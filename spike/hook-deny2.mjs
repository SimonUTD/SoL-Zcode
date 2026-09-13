let raw = ""; process.stdin.setEncoding("utf8");
for await (const c of process.stdin) raw += c;
process.stderr.write("[deny2] got event, exiting 2\n");
process.exit(2);
