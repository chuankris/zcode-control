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

function fakeEnv(sc, { script, bootstrap, ack, sendError, stopError, registerError, registerDelayMs, bootstrapDelayMs, connectError } = {}) {
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
    assert.equal(binding.scope.workspace, "d:/site-ws-b");
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
