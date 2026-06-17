import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// ============================================================================
// CONFIGURATION - Easy to modify
// ============================================================================
/**
 * Session name prefixes that indicate a subagent session.
 * If the session name starts with any of these prefixes, pi-hints
 * will not inject hints under any circumstance.
 * 
 * These correspond to default pi-subagents agent types:
 * - general-purpose#<id>
 * - Explore#<id>
 * - Plan#<id>
 * 
 * Custom agents can be added here as needed.
 */
const SUBAGENT_SESSION_PREFIXES = [
  "authorizer#",
  "premortem#",
];

/**
 * Global hints file path.
 * This file contains hints that apply to ALL projects.
 * Default: C:\Users\Coffee Shops Coder\.pi\agent\.pihints-global
 */
const GLOBAL_HINTS_FILE_PATH = join(homedir(), ".pi", "agent", ".pihints-global");

const CONSTANT_REMINDER =  "Remember: **Never** assume or guess at an API name, method name, CSS selector, Object Property name, or function signature -- always verify!  Avoid assumptions as much as practicable -- when simple verifications are available, DO THE VERIFICATION instead of proceeding based on assumptions.  Separate “I haven’t verified it” from “it does not exist.”  ALWAYS prefer the read, edit, and write tools for file handling -- there is only one exception: if you experience errors when writing XML to a file.  Avoid relying on alternatives to the read or write or edit tools -- use of alternatives should be **VERY** rare. If you attempt the `edit` tool and receive an error such as \"Could not find the exact text...\" or \"Could not find edits[0] in\" then FIX THE TOOL CALL PARAMETERS for the `edit` tool and retry the `edit` tool.  All code changes must be thoroughly tested and fully validated before considering them complete. Please continue handling the current request...";

/**
 * Interval for CONSTANT_REMINDER hints injection (during agent turns).
 */
const TURN_INJECTION_INTERVAL = 10;

/**
 * Interval for GLOBAL hints injection (in agent_start events).
 * Hints are injected on agent_start #1 and every Nth agent_start thereafter.
 * Set to 1 to inject on every agent_start, higher values for less frequent injection.
 * Example: 8 means inject on agent_start events 1, 9, 17, 25, 33, etc.
 */
const GLOBAL_HINTS_INJECTION_INTERVAL = 16;

/**
 * Interval for PROJECT-SPECIFIC hints injection (in agent_start events).
 * Hints are injected on agent_start #1 and every Nth agent_start thereafter.
 * Set to 1 to inject on every agent_start, higher values for less frequent injection.
 * Example: 6 means inject on agent_start events 1, 7, 13, 19, 25, etc.
 */
const PROJECT_HINTS_INJECTION_INTERVAL = 12;

/**
 * Whether to log injection decisions for debugging.
 */
const VERBOSE_INJECTION_LOGGING = false;

// ============================================================================
// END CONFIGURATION
// ============================================================================

// Default context file names for project-specific hints
const DEFAULT_PROJECT_HINTS_FILE_NAMES = ["AGENTS.md", ".pihints"];

interface LoadedHints {
  content: string;
  loadedAt: number;
}

interface PiHintsState {
  globalHints: LoadedHints;
  projectHints: LoadedHints;
  agentStartCount: number;
  lastGlobalInjectionCount: number;
  lastProjectInjectionCount: number;
  config: {
    projectHintsFileNames: string[];
    enabled: boolean;
    verbose: boolean;
    globalInjectionInterval: number;
    projectInjectionInterval: number;
  };
}

/**
 * Check if the current session is a subagent based on session name prefix.
 * Returns true if the session name starts with any prefix in SUBAGENT_SESSION_PREFIXES.
 */
function isSubagentSession(sessionName: string | undefined): boolean {
  if (!sessionName) return false;
  return SUBAGENT_SESSION_PREFIXES.some(prefix => sessionName.startsWith(prefix));
}

/**
 * Parse environment variable for context file names
 */
function parseContextFileNames(envValue: string | undefined): string[] {
  if (!envValue) return DEFAULT_PROJECT_HINTS_FILE_NAMES;
  try {
    const parsed = JSON.parse(envValue);
    if (Array.isArray(parsed)) {
      return parsed.filter((f) => typeof f === "string");
    }
    return DEFAULT_PROJECT_HINTS_FILE_NAMES;
  } catch {
    return DEFAULT_PROJECT_HINTS_FILE_NAMES;
  }
}

/**
 * Read a file and return its contents, or empty string if not found
 */
async function readHintFile(filePath: string): Promise<string> {
  try {
    if (!existsSync(filePath)) {
      return "";
    }
    const content = await readFile(filePath, "utf-8");
    return content.trim();
  } catch {
    return "";
  }
}

/**
 * Find all hint files in a directory hierarchy from cwd to root
 */
async function findHintFilesUp(
  startPath: string,
  fileNames: string[]
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  let currentPath = resolve(startPath);
  const rootMarker = process.platform === "win32" ? currentPath.substring(0, 3) : "/";

  while (true) {
    for (const fileName of fileNames) {
      const filePath = join(currentPath, fileName);
      if (existsSync(filePath)) {
        if (!results.has(filePath)) {
          results.set(filePath, currentPath);
        }
      }
    }

    if (currentPath === rootMarker || currentPath === "/") break;
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }

  return results;
}

/**
 * Process hint file content, expanding @ references
 */
async function processHintContent(
  content: string,
  baseDir: string,
  _fileNames: string[],
  visited: Set<string>,
  maxDepth: number = 3,
  currentDepth: number = 0
): Promise<string> {
  if (currentDepth >= maxDepth) return content;

  const lines = content.split("\n");
  const processedLines: string[] = [];
  const atPattern = /^-?\s*@(\S+)/;

  for (const line of lines) {
    const match = line.match(atPattern);
    if (match) {
      const refPath = match[1];
      if (refPath.startsWith("http://") || refPath.startsWith("https://")) {
        processedLines.push(line);
        continue;
      }

      const absoluteRefPath = isAbsolute(refPath) ? refPath : resolve(baseDir, refPath);

      if (visited.has(absoluteRefPath)) {
        processedLines.push(line);
        continue;
      }

      visited.add(absoluteRefPath);

      try {
        if (existsSync(absoluteRefPath)) {
          const refContent = await readFile(absoluteRefPath, "utf-8");
          const refDir = dirname(absoluteRefPath);
          const expandedContent = await processHintContent(
            refContent, refDir, _fileNames, visited, maxDepth, currentDepth + 1
          );
          processedLines.push("\n<!-- Begin " + refPath + " -->\n" + expandedContent + "\n<!-- End " + refPath + " -->\n");
        } else {
          processedLines.push(line);
        }
      } catch {
        processedLines.push(line);
      }
    } else {
      processedLines.push(line);
    }
  }

  return processedLines.join("\n");
}

/**
 * Load global hints from the designated file path
 */
async function loadGlobalHints(verbose: boolean): Promise<LoadedHints> {
  const content = await readHintFile(GLOBAL_HINTS_FILE_PATH);
  
  if (content && verbose) {
    console.log("[pi-hints] Global hints file found at: " + GLOBAL_HINTS_FILE_PATH);
  } else if (verbose) {
    console.log("[pi-hints] No global hints file found at: " + GLOBAL_HINTS_FILE_PATH);
  }
  
  return {
    content,
    loadedAt: Date.now(),
  };
}

/**
 * Load project-specific hints from the directory hierarchy
 */
async function loadProjectHints(
  cwd: string,
  fileNames: string[],
  verbose: boolean
): Promise<LoadedHints> {
  const hintFiles = await findHintFilesUp(cwd, fileNames);
  const visited = new Set<string>();

  const allHints: string[] = [];

  for (const [filePath, directory] of hintFiles) {
    const content = await readHintFile(filePath);
    if (!content || !content.trim()) continue;

    const processedContent = await processHintContent(
      content, directory, fileNames, visited
    );
    allHints.push(processedContent);

    if (verbose) {
      console.log("[pi-hints] Loaded project hints: " + filePath);
    }
  }

  return {
    content: allHints.join("\n\n---\n\n"),
    loadedAt: Date.now(),
  };
}

/**
 * Determine if hints should be injected based on agent_start event count
 */
function shouldInject(
  agentStartCount: number,
  lastInjectionCount: number,
  interval: number
): boolean {
  if (agentStartCount === 1) return true;
  return (agentStartCount - lastInjectionCount) >= interval;
}

/**
 * Main extension function
 */
export default function (pi: ExtensionAPI) {
  let state: PiHintsState = {
    globalHints: { content: "", loadedAt: 0 },
    projectHints: { content: "", loadedAt: 0 },
    agentStartCount: 0,
    lastGlobalInjectionCount: 0,
    lastProjectInjectionCount: 0,
    config: {
      projectHintsFileNames: DEFAULT_PROJECT_HINTS_FILE_NAMES,
      enabled: true,
      verbose: false,
      globalInjectionInterval: GLOBAL_HINTS_INJECTION_INTERVAL,
      projectInjectionInterval: PROJECT_HINTS_INJECTION_INTERVAL,
    },
  };

  // ── Turn counter for periodic steer injection ──
  let turnStartCount = 0;

  // ========================================================================
  // AUTO-INIT SEQUENCE STATE (session_start -> agent_end)
  // ========================================================================
  // ── Pending-injection flags ──
  let globalHintsPending = false;
  let projectHintsPending = false;

  let originalModel: any = null;
  let inputBlocked = false;
  let sequenceInitialized = false;
  let firstEndHandled = false;
  let initTimeout: ReturnType<typeof setTimeout> | null = null;
  let sequenceCancelled = false;

  // Register input handler to block user input during the init sequence
  pi.on("input", async (event, _ctx) => {
    // Only block interactive (real user) input during the init sequence.
    // Extension-sourced messages (e.g., from sendUserMessage) always pass through
    // so they are not blocked while inputBlocked is true.
    if (inputBlocked && event.source === "interactive") {
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  function initConfig() {
    state.config.projectHintsFileNames = parseContextFileNames(
      process.env.PI_CONTEXT_FILE_NAMES
    );
    state.config.enabled = process.env.PI_HINTS_ENABLED !== "false";
    state.config.verbose = process.env.PI_HINTS_VERBOSE === "true";

    if (state.config.verbose) {
      console.log("[pi-hints] Config: globalInterval=" + state.config.globalInjectionInterval + ", projectInterval=" + state.config.projectInjectionInterval);
    }
  }

  pi.on("session_start", async (event, ctx) => {
    globalHintsPending = false;
    projectHintsPending = false;

    if (!state.config.enabled) return;

    // Skip hint initialization on reload, resume, or fork — context is preserved
    // so hints should not be re-injected. Only initialize on startup or new sessions.
    if (event.reason === "reload" || event.reason === "resume" || event.reason === "fork") {
      if (state.config.verbose) {
        console.log("[pi-hints] Skipping initialization (reason: " + event.reason + ")");
      }
      return;
    }

    // Skip if this is a subagent session — pi-hints should not run for sub-agents
    const sessionName = ctx.sessionManager.getSessionName?.();
    if (isSubagentSession(sessionName)) {
      if (state.config.verbose) {
        console.log("[pi-hints] Skipping subagent session_start:", sessionName);
      }
      return;
    }

    initConfig();

    state.agentStartCount = 0;
    state.lastGlobalInjectionCount = 0;
    state.lastProjectInjectionCount = 0;

    // Load global hints once per session
    state.globalHints = await loadGlobalHints(state.config.verbose);
    
    // Load project hints from current directory
    state.projectHints = await loadProjectHints(
      event.cwd || ctx.cwd,
      state.config.projectHintsFileNames,
      state.config.verbose
    );

    const hasGlobal = !!state.globalHints.content;
    const hasProject = !!state.projectHints.content;

    if (ctx.ui) {
      if (hasGlobal && hasProject) {
        ctx.ui.notify(
          "pi-hints ready: global (every " + state.config.globalInjectionInterval + " agent_start events), project (every " + state.config.projectInjectionInterval + " agent_start events)",
          "info"
        );
      } else if (hasGlobal) {
        ctx.ui.notify(
          "pi-hints ready: global hints active (every " + state.config.globalInjectionInterval + " agent_start events)",
          "info"
        );
      } else if (hasProject) {
        ctx.ui.notify(
          "pi-hints ready: project hints active (every " + state.config.projectInjectionInterval + " agent_start events)",
          "info"
        );
      }
    }

    // ====================================================================
    // AUTO-INIT SEQUENCE: block input immediately, defer rest to 2500ms
    // ====================================================================
    if (!sequenceInitialized) {
      sequenceInitialized = true;

      // 1. Block user input immediately (synchronous in session_start)
      inputBlocked = true;
      if (ctx.ui) {
        ctx.ui.notify("pi-hints init sequence starting... input disabled", "info");
      }

      // 2. Defer the heavy init work to 2500ms from now, allowing session_start to complete
      setTimeout(async () => {
        // Bail out early if the session was cancelled during the delay
        if (sequenceCancelled) return;

        // 3. Save current model (full model object)
        originalModel = ctx.model || null;

        // 4. Change model to openrouter/free
        const freeModel = ctx.modelRegistry?.find("openrouter", "openrouter/free");
        if (freeModel) {
          try {
            await pi.setModel(freeModel);
            if (ctx.ui) {
              ctx.ui.notify("Model switched to openrouter/free for init", "info");
            }
          } catch (err) {
            console.error("[pi-hints] Failed to switch model to openrouter/free:", err);
            if (ctx.ui) {
              ctx.ui.notify("Failed to switch model to openrouter/free", "warning");
            }
          }
        } else {
          console.error("[pi-hints] Could not find model openrouter/free");
          if (ctx.ui) {
            ctx.ui.notify("Could not find model openrouter/free", "warning");
          }
        }

        // 5. Wait 1 second after model switch for it to settle
        await new Promise(resolve => setTimeout(resolve, 1000));

        // If session was switched during the settle period, cancel the init
        if (sequenceCancelled) return;

        // 6. Unblock user input BEFORE sending "Hi" so the extension-sourced
        //    message isn't blocked by the input handler
        inputBlocked = false;

        // 7. Send "Hi" to trigger first agent turn
        if (ctx.ui) {
          ctx.ui.notify("About to send initial 'Hi' message...", "info");
        }
        try {
          await pi.sendUserMessage("Hi");
          if (ctx.ui) {
            ctx.ui.notify("Successfully sent initial 'Hi' message", "info");
          }
        } catch (err) {
          console.error("[pi-hints] Failed to send user message:", err);
          if (ctx.ui) {
            ctx.ui.notify("Failed to send initial message", "warning");
          }
        }

        // 8. Watchdog timeout — force unblock if agent_end never fires
        initTimeout = setTimeout(() => {
          if (firstEndHandled) return;
          console.warn("[pi-hints] Init sequence timed out — agent_end never fired, forcing unblock");
          // Do NOT set firstEndHandled here, so agent_end can still restore the model
          // Do NOT restore the model here (per user request: only on agent_end or session_end)
          initTimeout = null;

          // Re-enable user input (safety net)
          inputBlocked = false;
          if (ctx.ui) {
            ctx.ui.notify("pi-hints init sequence timed out — input re-enabled", "warning");
          }
        }, 700);
      }, 2500);
    }
  });

  /**
   * Check if the last assistant message ended with an error or abort.
   */
  function lastTurnWasError(messages: any[]): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
        return true;
      }
    }
    return false;
  }

  // ── agent_end handler: clear pending flags on normal turns ──
  pi.on("agent_end", async (event, _ctx) => {
    if (!lastTurnWasError(event.messages || [])) {
      globalHintsPending = false;
      projectHintsPending = false;
    }
  });

  // ── turn_start handler: periodic steer injection ──
  pi.on("turn_start", async (_event, ctx) => {
    turnStartCount++;
    if (turnStartCount % TURN_INJECTION_INTERVAL === 2) {
      pi.sendMessage(
        {
          customType: "pi-hints-ping",
          content: `${CONSTANT_REMINDER}`,
          display: true,
        },
        { deliverAs: "steer" }
      );
      if (state.config.verbose) {
        console.log("[pi-hints] Steer injected at turn #" + turnStartCount);
      }
    }
  });

  // ── agent_end handler: reset turn counter ──
  pi.on("agent_end", async () => {
    turnStartCount = 0;
  });

  // ── agent_end handler: init-sequence cleanup ──
  pi.on("agent_end", async (_event, _ctx) => {
    if (!sequenceInitialized) return;
    if (firstEndHandled) return;
    firstEndHandled = true;

    // Cancel the watchdog timeout since agent_end fired
    if (initTimeout) {
      clearTimeout(initTimeout);
      initTimeout = null;
    }

    // Restore original model
    if (originalModel) {
      try {
        await pi.setModel(originalModel);
        if (_ctx.ui) {
          _ctx.ui.notify("Model restored to " + (originalModel.id || "unknown"), "info");
        }
      } catch (err) {
        console.error("[pi-hints] Failed to restore model:", err);
      }
    }

    // Re-enable user input
    inputBlocked = false;
    if (_ctx.ui) {
      _ctx.ui.notify("Input enabled. You can now type your message.", "info");
    }
  });

  pi.on("session_shutdown", async () => {
    globalHintsPending = false;
    projectHintsPending = false;

    // If the init sequence was started but never completed (model was
    // switched but no agent_end fired yet), restore the original model
    // so the model isn't stuck on openrouter/free from the init sequence.
    if (sequenceInitialized && !firstEndHandled && originalModel) {
      try {
        await pi.setModel(originalModel);
      } catch (err) {
        console.error("[pi-hints] Failed to restore model on session shutdown:", err);
      }
    }
    // Mark the sequence as cancelled so any in-flight delayed callbacks
    // in the old session will bail out early.
    sequenceCancelled = true;
  });

  pi.on("agent_start", async (event, ctx) => {
    // Skip if this is a subagent session
    const sessionName = ctx.sessionManager.getSessionName();
    if (isSubagentSession(sessionName)) {
      if (state.config.verbose) {
        console.log("[pi-hints] Skipping subagent session:", sessionName);
      }
      return;
    }
    
    // Increment agent start count BEFORE checking injection
    // This ensures the count reflects the current agent start
    state.agentStartCount++;
    
    if (!state.config.enabled) return;

    let globalInjected = false;
    let projectInjected = false;
    let messagesToSend: string[] = [];

    // ── Check flags: skip if a prior injection is still pending ──
    if (globalHintsPending || projectHintsPending) {
      if (state.config.verbose) {
        console.log("[pi-hints] Agent Start #" + state.agentStartCount + " - skip: globalPending=" + globalHintsPending + ", projectPending=" + projectHintsPending);
      }
      return;
    }

    // Check if we should inject global hints
    if (state.globalHints.content && shouldInject(
      state.agentStartCount,
      state.lastGlobalInjectionCount,
      state.config.globalInjectionInterval
    )) {
      state.lastGlobalInjectionCount = state.agentStartCount;
      globalInjected = true;
      globalHintsPending = true;
      messagesToSend.push(
        "## GLOBAL CONTEXT (from .pihints-global - injected every " + state.config.globalInjectionInterval + " agent_start events)\n\n" + state.globalHints.content
      );
      if (ctx.ui) {
        ctx.ui.notify("Global hints injected (agent_start #" + state.agentStartCount + ")", "info");
      }
    }

    // Check if we should inject project hints
    if (state.projectHints.content && shouldInject(
      state.agentStartCount,
      state.lastProjectInjectionCount,
      state.config.projectInjectionInterval
    )) {
      state.lastProjectInjectionCount = state.agentStartCount;
      projectInjected = true;
      projectHintsPending = true;
      messagesToSend.push(
        "## PROJECT CONTEXT (from .pihints files - injected every " + state.config.projectInjectionInterval + " agent_start events)\n\n" + state.projectHints.content
      );
      if (ctx.ui) {
        ctx.ui.notify("Project hints injected (agent_start #" + state.agentStartCount + ")", "info");
      }
    }

    if (messagesToSend.length > 0) {
      if (state.config.verbose) {
        console.log("[pi-hints] Agent Start #" + state.agentStartCount + " - injecting: global=" + globalInjected + ", project=" + projectInjected);
      }

      // Send hints as a follow-up message (does not trigger a turn)
      const messageContent = messagesToSend.join("\n\n---\n\n");
      pi.sendMessage(
        {
          customType: "pi-hints",
          content: messageContent,
          display: true,
        },
        {
          deliverAs: "followUp",
          triggerTurn: false,
        }
      );
    } else if (state.config.verbose) {
      console.log("[pi-hints] Agent Start #" + state.agentStartCount + " - no injection (waiting for next interval)");
    }
  });

  // Note: We no longer use before_agent_start to modify system prompt
  // Instead, we use pi.sendMessage in agent_start to inject hints as messages

  // Commands
  pi.registerCommand("reload-hints", {
    description: "Reload both global and project .pihints files",
    handler: async (_args, ctx) => {
      if (!state.config.enabled) {
        ctx.ui.notify("pi-hints is disabled", "info");
        return;
      }

      try {
        state.globalHints = await loadGlobalHints(state.config.verbose);
        state.projectHints = await loadProjectHints(
          ctx.cwd,
          state.config.projectHintsFileNames,
          state.config.verbose
        );

        const globalOk = !!state.globalHints.content;
        const projectOk = !!state.projectHints.content;

        if (globalOk && projectOk) {
          ctx.ui.notify("Reloaded both global and project hints", "success");
        } else if (globalOk) {
          ctx.ui.notify("Reloaded global hints only", "success");
        } else if (projectOk) {
          ctx.ui.notify("Reloaded project hints only", "success");
        } else {
          ctx.ui.notify("No .pihints files found", "info");
        }
      } catch (error) {
        ctx.ui.notify("Error reloading hints: " + error, "error");
      }
    },
  });

  pi.registerCommand("show-hints", {
    description: "Show the currently loaded .pihints content",
    handler: async (_args, ctx) => {
      const globalContent = state.globalHints.content;
      const projectContent = state.projectHints.content;

      if (!globalContent && !projectContent) {
        ctx.ui.notify("No hints loaded for this session", "info");
        return;
      }

      let message = "";
      if (globalContent) {
        message += "=== GLOBAL HINTS (" + globalContent.length + " chars) ===\n" + globalContent.substring(0, 300);
        if (globalContent.length > 300) message += "\n... [truncated]";
      }
      if (projectContent) {
        if (message) message += "\n\n";
        message += "=== PROJECT HINTS (" + projectContent.length + " chars) ===\n" + projectContent.substring(0, 300);
        if (projectContent.length > 300) message += "\n... [truncated]";
      }

      ctx.ui.notify(message, "info");
    },
  });

  pi.registerCommand("hints-status", {
    description: "Show pi-hints injection status and statistics",
    handler: async (_args, ctx) => {
      const nextGlobal = state.lastGlobalInjectionCount === 0
        ? 1
        : state.lastGlobalInjectionCount + state.config.globalInjectionInterval;
      const nextProject = state.lastProjectInjectionCount === 0
        ? 1
        : state.lastProjectInjectionCount + state.config.projectInjectionInterval;

      const status = "Pi-Hints Status:\n" +
        "- Enabled: " + state.config.enabled + "\n" +
        "- Agent start count: " + state.agentStartCount + "\n" +
        "- Global hints: " + (state.globalHints.content ? state.globalHints.content.length + " chars" : "none") + "\n" +
        "  - Last injection: agent_start #" + state.lastGlobalInjectionCount + "\n" +
        "  - Agent starts since last injection: " + (state.agentStartCount - state.lastGlobalInjectionCount) + "\n" +
        "  - Next injection: agent_start #" + nextGlobal + "\n" +
        "  - Interval: every " + state.config.globalInjectionInterval + " agent_start events\n" +
        "- Project hints: " + (state.projectHints.content ? state.projectHints.content.length + " chars" : "none") + "\n" +
        "  - Last injection: agent_start #" + state.lastProjectInjectionCount + "\n" +
        "  - Agent starts since last injection: " + (state.agentStartCount - state.lastProjectInjectionCount) + "\n" +
        "  - Next injection: agent_start #" + nextProject + "\n" +
        "  - Interval: every " + state.config.projectInjectionInterval + " agent_start events";

      ctx.ui.notify(status, "info");
    },
  });

  // Tool for LLM
  pi.registerTool({
    name: "pihints_status",
    label: "Pi-Hints Status",
    description: "Check the status of loaded .pihints files and their injection schedules, including agent_start events since last injection.",
    parameters: {
      type: "object",
      properties: {
        show_content: {
          type: "boolean",
          description: "If true, show the full hint content",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params) {
      const showContent = params.show_content === true;

      const nextGlobal = state.lastGlobalInjectionCount === 0
        ? 1
        : state.lastGlobalInjectionCount + state.config.globalInjectionInterval;
      const nextProject = state.lastProjectInjectionCount === 0
        ? 1
        : state.lastProjectInjectionCount + state.config.projectInjectionInterval;

      let text = "Agent Start #" + state.agentStartCount + " | Global: agent_start #" + nextGlobal + " | Project: agent_start #" + nextProject;

      if (showContent) {
        if (state.globalHints.content) {
          text += "\n\n=== GLOBAL HINTS ===\n" + state.globalHints.content;
        }
        if (state.projectHints.content) {
          text += "\n\n=== PROJECT HINTS ===\n" + state.projectHints.content;
        }
      }

      return {
        content: [{ type: "text", text }],
        details: {
          enabled: state.config.enabled,
          agentStartCount: state.agentStartCount,
          globalHintsLength: state.globalHints.content.length,
          projectHintsLength: state.projectHints.content.length,
          globalInterval: state.config.globalInjectionInterval,
          projectInterval: state.config.projectInjectionInterval,
          lastGlobalInjectionCount: state.lastGlobalInjectionCount,
          lastProjectInjectionCount: state.lastProjectInjectionCount,
          nextGlobalInjectionCount: nextGlobal,
          nextProjectInjectionCount: nextProject,
          agentStartsSinceLastGlobalInjection: state.agentStartCount - state.lastGlobalInjectionCount,
          agentStartsSinceLastProjectInjection: state.agentStartCount - state.lastProjectInjectionCount,
        },
      };
    },
  });
}
