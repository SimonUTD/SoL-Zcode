#!/usr/bin/env node
// rl-watchdog.mjs — in-container rate-limit degeneracy watchdog (audit
// MAJOR-1, 2026-09-14). Bench infrastructure, not part of the eval subject
// (not freeze-hashed, same as write-cli-config.mjs).
//
// Criterion (must stay identical to benchmark/rate_limit_guard.py; parity is
// asserted by benchmark/bin/test-rate-limit-guard.py):
//   a single model request OBSERVED > --abort-sec, --consecutive times in a
//   row -> kill the agent, write the abort marker, exit 75. The in-flight
//   (pending) request counts as soon as it crosses the threshold, so a fully
//   hung third request still aborts.
//
// Request duration observation: adjacent-event gaps in the plugin trajectory
// JSONL (~/.zcode/cli/plugins/data/<plugin>/store/trajectory/<session>.jsonl),
// classified by the earlier event: gap after pre_tool = tool execution
// (excluded); gap after post_tool/user_prompt/session_start = model request.
// A pending gap after `stop` is never a request.
//
// Arms with trajectory=false write no trajectory: the watchdog runs blind and
// fails OPEN (logs once; the in-band `timeout` cap remains the only bound).
//
// Modes:
//   wrap   node rl-watchdog.mjs --out <zcode.txt> --abort-marker <path>
//            [--abort-sec N] [--consecutive K] [--poll-sec P] -- "<shell cmd>"
//          Spawns the command via /bin/sh in its own process group, tees the
//          child's combined stdout+stderr to --out AND forwards it to this
//          process's stdout (same capture semantics as the old
//          `... | tee zcode.txt`). Runs entirely inside the container — it
//          does not depend on any host/foreground process being alive.
//   eval   node rl-watchdog.mjs --evaluate-file <trajectory.jsonl>
//            [--abort-sec N] [--consecutive K] [--now <iso>]
//          Prints the verdict JSON; exit 3 when the criterion is met, else 0.
//          Used only for offline checks/tests.
//
// Exit codes (wrap): 75 = aborted by this watchdog (marker written);
// otherwise the child's exit status is propagated.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ABORT_EXIT = 75;
const EVAL_ABORT_EXIT = 3;
const TERM_GRACE_SEC = 15;

function parseArgs(argv) {
  const args = {
    abortSec: 600,
    consecutive: 3,
    pollSec: 30,
    out: null,
    abortMarker: null,
    evaluateFile: null,
    now: null,
    command: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--abort-sec": args.abortSec = Number(argv[++i]); break;
      case "--consecutive": args.consecutive = Number(argv[++i]); break;
      case "--poll-sec": args.pollSec = Number(argv[++i]); break;
      case "--out": args.out = argv[++i]; break;
      case "--abort-marker": args.abortMarker = argv[++i]; break;
      case "--evaluate-file": args.evaluateFile = argv[++i]; break;
      case "--now": args.now = argv[++i]; break;
      case "--":
        args.command = argv.slice(i + 1).join(" ");
        i = argv.length;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------- evaluation

function parseTs(ts) {
  if (typeof ts !== "string" || !ts) return null;
  const ms = Date.parse(ts.endsWith("Z") ? ts : ts);
  return Number.isNaN(ms) ? null : ms;
}

function parseEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try { record = JSON.parse(trimmed); } catch { continue; }
    if (record && typeof record === "object" && parseTs(record.ts) !== null) {
      events.push(record);
    }
  }
  return events;
}

function gapKind(fromEvent) {
  return fromEvent === "pre_tool" ? "tool-exec" : "request";
}

function classifyGaps(events, nowMs) {
  const gaps = [];
  for (let i = 1; i < events.length; i++) {
    const a = parseTs(events[i - 1].ts);
    const b = parseTs(events[i].ts);
    if (a === null || b === null) continue;
    gaps.push({
      fromTs: events[i - 1].ts,
      toTs: events[i].ts,
      seconds: (b - a) / 1000,
      kind: gapKind(String(events[i - 1].event ?? "")),
      fromEvent: String(events[i - 1].event ?? ""),
      toEvent: String(events[i].event ?? ""),
      pending: false,
    });
  }
  if (nowMs !== null && events.length) {
    const last = events[events.length - 1];
    const lastEvent = String(last.event ?? "");
    const end = parseTs(last.ts);
    const pending = (nowMs - end) / 1000;
    if (lastEvent !== "stop" && pending > 0) {
      gaps.push({
        fromTs: last.ts,
        toTs: null,
        seconds: pending,
        kind: gapKind(lastEvent),
        fromEvent: lastEvent,
        toEvent: null,
        pending: true,
      });
    }
  }
  return gaps;
}

function evaluate(events, { abortSec, consecutive, nowMs }) {
  const gaps = classifyGaps(events, nowMs);
  const requestGaps = gaps.filter((g) => g.kind === "request");
  const trailing = [];
  for (let i = requestGaps.length - 1; i >= 0; i--) {
    if (requestGaps[i].seconds > abortSec) trailing.push(requestGaps[i]);
    else break;
  }
  trailing.reverse();
  let maxStreak = 0, streak = 0;
  for (const g of requestGaps) {
    streak = g.seconds > abortSec ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const maxOf = (kind) => {
    const values = gaps.filter((g) => g.kind === kind).map((g) => g.seconds);
    return values.length ? round3(Math.max(...values)) : null;
  };
  return {
    abort: trailing.length >= consecutive,
    abortSec,
    consecutive,
    streak: trailing.length,
    maxStreak,
    events: events.length,
    maxRequestGapSec: maxOf("request"),
    maxToolGapSec: maxOf("tool-exec"),
    evidence: trailing.map((g) => ({
      fromTs: g.fromTs,
      toTs: g.toTs,
      seconds: round3(g.seconds),
      kind: g.kind,
      fromEvent: g.fromEvent,
      toEvent: g.toEvent,
      pending: g.pending,
    })),
  };
}

// ------------------------------------------------------------ traj discovery

function findTrajectoryFile() {
  const root = path.join(
    process.env.HOME ?? "/root",
    ".zcode/cli/plugins/data"
  );
  let pluginDirs;
  try {
    pluginDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name, "store/trajectory"));
  } catch {
    return null;
  }
  let best = null;
  for (const trajDir of pluginDirs) {
    let files;
    try {
      files = fs.readdirSync(trajDir);
    } catch{
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(trajDir, name);
      try {
        const mtime = fs.statSync(full).mtimeMs;
        if (best === null || mtime > best.mtime) best = { full, mtime };
      } catch { /* raced away */ }
    }
  }
  return best ? best.full : null;
}

function readEvents(file) {
  try {
    return parseEvents(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ wrapping

async function wrap(args) {
  if (!args.out || !args.abortMarker || !args.command) {
    console.error("rl-watchdog: --out, --abort-marker and -- <cmd> are required");
    process.exit(64);
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });

  const outStream = fs.createWriteStream(args.out, { flags: "w" });
  const child = spawn("/bin/sh", ["-c", args.command], {
    detached: true, // own process group so we can kill the whole tree
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tee = (chunk) => {
    outStream.write(chunk);
    process.stdout.write(chunk);
  };
  child.stdout.on("data", tee);
  child.stderr.on("data", tee);

  const childExit = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const startedAt = Date.now();
  let blindLogged = false;
  let aborted = false;
  let verdict = null;
  let trajectoryFile = null;

  const poll = setInterval(() => {
    if (aborted || child.exitCode !== null || child.signalCode !== null) return;
    trajectoryFile = findTrajectoryFile();
    if (trajectoryFile === null) {
      if (!blindLogged && Date.now() - startedAt > 120_000) {
        blindLogged = true;
        console.error(
          "rl-watchdog: no trajectory source after 120s " +
          "(arm with trajectory=false?) — running blind, fail-open"
        );
      }
      return;
    }
    verdict = evaluate(readEvents(trajectoryFile), {
      abortSec: args.abortSec,
      consecutive: args.consecutive,
      nowMs: Date.now(),
    });
    if (verdict.abort) {
      aborted = true;
      console.error(
        `rl-watchdog: rate-limit degeneracy — ${verdict.streak} consecutive ` +
        `model request(s) > ${args.abortSec}s (trajectory: ${trajectoryFile}); ` +
        `killing agent process group`
      );
      killGroup(child);
    }
  }, args.pollSec * 1000);

  function killGroup(target) {
    const stop = () => clearInterval(poll);
    try { process.kill(-target.pid, "SIGTERM"); } catch { /* already gone */ }
    const killTimer = setTimeout(() => {
      try { process.kill(-target.pid, "SIGKILL"); } catch { /* already gone */ }
    }, TERM_GRACE_SEC * 1000);
    stop();
    killTimer.unref();
  }

  const { code, signal } = await childExit;
  clearInterval(poll);
  await new Promise((resolve) => outStream.end(resolve));

  if (aborted) {
    const marker = {
      schema: "sol_rl_abort_v1",
      ts: new Date().toISOString(),
      reason: "rate-limit-degeneracy",
      abortSec: args.abortSec,
      consecutive: args.consecutive,
      childPid: child.pid,
      trajectoryFile,
      verdict,
    };
    fs.writeFileSync(args.abortMarker, JSON.stringify(marker, null, 2) + "\n");
    process.exit(ABORT_EXIT);
  }
  if (code !== null) process.exit(code);
  process.exit(128 + (signal ? 1 : 0)); // propagate signal death as best we can
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.evaluateFile) {
    const nowMs = args.now ? Date.parse(args.now) : null;
    const verdict = evaluate(parseEvents(
      fs.readFileSync(args.evaluateFile, "utf8")
    ), { abortSec: args.abortSec, consecutive: args.consecutive, nowMs });
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(verdict.abort ? EVAL_ABORT_EXIT : 0);
  }
  await wrap(args);
}

main().catch((err) => {
  console.error(`rl-watchdog: ${err?.stack ?? err}`);
  process.exit(70);
});
