/**
 * Pure workspace-task projection for the task center: it merges the Zcode
 * desktop's synced task index with the workbench's recorded rounds into the
 * unified `TaskCenterItem` rows the list renders. The layer is a projection
 * only — it never mutates persistent tasks or adapter bindings, holds no I/O,
 * and imports nothing beyond the wire types, so the Host and the Client bundle
 * share the exact same merge semantics.
 *
 * Identity is `(nodeId, workspace scope, desktopTaskId)`. Rows merge only
 * through verified links: a record's own `desktopTaskId`, or the adapter
 * binding join the Host computed from its session ledger. Titles, short ids,
 * and same-looking paths never merge anything, and two nodes serving the same
 * site path stay separate lists.
 */
import type {
  TerminalWorkbenchTaskStatus, WorkbenchTaskStatus, WorkbenchTaskView, WorkspaceTasksView,
  ZcodeDesktopTaskStatus,
} from './types.ts'

/**
 * Row cap of the adapter's `--list-tasks` report. A listing at or beyond this
 * length cannot prove completeness, so the list must say "recent 200 only".
 */
export const DESKTOP_INDEX_ROW_CAP = 200

/**
 * User-facing main status of one unified item, derived from the evidence
 * rather than from any single raw status vocabulary. `reported` never appears
 * here: it is an acknowledgment facet shown in run details, while the item
 * keeps the real outcome (`unknown` when the outcome cannot be verified).
 */
export type TaskCenterMainStatus =
  | 'needs_route' // no route chosen yet — pick node and workspace
  | 'submitting' // dispatching or only the prompt envelope was acknowledged
  | 'running' // the desktop confirmed execution
  | 'needs_input' // the desktop awaits on-site interaction
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown' // desktop outcome unknown or unverifiable

/** Status filter buckets of the unified list. */
export type TaskCenterFilter = 'all' | 'active' | 'completed' | 'attention'

/** How one unified item opens its detail surface. */
export type TaskCenterOpenTarget =
  | { kind: 'workbench'; workbenchTaskId: string }
  | { kind: 'native'; desktopTaskId: string }

/** Why a desktop task currently refuses continuation; null when continuable. */
export type NotContinuableReason =
  | 'round_in_flight' // a round is still dispatching/running or its outcome is unknown
  | 'echo_lost' // a round's delivery could not be confirmed — verify on the desktop first
  | 'round_unsuccessful' // the newest round settled failed/cancelled more recently than the index sample
  | 'desktop_running'
  | 'desktop_error'
  | 'desktop_unknown_status'
  | 'not_in_index' // the task is not verifiable in the current desktop index (pinned/archived/dropped)
  | 'index_unavailable' // the desktop index itself is unavailable

/**
 * One unified task-center row: a desktop task with every workbench round the
 * evidence binds to it, or a standalone workbench record nothing binds yet.
 */
export interface TaskCenterItem {
  /** Stable identity: node + workspace scope + desktop task (or record) id. */
  key: string
  nodeId: string
  /** Selected workspace path; null for fixed nodes (pin lives in adapter config). */
  workspacePath: string | null
  /** Desktop task (conversation session) id; null for unbound workbench records. */
  desktopTaskId: string | null
  /** Workbench rounds bound to this desktop task, oldest first. */
  rounds: WorkbenchTaskView[]
  /** Which detail opens first: the newest round, or the native summary. */
  open: TaskCenterOpenTarget
  title: string
  /** Lightweight source label: where the task entered. */
  source: 'codex' | 'workbench' | 'desktop'
  mainStatus: TaskCenterMainStatus
  /** Desktop index row status, when the index covers this task. */
  desktopStatus: ZcodeDesktopTaskStatus | null
  createdAt: string
  updatedAt: string
  awaitingInput: boolean
  echoLost: boolean
  /** Whether the current evidence proves this desktop task may be continued. */
  continuable: boolean
  /** Why continuation is refused; null exactly while `continuable` holds. */
  notContinuableReason: NotContinuableReason | null
  /** Last content preview: the newest round's prompt tail, else the title. */
  preview: string
}

/** The workspace scope one projection run covers. */
export interface WorkspaceTaskScope {
  nodeId: string
  /** Selected workspace path; null for fixed nodes. */
  workspacePath: string | null
}

/** Statuses under which a round still owns the desktop task's follow-up slot. */
const ROUND_IN_FLIGHT: ReadonlySet<WorkbenchTaskStatus> = new Set([
  'received', 'awaiting_route', 'dispatching', 'zcode_acknowledged', 'running',
])

/** Statuses sorted first: needs handling and in-flight before settled rows. */
const HANDLING_FIRST: ReadonlySet<TaskCenterMainStatus> = new Set([
  'needs_route', 'submitting', 'running', 'needs_input', 'unknown',
])

/**
 * The execution outcome a task view really settled into. `reported` is an
 * acknowledgment facet, so its recorded `terminalOutcome` answers instead of
 * the status itself; anything unsettled answers null.
 * @param view - task view carrying status and terminalOutcome.
 * @returns the real terminal outcome, or null while unsettled/unrecoverable.
 */
export function outcomeOf(view: Pick<WorkbenchTaskView, 'status' | 'terminalOutcome'>): TerminalWorkbenchTaskStatus | null {
  if (view.status === 'completed' || view.status === 'failed' || view.status === 'cancelled') return view.status
  if (view.status === 'reported') return view.terminalOutcome
  return null
}

/**
 * Main status of one workbench round view, reported-safe: a reported round
 * keeps its real outcome instead of reading as a new success state.
 * @param view - task view.
 * @returns the user-facing main status of the round.
 */
export function mainStatusOfView(view: WorkbenchTaskView): TaskCenterMainStatus {
  if (view.echoLost) return 'unknown'
  if (view.awaitingInput) return 'needs_input'
  if (view.status === 'reported') return view.terminalOutcome ?? 'unknown'
  switch (view.status) {
    case 'received':
    case 'awaiting_route': return 'needs_route'
    case 'dispatching':
    case 'zcode_acknowledged': return 'submitting'
    case 'running': return 'running'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
  }
}

/** Main status of one desktop index row. */
function mainStatusOfDesktopRow(status: ZcodeDesktopTaskStatus): TaskCenterMainStatus {
  if (status === 'running') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'error') return 'failed'
  return 'unknown'
}

/** Main status of a settled terminal outcome. */
function mainStatusOfOutcome(outcome: TerminalWorkbenchTaskStatus): TaskCenterMainStatus {
  if (outcome === 'completed') return 'completed'
  if (outcome === 'failed') return 'failed'
  return 'cancelled'
}

/** Parse an ISO timestamp defensively; unreadable values sort oldest. */
function timeOf(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Merge the desktop's synced task index and the workbench's recorded rounds of
 * one workspace into unified items. Deduplication is evidence-driven only:
 * a desktop row and records join when a record carries the row's task id or
 * the Host's verified binding join named the record. Unmatched records stay
 * visible as standalone items — unrouted, undelivered, echo-lost, or simply
 * not covered by the index — and are never merged by title or short id.
 *
 * @param scope - node and workspace the listing covers.
 * @param desktop - the desktop index facet (`unavailable` keeps records listed).
 * @param records - workbench task views of this workspace, any order.
 * @returns unified items, needs-handling/in-flight first then newest first.
 */
export function mergeWorkspaceTasks(
  scope: WorkspaceTaskScope,
  desktop: WorkspaceTasksView['desktop'],
  records: readonly WorkbenchTaskView[],
): TaskCenterItem[] {
  const scopeKey = `${scope.nodeId}::${scope.workspacePath ?? '__fixed__'}`
  const byWorkbenchId = new Map(records.map(record => [record.workbenchTaskId, record]))
  const roundsByDesktopId = new Map<string, WorkbenchTaskView[]>()
  for (const record of records) {
    if (record.desktopTaskId === null) continue
    const rounds = roundsByDesktopId.get(record.desktopTaskId) ?? []
    rounds.push(record)
    roundsByDesktopId.set(record.desktopTaskId, rounds)
  }
  const items: TaskCenterItem[] = []
  const seenDesktopIds = new Set<string>()
  // Workbench records consumed by a desktop row (either join); standalone
  // rendering skips exactly these.
  const mergedIntoRows = new Set<string>()
  if (desktop.state === 'ok') {
    for (const row of desktop.tasks) {
      if (row.taskId.length === 0 || seenDesktopIds.has(row.taskId)) continue
      seenDesktopIds.add(row.taskId)
      // Verified joins only: the record's own desktopTaskId link, plus the
      // Host's adapter-binding join when it named a record of this listing.
      const rounds = [...(roundsByDesktopId.get(row.taskId) ?? [])]
      if (row.workbenchTaskId !== null && !rounds.some(round => round.workbenchTaskId === row.workbenchTaskId)) {
        const joined = byWorkbenchId.get(row.workbenchTaskId)
        if (joined !== undefined && joined.desktopTaskId === null) rounds.push(joined)
      }
      for (const round of rounds) mergedIntoRows.add(round.workbenchTaskId)
      items.push(buildItem(scope, scopeKey, row.taskId, rounds, row.status, row.title, row.createdAt, row.updatedAt, row.origin, desktop))
    }
  }
  // Standalone records, still one row per desktop conversation: rounds whose
  // verified `desktopTaskId` names a task the index does not currently cover
  // (pinned, archived, dropped, or the whole index is unavailable) group by
  // that id, while truly unbound records — unrouted, undelivered, or a fresh
  // compose round nothing verified links yet — stay one row per record.
  const indexMissedGroups = new Map<string, WorkbenchTaskView[]>()
  for (const record of records) {
    if (mergedIntoRows.has(record.workbenchTaskId)) continue
    if (record.desktopTaskId === null) {
      items.push(buildItem(scope, scopeKey, null, [record], null, record.title, record.createdAt, record.updatedAt, null, desktop))
      continue
    }
    const group = indexMissedGroups.get(record.desktopTaskId) ?? []
    group.push(record)
    indexMissedGroups.set(record.desktopTaskId, group)
  }
  for (const [desktopTaskId, group] of indexMissedGroups) {
    items.push(buildItem(scope, scopeKey, desktopTaskId, group, null, '', '', '', null, desktop))
  }
  return sortItems(items)
}

/** Assemble one unified item from its evidence. */
function buildItem(
  scope: WorkspaceTaskScope,
  scopeKey: string,
  desktopTaskId: string | null,
  roundsInput: WorkbenchTaskView[],
  desktopStatus: ZcodeDesktopTaskStatus | null,
  desktopTitle: string,
  desktopCreatedAt: string,
  desktopUpdatedAt: string,
  desktopOrigin: 'workbench' | 'desktop' | null,
  desktop: WorkspaceTasksView['desktop'],
): TaskCenterItem {
  const rounds = [...roundsInput].sort((left, right) => timeOf(left.createdAt) - timeOf(right.createdAt)
    || left.workbenchTaskId.localeCompare(right.workbenchTaskId))
  const newestRound = rounds.length > 0 ? rounds[rounds.length - 1]! : null
  const awaitingInput = rounds.some(round => round.awaitingInput)
  const echoLost = rounds.some(round => round.echoLost)
  const inFlightRound = rounds.find(round => ROUND_IN_FLIGHT.has(round.status)) ?? null
  const newestOutcome = outcomeOf(newestRound ?? { status: 'received', terminalOutcome: null })
  // Main status follows the strongest live evidence: on-site input and lost
  // outcomes outrank everything; an in-flight round outranks the sampled index
  // row. Beyond that the freshest terminal fact wins by timestamp — a failed
  // newest round must not be masked by a stale index sample that still shows
  // the previous round's completion, and a desktop task someone resumed after
  // the last round settled must not read as settled here.
  let mainStatus: TaskCenterMainStatus
  if (awaitingInput) mainStatus = 'needs_input'
  else if (echoLost) mainStatus = 'unknown'
  else if (inFlightRound !== null) mainStatus = mainStatusOfView(inFlightRound)
  else if (newestOutcome !== null && (desktopStatus === null || timeOf(newestRound!.updatedAt) >= timeOf(desktopUpdatedAt))) {
    mainStatus = mainStatusOfOutcome(newestOutcome)
  }
  else if (desktopStatus !== null) mainStatus = mainStatusOfDesktopRow(desktopStatus)
  else if (newestRound !== null) mainStatus = mainStatusOfView(newestRound)
  else mainStatus = 'unknown'
  const updatedAt = rounds.reduce((latest, round) => timeOf(round.updatedAt) > timeOf(latest) ? round.updatedAt : latest, desktopUpdatedAt)
  const createdAt = rounds.length > 0
    ? rounds.reduce((earliest, round) => timeOf(round.createdAt) < timeOf(earliest) ? round.createdAt : earliest, rounds[0]!.createdAt)
    : desktopCreatedAt
  const title = desktopTitle.trim().length > 0 ? desktopTitle : newestRound?.title ?? ''
  const source: TaskCenterItem['source'] = rounds.some(round => round.source === 'codex')
    ? 'codex'
    : rounds.length > 0 || desktopOrigin === 'workbench' ? 'workbench' : 'desktop'
  const open: TaskCenterOpenTarget = newestRound !== null
    ? { kind: 'workbench', workbenchTaskId: newestRound.workbenchTaskId }
    : { kind: 'native', desktopTaskId: desktopTaskId! }
  return {
    key: `${scopeKey}::${desktopTaskId ?? `wb-${newestRound?.workbenchTaskId ?? ''}`}`,
    nodeId: scope.nodeId,
    workspacePath: scope.workspacePath,
    desktopTaskId,
    rounds,
    open,
    title,
    source,
    mainStatus,
    desktopStatus,
    createdAt,
    updatedAt,
    awaitingInput,
    echoLost,
    ...continuationEvidence(desktopTaskId, desktopStatus, desktopUpdatedAt, desktop, rounds),
    preview: newestRound !== null ? newestRound.promptPreview : title,
  }
}

/**
 * Continuation evidence per design: enabled only when the desktop index
 * itself proves the task completed and no round still owns the follow-up slot
 * (in flight or outcome unknown). Everything else names its refusal reason.
 */
function continuationEvidence(
  desktopTaskId: string | null,
  desktopStatus: ZcodeDesktopTaskStatus | null,
  desktopUpdatedAt: string,
  desktop: WorkspaceTasksView['desktop'],
  rounds: readonly WorkbenchTaskView[],
): { continuable: boolean; notContinuableReason: NotContinuableReason | null } {
  const echoLostRound = rounds.find(round => round.echoLost) ?? null
  if (echoLostRound !== null) return { continuable: false, notContinuableReason: 'echo_lost' }
  const inFlightRound = rounds.find(round => ROUND_IN_FLIGHT.has(round.status)) ?? null
  if (inFlightRound !== null) return { continuable: false, notContinuableReason: 'round_in_flight' }
  // An unavailable index is the primary blocker for every row: nothing about
  // the desktop side can be verified while it is down.
  if (desktop.state !== 'ok') return { continuable: false, notContinuableReason: 'index_unavailable' }
  if (desktopTaskId === null) return { continuable: false, notContinuableReason: 'not_in_index' }
  if (desktopStatus === null) return { continuable: false, notContinuableReason: 'not_in_index' }
  // Freshest-evidence conservatism: a newest round that settled failed or
  // cancelled AFTER the index was sampled outranks the stale completed row —
  // the button waits for a fresher sample (or on-site verification); the
  // adapter's adopt re-verifies regardless once the send actually happens.
  const newestRound = rounds.length > 0 ? rounds[rounds.length - 1]! : null
  if (newestRound !== null) {
    const outcome = outcomeOf(newestRound)
    if ((outcome === 'failed' || outcome === 'cancelled') && timeOf(newestRound.updatedAt) >= timeOf(desktopUpdatedAt)) {
      return { continuable: false, notContinuableReason: 'round_unsuccessful' }
    }
  }
  if (desktopStatus === 'running') return { continuable: false, notContinuableReason: 'desktop_running' }
  if (desktopStatus === 'error') return { continuable: false, notContinuableReason: 'desktop_error' }
  if (desktopStatus === 'unknown') return { continuable: false, notContinuableReason: 'desktop_unknown_status' }
  return { continuable: true, notContinuableReason: null }
}

/**
 * Needs-handling and in-flight items first, then by latest activity descending;
 * equal timestamps keep their input order (stable relative order).
 * @param items - unified items in any order.
 * @returns the sorted items.
 */
export function sortItems(items: readonly TaskCenterItem[]): TaskCenterItem[] {
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const rankLeft = HANDLING_FIRST.has(left.item.mainStatus) ? 0 : 1
      const rankRight = HANDLING_FIRST.has(right.item.mainStatus) ? 0 : 1
      if (rankLeft !== rankRight) return rankLeft - rankRight
      const timeDelta = timeOf(right.item.updatedAt) - timeOf(left.item.updatedAt)
      if (timeDelta !== 0) return timeDelta
      return left.index - right.index
    })
    .map(entry => entry.item)
}

/**
 * Apply one status filter bucket.
 * @param items - unified items.
 * @param filter - filter bucket.
 * @returns the items the bucket keeps, order preserved.
 */
export function applyTaskCenterFilter(items: readonly TaskCenterItem[], filter: TaskCenterFilter): TaskCenterItem[] {
  return items.filter(item => {
    switch (filter) {
      case 'all': return true
      case 'active': return item.mainStatus === 'submitting' || item.mainStatus === 'running'
      case 'completed': return item.mainStatus === 'completed'
      case 'attention': return item.mainStatus === 'needs_route' || item.mainStatus === 'needs_input' || item.mainStatus === 'unknown'
    }
  })
}

/**
 * Whether a desktop listing at this row count cannot prove completeness and
 * must render the "recent rows only" note.
 * @param rowCount - rows the desktop facet reported.
 * @returns whether the listing may be truncated at the adapter cap.
 */
export function desktopListingMayBeTruncated(rowCount: number): boolean {
  return rowCount >= DESKTOP_INDEX_ROW_CAP
}
