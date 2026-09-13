import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const event = process.argv[2];
let raw = "";
process.stdin.setEncoding("utf8");
for await (const c of process.stdin) raw += c;
mkdirSync("/tmp/sol-spike/hooks", { recursive: true });
appendFileSync(`/tmp/sol-spike/hooks/${event}.jsonl`, raw.trimEnd() + "\n");
try { const d = JSON.parse(raw); if (d.transcript_path) { try { appendFileSync("/tmp/sol-spike/transcript-paths.txt", d.transcript_path + "\n"); } catch {} } } catch {}
process.stdout.write("{}");
