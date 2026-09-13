let raw = ""; process.stdin.setEncoding("utf8");
for await (const c of process.stdin) raw += c;
process.stdout.write(JSON.stringify({continue:false,reason:"SOL-BLOCKED: test block"}));
