/**
 * Built-in Tools SysPrompt Injector
 *
 * Injects a reminder about built-in tools into the system prompt
 * immediately before the "Available tools:" anchor, using the head
 * insertion method.
 *
 * Install: Copy to ~/.pi/agent/extensions/built-in-tools-sysprompt-injector.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const USE_EXTENDED_INJECTION = false;

const INJECTION1 = `Never assume an API method name or CSS selector or Object Property name -- all names **MUST** be personally confirmed (through **external** sources) to exist in the current context.
 Checklist before using any unverified name:
 - [ ] Can I prove this name exists?
 - [ ] Have I recently checked the actual source/schema/DOM?
 - [ ] Am I relying on assumption or evidence?

Before stating whether an API, tool, or feature does or does not exist, you must verify by reading the relevant source code or documentation. 'I haven't seen it so far' is not a valid basis for a negative claim.
**Never guess at an API name, method name, or function signature. Always verify.**

Assume tools are available until validation attempts prove otherwise in the current session -- never convert uncertainty into a negative claim without validation attempts and evidence.

Avoid assumptions as much as practicable -- when simple verifications are available, DO THE VERIFICATION instead of proceeding based on assumptions.

- Keep all answers brief and concise, unless specifically asked for detailed explanation or elaboration.
- Only provide detailed explanations when asked for a feasibility assessment or when specifically asked for details.
- Skip pleasantries and flattery.
No \`Glob\` tool exists.  The\`<skill>\` tag has no functionality -- do not use it. All tool invocations use <tool_calls> with <invoke name="..."> XML format, as shown in this example:
\`\`\`xml
<tool_calls>
<invoke name="read">
<parameter name="path" string="true">C:/path/to/file.txt</parameter>
</invoke>
<invoke name="bash">
<parameter name="command" string="true">echo hello</parameter>
<parameter name="timeout" string="false">10</parameter>
</invoke>
</tool_calls>
\`\`\`

There are many custom tools; however you also have access to 4 basic tools — read, edit, bash, write — all lowercase, always.
ALWAYS prefer the read, edit, and write tools for file handling -- there is only one exception: if you experience errors when writing XML to a file.  Avoid relying on alternatives to the read or write or edit tools -- use of alternatives should be **VERY** rare. If you attempt the \`edit\` tool and receive an error such as "Could not find the exact text..." or "Could not find edits[0] in" then FIX THE TOOL CALL PARAMETERS for the \`edit\` tool and retry the \`edit\` tool.
For writing large amounts of content, please avoid writing more than 200 lines at a time -- use a combination of \`write\` and subsequent \`edit\` calls to append.
`;


const INJECTION2 = `
`;

var INJECTION = `${INJECTION1}`
if (USE_EXTENDED_INJECTION) {
	INJECTION = `${INJECTION1}${INJECTION2}`
}

export default function builtInToolsReminder(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const modified = event.systemPrompt.replace(
			"Available tools:",
			`${INJECTION}\n\nAvailable tools:`,
		);
		return { systemPrompt: modified };
	});
}
