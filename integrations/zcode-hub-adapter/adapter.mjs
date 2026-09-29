#!/usr/bin/env node
// stdio(ndJson JSON-RPC) ↔ WebSocket(frame-per-message) ACP transport adapter.
//
// Purpose: let a remote (or loopback) zcode-acp hub enter a dsh-acp-adapter
// workbench as an ordinary local stdio agent node. The adapter is pure
// passthrough: it never parses or rewrites JSON-RPC payloads, so requests,
// notifications, and server→client requests (approvals, elicitation) cross
// unchanged in both directions. It does not reconnect and never re-sends
// anything; every failure exits non-zero with a fixed-string stderr message
// (no URLs, no tokens, no hub-provided values) so the plugin surfaces it.
//
// Requires Node >= 22.4 (native WebSocket). Zero runtime dependencies.
//
// Configuration precedence: --config <file> > ZCODE_ACP_HUB_CONFIG > direct env.
// Config file JSON keys: hubUrl (string), token (string), instance? (string),
// workspace? (string), timeoutMs? (positive integer).
// Direct env: ZCODE_ACP_HUB_URL, ZCODE_ACP_HUB_TOKEN, ZCODE_ACP_HUB_INSTANCE,
//             ZCODE_ACP_HUB_WORKSPACE, ZCODE_ACP_HUB_TIMEOUT_MS
//
// Instance selection: with an explicit `instance`, discovery is skipped. With
// `workspace`, an instance is used only when its normalized workspace matches
// exactly AND it is the only match (backslashes and trailing slashes are
// normalized before comparison). Without either, a hub reporting exactly one
// instance connects; zero or multiple candidates are both errors — this
// adapter never silently picks the first remote node.
//
// Exit codes: 0 ok · 1 hub connection closed mid-session · 2 bad configuration
//             3 no unambiguous hub instance · 4 discovery unauthorized ·
//             5 discovery transport failure · 6 WebSocket connect failure ·
//             7 frame/queue limit violation
import { readFileSync } from "node:fs";
import process from "node:process";

const VERSION = "0.1.0";
const MAX_LINE_CHARS = 16 * 1024 * 1024; // bound for one ACP message, both directions
const MAX_QUEUED_FRAMES = 256; // frames buffered while the socket is not open yet
const MAX_QUEUE_BYTES = 64 * 1024 * 1024; // total bytes buffered while the socket is not open yet
const MAX_BUFFERED_AMOUNT = 64 * 1024 * 1024; // send-buffer bound, socket and stdout alike

/** Fixed-string failure: `code` is numeric, `message` never carries external input. */
function fail(code, message) {
  process.stderr.write(`[zcode-hub-adapter] ${message}\n`);
  process.exit(code);
}

if (process.argv.includes("--version")) {
  process.stdout.write(`zcode-hub-adapter ${VERSION}\n`);
  process.exit(0);
}

// ---------- stdin lifecycle: watched from startup, before any I/O ----------

/** "discovery" | "connecting" | "running" | "done" */
let state = "discovery";
let stdinOpen = true;
const eofAbort = new AbortController();
const outboundQueue = [];
let queuedBytes = 0; // total chars buffered in outboundQueue; live from startup, before any await

process.stdin.setEncoding("utf8");
let stdinBuffer = "";
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newlineIdx;
  while ((newlineIdx = stdinBuffer.indexOf("\n")) !== -1) {
    const line = stdinBuffer.slice(0, newlineIdx).trim();
    stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
    if (!line) continue;
    queueFrame(line);
  }
  if (stdinBuffer.length > MAX_LINE_CHARS) {
    fail(7, "inbound frame exceeds the size limit");
  }
});
process.stdin.on("end", onStdinEof);
process.stdin.on("error", onStdinEof);
process.stdin.resume();

function onStdinEof() {
  stdinOpen = false;
  eofAbort.abort();
  if (state === "running") {
    shutdown(0, "stdio closed");
  } else if (state !== "done") {
    process.stderr.write("[zcode-hub-adapter] stdio closed before the hub connection opened\n");
    process.exit(0);
  }
}

// ---------- configuration (external input: strictly validated) ----------

function expectString(source, field, value, required) {
  if (value === undefined || value === null) {
    if (required) fail(2, `configuration is missing the ${source} ${field}`);
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    fail(2, `configuration ${source} ${field} must be a non-empty string`);
  }
  return value;
}

function parseTimeoutMs(value) {
  if (value === undefined || value === null) return 8000;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(num) || num <= 0 || num > 120_000) {
    fail(2, "configuration timeoutMs must be an integer between 1 and 120000");
  }
  return num;
}

function readConfigFile(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    fail(2, "config file is missing or unreadable");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(2, "config file is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(2, "config file must contain a JSON object");
  }
  return parsed;
}

const configArgIdx = process.argv.indexOf("--config");
let configFromFile = {};
if (configArgIdx !== -1) {
  const configPath = process.argv[configArgIdx + 1];
  if (!configPath || configPath.startsWith("-")) fail(2, "--config requires a file path argument");
  configFromFile = readConfigFile(configPath);
} else if (process.env.ZCODE_ACP_HUB_CONFIG) {
  configFromFile = readConfigFile(process.env.ZCODE_ACP_HUB_CONFIG);
}

const config = {
  hubUrl: configFromFile.hubUrl ?? process.env.ZCODE_ACP_HUB_URL,
  token: configFromFile.token ?? process.env.ZCODE_ACP_HUB_TOKEN,
  instance: configFromFile.instance ?? process.env.ZCODE_ACP_HUB_INSTANCE,
  workspace: configFromFile.workspace ?? process.env.ZCODE_ACP_HUB_WORKSPACE,
};
const timeoutMs = parseTimeoutMs(configFromFile.timeoutMs ?? process.env.ZCODE_ACP_HUB_TIMEOUT_MS);

expectString("hub URL", "hubUrl", config.hubUrl, true);
expectString("hub token", "token", config.token, true);
if (config.instance !== undefined) expectString("hub selection", "instance", config.instance, true);
if (config.workspace !== undefined) expectString("hub selection", "workspace", config.workspace, true);
if (!stdinOpen) process.exit(0);

// ---------- URL validation: parse, forbid userinfo/query/hash, TLS off-loopback ----------

function normalizeHubUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(2, "hub URL is not a valid absolute URL");
  }
  if (url.username || url.password) fail(2, "hub URL must not contain userinfo");
  if (url.search || url.hash) fail(2, "hub URL must not contain a query or fragment");
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  if (!secure && url.protocol !== "http:" && url.protocol !== "ws:") {
    fail(2, "hub URL protocol must be http(s) or ws(s)");
  }
  const host = url.hostname; // URL lowercases; IPv6 keeps brackets
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (!secure && !loopback) {
    fail(2, "cleartext hub URL is only allowed on loopback hosts — use https:// or wss://");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return {
    discoveryUrl: `${secure ? "https" : "http"}://${url.host}${pathname}/api/instances`,
    wsUrlBase: `${secure ? "wss" : "ws"}://${url.host}${pathname}/acp`,
  };
}

const { discoveryUrl, wsUrlBase } = normalizeHubUrl(config.hubUrl);

/** Windows hubs report backslash paths; normalize both sides before exact comparison. */
function normalizeWorkspace(value) {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

// ---------- instance discovery: connect only on an unambiguous id ----------

function validateInstances(list) {
  if (!Array.isArray(list)) fail(5, "hub discovery response must be an array");
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) fail(5, "hub discovery response contains an invalid instance entry");
    if (typeof entry.id !== "string" || entry.id.length === 0) fail(5, "hub discovery response contains an invalid instance entry");
    if (typeof entry.workspace !== "string") fail(5, "hub discovery response contains an invalid instance entry");
  }
}

async function resolveInstanceId() {
  if (config.instance !== undefined) return config.instance;
  const discoveryTimeout = AbortSignal.timeout(timeoutMs);
  const discoverySignal = AbortSignal.any([eofAbort.signal, discoveryTimeout]);
  let res;
  try {
    res = await fetch(discoveryUrl, {
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: "error",
      signal: discoverySignal,
    });
  } catch {
    if (!stdinOpen) process.exit(0);
    if (discoveryTimeout.aborted) fail(5, "hub discovery timed out");
    fail(5, "hub unreachable during instance discovery");
  }
  if (!stdinOpen) process.exit(0);
  if (res.status === 401 || res.status === 403) fail(4, `hub rejected discovery (HTTP ${res.status})`);
  if (!res.ok) fail(5, `hub discovery failed (HTTP ${res.status})`);
  let raw;
  try {
    raw = await res.text();
  } catch {
    if (!stdinOpen) process.exit(0);
    if (discoveryTimeout.aborted) fail(5, "hub discovery timed out");
    fail(5, "hub discovery response aborted");
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    fail(5, "hub discovery returned malformed JSON");
  }
  validateInstances(list);
  const wanted = config.workspace === undefined ? undefined : normalizeWorkspace(config.workspace);
  const matches =
    wanted === undefined
      ? list
      : list.filter((entry) => normalizeWorkspace(entry.workspace) === wanted);
  if (matches.length === 0) {
    fail(3, wanted === undefined ? "hub reports no instances" : "no hub instance matches the configured workspace");
  }
  if (matches.length > 1) {
    fail(
      3,
      wanted === undefined
        ? "multiple hub instances reported — set the instance id or workspace explicitly"
        : "multiple hub instances match the configured workspace — set the instance id explicitly",
    );
  }
  return matches[0].id;
}

const instanceId = await resolveInstanceId();
if (!stdinOpen) process.exit(0);
state = "connecting";
process.stderr.write("[zcode-hub-adapter] hub instance resolved\n");

// ---------- WebSocket link ----------

if (typeof WebSocket !== "function") {
  fail(6, "native WebSocket unavailable — run with Node >= 22.4");
}

let socket;
try {
  socket = new WebSocket(`${wsUrlBase}?instance=${encodeURIComponent(instanceId)}&token=${encodeURIComponent(config.token)}`);
} catch {
  fail(6, "websocket construction failed");
}

let opened = false;
let exiting = false;

socket.addEventListener("open", () => {
  opened = true;
  state = "running";
  if (!stdinOpen) {
    shutdown(0, "stdio closed");
    return;
  }
  const pending = outboundQueue.splice(0);
  queuedBytes = 0;
  for (const line of pending) sendFrame(line);
});

socket.addEventListener("message", (event) => {
  const data = event.data;
  if (typeof data !== "string") {
    fail(7, "hub sent a binary frame — only text frames are supported");
  }
  if (data.length > MAX_LINE_CHARS) {
    fail(7, "hub frame exceeds the size limit");
  }
  const frame = data.trimEnd();
  if (frame.includes("\n") || frame.includes("\r")) {
    fail(7, "hub frame contains embedded line breaks");
  }
  if (frame.length === 0) return;
  if (process.stdout.writableLength > MAX_BUFFERED_AMOUNT) {
    fail(7, "stdout write buffer exceeded the bound");
  }
  try {
    process.stdout.write(`${frame}\n`);
  } catch {
    fail(1, "writing to stdout failed");
  }
});

process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") {
    process.exit(1);
  }
  fail(1, "writing to stdout failed");
});

function sendFrame(line) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    fail(7, "hub send buffer exceeded the bound");
  }
  try {
    socket.send(line);
  } catch {
    fail(1, "hub send failed");
  }
}

function queueFrame(line) {
  if (line.length > MAX_LINE_CHARS) {
    fail(7, "inbound frame exceeds the size limit");
  }
  if (state === "running" && opened) {
    sendFrame(line);
  } else if (
    outboundQueue.length >= MAX_QUEUED_FRAMES ||
    queuedBytes + line.length > MAX_QUEUE_BYTES
  ) {
    fail(7, "outbound queue overflow before the hub connection opened");
  } else {
    outboundQueue.push(line);
    queuedBytes += line.length;
  }
}

function shutdown(status, closeReason) {
  if (exiting) return;
  exiting = true;
  state = "done";
  try {
    socket.close(1000, closeReason);
  } catch {
    /* already closed */
  }
  const forced = setTimeout(() => process.exit(status), 1500);
  socket.addEventListener("close", () => {
    clearTimeout(forced);
    process.exit(status);
  });
  if (!opened) {
    clearTimeout(forced);
    process.exit(status);
  }
}

socket.addEventListener("close", (event) => {
  if (exiting) return;
  state = "done";
  fail(1, `hub connection closed (code ${event.code})`);
});
socket.addEventListener("error", () => {
  if (!opened && !exiting) {
    // The close event follows; a fixed message keeps URLs and tokens out.
    process.stderr.write("[zcode-hub-adapter] websocket error before open\n");
  }
});

const openTimeout = setTimeout(() => {
  if (!opened && !exiting) fail(6, `hub connection timed out after ${timeoutMs}ms`);
}, timeoutMs);
openTimeout.unref();

process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
process.on("SIGINT", () => shutdown(0, "SIGINT"));
