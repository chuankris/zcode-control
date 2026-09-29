/**
 * Pure task state machine: transition validation, retry/route-lock rules, and
 * view projection. The store owns persistence; this module owns which moves
 * are legal so every entry point (ingress, Client RPC, dispatch layer) enforces
 * the same chain.
 */
import type {
  TerminalWorkbenchTaskStatus, WorkbenchTaskSource, WorkbenchTaskStatus,
  WorkbenchTaskView, WorkbenchTranscriptEvent, ZcodeDeliveryState,
} from './types.ts'

/** Internal durable task record; the persisted shape. */
export interface WorkbenchTaskRecord {
  workbenchTaskId: string
  source: WorkbenchTaskSource
  sourceTaskId: string | null
  threadId: string | null
  title: string
  prompt: string
  status: WorkbenchTaskStatus
  /** Node route, once chosen. Immutable after the first dispatched prompt. */
  nodeId: string | null
  nodeLabel: string | null
  workspacePath: string | null
  workspaceLabel: string | null
  acpSessionId: string | null
  /**
   * Original desktop task this record continues (`null` for fresh tasks).
   * Pinned at creation of a continuation round; never rewritten afterwards.
   */
  desktopTaskId: string | null
  /** Set the moment the first prompt envelope is written to an adapter. */
  promptSentAt: string | null
  awaitingInput: boolean
  echoLost: boolean
  lastError: string | null
  transcript: WorkbenchTranscriptEvent[]
  createdAt: string
  updatedAt: string
}

/** Legal status transitions; `reported` is reachable only from terminal states. */
const TRANSITIONS: Readonly<Record<WorkbenchTaskStatus, readonly WorkbenchTaskStatus[]>> = {
  received: ['awaiting_route', 'dispatching'],
  awaiting_route: ['dispatching'],
  dispatching: ['zcode_acknowledged', 'failed'],
  zcode_acknowledged: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: ['reported'],
  failed: ['reported', 'dispatching'],
  cancelled: ['reported'],
  reported: [],
}

/**
 * Whether one status move is legal in the workbench chain.
 * @param from - current status.
 * @param to - requested status.
 * @returns whether `from → to` is a legal move of the workbench chain.
 */
export function transitionAllowed(from: WorkbenchTaskStatus, to: WorkbenchTaskStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * Whether one status is terminal, i.e. one a report may be marked from.
 * @param status - status to test.
 * @returns whether the status is terminal, i.e. one a report may be marked from.
 */
export function isTerminal(status: WorkbenchTaskStatus): status is TerminalWorkbenchTaskStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * A failed task may re-enter dispatch only when nothing was ever sent to a
 * Zcode side: no prompt envelope left the workbench for it. Every failure
 * after `promptSentAt` keeps the id and refuses re-dispatch — the outcome on
 * the desktop is unknown and a second dispatch could duplicate the task.
 */
/**
 * Whether a failed task may re-enter dispatch.
 * @param record - durable task record.
 * @returns whether the failed task may re-enter dispatch under the same id.
 */
export function retryAllowed(record: WorkbenchTaskRecord): boolean {
  return record.status === 'failed' && record.promptSentAt === null
}

/**
 * The route of a task locks at the first prompt envelope. Before that a task
 * may (re)choose node and workspace; after it the binding is immutable.
 */
/**
 * Whether the task's route locked at its first prompt envelope.
 * @param record - durable task record.
 * @returns whether the task's route locked at its first prompt envelope.
 */
export function routeLocked(record: WorkbenchTaskRecord): boolean {
  return record.promptSentAt !== null
}

/**
 * The Zcode delivery facet derived from the chain: what the Zcode execution
 * side has acknowledged, independent of whether the run later failed.
 */
/**
 * The Zcode delivery facet of one record, derived from the chain.
 * @param record - durable task record.
 * @returns the Zcode delivery facet derived from the chain.
 */
export function zcodeDeliveryOf(record: WorkbenchTaskRecord): ZcodeDeliveryState {
  if (record.echoLost) return 'echo_lost'
  if (record.promptSentAt === null) return 'pending'
  if (isTerminal(record.status) || record.status === 'reported') return 'terminal'
  if (record.status === 'running') return 'running'
  return 'acknowledged'
}

/** Characters of the prompt preview surfaced in list views. */
export const PROMPT_PREVIEW_CHARS = 160

/** Characters of the assistant tail the ingress reports back to the origin. */
export const RESULT_PREVIEW_CHARS = 2000

/**
 * Project the durable record into the Client-facing summary. The projection
 * is total: every derived facet is computed here once.
 * @param record - durable task record.
 * @returns independent wire view without the full prompt or transcript.
 */
export function projectTaskView(record: WorkbenchTaskRecord): WorkbenchTaskView {
  return {
    workbenchTaskId: record.workbenchTaskId,
    source: record.source,
    sourceTaskId: record.sourceTaskId,
    threadId: record.threadId,
    title: record.title,
    promptPreview: record.prompt.slice(0, PROMPT_PREVIEW_CHARS),
    status: record.status,
    zcodeDelivery: zcodeDeliveryOf(record),
    awaitingInput: record.awaitingInput,
    echoLost: record.echoLost,
    lastError: record.lastError,
    nodeId: record.nodeId,
    nodeLabel: record.nodeLabel,
    workspacePath: record.workspacePath,
    workspaceLabel: record.workspaceLabel,
    acpSessionId: record.acpSessionId,
    desktopTaskId: record.desktopTaskId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Tail of the last streamed assistant message, for origin reporting.
 * @param record - durable task record.
 * @returns the capped assistant tail, or null when none streamed.
 */
export function resultPreviewOf(record: WorkbenchTaskRecord): string | null {
  for (let index = record.transcript.length - 1; index >= 0; index -= 1) {
    const event = record.transcript[index]
    if (event !== undefined && event.kind === 'assistant_message' && event.text !== null) {
      const text = event.text
      return text.length > RESULT_PREVIEW_CHARS ? `…${text.slice(-RESULT_PREVIEW_CHARS)}` : text
    }
  }
  return null
}
