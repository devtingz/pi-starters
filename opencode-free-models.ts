import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const PROVIDER_NAME = "opencode-zen";

interface OpenCodeModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface OpenCodeModelsResponse {
  object: string;
  data: OpenCodeModelEntry[];
}

let cachedFreeModels: string[] = [];

async function fetchFreeModels(): Promise<string[]> {
  try {
    const res = await fetch(ZEN_MODELS_URL);
    if (!res.ok) return [];
    const json: OpenCodeModelsResponse = await res.json();
    return json.data
      .map((m) => m.id)
      .filter((id) => id.endsWith("-free"));
  } catch {
    return [];
  }
}

function registerProvider(pi: ExtensionAPI, modelIds: string[]) {
  if (modelIds.length === 0) return;

  pi.registerProvider(PROVIDER_NAME, {
    name: "OpenCode Zen (Free)",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: "public",
    api: "openai-completions",
    models: modelIds.map((id) => ({
      id,
      name: id.replace(/-free$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) + " (Free)",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    })),
  });
}

export default async function (pi: ExtensionAPI) {
  // Fetch and register on initial load (before startup completes)
  cachedFreeModels = await fetchFreeModels();
  registerProvider(pi, cachedFreeModels);

  // Re-register on session_start (covers /new, /resume, /reload)
  pi.on("session_start", async (_event, ctx) => {
    const fresh = await fetchFreeModels();
    if (fresh.length > 0) {
      cachedFreeModels = fresh;
      registerProvider(pi, cachedFreeModels);
    }
  });

  // Slash command to list and select free models
  pi.registerCommand("opencode-free", {
    description: "List OpenCode free-tier models",
    handler: async (_args, ctx) => {
      // Refresh on command invocation
      const models = await fetchFreeModels();
      if (models.length > 0) {
        cachedFreeModels = models;
        registerProvider(pi, models);
      }

      if (models.length === 0) {
        ctx.ui.notify("No free models found (API may be unreachable).", "warn");
        return;
      }

      const choice = await ctx.ui.select(
        "OpenCode Free Models — select to copy ID:",
        models.map((id) => ({
          value: id,
          label: id,
          description: `opencode-zen/${id}`,
        })),
      );

      if (choice) {
        ctx.ui.notify(`Model: opencode-zen/${choice}`, "info");
      }
    },
  });
}
