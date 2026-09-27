# zcode-desktop-adapter

English | [中文](README.zh.md)

An ACP-over-stdio agent facade that lets tasks submitted from a `dsh-acp-adapter` workbench run in the **local ZCode desktop as desktop-visible tasks**, next to the existing background ACP nodes and `zcode-hub-adapter` nodes. It reuses the verified `remote-client` transport over the desktop's official remote-control channel instead of reimplementing it: relay pairing, bootstrap, one exact workspace bridge, and the same `zcode-agent` / `zcode-task` channel surface the official web client uses (`helloConversationV4`, `initializeConversationV4`, `sendConversationCommandV4` with `createSession` / `sendText` / `stop`, the live V4 conversation subscription `subscribeConversationV4` / `resyncConversationV4` / `unsubscribeConversationV4` with the `onDynamicConversationFrame` workspace frame stream, and `zcode-task/createTask` for native task-list registration). Turn output is projected only from the subscription stream; the `zcode-task/getTaskSnapshot` polling path is deliberately unused (on desktop 3.14.0 its `resumeSession` read can serve a stale in-memory projection for long tasks).

It is an external-agent stdio program, not a DSH application entry: no plugin code is copied, `node_modules` is untouched, and the workbench keeps using the installed `@zaimokuza/dsh-acp-adapter`.

The same adapter also serves a **remote-site node**: one node for a paired site desktop with many registered workspaces (`workspaceSelection: "session"`), where each session picks its exact workspace from the site's own live list before anything can dispatch. See the "Remote-site node" section below.

Requires Node 24 with `--experimental-transform-types` for the external remote-client source checkout. Its dependencies must be installed in that checkout; this adapter adds no package dependencies.

Real acceptance evidence and remaining verification are recorded in the [integration manifest](../../DOC/integration/zcode-desktop-manifest.json).

## Use as a dsh-acp-adapter agent node

In the plugin's agent settings, configure the node as:

- command: absolute path of a Node 24 executable
- arguments: `["--experimental-transform-types", "<repo>/integrations/zcode-desktop-adapter/adapter.mjs", "--config", "<path to a private config file>"]`

The config file and everything else private live outside this repository. Example:

```json
{
  "remoteClientRoot": "D:/本地工作台/zcode-lab/remote-client",
  "connectionUrlFile": "D:/local-private/zcode-desktop-url.txt",
  "workspace": "D:/site/project-a",
  "stateDir": "D:/local-private/zcode-desktop-adapter-state",
  "requestTimeoutMs": 20000,
  "pollIntervalMs": 2500,
  "turnTimeoutMs": 600000
}
```

A remote-site node drops the fixed `workspace` and selects per session instead:

```json
{
  "remoteClientRoot": "D:/本地工作台/zcode-lab/remote-client",
  "connectionUrlFile": "D:/local-private/remote-site-url.txt",
  "workspaceSelection": "session",
  "siteName": "PC1-HZ20035172",
  "stateDir": "D:/local-private/remote-site-adapter-state"
}
```

## Configuration

`adapter.mjs --config <file>` is the only launch form. All keys are validated; a bad file exits before any connection.

| Key | Meaning |
| --- | --- |
| `remoteClientRoot` | Path to the reused remote-client checkout; `src/remote/client.ts` and `src/remote/connection-params.ts` are loaded from it by dynamic import. |
| `connectionUrlFile` | File containing the desktop remote-control URL (`sid`/`hash`/`t`). The only place secrets are read from; re-read on every connect, so credential renewal is read on reconnect. A changed desktop session identity refuses existing bindings. |
| `workspaceSelection` | `"fixed"` (default) or `"session"`. `"fixed"` requires `workspace` and keeps the historical exact-match behavior. `"session"` forbids `workspace`: one node serves every workspace the site reports, picked per session (see below). |
| `workspace` | Workspace path that must match exactly one workspace registered in the desktop (backslashes/trailing slashes normalized, case-insensitive on Windows). Zero or multiple matches are hard errors — the adapter never falls back to the desktop default workspace or another machine's project. Required iff `workspaceSelection` is `"fixed"`. |
| `siteName` | Operator-facing site label for fixed-string diagnostics and the workspace option description (default `remote site`). It is never read from the connection URL. |
| `stateDir` | Private directory for session bindings (see below). Never inside this repository. |
| `requestTimeoutMs` | Per-RPC budget to the desktop, integer 1000–120000, default 20000. |
| `pollIntervalMs` | Idle wake interval for deadline/cancel checks, integer 100–60000, default 2500 (frames drive progress; this timer carries no failure semantics). |
| `turnTimeoutMs` | Wall-clock budget for one prompt turn, integer 1000–3600000, default 600000. |

The configured `workspace` decides where the desktop task runs. The `cwd` DSH passes to `session/new` is recorded and echoed in `session/list`, but it does not change execution: the desktop executes in its registered workspace.

## Remote-site node (one node, many workspaces)

`workspaceSelection: "session"` turns the adapter into a single node that serves a whole site — no per-workspace node clones. The flow:

1. **Discovery at session creation.** `session/new` performs one read-only probe (relay pairing + bootstrap + disconnect, no bridge, no conversation channel) and returns a `workspace` select option whose values are the site's registered workspace paths. A failed probe — site offline, unreadable connection file, zero or path-duplicated workspaces — is an explicit `session/new` error; no binding is written and nothing is dispatched. The workbench's settings-page connection check exercises this same path, so "recheck" doubles as the online/offline health check. While a prompt turn is in flight, `session/new` answers busy instead of probing: the relay grants one controller connection per device, and a second pairing would kick the connection streaming the live turn — the 2026-09-21 acceptance run lost a turn exactly that way (the stream died mid-answer with an unknown outcome while the desktop itself had completed).
2. **Selection per session.** The workbench renders the option in the session's agent control menu (the same `session/set_config_option` channel as the model choice). Picking a value re-validates it against a fresh discovery — a stale menu cannot select a workspace the site no longer serves — and pins the choice (normalized scope plus workspace identity) on the binding.
3. **Exact dispatch.** `session/prompt` refuses with an explicit error until a workspace is selected, then bridges exactly that workspace and creates the desktop task inside it. There is no default workspace, no first-listed fallback, and the selection becomes immutable once a task has been dispatched. A dispatch always re-matches the selection against the site's current list, so a workspace removed between selection and prompt fails loud instead of landing in the wrong project.

**Health metadata and the UI boundary.** The ACP card protocol has no first-class slot for site metadata, so the read-only facts — site label, actual desktop version, registered workspace count — travel in the `workspace` option's description text, and `--health` prints the same facts as a one-line fixed-string report (exit 0 online, exit 1 offline):

```sh
node adapter.mjs --config <private-json> --health
# [zcode-desktop-adapter] health: PC1-HZ20035172: online, desktop 3.14.0, 19 registered workspace(s), workspace selection per session
```

Nothing in either surface carries the URL, `sid`, or `hash`. Scope isolation matches the fixed node: bindings are refused and filtered by the connection identity (device + desktop session), so the remote-site node never sees the local desktop node's sessions even when both share one relay host, and its bindings name their selected workspace so a session can only ever dispatch where it was told to.

## Protocol surface

- `initialize` — protocolVersion 1; capabilities are text-only and honest: `loadSession: true`, one scoped `session/list`, `promptCapabilities` all false (no image/audio/embedded context), `mcpCapabilities` all false. No MCP, image, or approval capability is claimed.
- `session/new` — lazily mints a stable DSH-side session id (`zdsk-<uuid>`) and a binding file. In fixed-workspace mode nothing touches the desktop until the first prompt and the response carries one fixed config option: the model select `follow-desktop` (the desktop owns model choice), which also answers the workbench's model probe. In session mode the response additionally carries the `workspace` select option from a read-only discovery (see the "Remote-site node" section).
- `session/prompt` — one turn at a time per adapter process (concurrent prompts are rejected). Text blocks only; any non-text block is rejected before anything is dispatched. If DSH prepends a host-instructions block (`Current host instructions (replace earlier host instructions for this request).`), its content is preserved verbatim but moved after the real user task, so the desktop task title reflects the task. The command id is persisted before the envelope is sent; the desktop session id is recorded only after an `accepted` ack, in one atomic write. A prompt turn streams only agent/tool updates — the user text is never echoed back (DSH already recorded it); user chunks exist only in `session/load` replay.
- Turn tracking — the conversation topic `conversation/<sessionId>` is subscribed through the official V4 stream, and the turn is event-driven over it. The projection follows the official store contract: a snapshot frame wholesale-replaces state; delta frames apply only when interval-contiguous (`fromSeq === seq`); a gap, an assembly fault, or a bridge recovery recovers through `resyncConversationV4` first, falling back to a fresh snapshot subscription, then to a controller re-pair with a read-only re-subscribe; bounded idle silence recovers through the same ladder, resync-first, and a route whose forced snapshot never lands escalates to the rebuild at the next idle wake — commands are never re-sent. Fragmented physical frames assemble under the crc32 checksum and fail closed. Output streams as `agent_message_chunk` keyed by row (`v4row-<rowId>`); official `text` / `output.text` deltas append under one `messageId`, while a legal `row.upserted` text replacement opens a new message revision because ACP cannot retract an already-sent chunk. History is never replayed: for an existing task the pre-dispatch subscription snapshot is the baseline and it must be terminal (`control.phase` completed and no pending interactions) — a still-running task refuses the `startNow` append rather than overwriting it. Turn completion requires new assistant rows: the terminal phase can settle before the assistant row is projected, so a terminal phase alone never ends the turn — it stays open until the row lands (or fails with evidence). A new user row plus a terminal phase, or tools already visible in the baseline, never close a turn. Rows without a `rowId` are handled conservatively: resync, never streamed, never counted as evidence. `reasoning` rows are never projected.
- Task registration — direct `createSession` alone does not initialize the desktop's task facade. After the accepted ack the adapter calls `zcode-task/createTask` with `draftSessionId` (the same accepted id, `v4Create: true`) so the desktop adopts the existing draft without dispatching new input; the result's task id is the verification, and only then is the binding marked `registered`. A failed registration marks it `unknown`, keeps the binding, and never retries automatically; `session/load` refuses `unknown` bindings (inspect the native task first) and backfills registration for historical bindings that predate the field.
- Tools and approvals — `toolCall` rows (stable id `row.toolCallId`, official status set) project as ACP `tool_call` / `tool_call_update` cards. Desktop-side pending permissions/elicitations surface as one persistent card saying approval must happen in the ZCode desktop; the turn keeps running and the adapter never auto-approves and never configures yolo.
- `session/cancel` — maps to the desktop's real `stop` conversation command (verified against the installed desktop's own stop-generation call site). An accepted stop ack is delivery, not a terminal state: `cancelled` is returned only after the stream observes a terminal phase (`completedInterrupted`); if the stop cannot be confirmed before the deadline, an error says the remote state is unknown instead of claiming success.
- `session/load` — restores the bound desktop session from the binding file and replays history from a fresh subscription snapshot (real-user and guided inputs plus assistant rows, keyed by row id), so a workbench restart or adapter restart resumes the same desktop task.

## Failure semantics

- Timeouts and dropped links never trigger a resend. If a command's outcome is unknown (lost ack, adapter restart between send and ack), the binding keeps the dispatch record and further prompts on that session are refused until a human checks the task in the ZCode desktop. The adapter never auto-creates a replacement session. The turn deadline is checked at the top of every loop wake, including the resync-retry path, so persistent stream faults cannot extend a turn past `turnTimeoutMs`. Recovery: verify the task on the desktop, then delete the binding file in `stateDir/bindings/` (a new DSH session starts a new desktop task; the old task stays on the desktop).
- A turn that exceeds `turnTimeoutMs` returns an error that explicitly says the desktop task may still be running.
- Process exit (stdin EOF, signal) only disconnects the relay; nothing is re-dispatched, and the binding survives for `session/load`.
- Bindings are scope-checked by device identity and workspace, not just relay host: the identity is stored as a safe hash (never the raw credential), a changed connection file or workspace refuses old bindings on load, prompt, and list.
- stdout carries JSON-RPC only. stderr carries credential-scrubbed diagnostics. Error text crossing stdio is scrubbed: connection credentials and URLs never appear in protocol errors or stderr.

| Exit code | Meaning |
| --- | --- |
| 0 | Normal end (stdio closed or signal). |
| 1 | `--health` found the site offline or misconfigured. |
| 2 | Bad configuration. |
| 7 | Inbound JSON-RPC frame exceeds the size limit. |
| 8 | remoteClientRoot does not expose the expected modules. |

## Capability boundaries

- **Internet relay dependency.** The desktop remote-control channel goes through the official internet relay (`wss://<relay-host>/ws`), even for a desktop on the same machine. This adapter is not an offline local RPC; relay reachability and account state affect it.
- **Desktop authorization / pairing lifecycle.** The remote-control URL is generated per pairing from the desktop's mobile remote-control screen. It expires when the desktop re-pairs or revokes. The adapter re-reads the URL file on each connect, so credential renewal is picked up on reconnect. A changed device or desktop session identity refuses old bindings; the adapter cannot re-pair on its own.
- **Approvals stay on the desktop.** Permission requests and elicitations raised inside the desktop task cannot be answered from the workbench; the adapter surfaces them as a waiting card and keeps the turn open.
- **Model choice follows the desktop.** The single advertised model option is the fixed `follow-desktop` value; changing models happens in the ZCode desktop.
- **Connection ownership.** Each prompt and idle session load releases its relay connection when finished. The next turn reconnects and retains the same desktop task binding. Other remote controllers must not connect during an active turn. The adapter enforces the same single-slot rule on itself: every pairing in the process — site discovery and the task link — serializes through one controller gate, so a prompt dispatched while a discovery is still open waits for that discovery to release the slot instead of pairing alongside it.
- **Single-driver assumption.** The adapter assumes it drives the task it created. If a human or another client simultaneously works the same desktop task, turn boundaries are attributed best-effort from the live stream.
- **V4 protocol shapes.** The wire-frame, snapshot, and row projections (wireVersion 3; `ConversationSnapshot` with `control.phase`, `rows.window`, `pendingInteractions`; `assistantText`/`toolCall` rows with `rowId`/`toolCallId`) follow the official 3.14.0 protocol (verified against the ZCode-official sources at that version); a desktop update that changes these shapes degrades to conservative behavior (resync loops, turn timeout) rather than data loss.

## Coexistence with other nodes

This adapter does not replace anything: the ACP background node (independent headless execution) and `integrations/zcode-hub-adapter` (remote hub passthrough with full approval bridging) keep working unchanged. Use this node when the requirement is that the task is *visible and steerable in the running ZCode desktop*; use the ACP node for headless runs; use the hub adapter for hub-hosted sessions.

## Tests

Fake-remote integration tests spawn the real stdio entry; only the desktop is faked (no network, no relay, no real desktop):

```sh
node --test integrations/zcode-desktop-adapter/test/adapter.test.mjs
```

Covered: capability advertisement, create → prompt → end-to-end turn streaming with host-instruction ordering and per-turn subscribe/unsubscribe lifecycle, restart + session/load resume with snapshot replay, exact/unique workspace matching, non-text rejection, concurrent and unresolved-dispatch blocking, credential non-leakage on content and URL non-leakage on errors/stderr, terminal-phase-without-content and user-echo-only turn discipline, terminal-phase-before-row projection discipline, baseline tool coverage, non-terminal baseline refusal, real stop cancellation with terminal-state observation (accepted-ack-alone and unconfirmed-stop negatives included), persistent stream-fault turns that resync without resend or deadline escape, idle missed-terminal recovery through one forced resync on the live subscription (no route rebuild, complete answer streamed), silent-resync escalation to exactly one subscription rebuild, and refused-resync fallback to the rebuild — all without command resend, growing-row deltas under one messageId, snapshot-replacement no-replay, conservative id-less handling, seq-gap recovery through exactly one server resync with missed rows streamed, crc32 fragment assembly and corrupted-fragment fail-closed, tool/approval cards (validated against the ACP ToolCallContent shapes the SDK enforces), a hard assertion that zcode-task/getTaskSnapshot is never called, task registration (reuse without re-dispatch, failure keeps the binding with no auto-retry, session/load backfill for historical bindings and refusal for unconfirmed ones), the fixed model option, and binding scope guards including device-identity isolation.

The remote-site mode adds: read-only discovery surfacing the workspace option (values, labels, health metadata), discovery failure leaving no binding and dispatching nothing, path-duplicate refusal, no-selection prompt refusal, off-list selection refusal with an unpinned binding, selection pinning verified through the actual `createSession` workspace id, post-dispatch immutability, device-identity isolation of site bindings, undispatched `session/load` re-discovery that keeps (or refuses a vanished) selection, `--health` online/offline output with credential scrubbing, and config validation for both modes (legacy fixed config unchanged, session + pinned workspace rejected, fixed without workspace still rejected, unknown selector rejected). Concurrency against the single controller slot: `session/new` discovery during a live turn returns busy without opening a second relay pairing (no controller kick, no binding written), the turn still streams its complete final answer — including a final frame whose terminal patch precedes the last full-text row — and a prompt dispatched behind an in-flight discovery waits for the slot instead of contending.
