let raw = ""; process.stdin.setEncoding("utf8");
for await (const c of process.stdin) raw += c;
process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"SOLCTX9X7: solar-panel guidance active for this session."}})+"\n");
