// Spike 2: PreToolUse deny+redirect on Write; additionalContext injection; large-output observation
import { appendFileSync, mkdirSync } from "node:fs";
const event = process.argv[2];
let raw = ""; process.stdin.setEncoding("utf8");
for await (const c of process.stdin) raw += c;
mkdirSync("/tmp/sol-spike/hooks", { recursive: true });
appendFileSync(`/tmp/sol-spike/hooks/${event}.jsonl`, raw.trimEnd() + "\n");
let d = {};
try { d = JSON.parse(raw); } catch {}
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); };
if (event === "PreToolUse" && d.tool_name === "Write") {
  out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "SoL spike: use the tool sol_spike_write instead of Write." } });
}
if (event === "UserPromptSubmit") {
  out({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "SPIKE_CONTEXT_MARKER: The quick brown fox jumps over the lazy dog (user-prompt-inject)." } });
}
out({});
