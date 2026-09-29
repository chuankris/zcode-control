---
description: "Zcode workbench task center, node routing, and desktop-visible dispatch for Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-zcode-workbench

English | [中文](README.zh.md)

## Summary

A task center that lets Codex and the workbench itself hand tasks to desktop-visible Zcode nodes. One shared `workbenchTaskId` crosses all three sides, the workbench picks the executing node and workspace before anything dispatches, and dispatch rides the verified ACP adapter program (`integrations/zcode-desktop-adapter`) instead of reimplementing the Zcode remote protocol. This private plugin supplies a main panel (task list, composition, task detail), a node settings section, a local HTTP ingress for Codex, and a durable task store; it adds no session-format changes and no model-visible inputs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

<a id="use-this-package"></a>

Install the package in an existing Web dsh profile and insert its package name through the profile's patch layer:

```yaml
- insert:
    - id: zcode-workbench
      name: '@deepseek-ai/dsh-experimental-zcode-workbench'
      config:
        stateDir: "<private directory outside this repository>"
        ingressPath: "/zcode-workbench/ingress"
        ingressTokenFile: "<private token file path>"
```

`stateDir` holds the durable task and node records; `ingressTokenFile` holds the bearer token the Codex ingress requires (at least 16 characters; the route answers 503 until the file exists). Neither file belongs in the repository.

Register Zcode nodes in Settings → Zcode nodes. A node is an ACP agent launcher: `command` plus `args` naming the adapter's private `--config` JSON. In production the command launches `integrations/zcode-desktop-adapter/adapter.mjs`; its configuration file alone holds the connection URL file path and all other private settings, and the workbench never reads it. `workspaceSelection: session` nodes list the site's own workspaces through a read-only `session/new` discovery, so the task form picks from the live site list; `fixed` nodes pin one workspace inside the adapter configuration.

The task center panel is workspace-first. The home lists nodes with their connection state, and only the node being viewed gets one workspace discovery (never a 2–3s poll across all workspaces — each discovery occupies the device's single remote-control slot); a single available node expands by itself. A home workspace card shows the confirmable **workbench-session count** — the same identity the unified list uses: bound rounds collapse by their verified `desktopTaskId` into one session, unbound records each count as one, and the number never guesses the desktop's native total; last activity spans every round of the workspace. Entering a workspace shows the unified task list: the Zcode desktop's own synced task index (read through the adapter's read-only `--list-tasks` mode; synced, non-pinned, non-archived tasks of that workspace only — the desktop's real capability boundary) merged with this store's workbench rounds by verified identity `(nodeId, workspaceIdentity, desktopTaskId)` — a desktop row and records join only when a record carries the same `desktopTaskId` or the Host-side adapter-binding join names the record; titles, short ids, and same-looking paths never merge anything, and the same path on different nodes stays isolated. A compose round's own `desktopTaskId` is backfilled conservatively by the Host on the first listing that sees the adapter row's verified `dshSessionId → taskId` binding (only records without one yet, only sessions the index binds to exactly one task; a missing or conflicted binding writes nothing), so the round chain stays one desktop conversation after completion, restarts, and index outages. When the index read fails the workbench rows stay visible and the desktop side states "unavailable" with the reason; at the adapter's row cap the list says "showing the most recent 200 only"; the list carries the desktop index's sampled time and is read only on entering the workspace, on manual refresh, or after a dispatched round settles. Filters are all/active/completed/needs-attention; needs-handling and in-flight rows sort first, then latest activity. Narrow screens navigate workspace → list → detail/compose; wide screens (≥1080px) show the three columns side by side over the same state.

The task detail is result-first: title and main status → original request → conversation (assistant text renders through a safe Markdown subset — no raw HTML parsing, only http(s) links become anchors, code blocks scroll horizontally) → the continuation composer → a collapsed run-details section (full task ids, delivery stage, status trace, and reported state, copyable for diagnostics). `reported` no longer overwrites the real outcome: the record and wire view keep a `terminalOutcome`, the main status shows the real result, legacy records recover it from the status trace and show "outcome needs verification" when they cannot — "reported" itself lives in run details only. Every workbench round of the same desktop task chains in time order in the detail, each keeping its own prompt, errors, and replies; earlier rounds load once each and survive late or transiently failing reads (late results still land, failures retry a bounded number of times, and a round confirmed absent is not retried). A native desktop task's detail reads the desktop's own read-only snapshot (phase 2): opening the detail or pressing refresh fetches one pass of the adapter's `--task-snapshot` mode through the `desktopTaskSnapshot` Remote — identity verified first against the workspace's own synced index by node, workspace, and the full `desktopTaskId`, then the conversation snapshot read over the official subscription path; opening a detail never runs `session/adopt`, never changes the desktop task, and never contends an executing controller (the read serializes behind dispatches on the node queue instead of pairing a second controller). The snapshot renders its bounded, scrubbed, desktop-ordered user/assistant/tool summary (assistant text through the same safe Markdown) with a recent-only note for the tail window; a failed read states `unavailable` with its reason, never fakes content from a workbench transcript, and is never polled on a timer.

Composing from a workspace arrives with the node and workspace preselected (no duplicate pickers; the target stays visible before sending, the server re-validates the location, and the route locks with the first dispatched prompt); the global New-task entry keeps the full picker. Un-routed Codex tasks appear on the home under "tasks awaiting a route"; their routing form shows the original prompt read-only, and the send stays disabled until that original has loaded — a race can never mint a second task. Continuing a completed desktop task is an explicit second mode inside the detail: "Continue this task" is enabled only while the desktop index proves `completed` and no round on that desktop task is in flight or of unknown outcome, and the disabled state names its reason (running, error, unknown status, index unavailable, pinned/archived and unverifiable). Sending goes through the dedicated `continueDesktopTask` request: the round is recorded as its own task carrying the original `desktopTaskId`, the adapter's `session/adopt` first verifies the task against the desktop's own `zcode-task/listTasks` index and live conversation snapshot (workspace ownership, completed, no pending interaction) before binding it, and the prompt rides `sendText`/`startNow` on that same desktop task — the adapter never falls back to creating a replacement. One desktop task admits at most one in-flight round per node and workspace (a second submission while one is running, or while its outcome is unknown, is refused), and a task the workbench already dispatched is continued on its existing binding. After a successful send the same desktop task's detail shows the new round marked "submitting/running".

A round whose desktop echo was lost (`echoLost`, e.g. the relay link died after the prompt left) keeps that lock on purpose: the desktop outcome is unknown, so the same original desktop task refuses a new follow-up until a human verifies it on site. Releasing it is the `reconcileEchoLostFollowup` maintenance Remote — an operator flow, not a panel surface: without `confirm` it runs the node adapter's read-only `--reconcile-dispatch` evidence pass and returns the site facts (task status, updated-at, live phase, pending interactions, whether the old instruction still appears in the desktop conversation); with `confirm: { humanVerified: true, operator }` it re-verifies the same evidence and writes the round off — the site adapter clears its unresolved dispatch ledger under the same attestation, this store appends one entry to `stateDir/reconcile-ledger.jsonl` (task, node, workspace, desktop task id, original command id, evidence summary, mode, operator, time — never the prompt text or credentials), and the record moves out of the unknown-outcome state. After that, `continueDesktopTask` accepts a **new** follow-up on the same original desktop task. The write-off never re-sends the old instruction, never creates a desktop task, and refuses conservatively on every contrary signal: a round still dispatching, a non-echo-lost round, a non-continuation round, a missing node, the instruction visible in the desktop conversation, the task running/awaiting input, unknown task state, unreadable evidence, or a duplicate write-off. Codex-origin tasks arrive through the local ingress:

```sh
curl -X POST http://127.0.0.1:<port>/zcode-workbench/ingress/tasks \
  -H "Authorization: Bearer $(cat <token file>)" \
  -d '{"source":"codex","sourceTaskId":"<codex task id>","threadId":"<thread>","prompt":"..."}'
```

Creation is idempotent by `source` + `sourceTaskId` + `threadId`: re-posting returns the same `workbenchTaskId` with `created: false`. `GET .../tasks/<workbenchTaskId>` reports status back to Codex and marks terminal tasks `reported`. The ingress accepts only loopback authorities and only with the token.

## Understand the implementation

<a id="understand-the-implementation"></a>

<details>
<summary>Implementation notes</summary>

- **Task state machine** (`src/state.ts`): `received → awaiting_route → dispatching → zcode_acknowledged → running → completed/failed/cancelled → reported`, with a refused-transition table shared by every entry point. The Zcode delivery facet (pending / acknowledged / running / terminal / echo_lost) is derived separately from execution failure, so the UI distinguishes a lost echo from a failed run from a task awaiting on-site input (the adapter's approval card). Delivery wording follows the evidence: `acknowledged` only means the prompt envelope was written to the node's adapter — worded *submitted · awaiting confirmation*, never "delivered"; the delivered wording appears only at `running` (the remote confirmed and is executing) or afterwards, and `echo_lost` reads *outcome unknown — verify on desktop*.
- **Idempotent store** (`src/store.ts`): one JSON file in `stateDir`, atomic tmp+rename writes serialized through one in-process chain; daily-sequence ids `WB-YYYYMMDD-NNN`; retention caps that never evict live tasks; capped transcript.
- **Dispatch layer** (`src/acp.ts`): spawns the node's adapter program and speaks the documented ACP surface — `initialize`, `session/new`, `session/set_config_option` (per-session workspace pin), `session/adopt` (continuation of an existing desktop task), `session/prompt`, `session/cancel` — consuming `session/update` notifications. `zcode_acknowledged` is recorded when the prompt envelope is about to leave the process (`promptSentAt`); from then on re-dispatch is refused — the desktop outcome may be unknown. Pre-ack failures are retryable under the same task id. Link-class failures after the ack keep the task non-terminal with `echoLost`, awaiting on-desktop verification. The same module also drives the adapter's read-only one-shot modes: `--health` probes, `--list-tasks` desktop task-index listings, and `--reconcile-dispatch` evidence/write-off passes (one short-lived process, no session, serialized with dispatches per node; the echo-lost round's prompt text crosses to the comparison over stdin and is never persisted by either side).
- **Follow-up write-off** (`src/index.ts`): the `reconcileEchoLostFollowup` Remote is the controlled maintenance entry for an echo-lost continuation round. It refuses everything except an echo-lost record with a recorded route (a live round, a known-outcome round, a fresh task, a vanished node), runs the adapter pass on the record's own node and workspace, and on the human-verified confirm appends one audit entry to the append-only `reconcile-ledger.jsonl` before clearing the record's `echoLost` in one serialized store transaction — so a torn run between the site write-off and the record update is retried safely from the adapter's idempotent `already-reconciled` report, and a duplicate write-off refuses atomically.
- **Ingress** (`src/ingress.ts`): one prefix route on the Host web server (`webServer.register` — the documented extension point; no core edits). Timing-safe bearer comparison against a re-read token file, loopback-only authority, bounded bodies, fixed-string errors.
- **Client** (`src/client/`): registers the `main` panel keyed `zcode-tasks` (workspace-first home, unified per-workspace task list, result-first detail with safe Markdown and collapsed run details, snapshot-backed native-task detail, preset-workspace composition) and the `settings.section` page for nodes; all copy is locale-owned (`zcode.workbench` namespace, zh key-complete by type); updates poll while mounted. The generated Typert remote contribution provides the RPC surface.
- **Task-center projection** (`src/taskCenter.ts`): the pure merge layer shared by the client — desktop index rows and workbench rounds become `TaskCenterItem`s keyed by `(nodeId, workspace scope, desktopTaskId)`, with evidence-driven main status (a failed newest round is never masked by a stale index sample), continuation gating, sorting, and filters; it holds no I/O and mutates nothing.
- **Node registry** (`src/nodes.ts`): launcher paths and labels only; health probes run `--health` and serialize with dispatches per node, matching the relay's single control channel per device.

</details>

## Model Experience

### Harness session, none through this package

#### What the model sees

Nothing. The plugin contributes no tools, no prompt sections, and no session events; dispatched tasks leave through the adapter's `session/prompt` and execute in the Zcode desktop, not in a Harness session.

#### Token effect

None. The plugin adds nothing to any Harness model's context; adapter dispatches are process I/O on the Host.

#### KV Cache effect

None. The plugin sends no model requests and changes no prompt prefixes.

## Known Limitations and Deferred Work

- One prompt turn per dispatch round; each continuation round is one turn on the original desktop task, and rounds must settle (or be written off through `reconcileEchoLostFollowup` after on-site verification) before the next one is accepted.
- The desktop protocol cannot prove a lost follow-up command was not applied; the write-off's `humanVerified` attestation carries that residual uncertainty (a snapshot tail window can have truncated history, and a post-dispatch task timestamp can be sync noise). The evidence report surfaces every fact the protocol does expose, and any contrary signal refuses instead of unlocking.
- A desktop task can only be continued while the desktop's own synced index still shows it as completed in the selected workspace — pinned, archived, or still-running tasks are outside this path (the adapter refuses them even if a stale list ever offered them).
- Task updates reach the Client by polling (2–3 s while visible); a Typert stream or event push is deferred.
- Surfaces survive a DSH Host restart in an already-open tab: a render failure is contained inside the surface, a temporarily unreachable Host shows a reconnect status while the last known list stays visible, and a re-established connection triggers an immediate re-pull plus re-selection of the task center panel when it was showing before the outage.
- The ingress trusts any loopback caller holding the token; per-origin quotas and revocation are deferred.
- `reportWorkspaceOptions`-style desktop metadata relies on the adapter's documented `--health` line and workspace option description formats.
- Real desktop-visible acceptance against a live Zcode site is owned by the operator's Codex run; this round verifies dispatch against the closed fixture agent only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Development notes</summary>

See the Agent Note [2026-09-21-zcode-workbench-plugin.md](../../../.agents/notes/implemented/feature/2026-09-21-zcode-workbench-plugin.md) for the decision record, [2026-09-24-zcode-workbench-continue-desktop-task.md](../../../.agents/notes/implemented/feature/2026-09-24-zcode-workbench-continue-desktop-task.md) for continuing an existing desktop task, and [2026-09-28-zcode-workbench-reconcile-followup.md](../../../.agents/notes/implemented/feature/2026-09-28-zcode-workbench-reconcile-followup.md) for the verify-then-release write-off of an echo-lost follow-up.

</details>
