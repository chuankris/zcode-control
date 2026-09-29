// Adapter integration tests: node --test integrations/zcode-desktop-adapter/test/
//
// Spawns the real stdio entry (adapter.mjs) as a child process and drives it
// with JSON-RPC over stdin/stdout. The desktop side is faked by the
// fixtures/fake-remote module (loaded through the same dynamic-import path the
// adapter uses for the real remote-client), so no network, no relay, and no
// real ZCode desktop is ever touched. Turn output is driven by official V4
// conversation frame scripts (snapshot + contiguous deltas); the fake refuses
// zcode-task/getTaskSnapshot outright so a regression to the stale snapshot
// path fails loud. Secrets used here are synthetic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "adapter.mjs");
const FAKE_REMOTE_ROOT = path.join(HERE, "fixtures", "fake-remote");
// One synthetic device (sid + mid); the device-isolation test swaps the file
// content for a second device on the same relay host.
const URL_FILE_CONTENT = "https://zcode.z.ai/remote/v4?sid=SECRETSID42&hash=SECRETHASH42&t=1730000000&mid=machine-a\n";
const URL_FILE_CONTENT_OTHER_DEVICE =
  "https://zcode.z.ai/remote/v4?sid=OTHERSID77&hash=OTHERHASH77&t=1730000001&mid=machine-b\n";

const WORKSPACE = "D:\\fake-ws";
const OTHER_WORKSPACE = "D:\\other-ws";
const DESKTOP_SESSION = "dtask-1";
const TOPIC = `conversation/${DESKTOP_SESSION}`;
const SUBSCRIPTION_ID = "fsub-1";

// ---------- official V4 wire/script builders ----------

const row = (rowId, extra = {}) => ({ rowId, turnId: 1, ...extra });
const userRow = (rowId, text) => row(rowId, { kind: "userInput", text, origin: "realUser" });
const assistantRow = (rowId, text, state = "complete") =>
  row(rowId, { kind: "assistantText", text, state, assistantResponseId: "resp-1" });
const toolRow = (rowId, toolCallId, status, extra = {}) =>
  row(rowId, { kind: "toolCall", toolCallId, toolName: "Bash", status, inputText: "", ...extra });

function control(phase) {
  return {
    phase,
    sessionEnded: phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error",
    canStop: phase === "running",
    stopState: phase === "running" ? "stoppable" : "idle",
    stopTargetKind: "unknown",
    activeWorks: [],
    lastError: phase === "error" ? { code: "provider_error", message: "boom", recoverable: false, at: 0, source: "provider" } : null,
    apiRetry: null,
  };
}

function buildSnapshot(seq, { phase = "running", rows = [], pendingInteractions = [] } = {}) {
  return {
    protocolVersion: 1,
    sessionId: DESKTOP_SESSION,
    logEpoch: "e1",
    seq,
    revision: 1,
    control: control(phase),
    availability: {
      fork: { allowed: true }, compact: { allowed: true }, switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true }, queueEdit: { allowed: true }, sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: true }, resumeGoal: { allowed: true },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "default" },
    config: {},
    usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    queue: { items: [], autoDrain: true },
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    pendingInteractions,
    rows: { window: rows, totalCount: rows.length, firstRowId: rows.length > 0 ? rows[0].rowId : null },
  };
}

function wireFrame(fromSeq, toSeq, payload) {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: `lf-${toSeq}`,
    logicalFrameOrdinal: toSeq,
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    frame: { topic: TOPIC, subscriptionId: SUBSCRIPTION_ID, fromSeq, toSeq, sentAt: Date.now(), payload },
  };
}

const snapWire = (seq, opts) => wireFrame(0, seq, { kind: "snapshot", snapshot: buildSnapshot(seq, opts) });
const deltaWire = (fromSeq, toSeq, deltas) => wireFrame(fromSeq, toSeq, { kind: "deltas", deltas });
const appended = (rowValue) => ({ op: "row.appended", row: rowValue });
const upserted = (rowValue) => ({ op: "row.upserted", row: rowValue });
const textDelta = (rowId, append) => ({ op: "row.delta", rowId, path: "text", append });
const stateUpdated = (patch) => ({ op: "state.updated", patch });
const terminal = (phase = "completedSuccess") => stateUpdated({ control: control(phase) });

/** Splits one logical frame into official crc32-guarded fragment wires. */
function fragmentsOf(logicalFrame, count) {
  const bytes = Buffer.from(JSON.stringify(logicalFrame.frame), "utf8");
  const checksum = { algorithm: "crc32", value: zlibCrc32(bytes).toString(16).padStart(8, "0") };
  const size = Math.ceil(bytes.length / count);
  return Array.from({ length: count }, (_, index) => ({
    wireVersion: 3,
    kind: "fragment",
    deliveryKind: "online",
    logicalFrameId: logicalFrame.logicalFrameId,
    logicalFrameOrdinal: logicalFrame.logicalFrameOrdinal,
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    fragmentIndex: index,
    fragmentCount: count,
    logicalBytes: bytes.length,
    checksum,
    dataBase64: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
  }));
}

function scenario({ workspace = WORKSPACE, requestTimeoutMs = 1500, pollIntervalMs = 120, turnTimeoutMs = 2000 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zdsk-adapter-"));
  const urlFile = path.join(dir, "remote-url.txt");
  writeFileSync(urlFile, URL_FILE_CONTENT);
  const stateDir = path.join(dir, "state");
  const scriptFile = path.join(dir, "v4-script.json");
  const configFile = path.join(dir, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      remoteClientRoot: FAKE_REMOTE_ROOT,
      connectionUrlFile: urlFile,
      workspace,
      stateDir,
      requestTimeoutMs,
      pollIntervalMs,
      turnTimeoutMs,
    }),
  );
  return {
    dir,
    configFile,
    stateDir,
    scriptFile,
    journalFile: path.join(dir, "journal.jsonl"),
    urlFile,
    bindingsDir: path.join(stateDir, "bindings"),
  };
}

function fakeEnv(sc, { script, bootstrap, ack, sendError, stopError, registerError, registerDelayMs, bootstrapDelayMs, connectError, taskList, listTasksError } = {}) {
  if (script !== undefined) writeFileSync(sc.scriptFile, JSON.stringify(script));
  const env = {
    ZCODE_FAKE_JOURNAL: sc.journalFile,
    ZCODE_FAKE_STATE_DIR: sc.bindingsDir,
    ZCODE_FAKE_V4_SCRIPT_FILE: sc.scriptFile,
    ...(bootstrap === undefined ? {} : { ZCODE_FAKE_BOOTSTRAP: JSON.stringify(bootstrap) }),
    ...(ack === undefined ? {} : { ZCODE_FAKE_ACK: JSON.stringify(ack) }),
    ...(sendError === undefined ? {} : { ZCODE_FAKE_SEND_ERROR: sendError }),
    ...(stopError === undefined ? {} : { ZCODE_FAKE_STOP_ERROR: stopError }),
    ...(registerError === undefined ? {} : { ZCODE_FAKE_REGISTER_ERROR: registerError }),
    ...(registerDelayMs === undefined ? {} : { ZCODE_FAKE_REGISTER_DELAY_MS: String(registerDelayMs) }),
    ...(bootstrapDelayMs === undefined ? {} : { ZCODE_FAKE_BOOTSTRAP_DELAY_MS: String(bootstrapDelayMs) }),
    ...(connectError === undefined ? {} : { ZCODE_FAKE_CONNECT_ERROR: connectError }),
    ...(taskList === undefined ? {} : { ZCODE_FAKE_TASK_LIST: JSON.stringify(taskList) }),
    ...(listTasksError === undefined ? {} : { ZCODE_FAKE_LIST_TASKS_ERROR: listTasksError }),
  };
  return { ...process.env, ...env };
}

/** Legal ACP ContentBlock variants (message chunks and inner tool content). */
const LEGAL_CONTENT_BLOCK_TYPES = new Set(["text", "image", "audio", "resource_link", "resource"]);
/** Legal ACP ToolCallContent variants (tool_call / tool_call_update content). */
const LEGAL_TOOL_CALL_CONTENT_TYPES = new Set(["content", "diff", "terminal"]);

/** Minimal session/update contract checks the DSH SDK enforces on receipt. */
function protocolViolationsOf(message) {
  const violations = [];
  const update = message.params?.update;
  if (message.method !== "session/update" || typeof update?.sessionUpdate !== "string") return violations;
  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
    const content = update.content;
    if (content?.type !== "text" || typeof content.text !== "string") {
      violations.push(`${update.sessionUpdate} content must be a text ContentBlock`);
    }
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    if (typeof update.toolCallId !== "string" || typeof update.title !== "string") {
      violations.push(`${update.sessionUpdate} requires string toolCallId and title`);
    }
    for (const block of Array.isArray(update.content) ? update.content : []) {
      if (!LEGAL_TOOL_CALL_CONTENT_TYPES.has(block?.type)) {
        violations.push(`${update.sessionUpdate} content block type '${String(block?.type)}' is not a legal ToolCallContent variant`);
      } else if (block.type === "content") {
        // The 'content' variant wraps one plain ContentBlock.
        if (!LEGAL_CONTENT_BLOCK_TYPES.has(block.content?.type)) {
          violations.push(`${update.sessionUpdate} wrapped block type '${String(block.content?.type)}' is not a legal ContentBlock`);
        } else if (block.content.type === "text" && typeof block.content.text !== "string") {
          violations.push(`${update.sessionUpdate} wrapped text block must carry a string text`);
        }
      }
    }
  }
  return violations;
}

class AdapterProc {
  constructor(sc, env) {
    this.sc = sc;
    this.proc = spawn(process.execPath, [ADAPTER, "--config", sc.configFile], {
      cwd: path.dirname(ADAPTER),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.pending = new Map();
    this.notifications = [];
    this.allNotifications = [];
    this.notificationWaiters = [];
    this.protocolViolations = [];
    this.stderrText = "";
    this.nextId = 0;
    this.exited = new Promise((resolve) => this.proc.once("exit", resolve));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderrText += chunk;
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve } = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve(message);
        continue;
      }
      this.notifications.push(message);
      this.allNotifications.push(message);
      this.protocolViolations.push(...protocolViolationsOf(message));
      for (const waiter of [...this.notificationWaiters]) waiter();
    }
  }

  send(message) {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 20_000) {
    const id = `t${(this.nextId += 1)}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async waitForNotification(predicate, timeoutMs = 15_000) {
    const found = () => this.notifications.findIndex(predicate);
    let existing = found();
    if (existing !== -1) return this.consume(existing);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const late = found();
        if (late !== -1) resolve(this.consume(late));
        else reject(new Error("expected notification did not arrive"));
      }, timeoutMs);
      const poll = () => {
        const match = found();
        if (match === -1) return;
        clearTimeout(timer);
        this.notificationWaiters = this.notificationWaiters.filter((waiter) => waiter !== poll);
        resolve(this.consume(match));
      };
      this.notificationWaiters.push(poll);
    });
  }

  /** Removes a notification so the next wait sees only unconsumed ones. */
  consume(index) {
    return this.notifications.splice(index, 1)[0];
  }

  async stop() {
    this.proc.kill();
    await this.exited;
  }
}

function readJournal(sc) {
  if (!existsSync(sc.journalFile)) return [];
  return readFileSync(sc.journalFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function journalCalls(sc) {
  return readJournal(sc).filter((entry) => entry.kind === "call").map((entry) => entry.value);
}

function journalSendChecks(sc) {
  return readJournal(sc).filter((entry) => entry.kind === "send-check").map((entry) => entry.value);
}

/** Resolves once a journal entry matching the predicate has been appended. */
async function waitForJournal(sc, predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  for (;;) {
    if (readJournal(sc).some(predicate)) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error("expected journal entry did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function promptBlocks(...texts) {
  return texts.map((text) => ({ type: "text", text }));
}

async function cleanup(sc) {
  rmSync(sc.dir, { recursive: true, force: true });
}

async function initialize(adapter) {
  await adapter.request("initialize", { protocolVersion: 1 });
}

test("initialize advertises text-only desktop capabilities with loadSession", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc));
  try {
    const init = await adapter.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.error, undefined);
    const caps = init.result.agentCapabilities;
    assert.equal(init.result.protocolVersion, 1);
    assert.equal(caps.loadSession, true);
    assert.deepEqual(caps.promptCapabilities, { image: false, audio: false, embeddedContext: false });
    assert.deepEqual(caps.mcpCapabilities, { http: false, sse: false, acp: false });
    assert.deepEqual(caps.sessionCapabilities, { list: {} });
    const unknown = await adapter.request("session/set_mode", { sessionId: "x", modeId: "y" });
    assert.equal(unknown.error.code, -32601);
    const missing = await adapter.request("session/load", { sessionId: "zdsk-does-not-exist" });
    assert.equal(missing.error.code, -32002);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("create → prompt streams only new-turn output and persists the accepted desktop session", async () => {
  const sc = scenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(userRow(1, "Fix the login bug"))]),
      deltaWire(2, 3, [appended(assistantRow(2, "Fixed. DESKTOP_OK"))]),
      deltaWire(3, 4, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const created = await adapter.request("session/new", { cwd: "D:\\workbench-cwd" });
    const sessionId = created.result.sessionId;
    assert.match(sessionId, /^zdsk-[0-9a-f-]+$/);

    const prompt = adapter.request("session/prompt", {
      sessionId,
      prompt: await promptBlocks(
        `${"Current host instructions (replace earlier host instructions for this request)."}\nInternal host rule: never deploy to prod`,
        "Fix the login bug",
      ),
    });
    const assistantChunk = await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.sessionUpdate === "agent_message_chunk",
    );
    assert.equal(assistantChunk.params.update.content.text, "Fixed. DESKTOP_OK");
    const settled = await prompt;
    assert.equal(settled.error, undefined);
    assert.equal(settled.result.stopReason, "end_turn");
    assert.equal(
      adapter.allNotifications.filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk").length,
      1,
      "old-turn history must not be replayed as new chunks",
    );
    assert.equal(
      adapter.allNotifications.filter((n) => n.params?.update?.sessionUpdate === "user_message_chunk").length,
      0,
      "a prompt turn must not echo the user text back — only session/load replay emits user chunks",
    );

    const calls = journalCalls(sc);
    const create = calls.find((call) => call.channel === "zcode-agent" && call.name === "sendConversationCommandV4");
    assert.equal(create.args[0].envelope.type, "createSession");
    assert.equal(create.args[0].envelope.commandId.length > 0, true);
    // The conversation handshake precedes the dispatched command (the bridge
    // assignment bug made every post-connect call unusable).
    const sendIndex = calls.indexOf(create);
    const helloIndex = calls.findIndex((call) => call.channel === "zcode-agent" && call.name === "helloConversationV4");
    const initIndex = calls.findIndex((call) => call.channel === "zcode-agent" && call.name === "initializeConversationV4");
    assert.ok(helloIndex !== -1 && initIndex !== -1 && helloIndex < sendIndex && initIndex < sendIndex);
    // The output subscription goes up after the accepted create and comes
    // down at the turn boundary — the relay slot is released per turn.
    const subscribeIndex = calls.findIndex((call) => call.name === "subscribeConversationV4");
    assert.ok(subscribeIndex > sendIndex, "the new task is subscribed after the accepted create");
    assert.equal(calls[subscribeIndex].args[0].sessionId, DESKTOP_SESSION);
    assert.equal(
      calls.filter((call) => call.name === "unsubscribeConversationV4").length >= 1,
      true,
      "the turn ends by unsubscribing the conversation stream",
    );
    assert.equal(
      calls.filter((call) => call.channel === "zcode-task" && call.name === "getTaskSnapshot").length,
      0,
      "the turn must never read the stale zcode-task snapshot",
    );
    const sentText = create.args[0].envelope.payload.firstInput.text;
    assert.ok(sentText.startsWith("Fix the login bug"), "the real user task must lead the composed text");
    assert.ok(sentText.includes("never deploy to prod"), "host-instruction content must be preserved");
    const sendCheck = journalSendChecks(sc).find((check) => check.type === "createSession");
    assert.equal(sendCheck.dispatchPersistedBeforeSend, true, "command id must be persisted before the envelope is sent");

    const binding = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));
    assert.equal(binding.desktopSessionId, DESKTOP_SESSION);
    assert.equal(binding.dispatch, null);

    const listed = await adapter.request("session/list", {});
    assert.deepEqual(listed.result.sessions.map((session) => session.sessionId), [sessionId]);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("turn frames received during desktop registration are still streamed", async () => {
  const sc = scenario();
  const script = {
    frameDelayMs: 1,
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "FAST_REPLY"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script, registerDelayMs: 100 }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const result = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Reply quickly") });
    assert.equal(result.error, undefined);
    assert.equal(result.result.stopReason, "end_turn");
    assert.equal(
      adapter.allNotifications.filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((n) => n.params.update.content.text).join(""),
      "FAST_REPLY",
    );
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("adapter restart resumes the bound desktop session through session/load", async () => {
  const sc = scenario();
  const history = [
    userRow(1, "old question"),
    assistantRow(2, "old answer"),
    userRow(3, "Fix the login bug"),
    assistantRow(4, "Fixed. DESKTOP_OK"),
  ];
  const firstScript = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 4, [appended(assistantRow(4, "Fixed. DESKTOP_OK"))]),
      deltaWire(4, 5, [terminal()]),
    ],
  };
  const first = new AdapterProc(sc, fakeEnv(sc, { script: firstScript }));
  let sessionId;
  try {
    await initialize(first);
    sessionId = (await first.request("session/new", {})).result.sessionId;
    const prompt = first.request("session/prompt", { sessionId, prompt: await promptBlocks("Fix the login bug") });
    assert.equal((await prompt).result.stopReason, "end_turn");
  } finally {
    await first.stop();
  }
  try {
    // subscribeTurns serve both the session/load replay and the second-turn
    // baseline: the Nth subscription replays the authoritative snapshot.
    const secondScript = {
      subscribeTurns: [[snapWire(10, { phase: "completedSuccess", rows: history })], [snapWire(10, { phase: "completedSuccess", rows: history })]],
      frames: [
        deltaWire(10, 11, [appended(userRow(5, "Second turn please"))]),
        deltaWire(11, 12, [appended(assistantRow(6, "Second turn done"))]),
        deltaWire(12, 13, [terminal()]),
      ],
    };
    const second = new AdapterProc(sc, fakeEnv(sc, { script: secondScript }));
    try {
      await initialize(second);
      const loaded = second.request("session/load", { sessionId });
      const replay = await second.waitForNotification(
        (n) => n.method === "session/update" && n.params.update.content?.text === "Fixed. DESKTOP_OK",
      );
      assert.equal(replay.params.update.sessionUpdate, "agent_message_chunk");
      const replayedUser = await second.waitForNotification(
        (n) => n.method === "session/update" && n.params.update.content?.text === "old question",
      );
      assert.equal(replayedUser.params.update.sessionUpdate, "user_message_chunk", "load replay is where user history is rendered");
      assert.equal((await loaded).result !== undefined, true);

      const prompt = second.request("session/prompt", { sessionId, prompt: await promptBlocks("Second turn please") });
      const chunk = await second.waitForNotification(
        (n) => n.method === "session/update" && n.params.update.content?.text === "Second turn done",
      );
      assert.equal(chunk.params.sessionId, sessionId);
      assert.equal((await prompt).result.stopReason, "end_turn");
      assert.equal(
        second.allNotifications.filter((n) => n.params?.update?.sessionUpdate === "user_message_chunk").length,
        2,
        "the resumed turn must not echo user text; only the two replayed history users may appear",
      );
      const calls = journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4");
      const sendText = calls.find((call) => call.args[0].envelope.type === "sendText");
      assert.notEqual(sendText, undefined, "the resumed turn must go through sendText");
      assert.equal(sendText.args[0].envelope.sessionId, DESKTOP_SESSION);
      assert.equal(sendText.args[0].envelope.payload.requestedDelivery, "startNow");
    } finally {
      await second.stop();
    }
  } finally {
    await cleanup(sc);
  }
});

test("workspace must match exactly one registered desktop workspace", async () => {
  for (const bootstrap of [
    { desktopAppVersion: "3.14.0-fake", workspaces: [{ workspacePath: "D:\\somewhere-else" }] },
    {
      desktopAppVersion: "3.14.0-fake",
      workspaces: [{ workspacePath: "D:\\fake-ws" }, { workspacePath: "D:\\fake-ws\\" }],
    },
  ]) {
    const sc = scenario();
    const adapter = new AdapterProc(sc, fakeEnv(sc, { bootstrap }));
    try {
      await initialize(adapter);
      const sessionId = (await adapter.request("session/new", {})).result.sessionId;
      const prompt = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("hello") });
      assert.equal(prompt.error.code, -32003);
      assert.equal(journalCalls(sc).length, 0, "no channel call may happen without an unambiguous workspace bridge");
    } finally {
      await adapter.stop();
      await cleanup(sc);
    }
  }
});

test("non-text prompt blocks are rejected before anything is dispatched", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const image = await adapter.request("session/prompt", {
      sessionId,
      prompt: [{ type: "image", data: "x" }, { type: "text", text: "hi" }],
    });
    assert.equal(image.error.code, -32602);
    assert.match(image.error.message, /text content blocks only/);
    const empty = await adapter.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "" }] });
    assert.equal(empty.error.code, -32602);
    assert.equal(journalCalls(sc).length, 0);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("concurrent prompts are rejected and only one turn is dispatched", async () => {
  const sc = scenario();
  const script = { frames: [snapWire(1, { phase: "running" })] };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const first = (await adapter.request("session/new", {})).result.sessionId;
    const second = (await adapter.request("session/new", {})).result.sessionId;
    const runningPrompt = adapter.request("session/prompt", { sessionId: first, prompt: await promptBlocks("first turn") });
    await waitForJournal(sc, (entry) => entry.kind === "call" && entry.value?.name === "sendConversationCommandV4");
    const rejected = await adapter.request("session/prompt", { sessionId: second, prompt: await promptBlocks("second turn") });
    assert.equal(rejected.error.code, -32001);
    const dispatched = journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4");
    assert.equal(dispatched.length, 1);
    runningPrompt.catch(() => {}); // the turn never settles in this test; the process is killed below
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a lost ack records an unresolved dispatch and blocks further prompts without resending", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(
    sc,
    fakeEnv(sc, { sendError: "TimeoutError: Remote request sendConversationCommandV4 timed out after 1500ms." }),
  );
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const failed = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("will vanish") });
    assert.equal(failed.error.code, -32005);
    assert.match(failed.error.message, /outcome is unknown/);
    const binding = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));
    assert.equal(typeof binding.dispatch.commandId, "string");
    assert.equal(binding.dispatch.kind, "createSession");
    const blocked = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("try again") });
    assert.equal(blocked.error.code, -32002);
    assert.match(blocked.error.message, /outcome is unknown/);
    assert.equal(journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length, 1, "never resend an unresolved command");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

// ---------- sendConversationCommandV4 acknowledgement contract (3.14.x) ----------
//
// The official contract (ZCode-official 3.14.0 commandAckSchema; the 3.14.3
// desktop bundle's assertV4CommandAckOk) carries a finite status set —
// accepted/rejected/stale/duplicate/noop/failed — either flat on the RPC reply
// (observed live 2026-09-21) or nested under `ack` like the other conversation
// RPC results (subscribeConversationV4 observed live 2026-09-28). Recognition
// stays strict: an unknown shape, an unknown status value, or a reply naming
// another command is never a confirmation, and a refusal never counts as
// delivery.

const ackOf = (status, extra = {}) => ({ status, revisionAtDecision: 1, ...extra });
const sendCount = (sc) => journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length;
const createTaskCount = (sc) =>
  journalCalls(sc).filter((call) => call.channel === "zcode-task" && call.name === "createTask").length;
const bindingOf = (sc, sessionId) => JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));

test("a flat accepted ack echoing the command id confirms a fresh dispatch", async () => {
  const sc = scenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "Confirmed. FLAT_OK"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script,
    ack: ackOf("accepted", { result: { type: "createSession", sessionId: DESKTOP_SESSION } }),
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("flat ack please") });
    const chunk = await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.content?.text === "Confirmed. FLAT_OK",
    );
    assert.equal(chunk.params.sessionId, sessionId);
    assert.equal((await prompt).result.stopReason, "end_turn");
    assert.equal(sendCount(sc), 1);
    assert.equal(createTaskCount(sc), 1);
    const binding = bindingOf(sc, sessionId);
    assert.equal(binding.desktopSessionId, DESKTOP_SESSION);
    assert.equal(binding.dispatch, null);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("an enveloped accepted ack confirms a continuation dispatch exactly once", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: adoptTerminalScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    ack: { ack: ackOf("accepted") },
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/adopt", { taskId: DESKTOP_SESSION })).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Round two please") });
    const chunk = await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.content?.text === "Round two done",
    );
    assert.equal(chunk.params.sessionId, sessionId);
    assert.equal((await prompt).result.stopReason, "end_turn");
    assert.equal(sendCount(sc), 1, "exactly one desktop command may leave the process");
    assert.equal(createTaskCount(sc), 0, "an adopted task must never be re-registered");
    assert.equal(bindingOf(sc, sessionId).dispatch, null);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("an explicit rejection names its reason, clears the ledger, and allows exactly one fresh dispatch", async () => {
  const sc = scenario();
  const script = { frames: [snapWire(1, { phase: "running" })] };
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script,
    ack: ackOf("rejected", { reasonCode: "fault.command.clientMismatch", message: "terminal binding lost" }),
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const first = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("one") });
    assert.equal(first.error.code, -32005);
    assert.match(first.error.message, /refused the createSession command/);
    assert.match(first.error.message, /status rejected/);
    assert.match(first.error.message, /fault\.command\.clientMismatch/);
    assert.equal(bindingOf(sc, sessionId).dispatch, null, "a proven refusal was never applied; the ledger must clear");
    assert.equal(createTaskCount(sc), 0);
    const second = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("two") });
    assert.match(second.error.message, /refused the createSession command/, "the fresh retry dispatches once more");
    assert.equal(sendCount(sc), 2, "exactly one fresh retry after the refusal, never more");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a stale resolution is a proven non-application: refused, ledger cleared, no task created", async () => {
  const sc = scenario();
  const script = { frames: [snapWire(1, { phase: "running" })] };
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script,
    ack: ackOf("stale", { reasonCode: "proto.revisionMoved" }),
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const failed = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("one") });
    assert.equal(failed.error.code, -32005);
    assert.match(failed.error.message, /refused the createSession command/);
    assert.match(failed.error.message, /status stale/);
    assert.equal(bindingOf(sc, sessionId).dispatch, null);
    assert.equal(createTaskCount(sc), 0);
    assert.equal(sendCount(sc), 1);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a failed resolution keeps the dispatch blocked and reports the unknown outcome", async () => {
  const sc = scenario();
  const script = { frames: [snapWire(1, { phase: "running" })] };
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script,
    ack: ackOf("failed", { reasonCode: "fault.command.transport" }),
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const failed = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("one") });
    assert.equal(failed.error.code, -32005);
    assert.match(failed.error.message, /failed the createSession command/);
    assert.match(failed.error.message, /outcome is unknown/);
    const binding = bindingOf(sc, sessionId);
    assert.equal(typeof binding.dispatch.commandId, "string", "an unproven application keeps the ledger blocking");
    const blocked = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("two") });
    assert.equal(blocked.error.code, -32002);
    assert.match(blocked.error.message, /outcome is unknown/);
    assert.equal(sendCount(sc), 1);
    assert.equal(createTaskCount(sc), 0);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a noop resolution is recognized as not applied and keeps the dispatch blocked", async () => {
  const sc = scenario();
  const script = { frames: [snapWire(1, { phase: "running" })] };
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script,
    ack: ackOf("noop", { reasonCode: "proto.alreadyResolved" }),
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const failed = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("one") });
    assert.equal(failed.error.code, -32005);
    assert.match(failed.error.message, /noop, not applied/);
    assert.match(failed.error.message, /proto\.alreadyResolved/);
    assert.equal(typeof bindingOf(sc, sessionId).dispatch.commandId, "string", "not-applied still blocks until a human verifies the desktop");
    const blocked = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("two") });
    assert.equal(blocked.error.code, -32002);
    assert.equal(sendCount(sc), 1);
    assert.equal(createTaskCount(sc), 0);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("unrecognized acknowledgements never confirm: unknown status, foreign command id, conflicting shapes", async () => {
  const variants = [
    { name: "status outside the proven enum", ack: ackOf("celebrated") },
    { name: "ack naming another command", ack: ackOf("accepted", { commandId: "11111111-1111-4111-8111-111111111111" }) },
    { name: "two conflicting known statuses", ack: { status: "accepted", revisionAtDecision: 1, ack: ackOf("rejected") } },
  ];
  for (const variant of variants) {
    const sc = scenario();
    const script = { frames: [snapWire(1, { phase: "running" })] };
    const adapter = new AdapterProc(sc, fakeEnv(sc, { script, ack: variant.ack }));
    try {
      await initialize(adapter);
      const sessionId = (await adapter.request("session/new", {})).result.sessionId;
      const failed = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("one") });
      assert.equal(failed.error.code, -32005, variant.name);
      assert.match(failed.error.message, /unrecognized acknowledgement/, variant.name);
      assert.match(failed.error.message, /outcome is unknown/, variant.name);
      assert.equal(typeof bindingOf(sc, sessionId).dispatch.commandId, "string", variant.name);
      const blocked = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("two") });
      assert.equal(blocked.error.code, -32002, variant.name);
      assert.equal(sendCount(sc), 1, `never resend on an unrecognized reply (${variant.name})`);
      assert.equal(createTaskCount(sc), 0, variant.name);
    } finally {
      await adapter.stop();
      await cleanup(sc);
    }
  }
});

test("an enveloped accepted stop ack verifies the desktop stop", async () => {
  const sc = scenario();
  const script = {
    frames: [snapWire(1, { phase: "running" })],
    stopFrames: [deltaWire(1, 2, [terminal("completedInterrupted")])],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script,
    ack: { ack: ackOf("accepted", { result: { type: "createSession", sessionId: DESKTOP_SESSION } }) },
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("long task") });
    await waitForJournal(sc, (entry) => entry.kind === "call" && entry.value?.name === "sendConversationCommandV4");
    adapter.notify("session/cancel", { sessionId });
    const settled = await prompt;
    assert.equal(settled.error, undefined);
    assert.equal(settled.result.stopReason, "cancelled");
    const stops = journalCalls(sc).filter((call) => call.args[0]?.envelope?.type === "stop");
    assert.equal(stops.length, 1);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("connection credentials and URLs never reach stdout or stderr", async () => {
  const sc = scenario();
  const firstScript = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "a1"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const first = new AdapterProc(sc, fakeEnv(sc, { script: firstScript }));
  let sessionId;
  try {
    await initialize(first);
    sessionId = (await first.request("session/new", {})).result.sessionId;
    const prompt = first.request("session/prompt", { sessionId, prompt: await promptBlocks("q") });
    assert.equal((await prompt).result.stopReason, "end_turn");
  } finally {
    await first.stop();
  }
  try {
    // Streamed row text poisoned with the full credential URL: every surface
    // must come back scrubbed.
    const poisoned = "leak https://zcode.z.ai/remote/v4?sid=SECRETSID42&hash=SECRETHASH42 wss://zcode.z.ai/ws";
    const secondScript = {
      subscribeTurns: [[snapWire(10, { phase: "completedSuccess", rows: [] })]],
      frames: [
        deltaWire(10, 11, [appended(assistantRow(2, poisoned))]),
        deltaWire(11, 12, [terminal()]),
      ],
      resyncError: `resync failed (https://zcode.z.ai/remote/v4?sid=SECRETSID42&hash=SECRETHASH42)`,
    };
    const second = new AdapterProc(sc, fakeEnv(sc, { script: secondScript }));
    try {
      await initialize(second);
      const prompt = second.request("session/prompt", { sessionId, prompt: await promptBlocks("again") });
      const chunk = await second.waitForNotification(
        (n) => n.method === "session/update" && n.params.update.sessionUpdate === "agent_message_chunk",
      );
      const settled = await prompt;
      // Content chunks are credential-scrubbed (the sid and hash values must
      // vanish); the error and stderr surfaces are additionally URL-free.
      assert.ok(!chunk.params.update.content.text.includes("SECRETSID42"), "device sid leaked into content");
      assert.ok(!chunk.params.update.content.text.includes("SECRETHASH42"), "pass hash leaked into content");
      const cleanSurfaces = [second.stderrText];
      if (settled.error !== undefined) cleanSurfaces.push(settled.error.message);
      for (const surface of cleanSurfaces) {
        assert.ok(!surface.includes("SECRETSID42"), "device sid leaked");
        assert.ok(!surface.includes("SECRETHASH42"), "pass hash leaked");
        assert.ok(!surface.includes("zcode.z.ai"), "relay host leaked");
        assert.ok(!/wss?:\/\//.test(surface), "relay URL leaked");
      }
    } finally {
      await second.stop();
    }
  } finally {
    await cleanup(sc);
  }
});

test("a terminal phase without new assistant rows never ends the turn", async () => {
  const sc = scenario({ turnTimeoutMs: 1200 });
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(userRow(1, "new turn"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const timedOut = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("new turn") });
    assert.equal(timedOut.error.code, -32005);
    assert.match(timedOut.error.message, /deadline|may still be running/);
    assert.equal(journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length, 1);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("session/cancel returns cancelled only after the desktop observed a terminal state", async () => {
  const sc = scenario();
  const script = {
    frames: [snapWire(1, { phase: "running" })],
    stopFrames: [deltaWire(1, 2, [terminal("completedInterrupted")])],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("long task") });
    await waitForJournal(sc, (entry) => entry.kind === "call" && entry.value?.name === "sendConversationCommandV4");
    adapter.notify("session/cancel", { sessionId });
    const settled = await prompt;
    assert.equal(settled.error, undefined);
    assert.equal(settled.result.stopReason, "cancelled");
    const stops = journalCalls(sc).filter((call) => call.args[0]?.envelope?.type === "stop");
    assert.equal(stops.length, 1);
    assert.equal(stops[0].args[0].envelope.sessionId, DESKTOP_SESSION);
    assert.deepEqual(stops[0].args[0].envelope.payload, {});
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("an accepted stop ack alone never reports cancelled while the task keeps running", async () => {
  const sc = scenario({ turnTimeoutMs: 1500 });
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "tick"))]),
    ],
    stopFrames: [deltaWire(2, 3, [stateUpdated({ control: control("running") })])],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("never stops") });
    await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.sessionUpdate === "agent_message_chunk",
    );
    adapter.notify("session/cancel", { sessionId });
    const settled = await prompt;
    assert.notEqual(settled?.result?.stopReason, "cancelled", "a stop ack is delivery, not a terminal state");
    assert.equal(settled.error.code, -32005);
    assert.match(settled.error.message, /unknown|deadline/);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a stop command that cannot be confirmed reports unknown state instead of cancelled", async () => {
  const sc = scenario({ turnTimeoutMs: 1200 });
  const script = { frames: [snapWire(1, { phase: "running" })] };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script, stopError: "TimeoutError: stop command timed out" }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("stop is flaky") });
    await waitForJournal(sc, (entry) => entry.kind === "call" && entry.value?.name === "sendConversationCommandV4");
    adapter.notify("session/cancel", { sessionId });
    const settled = await prompt;
    assert.notEqual(settled?.result?.stopReason, "cancelled");
    assert.equal(settled.error.code, -32005);
    assert.match(settled.error.message, /unknown|confirm/);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("persistent stream faults resync within the turn deadline and never resend the command", async () => {
  const sc = scenario({ requestTimeoutMs: 8000, pollIntervalMs: 100, turnTimeoutMs: 1200 });
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      { wireVersion: 99, kind: "complete", topic: TOPIC, subscriptionId: SUBSCRIPTION_ID, frame: null },
    ],
    resyncError: "cheap transient error",
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const startedAt = Date.now();
    const settled = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("flaky") });
    const elapsed = Date.now() - startedAt;
    assert.equal(settled.error.code, -32005);
    assert.ok(elapsed < 5000, `recovery must respect the turn deadline (took ${elapsed}ms)`);
    assert.equal(journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length, 1);
    assert.ok(journalCalls(sc).some((call) => call.name === "resyncConversationV4"), "a wire fault triggers a server resync");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a missed terminal frame is recovered by an idle V4 resync without command resend", async () => {
  const sc = scenario({ requestTimeoutMs: 1500, pollIntervalMs: 100, turnTimeoutMs: 2500 });
  const script = {
    subscribeTurns: [[]],
    resyncFrames: [snapWire(8, { phase: "completedSuccess", rows: [assistantRow(2, "Visible progress\nFinal")] })],
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "Visible progress", "streaming"))]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const result = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Finish even if terminal is missed") });
    assert.equal(result.error, undefined);
    assert.equal(result.result.stopReason, "end_turn");
    assert.equal(
      adapter.allNotifications
        .filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((n) => n.params.update.content.text).join(""),
      "Visible progress\nFinal",
      "the recovered snapshot must complete the streamed answer",
    );
    assert.equal(journalCalls(sc).filter((call) => call.name === "subscribeConversationV4").length, 1);
    assert.equal(journalCalls(sc).filter((call) => call.name === "resyncConversationV4").length, 1);
    assert.equal(journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length, 1);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a silent idle resync escalates to one subscription rebuild and never resends", async () => {
  const sc = scenario({ requestTimeoutMs: 1500, pollIntervalMs: 100, turnTimeoutMs: 4000 });
  const script = {
    // The resync acks but its forced snapshot never arrives: the route is
    // silently dead, so the next idle wake must rebuild the subscription
    // instead of resyncing the same dead route forever.
    subscribeTurns: [[], [snapWire(9, { phase: "completedSuccess", rows: [assistantRow(2, "Final via rebuild")] })]],
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "Partial", "streaming"))]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const result = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("resync goes quiet") });
    assert.equal(result.error, undefined);
    assert.equal(result.result.stopReason, "end_turn");
    assert.deepEqual(
      adapter.allNotifications
        .filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((n) => n.params.update.content.text),
      ["Partial", "Final via rebuild"],
      "the rebuild's snapshot must complete the answer the dead route dropped",
    );
    const calls = journalCalls(sc);
    assert.equal(calls.filter((call) => call.name === "resyncConversationV4").length, 1, "resync is tried first on the live subscription");
    assert.equal(calls.filter((call) => call.name === "subscribeConversationV4").length, 2, "the silent route escalates to exactly one rebuild");
    assert.equal(calls.filter((call) => call.name === "sendConversationCommandV4").length, 1, "recovery never re-sends the user command");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a refused idle resync falls back to the subscription rebuild without resending", async () => {
  const sc = scenario({ requestTimeoutMs: 1500, pollIntervalMs: 100, turnTimeoutMs: 2500 });
  const script = {
    subscribeTurns: [[], [snapWire(9, { phase: "completedSuccess", rows: [assistantRow(2, "Recovered after refused resync")] })]],
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "Streaming", "streaming"))]),
    ],
    resyncError: "resync route refused",
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const result = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("resync is refused") });
    assert.equal(result.error, undefined);
    assert.equal(result.result.stopReason, "end_turn");
    assert.deepEqual(
      adapter.allNotifications
        .filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((n) => n.params.update.content.text),
      ["Streaming", "Recovered after refused resync"],
    );
    const calls = journalCalls(sc);
    assert.equal(calls.filter((call) => call.name === "resyncConversationV4").length, 1, "the resync attempt is made exactly once");
    assert.equal(calls.filter((call) => call.name === "subscribeConversationV4").length, 2, "the refused resync rebuilds the subscription exactly once");
    assert.equal(calls.filter((call) => call.name === "sendConversationCommandV4").length, 1, "recovery never re-sends the user command");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a growing assistant row streams deltas under one messageId", async () => {
  const sc = scenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "Part one. ", "streaming"))]),
      deltaWire(2, 3, [textDelta(2, "Part two.")]),
      deltaWire(3, 4, [textDelta(2, " FINISHED")]),
      deltaWire(4, 5, [upserted(assistantRow(2, "Part one. Part two. FINISHED")), terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("grow") });
    const chunks = [];
    for (const expected of ["Part one. ", "Part two.", " FINISHED"]) {
      const chunk = await adapter.waitForNotification(
        (n) => n.method === "session/update" && n.params.update.sessionUpdate === "agent_message_chunk",
      );
      assert.equal(chunk.params.update.content.text, expected);
      chunks.push(chunk);
    }
    assert.deepEqual(
      chunks.map((chunk) => chunk.params.update.content.text),
      ["Part one. ", "Part two.", " FINISHED"],
    );
    assert.deepEqual([...new Set(chunks.map((chunk) => chunk.params.update.messageId))], ["v4row-2"]);
    assert.equal((await prompt).result.stopReason, "end_turn");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("an official row upsert rewrite starts a new message revision instead of failing the turn", async () => {
  const sc = scenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "Working draft", "streaming"))]),
      deltaWire(2, 3, [upserted(assistantRow(2, "Final answer", "complete"))]),
      deltaWire(3, 4, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const result = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Rewrite") });
    assert.equal(result.error, undefined);
    assert.equal(result.result.stopReason, "end_turn");
    const chunks = adapter.allNotifications.filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk");
    assert.deepEqual(chunks.map((n) => n.params.update.content.text), ["Working draft", "Final answer"]);
    assert.deepEqual(chunks.map((n) => n.params.update.messageId), ["v4row-2", "v4row-2-revision-1"]);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("desktop tools and pending approvals project as tool cards that keep the turn running", async () => {
  const sc = scenario();
  const permission = {
    interactionId: "p1",
    kind: "permission",
    anchorRowId: null,
    createdAt: 0,
    payload: { kind: "permission", toolCallId: "tc-1", toolName: "Bash", summary: "", options: [] },
  };
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(toolRow(2, "tc-1", "running", { output: "3 passing" }))]),
      deltaWire(2, 3, [stateUpdated({ pendingInteractions: [permission] })]),
      deltaWire(3, 4, [upserted(toolRow(2, "tc-1", "success", { output: "3 passing" })), stateUpdated({ pendingInteractions: [] })]),
      deltaWire(4, 5, [appended(assistantRow(3, "working finished")), terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("with tools") });
    const running = await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.sessionUpdate === "tool_call" && n.params.update.toolCallId === "tc-1",
    );
    assert.equal(running.params.update.status, "in_progress");
    assert.equal(running.params.update.kind, "execute");
    const approvalIn = await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.toolCallId === "zdesktop-approval",
    );
    assert.equal(approvalIn.params.update.status, "in_progress");
    assert.match(approvalIn.params.update.title, /Zcode desktop/);
    const toolDone = await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.sessionUpdate === "tool_call_update" && n.params.update.toolCallId === "tc-1",
    );
    assert.equal(toolDone.params.update.status, "completed");
    const approvalOut = await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.sessionUpdate === "tool_call_update" && n.params.update.toolCallId === "zdesktop-approval",
    );
    assert.equal(approvalOut.params.update.status, "completed");
    const settled = await prompt;
    assert.equal(settled.result.stopReason, "end_turn");
    assert.deepEqual(
      adapter.protocolViolations,
      [],
      "every session/update the adapter emits must satisfy the ACP shapes DSH's SDK validates",
    );
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("official V4 text and tool output delta paths stream without a false resync", async () => {
  const sc = scenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(toolRow(2, "tc-1", "running", { output: { text: "" } }))]),
      deltaWire(2, 3, [{ op: "row.delta", rowId: 2, path: "output.text", append: "step one" }]),
      deltaWire(3, 4, [upserted(toolRow(2, "tc-1", "success", { output: { text: "step one" } }))]),
      deltaWire(4, 5, [appended(assistantRow(3, "Done", "streaming"))]),
      deltaWire(5, 6, [textDelta(3, ".")]),
      deltaWire(6, 7, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const result = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Read only") });
    assert.equal(result.error, undefined);
    assert.equal(result.result.stopReason, "end_turn");
    const updates = adapter.allNotifications.map((n) => n.params?.update).filter(Boolean);
    assert.equal(updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join(""), "Done.");
    assert.ok(updates.some((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "tc-1" &&
      u.content?.[0]?.content?.text === "step one"));
    assert.equal(journalCalls(sc).filter((call) => call.name === "resyncConversationV4").length, 0);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("an unconfirmable connection identity refuses old bindings instead of guessing", async () => {
  const sc = scenario();
  const firstScript = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "a1"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const first = new AdapterProc(sc, fakeEnv(sc, { script: firstScript }));
  let sessionId;
  try {
    await initialize(first);
    sessionId = (await first.request("session/new", {})).result.sessionId;
    const prompt = first.request("session/prompt", { sessionId, prompt: await promptBlocks("q1") });
    assert.equal((await prompt).result.stopReason, "end_turn");
  } finally {
    await first.stop();
  }
  try {
    // The URL no longer carries a parsable device identity: the adapter must
    // refuse to attribute the old binding to it, not fall back to host+path.
    writeFileSync(sc.urlFile, "https://zcode.z.ai/remote/v4?not-a-credential\n");
    const secondSc = scenario();
    writeFileSync(
      secondSc.configFile,
      JSON.stringify({
        remoteClientRoot: FAKE_REMOTE_ROOT,
        connectionUrlFile: sc.urlFile,
        workspace: WORKSPACE,
        stateDir: sc.stateDir,
        requestTimeoutMs: 1500,
        pollIntervalMs: 120,
        turnTimeoutMs: 2000,
      }),
    );
    const second = new AdapterProc(secondSc, fakeEnv(secondSc));
    try {
      await initialize(second);
      const loaded = await second.request("session/load", { sessionId });
      assert.notEqual(loaded.error, undefined, "an unconfirmable identity must not load old bindings");
      const prompted = await second.request("session/prompt", { sessionId, prompt: await promptBlocks("who am I") });
      assert.notEqual(prompted.error, undefined, "an unconfirmable identity must refuse prompts");
      const listed = await second.request("session/list", {});
      // Either an explicit error or an empty listing is a valid loud refusal;
      // returning the foreign bindings would be the only failure.
      if (listed.error === undefined) {
        assert.equal(listed.result.sessions.length, 0, "an unconfirmable identity lists nothing");
      }
      const sends = journalCalls(secondSc).filter((call) => call.name === "sendConversationCommandV4");
      assert.equal(sends.length, 0, "refusals happen before any dispatch");
    } finally {
      await second.stop();
      await cleanup(secondSc);
    }
  } finally {
    await cleanup(sc);
  }
});

test("a new user row plus a terminal phase is not completion evidence", async () => {
  const sc = scenario({ turnTimeoutMs: 1200 });
  const turnOneRows = [userRow(1, "q1"), assistantRow(2, "a1")];
  const script = {
    // Turn one creates the history; the second turn's only new row is the
    // user echo and the phase is already terminal — neither may close it.
    turns: [
      [snapWire(1, { phase: "running" }), deltaWire(1, 2, [appended(assistantRow(2, "a1")), terminal()])],
      [deltaWire(10, 11, [appended(userRow(3, "second q"))]), deltaWire(11, 12, [terminal()])],
    ],
    subscribeTurns: [[], [snapWire(10, { phase: "completedSuccess", rows: turnOneRows })]],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const first = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("q1") });
    assert.equal(first.result.stopReason, "end_turn");
    const second = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("second q") });
    assert.notEqual(second?.result?.stopReason, "end_turn", "a bare user echo must not close the turn");
    assert.equal(second.error.code, -32005);
    assert.match(second.error.message, /deadline|may still be running/);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("tools already visible in the baseline are not new-turn evidence", async () => {
  const sc = scenario({ turnTimeoutMs: 1200 });
  const baselineRows = [userRow(1, "q1"), assistantRow(2, "a1"), toolRow(3, "tc-old", "running")];
  const script = {
    turns: [
      [snapWire(1, { phase: "running" }), deltaWire(1, 2, [appended(toolRow(3, "tc-old", "running")), appended(assistantRow(2, "a1")), terminal()])],
      [deltaWire(10, 11, [appended(userRow(4, "second q"))]), deltaWire(11, 12, [terminal()])],
    ],
    subscribeTurns: [[], [snapWire(10, { phase: "completedSuccess", rows: baselineRows })]],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const first = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("q1") });
    assert.equal(first.result.stopReason, "end_turn");
    const toolUpdatesAfterTurnOne = adapter.allNotifications
      .filter((n) => n.params?.update?.toolCallId === "tc-old")
      .length;
    assert.ok(toolUpdatesAfterTurnOne >= 1, "the tool still projects in turn one");
    const second = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("second q") });
    assert.notEqual(second?.result?.stopReason, "end_turn", "a pre-existing running tool must not close the turn");
    assert.equal(second.error.code, -32005);
    const secondTurnToolNoise = adapter.allNotifications
      .filter((n) => n.params?.update?.toolCallId === "tc-old")
      .length - toolUpdatesAfterTurnOne;
    assert.equal(secondTurnToolNoise, 0, "a baseline tool must not re-emit as new-turn evidence");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a non-terminal baseline task refuses a startNow append instead of overwriting it", async () => {
  for (const busyPhase of ["running", "prewarming", "draft"]) {
    const sc = scenario();
    const script = {
      turns: [
        [snapWire(1, { phase: "running" }), deltaWire(1, 2, [appended(assistantRow(2, "a1")), terminal()])],
      ],
      subscribeTurns: [[], [snapWire(10, { phase: busyPhase, rows: [userRow(1, "q1"), assistantRow(2, "a1")] })]],
    };
    const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
    try {
      await initialize(adapter);
      const sessionId = (await adapter.request("session/new", {})).result.sessionId;
      const first = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("q1") });
      assert.equal(first.result.stopReason, "end_turn");
      const second = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("while busy") });
      assert.equal(second.result, undefined, `a ${busyPhase} baseline must refuse the prompt`);
      assert.notEqual(second.error, undefined);
      const sends = journalCalls(sc).filter((call) => call.args[0]?.envelope?.type === "sendText");
      assert.equal(sends.length, 0, "no sendText may be dispatched over a non-terminal task");
    } finally {
      await adapter.stop();
      await cleanup(sc);
    }
  }
});

test("bindings are isolated per device identity, not just per relay host and workspace", async () => {
  const sc = scenario();
  const firstScript = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "a"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const first = new AdapterProc(sc, fakeEnv(sc, { script: firstScript }));
  let sessionId;
  try {
    await initialize(first);
    sessionId = (await first.request("session/new", {})).result.sessionId;
    const prompt = first.request("session/prompt", { sessionId, prompt: await promptBlocks("q") });
    assert.equal((await prompt).result.stopReason, "end_turn");
  } finally {
    await first.stop();
  }
  try {
    // Same relay host, same workspace, different paired device.
    writeFileSync(sc.urlFile, URL_FILE_CONTENT_OTHER_DEVICE);
    const other = scenario();
    writeFileSync(
      other.configFile,
      JSON.stringify({
        remoteClientRoot: FAKE_REMOTE_ROOT,
        connectionUrlFile: sc.urlFile,
        workspace: WORKSPACE,
        stateDir: sc.stateDir,
        requestTimeoutMs: 1500,
        pollIntervalMs: 120,
        turnTimeoutMs: 2000,
      }),
    );
    const second = new AdapterProc(other, fakeEnv(other));
    try {
      await initialize(second);
      const listed = await second.request("session/list", {});
      assert.equal(listed.result.sessions.length, 0, "another device's bindings must not be listed");
      const loaded = await second.request("session/load", { sessionId });
      assert.notEqual(loaded.error, undefined, "another device's binding must not load");
      const prompted = await second.request("session/prompt", { sessionId, prompt: await promptBlocks("cross device") });
      assert.notEqual(prompted.error, undefined, "another device's binding must refuse prompts");
      const sends = journalCalls(other).filter((call) => call.name === "sendConversationCommandV4");
      assert.equal(sends.length, 0, "refusals must happen before any dispatch");
    } finally {
      await second.stop();
      await cleanup(other);
    }
  } finally {
    await cleanup(sc);
  }
});

test("rows without a rowId are handled conservatively: never streamed, never evidence", async () => {
  const sc = scenario({ turnTimeoutMs: 1200 });
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [{ op: "row.appended", row: { kind: "assistantText", text: "opaque history" } }]),
    ],
    resyncFrames: [snapWire(5, { phase: "completedSuccess", rows: [] })],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const settled = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("no ids") });
    assert.notEqual(settled?.result?.stopReason, "end_turn", "unattributable content must not prove a turn finished");
    assert.equal(settled.error.code, -32005);
    assert.equal(
      adapter.allNotifications.filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk").length,
      0,
      "content without a stable identity must not be streamed",
    );
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a snapshot replacement never replays already-streamed history", async () => {
  const sc = scenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "h2"))]),
      // A wholesale snapshot replacement re-delivers the streamed row verbatim.
      snapWire(3, { phase: "running", rows: [userRow(1, "two"), assistantRow(2, "h2")] }),
      deltaWire(3, 4, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const settled = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("two") });
    assert.equal(settled.result.stopReason, "end_turn");
    const chunks = adapter.allNotifications
      .filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((n) => n.params.update.content.text);
    assert.deepEqual(chunks, ["h2"], "a snapshot replacement must not replay streamed rows");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a seq gap resyncs through the server, streams the missed rows, and never resends the command", async () => {
  const sc = scenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "part one"))]),
      // fromSeq jumps 2 → 4: the interval is not contiguous, the frame is a gap.
      deltaWire(4, 5, [appended(assistantRow(3, "part two"))]),
    ],
    resyncFrames: [snapWire(6, { phase: "completedSuccess", rows: [assistantRow(2, "part one"), assistantRow(3, "part two")] })],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("gap") });
    const chunks = [];
    for (const expected of ["part one", "part two"]) {
      const chunk = await adapter.waitForNotification(
        (n) => n.method === "session/update" && n.params.update.sessionUpdate === "agent_message_chunk",
      );
      assert.equal(chunk.params.update.content.text, expected);
      chunks.push(chunk);
    }
    assert.equal((await prompt).result.stopReason, "end_turn");
    assert.equal(journalCalls(sc).filter((call) => call.name === "resyncConversationV4").length, 1, "the gap recovers through exactly one resync");
    assert.equal(journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length, 1, "a gap must never resend the prompt");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("fragmented wire frames assemble through the crc32 checksum and stream", async () => {
  const sc = scenario();
  const logical = deltaWire(1, 2, [appended(assistantRow(2, "assembled from fragments"))]);
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      ...fragmentsOf(logical, 3),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("fragmented") });
    const chunk = await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.sessionUpdate === "agent_message_chunk",
    );
    assert.equal(chunk.params.update.content.text, "assembled from fragments");
    assert.equal((await prompt).result.stopReason, "end_turn");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a corrupted fragment fails closed and recovers only through the server", async () => {
  const sc = scenario({ turnTimeoutMs: 1200 });
  const logical = deltaWire(1, 2, [appended(assistantRow(2, "never assembled"))]);
  const [good0, good1, good2] = fragmentsOf(logical, 3);
  const corrupted = { ...good2, dataBase64: Buffer.from("corrupted").toString("base64") };
  const script = {
    frames: [snapWire(1, { phase: "running" }), good0, good1, corrupted],
    resyncFrames: [snapWire(5, { phase: "running", rows: [] })],
    resyncError: "resync unavailable",
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const settled = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("corrupt") });
    assert.equal(settled.error.code, -32005);
    assert.equal(
      adapter.allNotifications.filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk").length,
      0,
      "a corrupted assembly must never stream partial content",
    );
    assert.equal(journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length, 1);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("task registration reuses the accepted session id and never re-dispatches input", async () => {
  const sc = scenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "a1"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    assert.equal((await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("q1") })).result.stopReason, "end_turn");

    const creates = journalCalls(sc).filter((call) => call.name === "createTask");
    assert.equal(creates.length, 1, "the accepted session is registered exactly once");
    assert.equal(creates[0].args[0].draftSessionId, DESKTOP_SESSION, "registration points at the accepted desktop session id");
    assert.equal(creates[0].args[0].v4Create, true);
    assert.equal(
      journalCalls(sc).filter((call) => call.channel === "zcode-task" && call.name === "getTaskSnapshot").length,
      0,
      "registration verifies through the createTask id echo, never through the stale snapshot read",
    );
    assert.equal(
      journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length,
      1,
      "registration must not dispatch another createSession or sendText",
    );
    const binding = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));
    assert.equal(binding.registration, "registered");
    assert.equal(binding.desktopSessionId, DESKTOP_SESSION);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a failed registration keeps the binding and is never retried automatically", async () => {
  const sc = scenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "a1"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script, registerError: "createTask unavailable" }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    // Whether a failed registration fails the turn is the adapter's call; the
    // invariants below are what must hold either way.
    await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("q1") });
    const binding = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));
    assert.equal(binding.desktopSessionId, DESKTOP_SESSION, "the accepted session id survives a failed registration");
    assert.notEqual(binding.registration, "registered");

    // A later turn on the same binding must not silently re-attempt registration.
    await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("q2") });
    assert.equal(journalCalls(sc).filter((call) => call.name === "createTask").length, 1, "registration is never retried automatically");
    const bindingAfter = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));
    assert.equal(bindingAfter.desktopSessionId, DESKTOP_SESSION);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("session/load backfills registration for a historical unregistered binding", async () => {
  const sc = scenario();
  const history = [userRow(1, "q1"), assistantRow(2, "a1")];
  const failingScript = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "a1"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const failing = new AdapterProc(sc, fakeEnv(sc, { script: failingScript, registerError: "createTask unavailable" }));
  let sessionId;
  try {
    await initialize(failing);
    sessionId = (await failing.request("session/new", {})).result.sessionId;
    await failing.request("session/prompt", { sessionId, prompt: await promptBlocks("q1") });
    const beforeRepair = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));
    assert.notEqual(beforeRepair.registration, "registered");
  } finally {
    await failing.stop();
  }
  try {
    // Same stateDir and URL file, fresh journal: only the repairing process writes here.
    const repairSc = scenario();
    writeFileSync(
      repairSc.configFile,
      JSON.stringify({
        remoteClientRoot: FAKE_REMOTE_ROOT,
        connectionUrlFile: sc.urlFile,
        workspace: WORKSPACE,
        stateDir: sc.stateDir,
        requestTimeoutMs: 1500,
        pollIntervalMs: 120,
        turnTimeoutMs: 2000,
      }),
    );
    const repairScript = { subscribeTurns: [[snapWire(10, { phase: "completedSuccess", rows: history })]] };
    const repairing = new AdapterProc(repairSc, fakeEnv(repairSc, { script: repairScript }));
    try {
      await initialize(repairing);
      // A registration that was attempted and failed stays refused: the
      // outcome must be inspected by a human, not silently retried.
      const refused = await repairing.request("session/load", { sessionId });
      assert.notEqual(refused.error, undefined, "an unconfirmed registration must not load");
      assert.equal(journalCalls(repairSc).filter((call) => call.name === "createTask").length, 0);

      // A historical binding from before registration existed (no field at
      // all) is exactly what session/load backfills.
      const bindingFile = path.join(sc.bindingsDir, `${sessionId}.json`);
      const historical = JSON.parse(readFileSync(bindingFile, "utf8"));
      delete historical.registration;
      writeFileSync(bindingFile, JSON.stringify(historical, null, 2));
      const loaded = await repairing.request("session/load", { sessionId });
      assert.equal(loaded.error, undefined);
      assert.equal(
        journalCalls(repairSc).filter((call) => call.name === "createTask").length,
        1,
        "session/load registers the historical binding exactly once",
      );
      const replayed = await repairing.waitForNotification(
        (n) => n.method === "session/update" && n.params.update.content?.text === "a1",
      );
      assert.equal(replayed.params.update.sessionUpdate, "agent_message_chunk", "load replays the live snapshot history");
      const binding = JSON.parse(readFileSync(bindingFile, "utf8"));
      assert.equal(binding.registration, "registered");
      assert.equal(binding.desktopSessionId, DESKTOP_SESSION);
    } finally {
      await repairing.stop();
      await cleanup(repairSc);
    }
  } finally {
    await cleanup(sc);
  }
});

test("a terminal phase that settles before the assistant row does not end the turn", async () => {
  const sc = scenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running", rows: [userRow(1, "q1")] }),
      deltaWire(1, 2, [terminal()]),
      deltaWire(2, 3, [appended(assistantRow(2, "late answer"))]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { script }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/new", {})).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("q1") });
    // The turn must still be open when the contentless terminal patch has
    // landed; it ends only once the assistant row actually arrives.
    const chunk = await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.content?.text === "late answer",
    );
    assert.equal(chunk.params.update.sessionUpdate, "agent_message_chunk");
    const settled = await prompt;
    assert.equal(settled.error, undefined);
    assert.equal(settled.result.stopReason, "end_turn");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a fixed follow-desktop model option answers the DSH model probe", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc));
  try {
    await initialize(adapter);
    const created = await adapter.request("session/new", {});
    const option = created.result.configOptions.find((entry) => entry.id === "model");
    assert.equal(option.type, "select");
    assert.equal(option.currentValue, "follow-desktop");
    assert.equal(option.options.length, 1);
    assert.equal(option.options[0].value, "follow-desktop");
    assert.ok(typeof option.options[0].name === "string" && option.options[0].name.length > 0, "the option carries a display name");
    const kept = await adapter.request("session/set_config_option", {
      sessionId: created.result.sessionId,
      configId: "model",
      value: "follow-desktop",
    });
    assert.equal(kept.result.configOptions.length, 1);
    const other = await adapter.request("session/set_config_option", {
      sessionId: created.result.sessionId,
      configId: "model",
      value: "gpt-9",
    });
    assert.equal(other.error.code, -32602);
    assert.match(other.error.message, /follow-desktop/);
    const unknown = await adapter.request("session/set_config_option", {
      sessionId: created.result.sessionId,
      configId: "thought",
      value: "high",
    });
    assert.equal(unknown.error.code, -32602);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("bindings refuse to load when the adapter workspace changed", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc));
  let sessionId;
  try {
    await initialize(adapter);
    sessionId = (await adapter.request("session/new", {})).result.sessionId;
  } finally {
    await adapter.stop();
  }
  try {
    const reconfigured = scenario({ workspace: OTHER_WORKSPACE });
    // Same stateDir and URL file as the original node, different workspace.
    writeFileSync(
      reconfigured.configFile,
      JSON.stringify({
        remoteClientRoot: FAKE_REMOTE_ROOT,
        connectionUrlFile: sc.urlFile,
        workspace: OTHER_WORKSPACE,
        stateDir: sc.stateDir,
        requestTimeoutMs: 1500,
        pollIntervalMs: 120,
        turnTimeoutMs: 2000,
      }),
    );
    const other = new AdapterProc(reconfigured, fakeEnv(reconfigured));
    try {
      await initialize(other);
      const listed = await other.request("session/list", {});
      assert.deepEqual(listed.result.sessions, [], "session/list must be scope-filtered");
      const loaded = await other.request("session/load", { sessionId });
      assert.equal(loaded.error.code, -32002);
      assert.match(loaded.error.message, /scope mismatch/);
    } finally {
      await other.stop();
      await cleanup(reconfigured);
    }
  } finally {
    await cleanup(sc);
  }
});

// ---------- remote-site node: one node, per-session workspace selection ----------

const SITE_WORKSPACES = [
  { workspacePath: "D:\\site-ws-a", workspaceIdentity: "site-wid-a", label: "Project A" },
  { workspacePath: "D:\\site-ws-b", workspaceIdentity: "site-wid-b", label: "Project B" },
  { workspacePath: "E:\\site-ws-c", workspaceIdentity: "site-wid-c", label: "Project C" },
];
const SITE_BOOTSTRAP = { desktopAppVersion: "3.14.0-fake", workspaces: SITE_WORKSPACES };

/** A workspaceSelection:"session" node config against the fake site. */
function siteScenario() {
  const dir = mkdtempSync(path.join(tmpdir(), "zdsk-site-"));
  const urlFile = path.join(dir, "remote-url.txt");
  writeFileSync(urlFile, URL_FILE_CONTENT);
  const stateDir = path.join(dir, "state");
  const scriptFile = path.join(dir, "v4-script.json");
  const configFile = path.join(dir, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      remoteClientRoot: FAKE_REMOTE_ROOT,
      connectionUrlFile: urlFile,
      workspaceSelection: "session",
      siteName: "PC1-TESTSITE",
      stateDir,
      requestTimeoutMs: 1500,
      pollIntervalMs: 120,
      turnTimeoutMs: 2000,
    }),
  );
  return {
    dir,
    configFile,
    stateDir,
    scriptFile,
    journalFile: path.join(dir, "journal.jsonl"),
    urlFile,
    bindingsDir: path.join(stateDir, "bindings"),
  };
}

/** Spawns the adapter once (config validation or --health) and captures its exit. */
function runAdapterOnce(extraArgs, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [ADAPTER, ...extraArgs], {
      cwd: path.dirname(ADAPTER),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      out += chunk;
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      err += chunk;
    });
    proc.once("exit", (code) => resolve({ code, out, err }));
  });
}

function assertNoSecrets(text) {
  assert.ok(!text.includes("SECRETSID42"), "sid must not leak");
  assert.ok(!text.includes("SECRETHASH42"), "hash must not leak");
  assert.ok(!/wss?:\/\/|https?:\/\//.test(text), "URLs must not leak");
}

test("site session/new discovers the remote workspaces read-only and offers them as one config option", async () => {
  const sc = siteScenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP }));
  try {
    await initialize(adapter);
    const created = await adapter.request("session/new", { cwd: "C:/dsh-session-ws" });
    assert.equal(created.error, undefined);
    const options = created.result.configOptions;
    assert.equal(options.length, 2, "model plus workspace options only");
    const model = options.find((option) => option.id === "model");
    assert.equal(model.options.length, 1, "the model catalogue stays follow-desktop only");
    const workspace = options.find((option) => option.id === "workspace");
    assert.equal(workspace.type, "select");
    assert.equal(workspace.category, "workspace");
    assert.equal(workspace.currentValue, "");
    assert.deepEqual(
      workspace.options,
      SITE_WORKSPACES.map((entry) => ({ value: entry.workspacePath, name: entry.label })),
    );
    assert.match(workspace.description, /PC1-TESTSITE/);
    assert.match(workspace.description, /3\.14\.0-fake/);
    assert.match(workspace.description, /3 registered workspaces/);
    // Discovery is read-only: pairing plus bootstrap plus dispose, nothing else.
    const kinds = readJournal(sc).map((entry) => entry.kind);
    assert.deepEqual(kinds.sort(), ["bootstrap", "connect", "dispose"]);
    assertNoSecrets(adapter.stderrText);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("site discovery failure at session/new is an explicit error that leaves no binding and dispatches nothing", async () => {
  const sc = siteScenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, { connectError: "connect refused SECRETSID42 SECRETHASH42" }));
  try {
    await initialize(adapter);
    const created = await adapter.request("session/new", {});
    assert.equal(created.error.code, -32003);
    assert.match(created.error.message, /remote workspace discovery failed/);
    assertNoSecrets(JSON.stringify(created));
    assertNoSecrets(adapter.stderrText);
    assert.deepEqual(readdirSync(sc.bindingsDir), [], "a failed discovery must not persist a binding");
    assert.equal(journalCalls(sc).length, 0, "nothing was dispatched");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a duplicate site workspace path is refused at discovery instead of offering an ambiguous choice", async () => {
  const sc = siteScenario();
  const ambiguous = {
    desktopAppVersion: "3.14.0-fake",
    workspaces: [
      { workspacePath: "D:\\site-ws-a", workspaceIdentity: "site-wid-a" },
      { workspacePath: "D:\\site-ws-a", workspaceIdentity: "site-wid-a2" },
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { bootstrap: ambiguous }));
  try {
    await initialize(adapter);
    const created = await adapter.request("session/new", {});
    assert.equal(created.error.code, -32003);
    assert.match(created.error.message, /sharing one path/);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a site prompt without a selected workspace is refused and nothing is dispatched", async () => {
  const sc = siteScenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP }));
  try {
    await initialize(adapter);
    const { sessionId } = (await adapter.request("session/new", {})).result;
    const prompted = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("do work") });
    assert.equal(prompted.error.code, -32002);
    assert.match(prompted.error.message, /no workspace is selected/);
    assert.equal(journalCalls(sc).length, 0, "the adapter must not bridge or dispatch without a selection");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a workspace selection not on the site list is refused and the binding stays unselected", async () => {
  const sc = siteScenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP }));
  try {
    await initialize(adapter);
    const { sessionId } = (await adapter.request("session/new", {})).result;
    const chosen = await adapter.request("session/set_config_option", {
      sessionId,
      configId: "workspace",
      value: "D:\\not-registered",
    });
    assert.equal(chosen.error.code, -32002);
    assert.match(chosen.error.message, /not \(uniquely\) registered/);
    const binding = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));
    assert.equal(binding.scope.workspace, null, "a refused selection must not pin anything");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("selecting a workspace pins it: prompt dispatches createSession to exactly that workspace", async () => {
  const sc = siteScenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(userRow(1, "Fix the login bug"))]),
      deltaWire(2, 3, [appended(assistantRow(2, "Fixed. SITE_OK"))]),
      deltaWire(3, 4, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP, script }));
  try {
    await initialize(adapter);
    const { sessionId } = (await adapter.request("session/new", {})).result;
    const chosen = await adapter.request("session/set_config_option", {
      sessionId,
      configId: "workspace",
      value: "D:\\site-ws-b",
    });
    assert.equal(chosen.error, undefined);
    const option = chosen.result.configOptions.find((entry) => entry.id === "workspace");
    assert.equal(option.currentValue, "D:\\site-ws-b");
    const binding = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));
    const expectedWorkspace = process.platform === "win32" ? "d:/site-ws-b" : "D:/site-ws-b";
    assert.equal(binding.scope.workspace, expectedWorkspace);
    assert.equal(binding.workspace.identity, "site-wid-b");
    const update = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Fix the login bug") });
    assert.equal(update.error, undefined);
    assert.equal(update.result.stopReason, "end_turn");
    await adapter.waitForNotification((message) =>
      message.method === "session/update" &&
      message.params?.update?.sessionUpdate === "agent_message_chunk" &&
      message.params.update.content?.text?.includes("SITE_OK"));
    // The dispatch bridged and created the task in exactly the chosen workspace.
    const bridges = readJournal(sc).filter((entry) => entry.kind === "openBridge").map((entry) => entry.value);
    assert.ok(bridges.includes("site-wid-b"), `bridges: ${JSON.stringify(bridges)}`);
    const createSession = journalCalls(sc).find((call) =>
      call.channel === "zcode-agent" && call.name === "sendConversationCommandV4" &&
      call.args[0]?.envelope?.type === "createSession");
    assert.equal(createSession.args[0].envelope.payload.workspaceId, "site-wid-b");
    assertNoSecrets(adapter.stderrText);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("after a dispatched turn the workspace selection is immutable", async () => {
  const sc = siteScenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "Done. SITE_ONCE"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP, script }));
  try {
    await initialize(adapter);
    const { sessionId } = (await adapter.request("session/new", {})).result;
    await adapter.request("session/set_config_option", { sessionId, configId: "workspace", value: "E:\\site-ws-c" });
    const update = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("one turn") });
    assert.equal(update.result.stopReason, "end_turn");
    const changed = await adapter.request("session/set_config_option", {
      sessionId,
      configId: "workspace",
      value: "D:\\site-ws-a",
    });
    assert.equal(changed.error.code, -32002);
    assert.match(changed.error.message, /already has a dispatched desktop task/);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

/** Controller openings strictly serialize: a connect only starts after the previous dispose. */
function assertStrictControllerSerialization(sc) {
  let depth = 0;
  for (const entry of readJournal(sc)) {
    if (entry.kind === "connect") {
      depth += 1;
      assert.equal(depth, 1, "two controller connections were open at once");
    } else if (entry.kind === "dispose") {
      depth -= 1;
      assert.equal(depth, 0, "a dispose ran without a matching live connection");
    }
  }
  assert.equal(depth, 0, "a controller connection was never released");
}

function assertNoControllerKick(sc) {
  assert.ok(
    readJournal(sc).every((entry) => entry.kind !== "kick"),
    "a second pairing kicked the live controller — the relay slot was contended",
  );
}

test("a session/new discovery during a live turn returns busy instead of contending for the controller slot", async () => {
  const sc = siteScenario();
  // Live acceptance shape (2026-09-21): the turn streams partial text and never
  // reaches its terminal frame while the concurrent probe must be refused.
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "Streaming mid-turn", "streaming"))]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP, script }));
  try {
    await initialize(adapter);
    const { sessionId } = (await adapter.request("session/new", {})).result;
    await adapter.request("session/set_config_option", { sessionId, configId: "workspace", value: "D:\\site-ws-a" });
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("long read-only task") });
    await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.sessionUpdate === "agent_message_chunk",
    );
    const connectsBefore = readJournal(sc).filter((entry) => entry.kind === "connect").length;
    const bindingsBefore = readdirSync(sc.bindingsDir).sort();
    const busy = await adapter.request("session/new", {});
    assert.equal(busy.error.code, -32001);
    assert.match(busy.error.message, /prompt turn is in flight/);
    assert.equal(
      readJournal(sc).filter((entry) => entry.kind === "connect").length,
      connectsBefore,
      "a busy discovery must not open a second relay connection",
    );
    assertNoControllerKick(sc);
    assert.deepEqual(readdirSync(sc.bindingsDir).sort(), bindingsBefore, "a busy session/new must not write a binding");
    prompt.catch(() => {}); // the turn never settles in this test; the process is killed below
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a turn survives a concurrent session/new and streams the complete final answer", async () => {
  const sc = siteScenario();
  // Determinism: the terminal frame is gated on a release file this test owns.
  // While the gate is held the turn provably cannot end (the adapter only ends
  // a turn on the terminal frame), so the concurrent session/new below is
  // guaranteed to land inside the live turn on any machine speed — no
  // frameDelayMs guess. gate-held in the journal is the sync barrier proving
  // the fake is parked on the frame; writing the file is the latch.
  const gateFile = path.join(sc.dir, "gate-release.txt");
  const script = {
    gate: { turnIndex: 0, frameIndex: 3, releaseFile: gateFile },
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "Reading the repository. ", "streaming"))]),
      deltaWire(2, 3, [textDelta(2, "Cross-checking the manifest. ")]),
      // The terminal patch precedes the final full-text row inside one frame:
      // the finish must still emit that row before end_turn.
      deltaWire(3, 4, [terminal(), appended(assistantRow(3, "Final consolidated answer"))]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP, script }));
  try {
    await initialize(adapter);
    const { sessionId } = (await adapter.request("session/new", {})).result;
    await adapter.request("session/set_config_option", { sessionId, configId: "workspace", value: "D:\\site-ws-a" });
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("audit, read-only") });
    await adapter.waitForNotification(
      (n) => n.method === "session/update" &&
        n.params.update.sessionUpdate === "agent_message_chunk" &&
        n.params.update.content.text.includes("Reading"),
    );
    await waitForJournal(sc, (entry) => entry.kind === "gate-held");
    const busy = await adapter.request("session/new", {});
    assert.equal(busy.error.code, -32001);
    assert.match(busy.error.message, /prompt turn is in flight/);
    // Release the latch: the original turn must now finish untouched.
    writeFileSync(gateFile, "");
    await waitForJournal(sc, (entry) => entry.kind === "gate-released");
    const settled = await prompt;
    assert.equal(settled.error, undefined);
    assert.equal(settled.result.stopReason, "end_turn");
    const streamed = adapter.allNotifications
      .filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((n) => n.params.update.content.text).join("");
    assert.equal(streamed, "Reading the repository. Cross-checking the manifest. Final consolidated answer");
    assertNoControllerKick(sc);
    assertStrictControllerSerialization(sc);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a prompt waits for an in-flight discovery to release the controller slot instead of pairing over it", async () => {
  const sc = siteScenario();
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "Queued behind discovery"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP, script, bootstrapDelayMs: 400 }));
  try {
    await initialize(adapter);
    const { sessionId } = (await adapter.request("session/new", {})).result;
    await adapter.request("session/set_config_option", { sessionId, configId: "workspace", value: "D:\\site-ws-a" });
    // The second session/new holds the controller slot through a slow bootstrap;
    // the prompt that arrives right behind it must queue, never pair alongside.
    const discovering = adapter.request("session/new", {});
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("run now") });
    const created = await discovering;
    assert.equal(created.error, undefined);
    const settled = await prompt;
    assert.equal(settled.error, undefined);
    assert.equal(settled.result.stopReason, "end_turn");
    assert.equal(
      adapter.allNotifications
        .filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((n) => n.params.update.content.text).join(""),
      "Queued behind discovery",
    );
    assertNoControllerKick(sc);
    assertStrictControllerSerialization(sc);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("site bindings are isolated per device identity, not per relay host", async () => {
  const sc = siteScenario();
  let sessionId;
  const first = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP }));
  try {
    await initialize(first);
    sessionId = (await first.request("session/new", {})).result.sessionId;
    const chosen = await first.request("session/set_config_option", {
      sessionId,
      configId: "workspace",
      value: "D:\\site-ws-a",
    });
    assert.equal(chosen.error, undefined);
  } finally {
    await first.stop();
  }
  // The connection file now names another device on the same relay host.
  writeFileSync(sc.urlFile, URL_FILE_CONTENT_OTHER_DEVICE);
  const second = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP }));
  try {
    await initialize(second);
    const listed = await second.request("session/list", {});
    assert.deepEqual(listed.result.sessions, [], "another device's bindings must not be listed");
    const loaded = await second.request("session/load", { sessionId });
    assert.equal(loaded.error.code, -32002);
    assert.match(loaded.error.message, /scope mismatch/);
    const prompted = await second.request("session/prompt", { sessionId, prompt: await promptBlocks("hi") });
    assert.equal(prompted.error.code, -32002);
    assertNoSecrets(second.stderrText);
  } finally {
    await second.stop();
    await cleanup(sc);
  }
});

test("session/load of an undispatched site session re-discovers read-only and keeps the selection current", async () => {
  const sc = siteScenario();
  let sessionId;
  const first = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP }));
  try {
    await initialize(first);
    sessionId = (await first.request("session/new", { cwd: "C:/dsh-session-ws" })).result.sessionId;
    await first.request("session/set_config_option", { sessionId, configId: "workspace", value: "D:\\site-ws-b" });
  } finally {
    await first.stop();
  }
  const second = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP }));
  try {
    await initialize(second);
    const loaded = await second.request("session/load", { sessionId });
    assert.equal(loaded.error, undefined);
    const option = loaded.result.configOptions.find((entry) => entry.id === "workspace");
    assert.equal(option.currentValue, "D:\\site-ws-b");
    assert.equal(option.options.length, 3);
    // Read-only replay of an undispatched session: no conversation traffic.
    assert.equal(journalCalls(sc).length, 0);
    const listed = await second.request("session/list", {});
    assert.equal(listed.result.sessions.length, 1);
    assert.equal(listed.result.sessions[0].cwd, "C:/dsh-session-ws", "the recorded DSH cwd drives grouping");
  } finally {
    await second.stop();
    await cleanup(sc);
  }
});

test("session/load refuses an undispatched site session whose selected workspace vanished from the site", async () => {
  const sc = siteScenario();
  let sessionId;
  const first = new AdapterProc(sc, fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP }));
  try {
    await initialize(first);
    sessionId = (await first.request("session/new", {})).result.sessionId;
    await first.request("session/set_config_option", { sessionId, configId: "workspace", value: "E:\\site-ws-c" });
  } finally {
    await first.stop();
  }
  const shrunk = {
    desktopAppVersion: "3.14.0-fake",
    workspaces: SITE_WORKSPACES.filter((entry) => entry.workspacePath !== "E:\\site-ws-c"),
  };
  const second = new AdapterProc(sc, fakeEnv(sc, { bootstrap: shrunk }));
  try {
    await initialize(second);
    const loaded = await second.request("session/load", { sessionId });
    assert.equal(loaded.error.code, -32002);
    assert.match(loaded.error.message, /no longer registered/);
  } finally {
    await second.stop();
    await cleanup(sc);
  }
});

test("--health prints the fixed-string site summary without credentials", async () => {
  const sc = siteScenario();
  const online = await runAdapterOnce(["--config", sc.configFile, "--health"], fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP }));
  assert.equal(online.code, 0);
  assert.match(online.out, /PC1-TESTSITE: online, desktop 3\.14\.0-fake, 3 registered workspace\(s\), workspace selection per session/);
  assertNoSecrets(online.out + online.err);
  const offline = await runAdapterOnce(
    ["--config", sc.configFile, "--health"],
    fakeEnv(sc, { connectError: "relay unreachable SECRETSID42" }),
  );
  assert.equal(offline.code, 1);
  assert.match(offline.err, /PC1-TESTSITE is offline or unreachable/);
  assertNoSecrets(offline.out + offline.err);
  await cleanup(sc);
});

test("--health on a fixed-workspace node also verifies the configured workspace", async () => {
  const sc = scenario({ workspace: OTHER_WORKSPACE });
  try {
    const result = await runAdapterOnce(["--config", sc.configFile, "--health"], fakeEnv(sc, {}));
    assert.equal(result.code, 1, "the fake site serves D:\\fake-ws, not the configured workspace");
    assert.match(result.err, /offline or unreachable/);
    assert.match(result.err, /configured workspace is not registered/);
    assertNoSecrets(result.out + result.err);
  } finally {
    await cleanup(sc);
  }
});

test("config validation keeps fixed mode strict and session mode unambiguous", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "zdsk-cfg-"));
  const urlFile = path.join(baseDir, "url.txt");
  writeFileSync(urlFile, URL_FILE_CONTENT);
  const base = {
    remoteClientRoot: FAKE_REMOTE_ROOT,
    stateDir: baseDir,
    requestTimeoutMs: 1500,
    pollIntervalMs: 120,
    turnTimeoutMs: 2000,
  };
  const probeEnv = (tag) => fakeEnv({
    journalFile: path.join(baseDir, `j-${tag}.jsonl`),
    bindingsDir: path.join(baseDir, `b-${tag}`),
    scriptFile: path.join(baseDir, `s-${tag}.json`),
  });
  const writeConfig = (extra) => {
    const configFile = path.join(baseDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ ...base, connectionUrlFile: urlFile, ...extra }));
    return configFile;
  };

  // Legacy shape: no workspaceSelection key, workspace present — unchanged path.
  const legacy = await runAdapterOnce(
    ["--config", writeConfig({ workspace: "D:\\fake-ws" }), "--health"],
    probeEnv("legacy"),
  );
  assert.equal(legacy.code, 0);
  assert.match(legacy.out, /configured workspace registered/);

  // Session mode plus a pinned workspace is ambiguous and must fail loud.
  const pinned = await runAdapterOnce(
    ["--config", writeConfig({ workspaceSelection: "session", workspace: "D:\\fake-ws" }), "--health"],
    probeEnv("pinned"),
  );
  assert.equal(pinned.code, 2);
  assert.match(pinned.err, /workspace must be omitted/);

  // Fixed mode without a workspace keeps failing loud.
  const missing = await runAdapterOnce(
    ["--config", writeConfig({ workspaceSelection: "fixed" }), "--health"],
    probeEnv("missing"),
  );
  assert.equal(missing.code, 2);
  assert.match(missing.err, /missing the workspace/);

  // An unknown workspaceSelection value is rejected.
  const badMode = await runAdapterOnce(
    ["--config", writeConfig({ workspaceSelection: "auto" }), "--health"],
    probeEnv("badmode"),
  );
  assert.equal(badMode.code, 2);
  assert.match(badMode.err, /workspaceSelection must be/);

  rmSync(baseDir, { recursive: true, force: true });
});

// ---------- --list-tasks: one read-only desktop task-index listing ----------

/** Parses the single `[adapter] tasks: <json>` stdout line. */
function parseTasksLine(out) {
  const line = out.split("\n").map((part) => part.trim()).find((part) => part.includes("] tasks: "));
  assert.ok(line, "a tasks line must be printed");
  return JSON.parse(line.slice(line.indexOf("] tasks: ") + "] tasks: ".length));
}

const SITE_TASK_LIST = {
  "site-wid-a": [
    { taskId: "dtask-site-1", title: "older site task", status: "completed", createdAt: 1730000000000, updatedAt: 1730000500000 },
    { taskId: "dtask-site-2", title: "newer site task mentioning https://relay.example/secret", createdAt: 1730001000000, updatedAt: 1730002000000 },
    { taskId: "dtask-site-3", title: "unset status falls back", createdAt: 1730003000000, updatedAt: 1730003000000 },
    { taskId: "", title: "invalid row is skipped", createdAt: 1, updatedAt: 1 },
    { title: "row without an id is skipped", createdAt: 1, updatedAt: 1 },
  ],
  "site-wid-b": [
    { taskId: "dtask-other-ws", title: "belongs to workspace B", status: "error", createdAt: 1, updatedAt: 1730009000000 },
  ],
};

test("--list-tasks lists one workspace's synced desktop tasks, scoped and scrubbed", async () => {
  const sc = siteScenario();
  const env = fakeEnv(sc, {
    bootstrap: SITE_BOOTSTRAP,
    taskList: SITE_TASK_LIST,
  });
  const result = await runAdapterOnce(["--config", sc.configFile, "--list-tasks", "D:\\site-ws-a"], env);
  assert.equal(result.code, 0);
  const report = parseTasksLine(result.out);
  assert.equal(report.desktopVersion, "3.14.0-fake");
  assert.deepEqual(
    report.tasks.map((task) => task.taskId),
    // newest-updated first; invalid rows skipped; other workspaces never leak in
    ["dtask-site-3", "dtask-site-2", "dtask-site-1"],
  );
  assert.equal(report.tasks[0].status, "unknown");
  assert.match(report.tasks[1].title, /newer site task mentioning \[url\]/);
  assert.equal(report.tasks[2].status, "completed");
  for (const task of report.tasks) {
    assert.equal(task.origin, "desktop");
    assert.equal(task.dshSessionId, undefined);
    assert.match(task.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(task.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
  // The listing is one read-only controller pass scoped to the exact workspace.
  const calls = journalCalls(sc);
  const listCall = calls.find((call) => call.channel === "zcode-task" && call.name === "listTasks");
  assert.ok(listCall, "listTasks must be called through the bridge");
  assert.equal(listCall.args[0].workspacePath, "D:\\site-ws-a");
  assert.equal(listCall.args[0].workspaceIdentity, "site-wid-a");
  assert.equal(readJournal(sc).filter((entry) => entry.kind === "connect").length, 1);
  assertNoSecrets(result.out + result.err);
  await cleanup(sc);
});

test("--list-tasks marks tasks this adapter owns as workbench-origin with the dsh session id", async () => {
  const sc = siteScenario();
  // A real dispatched turn first: it mints a binding with desktopSessionId
  // dtask-owned-1 registered for workspace A. The scripted frames carry the
  // owned session's conversation topic so the live stream observes them.
  const ownedTopicRewrite = (wire) => ({
    ...wire,
    topic: "conversation/dtask-owned-1",
    frame: { ...wire.frame, topic: "conversation/dtask-owned-1" },
  });
  const script = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "done"))]),
      deltaWire(2, 3, [terminal()]),
    ].map(ownedTopicRewrite),
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    bootstrap: SITE_BOOTSTRAP,
    script,
    ack: { status: "accepted", result: { sessionId: "dtask-owned-1" } },
    taskList: {
      "site-wid-a": [
        { taskId: "dtask-owned-1", title: "workbench dispatched", status: "completed", createdAt: 1, updatedAt: 1730010000000 },
      ],
    },
  }));
  try {
    await initialize(adapter);
    const created = await adapter.request("session/new", {});
    const sessionId = created.result.sessionId;
    const select = await adapter.request("session/set_config_option", {
      sessionId, configId: "workspace", value: "D:\\site-ws-a",
    });
    assert.equal(select.error, undefined);
    const prompt = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("own me") });
    assert.equal(prompt.error, undefined);
    await adapter.stop();

    const listing = await runAdapterOnce(["--config", sc.configFile, "--list-tasks", "D:\\site-ws-a"], fakeEnv(sc, {
      bootstrap: SITE_BOOTSTRAP,
      taskList: {
        "site-wid-a": [
          { taskId: "dtask-owned-1", title: "workbench dispatched", status: "completed", createdAt: 1, updatedAt: 1730010000000 },
          { taskId: "dtask-native", title: "created on the desktop", status: "running", createdAt: 1, updatedAt: 1730005000000 },
        ],
      },
    }));
    assert.equal(listing.code, 0);
    const report = parseTasksLine(listing.out);
    const owned = report.tasks.find((task) => task.taskId === "dtask-owned-1");
    assert.equal(owned.origin, "workbench");
    assert.equal(owned.dshSessionId, sessionId);
    const native = report.tasks.find((task) => task.taskId === "dtask-native");
    assert.equal(native.origin, "desktop");
    assert.equal(native.dshSessionId, undefined);
    assertNoSecrets(listing.out + listing.err);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("--list-tasks failure and validation modes", async () => {
  // Session node without a workspace path is refused before any connection.
  const sc = siteScenario();
  const noPath = await runAdapterOnce(["--config", sc.configFile, "--list-tasks"], fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP }));
  assert.equal(noPath.code, 2);
  assert.match(noPath.err, /requires a workspace path/);

  // A workspace the site does not register fails with the exact-match reason.
  const unknown = await runAdapterOnce(
    ["--config", sc.configFile, "--list-tasks", "D:\\not-registered"],
    fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP, taskList: SITE_TASK_LIST }),
  );
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /configured workspace is not registered/);
  assertNoSecrets(unknown.out + unknown.err);

  // An unreachable site fails fixed-string without credentials.
  const offline = await runAdapterOnce(
    ["--config", sc.configFile, "--list-tasks", "D:\\site-ws-a"],
    fakeEnv(sc, { connectError: "relay unreachable SECRETSID42" }),
  );
  assert.equal(offline.code, 1);
  assert.match(offline.err, /task listing failed/);
  assertNoSecrets(offline.out + offline.err);

  // A desktop-side listing error surfaces fixed-string.
  const rejected = await runAdapterOnce(
    ["--config", sc.configFile, "--list-tasks", "D:\\site-ws-a"],
    fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP, listTasksError: "index read failed SECRETHASH42" }),
  );
  assert.equal(rejected.code, 1);
  assert.match(rejected.err, /task listing failed/);
  assert.match(rejected.err, /\[redacted\]/);
  assertNoSecrets(rejected.out + rejected.err);
  await cleanup(sc);

  // Fixed node: no argument lists the pinned workspace; an argument is refused.
  const fixedSc = scenario();
  const fixedEnv = fakeEnv(fixedSc, { taskList: { "wid-fake": [{ taskId: "dtask-fixed-1", title: "pinned workspace task", status: "running", createdAt: 1, updatedAt: 1730020000000 }] } });
  const fixed = await runAdapterOnce(["--config", fixedSc.configFile, "--list-tasks"], fixedEnv);
  assert.equal(fixed.code, 0);
  const fixedReport = parseTasksLine(fixed.out);
  assert.deepEqual(fixedReport.tasks.map((task) => task.taskId), ["dtask-fixed-1"]);
  const fixedCall = journalCalls(fixedSc).find((call) => call.channel === "zcode-task" && call.name === "listTasks");
  assert.equal(fixedCall.args[0].workspacePath, "D:\\fake-ws");
  assert.equal(fixedCall.args[0].workspaceIdentity, "wid-fake");
  const withPath = await runAdapterOnce(
    ["--config", fixedSc.configFile, "--list-tasks", "D:\\fake-ws"],
    fixedEnv,
  );
  assert.equal(withPath.code, 2);
  assert.match(withPath.err, /takes no workspace path/);
  await cleanup(fixedSc);
});

// ---------- session/adopt: continue an existing desktop task ----------

/** listTasks rows served for the fixed scenario's bridged workspace key. */
function fixedTaskList(rows) {
  return { "wid-fake": rows };
}

function completedMeta(taskId) {
  return { taskId, title: `task ${taskId}`, status: "completed", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 };
}

const ADOPT_HISTORY = [userRow(1, "old question"), assistantRow(2, "old answer")];
const adoptTerminalScript = () => ({
  subscribeTurns: [
    [snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })],
    [snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })],
  ],
  frames: [
    deltaWire(10, 11, [appended(userRow(3, "Round two please"))]),
    deltaWire(11, 12, [appended(assistantRow(4, "Round two done"))]),
    deltaWire(12, 13, [terminal()]),
  ],
});

test("session/adopt continues an existing desktop task via sendText with no createSession and no createTask", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: adoptTerminalScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
  }));
  try {
    await initialize(adapter);
    const adopted = await adapter.request("session/adopt", { taskId: DESKTOP_SESSION });
    assert.equal(adopted.error, undefined);
    assert.equal(adopted.result.created, true);
    const sessionId = adopted.result.sessionId;
    assert.match(sessionId, /^zdsk-[0-9a-f-]+$/);

    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Round two please") });
    const chunk = await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.content?.text === "Round two done",
    );
    assert.equal(chunk.params.sessionId, sessionId);
    assert.equal((await prompt).result.stopReason, "end_turn");
    assert.equal(
      adapter.allNotifications.filter((n) => n.params?.update?.content?.text === "old answer").length,
      0,
      "pre-adoption history must not stream as new-turn output",
    );

    const calls = journalCalls(sc);
    const sends = calls.filter((call) => call.name === "sendConversationCommandV4");
    assert.equal(sends.length, 1, "exactly one desktop command may leave the process");
    assert.equal(sends[0].args[0].envelope.type, "sendText");
    assert.equal(sends[0].args[0].envelope.sessionId, DESKTOP_SESSION, "the desktop stays the same task");
    assert.equal(sends[0].args[0].envelope.payload.requestedDelivery, "startNow");
    assert.equal(sends[0].args[0].envelope.payload.text, "Round two please");
    assert.equal(
      calls.filter((call) => call.channel === "zcode-task" && call.name === "createTask").length,
      0,
      "an adopted task is already registered by the desktop; createTask must never run",
    );
    const listCall = calls.find((call) => call.channel === "zcode-task" && call.name === "listTasks");
    assert.ok(listCall, "adoption must verify the task through the official listTasks index");
    assert.equal(listCall.args[0].workspaceIdentity, "wid-fake");

    const binding = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));
    assert.equal(binding.desktopSessionId, DESKTOP_SESSION);
    assert.equal(binding.registration, "adopted");
    assert.equal(binding.dispatch, null);
    assertNoSecrets(adapter.stderrText);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("session/adopt refuses tasks it cannot prove completed; nothing is bound or sent", async () => {
  const cases = [
    {
      name: "task missing from the workspace index",
      taskList: fixedTaskList([completedMeta("dtask-other")]),
      message: /not in this workspace's synced task index/,
    },
    {
      name: "index reports the task running",
      taskList: fixedTaskList([{ ...completedMeta(DESKTOP_SESSION), status: "running" }]),
      message: /not completed \(running\)/,
    },
    {
      name: "index reports the task in error",
      taskList: fixedTaskList([{ ...completedMeta(DESKTOP_SESSION), status: "error" }]),
      message: /not completed \(error\)/,
    },
    {
      name: "index completed but the live conversation is still running",
      script: { subscribeTurns: [[snapWire(10, { phase: "running", rows: ADOPT_HISTORY })]] },
      taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
      message: /live conversation is still running or awaiting input/,
    },
    {
      name: "index completed but the live conversation awaits input",
      script: { subscribeTurns: [[snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY, pendingInteractions: [{ id: "ask-1" }] })]] },
      taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
      message: /live conversation is still running or awaiting input/,
    },
  ];
  for (const testCase of cases) {
    const sc = scenario();
    const adapter = new AdapterProc(sc, fakeEnv(sc, {
      ...(testCase.script === undefined ? {} : { script: testCase.script }),
      taskList: testCase.taskList,
    }));
    try {
      await initialize(adapter);
      const adopted = await adapter.request("session/adopt", { taskId: DESKTOP_SESSION });
      assert.equal(adopted.error.code, -32002, testCase.name);
      assert.match(adopted.error.message, testCase.message, testCase.name);
      assert.deepEqual(readdirSync(sc.bindingsDir), [], `${testCase.name}: no binding may persist`);
      assert.equal(
        journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length,
        0,
        `${testCase.name}: nothing may be dispatched`,
      );
    } finally {
      await adapter.stop();
      await cleanup(sc);
    }
  }
});

test("session/adopt reuses the binding a workbench dispatch already created, across adapter restarts", async () => {
  const sc = scenario();
  const firstScript = {
    frames: [
      snapWire(1, { phase: "running" }),
      deltaWire(1, 2, [appended(assistantRow(2, "First round done"))]),
      deltaWire(2, 3, [terminal()]),
    ],
  };
  const first = new AdapterProc(sc, fakeEnv(sc, { script: firstScript }));
  let dispatchSessionId;
  try {
    await initialize(first);
    dispatchSessionId = (await first.request("session/new", {})).result.sessionId;
    const prompt = first.request("session/prompt", { sessionId: dispatchSessionId, prompt: await promptBlocks("First round") });
    assert.equal((await prompt).result.stopReason, "end_turn");
  } finally {
    await first.stop();
  }
  try {
    const second = new AdapterProc(sc, fakeEnv(sc, {
      script: adoptTerminalScript(),
      taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    }));
    try {
      await initialize(second);
      const adopted = await second.request("session/adopt", { taskId: DESKTOP_SESSION });
      assert.equal(adopted.error, undefined);
      assert.equal(adopted.result.created, false, "the dispatched binding must be reused, not duplicated");
      assert.equal(adopted.result.sessionId, dispatchSessionId);
      const binding = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${dispatchSessionId}.json`), "utf8"));
      assert.equal(binding.registration, "registered");
      assert.deepEqual(readdirSync(sc.bindingsDir), [`${dispatchSessionId}.json`], "exactly one binding owns the desktop task");
    } finally {
      await second.stop();
    }
  } finally {
    await cleanup(sc);
  }
});

test("an adopted binding survives an adapter restart: replay plus a second sendText round, still one task", async () => {
  const sc = scenario();
  const first = new AdapterProc(sc, fakeEnv(sc, {
    script: adoptTerminalScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
  }));
  let sessionId;
  try {
    await initialize(first);
    sessionId = (await first.request("session/adopt", { taskId: DESKTOP_SESSION })).result.sessionId;
    const prompt = first.request("session/prompt", { sessionId, prompt: await promptBlocks("Round two please") });
    assert.equal((await prompt).result.stopReason, "end_turn");
  } finally {
    await first.stop();
  }
  try {
    const roundTwoHistory = [...ADOPT_HISTORY, userRow(3, "Round two please"), assistantRow(4, "Round two done")];
    const secondScript = {
      subscribeTurns: [
        [snapWire(20, { phase: "completedSuccess", rows: roundTwoHistory })],
        [snapWire(20, { phase: "completedSuccess", rows: roundTwoHistory })],
      ],
      frames: [
        deltaWire(20, 21, [appended(userRow(5, "Round three please"))]),
        deltaWire(21, 22, [appended(assistantRow(6, "Round three done"))]),
        deltaWire(22, 23, [terminal()]),
      ],
    };
    const second = new AdapterProc(sc, fakeEnv(sc, { script: secondScript, taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]) }));
    try {
      await initialize(second);
      const loaded = await second.request("session/load", { sessionId });
      assert.equal(loaded.error, undefined);
      const replay = await second.waitForNotification(
        (n) => n.method === "session/update" && n.params.update.content?.text === "old answer",
      );
      assert.equal(replay.params.sessionId, sessionId);

      const prompt = second.request("session/prompt", { sessionId, prompt: await promptBlocks("Round three please") });
      assert.equal((await prompt).result.stopReason, "end_turn");
      const calls = journalCalls(sc);
      const sends = calls.filter((call) => call.name === "sendConversationCommandV4");
      assert.equal(sends.filter((call) => call.args[0].envelope.type === "sendText").length, 2, "both rounds ride sendText");
      assert.equal(sends.every((call) => call.args[0].envelope.sessionId === DESKTOP_SESSION), true, "the desktop task id never changes");
      assert.equal(
        calls.filter((call) => call.channel === "zcode-task" && call.name === "createTask").length,
        0,
        "an adopted task is never re-registered through createTask, even after a restart",
      );
    } finally {
      await second.stop();
    }
  } finally {
    await cleanup(sc);
  }
});

test("a turn whose terminal patch precedes the full-text row still streams the complete answer", async () => {
  const sc = scenario();
  // Live-desktop shape observed 2026-09-28 (continuation round on a real
  // task): the phase flipped to running, the reply row's first drained
  // version carried partial text, the terminal patch landed right behind it,
  // and the full-text row.upserted followed the terminal patch. Ending the
  // turn on the first terminal observation dropped that tail — the workbench
  // recorded "CONT" while the desktop's own snapshot held "CONTINUE_SMOKE_OK"
  // (proven by a later session/load replay). The gate parks the full-text
  // frame so the terminal provably lands first; writing the release file is
  // the latch that lets the tail through while the turn still settles.
  const gateFile = path.join(sc.dir, "tail-gate.txt");
  const script = {
    gate: { turnIndex: 0, frameIndex: 4, releaseFile: gateFile },
    subscribeTurns: [
      [snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })],
      [snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })],
    ],
    frames: [
      deltaWire(10, 11, [appended(userRow(3, "Round two please"))]),
      deltaWire(11, 12, [stateUpdated({ control: control("running") })]),
      deltaWire(12, 13, [appended(assistantRow(4, "CONT", "streaming"))]),
      deltaWire(13, 14, [terminal()]),
      deltaWire(14, 15, [appended(assistantRow(4, "CONTINUE_SMOKE_OK"))]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script,
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/adopt", { taskId: DESKTOP_SESSION })).result.sessionId;
    const prompt = adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Round two please") });
    await adapter.waitForNotification(
      (n) => n.method === "session/update" && n.params.update.content?.text === "CONT",
    );
    // gate-held proves the terminal patch is already on the wire and the
    // full-text row is not; releasing now lands it inside the settle window.
    await waitForJournal(sc, (entry) => entry.kind === "gate-held");
    writeFileSync(gateFile, "");
    await waitForJournal(sc, (entry) => entry.kind === "gate-released");
    const settled = await prompt;
    assert.equal(settled.error, undefined);
    assert.equal(settled.result.stopReason, "end_turn");
    const streamed = adapter.allNotifications
      .filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((n) => n.params.update.content.text).join("");
    assert.equal(streamed, "CONTINUE_SMOKE_OK", "the trailing full-text row must reach the DSH transcript");
    const calls = journalCalls(sc);
    const sends = calls.filter((call) => call.name === "sendConversationCommandV4");
    assert.equal(sends.length, 1, "the command is never re-sent while settling");
    assert.equal(sends[0].args[0].envelope.type, "sendText");
    assert.equal(sends[0].args[0].envelope.sessionId, DESKTOP_SESSION, "the desktop stays the same task");
    assert.equal(
      calls.filter((call) => call.channel === "zcode-task" && call.name === "createTask").length,
      0,
      "no replacement desktop task may be created while settling",
    );
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a complete short answer ends the turn through the settle window, not the deadline", async () => {
  const sc = scenario({ turnTimeoutMs: 2500 });
  // The initial block is the whole answer and nothing follows the terminal
  // patch: the turn must converge on its own (quiescence), far inside the
  // turn budget — never wait for a trailing frame that will not come.
  const script = {
    subscribeTurns: [
      [snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })],
      [snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })],
    ],
    frames: [
      deltaWire(10, 11, [appended(userRow(3, "Round two please"))]),
      deltaWire(11, 12, [stateUpdated({ control: control("running") })]),
      deltaWire(12, 13, [appended(assistantRow(4, "Full short answer"))]),
      deltaWire(13, 14, [terminal()]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script,
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/adopt", { taskId: DESKTOP_SESSION })).result.sessionId;
    const startedAt = Date.now();
    const settled = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Round two please") });
    assert.equal(settled.error, undefined);
    assert.equal(settled.result.stopReason, "end_turn");
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 2500, `the turn must converge on quiescence, not the deadline (took ${elapsed}ms)`);
    const streamed = adapter.allNotifications
      .filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((n) => n.params.update.content.text).join("");
    assert.equal(streamed, "Full short answer");
    assert.equal(
      journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length,
      1,
      "exactly one command leaves the process",
    );
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a trailing trickle inside the settle window streams in full before the turn ends", async () => {
  const sc = scenario({ turnTimeoutMs: 3000 });
  // The full text arrives as a slow row.delta trickle behind the terminal
  // patch: every segment is a projection change that restarts the quiet
  // clock, so the whole tail must stream before the turn ends — and none of
  // it may be duplicated or re-requested.
  const script = {
    frameDelayMs: 100,
    subscribeTurns: [
      [snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })],
      [snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })],
    ],
    frames: [
      deltaWire(10, 11, [appended(userRow(3, "Round two please"))]),
      deltaWire(11, 12, [stateUpdated({ control: control("running") })]),
      deltaWire(12, 13, [appended(assistantRow(4, "Tail:"))]),
      deltaWire(13, 14, [terminal()]),
      deltaWire(14, 15, [textDelta(4, " one")]),
      deltaWire(15, 16, [textDelta(4, " two")]),
      deltaWire(16, 17, [textDelta(4, " three")]),
      deltaWire(17, 18, [textDelta(4, " done.")]),
    ],
  };
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script,
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/adopt", { taskId: DESKTOP_SESSION })).result.sessionId;
    const settled = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Round two please") });
    assert.equal(settled.error, undefined);
    assert.equal(settled.result.stopReason, "end_turn");
    const streamed = adapter.allNotifications
      .filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((n) => n.params.update.content.text).join("");
    assert.equal(streamed, "Tail: one two three done.", "the whole trickle must reach the transcript");
    const calls = journalCalls(sc);
    assert.equal(
      calls.filter((call) => call.name === "sendConversationCommandV4").length,
      1,
      "the trickle never justifies a resend",
    );
    assert.equal(
      calls.filter((call) => call.channel === "zcode-task" && call.name === "createTask").length,
      0,
    );
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a lost send acknowledgement keeps the adopted task's ledger and blocks further prompts", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: adoptTerminalScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    sendError: "relay dropped the command",
  }));
  try {
    await initialize(adapter);
    const sessionId = (await adapter.request("session/adopt", { taskId: DESKTOP_SESSION })).result.sessionId;
    const prompt = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Round two please") });
    assert.equal(prompt.error.code, -32005);
    assert.match(prompt.error.message, /outcome is unknown/);
    const binding = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${sessionId}.json`), "utf8"));
    assert.equal(binding.desktopSessionId, DESKTOP_SESSION, "the record keeps the adopted task identity");
    assert.equal(typeof binding.dispatch.commandId, "string", "the unacknowledged command stays on the ledger");
    const retry = await adapter.request("session/prompt", { sessionId, prompt: await promptBlocks("Round two please") });
    assert.equal(retry.error.code, -32002);
    assert.match(retry.error.message, /outcome is unknown/);
    assert.equal(
      journalCalls(sc).filter((call) => call.name === "sendConversationCommandV4").length,
      1,
      "the command is never re-sent",
    );
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("session/adopt workspace rules: session mode requires the path, fixed mode refuses it, the task must be in the named workspace", async () => {
  const siteList = { "site-wid-a": [completedMeta(DESKTOP_SESSION)], "site-wid-b": [] };
  const siteTerminal = {
    subscribeTurns: [
      [snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })],
      [snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })],
    ],
  };

  // Session mode: the workspace pins and scopes the adoption.
  const sc = siteScenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: siteTerminal,
    bootstrap: SITE_BOOTSTRAP,
    taskList: siteList,
  }));
  try {
    await initialize(adapter);
    const missingPath = await adapter.request("session/adopt", { taskId: DESKTOP_SESSION });
    assert.equal(missingPath.error.code, -32602);
    assert.match(missingPath.error.message, /requires the workspacePath/);

    const wrongWorkspace = await adapter.request("session/adopt", { taskId: DESKTOP_SESSION, workspacePath: "D:\\site-ws-b" });
    assert.equal(wrongWorkspace.error.code, -32002);
    assert.match(wrongWorkspace.error.message, /not in this workspace's synced task index/);

    const adopted = await adapter.request("session/adopt", { taskId: DESKTOP_SESSION, workspacePath: "D:\\site-ws-a" });
    assert.equal(adopted.error, undefined);
    assert.equal(adopted.result.created, true);
    const normalize = (value) => value.replaceAll("\\", "/").replace(/\/+$/, "");
    const expected = process.platform === "win32" ? normalize("D:\\site-ws-a").toLowerCase() : normalize("D:\\site-ws-a");
    const binding = JSON.parse(readFileSync(path.join(sc.bindingsDir, `${adopted.result.sessionId}.json`), "utf8"));
    assert.equal(binding.scope.workspace, expected, "the adopted binding pins the normalized workspace");
    assert.equal(binding.workspace.identity, "site-wid-a");
    // Re-adopting through a differently spelled path of the same workspace reuses the binding.
    const again = await adapter.request("session/adopt", { taskId: DESKTOP_SESSION, workspacePath: "D:\\site-ws-a\\" });
    assert.equal(again.error, undefined);
    assert.equal(again.result.created, false);
    assert.equal(again.result.sessionId, adopted.result.sessionId);
    assert.deepEqual(readdirSync(sc.bindingsDir), [`${adopted.result.sessionId}.json`], "no second binding for one desktop task");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }

  // Fixed mode: the pin lives in the configuration; an explicit path is a client bug.
  const fixedSc = scenario();
  const fixed = new AdapterProc(fixedSc, fakeEnv(fixedSc, {
    script: siteTerminal,
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
  }));
  try {
    await initialize(fixed);
    const withPath = await fixed.request("session/adopt", { taskId: DESKTOP_SESSION, workspacePath: "D:\\fake-ws" });
    assert.equal(withPath.error.code, -32602);
    assert.match(withPath.error.message, /takes no workspace path/);
  } finally {
    await fixed.stop();
    await cleanup(fixedSc);
  }
});

// ---------- --task-snapshot: one read-only conversation snapshot ----------

/** Parses the single `[adapter] task-snapshot: <json>` stdout line. */
function parseSnapshotLine(out) {
  const line = out.split("\n").map((part) => part.trim()).find((part) => part.includes("] task-snapshot: "));
  assert.ok(line, "a task-snapshot line must be printed");
  return JSON.parse(line.slice(line.indexOf("] task-snapshot: ") + "] task-snapshot: ".length));
}

/** The adapter's summary row cap; tests exercise the boundary itself. */
const SNAPSHOT_ROW_CAP = 200;


/** A fixed-mode task list naming one completed native task in the pinned workspace. */
const SNAPSHOT_TASK_LIST = fixedTaskList([
  { taskId: DESKTOP_SESSION, title: "native task to read", status: "completed", createdAt: 1730000000000, updatedAt: 1730000500000 },
  { taskId: "dtask-snap-2", title: "still running", status: "running", createdAt: 1730001000000, updatedAt: 1730001500000 },
])

test("--task-snapshot reads one conversation read-only: ordered, scrubbed, bounded, never a command", async () => {
  const sc = scenario();
  try {
    const snapshot = buildSnapshot(6, {
      phase: "completedSuccess",
      rows: [
        userRow(0, "please summarize https://relay.example/secret"),
        toolRow(1, "tool-1", "success", { inputText: "ls" }),
        assistantRow(2, "see https://relay.example/x for details"),
        assistantRow(3, "second answer block"),
      ],
    });
    const env = fakeEnv(sc, {
      script: { subscribeFrames: [snapWire(6, {})] },
      taskList: SNAPSHOT_TASK_LIST,
    });
    // The scripted snapshot above needs the exact rows: rebuild the wire with
    // the crafted snapshot (snapWire's opts build covers phase/rows already).
    writeFileSync(sc.scriptFile, JSON.stringify({
      subscribeFrames: [wireFrame(0, 6, { kind: "snapshot", snapshot })],
    }));
    const result = await runAdapterOnce(["--config", sc.configFile, "--task-snapshot", DESKTOP_SESSION], env);
    assert.equal(result.code, 0);
    const report = parseSnapshotLine(result.out);
    assert.equal(report.taskId, DESKTOP_SESSION);
    assert.equal(report.phase, "completedSuccess");
    assert.equal(report.reason, null);
    assert.equal(report.rowCount, 4);
    // totalCount covers the window: the report does not claim truncation.
    assert.equal(report.partial, false);
    assert.deepEqual(
      report.summary.map((entry) => [entry.kind, entry.rowId]),
      [["user", 0], ["tool", 1], ["assistant", 2], ["assistant", 3]],
    );
    assert.match(report.summary[0].text, /please summarize \[url\]/);
    assert.equal(report.summary[2].text, "see [url] for details");
    assert.equal(report.summary[1].toolCallId, "tool-1");
    assert.equal(report.summary[1].title, "Bash");
    assert.equal(report.summary[1].status, "completed");
    // Read-only contract: identity check then hello/initialize/subscribe —
    // never a conversation command, never an adoption, never a created task.
    const calls = journalCalls(sc);
    assert.ok(calls.some((call) => call.channel === "zcode-task" && call.name === "listTasks"));
    assert.ok(calls.some((call) => call.channel === "zcode-agent" && call.name === "subscribeConversationV4"));
    assert.equal(
      calls.filter((call) => call.channel === "zcode-agent" && call.name === "sendConversationCommandV4").length,
      0,
      "the snapshot pass must never send a conversation command",
    );
    assert.equal(readJournal(sc).filter((entry) => entry.kind === "connect").length, 1, "one controller pairing");
    assertNoSecrets(result.out + result.err);
  } finally {
    await cleanup(sc);
  }
});

test("--task-snapshot flags a tail window as partial instead of faking full history", async () => {
  const sc = scenario();
  try {
    const window = [userRow(4, "late question"), assistantRow(5, "late answer")];
    const truncated = {
      ...buildSnapshot(9, { phase: "completedSuccess", rows: window }),
      rows: { window, totalCount: 6, firstRowId: 4 },
    };
    const env = fakeEnv(sc, {
      script: { subscribeFrames: [wireFrame(0, 9, { kind: "snapshot", snapshot: truncated })] },
      taskList: SNAPSHOT_TASK_LIST,
    });
    const result = await runAdapterOnce(["--config", sc.configFile, "--task-snapshot", DESKTOP_SESSION], env);
    assert.equal(result.code, 0);
    const report = parseSnapshotLine(result.out);
    assert.equal(report.partial, true, "window shorter than totalCount must read as recent-only");
    assert.equal(report.rowCount, 2);
  } finally {
    await cleanup(sc);
  }
});

test("--task-snapshot refuses a task the bridged workspace's index does not carry", async () => {
  const sc = scenario();
  try {
    const env = fakeEnv(sc, {
      script: { subscribeFrames: [snapWire(1, {})] },
      taskList: SNAPSHOT_TASK_LIST,
    });
    const result = await runAdapterOnce(["--config", sc.configFile, "--task-snapshot", "dtask-elsewhere"], env);
    assert.equal(result.code, 1);
    const report = parseSnapshotLine(result.out);
    assert.equal(report.reason, "task-missing");
    assert.equal(report.summary, null);
    // Identity refused before any subscription: nothing was read.
    const calls = journalCalls(sc);
    assert.ok(calls.some((call) => call.channel === "zcode-task" && call.name === "listTasks"));
    assert.equal(calls.filter((call) => call.channel === "zcode-agent").length, 0, "no conversation handshake for a missing task");
  } finally {
    await cleanup(sc);
  }
});

test("--task-snapshot isolates workspaces in session mode", async () => {
  const sc = siteScenario();
  try {
    const taskList = {
      "site-wid-a": [
        { taskId: "dtask-site-snap", title: "workspace A task", status: "completed", createdAt: 1, updatedAt: 1730000500000 },
      ],
    };
    const env = fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP, taskList });
    // The same task id asked through workspace B's listing: not found there.
    const wrong = await runAdapterOnce(
      ["--config", sc.configFile, "--task-snapshot", "dtask-site-snap", "D:\\site-ws-b"],
      env,
    );
    assert.equal(wrong.code, 1);
    assert.equal(parseSnapshotLine(wrong.out).reason, "task-missing");
    // Through its own workspace it reads.
    const siteTopic = (wire) => ({
      ...wire,
      topic: "conversation/dtask-site-snap",
      frame: { ...wire.frame, topic: "conversation/dtask-site-snap" },
    });
    writeFileSync(sc.scriptFile, JSON.stringify({
      subscribeFrames: [siteTopic(snapWire(3, { phase: "completedSuccess", rows: [userRow(0, "q"), assistantRow(1, "a")] }))],
    }));
    const right = await runAdapterOnce(
      ["--config", sc.configFile, "--task-snapshot", "dtask-site-snap", "D:\\site-ws-a"],
      fakeEnv(sc, { bootstrap: SITE_BOOTSTRAP, taskList }),
    );
    assert.equal(right.code, 0);
    const report = parseSnapshotLine(right.out);
    assert.equal(report.reason, null);
    assert.deepEqual(report.summary.map((entry) => entry.kind), ["user", "assistant"]);
  } finally {
    await cleanup(sc);
  }
});

test("--task-snapshot reports under a fully closed stdin: the referenced deadline owns the read", async () => {
  // runAdapterOnce spawns with stdin ignored: no parent handle keeps the
  // child's loop alive. The mode's own referenced hard deadline must keep the
  // bounded read alive and still print exactly one report line (here the
  // inner snapshot budget refuses first; the deadline is the backstop).
  const sc = scenario({ requestTimeoutMs: 1000 });
  try {
    const result = await runAdapterOnce(
      ["--config", sc.configFile, "--task-snapshot", DESKTOP_SESSION],
      fakeEnv(sc, { taskList: SNAPSHOT_TASK_LIST }),
    );
    assert.equal(result.code, 1);
    assert.equal(parseSnapshotLine(result.out).reason, "snapshot-unreadable");
    assert.match(result.err, /unavailable \(snapshot-unreadable\)/);
    assertNoSecrets(result.out + result.err);
  } finally {
    await cleanup(sc);
  }
});

test("--task-snapshot failure and argv validation modes", async () => {
  const sc = scenario();
  try {
    // No subscribe frames scripted: the wait for a snapshot times out and the
    // pass reports snapshot-unreadable without inventing content.
    const unreadable = await runAdapterOnce(
      ["--config", sc.configFile, "--task-snapshot", DESKTOP_SESSION],
      fakeEnv(sc, { taskList: SNAPSHOT_TASK_LIST }),
    );
    assert.equal(unreadable.code, 1);
    assert.equal(parseSnapshotLine(unreadable.out).reason, "snapshot-unreadable");
  } finally {
    await cleanup(sc);
  }

  const site = siteScenario();
  try {
    // Session mode without a path fails before any connection.
    const noPath = await runAdapterOnce(
      ["--config", site.configFile, "--task-snapshot", "dtask-1"],
      fakeEnv(site, { bootstrap: SITE_BOOTSTRAP }),
    );
    assert.equal(noPath.code, 2);
    assert.match(noPath.err, /requires a workspace path/);
  } finally {
    await cleanup(site);
  }

  const sc2 = scenario();
  try {
    // Fixed mode takes no path, and the mode is exclusive with --list-tasks.
    const withPath = await runAdapterOnce(
      ["--config", sc2.configFile, "--task-snapshot", "dtask-1", "D:\\fake-ws"],
      fakeEnv(sc2, { taskList: SNAPSHOT_TASK_LIST }),
    );
    assert.equal(withPath.code, 2);
    assert.match(withPath.err, /takes no workspace path/);
    const exclusive = await runAdapterOnce(
      ["--config", sc2.configFile, "--task-snapshot", "dtask-1", "--list-tasks"],
      fakeEnv(sc2, { taskList: SNAPSHOT_TASK_LIST }),
    );
    assert.equal(exclusive.code, 2);
    assert.match(exclusive.err, /exclusive/);
  } finally {
    await cleanup(sc2);
  }
});

test("--task-snapshot projects only user-authored inputs, never engine-sourced rows", async () => {
  const sc = scenario();
  try {
    const rows = [
      userRow(0, "real user question"),
      // Engine-sourced input rows: neither realUser origin nor guided — the
      // snapshot must not present them as conversation turns.
      row(1, { kind: "userInput", text: "engine-internal instruction", origin: "engine" }),
      row(2, { kind: "userInput", text: "queued host instruction" }),
      row(3, { kind: "userInput", text: "guided follow-up", origin: "system", guided: true }),
      assistantRow(4, "answer"),
    ];
    const env = fakeEnv(sc, {
      script: { subscribeFrames: [wireFrame(0, 7, { kind: "snapshot", snapshot: buildSnapshot(7, { phase: "completedSuccess", rows }) })] },
      taskList: SNAPSHOT_TASK_LIST,
    });
    const result = await runAdapterOnce(["--config", sc.configFile, "--task-snapshot", DESKTOP_SESSION], env);
    assert.equal(result.code, 0);
    const report = parseSnapshotLine(result.out);
    const userTexts = report.summary.filter((entry) => entry.kind === "user").map((entry) => entry.text);
    assert.deepEqual(userTexts, ["real user question", "guided follow-up"]);
    // The rowCount still reports every window row; only the summary filters.
    assert.equal(report.rowCount, 5);
  } finally {
    await cleanup(sc);
  }
});

test("--task-snapshot keeps the NEWEST rows when the cap truncates, still ascending, still partial", async () => {
  const sc = scenario();
  try {
    // A complete window (totalCount === window length) whose summary alone
    // exceeds the cap: recent-only by definition, never full history — and
    // the rows that survive are the newest ones, latest answer included.
    const rows = [];
    for (let index = 0; index < SNAPSHOT_ROW_CAP; index += 1) {
      rows.push(userRow(index, `turn ${index}`));
    }
    rows.push(assistantRow(SNAPSHOT_ROW_CAP, "the latest answer that must survive"));
    const env = fakeEnv(sc, {
      script: { subscribeFrames: [wireFrame(0, rows.length, { kind: "snapshot", snapshot: buildSnapshot(rows.length, { phase: "completedSuccess", rows }) })] },
      taskList: SNAPSHOT_TASK_LIST,
    });
    const result = await runAdapterOnce(["--config", sc.configFile, "--task-snapshot", DESKTOP_SESSION], env);
    assert.equal(result.code, 0);
    const report = parseSnapshotLine(result.out);
    assert.equal(report.summary.length, SNAPSHOT_ROW_CAP);
    assert.equal(report.rowCount, rows.length);
    assert.equal(report.partial, true, "a capped summary must read as recent-only even when the window is complete");
    // The newest 200 of the 201 projectable rows survive, in ascending order,
    // ending on the latest assistant reply; the oldest user turn fell off.
    const last = report.summary[report.summary.length - 1];
    assert.equal(last.kind, "assistant");
    assert.equal(last.text, "the latest answer that must survive");
    assert.equal(report.summary[0].text, "turn 1");
    for (let index = 1; index < report.summary.length; index += 1) {
      assert.ok(report.summary[index].rowId > report.summary[index - 1].rowId, "display order stays ascending");
    }
  } finally {
    await cleanup(sc);
  }
});

test("--task-snapshot scrubs credentials before capping so a straddling secret never leaks a fragment", async () => {
  const sc = scenario();
  try {
    // The secret starts six characters before the 16 KiB cap: slicing first
    // would keep a five-character fragment no redaction can match anymore.
    const pad = "a".repeat(16_384 - 6);
    const rows = [row(0, { kind: "userInput", text: `${pad}SECRETSID42-tail`, origin: "realUser" })];
    const env = fakeEnv(sc, {
      script: { subscribeFrames: [wireFrame(0, 1, { kind: "snapshot", snapshot: buildSnapshot(1, { phase: "completedSuccess", rows }) })] },
      taskList: SNAPSHOT_TASK_LIST,
    });
    const result = await runAdapterOnce(["--config", sc.configFile, "--task-snapshot", DESKTOP_SESSION], env);
    assert.equal(result.code, 0);
    const report = parseSnapshotLine(result.out);
    const text = report.summary[0].text;
    assert.ok(!text.includes("SECRE"), "no secret fragment survives the cap boundary");
    assert.ok(!/\[[^\[\]]{0,9}$/.test(text), "no half-written redaction marker is shown");
    assert.ok(text.length <= 16_384 && text.length >= 16_384 - 10, "the cap holds within one marker of its bound");
    assertNoSecrets(result.out + result.err);
  } finally {
    await cleanup(sc);
  }
});

// ---------- --reconcile-dispatch: verify-then-release an unresolved dispatch ----------
//
// The desktop protocol cannot prove non-application after a lost ack, so the
// reconcile mode gathers every read-only fact (task-index row, live snapshot
// phase, pending interactions, prompt-text match) and refuses on any signal of
// application, unreadable evidence, wrong scope, or a duplicate write-off. The
// ledger clears only under `--confirm human-verified`, and each write-off is
// one append-only reconcile-ledger.jsonl entry. No pass ever re-sends a
// command or creates a desktop task.

const STUCK_PROMPT = "please continue the incident report";
const RECONCILE_MARKER = "] reconcile: ";

/** Runs one --reconcile-dispatch child; `stdinLine` may be null. */
function runReconcile(sc, env, { args = [], stdinLine = null } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [ADAPTER, "--config", sc.configFile, "--reconcile-dispatch", ...args],
      { cwd: path.dirname(ADAPTER), env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => { err += chunk; });
    if (stdinLine !== null) proc.stdin.write(`${stdinLine}\n`);
    proc.once("exit", (code) => {
      const line = out.split("\n").map((part) => part.trim()).find((part) => part.includes(RECONCILE_MARKER));
      resolve({
        code, out, err,
        report: line === undefined ? null : JSON.parse(line.slice(line.indexOf(RECONCILE_MARKER) + RECONCILE_MARKER.length)),
      });
    });
  });
}

const expectedPromptLine = (text) => JSON.stringify({ expectedPromptText: text });
const reconcileLedgerLines = (sc) =>
  existsSync(path.join(sc.stateDir, "reconcile-ledger.jsonl"))
    ? readFileSync(path.join(sc.stateDir, "reconcile-ledger.jsonl"), "utf8").split("\n").filter((line) => line.length > 0)
    : [];

/**
 * Creates one stuck continuation binding the way a lost ack leaves it: adopt a
 * completed desktop task, then fail the sendText dispatch. Returns the adopted
 * ACP session id plus the binding's unresolved dispatch record.
 */
async function stuckContinuation(sc, adapter) {
  const adopted = await adapter.request("session/adopt", { taskId: DESKTOP_SESSION });
  assert.equal(adopted.error, undefined);
  const failed = await adapter.request("session/prompt", { sessionId: adopted.result.sessionId, prompt: await promptBlocks(STUCK_PROMPT) });
  assert.equal(failed.error.code, -32005, "the fixture dispatch must fail with an unknown outcome");
  const binding = bindingOf(sc, adopted.result.sessionId);
  assert.equal(binding.dispatch.kind, "sendText");
  assert.equal(typeof binding.dispatch.commandId, "string");
  return { sessionId: adopted.result.sessionId, dispatch: binding.dispatch };
}

/** Script for a dispatch process whose sendText fails (baseline stays clean). */
const stuckDispatchScript = () => ({ subscribeTurns: [[snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })]] });

test("reconcile dry run reports the evidence and writes nothing off", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    sendError: "TimeoutError: sendConversationCommandV4 timed out",
  }));
  try {
    const stuck = await stuckContinuation(sc, adapter);
    const sendCommandsBefore = sendCount(sc);
    const run = await runReconcile(sc, fakeEnv(sc, {
      script: stuckDispatchScript(),
      taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    }), { args: [DESKTOP_SESSION], stdinLine: expectedPromptLine(STUCK_PROMPT) });
    assert.equal(run.code, 0);
    assert.equal(run.report.reason, null);
    assert.equal(run.report.writtenOff, false);
    assert.equal(run.report.commandKind, "sendText");
    assert.equal(run.report.commandId, stuck.dispatch.commandId);
    assert.equal(run.report.taskStatus, "completed");
    assert.equal(run.report.phase, "completedSuccess");
    assert.equal(run.report.pendingInteractions, 0);
    assert.equal(run.report.promptMatched, false);
    assert.equal(run.report.expectedPromptProvided, true);
    // Nothing changed: the binding ledger entry and the audit trail are intact.
    assert.deepEqual(bindingOf(sc, stuck.sessionId).dispatch, stuck.dispatch);
    assert.equal(reconcileLedgerLines(sc).length, 0);
    assert.equal(sendCount(sc), sendCommandsBefore, "a reconcile pass never re-sends the old command");
    assertNoSecrets(`${run.out}\n${run.err}`);
    assert.ok(!run.out.includes(STUCK_PROMPT), "the expected prompt text must not be echoed");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("a human-verified confirm clears the ledger, audits the write-off, and reopens the desktop task", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    sendError: "TimeoutError: sendConversationCommandV4 timed out",
  }));
  const confirmEnv = fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
  });
  try {
    const stuck = await stuckContinuation(sc, adapter);
    const run = await runReconcile(sc, confirmEnv, {
      args: [DESKTOP_SESSION, "--confirm", "human-verified", "--operator", "codex-once"],
      stdinLine: expectedPromptLine(STUCK_PROMPT),
    });
    assert.equal(run.code, 0);
    assert.equal(run.report.reason, null);
    assert.equal(run.report.writtenOff, true);
    assert.equal(bindingOf(sc, stuck.sessionId).dispatch, null, "the adapter-side lock is released");
    const ledger = reconcileLedgerLines(sc);
    assert.equal(ledger.length, 1);
    const entry = JSON.parse(ledger[0]);
    assert.equal(entry.kind, "reconcile-dispatch");
    assert.equal(entry.taskId, DESKTOP_SESSION);
    assert.equal(entry.dshSessionId, stuck.sessionId);
    assert.equal(entry.commandId, stuck.dispatch.commandId);
    assert.equal(entry.commandKind, "sendText");
    assert.equal(entry.mode, "human-verified");
    assert.equal(entry.operatorSource, "codex-once");
    assert.equal(entry.evidence.promptMatched, false);
    assert.ok(!ledger[0].includes(STUCK_PROMPT), "the audit trail never carries the prompt text");
    assertNoSecrets(ledger[0]);

    // A duplicate confirm reports the completed write-off and appends nothing.
    const again = await runReconcile(sc, confirmEnv, {
      args: [DESKTOP_SESSION, "--confirm", "human-verified"],
      stdinLine: expectedPromptLine(STUCK_PROMPT),
    });
    assert.equal(again.code, 0);
    assert.equal(again.report.alreadyReconciled, true);
    assert.equal(again.report.writtenOff, true);
    assert.equal(again.report.commandId, stuck.dispatch.commandId);
    assert.equal(reconcileLedgerLines(sc).length, 1, "a duplicate changes nothing");

    // The desktop task is continuable again through adoption — no replacement task.
    await adapter.stop();
    const reopened = new AdapterProc(sc, confirmEnv);
    try {
      const readopt = await reopened.request("session/adopt", { taskId: DESKTOP_SESSION });
      assert.equal(readopt.error, undefined, "the cleared ledger unblocks adoption of the same desktop task");
      assert.equal(readopt.result.created, false);
      assert.equal(createTaskCount(sc), 0, "reconciliation must never create a desktop task");
    } finally {
      await reopened.stop();
    }

    // A torn write-off (ledger entry written, binding write lost) is refused by
    // naming the conflict; the ledger never gains a second entry over a lock.
    const tornBinding = bindingOf(sc, stuck.sessionId);
    tornBinding.dispatch = stuck.dispatch;
    writeFileSync(path.join(sc.bindingsDir, `${stuck.sessionId}.json`), JSON.stringify(tornBinding, null, 2));
    const torn = await runReconcile(sc, confirmEnv, {
      args: [DESKTOP_SESSION, "--confirm", "human-verified"],
      stdinLine: expectedPromptLine(STUCK_PROMPT),
    });
    assert.equal(torn.code, 1);
    assert.equal(torn.report.reason, "ledger-conflict");
    assert.equal(reconcileLedgerLines(sc).length, 1);
    assert.deepEqual(bindingOf(sc, stuck.sessionId).dispatch, stuck.dispatch, "the operator resolves the torn state from the ledger");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("reconcile keeps the dispatch locked when its audit ledger is unreadable", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    sendError: "TimeoutError: sendConversationCommandV4 timed out",
  }));
  const confirmEnv = fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
  });
  try {
    const stuck = await stuckContinuation(sc, adapter);
    writeFileSync(path.join(sc.stateDir, "reconcile-ledger.jsonl"), '{"v":1,"kind":"reconcile-dispatch"\n');
    const run = await runReconcile(sc, confirmEnv, {
      args: [DESKTOP_SESSION, "--confirm", "human-verified"],
      stdinLine: expectedPromptLine(STUCK_PROMPT),
    });
    assert.notEqual(run.code, 0);
    assert.deepEqual(bindingOf(sc, stuck.sessionId).dispatch, stuck.dispatch);
    assert.equal(reconcileLedgerLines(sc).length, 1, "the damaged ledger must not be appended to");
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("reconcile refuses when the follow-up prompt appears in the desktop conversation", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    sendError: "TimeoutError: sendConversationCommandV4 timed out",
  }));
  try {
    const stuck = await stuckContinuation(sc, adapter);
    // The live snapshot now shows the old instruction as a user turn: the
    // command was applied and must never be written off.
    const appliedScript = {
      subscribeTurns: [[snapWire(10, { phase: "completedSuccess", rows: [...ADOPT_HISTORY, userRow(3, STUCK_PROMPT)] })]],
    };
    const run = await runReconcile(sc, fakeEnv(sc, {
      script: appliedScript,
      taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    }), { args: [DESKTOP_SESSION, "--confirm", "human-verified"], stdinLine: expectedPromptLine(STUCK_PROMPT) });
    assert.equal(run.code, 1);
    assert.equal(run.report.reason, "prompt-matched");
    assert.equal(run.report.promptMatched, true);
    assert.deepEqual(bindingOf(sc, stuck.sessionId).dispatch, stuck.dispatch, "the lock stays");
    assert.equal(reconcileLedgerLines(sc).length, 0);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("reconcile refuses on a running, unknown, or absent task-index row", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    sendError: "TimeoutError: sendConversationCommandV4 timed out",
  }));
  try {
    const stuck = await stuckContinuation(sc, adapter);
    for (const [rows, reason] of [
      [[{ ...completedMeta(DESKTOP_SESSION), status: "running" }], "task-running"],
      [[{ ...completedMeta(DESKTOP_SESSION), status: "paused" }], "task-status-unknown"],
      [[], "task-missing"],
    ]) {
      const run = await runReconcile(sc, fakeEnv(sc, {
        script: stuckDispatchScript(),
        taskList: fixedTaskList(rows),
      }), { args: [DESKTOP_SESSION, "--confirm", "human-verified"], stdinLine: expectedPromptLine(STUCK_PROMPT) });
      assert.equal(run.code, 1);
      assert.equal(run.report.reason, reason);
    }
    assert.deepEqual(bindingOf(sc, stuck.sessionId).dispatch, stuck.dispatch, "no refusal path unlocked the ledger");
    assert.equal(reconcileLedgerLines(sc).length, 0);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("reconcile refuses while the live conversation runs or awaits input", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    sendError: "TimeoutError: sendConversationCommandV4 timed out",
  }));
  try {
    await stuckContinuation(sc, adapter);
    for (const [snapshot, reason] of [
      [{ phase: "running" }, "phase-not-terminal"],
      [{ phase: "completedSuccess", pendingInteractions: [{ id: "ask-1" }] }, "awaiting-input"],
    ]) {
      const script = { subscribeTurns: [[snapWire(10, { rows: ADOPT_HISTORY, ...snapshot })]] };
      const run = await runReconcile(sc, fakeEnv(sc, {
        script,
        taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
      }), { args: [DESKTOP_SESSION, "--confirm", "human-verified"], stdinLine: expectedPromptLine(STUCK_PROMPT) });
      assert.equal(run.code, 1);
      assert.equal(run.report.reason, reason);
    }
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("reconcile refuses outside its scope: wrong task, foreign connection, clean binding", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    sendError: "TimeoutError: sendConversationCommandV4 timed out",
  }));
  try {
    await stuckContinuation(sc, adapter);

    // A task no binding owns on this node.
    const wrongTask = await runReconcile(sc, fakeEnv(sc, {
      script: stuckDispatchScript(),
      taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    }), { args: ["dtask-unbound"], stdinLine: expectedPromptLine(STUCK_PROMPT) });
    assert.equal(wrongTask.code, 1);
    assert.equal(wrongTask.report.reason, "binding-not-found");

    // A connection-identity change (another device pairing) hides every binding.
    writeFileSync(sc.urlFile, URL_FILE_CONTENT_OTHER_DEVICE);
    const foreign = await runReconcile(sc, fakeEnv(sc, {
      script: stuckDispatchScript(),
      taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    }), { args: [DESKTOP_SESSION], stdinLine: expectedPromptLine(STUCK_PROMPT) });
    assert.equal(foreign.code, 1);
    assert.equal(foreign.report.reason, "binding-not-found");
    writeFileSync(sc.urlFile, URL_FILE_CONTENT);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }

  // A binding whose dispatch already settled normally has nothing to reconcile.
  const clean = scenario();
  const cleanAdapter = new AdapterProc(clean, fakeEnv(clean, {
    script: adoptTerminalScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
  }));
  try {
    await initialize(cleanAdapter);
    const adopted = await cleanAdapter.request("session/adopt", { taskId: DESKTOP_SESSION });
    const run = await runReconcile(clean, fakeEnv(clean, {
      script: adoptTerminalScript(),
      taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    }), { args: [DESKTOP_SESSION], stdinLine: expectedPromptLine("anything") });
    assert.equal(run.code, 1);
    assert.equal(run.report.reason, "nothing-to-reconcile");
    assert.equal(adopted.error, undefined);
    assert.equal(reconcileLedgerLines(clean).length, 0);
  } finally {
    await cleanAdapter.stop();
    await cleanup(clean);
  }
});

test("session-mode reconcile is workspace-scoped like adoption", async () => {
  const sc = siteScenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    bootstrap: SITE_BOOTSTRAP,
    script: { subscribeTurns: [[snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })]] },
    taskList: { "site-wid-a": [completedMeta(DESKTOP_SESSION)] },
    sendError: "TimeoutError: sendConversationCommandV4 timed out",
  }));
  try {
    const adopted = await adapter.request("session/adopt", { taskId: DESKTOP_SESSION, workspacePath: "D:\\site-ws-a" });
    assert.equal(adopted.error, undefined);
    const failed = await adapter.request("session/prompt", { sessionId: adopted.result.sessionId, prompt: await promptBlocks(STUCK_PROMPT) });
    assert.equal(failed.error.code, -32005);
    const evidenceEnv = fakeEnv(sc, {
      bootstrap: SITE_BOOTSTRAP,
      script: { subscribeTurns: [[snapWire(10, { phase: "completedSuccess", rows: ADOPT_HISTORY })]] },
      taskList: { "site-wid-a": [completedMeta(DESKTOP_SESSION)], "site-wid-b": [] },
    });
    // The binding lives in workspace A: asking from workspace B finds nothing.
    const wrongWorkspace = await runReconcile(sc, evidenceEnv, {
      args: [DESKTOP_SESSION, "D:\\site-ws-b", "--confirm", "human-verified"],
      stdinLine: expectedPromptLine(STUCK_PROMPT),
    });
    assert.equal(wrongWorkspace.code, 1);
    assert.equal(wrongWorkspace.report.reason, "binding-not-found");
    // From its own workspace the same pass succeeds.
    const ownWorkspace = await runReconcile(sc, evidenceEnv, {
      args: [DESKTOP_SESSION, "D:\\site-ws-a", "--confirm", "human-verified"],
      stdinLine: expectedPromptLine(STUCK_PROMPT),
    });
    assert.equal(ownWorkspace.code, 0);
    assert.equal(ownWorkspace.report.writtenOff, true);
    assert.equal(bindingOf(sc, adopted.result.sessionId).dispatch, null);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});

test("confirm without the expected prompt text refuses; argv misuse fails loud", async () => {
  const sc = scenario();
  const adapter = new AdapterProc(sc, fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
    sendError: "TimeoutError: sendConversationCommandV4 timed out",
  }));
  const evidenceEnv = fakeEnv(sc, {
    script: stuckDispatchScript(),
    taskList: fixedTaskList([completedMeta(DESKTOP_SESSION)]),
  });
  try {
    const stuck = await stuckContinuation(sc, adapter);
    // A dry run without stdin still reports the evidence; the prompt facet is null.
    const dry = await runReconcile(sc, evidenceEnv, { args: [DESKTOP_SESSION] });
    assert.equal(dry.code, 0);
    assert.equal(dry.report.reason, null);
    assert.equal(dry.report.promptMatched, null);
    assert.equal(dry.report.expectedPromptProvided, false);
    // Confirming without the text comparison is a hard refusal.
    const blind = await runReconcile(sc, evidenceEnv, { args: [DESKTOP_SESSION, "--confirm", "human-verified"] });
    assert.equal(blind.code, 1);
    assert.equal(blind.report.reason, "expected-prompt-missing");
    assert.deepEqual(bindingOf(sc, stuck.sessionId).dispatch, stuck.dispatch);
    // The attestation must be the explicit literal, and the fixed-mode workspace pin is not an argument.
    const badConfirm = await runReconcile(sc, evidenceEnv, { args: [DESKTOP_SESSION, "--confirm", "yes"], stdinLine: expectedPromptLine(STUCK_PROMPT) });
    assert.equal(badConfirm.code, 2);
    assert.match(badConfirm.err, /human-verified/);
    const badWorkspace = await runReconcile(sc, evidenceEnv, { args: [DESKTOP_SESSION, "D:\\fake-ws"], stdinLine: expectedPromptLine(STUCK_PROMPT) });
    assert.equal(badWorkspace.code, 2);
    assert.match(badWorkspace.err, /takes no workspace path/);
  } finally {
    await adapter.stop();
    await cleanup(sc);
  }
});
