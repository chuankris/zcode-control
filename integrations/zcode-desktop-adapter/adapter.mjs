#!/usr/bin/env node
// ACP-over-stdio agent facade for the local ZCode desktop's remote-control channel.
//
// Purpose: let the DSH workbench drive tasks that must be *visible in the running
// ZCode desktop* as an ordinary ACP agent node, next to the existing background
// ACP and zcode-hub-adapter nodes. The adapter reuses the verified
// remote-client transport (remoteClientRoot) instead of reimplementing it: it
// connects over the official internet relay, bootstraps the desktop, bridges
// exactly one workspace, and drives tasks through the same zcode-agent /
// zcode-task channel surface the official web client uses
// (helloConversationV4 / initializeConversationV4 / sendConversationCommandV4
// createSession/sendText/stop, subscribeConversationV4 /
// resyncConversationV4 / unsubscribeConversationV4 with the live
// onDynamicConversationFrame workspace frame stream, and
// zcode-task/createTask for native task-list registration).
//
// Continuation of an existing desktop task goes through `session/adopt`:
// the task id is verified against the official zcode-task/listTasks index
// and the live conversation snapshot (terminal phase, no pending
// interaction) before a recoverable binding is created or reused; later
// prompts then ride the existing sendText/startNow path and never
// createSession/createTask.
//
// Output source: turn output is projected ONLY from the official V4
// conversation subscription (snapshot wholesale-replace + contiguous
// (fromSeq,toSeq] delta intervals), matching the official web client's
// projection store semantics. The zcode-task/getTaskSnapshot polling path is
// deliberately unused for turn progress: on desktop 3.14.0 its resumeSession
// read can serve a stale in-memory projection for long tasks (live evidence:
// 2026-09-21 probes in zcode-lab/.private/remote-site-onboarding/).
//
// Safety posture (mirrors the verified desktop-task.mjs probe):
// - The command id is persisted BEFORE the envelope is sent; the desktop
//   session id is only recorded after an `accepted` ack, in one atomic write.
// - Timeout or a dropped link never triggers a resend; an unknown command
//   outcome blocks further prompts on that binding until a human checks the
//   desktop. The adapter never auto-creates a replacement session.
// - session/cancel maps to the real desktop `stop` conversation command
//   (verified against the installed desktop's own stopGeneration call site);
//   `cancelled` requires an accepted stop AND an observed terminal snapshot.
// - The relay grants one controller connection per device: discovery probes
//   and the task link serialize through a single in-process slot, and
//   session-mode session/new answers busy while a turn is in flight.
// - stdout carries JSON-RPC only. stderr carries fixed-string messages that
//   never echo URLs, session ids, or connection parameters.
//
// Requires Node >= 23.6 (native TypeScript type stripping for the reused
// remote-client sources); Node 24 verified. Zero runtime dependencies.
//
// Configuration: `adapter.mjs --config <private-json>` with keys
//   remoteClientRoot   path to the reused remote-client checkout (required)
//   connectionUrlFile  file holding the desktop remote-control URL (required;
//                      the only place secrets are read from; re-read per link)
//   workspaceSelection "fixed" (default) — `workspace` below pins one exact
//                      desktop workspace, as before;
//                      "session" — one node serves every workspace the site
//                      reports: session/new discovers them read-only and the
//                      workbench picks one per session before any dispatch
//   workspace          workspace path that must match exactly one registered
//                      desktop workspace (required iff workspaceSelection is
//                      "fixed"; it decides where the task runs — the DSH-side
//                      cwd does not)
//   siteName           operator-facing site label used in fixed-string
//                      diagnostics and the workspace option (optional;
//                      default "remote site"; never read from the URL)
//   stateDir           private directory for session bindings (required,
//                      outside the repository)
//   requestTimeoutMs   per-RPC budget, 1000..120000, default 20000
//   pollIntervalMs     idle wake interval for deadline/cancel checks,
//                      100..60000, default 2500 (no failure semantics attached)
//   turnTimeoutMs      wall-clock budget per turn, 1000..3600000, default 600000
//
// `--health` (with --config) performs one read-only discovery and reports a
// fixed-string summary — online/offline, desktop version, workspace count —
// without ever printing connection credentials.
//
// `--reconcile-dispatch <taskId> [<workspacePath>] [--confirm human-verified]
// [--operator <label>]` gathers the read-only desktop evidence for one
// unresolved dispatch ledger entry and, only under the explicit human
// attestation, writes it off (see the mode's own section below). The expected
// prompt text rides stdin as one JSON line, never argv.
//
// Exit codes: 0 clean shutdown · 1 health offline, task listing failed, or a
//             reconcile pass refused (nothing was written off)
//             2 bad configuration · 7 protocol frame limit
//             8 remote-client load failure
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const VERSION = "0.5.0";
const ADAPTER_NAME = "zcode-desktop-adapter";
const HOST_INSTRUCTIONS_PREFIX = "Current host instructions (replace earlier host instructions for this request).";
const MAX_LINE_CHARS = 16 * 1024 * 1024; // one ACP message, inbound
const CONVERSATION_PROTOCOL_VERSION = 3; // desktop conversation handshake (verified)
const TERMINAL_RELAY_STATES = new Set(["closed", "error", "kicked"]);

// JSON-RPC error codes: -32000 is reserved by DSH for auth_required detection,
// so adapter-defined server errors start at -32001.
const ERR_BUSY = -32001;
const ERR_SESSION_STATE = -32002;
const ERR_LINK = -32003;
const ERR_TURN = -32005;

const CLIENT_ID = `dsh-${ADAPTER_NAME}-${randomUUID()}`;

/** Fixed-string startup failure: the message never carries external input. */
function fail(code, message) {
  process.stderr.write(`[${ADAPTER_NAME}] ${message}\n`);
  process.exit(code);
}

if (process.argv.includes("--version")) {
  process.stdout.write(`${ADAPTER_NAME} ${VERSION}\n`);
  process.exit(0);
}

// ---------- configuration (external input: strictly validated) ----------

function expectString(field, value) {
  if (value === undefined || value === null) fail(2, `configuration is missing the ${field}`);
  if (typeof value !== "string" || value.length === 0) {
    fail(2, `configuration ${field} must be a non-empty string`);
  }
  return value;
}

function expectTimeoutMs(field, value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  const num = value;
  if (!Number.isInteger(num) || num < min || num > max) {
    fail(2, `configuration ${field} must be an integer between ${min} and ${max}`);
  }
  return num;
}

const configArgIdx = process.argv.indexOf("--config");
if (configArgIdx === -1) fail(2, "launch with --config <private-json>");
const configPath = process.argv[configArgIdx + 1];
if (!configPath || configPath.startsWith("-")) fail(2, "--config requires a file path argument");
const healthMode = process.argv.includes("--health");
// `--list-tasks [<workspacePath>]`: one read-only desktop task-index listing.
// The path is validated after configuration parsing (session mode requires it;
// fixed mode refuses it because the pin already lives in the configuration).
const listTasksArgIdx = process.argv.indexOf("--list-tasks");
const listTasksMode = listTasksArgIdx !== -1;
let listTasksWorkspace = null;
if (listTasksMode) {
  const candidate = process.argv[listTasksArgIdx + 1];
  if (candidate !== undefined && !candidate.startsWith("-")) listTasksWorkspace = candidate;
}
// `--reconcile-dispatch <taskId> [<workspacePath>] [--confirm human-verified]
// [--operator <label>]`: verify-then-release one unresolved dispatch ledger
// entry (see the mode block below the --list-tasks section). The expected
// prompt text arrives on stdin as one JSON line, never on the command line.
const reconcileArgIdx = process.argv.indexOf("--reconcile-dispatch");
const reconcileMode = reconcileArgIdx !== -1;
let reconcileTaskId = null;
let reconcileWorkspace = null;
let reconcileConfirm = false;
let reconcileOperator = null;
if (reconcileMode) {
  const operands = [];
  for (let index = reconcileArgIdx + 1; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--confirm") {
      if (process.argv[index + 1] !== "human-verified") fail(2, "--confirm requires the explicit attestation value human-verified");
      reconcileConfirm = true;
      index += 1;
      continue;
    }
    if (arg === "--operator") {
      const label = process.argv[index + 1];
      if (typeof label !== "string" || label.length === 0 || label.length > 120 || /[\r\n\0]/.test(label)) {
        fail(2, "--operator requires a label of 1..120 characters without line breaks");
      }
      reconcileOperator = label;
      index += 1;
      continue;
    }
    operands.push(arg);
  }
  if (operands.length < 1 || operands.length > 2 || operands.some((operand) => operand.startsWith("-"))) {
    fail(2, "--reconcile-dispatch takes a taskId and an optional workspace path");
  }
  reconcileTaskId = operands[0];
  reconcileWorkspace = operands[1] ?? null;
}
if (healthMode && listTasksMode) fail(2, "--health and --list-tasks are exclusive");
if ((healthMode || listTasksMode) && reconcileMode) fail(2, "--reconcile-dispatch is exclusive with --health and --list-tasks");
// `--task-snapshot <taskId> [<workspacePath>]`: one read-only conversation
// snapshot of an existing desktop task (the native-task detail entry). The
// path rules mirror --list-tasks and --reconcile-dispatch: session mode
// requires it, fixed mode refuses it.
const taskSnapshotArgIdx = process.argv.indexOf("--task-snapshot");
const taskSnapshotMode = taskSnapshotArgIdx !== -1;
let snapshotTaskId = null;
let snapshotWorkspace = null;
if (taskSnapshotMode) {
  const operands = [];
  for (let index = taskSnapshotArgIdx + 1; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg.startsWith("-") && arg !== "-") break;
    operands.push(arg);
  }
  if (operands.length < 1 || operands.length > 2) {
    fail(2, "--task-snapshot takes a taskId and an optional workspace path");
  }
  snapshotTaskId = operands[0];
  snapshotWorkspace = operands[1] ?? null;
}
if (taskSnapshotMode && (healthMode || listTasksMode || reconcileMode)) {
  fail(2, "--task-snapshot is exclusive with --health, --list-tasks, and --reconcile-dispatch");
}
let configRaw;
try {
  configRaw = readFileSync(configPath, "utf8");
} catch {
  fail(2, "config file is missing or unreadable");
}
let configFile;
try {
  configFile = JSON.parse(configRaw);
} catch {
  fail(2, "config file is not valid JSON");
}
if (typeof configFile !== "object" || configFile === null || Array.isArray(configFile)) {
  fail(2, "config file must contain a JSON object");
}

// "session" turns this node into a one-node-many-workspaces site adapter: the
// workspace is picked per session from the site's own list, never defaulted.
const workspaceSelection = configFile.workspaceSelection ?? "fixed";
if (workspaceSelection !== "fixed" && workspaceSelection !== "session") {
  fail(2, 'configuration workspaceSelection must be "fixed" or "session"');
}
const SESSION_WORKSPACES = workspaceSelection === "session";
if (listTasksMode && SESSION_WORKSPACES && listTasksWorkspace === null) {
  fail(2, "--list-tasks requires a workspace path when workspaceSelection is session");
}
if (listTasksMode && !SESSION_WORKSPACES && listTasksWorkspace !== null) {
  fail(2, "--list-tasks takes no workspace path; the workspace is pinned in this configuration");
}
if (reconcileMode) {
  if (typeof reconcileTaskId !== "string" || reconcileTaskId.length === 0 || reconcileTaskId.length > 200) {
    fail(2, "--reconcile-dispatch requires a taskId of 1..200 characters");
  }
  if (SESSION_WORKSPACES && reconcileWorkspace === null) {
    fail(2, "--reconcile-dispatch requires a workspace path when workspaceSelection is session");
  }
  if (!SESSION_WORKSPACES && reconcileWorkspace !== null) {
    fail(2, "--reconcile-dispatch takes no workspace path; the workspace is pinned in this configuration");
  }
}
if (taskSnapshotMode) {
  if (typeof snapshotTaskId !== "string" || snapshotTaskId.length === 0 || snapshotTaskId.length > 200) {
    fail(2, "--task-snapshot requires a taskId of 1..200 characters");
  }
  if (SESSION_WORKSPACES && snapshotWorkspace === null) {
    fail(2, "--task-snapshot requires a workspace path when workspaceSelection is session");
  }
  if (!SESSION_WORKSPACES && snapshotWorkspace !== null) {
    fail(2, "--task-snapshot takes no workspace path; the workspace is pinned in this configuration");
  }
}
if (SESSION_WORKSPACES && configFile.workspace !== undefined && configFile.workspace !== null) {
  fail(2, 'configuration workspace must be omitted when workspaceSelection is "session" (the workspace is chosen per session)');
}
if (!SESSION_WORKSPACES) expectString("workspace", configFile.workspace);
const siteName = configFile.siteName === undefined || configFile.siteName === null
  ? "remote site"
  : expectString("siteName", configFile.siteName);

const config = {
  remoteClientRoot: expectString("remoteClientRoot", configFile.remoteClientRoot),
  connectionUrlFile: expectString("connectionUrlFile", configFile.connectionUrlFile),
  workspace: SESSION_WORKSPACES ? null : configFile.workspace,
  stateDir: expectString("stateDir", configFile.stateDir),
  requestTimeoutMs: expectTimeoutMs("requestTimeoutMs", configFile.requestTimeoutMs, 20_000, 1_000, 120_000),
  pollIntervalMs: expectTimeoutMs("pollIntervalMs", configFile.pollIntervalMs, 2_500, 100, 60_000),
  turnTimeoutMs: expectTimeoutMs("turnTimeoutMs", configFile.turnTimeoutMs, 600_000, 1_000, 3_600_000),
};
try {
  if (!statSync(config.remoteClientRoot).isDirectory()) throw new Error("not a directory");
} catch {
  fail(2, "remoteClientRoot is not an existing directory");
}
if (!existsSync(config.connectionUrlFile)) {
  fail(2, "connectionUrlFile does not exist (the desktop remote-control URL must be provisioned first)");
}
try {
  mkdirSync(path.join(config.stateDir, "bindings"), { recursive: true });
} catch {
  fail(2, "stateDir is not writable");
}

/** Backslash/trailing-slash normalization; case-folded on Windows only. */
function normalizeWorkspacePath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
const WORKSPACE_NORM = SESSION_WORKSPACES ? null : normalizeWorkspacePath(config.workspace);

// ---------- secret scrubbing: nothing user-visible carries connection data ----------

const activeSecrets = { values: [] };

/** Removes connection credentials and any URL before text crosses stdio. */
function scrub(text) {
  let out = String(text);
  for (const secret of activeSecrets.values) {
    if (secret.length >= 4) out = out.replaceAll(secret, "[redacted]");
  }
  return out.replace(/(?:https?|wss?):\/\/\S+/g, "[url]");
}

function scrubCredentials(text) {
  for (const secret of activeSecrets.values) {
    if (secret.length >= 4) text = text.replaceAll(secret, "[redacted]");
  }
  return text;
}

// ---------- stdout: JSON-RPC only ----------

let stdoutBroken = false;

function writeMessage(message) {
  if (stdoutBroken) return;
  try {
    const line = JSON.stringify(message);
    if (line.length > MAX_LINE_CHARS) throw new Error("frame too large");
    process.stdout.write(`${line}\n`);
  } catch {
    stdoutBroken = true;
    process.exit(1);
  }
}

function replyResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message: scrub(message) } });
}

// ---------- reused remote-client: dynamic load ----------

let RemoteClientCtor;
let parseRemoteConnectionUrl;
let crc32Hex;

try {
  const clientModule = await import(
    pathToFileURL(path.join(config.remoteClientRoot, "src", "remote", "client.ts")).href
  );
  const paramsModule = await import(
    pathToFileURL(path.join(config.remoteClientRoot, "src", "remote", "connection-params.ts")).href
  );
  const crcModule = await import(
    pathToFileURL(path.join(config.remoteClientRoot, "src", "remote", "crc32.ts")).href
  );
  RemoteClientCtor = clientModule.RemoteClient;
  parseRemoteConnectionUrl = paramsModule.parseRemoteConnectionUrl;
  crc32Hex = crcModule.crc32Hex;
  if (typeof RemoteClientCtor !== "function" || typeof parseRemoteConnectionUrl !== "function" || typeof crc32Hex !== "function") {
    throw new Error("missing exports");
  }
} catch (error) {
  fail(8, `remoteClientRoot does not expose RemoteClient/parseRemoteConnectionUrl/crc32Hex (${error instanceof Error ? error.name : "unknown"})`);
}

// ---------- desktop link: lazy relay pairing, exact workspace bridge ----------

/** Link-level failure with a fixed, operator-readable reason. */
class LinkError extends Error {
  constructor(reason) {
    super(reason);
  }
}

function readConnection() {
  let params;
  try {
    params = parseRemoteConnectionUrl(readFileSync(config.connectionUrlFile, "utf8"));
  } catch {
    throw new LinkError("the connection URL file is unreadable");
  }
  if (!params) throw new LinkError("the connection URL file is invalid");
  activeSecrets.values = [params.source.href, params.deviceSid, params.passHash, encodeURIComponent(params.passHash)];
  return params;
}

// Credentials may rotate without moving a task; a different device/desktop
// session is a different authority even on the same relay and workspace path.
function connectionIdentity(params) {
  return createHash("sha256").update(JSON.stringify([
    params.source.origin, params.deviceMid ?? params.source.searchParams.get("mid"), params.deviceSid,
  ])).digest("hex");
}

function assertBindingScope(binding) {
  // Session-mode bindings carry workspace null until the user picks one; the
  // connection identity stays the authority either way.
  if ((!SESSION_WORKSPACES && binding.scope?.workspace !== WORKSPACE_NORM) ||
      binding.scope?.connection !== connectionIdentity(readConnection())) {
    throw new RpcError(ERR_SESSION_STATE, "session binding scope mismatch: the configured desktop or workspace changed; use the original node to continue this task");
  }
}

// The official relay grants one controller connection per paired device: a
// second pairing while one is live gets the older connection kicked. Every
// controller lifecycle in this process — the task link and read-only site
// discovery — therefore serializes through this slot, so the adapter never
// holds two controller connections (live evidence: the 2026-09-21 remote-site
// acceptance lost a running turn mid-stream to a concurrent session/new
// discovery pairing over it).
let controllerHeld = false;
const controllerWaiters = [];

/** Resolves once this process's single relay controller slot is free. */
async function acquireController() {
  while (controllerHeld) {
    await new Promise((resolve) => controllerWaiters.push(resolve));
  }
  controllerHeld = true;
}

/** Releases the slot; woken waiters re-race for it, the rest keep waiting. */
function releaseController() {
  controllerHeld = false;
  for (const waiter of controllerWaiters.splice(0)) waiter();
}

/**
 * One relay pairing + workspace bridge to the desktop. Connected lazily on the
 * first session operation that needs the desktop (prompt, load replay), never
 * at initialize time, so an offline desktop does not break workbench startup.
 */
const link = {
  client: undefined,
  bridge: undefined,
  params: undefined,
  workspace: undefined,
  appVersion: undefined,
  // Bootstrap facts from the current link; read-only menu rendering uses it
  // instead of opening a second relay connection.
  siteDiscovery: undefined,
  conversationReady: false,
  // Bumped whenever a recovered bridge invalidates server-side channel state;
  // the turn loop resubscribes the conversation stream on change (an event,
  // never an idle-timer guess).
  frameGeneration: 0,
  frameHandlers: new Map(),
  frameDetach: undefined,

  get host() {
    return this.params?.source?.host ?? null;
  },

  relayDead() {
    return this.client !== undefined && TERMINAL_RELAY_STATES.has(this.client.state);
  },

  workspaceTarget() {
    return {
      workspacePath: this.workspace.path,
      ...(this.workspace.identity !== null ? { workspaceIdentity: this.workspace.identity } : {}),
    };
  },

  attachFrameListener() {
    if (this.frameDetach !== undefined || this.bridge === undefined) return;
    this.frameDetach = this.bridge.subscribe(
      "zcode-agent",
      "onDynamicConversationFrame",
      (wire) => {
        const topic = typeof wire?.topic === "string" ? wire.topic : null;
        const handler = topic !== null ? this.frameHandlers.get(topic) : undefined;
        if (handler !== undefined) handler(wire);
      },
      this.workspaceTarget(),
    );
  },

  /** Routes logical frames for one conversation topic to its handler. */
  onConversationFrames(topic, handler) {
    this.frameHandlers.set(topic, handler);
    return () => {
      if (this.frameHandlers.get(topic) === handler) this.frameHandlers.delete(topic);
    };
  },

  async subscribeConversation(sessionId, base) {
    await this.conversationEnsure();
    this.attachFrameListener();
    const ack = await this.bridge.call("zcode-agent", "subscribeConversationV4", [
      { ...this.workspaceTarget(), sessionId, ...(base !== undefined ? { base } : {}) },
    ]);
    const subscriptionId = ack?.ack?.subscriptionId;
    if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
      throw new LinkError("the desktop conversation subscription ack carried no subscription id");
    }
    return {
      subscriptionId,
      mode: ack?.ack?.mode === "resume" ? "resume" : "snapshot",
      logEpoch: typeof ack?.ack?.logEpoch === "string" ? ack.ack.logEpoch : null,
    };
  },

  /** Server-authoritative recovery: forces a fresh snapshot onto the stream. */
  async resyncConversation(subscriptionId, forceSnapshot) {
    await this.conversationEnsure();
    return await this.bridge.call("zcode-agent", "resyncConversationV4", [
      {
        ...this.workspaceTarget(),
        subscriptionId,
        base: null,
        ...(forceSnapshot ? { forceSnapshot: true } : {}),
      },
    ]);
  },

  async unsubscribeConversation(subscriptionId) {
    if (this.bridge === undefined) return;
    await this.bridge.call("zcode-agent", "unsubscribeConversationV4", [
      { ...this.workspaceTarget(), subscriptionId },
    ]);
  },

  async ensure(workspaceNorm) {
    if (this.bridge !== undefined) {
      // Inner re-entry (conversation handshake, commands): a pure state check.
      const params = readConnection();
      if (connectionIdentity(params) !== connectionIdentity(this.params)) {
        throw new LinkError("the configured desktop changed; restart the adapter before using the new node");
      }
      if (this.relayDead()) throw new LinkError("the desktop control connection ended; reload the workbench session to reconnect");
      if (workspaceNorm !== undefined && normalizeWorkspacePath(this.workspace.path) !== workspaceNorm) {
        throw new LinkError("the bridged workspace does not match this session's selection; reload the workbench session");
      }
      return;
    }
    const target = workspaceNorm ?? WORKSPACE_NORM;
    if (target === null) {
      throw new LinkError("no workspace is selected for this session; choose one before dispatching");
    }
    const params = readConnection();
    // Hold the controller slot from pairing until dispose; an in-flight
    // discovery releases it first instead of being paired over.
    await acquireController();
    const client = new RemoteClientCtor(params, { requestTimeoutMs: config.requestTimeoutMs });
    try {
      await client.connect({ pairingTimeoutMs: Math.max(60_000, config.requestTimeoutMs * 2) });
      const boot = await client.bootstrap();
      this.siteDiscovery = discoveryFromBoot(boot);
      const workspace = pickDesktopWorkspace(boot, target);
      const bridge = await client.openBridge(workspace.identity ?? workspace.path);
      // Server-side channel state dies with a recovered bridge; re-handshake lazily.
      bridge.onRecovered?.(() => {
        this.conversationReady = false;
        this.frameGeneration += 1;
      });
      this.bridge = bridge;
      this.client = client;
      this.params = params;
      this.workspace = workspace;
      this.appVersion = typeof boot?.desktopAppVersion === "string" ? boot.desktopAppVersion : "web";
      this.attachFrameListener();
    } catch (error) {
      client.dispose();
      releaseController();
      if (error instanceof LinkError) throw error;
      throw new LinkError(`connecting to the ZCode desktop failed (${error instanceof Error ? error.name : "unknown"})`);
    }
  },

  async conversationEnsure() {
    await this.ensure();
    // The frame listener goes up before any command or subscription: server
    // pushes that race the subscribe ack must never be dropped.
    this.attachFrameListener();
    if (this.conversationReady) return;
    await this.bridge.call("zcode-agent", "helloConversationV4", []);
    await this.bridge.call("zcode-agent", "initializeConversationV4", [
      {
        kind: "clientHello",
        protocolVersion: CONVERSATION_PROTOCOL_VERSION,
        clientId: CLIENT_ID,
        clientKind: "web",
        appVersion: this.appVersion,
        capabilities: { workspaceHookReviewUi: true },
      },
    ]);
    this.conversationReady = true;
  },

  async sendCommand(envelope) {
    await this.ensure();
    return await this.bridge.call("zcode-agent", "sendConversationCommandV4", [
      {
        workspacePath: this.workspace.path,
        ...(this.workspace.identity !== null ? { workspaceIdentity: this.workspace.identity } : {}),
        envelope,
      },
    ]);
  },

  dispose() {
    this.bridge = undefined;
    this.conversationReady = false;
    this.frameDetach = undefined;
    this.siteDiscovery = undefined;
    if (this.client !== undefined) {
      const client = this.client;
      this.client = undefined;
      try {
        client.dispose();
      } catch {
        /* teardown must stay silent and fixed-string */
      }
      releaseController();
    }
  },
};

/**
 * Picks one workspace from bootstrap entries by normalized path. Exactly one
 * match is required: zero or multiple matches are errors and never fall back
 * to the desktop default workspace.
 */
function pickFromEntries(entries, workspaceNorm) {
  const matches = entries.filter((entry) => normalizeWorkspacePath(entry.path) === workspaceNorm);
  if (matches.length === 0) {
    throw new LinkError("the configured workspace is not registered in the ZCode desktop");
  }
  if (matches.length > 1) {
    throw new LinkError("multiple desktop workspaces match the configured path — the adapter refuses an ambiguous bridge");
  }
  return matches[0];
}

function pickDesktopWorkspace(boot, workspaceNorm) {
  return pickFromEntries(bootstrapWorkspaces(boot), workspaceNorm);
}

/** Raw bootstrap entries: workspacePath plus an optional identity key and label. */
function bootstrapWorkspaces(boot) {
  const raw = Array.isArray(boot) ? boot : boot?.workspaces;
  if (!Array.isArray(raw)) return [];
  const entries = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const entryPath = entry.workspacePath ?? entry.path;
    if (typeof entryPath !== "string" || entryPath.length === 0) continue;
    const identity = entry.workspaceIdentity ?? entry.workspaceKey ?? entry.key;
    const label = entry.label ?? entry.name;
    entries.push({
      path: entryPath,
      identity: typeof identity === "string" && identity.length > 0 ? identity : null,
      label: typeof label === "string" && label.length > 0 ? label : entryPath,
    });
  }
  return entries;
}

// ---------- read-only site discovery (session workspace selection) ----------

/** Bootstrap facts shared by discovery and bridging: entries plus version. */
function discoveryFromBoot(boot) {
  return {
    entries: bootstrapWorkspaces(boot),
    appVersion: typeof boot?.desktopAppVersion === "string" ? boot.desktopAppVersion : "web",
  };
}

/**
 * Connects, reads one bootstrap, and disconnects: the site's own workspace
 * list plus its desktop version, with no bridge and no conversation channel.
 * The relay's one-controller slot is released before returning. Duplicated
 * normalized paths are refused — an ambiguous option value can never select
 * one workspace exactly.
 */
async function discoverSite() {
  const params = readConnection();
  // Read-only still means a controller pairing: the slot serializes with the
  // task link so the two never contend for the desktop.
  await acquireController();
  const client = new RemoteClientCtor(params, { requestTimeoutMs: config.requestTimeoutMs });
  let discovery;
  try {
    await client.connect({ pairingTimeoutMs: Math.max(60_000, config.requestTimeoutMs * 2) });
    const boot = await client.bootstrap();
    discovery = discoveryFromBoot(boot);
    if (discovery.entries.length === 0) {
      throw new LinkError("the site registered no workspaces");
    }
    const seen = new Set();
    for (const entry of discovery.entries) {
      const norm = normalizeWorkspacePath(entry.path);
      if (seen.has(norm)) {
        throw new LinkError("the site reports multiple workspaces sharing one path — the adapter refuses an ambiguous selection");
      }
      seen.add(norm);
    }
  } finally {
    try {
      client.dispose();
    } catch {
      /* teardown must stay silent and fixed-string */
    }
    releaseController();
  }
  return discovery;
}

/**
 * The binding's selected workspace rendered back into the option list. A
 * selection that no longer resolves to exactly one site entry refuses the
 * load instead of guessing a replacement.
 */
function selectedPathOf(discovery, binding) {
  const selected = binding.workspace?.path;
  if (typeof selected !== "string" || selected.length === 0) return null;
  const matches = discovery.entries.filter((entry) => normalizeWorkspacePath(entry.path) === normalizeWorkspacePath(selected));
  if (matches.length !== 1) {
    throw new RpcError(ERR_SESSION_STATE, "the workspace selected for this session is no longer registered on the site; verify the site and re-select a workspace");
  }
  return matches[0].path;
}

/**
 * The per-session workspace option. Values are the site's raw workspace paths;
 * the description carries the read-only health metadata (site label, desktop
 * version, workspace count) because the ACP card protocol has no first-class
 * metadata slot.
 */
function siteWorkspaceConfigOption(discovery, currentPath) {
  return {
    id: "workspace",
    name: "Workspace",
    category: "workspace",
    description: `${siteName}: desktop ${discovery.appVersion}, ${discovery.entries.length} registered workspaces. The task runs in the workspace chosen here; no default is applied.`,
    type: "select",
    currentValue: typeof currentPath === "string" ? currentPath : "",
    options: discovery.entries.map((entry) => ({ value: entry.path, name: entry.label })),
  };
}

function sessionConfigOptions(discovery, currentPath) {
  return [...MODEL_CONFIG_OPTIONS, siteWorkspaceConfigOption(discovery, currentPath)];
}

// ---------- bindings: atomic, scope-checked, outside the repository ----------

const BINDING_ID_PATTERN = /^[A-Za-z0-9-]+$/;

function bindingPath(dshSessionId) {
  return path.join(config.stateDir, "bindings", `${dshSessionId}.json`);
}

function readBinding(dshSessionId) {
  if (typeof dshSessionId !== "string" || !BINDING_ID_PATTERN.test(dshSessionId)) return undefined;
  const file = bindingPath(dshSessionId);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || parsed.v !== 1 ||
        parsed.adapter !== ADAPTER_NAME || parsed.dshSessionId !== dshSessionId ||
        !parsed.scope || (parsed.desktopSessionId !== null && typeof parsed.desktopSessionId !== "string")) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** tmp + rename in the same directory: readers see only whole bindings. */
function writeBinding(binding) {
  if (typeof binding.dshSessionId !== "string" || !BINDING_ID_PATTERN.test(binding.dshSessionId)) return;
  binding.updatedAt = Date.now();
  const file = bindingPath(binding.dshSessionId);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(binding, null, 2));
  renameSync(temporary, file);
}

function assembleBinding(cwd) {
  const dshSessionId = `zdsk-${randomUUID()}`;
  return {
    v: 1,
    adapter: ADAPTER_NAME,
    dshSessionId,
    // Session-mode bindings select the workspace later (session/set_config_option).
    scope: { workspace: SESSION_WORKSPACES ? null : WORKSPACE_NORM, connection: connectionIdentity(readConnection()) },
    ...(typeof cwd === "string" && cwd.length > 0 ? { cwd } : {}),
    desktopSessionId: null,
    dispatch: null,
    workspace: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function newBinding(cwd) {
  const binding = assembleBinding(cwd);
  writeBinding(binding);
  return binding;
}

/**
 * Listing validates the configured desktop identity without opening a relay.
 */
function listScopedBindings() {
  const dir = path.join(config.stateDir, "bindings");
  const out = [];
  const connection = connectionIdentity(readConnection());
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const binding = readBinding(name.slice(0, -".json".length));
    if (binding?.scope?.connection !== connection) continue;
    if (!SESSION_WORKSPACES && binding.scope.workspace !== WORKSPACE_NORM) continue;
    out.push(binding);
  }
  return out;
}

/** Pin the registered workspace identity after validating the saved authority. */
function refreshBindingScope(binding) {
  assertBindingScope(binding);
  if (binding.workspace?.identity && binding.workspace.identity !== link.workspace?.identity) {
    throw new RpcError(ERR_SESSION_STATE, "the desktop workspace identity changed; refusing to reuse the task binding");
  }
  binding.workspace = link.workspace === undefined ? null : { ...link.workspace };
}

/**
 * The in-scope binding that already owns one desktop task id, when any.
 * Session-mode bindings for other workspaces are excluded by the caller's
 * scope check so one desktop task never maps to two bindings on this node.
 */
function findBindingByDesktopTask(taskId) {
  for (const binding of listScopedBindings()) {
    if (binding.desktopSessionId === taskId) return binding;
  }
  return undefined;
}

/**
 * `session/adopt`: binds one existing desktop task so later prompts continue
 * it through sendText/startNow instead of creating a replacement task.
 * Verification is fail-closed on two independent desktop sources —
 *   1. the official `zcode-task/listTasks` index of the bridged workspace
 *      must carry the task id with status "completed";
 *   2. the live conversation snapshot must be terminal with no pending
 *      interaction.
 * A binding that already owns this desktop task (this connection, this
 * workspace) is reused verbatim — never a second binding. Any mismatch,
 * uncertain state, or unconfirmed previous dispatch refuses; this method
 * never creates a desktop session, never registers one, and never re-sends.
 */
async function handleAdoptSession(params) {
  if (turnInFlight !== null) {
    throw new RpcError(ERR_BUSY, "a prompt turn is in flight; task adoption is unavailable until it ends");
  }
  const taskId = params?.taskId;
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 200) {
    throw new RpcError(-32602, "session/adopt requires a taskId string of 1..200 characters");
  }
  const requestedWorkspace = params?.workspacePath;
  if (SESSION_WORKSPACES) {
    if (typeof requestedWorkspace !== "string" || requestedWorkspace.length === 0) {
      throw new RpcError(-32602, "session/adopt requires the workspacePath the desktop task belongs to");
    }
  } else if (requestedWorkspace !== undefined && requestedWorkspace !== null) {
    throw new RpcError(-32602, "session/adopt takes no workspace path; the workspace is pinned in this configuration");
  }
  const targetNorm = SESSION_WORKSPACES ? normalizeWorkspacePath(requestedWorkspace) : WORKSPACE_NORM;
  const existing = findBindingByDesktopTask(taskId);
  if (existing !== undefined) {
    const scopeWorkspace = SESSION_WORKSPACES ? existing.scope.workspace : WORKSPACE_NORM;
    if (scopeWorkspace !== targetNorm) {
      throw new RpcError(ERR_SESSION_STATE, "the desktop task is already bound to another workspace on this site; continue it from its own workspace");
    }
    if (existing.dispatch !== null && existing.dispatch !== undefined) {
      throw new RpcError(ERR_SESSION_STATE, "the previous desktop command's outcome is unknown (adapter restart or lost ack); verify the task in the Zcode desktop before sending more prompts");
    }
  }
  await link.ensure(SESSION_WORKSPACES ? targetNorm : undefined).catch((error) => {
    throw new RpcError(ERR_LINK, error instanceof LinkError ? error.message : "desktop link failed");
  });
  await link.conversationEnsure().catch(() => {
    throw new RpcError(ERR_LINK, "the desktop conversation handshake failed");
  });
  let metas;
  try {
    metas = await link.bridge.call("zcode-task", "listTasks", [link.workspaceTarget()]);
  } catch {
    throw new RpcError(ERR_LINK, "the desktop task index could not be read; the task cannot be verified for continuation");
  }
  const meta = Array.isArray(metas)
    ? metas.find((entry) => typeof entry === "object" && entry !== null && entry.taskId === taskId)
    : undefined;
  if (meta === undefined) {
    throw new RpcError(ERR_SESSION_STATE, "the desktop task is not in this workspace's synced task index (it may be pinned, archived, or belong to another workspace); continuation is refused");
  }
  if (meta.status !== "completed") {
    const status = meta.status === "running" || meta.status === "error" ? meta.status : "unknown";
    throw new RpcError(ERR_SESSION_STATE, `the desktop task is not completed (${status}); finish or verify it in the Zcode desktop first`);
  }
  const stream = new ConversationStream(taskId);
  try {
    await stream.attach().catch((error) => {
      throw new RpcError(ERR_LINK, error instanceof LinkError ? error.message : "desktop conversation subscription failed");
    });
    await stream.waitForSnapshot(config.requestTimeoutMs).catch(() => {
      throw new RpcError(ERR_LINK, "the desktop task state could not be read for continuation (no initial conversation snapshot)");
    });
    if (!TERMINAL_PHASES.has(stream.projection.phase) || stream.projection.pendingInteractions.length > 0) {
      throw new RpcError(ERR_SESSION_STATE, "the desktop task's live conversation is still running or awaiting input; continuation is refused");
    }
  } finally {
    await stream.dispose();
  }
  if (existing !== undefined) {
    refreshBindingScope(existing);
    writeBinding(existing);
    return { sessionId: existing.dshSessionId, created: false };
  }
  const binding = assembleBinding(undefined);
  binding.desktopSessionId = taskId;
  binding.scope.workspace = targetNorm;
  binding.workspace = { ...link.workspace };
  // The desktop registered this task itself when it was created; registerDesktopTask
  // must never submit it to zcode-task/createTask.
  binding.registration = "adopted";
  writeBinding(binding);
  return { sessionId: binding.dshSessionId, created: true };
}

/** Register the existing session with the desktop task facade. It initializes
 * project-list placement and emits task_created; a raw agent createSession
 * alone does not establish those desktop subscriptions. Never submit input here.
 * The createTask result's task id is the verification; the stale-prone
 * zcode-task snapshot read is deliberately not consulted.
 */
async function registerDesktopTask(binding) {
  if (binding.registration === "registered" || binding.registration === "adopted") return;
  if (binding.registration === "pending" || binding.registration === "unknown") {
    throw new RpcError(ERR_SESSION_STATE, "desktop task registration is unconfirmed; inspect the existing native task before retrying");
  }
  binding.registration = "pending";
  writeBinding(binding);
  try {
    const result = await link.bridge.call("zcode-task", "createTask", [{
      workspacePath: link.workspace.path,
      ...(link.workspace.identity !== null ? { workspaceIdentity: link.workspace.identity } : {}),
      draftSessionId: binding.desktopSessionId,
      v4Create: true,
    }]);
    if (result?.taskId !== binding.desktopSessionId) throw new Error("task identity mismatch");
    binding.registration = "registered";
    writeBinding(binding);
  } catch {
    binding.registration = "unknown";
    writeBinding(binding);
    throw new RpcError(ERR_LINK, "the task was dispatched but desktop list registration is unconfirmed; inspect the saved native task, do not dispatch a replacement");
  }
}

// ---------- V4 conversation projection: wire frames, snapshot replace, contiguous deltas ----------
//
// Mirrors the official conversationProjectionStore contract (ZCode-official
// packages/ui/src/v4/conversationProjectionStore.ts, Apache-2.0):
//   1. a snapshot frame wholesale-replaces the projection, never merges;
//   2. delta frames apply only when interval-contiguous (fromSeq === seq);
//      a gap is never guessed at or compensated locally;
//   3. on a gap/assembly fault the adapter resubscribes or resyncs carrying
//      its watermark — the server decides resume vs snapshot — and commands
//      are never re-sent.
// Row facts come from the official rows schema: assistantText/reasoning rows
// carry state + text, toolCall rows carry toolCallId/status/output, and
// `reasoning` rows are never projected (this channel streams text output only).

const V4_WIRE_VERSION = 3;
const TERMINAL_PHASES = new Set(["completedSuccess", "completedInterrupted", "error"]);
const TOOL_ROW_STATUS_TO_ACP = {
  inputStreaming: "in_progress",
  pendingApproval: "in_progress",
  running: "in_progress",
  success: "completed",
  error: "failed",
  cancelled: "failed",
};
const TOOL_KIND_BY_NAME = new Map([
  ["Read", "read"], ["Edit", "edit"], ["Write", "edit"], ["MultiEdit", "edit"], ["NotebookEdit", "edit"],
  ["Delete", "delete"], ["Move", "move"], ["Grep", "search"], ["Glob", "search"],
  ["Bash", "execute"], ["Execute", "execute"], ["WebFetch", "fetch"], ["WebSearch", "fetch"],
  ["Task", "other"], ["Think", "think"],
]);

// ---------- conversation command acknowledgement (proven V4 contract) ----------
//
// commandAckSchema (ZCode-official 3.14.0 packages/shared/src/zcode-protocol-v4/
// command.ts; the installed 3.14.3 desktop bundle enforces the same set through
// assertV4CommandAckOk) resolves every conversation command with
// { commandId, status, reasonCode?, message?, revisionAtDecision, result? } where
// status is exactly one of accepted/rejected/stale/duplicate/noop/failed. On the
// remote channel the ack is observed in two positions: flat on the RPC reply
// (live 2026-09-21 createSession dispatch) and nested under `ack` like the other
// conversation RPC results (subscribeConversationV4, live 2026-09-28).
// Recognition requires exactly one of those positions to carry a known status
// and, when the ack names a command id, that id to be this command's; every
// other shape stays unrecognized and fails closed.

const COMMAND_ACK_STATUSES = new Set(["accepted", "rejected", "stale", "duplicate", "noop", "failed"]);
/** Officially processed-OK statuses (assertV4CommandAckOk): the command was handled. */
const COMMAND_ACK_OK_FOR_STOP = new Set(["accepted", "duplicate", "noop"]);

function commandAckCandidate(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
      COMMAND_ACK_STATUSES.has(value.status)
    ? value
    : undefined;
}

/**
 * Interprets one sendConversationCommandV4 reply against the proven contract.
 * @param {unknown} reply - the raw RPC reply.
 * @param {string} commandId - the dispatched envelope's command id.
 * @returns {{ ack: object, status: string, detail: string } | undefined} undefined for every unrecognized shape.
 */
function interpretCommandAck(reply, commandId) {
  const candidates = [commandAckCandidate(reply), commandAckCandidate(reply?.ack)]
    .filter((candidate) => candidate !== undefined);
  if (candidates.length !== 1) return undefined;
  const ack = candidates[0];
  if (typeof ack.commandId === "string" && ack.commandId !== commandId) return undefined;
  const detail = [
    `status ${String(ack.status)}`,
    typeof ack.reasonCode === "string" && ack.reasonCode.length > 0 ? `reason ${ack.reasonCode}` : undefined,
    typeof ack.message === "string" && ack.message.length > 0 ? `message ${scrub(ack.message.slice(0, 120))}` : undefined,
  ].filter(Boolean).join(", ");
  return { ack, status: ack.status, detail };
}

function decodeBase64(value) {
  return Buffer.from(value, "base64");
}

/**
 * Official TopicWireFrame semantics, minimal form: complete frames pass through;
 * fragments of one logicalFrameId assemble in fragmentIndex order, guarded by
 * the crc32 checksum. Any assembly violation is a fault (fail closed); the
 * caller resyncs — the server is the only recovery authority.
 */
class WireAssembler {
  constructor() {
    this.pending = new Map(); // logicalFrameId -> { count, parts: Map<index, base64>, logicalBytes }
  }

  /** @returns {{ frame: object } | { fault: string } | null while fragments are outstanding */
  accept(wire) {
    if (wire?.wireVersion !== V4_WIRE_VERSION) return { fault: "unsupported wire version" };
    if (wire.kind === "complete") {
      if (typeof wire.frame !== "object" || wire.frame === null) return { fault: "complete frame without payload" };
      return { frame: wire.frame };
    }
    if (wire.kind !== "fragment") return { fault: "unknown wire kind" };
    const { logicalFrameId, fragmentIndex, fragmentCount, logicalBytes, checksum, dataBase64 } = wire;
    if (typeof logicalFrameId !== "string" || typeof fragmentIndex !== "number" || typeof fragmentCount !== "number" ||
        typeof logicalBytes !== "number" || typeof dataBase64 !== "string" || typeof checksum?.value !== "string") {
      return { fault: "malformed fragment" };
    }
    if (!Number.isInteger(fragmentIndex) || fragmentIndex < 0 || fragmentIndex >= fragmentCount) {
      return { fault: "fragment index out of range" };
    }
    let entry = this.pending.get(logicalFrameId);
    if (entry === undefined) {
      entry = { count: fragmentCount, logicalBytes, parts: new Map(), checksum: checksum.value };
      this.pending.set(logicalFrameId, entry);
    }
    if (entry.count !== fragmentCount || entry.checksum !== checksum.value) return { fault: "fragment set mismatch" };
    entry.parts.set(fragmentIndex, dataBase64);
    if (entry.parts.size < entry.count) return null;
    this.pending.delete(logicalFrameId);
    const buffers = [];
    for (let index = 0; index < entry.count; index += 1) {
      const part = entry.parts.get(index);
      if (part === undefined) return { fault: "missing fragment part" };
      buffers.push(decodeBase64(part));
    }
    const joined = Buffer.concat(buffers);
    if (joined.byteLength !== entry.logicalBytes) return { fault: "assembled length mismatch" };
    if (crc32Hex(joined) !== entry.checksum) return { fault: "assembled checksum mismatch" };
    let frame;
    try {
      frame = JSON.parse(joined.toString("utf8"));
    } catch {
      return { fault: "assembled frame is not JSON" };
    }
    if (typeof frame !== "object" || frame === null) return { fault: "assembled frame is not an object" };
    return { frame };
  }

  drop() {
    this.pending.clear();
  }
}

function validRow(row) {
  return typeof row === "object" && row !== null && typeof row.rowId === "number" && typeof row.kind === "string";
}

/**
 * The live conversation projection. `applyFrame` returns the rows that changed
 * (in application order) plus the state patch flag, or `{ gap: true }` when the
 * frame's interval does not continue the current watermark — the caller must
 * recover through the server, never by applying the frame.
 */
class ConversationProjection {
  constructor() {
    this.reset();
  }

  reset() {
    this.seq = null;
    this.logEpoch = null;
    this.phase = null;
    this.rows = new Map();
    this.pendingInteractions = [];
    this.lastError = null;
    this.inputRouting = null;
    // Official snapshot rows carry a totalCount next to the window; a window
    // shorter than it is a truncated tail. Null when the snapshot omitted it
    // (then completeness simply cannot be claimed).
    this.totalRowCount = null;
  }

  get terminal() {
    return TERMINAL_PHASES.has(this.phase);
  }

  applyFrame(frame) {
    const { topic, subscriptionId, fromSeq, toSeq, payload } = frame ?? {};
    if (typeof topic !== "string" || typeof subscriptionId !== "string" ||
        typeof fromSeq !== "number" || typeof toSeq !== "number" || typeof payload?.kind !== "string") {
      return { gap: true };
    }
    if (payload.kind === "snapshot") {
      const snapshot = payload.snapshot;
      const window = snapshot?.rows?.window;
      if (!Array.isArray(window) || typeof snapshot?.seq !== "number" || typeof snapshot?.control?.phase !== "string") {
        return { gap: true };
      }
      this.reset();
      this.seq = snapshot.seq;
      this.logEpoch = typeof snapshot.logEpoch === "string" ? snapshot.logEpoch : null;
      this.phase = snapshot.control.phase;
      this.lastError = snapshot.control?.lastError ?? null;
      this.inputRouting = snapshot.inputRouting ?? null;
      this.pendingInteractions = Array.isArray(snapshot.pendingInteractions) ? snapshot.pendingInteractions : [];
      this.totalRowCount = typeof snapshot.rows?.totalCount === "number" && Number.isFinite(snapshot.rows.totalCount)
        ? snapshot.rows.totalCount
        : null;
      const changed = [];
      for (const row of window) {
        if (!validRow(row)) return { gap: true };
        this.rows.set(row.rowId, row);
        changed.push(row);
      }
      return { replaced: true, changedRows: changed };
    }
    if (payload.kind !== "deltas" || !Array.isArray(payload.deltas)) return { gap: true };
    if (this.seq === null || fromSeq !== this.seq) return { gap: true };
    const changed = [];
    for (const delta of payload.deltas) {
      switch (delta?.op) {
        case "row.appended":
        case "row.upserted": {
          const row = delta.row;
          if (!validRow(row)) return { gap: true };
          if (delta.op === "row.upserted" && !this.rows.has(row.rowId)) break;
          this.rows.set(row.rowId, row);
          changed.push(row);
          break;
        }
        case "row.removed": {
          if (typeof delta.fromRowId !== "number") return { gap: true };
          for (const rowId of [...this.rows.keys()]) {
            if (rowId >= delta.fromRowId) this.rows.delete(rowId);
          }
          break;
        }
        case "row.delta": {
          const row = this.rows.get(delta.rowId);
          if (typeof delta.append !== "string") return { gap: true };
          if (row === undefined) break; // row outside the subscribed tail window
          let next;
          if (delta.path === "text" && (row.kind === "assistantText" || row.kind === "reasoning")) {
            next = { ...row, text: row.text + delta.append };
          } else if (delta.path === "inputText" && row.kind === "toolCall") {
            next = { ...row, inputText: row.inputText + delta.append };
          } else if (delta.path === "output.text" && row.kind === "toolCall" && row.output) {
            next = { ...row, output: { ...row.output, text: row.output.text + delta.append } };
          } else if (delta.path === "summaryText" && row.kind === "subagent") {
            next = { ...row, summaryText: row.summaryText + delta.append };
          } else {
            break; // official applyConversationDelta treats non-matching paths as no-op
          }
          this.rows.set(row.rowId, next);
          changed.push(this.rows.get(row.rowId));
          break;
        }
        case "state.updated": {
          const patch = delta.patch;
          if (typeof patch !== "object" || patch === null) return { gap: true };
          if (typeof patch.control?.phase === "string") this.phase = patch.control.phase;
          if (patch.control?.lastError !== undefined) this.lastError = patch.control.lastError;
          if (patch.inputRouting !== undefined) this.inputRouting = patch.inputRouting;
          if (Array.isArray(patch.pendingInteractions)) this.pendingInteractions = patch.pendingInteractions;
          break;
        }
        default:
          return { gap: true };
      }
    }
    this.seq = toSeq;
    return { changedRows: changed };
  }
}

/** Text content of a row; null for rows this channel does not project. */
function rowText(row) {
  if (row?.kind === "assistantText" && typeof row.text === "string") return row.text;
  return null;
}

/** One toolCall row reduced to the ACP card facts; null when unusable. */
function rowToolCard(row) {
  if (row?.kind !== "toolCall" || typeof row.toolCallId !== "string" || row.toolCallId.length === 0) return null;
  const title = typeof row.toolName === "string" && row.toolName.length > 0 ? row.toolName : "tool";
  const status = TOOL_ROW_STATUS_TO_ACP[row.status] ?? "pending";
  const output = typeof row.output === "string"
    ? row.output
    : typeof row.output?.text === "string"
      ? row.output.text
      : undefined;
  return {
    toolCallId: row.toolCallId,
    title,
    kind: TOOL_KIND_BY_NAME.get(title) ?? "other",
    status,
    ...(output !== undefined ? { output: scrubCredentials(output.slice(0, 16_384)) } : {}),
    ...(typeof row.error?.message === "string" ? { error: scrubCredentials(row.error.message.slice(0, 512)) } : {}),
  };
}

// ---------- ACP session/update emitters ----------

function emitUpdate(sessionId, update) {
  writeMessage({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function emitContentChunk(sessionId, sessionUpdate, text, messageId) {
  emitUpdate(sessionId, {
    sessionUpdate,
    content: { type: "text", text: scrubCredentials(text) },
    ...(messageId !== undefined ? { messageId } : {}),
  });
}

function emitToolCall(sessionId, tool, phase) {
  const base = {
    toolCallId: tool.toolCallId,
    title: scrubCredentials(tool.title),
    kind: tool.kind,
    status: tool.status,
    ...(tool.output ? { content: [{ type: "content", content: { type: "text", text: tool.output } }] } : {}),
  };
  emitUpdate(
    sessionId,
    phase === "update" ? { sessionUpdate: "tool_call_update", ...base } : { sessionUpdate: "tool_call", ...base },
  );
}

// ---------- prompt turn state machine (event-driven over the V4 stream) ----------

let turnInFlight = null;

class TurnError extends Error {}

/** Bounded pre-ACK staging, mirroring the official barrier's overflow guard. */
const MAX_PRE_ACK_STAGED_FRAMES = 1024;
const STREAM_IDLE_RESYNC_MS = Math.max(1_000, Math.min(5_000, Math.floor(config.requestTimeoutMs / 2)));

/**
 * One live conversation stream: subscription, wire assembly, projection.
 * Wires for the topic buffer until the subscription ack binds the id, so a
 * stale publisher cannot poison the projection; a fault or a seq gap flags
 * `needsResync` — recovery is always server-authoritative, never a local guess.
 */
class ConversationStream {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.topic = `conversation/${sessionId}`;
    this.assembler = new WireAssembler();
    this.projection = new ConversationProjection();
    this.subscriptionId = null;
    this.pendingWires = [];
    this.waiters = [];
    this.changedRows = [];
    this.needsResync = false;
    this.resyncInFlight = false;
    this.awaitingSnapshot = false;
    // Set by every forced recovery (resync or rebuild), cleared only by a
    // snapshot actually landing. A still-pending flag at the next idle tick
    // means the recovery route is silently dead: escalate to a subscription
    // rebuild instead of resyncing the same dead route again.
    this.forcedSnapshotPending = false;
    this.deferredFrames = [];
    this.detach = undefined;
    this.lastFrameAt = Date.now();
  }

  async attach(base) {
    this.detach = link.onConversationFrames(this.topic, (wire) => this.acceptWire(wire));
    const ack = await link.subscribeConversation(this.sessionId, base);
    this.subscriptionId = ack.subscriptionId;
    const buffered = this.pendingWires;
    this.pendingWires = [];
    for (const wire of buffered) this.acceptWire(wire);
    return ack;
  }

  acceptWire(wire) {
    if (this.subscriptionId !== null) {
      if (wire?.subscriptionId !== this.subscriptionId) return; // stale publisher generation
    } else {
      if (this.pendingWires.length >= MAX_PRE_ACK_STAGED_FRAMES) {
        this.pendingWires = [];
        this.needsResync = true; // never silently discard an ordered frame
        this.wake();
        return;
      }
      this.pendingWires.push(wire);
      return;
    }
    const outcome = this.assembler.accept(wire);
    if (outcome === null) return;
    if (outcome.fault !== undefined) {
      this.needsResync = true;
      this.wake();
      return;
    }
    this.acceptLogical(outcome.frame);
    this.lastFrameAt = Date.now();
    this.wake();
  }

  /** Snapshots re-anchor the watermark; deltas re-check contiguity after recovery. */
  acceptLogical(frame) {
    if (this.awaitingSnapshot && frame?.payload?.kind !== "snapshot") {
      if (this.deferredFrames.length >= 256) {
        this.deferredFrames = [];
        this.needsResync = true;
        return;
      }
      this.deferredFrames.push(frame);
      return;
    }
    const applied = this.projection.applyFrame(frame);
    if (applied.gap) {
      this.needsResync = true;
      return;
    }
    if (applied.replaced) {
      this.awaitingSnapshot = false;
      this.forcedSnapshotPending = false;
      const deferred = this.deferredFrames;
      this.deferredFrames = [];
      for (const deferredFrame of deferred) {
        const recheck = this.projection.applyFrame(deferredFrame);
        if (recheck.gap) this.needsResync = true;
        else for (const row of recheck.changedRows) this.changedRows.push(row);
      }
    }
    for (const row of applied.changedRows) this.changedRows.push(row);
  }

  wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  /** Resolves on the next frame batch or after the interval; carries no failure semantics. */
  waitNext(intervalMs) {
    if (this.changedRows.length > 0 || this.needsResync) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      }, intervalMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  drainChangedRows() {
    return this.changedRows.splice(0);
  }

  /** Resolves once the initial snapshot has replaced the projection. */
  async waitForSnapshot(budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (this.projection.seq === null) {
      if (this.needsResync || Date.now() >= deadline) {
        throw new LinkError("the desktop did not deliver an initial conversation snapshot");
      }
      await this.waitNext(Math.min(config.pollIntervalMs, 250));
    }
  }

  /**
   * Server-authoritative recovery, cheapest route first: one forced snapshot
   * onto the EXISTING subscription — a single RPC. Rebuilding the
   * subscription (and, if that fails too, re-pairing the controller and
   * subscribing read-only) is escalation-only: `escalate` skips straight to
   * the rebuild for a route whose forced snapshot already failed to land,
   * because resyncing a silently dead route again can never make progress. A
   * resync RPC that errors falls through to the same ladder. No route ever
   * re-sends the user command.
   */
  async recover(escalate = false) {
    if (this.resyncInFlight || this.subscriptionId === null) return;
    this.resyncInFlight = true;
    try {
      this.assembler.drop();
      this.needsResync = false;
      this.awaitingSnapshot = true;
      this.forcedSnapshotPending = true;
      if (escalate) {
        await this.refreshSnapshot().catch(() => this.reconnectSnapshot());
        return;
      }
      try {
        await link.resyncConversation(this.subscriptionId, true);
      } catch {
        try {
          await this.refreshSnapshot();
        } catch {
          // Some desktop builds stop answering conversation RPCs on an old
          // bridge while the native task itself keeps running. Drop only the
          // controller connection, pair again, and subscribe read-only to the
          // same task. The user command is deliberately not available here,
          // so recovery cannot dispatch it twice.
          await this.reconnectSnapshot();
        }
      }
    } finally {
      this.resyncInFlight = false;
    }
  }

  /** Replace a stale/unsupported resync route with a brand-new snapshot subscription. */
  async refreshSnapshot() {
    const previousSubscriptionId = this.subscriptionId;
    this.detach?.();
    this.detach = undefined;
    this.subscriptionId = null;
    this.assembler.drop();
    this.pendingWires = [];
    this.deferredFrames = [];
    this.awaitingSnapshot = true;
    this.needsResync = false;
    if (previousSubscriptionId !== null) {
      await link.unsubscribeConversation(previousSubscriptionId).catch(() => {
        /* a dead old route must not block creation of the replacement */
      });
    }
    await this.attach().catch((error) => {
      throw new TurnError(`refreshing the conversation snapshot failed (${error instanceof Error ? error.name : "unknown"}); the remote task state is unknown`);
    });
    this.lastFrameAt = Date.now();
  }

  /** Last-resort read-only recovery on a fresh controller connection. */
  async reconnectSnapshot() {
    const workspaceNorm = normalizeWorkspacePath(link.workspace.path);
    this.detach?.();
    this.detach = undefined;
    this.subscriptionId = null;
    this.assembler.drop();
    this.pendingWires = [];
    this.deferredFrames = [];
    this.awaitingSnapshot = true;
    this.needsResync = false;
    link.dispose();
    await link.ensure(workspaceNorm).catch((error) => {
      throw new TurnError(`reconnecting for the conversation snapshot failed (${error instanceof Error ? error.name : "unknown"}); the remote task state is unknown`);
    });
    await this.attach().catch((error) => {
      throw new TurnError(`re-subscribing after the controller reconnect failed (${error instanceof Error ? error.name : "unknown"}); the remote task state is unknown`);
    });
    this.lastFrameAt = Date.now();
  }

  /** Bridge-generation recovery: the old server subscription died with the bridge. */
  async resubscribe() {
    this.detach?.();
    this.detach = undefined;
    this.assembler.drop();
    this.awaitingSnapshot = false;
    // The fresh route supersedes any still-pending forced recovery: a resume
    // ack with deltas only is a legal outcome here, not a dead snapshot wait.
    this.forcedSnapshotPending = false;
    this.deferredFrames = [];
    this.pendingWires = [];
    this.subscriptionId = null;
    const base = this.projection.seq !== null && this.projection.logEpoch !== null
      ? { logEpoch: this.projection.logEpoch, seq: this.projection.seq }
      : undefined;
    await this.attach(base).catch((error) => {
      throw new TurnError(`re-subscribing the conversation after a bridge recovery failed (${error instanceof LinkError ? error.message : "unknown"}); the remote task state is unknown`);
    });
    // mode resume/snapshot stays the server's decision; both are applied wholesale.
  }

  async dispose() {
    this.detach?.();
    this.detach = undefined;
    if (this.subscriptionId !== null) {
      const subscriptionId = this.subscriptionId;
      this.subscriptionId = null;
      await link.unsubscribeConversation(subscriptionId).catch(() => {
        /* best-effort: the bridge teardown below ends the route anyway */
      });
    }
  }
}

/** An acknowledgement is not completion; only new-turn observations can end a prompt. */
async function runTurn(turn, binding, stream, baseline) {
  const { dshSessionId } = binding;
  turn.desktopSessionId = binding.desktopSessionId;
  const emittedText = new Map(
    [...baseline.emittedText].map(([rowId, text]) => [rowId, { text, revision: 0 }]),
  );
  const toolCards = new Map(baseline.toolCards);
  const deadline = Date.now() + config.turnTimeoutMs;
  // Tail settle: a real desktop can deliver the reply's final full-text row
  // just behind the terminal patch (observed live 2026-09-28: the turn ended
  // on the first terminal observation and the trailing row never streamed —
  // the DSH transcript held "CONT" while the desktop's own snapshot held the
  // full answer). Once THIS turn's live phase transition into a terminal
  // state is observed with assistant evidence, the turn ends only after the
  // projection holds still for `tailQuietMs` (every drained row restarts the
  // window) or `tailSettleCapMs` elapses. Never a resend, never unbounded:
  // a stream that never quiets is released at the cap with the best-effort
  // tail, and a turn whose budget expires after the terminal transition
  // still ends successfully — only the tail was cut, not the outcome.
  const tailQuietMs = Math.max(250, Math.min(config.pollIntervalMs, 1000));
  const tailSettleCapMs = Math.max(tailQuietMs + 250, Math.min(config.requestTimeoutMs, 5000));
  let newAssistant = false;
  let terminalTransitionAt; // first live non-terminal → terminal phase move of this turn
  let lastPhase = stream.projection.phase;
  let lastChangeAt = Date.now(); // last instant the live projection changed
  let cancelDeadline;
  let approvalVisible = false;
  let observedGeneration = link.frameGeneration;
  for (;;) {
    if (Date.now() >= (cancelDeadline ?? deadline)) {
      if (turn.cancelRequested) {
        throw new TurnError("the desktop stop could not be verified before the deadline; the remote task state is unknown");
      }
      if (terminalTransitionAt !== undefined && newAssistant) {
        return { stopReason: "end_turn" };
      }
      throw new TurnError("the turn deadline expired; the desktop task may still be running — check the Zcode desktop");
    }
    if (link.relayDead()) throw new TurnError("the relay link to the desktop was lost; the remote task state is unknown");
    if (link.frameGeneration !== observedGeneration) {
      // A bridge recovery invalidated the server-side subscription; resubscribe
      // the stream (never the command) and continue from the server's ruling.
      observedGeneration = link.frameGeneration;
      await stream.resubscribe();
      continue;
    }
    if (stream.needsResync) {
      await stream.recover();
      continue;
    }
    if (turn.cancelRequested && !turn.stopSettled) {
      cancelDeadline = Math.min(deadline, Date.now() + config.requestTimeoutMs);
      await settleStop(turn);
      if (!turn.stopAccepted) throw new TurnError("the desktop did not confirm the stop command; the remote task state is unknown");
    }
    await stream.waitNext(config.pollIntervalMs);
    const changedRows = stream.drainChangedRows();
    if (changedRows.length > 0) lastChangeAt = Date.now();
    for (const row of changedRows) {
      const text = rowText(row);
      if (text !== null) {
        const previous = emittedText.get(row.rowId);
        const embeddedAt = previous === undefined ? -1 : text.indexOf(previous.text);
        const extendsPrevious = previous === undefined || embeddedAt >= 0;
        const revision = extendsPrevious ? (previous?.revision ?? 0) : previous.revision + 1;
        const delta = previous === undefined
          ? text
          : embeddedAt >= 0
            ? text.slice(embeddedAt + previous.text.length)
            : previous.text.includes(text)
              ? ""
              : text;
        emittedText.set(row.rowId, { text, revision });
        if (delta.length > 0) {
          newAssistant = true;
          // V4 row.upserted is a structural replacement and may legally rewrite
          // already-streamed text. ACP cannot retract chunks, so start a new
          // message revision instead of failing the whole remote turn.
          const messageId = revision === 0 ? `v4row-${row.rowId}` : `v4row-${row.rowId}-revision-${revision}`;
          emitContentChunk(dshSessionId, "agent_message_chunk", delta, messageId);
        }
      }
      const tool = rowToolCard(row);
      if (tool !== null) {
        const signature = JSON.stringify(tool);
        const existed = toolCards.has(tool.toolCallId);
        if (existed && toolCards.get(tool.toolCallId) === signature) continue;
        toolCards.set(tool.toolCallId, signature);
        emitToolCall(dshSessionId, tool, existed ? "update" : "call");
      }
    }
    const awaitingApproval = stream.projection.pendingInteractions.length > 0;
    if (awaitingApproval !== approvalVisible) {
      emitToolCall(dshSessionId, {
        toolCallId: "zdesktop-approval",
        title: "Approval required in the Zcode desktop (this workbench cannot approve it)",
        kind: "other", status: awaitingApproval ? "in_progress" : "completed",
      }, approvalVisible ? "update" : "call");
      approvalVisible = awaitingApproval;
    }
    const phase = stream.projection.phase;
    if (phase !== lastPhase) {
      lastPhase = phase;
      lastChangeAt = Date.now();
      if (TERMINAL_PHASES.has(phase)) terminalTransitionAt = Date.now();
    }
    if (TERMINAL_PHASES.has(phase)) {
      if (phase === "completedSuccess") {
        // New user text alone is not completion: the phase can settle before
        // the assistant rows project. Wait for this turn's visible answer too.
        if (newAssistant) {
          if (terminalTransitionAt === undefined) {
            // The phase was already terminal before this turn's frames (a
            // continuation's baseline snapshot) and never moved: there is no
            // live terminal to settle behind, so keep the historical end.
            return { stopReason: "end_turn" };
          }
          // Tail settle (see tailQuietMs above): hold the subscription open
          // for the trailing full-text row until the projection quiets or the
          // cap elapses; every drained row restarts the quiet window.
          if (Date.now() - lastChangeAt >= tailQuietMs || Date.now() - terminalTransitionAt >= tailSettleCapMs) {
            return { stopReason: "end_turn" };
          }
        }
      } else if (turn.cancelRequested && turn.stopAccepted) {
        return { stopReason: "cancelled" };
      } else {
        const code = stream.projection.lastError?.code;
        throw new TurnError(`the desktop turn failed or was stopped outside this adapter${typeof code === "string" ? ` (${code})` : ""}; inspect the native task`);
      }
    }
    // Relay delivery is best-effort. A quiet subscription may have missed the
    // final state.updated frame even though the desktop already completed.
    // Ask the existing subscription for a server-authoritative force snapshot
    // first; a route whose forced snapshot never landed escalates to a
    // subscription rebuild (then a controller re-pair) at the next idle wake.
    // Neither path re-sends the user command, and silence alone is never
    // terminal evidence — only the recovered phase and this turn's rows are.
    if (Date.now() - stream.lastFrameAt >= STREAM_IDLE_RESYNC_MS) {
      stream.lastFrameAt = Date.now();
      stream.needsResync = true;
      await stream.recover(stream.forcedSnapshotPending);
    }
  }
}

/** Dispatches the verified `stop` conversation command once per cancel. */
async function settleStop(turn) {
  turn.stopSettled = true;
  if (typeof turn.desktopSessionId !== "string") {
    // Dispatch had not been acknowledged yet; nothing can be stopped remotely.
    turn.stopAccepted = false;
    return;
  }
  const commandId = randomUUID();
  try {
    const reply = await link.sendCommand({
      commandId,
      clientId: CLIENT_ID,
      sessionId: turn.desktopSessionId,
      type: "stop",
      payload: {},
      issuedAt: Date.now(),
    });
    const acknowledged = interpretCommandAck(reply, commandId);
    turn.stopAccepted = acknowledged !== undefined && COMMAND_ACK_OK_FOR_STOP.has(acknowledged.status);
  } catch {
    turn.stopAccepted = false;
  }
}

/**
 * Seeds the no-replay baseline from the live pre-dispatch snapshot: every
 * assistantText row's full text and every toolCall card already visible.
 */
function seedBaseline(projection) {
  const emittedText = new Map();
  const toolCards = new Map();
  for (const row of projection.rows.values()) {
    const text = rowText(row);
    if (text !== null) emittedText.set(row.rowId, text);
    const tool = rowToolCard(row);
    if (tool !== null) toolCards.set(tool.toolCallId, JSON.stringify(tool));
  }
  return { emittedText, toolCards };
}

// ---------- ACP prompt composition ----------

const HOST_INSTRUCTIONS_SENTINEL = HOST_INSTRUCTIONS_PREFIX;

/**
 * Composes the outgoing desktop text. DSH may prepend a host-instructions
 * block; its content is preserved verbatim as trailing context, but the real
 * user task is placed first so the desktop task title reflects the task, not
 * the internal instructions. No user text is ever dropped.
 */
function composePromptText(blocks) {
  const userParts = [];
  const hostParts = [];
  for (const block of blocks) {
    if (block.text.startsWith(HOST_INSTRUCTIONS_SENTINEL)) hostParts.push(block.text);
    else userParts.push(block.text);
  }
  if (hostParts.length === 0) return userParts.join("\n\n");
  if (userParts.length === 0) return hostParts.join("\n\n");
  return [...userParts, ...hostParts].join("\n\n");
}

function parsePromptBlocks(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw new RpcError(-32602, "session/prompt requires a non-empty prompt array");
  }
  const blocks = [];
  for (const block of prompt) {
    if (typeof block !== "object" || block === null || block.type !== "text" || typeof block.text !== "string") {
      throw new RpcError(
        -32602,
        `this desktop channel supports text content blocks only (received type: ${typeof block === "object" && block !== null ? String(block.type) : "invalid"})`,
      );
    }
    if (block.text.length === 0) continue;
    blocks.push({ text: block.text });
  }
  if (blocks.length === 0) {
    throw new RpcError(-32602, "session/prompt carried no non-empty text blocks");
  }
  return blocks;
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- ACP method handlers ----------

/**
 * The single advertised config option: a fixed model choice that follows the
 * desktop's own configuration. DSH's probe reads it to build its model
 * catalogue; switching it is a no-op here because the desktop owns the model.
 */
const MODEL_CONFIG_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    description: "Model selection follows the Zcode desktop configuration for this task.",
    type: "select",
    currentValue: "follow-desktop",
    options: [{ value: "follow-desktop", name: "跟随 Zcode 桌面配置" }],
  },
];

function handleInitialize() {
  return {
    protocolVersion: 1,
    agentInfo: { name: ADAPTER_NAME, version: VERSION },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false, acp: false },
      sessionCapabilities: { list: {} },
    },
  };
}

async function handleNewSession(params) {
  if (!SESSION_WORKSPACES) {
    const binding = newBinding(typeof params?.cwd === "string" ? params.cwd : undefined);
    return { sessionId: binding.dshSessionId, configOptions: MODEL_CONFIG_OPTIONS };
  }
  if (turnInFlight !== null) {
    // Discovery pairs a second controller, and the relay's single slot per
    // device means that kick would land on the connection streaming the live
    // turn. Refuse here: no connection, no binding, no guessed workspace list.
    throw new RpcError(ERR_BUSY, "a prompt turn is in flight; remote workspace discovery would contend for the site's single control connection — retry after the turn ends");
  }
  // One node, many workspaces: the site's own list is discovered read-only at
  // session creation, so the workbench (and the settings-page health probe)
  // verifies the site is reachable here. A failed discovery is an explicit
  // error that leaves no binding behind — the adapter never guesses or falls
  // back to a default workspace.
  const discovery = await discoverSiteCatch(() => discoverSite());
  const binding = newBinding(typeof params?.cwd === "string" ? params.cwd : undefined);
  return { sessionId: binding.dshSessionId, configOptions: sessionConfigOptions(discovery, null) };
}

/** Normalizes discovery failures into an explicit protocol error. */
async function discoverSiteCatch(run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RpcError) throw error;
    const reason = error instanceof LinkError ? error.message : `the site connection failed (${error instanceof Error ? scrub(error.message) : "unknown error"})`;
    throw new RpcError(ERR_LINK, `remote workspace discovery failed: ${reason}`);
  }
}

async function handleLoadSession(params) {
  const sessionId = params?.sessionId;
  const binding = readBinding(sessionId);
  if (binding === undefined) {
    throw new RpcError(ERR_SESSION_STATE, "session not found in this adapter's stateDir");
  }
  if (turnInFlight !== null) throw new RpcError(ERR_BUSY, "a prompt is in flight; history replay is unavailable");
  assertBindingScope(binding);
  if (SESSION_WORKSPACES && binding.desktopSessionId === null) {
    // Never dispatched: the live list is re-discovered read-only so the menu
    // reflects the site now; a vanished selection refuses instead of guessing.
    const discovery = await discoverSiteCatch(() => discoverSite());
    const currentPath = selectedPathOf(discovery, binding);
    writeBinding(binding);
    return { configOptions: sessionConfigOptions(discovery, currentPath) };
  }
  await link.ensure(SESSION_WORKSPACES ? binding.scope.workspace : undefined).catch((error) => {
    throw new RpcError(ERR_LINK, error instanceof LinkError ? error.message : "desktop link failed");
  });
  refreshBindingScope(binding);
  if (binding.desktopSessionId !== null && typeof binding.desktopSessionId === "string") {
    await registerDesktopTask(binding);
    const stream = new ConversationStream(binding.desktopSessionId);
    try {
      await stream.attach().catch((error) => {
        throw new RpcError(ERR_LINK, error instanceof LinkError ? error.message : "desktop conversation subscription failed");
      });
      await stream.waitForSnapshot(config.requestTimeoutMs).catch(() => {
        throw new RpcError(ERR_LINK, "desktop task state could not be read for replay (no initial conversation snapshot)");
      });
      // Row order is the rowId ascending tail window; replay real-user and
      // guided inputs only — engine-sourced rows are not conversation turns.
      for (const row of stream.projection.rows.values()) {
        if (row.kind === "assistantText" && typeof row.text === "string") {
          emitContentChunk(sessionId, "agent_message_chunk", scrubCredentials(row.text), `v4row-${row.rowId}`);
        } else if (row.kind === "userInput" && typeof row.text === "string" && (row.origin === "realUser" || row.guided === true)) {
          emitContentChunk(sessionId, "user_message_chunk", scrubCredentials(row.text), `v4row-${row.rowId}`);
        }
      }
    } finally {
      await stream.dispose();
    }
  }
  writeBinding(binding);
  if (!SESSION_WORKSPACES) return { configOptions: MODEL_CONFIG_OPTIONS };
  const discovery = link.siteDiscovery ?? discoveryFromBoot(undefined);
  return { configOptions: sessionConfigOptions(discovery, selectedPathOf(discovery, binding) ?? "") };
}

function handleSetConfigOption(params) {
  if (SESSION_WORKSPACES && params?.configId === "workspace") {
    return handleWorkspaceSelection(params);
  }
  if (params?.configId !== "model") {
    throw new RpcError(-32602, `this adapter exposes a single "model" config option (configId ${String(params?.configId)} is not configurable)`);
  }
  if (params?.value !== "follow-desktop") {
    throw new RpcError(-32602, 'the only supported model choice is "follow-desktop"; change the model in the Zcode desktop');
  }
  return { configOptions: MODEL_CONFIG_OPTIONS };
}

/**
 * Per-session workspace selection for the site node. The value must name one
 * workspace on the site's current list — re-discovered here so a stale menu
 * cannot select a workspace the site no longer serves. The choice is pinned
 * (normalized scope plus workspace identity) before anything can dispatch;
 * once a desktop task exists the binding is immutable.
 */
async function handleWorkspaceSelection(params) {
  if (typeof params?.sessionId !== "string" || typeof params?.value !== "string") {
    throw new RpcError(-32602, 'the "workspace" config option requires sessionId and value strings');
  }
  const binding = readBinding(params.sessionId);
  if (binding === undefined) {
    throw new RpcError(ERR_SESSION_STATE, "session not found in this adapter's stateDir");
  }
  if (turnInFlight !== null) throw new RpcError(ERR_BUSY, "a prompt turn is in flight; the workspace cannot change now");
  assertBindingScope(binding);
  if (binding.desktopSessionId !== null || binding.dispatch !== null) {
    throw new RpcError(ERR_SESSION_STATE, "the session already has a dispatched desktop task; its workspace cannot change");
  }
  const discovery = await discoverSiteCatch(() => discoverSite());
  const matches = discovery.entries.filter((entry) => normalizeWorkspacePath(entry.path) === normalizeWorkspacePath(params.value));
  if (matches.length !== 1) {
    throw new RpcError(ERR_SESSION_STATE, "the chosen workspace is not (uniquely) registered on the site; refresh the agent menu and pick from the current list");
  }
  const chosen = matches[0];
  binding.scope.workspace = normalizeWorkspacePath(chosen.path);
  binding.workspace = { path: chosen.path, identity: chosen.identity };
  writeBinding(binding);
  return { configOptions: sessionConfigOptions(discovery, chosen.path) };
}

function handleListSessions() {
  return {
    sessions: listScopedBindings().map((binding) => ({
      sessionId: binding.dshSessionId,
      cwd: typeof binding.cwd === "string"
        ? binding.cwd
        : SESSION_WORKSPACES
          ? (binding.workspace?.path ?? "")
          : config.workspace,
    })),
  };
}

async function handlePrompt(params) {
  const sessionId = params?.sessionId;
  const binding = readBinding(sessionId);
  if (binding === undefined) {
    throw new RpcError(ERR_SESSION_STATE, "session not found in this adapter's stateDir");
  }
  if (turnInFlight !== null) {
    throw new RpcError(ERR_BUSY, "another prompt turn is already in flight on this adapter");
  }
  assertBindingScope(binding);
  if (binding.dispatch !== null && binding.dispatch !== undefined) {
    throw new RpcError(
      ERR_SESSION_STATE,
      "the previous desktop command's outcome is unknown (adapter restart or lost ack); verify the task in the ZCode desktop before sending more prompts",
    );
  }
  if (binding.registration === "pending" || binding.registration === "unknown") {
    throw new RpcError(ERR_SESSION_STATE, "desktop task registration is unconfirmed; inspect the existing task before sending more prompts");
  }
  if (SESSION_WORKSPACES && binding.scope.workspace === null) {
    // The site node never dispatches without an explicit user selection —
    // no default workspace, no first-listed guess.
    throw new RpcError(ERR_SESSION_STATE, "no workspace is selected for this session; pick one from the agent menu's workspace option before sending a prompt");
  }
  // Claim the turn synchronously, before the first await, so a concurrent
  // prompt cannot slip between the check above and the dispatch below.
  const turn = { sessionId: binding.dshSessionId, desktopSessionId: undefined, cancelRequested: false, stopAccepted: false, stopSettled: false };
  turnInFlight = turn;
  try {
    return await dispatchPrompt(turn, binding, params);
  } finally {
    turnInFlight = null;
    // The official relay has one controller slot. Release it at the turn
    // boundary; subsequent input pairs afresh and retains the same task id.
    link.dispose();
  }
}

async function dispatchPrompt(turn, binding, params) {
  const blocks = parsePromptBlocks(params?.prompt);
  const promptText = composePromptText(blocks);
  await link.ensure(SESSION_WORKSPACES ? binding.scope.workspace : undefined).catch((error) => {
    throw new RpcError(ERR_LINK, error instanceof LinkError ? error.message : "desktop link failed");
  });
  await link.conversationEnsure().catch(() => {
    throw new RpcError(ERR_LINK, "the desktop conversation handshake failed");
  });
  refreshBindingScope(binding);

  if (turn.cancelRequested) return { stopReason: "cancelled" }; // No command has left this process.

  // Fresh baseline immediately before dispatch, so nothing already visible can
  // be replayed as new-turn output. The baseline comes from the live V4
  // subscription snapshot — the stale-prone zcode-task read is not consulted.
  const hasDesktopTask = typeof binding.desktopSessionId === "string" && binding.desktopSessionId.length > 0;
  const stream = new ConversationStream(hasDesktopTask ? binding.desktopSessionId : "");
  let baseline = { emittedText: new Map(), toolCards: new Map() };
  if (hasDesktopTask) {
    try {
      await stream.attach();
      await stream.waitForSnapshot(config.requestTimeoutMs);
    } catch (error) {
      await stream.dispose();
      throw new RpcError(ERR_LINK, `the desktop task state could not be read before dispatch; prompt refused (${error instanceof Error ? scrub(error.message) : "unknown error"})`);
    }
    const phase = stream.projection.phase;
    const interactions = stream.projection.pendingInteractions.length;
    if (!TERMINAL_PHASES.has(phase) || interactions > 0) {
      await stream.dispose();
      throw new RpcError(ERR_BUSY, "the desktop task is still running or awaiting input; finish or stop it before starting another turn");
    }
    baseline = seedBaseline(stream.projection);
    stream.changedRows = []; // discard only pre-dispatch history, never new-turn frames
  }

  if (turn.cancelRequested) return { stopReason: "cancelled" };

  const kind = hasDesktopTask ? "sendText" : "createSession";
  const commandId = randomUUID();
  binding.dispatch = { commandId, kind, issuedAt: Date.now() };
  writeBinding(binding); // recorded BEFORE the envelope leaves this process
  const envelope = {
    commandId,
    clientId: CLIENT_ID,
    sessionId: hasDesktopTask ? binding.desktopSessionId : null,
    type: kind,
    payload:
      kind === "createSession"
        ? { workspaceId: link.workspace.identity ?? link.workspace.path, firstInput: { text: promptText } }
        : { text: promptText, requestedDelivery: "startNow" },
    issuedAt: Date.now(),
  };
  let reply;
  try {
    reply = await link.sendCommand(envelope);
  } catch {
    // The dispatch record intentionally stays: the outcome is unknown.
    await stream.dispose();
    throw new RpcError(
      ERR_TURN,
      "the desktop did not acknowledge the command and its outcome is unknown; check the task in the Zcode desktop before retrying",
    );
  }
  const acknowledged = interpretCommandAck(reply, commandId);
  if (acknowledged === undefined) {
    await stream.dispose();
    throw new RpcError(ERR_TURN, "the desktop returned an unrecognized acknowledgement; the command outcome is unknown");
  }
  const { ack, status, detail } = acknowledged;
  if (status === "rejected" || status === "stale") {
    // Proven not-applied resolutions: a guard refused the command, or the CAS
    // revision moved under it. The desktop never received this input, so the
    // ledger clears and a fresh dispatch may retry under a new command id.
    binding.dispatch = null;
    writeBinding(binding);
    await stream.dispose();
    throw new RpcError(ERR_TURN, `the desktop refused the ${kind} command (${detail})`);
  }
  if (status === "noop") {
    // A recognized no-op is neither delivery nor an unknown outcome: the
    // desktop resolved the command without applying it now. Keep the ledger
    // blocking until a human verifies the task.
    await stream.dispose();
    throw new RpcError(ERR_TURN, `the desktop resolved the ${kind} command as noop, not applied (${detail}); verify the task in the Zcode desktop before retrying`);
  }
  if (status !== "accepted" && status !== "duplicate") {
    // "failed" resolves the command but does not prove whether the input was
    // applied — fail closed with the ledger intact.
    await stream.dispose();
    throw new RpcError(ERR_TURN, `the desktop failed the ${kind} command (${detail}); the outcome is unknown — verify the task in the Zcode desktop`);
  }
  const ackSessionId = typeof ack?.result?.sessionId === "string" ? ack.result.sessionId : undefined;
  if (kind === "createSession") {
    if (!ackSessionId) {
      await stream.dispose();
      throw new RpcError(ERR_TURN, "the desktop accepted createSession without returning a session id; inspect it before retrying");
    }
    binding.desktopSessionId = ackSessionId;
    stream.sessionId = ackSessionId;
    stream.topic = `conversation/${ackSessionId}`;
    try {
      await stream.attach();
    } catch (error) {
      throw new RpcError(ERR_LINK, `the new desktop task could not be subscribed (${error instanceof Error ? scrub(error.message) : "unknown error"}); the command outcome is unknown`);
    }
  }
  if (kind === "sendText" && ackSessionId !== undefined && ackSessionId !== binding.desktopSessionId) {
    await stream.dispose();
    throw new RpcError(ERR_TURN, "the desktop acknowledgement named another task; command outcome is unknown");
  }
  binding.dispatch = null; // one atomic write records the id and clears the ledger
  writeBinding(binding);
  try {
    await registerDesktopTask(binding);
  } catch (error) {
    await stream.dispose();
    throw error;
  }
  try {
    return await runTurn(turn, binding, stream, baseline);
  } finally {
    await stream.dispose();
  }
}

/** Client→agent notification; only session/cancel is meaningful here. */
async function handleNotification(method, params) {
  if (method !== "session/cancel") return;
  const turn = turnInFlight;
  if (turn === null || params?.sessionId !== turn.sessionId) return;
  if (turn.cancelRequested) return;
  turn.cancelRequested = true; // the poll loop performs the bounded stop handshake
}

// ---------- --health: one read-only probe, fixed-string output only ----------

if (healthMode) {
  try {
    const discovery = await discoverSite();
    let report = `${siteName}: online, desktop ${discovery.appVersion}, ${discovery.entries.length} registered workspace(s)`;
    if (!SESSION_WORKSPACES) {
      pickFromEntries(discovery.entries, WORKSPACE_NORM);
      report += ", configured workspace registered";
    } else {
      report += ", workspace selection per session";
    }
    process.stdout.write(`[${ADAPTER_NAME}] health: ${report}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`[${ADAPTER_NAME}] health: ${siteName} is offline or unreachable (${error instanceof LinkError ? error.message : error instanceof Error ? error.name : "unknown"})\n`);
    process.exitCode = 1;
  }
  // Exit on a later tick: exiting synchronously while the module graph is
  // still unwinding a caught top-level exception trips libuv's Windows
  // async-handle teardown assertion.
  setImmediate(() => process.exit(process.exitCode ?? 1));
}

// ---------- --list-tasks: one read-only desktop task-index listing ----------

/** Upper bound on tasks one listing reports; the workbench asks per workspace. */
const LIST_TASKS_ROW_CAP = 200;
/** Title cap per row, applied after credential/URL scrubbing. */
const LIST_TASKS_TITLE_CAP = 200;

/**
 * Projects desktop `ZCodeTaskMeta` rows into the fixed wire subset. Rows are
 * validated (process boundary); unusable rows are skipped, never guessed.
 * A task whose desktop id names a binding in this adapter's stateDir is marked
 * `workbench` with the DSH-side session id so the workbench can join the two
 * lists; everything else is `desktop`-origin.
 */
function projectDesktopTasks(metas, ownership) {
  if (!Array.isArray(metas)) return [];
  const rows = [];
  for (const meta of metas) {
    if (typeof meta !== "object" || meta === null) continue;
    const taskId = typeof meta.taskId === "string" ? meta.taskId : "";
    if (taskId.length === 0) continue;
    const owned = ownership.get(taskId);
    const created = typeof meta.createdAt === "number" && Number.isFinite(meta.createdAt)
      ? new Date(meta.createdAt).toISOString()
      : "";
    const updated = typeof meta.updatedAt === "number" && Number.isFinite(meta.updatedAt)
      ? new Date(meta.updatedAt).toISOString()
      : "";
    rows.push({
      taskId,
      title: typeof meta.title === "string" && meta.title.length > 0
        ? scrub(meta.title).slice(0, LIST_TASKS_TITLE_CAP)
        : "",
      status: meta.status === "running" || meta.status === "completed" || meta.status === "error"
        ? meta.status
        : "unknown",
      createdAt: created,
      updatedAt: updated,
      origin: owned === undefined ? "desktop" : "workbench",
      ...(owned !== undefined ? { dshSessionId: owned } : {}),
    });
    if (rows.length >= LIST_TASKS_ROW_CAP) break;
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return rows;
}

/**
 * Desktop ids this adapter owns for one workspace: bindings on the current
 * connection identity whose selected (or configured) workspace is the listed
 * one, keyed by desktop session id.
 */
function desktopTaskOwnership(targetNorm) {
  const ownership = new Map();
  for (const binding of listScopedBindings()) {
    if (typeof binding.desktopSessionId !== "string" || binding.desktopSessionId.length === 0) continue;
    const scopeWorkspace = SESSION_WORKSPACES ? binding.scope.workspace : WORKSPACE_NORM;
    if (scopeWorkspace !== targetNorm) continue;
    ownership.set(binding.desktopSessionId, binding.dshSessionId);
  }
  return ownership;
}

if (listTasksMode) {
  try {
    const params = readConnection();
    // One controller pairing for the whole read-only listing, like discovery.
    await acquireController();
    const client = new RemoteClientCtor(params, { requestTimeoutMs: config.requestTimeoutMs });
    let report;
    try {
      await client.connect({ pairingTimeoutMs: Math.max(60_000, config.requestTimeoutMs * 2) });
      const boot = await client.bootstrap();
      const discovery = discoveryFromBoot(boot);
      if (discovery.entries.length === 0) throw new LinkError("the site registered no workspaces");
      const target = pickFromEntries(discovery.entries, SESSION_WORKSPACES ? normalizeWorkspacePath(listTasksWorkspace) : WORKSPACE_NORM);
      const bridge = await client.openBridge(target.identity ?? target.path);
      const metas = await bridge.call("zcode-task", "listTasks", [{
        workspacePath: target.path,
        ...(target.identity !== null ? { workspaceIdentity: target.identity } : {}),
      }]);
      report = {
        desktopVersion: discovery.appVersion,
        tasks: projectDesktopTasks(metas, desktopTaskOwnership(normalizeWorkspacePath(target.path))),
      };
    } finally {
      try {
        client.dispose();
      } catch {
        /* teardown must stay silent and fixed-string */
      }
      releaseController();
    }
    process.stdout.write(`[${ADAPTER_NAME}] tasks: ${JSON.stringify(report)}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`[${ADAPTER_NAME}] tasks: ${siteName} task listing failed (${error instanceof LinkError ? error.message : error instanceof Error ? scrub(error.message) : "unknown"})\n`);
    process.exitCode = 1;
  }
  // Same deferred exit as --health: never unwind the module graph synchronously.
  setImmediate(() => process.exit(process.exitCode ?? 1));
}

// ---------- --task-snapshot: one read-only conversation snapshot ----------

/** Upper bound on summary entries one snapshot reports. */
const TASK_SNAPSHOT_ROW_CAP = 200;
/** Per-entry text cap, applied after credential/URL scrubbing. */
const TASK_SNAPSHOT_TEXT_CAP = 16_384;
/** Tool-title cap per entry, applied after scrubbing. */
const TASK_SNAPSHOT_TITLE_CAP = 200;

/**
 * Scrub first, cap second: a secret straddling the cap boundary is redacted
 * whole, never truncated into a leaking fragment. When the cap then lands
 * inside a replacement marker, the dangling partial marker is trimmed rather
 * than shown half-written.
 */
function scrubCapped(text) {
  const scrubbed = scrub(text);
  if (scrubbed.length <= TASK_SNAPSHOT_TEXT_CAP) return scrubbed;
  return scrubbed.slice(0, TASK_SNAPSHOT_TEXT_CAP).replace(/\[[^\[\]]{0,9}$/, "");
}

/** The task-snapshot report's fixed marker prefix on stdout (one JSON line). */
const TASK_SNAPSHOT_LINE_MARKER = "] task-snapshot: ";

/**
 * Projects one live conversation projection into a bounded, ordered, scrubbed
 * summary for the workbench's native-task detail. Rows project in row order:
 * user and assistant text rows carry their (scrubbed, capped) text, tool rows
 * carry the compact card facts, and `reasoning` rows or unknown kinds are
 * never projected — nothing is guessed at. User rows count only when the
 * desktop itself marks them user-authored (`origin: realUser` or `guided`) —
 * engine-sourced input rows are not conversation turns. Text is scrubbed
 * BEFORE capping so a secret straddling the cap boundary is redacted whole,
 * never truncated into a leaking fragment. When more than the row cap is
 * projectable, the NEWEST rows are kept — a task detail's value is the
 * recent conversation, and the latest answer must never fall off — while the
 * display order stays ascending by rowId. `truncated` reports whether the cap
 * cut the summary short (the caller must then flag partial).
 */
function projectConversationSummary(projection) {
  const ordered = [...projection.rows.values()].sort((a, b) => a.rowId - b.rowId);
  const entries = [];
  for (const row of ordered) {
    if (row.kind === "userInput" && typeof row.text === "string" && (row.origin === "realUser" || row.guided === true)) {
      entries.push({ kind: "user", rowId: row.rowId, text: scrubCapped(row.text) });
      continue;
    }
    if (row.kind === "assistantText" && typeof row.text === "string") {
      entries.push({ kind: "assistant", rowId: row.rowId, text: scrubCapped(row.text) });
      continue;
    }
    if (row.kind === "toolCall" && typeof row.toolCallId === "string" && row.toolCallId.length > 0) {
      entries.push({
        kind: "tool",
        rowId: row.rowId,
        toolCallId: row.toolCallId,
        title: typeof row.toolName === "string" && row.toolName.length > 0
          ? scrub(row.toolName).slice(0, TASK_SNAPSHOT_TITLE_CAP)
          : "tool",
        status: TOOL_ROW_STATUS_TO_ACP[row.status] ?? "pending",
      });
    }
  }
  const truncated = entries.length > TASK_SNAPSHOT_ROW_CAP;
  return {
    summary: truncated ? entries.slice(entries.length - TASK_SNAPSHOT_ROW_CAP) : entries,
    truncated,
  };
}

/**
 * Runs one read-only snapshot pass over an existing desktop task and returns
 * its report object. Identity is verified first — the full task id must be
 * visible in the bridged workspace's own synced index — and the conversation
 * is then read through the official subscription path (hello, initialize,
 * subscribe, snapshot, unsubscribe). The pass never adopts a binding, never
 * creates a session or task, and never sends a conversation command; every
 * refusal is a machine-stable `reason` with no state change.
 * @returns {Promise<object>} the report; the caller prints it as one stdout line.
 */
async function runTaskSnapshot() {
  const targetNorm = SESSION_WORKSPACES ? normalizeWorkspacePath(snapshotWorkspace) : WORKSPACE_NORM;
  const report = {
    taskId: snapshotTaskId,
    phase: null,
    pendingInteractions: null,
    // A tail window never masquerades as full history: partial stays true
    // unless the snapshot's own totalCount proves the window covers every row.
    partial: true,
    rowCount: null,
    sampledAt: new Date().toISOString(),
    summary: null,
    reason: null,
  };
  const refuse = (reason) => ({ ...report, reason });

  let metas;
  try {
    await link.ensure(SESSION_WORKSPACES ? targetNorm : undefined);
    metas = await link.bridge.call("zcode-task", "listTasks", [link.workspaceTarget()]);
  } catch {
    return refuse("index-unreadable");
  }
  const meta = Array.isArray(metas)
    ? metas.find((entry) => typeof entry === "object" && entry !== null && entry.taskId === snapshotTaskId)
    : undefined;
  if (meta === undefined) return refuse("task-missing");

  const stream = new ConversationStream(snapshotTaskId);
  try {
    try {
      await stream.attach();
      await stream.waitForSnapshot(config.requestTimeoutMs);
    } catch {
      return refuse("snapshot-unreadable");
    }
    const projection = stream.projection;
    const projected = projectConversationSummary(projection);
    return {
      ...report,
      phase: projection.phase,
      pendingInteractions: projection.pendingInteractions.length,
      // Partial when the window cannot prove completeness OR the summary cap
      // cut it short: a capped summary is recent-only content by definition.
      partial: projection.totalRowCount === null
        || projection.rows.size < projection.totalRowCount
        || projected.truncated,
      rowCount: projection.rows.size,
      summary: projected.summary,
    };
  } finally {
    await stream.dispose();
  }
}

if (taskSnapshotMode) {
  // One-shot CLI semantics: the stream's inner waits use unref'd timers by
  // design, and the caller may close stdin — nothing else would hold the
  // event loop. One REFERENCED hard deadline bounds the whole pass and
  // guarantees exactly one report line on every path: success, refusal, or
  // the deadline itself (snapshot-unreadable), even if an inner await never
  // settles. The mode is therefore self-sufficient under a closed stdin.
  const deadlineMs = Math.max(30_000, config.requestTimeoutMs * 2 + 5_000);
  let settleDeadline = () => {};
  const deadline = new Promise((resolve) => {
    // Referenced on purpose (no .unref()): this timer keeps the loop alive
    // for the bounded read and is cleared on every settling path below.
    const timer = setTimeout(() => resolve({ taskId: snapshotTaskId, reason: "snapshot-unreadable", hardDeadline: true }), deadlineMs);
    settleDeadline = () => clearTimeout(timer);
  });
  let report;
  try {
    report = await Promise.race([runTaskSnapshot(), deadline]);
    if (report?.hardDeadline === true) {
      delete report.hardDeadline;
      process.stderr.write(`[${ADAPTER_NAME}] task-snapshot: the read did not settle within ${deadlineMs}ms\n`);
    }
  } catch (error) {
    // An internal defect is never a desktop verdict; nothing was read that
    // could be reported, and the fixed-string reason says so.
    report = { taskId: snapshotTaskId, reason: "internal-error" };
    process.stderr.write(`[${ADAPTER_NAME}] task-snapshot: failed (${error instanceof Error ? error.name : "unknown"})\n`);
  }
  settleDeadline();
  link.dispose();
  process.stdout.write(`[${ADAPTER_NAME}] task-snapshot: ${JSON.stringify(report)}\n`);
  if (report.reason !== null) {
    process.stderr.write(`[${ADAPTER_NAME}] task-snapshot: unavailable (${report.reason})\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
  // Same deferred exit as --health: never unwind the module graph synchronously.
  setImmediate(() => process.exit(process.exitCode ?? 1));
}

// ---------- --reconcile-dispatch: verify-then-release one unresolved dispatch ----------
//
// An unresolved `binding.dispatch` entry blocks all further prompts on that
// binding until a human checks the desktop — but the desktop protocol cannot
// prove non-application after the fact: the command id never reappears in the
// conversation snapshot, and the snapshot is a row tail window. This mode
// therefore gathers every read-only fact the desktop does expose (task-index
// row, live conversation phase, pending interactions, and whether the old
// follow-up text appears as a user turn) and refuses on any signal of
// application or unreadable evidence. The ledger is cleared only when an
// operator explicitly attests `--confirm human-verified`; the attestation, not
// the protocol, carries the residual uncertainty (tail-window truncation,
// post-dispatch task timestamps). It never re-sends the old command, never
// creates a desktop task, and never touches a binding whose dispatch already
// settled; each write-off is one append-only `reconcile-ledger.jsonl` entry.

/** One-shot stdin budget for the expected-prompt JSON line (local I/O constant). */
const RECONCILE_STDIN_BUDGET_MS = 5000;
/** Mirrors the workbench prompt bound; longer stdin lines are not accepted. */
const RECONCILE_PROMPT_CAP = 20_000;
/** Inbound stdin cap before the reader gives up parsing more lines. */
const RECONCILE_STDIN_CHAR_CAP = RECONCILE_PROMPT_CAP * 2 + 1024;

/** The reconcile report's fixed marker prefix on stdout (one JSON line). */
const RECONCILE_LINE_MARKER = "] reconcile: ";

/**
 * Reads the expected prompt text from stdin: one JSON line
 * `{"expectedPromptText":"..."}`. Resolves on the first valid line, on stdin
 * end, or after the local budget — null when no valid line arrived. The text
 * never touches argv, stdout, or any persisted file.
 * @returns {Promise<string | null>} the expected prompt text, or null.
 */
function readExpectedPromptText() {
  return new Promise((resolve) => {
    let buffer = "";
    let text = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", finish);
      resolve(text);
    };
    const scan = () => {
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.expectedPromptText === "string" &&
              parsed.expectedPromptText.length > 0 && parsed.expectedPromptText.length <= RECONCILE_PROMPT_CAP) {
            text = parsed.expectedPromptText;
            finish();
            return;
          }
        } catch {
          /* not a JSON line: skip it */
        }
      }
    };
    const onData = (chunk) => {
      buffer += chunk;
      if (buffer.length > RECONCILE_STDIN_CHAR_CAP) {
        scan();
        finish();
        return;
      }
      scan();
    };
    const timer = setTimeout(finish, RECONCILE_STDIN_BUDGET_MS);
    timer.unref?.();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", finish);
    process.stdin.resume();
  });
}

/** Collapses all whitespace so desktop-side re-wrapping cannot hide a match. */
function normalizePromptText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * Whether one conversation user row is the expected prompt text: equal after
 * whitespace normalization, or containment in either direction guarded by a
 * minimum length (short legacy user rows must not noise-match a long
 * instruction). A false match refuses the write-off — the safe direction; an
 * applied prompt appears verbatim in its user row, so exact equality cannot
 * miss it.
 */
function promptTextMatches(rowText, expected) {
  const row = normalizePromptText(rowText);
  const want = normalizePromptText(expected);
  if (row.length === 0 || want.length === 0) return false;
  if (row === want) return true;
  if (want.length >= 16 && row.includes(want)) return true;
  if (row.length >= 16 && want.includes(row)) return true;
  return false;
}

/** Append-only write-off audit trail; one JSON object per line. */
function reconcileLedgerPath() {
  return path.join(config.stateDir, "reconcile-ledger.jsonl");
}

function readReconcileLedger() {
  let raw;
  try {
    raw = readFileSync(reconcileLedgerPath(), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || parsed.v !== 1 || parsed.kind !== "reconcile-dispatch") {
        throw new Error("invalid reconcile ledger entry");
      }
      entries.push(parsed);
    } catch {
      // A damaged audit trail is not an empty one. Never release a lock if
      // duplicate write-offs cannot be checked reliably.
      throw new Error("reconcile ledger is malformed");
    }
  }
  return entries;
}

/** The prior write-off of one desktop task, when the ledger holds one. */
function reconcileLedgerEntryFor(taskId, dshSessionId) {
  return readReconcileLedger().find((entry) => entry.taskId === taskId && entry.dshSessionId === dshSessionId);
}

/**
 * The in-scope binding that owns one desktop task within one workspace. The
 * workspace filter mirrors `session/adopt`: in session mode a binding of
 * another workspace never matches, so a task cannot be reconciled from the
 * wrong workspace's node.
 */
function findScopedBindingByDesktopTask(taskId, targetNorm) {
  for (const binding of listScopedBindings()) {
    if (binding.desktopSessionId !== taskId) continue;
    const scopeWorkspace = SESSION_WORKSPACES ? binding.scope.workspace : WORKSPACE_NORM;
    if (scopeWorkspace !== targetNorm) continue;
    return binding;
  }
  return undefined;
}

/**
 * Runs one reconcile pass and returns its report object. Every refusal is a
 * report with a machine-stable `reason` and no state change; the only state
 * changes are the confirm-mode ledger append plus the binding dispatch clear.
 * @returns {Promise<object>} the report; callers print it as one stdout line.
 */
async function runReconcileDispatch() {
  const targetNorm = SESSION_WORKSPACES ? normalizeWorkspacePath(reconcileWorkspace) : WORKSPACE_NORM;
  const report = {
    taskId: reconcileTaskId,
    dshSessionId: null,
    commandId: null,
    commandKind: null,
    issuedAt: null,
    taskStatus: null,
    taskUpdatedAt: null,
    taskUpdatedAfterIssued: null,
    phase: null,
    pendingInteractions: null,
    userTurnCount: null,
    promptMatched: null,
    expectedPromptProvided: false,
    writtenOff: false,
    alreadyReconciled: false,
    reconciledAt: new Date().toISOString(),
    reason: null,
  };
  const refuse = (reason) => ({ ...report, reason });

  const binding = findScopedBindingByDesktopTask(reconcileTaskId, targetNorm);
  if (binding === undefined) return refuse("binding-not-found");
  report.dshSessionId = binding.dshSessionId;
  const dispatch = binding.dispatch;
  if (dispatch === null || dispatch === undefined) {
    const prior = reconcileLedgerEntryFor(reconcileTaskId, binding.dshSessionId);
    if (prior !== undefined) {
      // Idempotent completion evidence for a caller finishing a torn write-off:
      // reports the completed state, appends nothing, changes nothing.
      return {
        ...report,
        commandId: typeof prior.commandId === "string" ? prior.commandId : null,
        commandKind: typeof prior.commandKind === "string" ? prior.commandKind : null,
        issuedAt: typeof prior.issuedAt === "number" ? prior.issuedAt : null,
        alreadyReconciled: true,
        writtenOff: true,
      };
    }
    return refuse("nothing-to-reconcile");
  }
  report.commandId = typeof dispatch.commandId === "string" ? dispatch.commandId : null;
  report.commandKind = typeof dispatch.kind === "string" ? dispatch.kind : null;
  report.issuedAt = typeof dispatch.issuedAt === "number" ? dispatch.issuedAt : null;

  const expected = await readExpectedPromptText();
  report.expectedPromptProvided = expected !== null;

  try {
    await link.ensure(SESSION_WORKSPACES ? targetNorm : undefined);
    await link.conversationEnsure();
  } catch (error) {
    return refuse(error instanceof LinkError ? "link-failed" : "evidence-unreadable");
  }
  let metas;
  try {
    metas = await link.bridge.call("zcode-task", "listTasks", [link.workspaceTarget()]);
  } catch {
    return refuse("index-unreadable");
  }
  const meta = Array.isArray(metas)
    ? metas.find((entry) => typeof entry === "object" && entry !== null && entry.taskId === reconcileTaskId)
    : undefined;
  if (meta === undefined) return refuse("task-missing");
  report.taskStatus = typeof meta.status === "string" ? meta.status : null;
  report.taskUpdatedAt = typeof meta.updatedAt === "number" && Number.isFinite(meta.updatedAt)
    ? new Date(meta.updatedAt).toISOString()
    : null;
  report.taskUpdatedAfterIssued = report.taskUpdatedAt !== null && report.issuedAt !== null
    ? meta.updatedAt > report.issuedAt
    : null;
  if (meta.status === "running") return refuse("task-running");
  if (meta.status !== "completed" && meta.status !== "error") return refuse("task-status-unknown");

  const stream = new ConversationStream(reconcileTaskId);
  try {
    try {
      await stream.attach();
      await stream.waitForSnapshot(config.requestTimeoutMs);
    } catch {
      return refuse("snapshot-unreadable");
    }
    report.phase = stream.projection.phase;
    report.pendingInteractions = stream.projection.pendingInteractions.length;
    if (!TERMINAL_PHASES.has(stream.projection.phase)) return refuse("phase-not-terminal");
    if (stream.projection.pendingInteractions.length > 0) return refuse("awaiting-input");
    let userTurnCount = 0;
    let matched = false;
    for (const row of stream.projection.rows.values()) {
      if (row.kind !== "userInput" || typeof row.text !== "string") continue;
      userTurnCount += 1;
      if (expected !== null && promptTextMatches(row.text, expected)) matched = true;
    }
    report.userTurnCount = userTurnCount;
    report.promptMatched = expected !== null ? matched : null;
    if (matched) return refuse("prompt-matched");
    if (reconcileConfirm) {
      if (expected === null) return refuse("expected-prompt-missing");
      if (readReconcileLedger().some((entry) => entry.commandId === report.commandId && entry.taskId === reconcileTaskId)) {
        // A torn write-off: the audit entry exists but the binding write never
        // landed, so the ledger and the lock disagree. Refusing names the
        // conflict instead of writing a second entry over a locked binding.
        return refuse("ledger-conflict");
      }
      const entry = {
        v: 1,
        kind: "reconcile-dispatch",
        taskId: reconcileTaskId,
        dshSessionId: binding.dshSessionId,
        commandId: report.commandId,
        commandKind: report.commandKind,
        issuedAt: report.issuedAt,
        evidence: {
          taskStatus: report.taskStatus,
          taskUpdatedAt: report.taskUpdatedAt,
          phase: report.phase,
          pendingInteractions: report.pendingInteractions,
          promptMatched: false,
          userTurnCount: report.userTurnCount,
        },
        mode: "human-verified",
        operatorSource: reconcileOperator ?? "cli",
        at: new Date().toISOString(),
      };
      try {
        appendFileSync(reconcileLedgerPath(), `${JSON.stringify(entry)}\n`);
      } catch {
        return refuse("ledger-write-failed");
      }
      // The audit entry exists before the lock clears; a failure here leaves
      // the ledger written but the binding locked, and the next confirm run
      // refuses on the command-id duplicate instead of writing twice.
      binding.dispatch = null;
      writeBinding(binding);
      return { ...report, writtenOff: true };
    }
    return { ...report };
  } finally {
    await stream.dispose();
  }
}

if (reconcileMode) {
  let report;
  try {
    report = await runReconcileDispatch();
  } catch (error) {
    // A throw here is an internal defect, never a desktop verdict; nothing was
    // written and the fixed-string reason says so.
    report = { reason: "internal-error" };
    process.stderr.write(`[${ADAPTER_NAME}] reconcile: failed (${error instanceof Error ? error.name : "unknown"})\n`);
  }
  link.dispose();
  process.stdout.write(`[${ADAPTER_NAME}] reconcile: ${JSON.stringify(report)}\n`);
  if (report.reason !== null) {
    process.stderr.write(`[${ADAPTER_NAME}] reconcile: refused (${report.reason}); nothing was written off\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
  // Same deferred exit as --health: never unwind the module graph synchronously.
  setImmediate(() => process.exit(process.exitCode ?? 1));
}

// ---------- stdin JSON-RPC pump ----------

let stdinOpen = true;
let stdinBuffer = "";
let shuttingDown = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newlineIdx;
  while ((newlineIdx = stdinBuffer.indexOf("\n")) !== -1) {
    const line = stdinBuffer.slice(0, newlineIdx).trim();
    stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
    if (line.length === 0) continue;
    if (line.length > MAX_LINE_CHARS) {
      fail(7, "inbound JSON-RPC frame exceeds the size limit");
    }
    void dispatchLine(line);
  }
  if (stdinBuffer.length > MAX_LINE_CHARS) {
    fail(7, "inbound JSON-RPC frame exceeds the size limit");
  }
});
process.stdin.on("end", shutdown);
process.stdin.on("error", shutdown);
process.stdin.resume();

async function dispatchLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0") return;
  if (message.method === undefined) return; // client→agent has no response messages
  const { method, params } = message;
  if (message.id === undefined || message.id === null) {
    try {
      await handleNotification(method, params);
    } catch {
      /* notification failures are unreportable; stay silent */
    }
    return;
  }
  const id = message.id;
  try {
    const result = await dispatchRequest(method, params);
    replyResult(id, result);
  } catch (error) {
    if (error instanceof RpcError) {
      replyError(id, error.code, error.message);
      return;
    }
    if (error instanceof LinkError) {
      replyError(id, ERR_LINK, error.message);
      return;
    }
    if (error instanceof TurnError) {
      replyError(id, ERR_TURN, error.message);
      return;
    }
    replyError(id, -32603, `internal error (${error instanceof Error ? error.name : "unknown"})`);
  }
}

async function dispatchRequest(method, params) {
  switch (method) {
    case "initialize":
      return handleInitialize(params);
    case "session/new":
      return handleNewSession(params);
    case "session/load":
      try {
        return await handleLoadSession(params);
      } finally {
        if (turnInFlight === null) link.dispose();
      }
    case "session/adopt":
      try {
        return await handleAdoptSession(params);
      } finally {
        if (turnInFlight === null) link.dispose();
      }
    case "session/list":
      return handleListSessions();
    case "session/prompt":
      return await handlePrompt(params);
    case "session/set_config_option":
      return handleSetConfigOption(params);
    default:
      throw new RpcError(-32601, `method not supported by ${ADAPTER_NAME}: ${method}`);
  }
}

// ---------- shutdown: disconnect only, never re-dispatch ----------

function shutdown() {
  stdinOpen = false;
  if (shuttingDown) return;
  shuttingDown = true;
  link.dispose();
  // A turn still in flight is abandoned with the connection; the binding
  // keeps the desktop session id so a restarted adapter can session/load it.
  // --health defers to its own verdict when it already set an exit code.
  process.exit(process.exitCode ?? 0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
