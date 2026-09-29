/**
 * Pure JSON wire types shared by the Host service, the Typert Remote surface,
 * the HTTP ingress, and the Client panels. Every field crossing the Client or
 * ingress boundary is defined here and contains no connection address,
 * credential, or private configuration content.
 */

/** Where a task entered the workbench. */
export type WorkbenchTaskSource = 'codex' | 'workbench'

/**
 * Workbench task lifecycle. The chain is
 * received → awaiting_route → dispatching → zcode_acknowledged → running →
 * completed/failed/cancelled → reported; `received` is the creation instant and
 * tasks created with a complete route move directly to `dispatching`.
 */
export type WorkbenchTaskStatus =
  | 'received'
  | 'awaiting_route'
  | 'dispatching'
  | 'zcode_acknowledged'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'reported'

/** Terminal statuses a task report can be marked from. */
export type TerminalWorkbenchTaskStatus = 'completed' | 'failed' | 'cancelled'

/**
 * The execution outcome a record settled into before `reported` consumed it.
 * `reported` is an acknowledgment facet ("the origin saw the result"), not an
 * execution result: this field keeps the real terminal outcome queryable so a
 * reported task is never misread as successful. Null when the outcome predates
 * the field and the durable status trace cannot recover it.
 */
export type WorkbenchTerminalOutcome = TerminalWorkbenchTaskStatus | null

/** Zcode delivery facet: what the Zcode execution side has acknowledged. */
export type ZcodeDeliveryState = 'pending' | 'acknowledged' | 'running' | 'terminal' | 'echo_lost'

/** One dispatched Zcode node: an operator-configured ACP agent launcher. */
export interface ZcodeNodeRecord {
  /** Stable slug identifying the node inside the registry. */
  id: string
  /** Deployment grouping: this machine or a remote site. */
  kind: 'local' | 'remote'
  /** Operator-facing display name. */
  label: string
  /** Free-form deployment note (site, room, owner); never a credential. */
  siteLabel: string
  /** Adapter launcher executable (advanced setting). */
  command: string
  /** Adapter arguments including `--config <private config path>` (advanced setting). */
  args: string[]
  /** Whether the adapter pins one workspace (`fixed`) or selects per session (`session`). */
  workspaceSelection: 'fixed' | 'session'
  createdAt: string
  updatedAt: string
}

/** Last read-only health probe outcome for one node. */
export interface ZcodeNodeHealth {
  state: 'unknown' | 'checking' | 'online' | 'offline'
  checkedAt: string | null
  /** Desktop version as reported through the adapter, when known. */
  desktopVersion: string | null
  /** Workspaces the site reported, when known. */
  workspaceCount: number | null
  /** Fixed-string detail; never carries addresses or credentials. */
  detail: string | null
}

/** Client-facing node view: the record plus health, without secrets (there are none on the wire). */
export interface ZcodeNodeView extends ZcodeNodeRecord {
  health: ZcodeNodeHealth
}

/** Client-facing workspace option resolved from a node's own list. */
export interface ZcodeWorkspaceOption {
  /** Site workspace path; empty for `fixed` nodes whose pin lives in private adapter configuration. */
  path: string
  label: string
}

/** Result of reading one node's workspace options. */
export interface ZcodeWorkspaceListing {
  options: ZcodeWorkspaceOption[]
  desktopVersion: string | null
}

/** Persisted status vocabulary of one Zcode desktop task-index row. */
export type ZcodeDesktopTaskStatus = 'running' | 'completed' | 'error' | 'unknown'

/**
 * One task as the Zcode desktop's own synced task index reports it. This is
 * the desktop's capability boundary, not a full history: the index carries
 * the site's synced, non-pinned, non-archived tasks for one workspace.
 */
export interface ZcodeDesktopTaskView {
  /** Desktop task id; identical to the desktop conversation session id. Abbreviated in the UI. */
  taskId: string
  /** Task title as the desktop recorded it; empty when the desktop kept none. */
  title: string
  status: ZcodeDesktopTaskStatus
  createdAt: string
  updatedAt: string
  /** Whether the site adapter owns this task through a recorded binding. */
  origin: 'workbench' | 'desktop'
  /** The workbench task bound to this desktop task, when the join resolves. */
  workbenchTaskId: string | null
}

/**
 * Desktop facet of one workspace task listing. `unavailable` states the real
 * boundary — the desktop listing failed and must not be faked from any other
 * source — while the workbench-recorded side stays usable.
 */
export type ZcodeDesktopTasksFacet =
  | { state: 'ok'; desktopVersion: string | null; tasks: ZcodeDesktopTaskView[] }
  | { state: 'unavailable'; reason: string }

/** Tasks of one node workspace: the desktop-synced and workbench-recorded sides. */
export interface WorkspaceTasksView {
  nodeId: string
  /** Selected workspace path; null for `fixed` nodes whose pin lives in adapter configuration. */
  workspacePath: string | null
  /** Zcode desktop's own synced task index for this workspace. */
  desktop: ZcodeDesktopTasksFacet
  /** Workbench-recorded tasks routed to this node workspace, newest first. */
  workbench: WorkbenchTaskView[]
}

/**
 * One entry of a native desktop task's read-only conversation snapshot:
 * user or assistant text, or a compact tool card, in the desktop's own row
 * order. Text is scrubbed and capped adapter-side; nothing is guessed.
 */
export interface ZcodeDesktopTaskSnapshotEntry {
  /** Desktop row id; orders the entries exactly as the desktop recorded them. */
  rowId: number
  kind: 'user' | 'assistant' | 'tool'
  /** User or assistant text; null for tool entries. */
  text: string | null
  /** Tool name; null for text entries. */
  toolTitle: string | null
  /** Tool card status; null for text entries. */
  toolStatus: string | null
}

/** One read-only conversation snapshot of a native desktop task. */
export interface ZcodeDesktopTaskSnapshot {
  taskId: string
  /** Live conversation phase as the snapshot observed it. */
  phase: string | null
  pendingInteractions: number | null
  /**
   * The desktop's snapshot is a row tail window: `partial` stays true unless
   * the snapshot's own row total proves the window covers every row. A
   * partial read is recent-only content, never full history.
   */
  partial: boolean
  /** Rows the window actually carried. */
  rowCount: number
  /** Adapter-side sample time. */
  sampledAt: string
  summary: ZcodeDesktopTaskSnapshotEntry[]
}

/**
 * Native-task snapshot read result. `unavailable` states the real boundary —
 * the read failed, the task is not verifiable in the workspace's index, or
 * the conversation could not be read — and must never be faked.
 */
export type ZcodeDesktopTaskSnapshotResult =
  | { state: 'ok'; snapshot: ZcodeDesktopTaskSnapshot }
  | { state: 'unavailable'; reason: string }

/** One streamed task transcript entry, scrubbed and capped on the Host. */
export interface WorkbenchTranscriptEvent {
  at: string
  kind: 'status' | 'user_message' | 'assistant_message' | 'tool_call'
  /** Message or status text; the tool title for `tool_call`. */
  text: string | null
  /** Merge key: message id for `assistant_message`, tool-call id for `tool_call`; null otherwise. */
  key: string | null
  /** Tool card status; present only for `tool_call`. */
  toolStatus: string | null
}

/** Client-facing task summary used by the task center list. */
export interface WorkbenchTaskView {
  workbenchTaskId: string
  source: WorkbenchTaskSource
  sourceTaskId: string | null
  threadId: string | null
  title: string
  /** First characters of the task prompt. */
  promptPreview: string
  status: WorkbenchTaskStatus
  /**
   * The real execution outcome behind `reported`: terminal result that the
   * report acknowledgment never overwrites. Null only for legacy records whose
   * outcome cannot be recovered ("result needs verification").
   */
  terminalOutcome: WorkbenchTerminalOutcome
  /** Zcode delivery facet, distinct from execution failure. */
  zcodeDelivery: ZcodeDeliveryState
  /** The Zcode desktop awaits on-site input (approval) for this task. */
  awaitingInput: boolean
  /** Live output echo was lost; the desktop outcome is unknown and must be verified. */
  echoLost: boolean
  /** Fixed-string failure note; never carries addresses or credentials. */
  lastError: string | null
  nodeId: string | null
  nodeLabel: string | null
  workspacePath: string | null
  workspaceLabel: string | null
  /** ACP session id binding this task to its adapter, once created. */
  acpSessionId: string | null
  /**
   * The original Zcode desktop task this record continues, when the record is
   * a follow-up round sent into an existing desktop conversation. Null for
   * every fresh task; the desktop side stays one and the same task.
   */
  desktopTaskId: string | null
  createdAt: string
  updatedAt: string
}

/** Full task detail with the capped transcript. */
export interface WorkbenchTaskDetailView extends WorkbenchTaskView {
  /** The task's own prompt, full and bounded; the detail's "original question". */
  prompt: string
  transcript: WorkbenchTranscriptEvent[]
  /** Whether an unacknowledged failed dispatch may be retried under the same id. */
  retryAllowed: boolean
}

/** Ingress request body creating one Codex-origin task. */
export interface IngressCreateTaskRequest {
  source: 'codex'
  sourceTaskId: string
  threadId: string | null
  title: string | null
  prompt: string
}

/** Ingress response for task creation; idempotent by source identity. */
export interface IngressCreateTaskResponse {
  workbenchTaskId: string
  created: boolean
  status: WorkbenchTaskStatus
}

/** Ingress response describing one task for the origin caller. */
export interface IngressTaskStatusResponse {
  workbenchTaskId: string
  source: WorkbenchTaskSource
  status: WorkbenchTaskStatus
  /** Real execution outcome behind `reported`; never claimed as success. */
  terminalOutcome: WorkbenchTerminalOutcome
  zcodeDelivery: ZcodeDeliveryState
  awaitingInput: boolean
  echoLost: boolean
  lastError: string | null
  nodeId: string | null
  workspacePath: string | null
  /** Tail of the assistant answer, when one streamed. */
  resultPreview: string | null
  reported: boolean
}

/** New task composed in the workbench UI. */
export interface WorkbenchComposeRequest {
  title: string
  prompt: string
  nodeId: string
  workspacePath: string
}

/**
 * One follow-up round sent into an existing Zcode desktop task. Distinct from
 * `WorkbenchComposeRequest` on purpose: the adapter must adopt and continue
 * the named desktop task, never create a replacement conversation.
 */
export interface WorkbenchContinueRequest {
  /** Node whose adapter owns the workspace the desktop task belongs to. */
  nodeId: string
  /** Selected workspace; the adapter verifies the task belongs to it. */
  workspacePath: string
  /** Original desktop task (conversation session) id to continue. */
  desktopTaskId: string
  /** This round's follow-up instruction. */
  prompt: string
  /** Optional label for the workbench record of this round. */
  title: string
}

/** Route selection for an existing un-routed task. */
export interface WorkbenchRouteRequest {
  workbenchTaskId: string
  nodeId: string
  workspacePath: string
}

/**
 * Operator request to verify — and under an explicit human attestation, write
 * off — one echo-lost follow-up round, releasing the workbench and adapter
 * locks so the same original desktop task accepts a new follow-up.
 */
export interface WorkbenchReconcileFollowupRequest {
  workbenchTaskId: string
  /**
   * The write-off attestation. The desktop protocol cannot prove a lost
   * command was not applied, so the operator's verification on site carries
   * the residual uncertainty; without it the pass is read-only. Omitted, or
   * `humanVerified: false`, means evidence-only.
   */
  confirm?: { humanVerified: boolean; operator: string }
}

/** Result of one follow-up reconciliation pass against a node. */
export interface WorkbenchReconcileFollowupResult {
  workbenchTaskId: string
  desktopTaskId: string
  /** Whether the site-side unresolved dispatch was (or had already been) written off. */
  writtenOff: boolean
  /** Whether this pass cleared the workbench record's follow-up lock. */
  workbenchRecordUpdated: boolean
  /** Fixed-string site evidence; carries no prompt text or credentials. */
  evidence: {
    taskStatus: string | null
    taskUpdatedAt: string | null
    phase: string | null
    pendingInteractions: number | null
    promptMatched: boolean | null
  }
  /** Command id of the written-off dispatch, when the site reported one. */
  commandId: string | null
}

/** Ingress reachability summary for the settings page; carries no token. */
export interface IngressInfo {
  path: string
  provisioned: boolean
}

/** Create-or-update submission for one dispatched Zcode node. */
export interface WorkbenchNodeInput {
  id: string
  kind: 'local' | 'remote'
  label: string
  siteLabel: string
  command: string
  args: string[]
  workspaceSelection: 'fixed' | 'session'
}

/**
 * Fixed-string marker embedded in adapter-capability failures meaning "the
 * adapter completed session/new without a per-session workspace option" — the
 * classic fixed-workspace adapter saved as a per-session node (its `--health`
 * can still answer online with workspaces, which is exactly why health alone
 * never proves routing will work). Host-side messages carry it verbatim so the
 * client can map it to an actionable localized hint.
 */
export const NO_WORKSPACE_OPTION_MARKER = 'answered session/new without offering a workspace option'
