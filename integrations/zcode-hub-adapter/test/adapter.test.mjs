// Adapter unit tests: node --test integrations/zcode-hub-adapter/test/
//
// The WebSocket *server* side of these tests loads the repository's already
// pinned `ws` dependency (packages/api/gateway, ^8.21.0) through a
// createRequire anchor: pnpm's strict isolation gives integrations/ no
// node_modules of its own, and adding an install just for tests would touch
// the lockfile. If the gateway ever drops `ws`, this require fails loudly —
// re-anchor to another workspace package that pins it.
//
// Every test binds its hub on 127.0.0.1:0 (no fixed ports) and writes config
// files into its own mkdtemp directory, so suites run concurrently.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const ADAPTER = path.join(REPO_ROOT, "integrations", "zcode-hub-adapter", "adapter.mjs");

const requireFromGateway = createRequire(path.join(REPO_ROOT, "packages", "api", "gateway", "package.json"));
const { WebSocketServer } = requireFromGateway("ws");

const TOKEN = () => randomBytes(18).toString("hex");

// ---------- fake hub ----------

class FakeHub {
  constructor({ token, instances = [], delayDiscovery = false, instancesBody = null } = {}) {
    this.token = token;
    this.instances = instances;
    this.delayDiscovery = delayDiscovery;
    this.instancesBody = instancesBody;
    this.discoveryRequests = [];
    this.upgradeInstances = [];
    this.received = [];
    this.closeCodes = [];
    this.sockets = [];
  }

  async start() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/api/instances" && req.method === "GET") {
        this.discoveryRequests.push(String(req.headers.authorization ?? ""));
        if (this.delayDiscovery) return; // hang the response on purpose
        if (req.headers.authorization !== `Bearer ${this.token}`) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(this.instancesBody ?? JSON.stringify(this.instances));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/acp") {
        socket.destroy();
        return;
      }
      if (url.searchParams.get("token") !== this.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.push(ws);
        this.upgradeInstances.push(url.searchParams.get("instance"));
        ws.on("message", (data) => this.received.push(data.toString()));
        ws.on("close", (code) => this.closeCodes.push(code));
      });
    });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = this.server.address().port;
    this.url = `http://127.0.0.1:${this.port}`;
    return this;
  }

  get lastSocket() {
    return this.sockets[this.sockets.length - 1];
  }

  send(obj) {
    this.lastSocket?.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  receivedJson() {
    return this.received.map((text) => JSON.parse(text));
  }

  async stop() {
    for (const ws of this.sockets) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
    await new Promise((resolve) => this.wss.close(resolve));
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

// ---------- adapter runner ----------

function baseEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ZCODE_ACP_HUB_")) delete env[key];
  }
  return env;
}

function spawnAdapter(extraEnv = {}, args = []) {
  const child = spawn(process.execPath, [ADAPTER, ...args], {
    env: { ...baseEnv(), ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const out = { lines: [], stderr: "" };
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let idx;
    while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
      out.lines.push(stdoutBuffer.slice(0, idx));
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    out.stderr += chunk;
  });
  return { child, out };
}

function sendLine(child, obj) {
  child.stdin.write(`${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
}

function waitExit(child, ms = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("adapter did not exit in time")), ms);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitFor(predicate, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function assertNoSecret(out, secret) {
  assert.ok(!out.stderr.includes(secret), "token leaked to stderr");
  assert.ok(!out.lines.join("\n").includes(secret), "token leaked to stdout");
}

// ---------- tests ----------

test("--version prints the version and exits 0", { timeout: 15_000 }, async () => {
  const { child, out } = spawnAdapter({}, ["--version"]);
  const code = await waitExit(child);
  assert.equal(code, 0);
  assert.match(out.lines.join("\n"), /zcode-hub-adapter 0\.\d+\.\d+/);
});

test("--config without an argument fails with exit 2", { timeout: 15_000 }, async () => {
  const { child, out } = spawnAdapter({}, ["--config"]);
  const code = await waitExit(child);
  assert.equal(code, 2);
  assert.match(out.stderr, /--config requires a file path/);
});

test("missing hub URL and token fails with exit 2", { timeout: 15_000 }, async () => {
  const { child, out } = spawnAdapter();
  const code = await waitExit(child);
  assert.equal(code, 2);
  assert.match(out.stderr, /missing the .* hubUrl/);
});

test("config file validation rejects malformed shapes", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-hub-adapter-"));
  try {
    const cases = [
      ["not json", "{ oops"],
      ["array", '["x"]'],
      ["bad url type", JSON.stringify({ hubUrl: 5, token: "t" })],
      ["bad timeout", JSON.stringify({ hubUrl: "ws://127.0.0.1:1", token: "t", timeoutMs: 1.5 })],
    ];
    for (const [name, content] of cases) {
      const file = path.join(dir, `${name.replace(/\W+/g, "_")}.json`);
      writeFileSync(file, content, "utf8");
      const { child, out } = spawnAdapter({ ZCODE_ACP_HUB_CONFIG: file });
      const code = await waitExit(child);
      assert.equal(code, 2, `${name} must exit 2`);
      assert.match(out.stderr, /\[zcode-hub-adapter\]/, `${name} reports a fixed-prefix error`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("URL validation rejects userinfo, query, wrong scheme, and cleartext off loopback", { timeout: 15_000 }, async () => {
  const cases = [
    "ws://user:pass@127.0.0.1:1",
    "ws://127.0.0.1:1?x=1",
    "ws://127.0.0.1:1#frag",
    "ftp://127.0.0.1:1",
    "http://example.com",
  ];
  for (const hubUrl of cases) {
    const { child, out } = spawnAdapter({ ZCODE_ACP_HUB_URL: hubUrl, ZCODE_ACP_HUB_TOKEN: "t" });
    const code = await waitExit(child);
    assert.equal(code, 2, `${hubUrl} must be rejected with exit 2`);
    assert.ok(!out.stderr.includes(hubUrl), "reject reason must not echo the URL");
  }
});

test("unreachable hub fails with exit 5 and never prints the token", { timeout: 15_000 }, async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const token = TOKEN();
  const { child, out } = spawnAdapter({
    ZCODE_ACP_HUB_URL: `ws://127.0.0.1:${port}`,
    ZCODE_ACP_HUB_TOKEN: token,
  });
  const code = await waitExit(child);
  assert.equal(code, 5);
  assert.match(out.stderr, /hub unreachable during instance discovery/);
  assertNoSecret(out, token);
});

test("discovery rejects wrong credentials with exit 4", { timeout: 15_000 }, async () => {
  const hub = await new FakeHub({ token: TOKEN() }).start();
  try {
    const token = TOKEN();
    const { child, out } = spawnAdapter({ ZCODE_ACP_HUB_URL: hub.url, ZCODE_ACP_HUB_TOKEN: token });
    const code = await waitExit(child);
    assert.equal(code, 4);
    assert.match(out.stderr, /hub rejected discovery \(HTTP 401\)/);
    assertNoSecret(out, token);
  } finally {
    await hub.stop();
  }
});

test("malformed discovery bodies fail with exit 5 and fixed messages", { timeout: 20_000 }, async () => {
  const token = TOKEN();
  const bodies = ["<<not json>>", JSON.stringify({ no: "array" }), JSON.stringify([{ id: 7, workspace: "/x" }])];
  for (const body of bodies) {
    const hub = await new FakeHub({ token, instancesBody: body }).start();
    try {
      const { child, out } = spawnAdapter({ ZCODE_ACP_HUB_URL: `${hub.url}/`, ZCODE_ACP_HUB_TOKEN: token });
      const code = await waitExit(child);
      assert.equal(code, 5, `body must be rejected: ${body}`);
      assert.match(out.stderr, /\[zcode-hub-adapter\]/);
      assertNoSecret(out, token);
    } finally {
      await hub.stop();
    }
  }
});

test("zero or multiple instances without a selector both fail with exit 3", { timeout: 20_000 }, async () => {
  const token = TOKEN();
  for (const instances of [[], [
    { id: "1", port: 1, workspace: "C:\\a" },
    { id: "2", port: 2, workspace: "C:\\b" },
  ]]) {
    const hub = await new FakeHub({ token, instances }).start();
    try {
      const { child, out } = spawnAdapter({ ZCODE_ACP_HUB_URL: hub.url, ZCODE_ACP_HUB_TOKEN: token });
      const code = await waitExit(child);
      assert.equal(code, 3, "no silent candidates[0] selection");
      assert.match(out.stderr, /instances|workspace/);
      assertNoSecret(out, token);
    } finally {
      await hub.stop();
    }
  }
});

test("workspace matching is exact after path normalization and refuses ambiguity", { timeout: 20_000 }, async () => {
  const token = TOKEN();
  const instances = [
    { id: "alpha", port: 1, workspace: "D:\\lab\\site-a" },
    { id: "beta", port: 2, workspace: "D:\\lab\\site-b" },
  ];
  const hub = await new FakeHub({ token, instances }).start();
  try {
    const ok = spawnAdapter({
      ZCODE_ACP_HUB_URL: hub.url,
      ZCODE_ACP_HUB_TOKEN: token,
      ZCODE_ACP_HUB_WORKSPACE: "D:/lab/site-b/",
    });
    sendLine(ok.child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(() => hub.upgradeInstances.includes("beta"));
    assert.ok(!hub.upgradeInstances.includes("alpha"), "must not touch the other instance");
    ok.child.stdin.end();
    assert.equal(await waitExit(ok.child), 0);

    const twinHub = await new FakeHub({
      token,
      instances: [
        { id: "a1", port: 1, workspace: "D:\\lab\\site" },
        { id: "a2", port: 2, workspace: "D:/lab/site/" },
      ],
    }).start();
    try {
      const twin = spawnAdapter({
        ZCODE_ACP_HUB_URL: twinHub.url,
        ZCODE_ACP_HUB_TOKEN: token,
        ZCODE_ACP_HUB_WORKSPACE: "D:\\lab\\site",
      });
      const code = await waitExit(twin.child);
      assert.equal(code, 3, "two normalized-equal matches must be refused");
      assert.match(twin.out.stderr, /multiple hub instances match/);
      assertNoSecret(twin.out, token);
    } finally {
      await twinHub.stop();
    }
  } finally {
    await hub.stop();
  }
});

test("explicit instance skips discovery and connects directly", { timeout: 20_000 }, async () => {
  const token = TOKEN();
  const hub = await new FakeHub({ token }).start();
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-hub-adapter-"));
  try {
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ hubUrl: `${hub.url}/`, token, instance: "42" }), "utf8");
    const { child, out } = spawnAdapter({}, ["--config", file]);
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(() => hub.upgradeInstances.includes("42"));
    assert.equal(hub.discoveryRequests.length, 0, "explicit instance must not hit discovery");
    child.stdin.end();
    assert.equal(await waitExit(child), 0);
    assertNoSecret(out, token);
    assert.ok(!out.stderr.includes(hub.url), "stderr must not echo the hub URL");
  } finally {
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bidirectional passthrough covers requests, notifications, and approvals", { timeout: 20_000 }, async () => {
  const token = TOKEN();
  const hub = await new FakeHub({ token, instances: [{ id: "7", port: 7, workspace: "D:/w" }] }).start();
  try {
    const { child, out } = spawnAdapter({
      ZCODE_ACP_HUB_URL: hub.url,
      ZCODE_ACP_HUB_TOKEN: token,
      ZCODE_ACP_HUB_WORKSPACE: "D:/w",
    });
    // Written before the socket opens: must be buffered and delivered after open.
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await waitFor(() => hub.receivedJson().some((m) => m.method === "initialize"));
    assert.equal(hub.discoveryRequests[0], `Bearer ${token}`, "token rides the header, not the logs");

    hub.send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    await waitFor(() => out.lines.some((l) => JSON.parse(l).id === 1));

    hub.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: {} } });
    await waitFor(() => out.lines.some((l) => JSON.parse(l).method === "session/update"));

    hub.send({ jsonrpc: "2.0", id: "srv-1", method: "session/request_permission", params: {} });
    await waitFor(() => out.lines.some((l) => JSON.parse(l).method === "session/request_permission"));
    sendLine(child, { jsonrpc: "2.0", id: "srv-1", result: { outcome: { outcome: "cancelled" } } });
    await waitFor(() => hub.receivedJson().some((m) => m.id === "srv-1" && m.result));

    child.stdin.end();
    assert.equal(await waitExit(child), 0);
    assertNoSecret(out, token);
  } finally {
    await hub.stop();
  }
});

test("stdin EOF after connect closes the socket with code 1000 and exit 0", { timeout: 20_000 }, async () => {
  const token = TOKEN();
  const hub = await new FakeHub({ token, instances: [{ id: "7", port: 7, workspace: "D:/w" }] }).start();
  try {
    const { child, out } = spawnAdapter({
      ZCODE_ACP_HUB_URL: hub.url,
      ZCODE_ACP_HUB_TOKEN: token,
      ZCODE_ACP_HUB_WORKSPACE: "D:/w",
    });
    await waitFor(() => hub.sockets.length > 0);
    child.stdin.end();
    assert.equal(await waitExit(child), 0);
    await waitFor(() => hub.closeCodes.length > 0);
    assert.equal(hub.closeCodes[0], 1000);
    assertNoSecret(out, token);
  } finally {
    await hub.stop();
  }
});

test("stdin EOF during discovery aborts and exits 0 without connecting", { timeout: 20_000 }, async () => {
  const token = TOKEN();
  const hub = await new FakeHub({ token, delayDiscovery: true }).start();
  try {
    const { child, out } = spawnAdapter({ ZCODE_ACP_HUB_URL: hub.url, ZCODE_ACP_HUB_TOKEN: token });
    await waitFor(() => hub.discoveryRequests.length > 0);
    child.stdin.end();
    assert.equal(await waitExit(child, 5000), 0);
    assert.equal(hub.upgradeInstances.length, 0);
    assertNoSecret(out, token);
  } finally {
    await hub.stop();
  }
});

test("hub closing mid-session exits 1 with a fixed message and no replay", { timeout: 20_000 }, async () => {
  const token = TOKEN();
  const hub = await new FakeHub({ token, instances: [{ id: "7", port: 7, workspace: "D:/w" }] }).start();
  try {
    const { child, out } = spawnAdapter({
      ZCODE_ACP_HUB_URL: hub.url,
      ZCODE_ACP_HUB_TOKEN: token,
      ZCODE_ACP_HUB_WORKSPACE: "D:/w",
    });
    await waitFor(() => hub.sockets.length > 0);
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(() => hub.received.length > 0);
    hub.lastSocket.close(1000, "hub done");
    assert.equal(await waitExit(child), 1);
    assert.match(out.stderr, /hub connection closed \(code 1000\)/);
    const receivedAtExit = hub.received.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(hub.received.length, receivedAtExit, "a dead adapter must not re-send anything");
    assertNoSecret(out, token);
  } finally {
    await hub.stop();
  }
});

test("inbound oversize line fails with exit 7", { timeout: 30_000 }, async () => {
  const token = TOKEN();
  const hub = await new FakeHub({ token, instances: [{ id: "7", port: 7, workspace: "D:/w" }] }).start();
  try {
    const { child, out } = spawnAdapter({
      ZCODE_ACP_HUB_URL: hub.url,
      ZCODE_ACP_HUB_TOKEN: token,
      ZCODE_ACP_HUB_WORKSPACE: "D:/w",
    });
    await waitFor(() => hub.sockets.length > 0);
    child.stdin.on("error", () => {
      /* adapter exits as soon as the limit trips; the pending big write then hits a closed pipe */
    });
    child.stdin.write(`${"a".repeat(17 * 1024 * 1024)}\n`);
    const code = await waitExit(child, 20_000);
    assert.equal(code, 7);
    assert.match(out.stderr, /inbound frame exceeds the size limit/);
    assertNoSecret(out, token);
  } finally {
    await hub.stop();
  }
});

test("binary hub frames and embedded line breaks fail with exit 7", { timeout: 20_000 }, async () => {
  const token = TOKEN();
  for (const [name, payload] of [
    ["binary", Buffer.from([0x01, 0x02, 0x03])],
    ["embedded-newline", '{"a":1}\n{"b":2}'],
  ]) {
    const hub = await new FakeHub({ token, instances: [{ id: "7", port: 7, workspace: "D:/w" }] }).start();
    try {
      const { child, out } = spawnAdapter({
        ZCODE_ACP_HUB_URL: hub.url,
        ZCODE_ACP_HUB_TOKEN: token,
        ZCODE_ACP_HUB_WORKSPACE: "D:/w",
      });
      await waitFor(() => hub.sockets.length > 0);
      hub.lastSocket.send(payload);
      const code = await waitExit(child);
      assert.equal(code, 7, `${name} frame must be rejected`);
      if (name === "embedded-newline") {
        assert.ok(
          !out.lines.some((l) => JSON.parse(l).b === 2),
          "a bad frame must not inject extra stdout lines",
        );
      }
      assertNoSecret(out, token);
    } finally {
      await hub.stop();
    }
  }
});

test("hanging discovery response times out with exit 5", { timeout: 20_000 }, async () => {
  const token = TOKEN();
  const hub = await new FakeHub({ token, delayDiscovery: true }).start();
  try {
    const started = Date.now();
    const { child, out } = spawnAdapter({
      ZCODE_ACP_HUB_URL: hub.url,
      ZCODE_ACP_HUB_TOKEN: token,
      ZCODE_ACP_HUB_TIMEOUT_MS: "100",
    });
    const code = await waitExit(child, 6000);
    const elapsed = Date.now() - started;
    assert.equal(code, 5);
    assert.match(out.stderr, /timed out|unreachable/);
    assert.ok(elapsed < 3000, `timeout must be enforced promptly (took ${elapsed}ms)`);
    assertNoSecret(out, token);
  } finally {
    await hub.stop();
  }
});

test("outbound queue byte cap fails with exit 7 before the socket opens", { timeout: 30_000 }, async () => {
  const token = TOKEN();
  const hub = await new FakeHub({ token, delayDiscovery: true }).start();
  try {
    const { child, out } = spawnAdapter({
      ZCODE_ACP_HUB_URL: hub.url,
      ZCODE_ACP_HUB_TOKEN: token,
      ZCODE_ACP_HUB_TIMEOUT_MS: "20000",
    });
    child.stdin.on("error", () => {
      /* the adapter exits the moment the byte cap trips; pending writes then hit a closed pipe */
    });
    await waitFor(() => hub.discoveryRequests.length > 0);
    const frame = "b".repeat(320_000);
    // ~70 MiB total: the 64 MiB byte cap trips before the 256-frame cap.
    for (let i = 0; i < 220; i++) child.stdin.write(`${frame}\n`);
    const code = await waitExit(child, 20_000);
    assert.equal(code, 7);
    assert.match(out.stderr, /outbound queue overflow/);
    assertNoSecret(out, token);
  } finally {
    await hub.stop();
  }
});

test("two independent adapter+hub pairs run concurrently", { timeout: 30_000 }, async () => {
  const pairs = await Promise.all(
    [1, 2].map(async (n) => {
      const token = TOKEN();
      const hub = await new FakeHub({ token, instances: [{ id: `i${n}`, port: n, workspace: `D:/w${n}` }] }).start();
      const runner = spawnAdapter({
        ZCODE_ACP_HUB_URL: hub.url,
        ZCODE_ACP_HUB_TOKEN: token,
        ZCODE_ACP_HUB_WORKSPACE: `D:/w${n}`,
      });
      sendLine(runner.child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      return { token, hub, runner };
    }),
  );
  try {
    for (const { hub } of pairs) {
      await waitFor(() => hub.receivedJson().some((m) => m.method === "initialize"));
    }
    for (const { hub } of pairs) {
      hub.send({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    }
    for (const { runner } of pairs) {
      await waitFor(() => runner.out.lines.some((l) => JSON.parse(l).id === 1));
      runner.child.stdin.end();
      assert.equal(await waitExit(runner.child), 0);
    }
    for (const { token, runner } of pairs) {
      assertNoSecret(runner.out, token);
    }
  } finally {
    await Promise.all(pairs.map(({ hub }) => hub.stop()));
  }
});
