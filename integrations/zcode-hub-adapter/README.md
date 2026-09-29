# zcode-hub-adapter

English | [中文](README.zh.md)

A zero-dependency stdio↔WebSocket transport adapter that lets a remote (or loopback) [zcode-acp](https://github.com/william0wang/zcode-acp) hub enter a `dsh-acp-adapter` workbench as an ordinary local stdio agent node. It is a transport program for an external agent, not a DSH application entry: no plugin code is copied, no `node_modules` is modified, and the workbench keeps using the plugin's own node settings, session UI, approval cards, and history.

Requires Node >= 22.4 (native WebSocket). Runtime dependencies: none.

## Use as a dsh-acp-adapter agent node

In the plugin's settings (设置 → ACP adapter → add agent), configure the node as:

- command: absolute path of a Node >= 22.4 executable
- arguments: `["<repo>/integrations/zcode-hub-adapter/adapter.mjs", "--config", "<path to a private config file>"]`

The recommended shape keeps credentials out of the workbench settings and out of version control: the DSH settings entry stores only the config file path, and the file itself lives in a private directory outside this repository (for example `<private-storage>/zcode-hub-adapter.json`). Example file content:

```json
{
  "hubUrl": "wss://hub.example.internal:8377",
  "token": "<a-long-random-secret>",
  "workspace": "D:/site/project-a",
  "instance": "optional-explicit-instance-id",
  "timeoutMs": 8000
}
```

## Configuration

Precedence: `--config <file>` > `ZCODE_ACP_HUB_CONFIG` > direct environment variables.

| Key | Env | Meaning |
| --- | --- | --- |
| `hubUrl` | `ZCODE_ACP_HUB_URL` | Hub base URL; `http(s)`/`ws(s)` only, no userinfo/query/fragment, trailing slashes normalized. Cleartext `http`/`ws` is accepted only on `localhost`, `127.0.0.1`, or `[::1]`. |
| `token` | `ZCODE_ACP_HUB_TOKEN` | Hub auth token. Sent only in the `Authorization: Bearer` header (discovery) and the WebSocket query string. Never printed, logged, or returned. |
| `instance` | `ZCODE_ACP_HUB_INSTANCE` | Explicit instance id; skips discovery entirely. |
| `workspace` | `ZCODE_ACP_HUB_WORKSPACE` | Exact-match filter for instance selection. |
| `timeoutMs` | `ZCODE_ACP_HUB_TIMEOUT_MS` | Discovery/connect timeout, integer 1–120000, default 8000. |

Instance selection never picks silently: an explicit `instance` connects directly; with `workspace`, a candidate is used only when its normalized workspace (backslashes → forward slashes, trailing slashes stripped) matches exactly and it is the only match; with neither, exactly one advertised instance connects. Zero candidates and multiple candidates are both errors (exit 3).

## Behavior and failure semantics

The adapter is a JSON-RPC payload passthrough: newline-delimited messages on stdio ↔ one text frame per message on the WebSocket. Frames are trimmed of surrounding whitespace and otherwise untouched — including server→client requests such as `session/request_permission` — so approvals render in the workbench's native approval UI. The adapter never parses payloads, never reconnects, and never re-sends anything; resuming after a break is the user's `session/load`, not an automatic replay.

Bounds: one frame ≤ 16,777,216 characters (JavaScript `string.length`) in either direction; the pre-connection queue holds ≤ 256 frames and ≤ 67,108,864 characters total; the socket and stdout write buffers (byte measures) are capped at 67,108,864. Binary frames, frames with embedded line breaks, and oversized frames fail closed.

| Exit code | Meaning |
| --- | --- |
| 0 | Normal end (stdio closed, signal, or pre-connection stdin EOF). |
| 1 | Hub connection closed mid-session, send/stdout failure. |
| 2 | Bad configuration or invalid hub URL. |
| 3 | No unambiguous hub instance (zero or multiple candidates). |
| 4 | Discovery rejected (HTTP 401/403). |
| 5 | Discovery transport failure or timeout, malformed discovery response. |
| 6 | WebSocket connect failure or timeout. |
| 7 | Frame/queue limit violation. |

All stderr messages are fixed strings plus numeric codes — no URLs, tokens, or hub-provided values are echoed.

## Tests

From the repository root:

```sh
node --test integrations/zcode-hub-adapter/test/adapter.test.mjs
```

The tests' WebSocket server side loads the repository's already-pinned `ws` dependency (`packages/api/gateway`, ^8.21.0) through a `createRequire` anchor: pnpm's strict isolation gives `integrations/` no `node_modules` of its own, and adding an install just for tests would touch the lockfile. If the gateway ever drops `ws`, the require fails loudly — re-anchor to another workspace package that pins it.

## Verification boundary

Unit tests cover configuration validation, URL policy, selection ambiguity, bidirectional passthrough with approvals, disconnect/close cleanup, limit violations, and credential non-leakage; two independent `node --test` processes have each passed 20/20. A loopback run against a real `zcode-acp` hub+serve (0.44.1, build mode) verified the full chain — including an adapter process restart followed by `session/load` context continuation — and the workbench accepted the loopback hub as an agent node, completing two conversational turns with correct marker recall. Run configuration, credentials, and logs live outside this repository in private storage; a real remote site across a network or tunnel is not yet exercised.
