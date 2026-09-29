#!/usr/bin/env node
// Closed ACP fixture agent for the workbench dispatch tests. It speaks the
// same documented method surface as integrations/zcode-desktop-adapter
// (initialize / session/new / session/set_config_option / session/adopt /
// session/prompt / session/cancel notifications / session/update
// notifications) and the same fixed-string `--health` line, so the dispatch
// layer runs one code path in tests and production. The scenario is read
// from the `--config` JSON file, which the real adapter would ignore as an
// unknown key; an optional `journal` path in that file appends one JSONL
// line per received method so tests can prove the exact call sequence.
//
// Scenarios:
//   happy            full turn: tool card, two-message assistant stream with a
//                    same-messageId chunk append, approval that appears and
//                    resolves, then stopReason end_turn; session/cancel maps to
//                    stopReason cancelled
//   die-mid-turn     streams one assistant chunk, then the process exits
//   reject-session   session/new fails with ERR_SESSION_STATE (-32002)
//   link-lost-turn   session/prompt fails with ERR_LINK (-32003) after the ack
//   health-offline   --health prints the offline line and exits 1
//   no-workspaces    health succeeds, but session/new exposes no workspace
//                    option (a reachable node that cannot route tasks)
//   tasks-fail       --list-tasks fails with a fixed-string error and exits 1
//   reject-adopt     session/adopt fails with ERR_SESSION_STATE (verification
//                    refused on the desktop side)
//   hold-turn        like happy, but session/prompt holds the turn open for
//                    ~1.5s before answering (in-flight continuation guards)
//
// --list-tasks [<workspacePath>] answers the read-only desktop task-index
// listing with one `[fake-acp-agent] tasks: <json>` line, mirroring the real
// adapter's --list-tasks mode. Workspace '/' is the fixed-node pin target.
//
// Two config keys model the adapter-side unresolved-dispatch lock for the
// reconcile flow (the real adapter persists it in a binding file):
//   stuckDispatchFile  path of the unresolved-dispatch marker. A link-lost
//                      session/prompt writes `{taskId, commandId, kind,
//                      prompt}` there; session/adopt refuses while it names the
//                      task; `--reconcile-dispatch --confirm human-verified`
//                      deletes it. Absent key: no marker is ever written.
//   reconcile*         per-spawn overrides for reconcile evidence checks
//                      (reconcileTaskStatus, reconcilePhase,
//                      reconcilePendingInteractions, reconcileForcePromptMatched).
//
// --reconcile-dispatch <taskId> [<workspacePath>] [--confirm human-verified]
// [--operator <label>] mirrors the real adapter's verify-then-release mode:
// it reads `{"expectedPromptText": "..."}` from one stdin JSON line, refuses on
// every contrary signal with a machine-stable reason, and only the confirm
// pass clears the marker. One `[fake-acp-agent] reconcile: <json>` line.
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ERR_SESSION_STATE = -32002;
const ERR_LINK = -32003;

const configArg = process.argv.indexOf("--config");
let fixtureConfig = {};
const scenario = configArg === -1
  ? "happy"
  : (() => {
    try {
      fixtureConfig = JSON.parse(readFileSync(process.argv[configArg + 1], "utf8"));
      return fixtureConfig.scenario ?? "happy";
    } catch {
      fail("fixture config unreadable");
    }
  })();

function fail(message) {
  process.stderr.write(`[fake-acp-agent] ${message}\n`);
  process.exit(2);
}

/** One JSONL line per received method; tests assert the exact call sequence. */
function journal(method, params) {
  if (typeof fixtureConfig.journal !== "string" || fixtureConfig.journal.length === 0) return;
  appendFileSync(fixtureConfig.journal, `${JSON.stringify({ method, params })}\n`);
}

const WORKSPACES = [
  { value: "/site/default", name: "default" },
  { value: "/site/deephik-progo", name: "deephik-progo" },
  { value: "/site/lab", name: "lab" },
];

// Desktop task-index rows per workspace; `dtask-wb-1` carries the adapter
// binding join (dshSessionId) that the workbench maps onto its own record,
// and `dtask-legacy-1` is the completed desktop-origin task continuation
// tests adopt.
const DESKTOP_TASKS = {
  "/site/default": [
    {
      taskId: "dtask-wb-1", title: "workbench dispatched task", status: "completed",
      createdAt: "2026-09-21T01:00:00.000Z", updatedAt: "2026-09-21T01:05:00.000Z",
      origin: "workbench", dshSessionId: "fake-acp-session-1",
    },
    {
      taskId: "dtask-desktop-only", title: "created on the desktop", status: "running",
      createdAt: "2026-09-21T02:00:00.000Z", updatedAt: "2026-09-21T02:10:00.000Z",
      origin: "desktop",
    },
  ],
  "/site/deephik-progo": [
    {
      taskId: "dtask-progo-1", title: "progo workspace task", status: "error",
      createdAt: "2026-09-21T03:00:00.000Z", updatedAt: "2026-09-21T03:30:00.000Z",
      origin: "desktop",
    },
  ],
  "/site/lab": [
    {
      taskId: "dtask-legacy-1", title: "completed desktop task", status: "completed",
      createdAt: "2026-09-21T04:00:00.000Z", updatedAt: "2026-09-21T04:20:00.000Z",
      origin: "desktop",
    },
  ],
};

const listTasksIdx = process.argv.indexOf("--list-tasks");
if (listTasksIdx !== -1) {
  if (scenario === "tasks-fail") {
    process.stderr.write("[fake-acp-agent] tasks: fixture site: task listing failed (index unreadable)\n");
    setImmediate(() => process.exit(1));
  } else {
    // A fixed node passes no path: the pin lives in adapter configuration and
    // answers the same rows as the default workspace.
    const requested = process.argv[listTasksIdx + 1] ?? "/site/default";
    if (!Object.hasOwn(DESKTOP_TASKS, requested)) {
      process.stderr.write("[fake-acp-agent] tasks: fixture site: task listing failed (workspace not registered)\n");
      setImmediate(() => process.exit(1));
    } else {
      const report = { desktopVersion: "3.14.0", tasks: DESKTOP_TASKS[requested] };
      process.stdout.write(`[fake-acp-agent] tasks: ${JSON.stringify(report)}\n`);
      setImmediate(() => process.exit(0));
    }
  }
}

// ---------- --reconcile-dispatch: the adapter's verify-then-release mode ----------

const RECONCILE_TERMINAL_PHASES = new Set(["completedSuccess", "completedInterrupted", "error"]);
const RECONCILE_MARKER = "] reconcile: ";

function stuckDispatchMarker() {
  if (typeof fixtureConfig.stuckDispatchFile !== "string" || fixtureConfig.stuckDispatchFile.length === 0) return null;
  try {
    return JSON.parse(readFileSync(fixtureConfig.stuckDispatchFile, "utf8"));
  } catch {
    return null;
  }
}

function writeStuckDispatchMarker(taskId) {
  if (typeof fixtureConfig.stuckDispatchFile !== "string" || fixtureConfig.stuckDispatchFile.length === 0) return;
  // The marker models the adapter's dispatch ledger only: task, command id,
  // kind, issue instant. Whether the desktop conversation shows the old
  // instruction is an independent site state, modeled by
  // `reconcileForcePromptMatched` — the ledger never implies it.
  const marker = { taskId, commandId: "cmd-fixture-stuck-1", kind: "sendText", issuedAt: Date.now() };
  writeFileSync(fixtureConfig.stuckDispatchFile, `${JSON.stringify(marker)}\n`);
}

/** Reads `{"expectedPromptText": "..."}` from one stdin JSON line (or null). */
function readExpectedPromptText() {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      resolve(text);
    };
    const onData = (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.expectedPromptText === "string" && parsed.expectedPromptText.length > 0) {
            finish(parsed.expectedPromptText);
            return;
          }
        } catch {
          /* skip non-JSON lines */
        }
      }
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), 3000);
    timer.unref?.();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  });
}

const reconcileIdx = process.argv.indexOf("--reconcile-dispatch");
if (reconcileIdx !== -1) {
  const operands = [];
  let confirm = false;
  let badArgs = false;
  for (let index = reconcileIdx + 1; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--confirm") {
      if (process.argv[index + 1] !== "human-verified") badArgs = true;
      confirm = true;
      index += 1;
      continue;
    }
    if (arg === "--operator") { index += 1; continue; }
    operands.push(arg);
  }
  if (badArgs) {
    process.stderr.write("[fake-acp-agent] reconcile: --confirm requires human-verified\n");
    setImmediate(() => process.exit(2));
  } else {
  const taskId = operands[0];
  const workspace = operands[1] ?? "/site/default";
  const expected = await readExpectedPromptText();
  const row = (DESKTOP_TASKS[workspace] ?? []).find((task) => task.taskId === taskId);
  const marker = stuckDispatchMarker();
  const report = {
    taskId, dshSessionId: null, commandId: null, commandKind: null, issuedAt: null,
    taskStatus: null, taskUpdatedAt: null, taskUpdatedAfterIssued: null,
    phase: null, pendingInteractions: null, userTurnCount: null,
    promptMatched: null, expectedPromptProvided: expected !== null,
    writtenOff: false, alreadyReconciled: false, reconciledAt: new Date().toISOString(), reason: null,
  };
  const finish = (reason) => {
    process.stdout.write(`[fake-acp-agent]${RECONCILE_MARKER}${JSON.stringify({ ...report, ...(reason === null ? {} : { reason }) })}\n`);
    if (reason !== null) process.stderr.write(`[fake-acp-agent] reconcile: refused (${reason})\n`);
    setImmediate(() => process.exit(reason === null ? 0 : 1));
  };
  if (marker === null) { finish("nothing-to-reconcile"); }
  else if (marker.taskId !== taskId) { finish("binding-not-found"); }
  else {
    report.dshSessionId = "fake-acp-session-adopted-1";
    report.commandId = marker.commandId;
    report.commandKind = marker.kind;
    report.issuedAt = marker.issuedAt;
    if (row === undefined) {
      finish("task-missing");
    } else {
      report.taskStatus = fixtureConfig.reconcileTaskStatus ?? row.status;
      report.taskUpdatedAt = row.updatedAt;
      if (report.taskStatus === "running") {
        finish("task-running");
      } else if (report.taskStatus !== "completed" && report.taskStatus !== "error") {
        finish("task-status-unknown");
      } else {
        report.phase = fixtureConfig.reconcilePhase ?? "completedSuccess";
        report.pendingInteractions = fixtureConfig.reconcilePendingInteractions ?? 0;
        report.userTurnCount = 1;
        if (!RECONCILE_TERMINAL_PHASES.has(report.phase)) {
          finish("phase-not-terminal");
        } else if (report.pendingInteractions > 0) {
          finish("awaiting-input");
        } else if (expected === null) {
          finish(confirm ? "expected-prompt-missing" : null);
        } else {
          report.promptMatched = fixtureConfig.reconcileForcePromptMatched === true;
          if (report.promptMatched) {
            finish("prompt-matched");
          } else {
            if (confirm) {
              rmSync(fixtureConfig.stuckDispatchFile, { force: true });
              journal("reconcile-confirm", { taskId, commandId: marker.commandId, kind: marker.kind });
              report.writtenOff = true;
            }
            finish(null);
          }
        }
      }
    }
  }
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function replyResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function update(sessionId, updateBody) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: updateBody } });
}

function chunk(sessionId, messageId, text) {
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId });
}

function toolCall(sessionId, toolCallId, title, status) {
  update(sessionId, { sessionUpdate: "tool_call", toolCallId, title, kind: "other", status });
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

if (process.argv.includes("--health")) {
  if (scenario === "health-offline") {
    process.stderr.write("[fake-acp-agent] health: fixture site: offline or unreachable (LinkError)\n");
    setImmediate(() => process.exit(1));
  } else {
    process.stdout.write("[fake-acp-agent] health: fixture site: online, desktop 3.14.0, 3 registered workspace(s), workspace selection per session\n");
    setImmediate(() => process.exit(0));
  }
} else {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  let cancelRequested = false;
  // One stable adopted binding id per desktop task within this process.
  const adoptedSessions = new Map();
  process.stdin.on("data", (part) => {
    buffer += part;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) void dispatch(JSON.parse(line));
    }
  });
  process.stdin.resume();

  async function dispatch(message) {
    if (message.method === "session/cancel") { cancelRequested = true; return; }
    const { id, method, params } = message;
    journal(method, params);
    if (method === "initialize") {
      replyResult(id, { protocolVersion: 1, agentInfo: { name: "fake-acp-agent", version: "0.0.1" } });
      return;
    }
    if (method === "session/new") {
      if (scenario === "reject-session") {
        replyError(id, ERR_SESSION_STATE, "the fixture site refused session creation");
        return;
      }
      replyResult(id, {
        sessionId: "fake-acp-session-1",
        configOptions: scenario === "no-workspaces" ? [
          { id: "model", name: "Model", type: "select", currentValue: "follow-desktop", options: [{ value: "follow-desktop", name: "follow" }] },
        ] : [
          { id: "model", name: "Model", type: "select", currentValue: "follow-desktop", options: [{ value: "follow-desktop", name: "follow" }] },
          {
            id: "workspace",
            name: "Workspace",
            type: "select",
            description: "fixture site: desktop 3.14.0, 3 registered workspaces. pick one; no default is applied.",
            currentValue: "",
            options: WORKSPACES,
          },
        ],
      });
      return;
    }
    if (method === "session/adopt") {
      if (scenario === "reject-adopt") {
        replyError(id, ERR_SESSION_STATE, "the fixture site refused task adoption (verification failed)");
        return;
      }
      // Same verification contract as the real adapter: the task must be a
      // completed row of the named workspace's own index, and an existing
      // binding (the workbench-origin join) is reused, never duplicated.
      const workspace = typeof params?.workspacePath === "string" && params.workspacePath.length > 0
        ? params.workspacePath
        : "/site/default";
      const row = (DESKTOP_TASKS[workspace] ?? []).find((task) => task.taskId === params?.taskId);
      if (row === undefined) {
        replyError(id, ERR_SESSION_STATE, "the desktop task is not in this workspace's synced task index (it may be pinned, archived, or belong to another workspace); continuation is refused");
        return;
      }
      if (row.status !== "completed") {
        replyError(id, ERR_SESSION_STATE, `the desktop task is not completed (${row.status}); finish or verify it in the Zcode desktop first`);
        return;
      }
      // The adapter-side unresolved-dispatch lock: while the stuck marker names
      // this task, adoption refuses exactly like the real adapter's binding
      // ledger does (ERR_SESSION_STATE, outcome unknown).
      if (stuckDispatchMarker()?.taskId === row.taskId) {
        replyError(id, ERR_SESSION_STATE, "the previous desktop command's outcome is unknown (adapter restart or lost ack); verify the task in the Zcode desktop before sending more prompts");
        return;
      }
      if (row.dshSessionId !== undefined) {
        replyResult(id, { sessionId: row.dshSessionId, created: false });
        return;
      }
      if (!adoptedSessions.has(row.taskId)) adoptedSessions.set(row.taskId, `fake-acp-session-adopted-${adoptedSessions.size + 1}`);
      replyResult(id, { sessionId: adoptedSessions.get(row.taskId), created: true });
      return;
    }
    if (method === "session/set_config_option") {
      const known = WORKSPACES.some((workspace) => workspace.value === params.value);
      if (params.configId !== "workspace" || !known) {
        replyError(id, ERR_SESSION_STATE, "the chosen workspace is not registered on the fixture site");
        return;
      }
      replyResult(id, { configOptions: [] });
      return;
    }
    if (method === "session/prompt") {
      const sessionId = params.sessionId;
      if (scenario === "link-lost-turn") {
        await sleep(30);
        // The dispatch was recorded before the envelope left, so the failure
        // persists exactly like the real adapter's unresolved binding ledger.
        const adopted = [...adoptedSessions.entries()].find(([, session]) => session === sessionId);
        if (adopted !== undefined) writeStuckDispatchMarker(adopted[0]);
        replyError(id, ERR_LINK, "the relay link to the desktop was lost; the remote task state is unknown");
        return;
      }
      if (scenario === "die-mid-turn") {
        await sleep(30);
        chunk(sessionId, "fixture-die-1", "partial answer before the link dies");
        await sleep(30);
        process.exit(1);
      }
      toolCall(sessionId, "fixture-tool-1", "Read", "running");
      await sleep(60);
      chunk(sessionId, "fixture-msg-1", "first segment");
      await sleep(60);
      chunk(sessionId, "fixture-msg-1", " plus appended segment");
      toolCall(sessionId, "fixture-tool-1", "Read", "success");
      toolCall(sessionId, "zdesktop-approval", "Approval required in the Zcode desktop (this workbench cannot approve it)", "in_progress");
      await sleep(60);
      toolCall(sessionId, "zdesktop-approval", "Approval required in the Zcode desktop (this workbench cannot approve it)", "completed");
      chunk(sessionId, "fixture-msg-2", "final answer");
      if (scenario === "hold-turn") await sleep(4000);
      await sleep(30);
      replyResult(id, { stopReason: cancelRequested ? "cancelled" : "end_turn" });
      return;
    }
    replyError(id, -32601, `method not supported by fake-acp-agent: ${method}`);
  }
}
