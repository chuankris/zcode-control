/**
 * Client surfaces of the Zcode workbench. The `main` panel is the task center:
 * workspace-first on every screen — a home of nodes and their workspaces, a
 * unified task list per workspace (the desktop's synced index merged with the
 * workbench's rounds through the pure `taskCenter` projection), and a
 * result-first task detail with safe Markdown and evidence-gated continuation.
 * Wide screens show the three columns side by side; narrow screens navigate
 * level by level with explicit backs. All Host access goes through the
 * injected action face; surfaces hold only view state and poll while mounted.
 * They are restart-safe: a render failure is contained inside the surface, and
 * connection loss shows a reconnect status while polling keeps running, so the
 * workbench rehydrates by itself once the Host is back.
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NO_WORKSPACE_OPTION_MARKER } from '../types.ts'
import {
  applyTaskCenterFilter, desktopListingMayBeTruncated, mainStatusOfView, mergeWorkspaceTasks,
  type NotContinuableReason, type TaskCenterFilter, type TaskCenterItem, type TaskCenterMainStatus,
  type TaskCenterOpenTarget,
} from '../taskCenter.ts'
import type {
  IngressInfo, WorkbenchComposeRequest, WorkbenchContinueRequest, WorkbenchNodeInput, WorkbenchRouteRequest,
  WorkbenchTaskDetailView, WorkbenchTaskStatus, WorkbenchTaskView, WorkbenchTranscriptEvent, WorkspaceTasksView,
  ZcodeDesktopTaskSnapshotEntry, ZcodeDesktopTaskSnapshotResult, ZcodeDesktopTaskStatus,
  ZcodeNodeView, ZcodeWorkspaceListing,
} from '../types.ts'
import { MarkdownMessage } from './markdown.tsx'
import type { WorkbenchKey } from './locales.ts'
import css from './style.module.css'

/** Status → dictionary key, keeping the translate calls fully typed. */
const STATUS_KEYS: Record<WorkbenchTaskStatus, WorkbenchKey> = {
  received: 'status_received',
  awaiting_route: 'status_awaiting_route',
  dispatching: 'status_dispatching',
  zcode_acknowledged: 'status_zcode_acknowledged',
  running: 'status_running',
  completed: 'status_completed',
  failed: 'status_failed',
  cancelled: 'status_cancelled',
  reported: 'status_reported',
}

/** Delivery facet → dictionary key (run details only). */
const DELIVERY_KEYS: Record<WorkbenchTaskView['zcodeDelivery'], WorkbenchKey> = {
  pending: 'delivery_pending',
  acknowledged: 'delivery_acknowledged',
  running: 'delivery_running',
  terminal: 'delivery_terminal',
  echo_lost: 'delivery_echo_lost',
}

/** Desktop task-index status → dictionary key. */
const DESKTOP_STATUS_KEYS: Record<ZcodeDesktopTaskStatus, WorkbenchKey> = {
  running: 'desktopStatus_running',
  completed: 'desktopStatus_completed',
  error: 'desktopStatus_error',
  unknown: 'desktopStatus_unknown',
}

/** Unified main status → dictionary key. */
const MAIN_STATUS_KEYS: Record<TaskCenterMainStatus, WorkbenchKey> = {
  needs_route: 'mainStatus_needs_route',
  submitting: 'mainStatus_submitting',
  running: 'mainStatus_running',
  needs_input: 'mainStatus_needs_input',
  completed: 'mainStatus_completed',
  failed: 'mainStatus_failed',
  cancelled: 'mainStatus_cancelled',
  unknown: 'mainStatus_unknown',
}

/** Unified main status → pill tone class. */
function mainPillClassOf(status: TaskCenterMainStatus): string | undefined {
  if (status === 'completed') return css.pillOk
  if (status === 'failed') return css.pillFail
  if (status === 'cancelled') return css.pillMuted
  return css.pillWarn
}

/** Why continuation is currently refused → dictionary key. */
const NOT_CONTINUABLE_KEYS: Record<NotContinuableReason, WorkbenchKey> = {
  round_in_flight: 'notContinuable_round_in_flight',
  echo_lost: 'notContinuable_echo_lost',
  round_unsuccessful: 'notContinuable_round_unsuccessful',
  desktop_running: 'notContinuable_running',
  desktop_error: 'notContinuable_error',
  desktop_unknown_status: 'notContinuable_unknown',
  not_in_index: 'notContinuable_not_in_index',
  index_unavailable: 'notContinuable_index_unavailable',
}

/** Source label → dictionary key. */
function sourceKeyOf(source: TaskCenterItem['source']): WorkbenchKey {
  if (source === 'codex') return 'sourceCodex'
  if (source === 'desktop') return 'sourceDesktop'
  return 'sourceWorkbench'
}

/**
 * Abbreviate a stable session/task id for display: the leading characters keep
 * it recognizable and matchable while the full value stays for run details.
 */
function abbreviateId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 10)}…`
}

/** Host operations injected into both surfaces. */
export interface WorkbenchActions {
  nodes: () => Promise<ZcodeNodeView[]>
  saveNode: (input: WorkbenchNodeInput) => Promise<ZcodeNodeView>
  removeNode: (id: string) => Promise<boolean>
  checkNode: (id: string) => Promise<ZcodeNodeView>
  listWorkspaces: (nodeId: string) => Promise<ZcodeWorkspaceListing>
  workspaceTasks: (nodeId: string, workspacePath: string) => Promise<WorkspaceTasksView>
  /**
   * Read one native desktop task's conversation snapshot (read-only; never
   * adopts). Called on opening a native detail and on manual refresh only —
   * never on a timer, so it cannot contend the site's controller slot.
   */
  desktopTaskSnapshot: (nodeId: string, workspacePath: string, desktopTaskId: string) => Promise<ZcodeDesktopTaskSnapshotResult>
  tasks: () => Promise<WorkbenchTaskView[]>
  task: (id: string) => Promise<WorkbenchTaskDetailView | undefined>
  composeTask: (request: WorkbenchComposeRequest) => Promise<WorkbenchTaskView>
  continueDesktopTask: (request: WorkbenchContinueRequest) => Promise<WorkbenchTaskView>
  routeTask: (request: WorkbenchRouteRequest) => Promise<WorkbenchTaskView>
  retryTask: (id: string) => Promise<WorkbenchTaskView>
  cancelTask: (id: string) => Promise<WorkbenchTaskView>
  ingressInfo: () => Promise<IngressInfo>
}

/** Client runtime seats the plugin may inject beside the Host action face. */
export interface WorkbenchRuntimeState {
  /**
   * Live client→Host connection state; absent when the plugin runs without
   * the recovery glue (component tests), in which case surfaces assume a
   * healthy connection and show ordinary action errors.
   */
  readonly connection?: WorkbenchConnection | undefined
}

/** Client-side observable of the connection lifecycle, injected by the plugin. */
export interface WorkbenchConnection {
  /** Current state; `undefined` from the carrier maps to `connecting`. */
  getSnapshot(): WorkbenchConnectionSnapshot
  /** Subscribe to state changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/** Connection lifecycle the surfaces render. */
export type WorkbenchConnectionSnapshot = 'connected' | 'connecting' | 'disconnected'

/** Main-panel props: framework runtime seats, locale, and the Host action face. */
export type WorkbenchPanelProps = PropsRuntime<'main'> & PropsLocale<'zcode.workbench'> & WorkbenchActions & Partial<WorkbenchRuntimeState>

/** Settings-section props for the node administration page. */
export type NodeSettingsProps = PropsRuntime<'settings.section'> & PropsLocale<'zcode.workbench'> & WorkbenchActions & Partial<WorkbenchRuntimeState>

// ---- Host-restart recovery plumbing (module-scoped, plugin-driven) ---------

type WorkbenchRefreshListener = () => void

const refreshListeners = new Set<WorkbenchRefreshListener>()

/**
 * Subscribe to the reconnect notification: the plugin fires it on every
 * `connection/reset`, so mounted surfaces re-pull immediately instead of
 * waiting out their poll interval.
 * @param listener - callback invoked on each reconnect.
 * @returns unsubscribe function.
 */
export function subscribeWorkbenchRefresh(listener: WorkbenchRefreshListener): () => void {
  refreshListeners.add(listener)
  return () => { refreshListeners.delete(listener) }
}

/**
 * Notify every mounted surface that the Host connection was re-established.
 * Listener failures are contained: one broken surface never blocks the others.
 */
export function notifyWorkbenchRefresh(): void {
  for (const listener of [...refreshListeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[zcode-workbench] refresh listener threw:', error)
    }
  }
}

let workbenchPanelOpenIntent = false

/** Record that the workbench main panel is showing (its keyed slot is active). */
export function recordWorkbenchPanelMounted(): void {
  workbenchPanelOpenIntent = true
}

/**
 * Record the panel leaving the screen. A healthy-connection unmount is a user
 * navigation, so the open intent drops; an unmount while the connection is
 * down or reconnecting may be Host-restart churn rekeying the slot, so the
 * intent survives and the plugin re-opens the panel after recovery.
 * @param healthyConnection - whether the client was connected at unmount time.
 */
export function recordWorkbenchPanelUnmounted(healthyConnection: boolean): void {
  if (healthyConnection) workbenchPanelOpenIntent = false
}

/** Whether the user last saw the workbench panel open. */
export function readWorkbenchPanelOpenIntent(): boolean {
  return workbenchPanelOpenIntent
}

/**
 * Contain a surface render failure inside the surface. Without this boundary
 * an uncaught render error unmounts the whole application (a blank page); with
 * it, the surface shows an error and a retry that remounts the subtree and
 * resumes polling.
 */
export class WorkbenchBoundary extends Component<
  { t: WorkbenchPanelProps['t']; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render(): ReactNode {
    if (this.state.failed) {
      const { t } = this.props
      return <div className={css.panel}>
        <p role="alert" className={css.error}>{t('surfaceError')}</p>
        <button type="button" className={css.secondary} onClick={() => { this.setState({ failed: false }) }}>{t('surfaceRetry')}</button>
      </div>
    }
    return this.props.children
  }
}

/**
 * Subscribe to the injected connection observable; an absent seat (component
 * tests, glue-less assemblies) reads as permanently connected.
 * @param connection - injected connection source, when the plugin provided one.
 * @returns current connection snapshot.
 */
function useConnectionSnapshot(connection: WorkbenchConnection | undefined): WorkbenchConnectionSnapshot {
  const subscribe = useCallback((listener: () => void) => connection?.subscribe(listener) ?? (() => {}), [connection])
  const getSnapshot = useCallback(() => connection?.getSnapshot() ?? 'connected', [connection])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Viewport media query with a safe default: without `matchMedia` (tests,
 * exotic shells) the answer is the narrow layout, so the progressive
 * navigation stays fully exercised everywhere.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const media = typeof window === 'object' && window !== null && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : undefined
    if (media === undefined) return
    const update = (): void => { setMatches(media.matches) }
    update()
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update)
      return () => { media.removeEventListener('change', update) }
    }
    if (typeof (media as { addListener?: unknown }).addListener === 'function') {
      ;(media as { addListener: (l: () => void) => void }).addListener(update)
      return () => { (media as { removeListener: (l: () => void) => void }).removeListener(update) }
    }
    return undefined
  }, [query])
  return matches
}

/** Polling intervals while the surfaces are mounted. */
const LIST_POLL_MS = 3000
const DETAIL_POLL_MS = 2000

/** Viewport from which the task center lays its three columns side by side. */
const WIDE_VIEWPORT_QUERY = '(min-width: 1080px)'

/** Stable empty id list for the earlier-round effect (no identity churn). */
const EMPTY_ROUND_IDS: readonly string[] = []

/** Bounded retries for one earlier-round detail load that keeps rejecting. */
const ROUND_LOAD_ATTEMPTS = 3

/** Bounded retries for one node's workspace discovery that keeps rejecting. */
const DISCOVERY_ATTEMPTS = 3

/** Compact sidebar icon for the global Zcode task-center entry. */
export function ZcodePanelIcon({ size, active }: SidebarPanelIconOwnerProps) {
  return <span aria-hidden="true" style={{
    alignItems: 'center', border: `1px solid ${active ? 'currentColor' : 'transparent'}`,
    borderRadius: 4, display: 'inline-flex', fontSize: Math.max(10, Math.round(size * 0.68)),
    fontWeight: 700, height: size, justifyContent: 'center', lineHeight: 1, width: size,
  }}>Z</span>
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function messageOf(error: unknown, t: (key: 'operationFailed') => string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : t('operationFailed')
}

/**
 * Error message with the fixed-adapter-saved-as-session case mapped to its
 * actionable localized hint (server messages carry the fixed marker; health
 * can be online at the same time, so the raw detail alone reads confusing).
 */
function hintMessageOf(error: unknown, t: WorkbenchPanelProps['t']): string {
  if (error instanceof Error && error.message.includes(NO_WORKSPACE_OPTION_MARKER)) return t('noWorkspaceOptionHint')
  return messageOf(error, t)
}

/** The workspace the task center currently has open. */
interface WorkspaceSelection {
  nodeId: string
  nodeLabel: string
  /** Selected workspace path; null for `fixed` nodes whose pin lives in adapter configuration. */
  workspacePath: string | null
  workspaceLabel: string
}

/** Target label line: node label plus workspace label. */
function selectionTargetLabel(selection: WorkspaceSelection): string {
  return `${selection.nodeLabel} / ${selection.workspaceLabel}`
}

/**
 * Cache scope of one workspace listing: a cached view may only ever render
 * against the selection it was read for — never projected into another
 * workspace while that workspace's own read is still in flight.
 */
function workspaceScopeKey(selection: Pick<WorkspaceSelection, 'nodeId' | 'workspacePath'>): string {
  return `${selection.nodeId}::${selection.workspacePath ?? '__fixed__'}`
}

/**
 * Readable workspace name for default surfaces (design §5): the site's own
 * option label when the discovery cache knows the workspace, else the path's
 * last segment. Display-only — routing keeps the exact workspacePath, and
 * the full path stays in the collapsed run-details diagnostics.
 */
function workspaceDisplayNameOf(options: readonly { path: string; label: string }[] | undefined, workspacePath: string | null): string | null {
  if (workspacePath === null) return null
  const match = options?.find(option => sameClientWorkspacePath(option.path, workspacePath))
  if (match !== undefined) return match.label
  const segments = workspacePath.replaceAll('\\', '/').replace(/\/+$/, '').split('/').filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1]! : workspacePath
}

/**
 * Whether two workspace paths plausibly name the same site workspace on the
 * client: separators and trailing slashes normalize away, and comparison is
 * case-SENSITIVE, mirroring the Host's non-Windows semantics. Case-insensitive
 * matching could mix two distinct same-spelled workspaces into one list, which
 * is the worse failure; a Windows client's case-drifted records simply wait
 * for the next host-filtered listing instead of live-overlaying. Display-level
 * only — every dispatch route is re-validated Host-side against the live site
 * list.
 */
function sameClientWorkspacePath(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  const normalize = (value: string): string => value.replaceAll('\\', '/').replace(/\/+$/, '')
  return normalize(left) === normalize(right)
}

/** One unrouted or in-flight workbench record shown on the home column. */
function RecordStripRow(props: { task: WorkbenchTaskView; t: WorkbenchPanelProps['t']; onRoute: () => void }) {
  const { task, t, onRoute } = props
  return <article className={css.stripRow}>
    <div className={css.taskPrimary}>
      <div className={css.taskTitleLine}>
        <strong>{task.title}</strong>
        <span className={`${css.pill} ${mainPillClassOf(mainStatusOfView(task))}`}>{t(MAIN_STATUS_KEYS[mainStatusOfView(task)])}</span>
      </div>
      <p className={css.taskMeta}>{formatTime(task.updatedAt)}</p>
    </div>
    <button type="button" className={css.secondary} onClick={onRoute}>{t('chooseTarget')}</button>
  </article>
}

/** One workspace entry of the home column. */
function WorkspaceEntry(props: {
  nodeId: string
  nodeLabel: string
  workspacePath: string | null
  workspaceLabel: string
  recordCount: number | null
  lastActivity: string | null
  t: WorkbenchPanelProps['t']
  onOpen: (selection: WorkspaceSelection) => void
  onCompose: (selection: WorkspaceSelection) => void
}) {
  const { nodeId, nodeLabel, workspacePath, workspaceLabel, recordCount, lastActivity, t, onOpen, onCompose } = props
  const selection: WorkspaceSelection = { nodeId, nodeLabel, workspacePath, workspaceLabel }
  const meta = [
    recordCount === null ? null : t('workspaceRecordCount', { count: String(recordCount) }),
    lastActivity === null ? null : t('lastActivity', { time: formatTime(lastActivity) }),
  ].filter((part): part is string => part !== null).join(' · ')
  return <div className={css.workspaceEntry}>
    <button type="button" className={css.workspaceButton} onClick={() => { onOpen(selection) }}>
      <strong>{workspaceLabel}</strong>
      <span>{meta.length > 0 ? meta : t('workspaceMetaUnread')}</span>
    </button>
    <button type="button" className={css.secondary} onClick={() => { onCompose(selection) }}>{t('newTaskHere')}</button>
  </div>
}

/** One node section of the home column: health plus its workspaces. */
function NodeSection(props: {
  node: ZcodeNodeView
  expanded: boolean
  listing: ZcodeWorkspaceListing | null
  listingLoading: boolean
  listingError: string
  records: readonly WorkbenchTaskView[]
  recordsLoaded: boolean
  t: WorkbenchPanelProps['t']
  onToggle: () => void
  onOpen: (selection: WorkspaceSelection) => void
  onCompose: (selection: WorkspaceSelection) => void
}) {
  const { node, expanded, listing, listingLoading, listingError, records, recordsLoaded, t, onToggle, onOpen, onCompose } = props
  const health = node.health
  const pillClass = health.state === 'online' ? css.pillOk : health.state === 'offline' ? css.pillFail : css.pillWarn
  const healthCaption = health.checkedAt === null ? t('neverChecked') : `${t(HEALTH_KEYS[health.state])} · ${formatTime(health.checkedAt)}`
  const workspaceStats = (workspacePath: string | null): { count: number | null; lastActivity: string | null } => {
    if (!recordsLoaded) return { count: null, lastActivity: null }
    const scoped = records.filter(record => record.nodeId === node.id
      && sameClientWorkspacePath(record.workspacePath, workspacePath))
    // One desktop conversation is one row in the task center: rounds bound
    // by a verified desktopTaskId collapse onto that conversation, while
    // unbound records each count as their own. The number is the confirmable
    // workbench-session count only — never a guess at the desktop's native
    // total. Last activity still spans every round.
    const conversations = new Set<string>()
    let unbound = 0
    for (const record of scoped) {
      if (record.desktopTaskId !== null) conversations.add(record.desktopTaskId)
      else unbound += 1
    }
    const lastActivity = scoped.reduce<string | null>((latest, record) =>
      latest === null || Date.parse(record.updatedAt) > Date.parse(latest) ? record.updatedAt : latest, null)
    return { count: conversations.size + unbound, lastActivity }
  }
  return <section className={css.nodeSection} aria-label={node.label}>
    <button type="button" className={css.nodeToggleButton} onClick={onToggle} aria-expanded={expanded}>
      <strong>{node.label}</strong>
      <span className={`${css.pill} ${pillClass}`}>{t(HEALTH_KEYS[health.state])}</span>
      <span className={css.taskMeta}>{node.kind === 'local' ? t('kindLocal') : t('kindRemote')} · {healthCaption}</span>
    </button>
    {expanded && <>
      {node.workspaceSelection === 'fixed'
        ? (() => {
          const stats = workspaceStats(null)
          return <div className={css.workspaceList}>
            <WorkspaceEntry
              nodeId={node.id} nodeLabel={node.label} workspacePath={null}
              workspaceLabel={t('fixedWorkspaceLabel', { node: node.label })}
              recordCount={stats.count} lastActivity={stats.lastActivity}
              t={t} onOpen={onOpen} onCompose={onCompose}
            />
          </div>
        })()
        : listingLoading
          ? <p className={css.scopeNote}>{t('loadingWorkspaces')}</p>
          : listingError.length > 0
            ? <p role="alert" className={css.error}>{listingError}</p>
            : listing !== null && listing.options.length === 0
              ? <p className={css.groupEmpty}>{t('noWorkspaces')}</p>
              : <div className={css.workspaceList}>
                {listing?.options.map(option => {
                  const stats = workspaceStats(option.path)
                  return <WorkspaceEntry
                    key={option.path}
                    nodeId={node.id} nodeLabel={node.label} workspacePath={option.path}
                    workspaceLabel={option.label}
                    recordCount={stats.count} lastActivity={stats.lastActivity}
                    t={t} onOpen={onOpen} onCompose={onCompose}
                  />
                })}
              </div>}
    </>}
  </section>
}

/** One cached workspace-discovery result of a node on the home column. */
interface NodeListingEntry {
  listing: ZcodeWorkspaceListing | null
  error: string
  loading: boolean
}

/**
 * Home column: nodes first, then the workspaces of the node being viewed.
 * Workspace discovery runs only for the expanded node — never for every node
 * on a timer — because each discovery occupies the site's single control
 * channel. The expansion and discovery cache live in the caller, so walking
 * into a workspace and back keeps the home exactly as it was left.
 * Workbench-record counts and last activity come from the light tasks poll;
 * desktop task totals are never inferred here.
 */
function HomeColumn(props: {
  actions: WorkbenchActions
  t: WorkbenchPanelProps['t']
  records: readonly WorkbenchTaskView[]
  recordsLoaded: boolean
  expandedId: string | null
  listings: Record<string, NodeListingEntry>
  onExpandNode: (nodeId: string | null) => void
  onListingResult: (nodeId: string, entry: NodeListingEntry) => void
  onOpenWorkspace: (selection: WorkspaceSelection) => void
  onComposeIn: (selection: WorkspaceSelection) => void
  onRoute: (workbenchTaskId: string) => void
}) {
  const { actions, t, records, recordsLoaded, expandedId, listings, onExpandNode, onListingResult, onOpenWorkspace, onComposeIn, onRoute } = props
  const [nodesList, setNodesList] = useState<ZcodeNodeView[]>([])
  const [nodesError, setNodesError] = useState('')
  const loadNodes = useCallback(() => {
    void actions.nodes().then((value) => {
      setNodesList(value)
      setNodesError('')
      // One available node carries no selector overhead: its workspaces show.
      if (expandedId === null && value.length === 1) onExpandNode(value[0]!.id)
    }, (reason: unknown) => { setNodesError(messageOf(reason, t)) })
  }, [actions, t, expandedId, onExpandNode])
  useEffect(() => { loadNodes() }, [loadNodes])
  useEffect(() => {
    const unsubscribe = subscribeWorkbenchRefresh(loadNodes)
    return () => { unsubscribe() }
  }, [loadNodes])
  // Discover workspaces only for the expanded node. Results write through to
  // the parent cache keyed by node id regardless of this effect's lifetime —
  // poll churn, node reloads, and narrow-screen remounts cannot strand the
  // entry at "reading workspaces". A rejection retries a bounded number of
  // times through an explicit tick; a settled error waits for a re-expansion
  // or a remount, both of which reset the retry budget.
  const discovering = useRef<Set<string>>(new Set())
  const discoveryAttempts = useRef<Map<string, number>>(new Map())
  const [discoveryRetryTick, setDiscoveryRetryTick] = useState(0)
  const cachedListings = useRef(listings)
  cachedListings.current = listings
  useEffect(() => {
    const nodeId = expandedId
    if (nodeId === null) {
      // A fresh expansion deserves a fresh retry budget.
      discoveryAttempts.current.clear()
      return
    }
    const node = nodesList.find(entry => entry.id === nodeId)
    if (node === undefined || node.workspaceSelection === 'fixed') return
    const entry = cachedListings.current[nodeId]
    if (entry !== undefined && (entry.loading || entry.listing !== null)) return
    if (discovering.current.has(nodeId)) return
    if ((discoveryAttempts.current.get(nodeId) ?? 0) >= DISCOVERY_ATTEMPTS
      && entry !== undefined && entry.error.length > 0) return
    discovering.current.add(nodeId)
    onListingResult(nodeId, { listing: null, error: '', loading: true })
    void actions.listWorkspaces(nodeId).then(
      (listing) => {
        discovering.current.delete(nodeId)
        onListingResult(nodeId, { listing, error: '', loading: false })
      },
      (reason: unknown) => {
        discovering.current.delete(nodeId)
        discoveryAttempts.current.set(nodeId, (discoveryAttempts.current.get(nodeId) ?? 0) + 1)
        onListingResult(nodeId, { listing: null, error: hintMessageOf(reason, t), loading: false })
        setDiscoveryRetryTick(tick => tick + 1)
      },
    )
  }, [expandedId, nodesList, actions, t, onListingResult, discoveryRetryTick])
  const unrouted = records.filter(record => record.nodeId === null && (record.status === 'received' || record.status === 'awaiting_route'))
  return <section className={css.homeColumn} aria-label={t('homeColumnTitle')}>
    <header className={css.columnHead}>
      <h2>{t('homeColumnTitle')}</h2>
      <span>{t('taskListHint')}</span>
    </header>
    {nodesError.length > 0 && <p role="alert" className={css.error}>{nodesError}</p>}
    {nodesList.length === 0 && nodesError.length === 0 && <p className={css.groupEmpty}>{t('noNodes')}</p>}
    <div className={css.nodeSections}>
      {nodesList.map(node => <NodeSection
        key={node.id}
        node={node}
        expanded={expandedId === node.id}
        listing={listings[node.id]?.listing ?? null}
        listingLoading={listings[node.id]?.loading ?? false}
        listingError={listings[node.id]?.error ?? ''}
        records={records}
        recordsLoaded={recordsLoaded}
        t={t}
        onToggle={() => { onExpandNode(expandedId === node.id ? null : node.id) }}
        onOpen={onOpenWorkspace}
        onCompose={onComposeIn}
      />)}
    </div>
    {unrouted.length > 0 && <>
      <header className={css.columnHead}>
        <h2>{t('unroutedTitle')}</h2>
      </header>
      <div className={css.taskList}>
        {unrouted.map(task => <RecordStripRow
          key={task.workbenchTaskId}
          task={task}
          t={t}
          onRoute={() => { onRoute(task.workbenchTaskId) }}
        />)}
      </div>
    </>}
  </section>
}

/** One unified task row: the whole row opens the detail. */
function TaskCenterRow(props: { item: TaskCenterItem; t: WorkbenchPanelProps['t']; onOpen: (target: TaskCenterOpenTarget) => void }) {
  const { item, t, onOpen } = props
  return <button type="button" className={css.taskRowBtn} onClick={() => { onOpen(item.open) }}>
    <div className={css.taskTitleLine}>
      <strong className={css.rowTitle}>{item.title.length > 0 ? item.title : t('untitledTask')}</strong>
      <span className={item.source === 'codex' ? css.badgeCodex : item.source === 'desktop' ? css.badgeNative : css.badgeWorkbench}>
        {t(sourceKeyOf(item.source))}
      </span>
      <span className={`${css.pill} ${mainPillClassOf(item.mainStatus)}`}>{t(MAIN_STATUS_KEYS[item.mainStatus])}</span>
      {item.awaitingInput && <span className={`${css.pill} ${css.pillWarn}`}>{t('awaitingInputShort')}</span>}
      {item.echoLost && <span className={`${css.pill} ${css.pillWarn}`}>{t('mainStatus_unknown')}</span>}
    </div>
    <p className={css.taskMeta}>
      {item.rounds.length > 1 && `${t('roundsCount', { count: String(item.rounds.length) })} · `}
      {formatTime(item.updatedAt)}
    </p>
    <p className={css.rowPreview}>{item.preview}</p>
  </button>
}

/**
 * Unified task list of one workspace: the desktop's synced index and the
 * workbench's rounds merged through the pure projection, so one desktop
 * conversation is one row no matter how many rounds it took. The desktop facet
 * keeps its sampled time; when it is unavailable the workbench rows stay and
 * the native side states the boundary instead of being faked.
 */
function WorkspaceListColumn(props: {
  t: WorkbenchPanelProps['t']
  selection: WorkspaceSelection
  items: readonly TaskCenterItem[]
  desktopUnavailableReason: string | null
  desktopTruncated: boolean
  fetchedAt: Date | null
  loading: boolean
  /** No listing for this workspace has landed yet: reading, not empty. */
  awaitingFirstRead: boolean
  error: string
  filter: TaskCenterFilter
  onFilter: (filter: TaskCenterFilter) => void
  onRefresh: () => void
  onOpen: (target: TaskCenterOpenTarget) => void
  onCompose: () => void
  onBack: () => void
}) {
  const { t, selection, items, desktopUnavailableReason, desktopTruncated, fetchedAt, loading, awaitingFirstRead, error, filter, onFilter, onRefresh, onOpen, onCompose, onBack } = props
  const visible = applyTaskCenterFilter(items, filter)
  return <section className={css.listColumn} aria-label={t('listColumnTitle')}>
    <header className={css.columnHead}>
      <div>
        <h2>{t('listColumnTitle')}</h2>
        <span>{selectionTargetLabel(selection)}</span>
      </div>
      <div className={css.columnActions}>
        <button type="button" className={css.secondary} onClick={onCompose}>{t('newTaskHere')}</button>
        <button type="button" className={css.secondary} disabled={loading} onClick={onRefresh}>
          {loading ? t('loadingWorkspaceTasks') : t('refreshTasks')}
        </button>
      </div>
    </header>
    <button type="button" className={`${css.secondary} ${css.backButton}`} onClick={onBack}>{t('backHome')}</button>
    <div className={css.filterBar} role="group" aria-label={t('filterLabel')}>
      {(Object.keys(FILTER_KEYS) as TaskCenterFilter[]).map(key => (
        <button
          key={key} type="button"
          className={filter === key ? css.filterActive : css.filterButton}
          aria-pressed={filter === key}
          onClick={() => { onFilter(key) }}
        >{t(FILTER_KEYS[key])}</button>
      ))}
    </div>
    {fetchedAt !== null && <p className={css.scopeNote}>{t('desktopDataAt', { time: formatTime(fetchedAt.toISOString()) })}</p>}
    {error.length > 0 && <p role="alert" className={css.error}>{error}</p>}
    {desktopUnavailableReason !== null && <p role="status" className={css.notice}>{t('desktopTasksUnavailable', { reason: desktopUnavailableReason })}</p>}
    {desktopTruncated && <p className={css.scopeNote}>{t('desktopTruncated', { count: '200' })}</p>}
    <p className={css.scopeNote}>{t('desktopScopeShort')}</p>
    {awaitingFirstRead
      ? <p className={css.groupEmpty}>{t('loadingWorkspaceTasks')}</p>
      : visible.length === 0
        ? <p className={css.groupEmpty}>{t('unifiedEmpty')}</p>
        : null}
    <div className={css.taskList}>
      {visible.map(item => <TaskCenterRow key={item.key} item={item} t={t} onOpen={onOpen} />)}
    </div>
  </section>
}

const FILTER_KEYS: Record<TaskCenterFilter, WorkbenchKey> = {
  all: 'filter_all',
  active: 'filter_active',
  completed: 'filter_completed',
  attention: 'filter_attention',
}

/**
 * Continuation composer of a task detail: enabled only while the merged
 * evidence proves the desktop task completed with no in-flight or
 * outcome-unknown round; the refusal reason states itself otherwise. Sending
 * goes through the existing `continueDesktopTask` — the adapter's
 * `session/adopt` re-verifies the task on the submit path; nothing is adopted
 * by opening the detail.
 */
function ContinueBox(props: {
  actions: WorkbenchActions
  t: WorkbenchPanelProps['t']
  nodeId: string
  workspacePath: string | null
  targetLabel: string
  desktopTaskId: string | null
  desktopTaskTitle: string
  continuable: boolean
  reason: NotContinuableReason | null
  onDispatched: (workbenchTaskId: string, view?: WorkbenchTaskView) => void
}) {
  const { actions, t, nodeId, workspacePath, targetLabel, desktopTaskId, desktopTaskTitle, continuable, reason, onDispatched } = props
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const promptReady = prompt.trim().length > 0
  const send = () => {
    if (sending || !continuable || desktopTaskId === null || !promptReady) return
    setSending(true)
    setError('')
    void actions.continueDesktopTask({
      nodeId,
      workspacePath: workspacePath ?? '',
      desktopTaskId,
      prompt: prompt.trim(),
      title: '',
    }).then(
      (task) => { onDispatched(task.workbenchTaskId, task) },
      (reason: unknown) => { setError(messageOf(reason, t)); setSending(false) },
    )
  }
  return <section className={css.continueBox} aria-label={t('continueTaskTitle')}>
    <h3>{t('continueTaskTitle')}</h3>
    <p className={css.scopeNote}>{t('continueSelectedHint')}</p>
    {desktopTaskId !== null && <p className={css.taskMeta}>
      {t('continueTargetLine', {
        title: desktopTaskTitle.length > 0 ? desktopTaskTitle : t('untitledTask'),
        taskId: abbreviateId(desktopTaskId),
        target: targetLabel,
      })}
    </p>}
    {!continuable && reason !== null && <p className={css.scopeNote}>{t(NOT_CONTINUABLE_KEYS[reason])}</p>}
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('promptField')}</span>
      <textarea rows={3} value={prompt} disabled={!continuable} placeholder={t('continuePlaceholder')} onChange={(event) => { setPrompt(event.target.value) }} />
    </label>
    <div className={css.composerFooter}>
      <p className={css.validation}>{continuable ? (promptReady ? t('readyToSendContinueShort') : t('validationPrompt')) : t('validationNotContinuable')}</p>
      <button type="button" className={css.primary} disabled={sending || !continuable || !promptReady} onClick={send}>
        {sending ? t('sending') : t('sendContinue')}
      </button>
    </div>
    {error.length > 0 && <p role="alert" className={css.error}>{error}</p>}
  </section>
}

/** Conversation of one workbench task round: assistant Markdown and tool cards. */
function Conversation(props: { events: readonly WorkbenchTranscriptEvent[]; t: WorkbenchPanelProps['t'] }) {
  const { events, t } = props
  const content = events.filter(event => event.kind === 'assistant_message' || event.kind === 'tool_call')
  if (content.length === 0) return <p className={css.groupEmpty}>{t('conversationEmpty')}</p>
  return <>{content.map((event, index) => {
    if (event.kind === 'tool_call') {
      return <div className={css.toolCard} key={index}>
        <strong>{event.text}</strong>
        <small>{event.toolStatus}</small>
      </div>
    }
    return <div className={css.bubble} key={index}>
      <MarkdownMessage text={event.text ?? ''} />
    </div>
  })}</>
}

/** One round of the chain: header with label and outcome, its prompt, and its conversation. */
function RoundBlock(props: { index: number; detail: WorkbenchTaskDetailView; t: WorkbenchPanelProps['t'] }) {
  const { index, detail, t } = props
  const status = mainStatusOfView(detail)
  return <section className={css.roundBlock} aria-label={t('roundLabel', { index: String(index) })}>
    <header className={css.roundHead}>
      <h4>{t('roundLabel', { index: String(index) })}</h4>
      <span className={`${css.pill} ${mainPillClassOf(status)}`}>{t(MAIN_STATUS_KEYS[status])}</span>
      <span className={css.taskMeta}>{formatTime(detail.createdAt)}</span>
    </header>
    {detail.awaitingInput && <p role="status" className={css.notice}>{t('awaitingInput')}</p>}
    {detail.echoLost && <p role="alert" className={css.noticeWarn}>{t('echoLost')}</p>}
    {detail.lastError !== null && !detail.echoLost && <p role="alert" className={css.noticeWarn}>{t('lastError')}: {detail.lastError}</p>}
    <div className={`${css.bubble} ${css.bubbleUser}`}><p>{detail.prompt}</p></div>
    <Conversation events={detail.transcript} t={t} />
  </section>
}

/** Placeholder for one earlier round whose detail has not landed yet. */
function RoundPending(props: { index: number; t: WorkbenchPanelProps['t'] }) {
  const { index, t } = props
  return <section className={css.roundBlock} aria-label={t('roundLabel', { index: String(index) })}>
    <header className={css.roundHead}>
      <h4>{t('roundLabel', { index: String(index) })}</h4>
      <span className={css.taskMeta}>{t('roundLoading')}</span>
    </header>
  </section>
}

/**
 * Result-first detail of one desktop task's workbench rounds. All rounds the
 * merged evidence chains to this desktop task render in time order — each
 * keeps its own prompt, errors, and conversation; the audit of a failed round
 * is never folded away. The polled round (the newest when opened from the
 * list) drives the header, actions, continuation, and run details. Round
 * numbers come from the projection's complete round list, so the polled round
 * keeps its true index while earlier rounds load behind reserved placeholders
 * — a late arrival slots in without renumbering anything.
 */
function TaskDetailPane(props: {
  actions: WorkbenchActions
  t: WorkbenchPanelProps['t']
  taskId: string
  item: TaskCenterItem | null
  fallbackReason: NotContinuableReason
  /** Readable workspace name for default surfaces; the full path lives in run details. */
  resolveWorkspaceName: (nodeId: string, workspacePath: string | null) => string | null
  onBack: () => void
  onDispatched: (workbenchTaskId: string, view?: WorkbenchTaskView) => void
  onSettled: () => void
}) {
  const { actions, t, taskId, item, fallbackReason, resolveWorkspaceName, onBack, onDispatched, onSettled } = props
  const [detail, setDetail] = useState<WorkbenchTaskDetailView | null>(null)
  const [error, setError] = useState('')
  const [pastRounds, setPastRounds] = useState<WorkbenchTaskDetailView[]>([])
  const settledRef = useRef<boolean | null>(null)
  const refresh = useCallback(() => {
    void actions.task(taskId).then((value) => {
      if (value === undefined) { setError(t('loadFailed')); return }
      setDetail(value)
      setError('')
    }, (reason: unknown) => { setError(messageOf(reason, t)) })
  }, [actions, taskId, t])
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, DETAIL_POLL_MS)
    const unsubscribe = subscribeWorkbenchRefresh(refresh)
    return () => { clearInterval(timer); unsubscribe() }
  }, [refresh])
  // Earlier rounds of the same desktop task, loaded once each (terminal
  // rounds do not change); the polled round stays the live one. The id list
  // is keyed by content, not by item identity: the merged item is rebuilt on
  // every light-poll tick, and an effect churned by fresh identities would
  // tear down its own in-flight loads. A late result therefore still lands —
  // the merge is idempotent — and a rejected load retries a bounded number
  // of times through an explicit tick instead of relying on poll churn.
  const settledRounds = useRef<Set<string>>(new Set())
  const inFlightRounds = useRef<Set<string>>(new Set())
  const roundAttempts = useRef<Map<string, number>>(new Map())
  const [roundRetryTick, setRoundRetryTick] = useState(0)
  const earlierRoundKey = (item?.rounds ?? [])
    .filter(round => round.workbenchTaskId !== taskId)
    .map(round => round.workbenchTaskId)
    .join('\n')
  const earlierRoundIds = useMemo(
    () => earlierRoundKey.length === 0 ? EMPTY_ROUND_IDS : earlierRoundKey.split('\n'),
    [earlierRoundKey],
  )
  // The polled round's stable number: its position in the projection's
  // complete round list when the evidence knows it, else one past the earlier
  // rounds. Never derived from what has already loaded — a loading gap must
  // not renumber the round the user is reading.
  const currentIndex = item !== null
    ? Math.max(1, item.rounds.findIndex(round => round.workbenchTaskId === taskId) + 1)
    : earlierRoundIds.length + 1
  useEffect(() => {
    for (const roundId of earlierRoundIds) {
      if (settledRounds.current.has(roundId) || inFlightRounds.current.has(roundId)) continue
      if ((roundAttempts.current.get(roundId) ?? 0) >= ROUND_LOAD_ATTEMPTS) continue
      inFlightRounds.current.add(roundId)
      void actions.task(roundId).then((value) => {
        inFlightRounds.current.delete(roundId)
        // Absent from the store: settled as missing, not retried forever.
        if (value === undefined) { settledRounds.current.add(roundId); return }
        settledRounds.current.add(roundId)
        setPastRounds(current => [...current.filter(round => round.workbenchTaskId !== roundId), value]
          .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)))
      }, () => {
        inFlightRounds.current.delete(roundId)
        roundAttempts.current.set(roundId, (roundAttempts.current.get(roundId) ?? 0) + 1)
        setRoundRetryTick(tick => tick + 1)
      })
    }
    setPastRounds(current => current.filter(round => earlierRoundIds.includes(round.workbenchTaskId)))
  }, [actions, earlierRoundIds, roundRetryTick])
  // One desktop read after this round settles: the follow-up slot frees (or
  // the task needs attention) exactly then; never on a timer while in flight.
  useEffect(() => {
    if (detail === null) return
    const settled = detail.echoLost || detail.status === 'completed' || detail.status === 'failed'
      || detail.status === 'cancelled' || detail.status === 'reported'
    if (settledRef.current === false && settled) onSettled()
    settledRef.current = settled
  }, [detail, onSettled])
  if (detail === null) {
    return <div className={css.panel}><p>{error.length > 0 ? error : t('loadingWorkspaces')}</p>
      <button type="button" className={css.secondary} onClick={onBack}>{t('back')}</button></div>
  }
  const mainStatus = mainStatusOfView(detail)
  const cancellable = detail.status === 'running' || detail.status === 'zcode_acknowledged' || detail.status === 'dispatching' || detail.echoLost
  const desktopTaskId = item?.desktopTaskId ?? detail.desktopTaskId
  const outcome = detail.status === 'reported' ? detail.terminalOutcome : null
  return <section className={css.detailColumn} aria-label={detail.title}>
    <header className={css.detailHead}>
      <div>
        <h2>{detail.title.length > 0 ? detail.title : t('untitledTask')}</h2>
        <div className={css.taskTitleLine}>
          <span className={`${css.pill} ${mainPillClassOf(mainStatus)}`}>{t(MAIN_STATUS_KEYS[mainStatus])}</span>
          <span className={detail.source === 'codex' ? css.badgeCodex : css.badgeWorkbench}>
            {detail.source === 'codex' ? t('sourceCodex') : t('sourceWorkbench')}
          </span>
          {desktopTaskId !== null && <span className={css.badgeContinue}>{t('continueBadge')}</span>}
          {item !== null && item.rounds.length > 1 && <span className={css.taskMeta}>{t('roundsCount', { count: String(item.rounds.length) })}</span>}
        </div>
      </div>
      <div className={css.detailActions}>
        {detail.retryAllowed && <button type="button" className={css.secondary} onClick={() => { void actions.retryTask(taskId).then(() => { refresh() }, (reason: unknown) => { setError(messageOf(reason, t)) }) }}>{t('retry')}</button>}
        {cancellable && <button type="button" className={css.secondary} onClick={() => { void actions.cancelTask(taskId).then(() => { refresh() }, (reason: unknown) => { setError(messageOf(reason, t)) }) }}>{t('cancel')}</button>}
        <button type="button" className={css.secondary} onClick={onBack}>{t('back')}</button>
      </div>
    </header>
    {detail.awaitingInput && <p role="status" className={css.notice}>{t('awaitingInput')}</p>}
    {detail.echoLost && <p role="alert" className={css.noticeWarn}>{t('echoLost')}</p>}
    {detail.lastError !== null && !detail.echoLost && <p role="alert" className={css.noticeWarn}>{t('lastError')}: {detail.lastError}</p>}
    <section className={css.conversation} aria-label={t('transcriptTitle')}>
      <h3>{t('originalQuestion')}</h3>
      {pastRounds.length > 0 && <p className={css.scopeNote}>{t('roundsChainNote')}</p>}
      {earlierRoundIds.map((roundId, position) => {
        const loaded = pastRounds.find(round => round.workbenchTaskId === roundId)
        return loaded !== undefined
          ? <RoundBlock key={roundId} index={position + 1} detail={loaded} t={t} />
          : <RoundPending key={roundId} index={position + 1} t={t} />
      })}
      <RoundBlock index={currentIndex} detail={detail} t={t} />
    </section>
    {desktopTaskId !== null && detail.nodeId !== null && <ContinueBox
      actions={actions} t={t}
      nodeId={detail.nodeId}
      workspacePath={detail.workspacePath}
      targetLabel={`${detail.nodeLabel ?? ''} / ${resolveWorkspaceName(detail.nodeId, detail.workspacePath) ?? detail.workspaceLabel ?? ''}`}
      desktopTaskId={desktopTaskId}
      desktopTaskTitle={item?.title ?? detail.title}
      continuable={item?.continuable ?? false}
      reason={item?.notContinuableReason ?? fallbackReason}
      onDispatched={onDispatched}
    />}
    <details className={css.runDetails}>
      <summary>{t('runDetails')}</summary>
      <dl className={css.infoList}>
        <div className={css.infoItem}><dt>{t('taskId')}</dt><dd>{detail.workbenchTaskId}</dd></div>
        <div className={css.infoItem}><dt>{t('origin')}</dt><dd>{detail.source === 'codex' ? t('sourceCodex') : t('sourceWorkbench')}</dd></div>
        <div className={css.infoItem}><dt>{t('nodeField')}</dt><dd>{detail.nodeLabel ?? t('none')}</dd></div>
        <div className={css.infoItem}><dt>{t('workspaceField')}</dt><dd>{detail.workspaceLabel ?? t('none')}</dd></div>
        <div className={css.infoItem}><dt>{t('deliveryField')}</dt><dd>{t(DELIVERY_KEYS[detail.zcodeDelivery])}</dd></div>
        <div className={css.infoItem}><dt>{t('acpSession')}</dt><dd>{detail.acpSessionId ?? t('none')}</dd></div>
        <div className={css.infoItem}><dt>{t('originalDesktopTask')}</dt><dd>{detail.desktopTaskId ?? t('none')}</dd></div>
        <div className={css.infoItem}><dt>{t('createdAt')}</dt><dd>{formatTime(detail.createdAt)}</dd></div>
        <div className={css.infoItem}><dt>{t('updatedAt')}</dt><dd>{formatTime(detail.updatedAt)}</dd></div>
        {pastRounds.length > 0 && <div className={css.infoItem}><dt>{t('pastRoundIds')}</dt><dd>{pastRounds.map(round => round.workbenchTaskId).join(', ')}</dd></div>}
        {detail.status === 'reported' && <div className={css.infoItem}><dt>{t('reportedMark')}</dt><dd>
          {outcome !== null ? t('reportedOutcomeNote', { outcome: t(STATUS_KEYS[outcome]) }) : t('outcomeNeedsVerification')}
        </dd></div>}
      </dl>
      <h4>{t('statusTraceTitle')}</h4>
      <ol className={css.statusTrace}>
        {detail.transcript.filter(event => event.kind === 'status').map((event, index) => {
          const statusEntry = STATUS_KEYS[event.text as WorkbenchTaskStatus]
          return <li key={index}>{statusEntry === undefined ? event.text : t(statusEntry)} · {formatTime(event.at)}</li>
        })}
      </ol>
      {detail.lastError !== null && <p role="alert" className={css.error}>{t('lastError')}: {detail.lastError}</p>}
    </details>
    {error.length > 0 && <p role="alert" className={css.error}>{error}</p>}
  </section>
}

/** One ordered snapshot entry: a user bubble, an assistant Markdown bubble, or a tool card. */
function SnapshotEntryRow(props: { entry: ZcodeDesktopTaskSnapshotEntry }) {
  const { entry } = props
  if (entry.kind === 'tool') {
    return <div className={css.toolCard}>
      <strong>{entry.toolTitle ?? 'tool'}</strong>
      <small>{entry.toolStatus}</small>
    </div>
  }
  if (entry.kind === 'user') {
    return <div className={`${css.bubble} ${css.bubbleUser}`}><p>{entry.text ?? ''}</p></div>
  }
  return <div className={css.bubble}>
    <MarkdownMessage text={entry.text ?? ''} />
  </div>
}

/**
 * Summary-first detail of one native desktop task. The desktop's own
 * read-only snapshot (phase 2) renders in the desktop's row order with the
 * honest tail-window note when partial; an unavailable read states its
 * boundary instead of being faked. Opening the detail never adopts — the
 * snapshot is fetched read-only here, and continuation adopts only on the
 * submit path.
 */
function NativeTaskPane(props: {
  actions: WorkbenchActions
  t: WorkbenchPanelProps['t']
  item: TaskCenterItem | null
  desktopTaskId: string
  fallback: WorkspaceSelection
  fallbackReason: NotContinuableReason
  /** Readable workspace name for default surfaces; the full path lives in run details. */
  resolveWorkspaceName: (nodeId: string, workspacePath: string | null) => string | null
  onBack: () => void
  onDispatched: (workbenchTaskId: string, view?: WorkbenchTaskView) => void
}) {
  const { actions, t, item, desktopTaskId, fallback, fallbackReason, resolveWorkspaceName, onBack, onDispatched } = props
  const title = item?.title ?? ''
  const desktopStatus = item?.desktopStatus ?? null
  const mainStatus: TaskCenterMainStatus = item?.mainStatus ?? 'unknown'
  const [snapshot, setSnapshot] = useState<ZcodeDesktopTaskSnapshotResult | null>(null)
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(() => {
    setLoading(true)
    void actions.desktopTaskSnapshot(fallback.nodeId, fallback.workspacePath ?? '', desktopTaskId).then((value) => {
      setSnapshot(value)
      setLoading(false)
    }, (reason: unknown) => {
      setSnapshot({ state: 'unavailable', reason: messageOf(reason, t) })
      setLoading(false)
    })
  }, [actions, fallback, desktopTaskId, t])
  useEffect(() => {
    refresh()
    const unsubscribe = subscribeWorkbenchRefresh(refresh)
    return () => { unsubscribe() }
  }, [refresh])
  return <section className={css.detailColumn} aria-label={title.length > 0 ? title : t('untitledTask')}>
    <header className={css.detailHead}>
      <div>
        <h2>{title.length > 0 ? title : t('untitledTask')}</h2>
        <div className={css.taskTitleLine}>
          <span className={`${css.pill} ${mainPillClassOf(mainStatus)}`}>{t(MAIN_STATUS_KEYS[mainStatus])}</span>
          <span className={css.badgeNative}>{t('sourceDesktop')}</span>
        </div>
      </div>
      <div className={css.detailActions}>
        <button type="button" className={css.secondary} onClick={onBack}>{t('back')}</button>
      </div>
    </header>
    <section className={css.panel} aria-label={t('taskInfo')}>
      <dl className={css.infoList}>
        <div className={css.infoItem}><dt>{t('nodeField')}</dt><dd>{fallback.nodeLabel}</dd></div>
        <div className={css.infoItem}><dt>{t('workspaceField')}</dt><dd>{fallback.workspaceLabel}</dd></div>
        {desktopStatus !== null && <div className={css.infoItem}><dt>{t('desktopIndexStatus')}</dt><dd>{t(DESKTOP_STATUS_KEYS[desktopStatus])}</dd></div>}
        {item !== null && <div className={css.infoItem}><dt>{t('createdAt')}</dt><dd>{formatTime(item.createdAt)}</dd></div>}
        {item !== null && <div className={css.infoItem}><dt>{t('updatedAt')}</dt><dd>{formatTime(item.updatedAt)}</dd></div>}
      </dl>
    </section>
    <section className={css.conversation} aria-label={t('nativeSnapshotTitle')}>
      <div className={css.columnHead}>
        <h3>{t('nativeSnapshotTitle')}</h3>
        <button type="button" className={css.secondary} disabled={loading} onClick={refresh}>
          {loading ? t('loadingWorkspaceTasks') : t('refreshTasks')}
        </button>
      </div>
      {snapshot === null
        ? <p className={css.groupEmpty}>{t('loadingWorkspaceTasks')}</p>
        : snapshot.state === 'unavailable'
          ? <>
            <p role="status" className={css.notice}>{t('nativeSnapshotUnavailable', { reason: snapshot.reason })}</p>
            <p className={css.scopeNote}>{t('nativeHistoryNotice')}</p>
          </>
          : <>
            {snapshot.snapshot.partial && <p className={css.scopeNote}>{t('nativeSnapshotPartial')}</p>}
            <p className={css.scopeNote}>{t('desktopDataAt', { time: formatTime(snapshot.snapshot.sampledAt) })}</p>
            {snapshot.snapshot.summary.map(entry => (
              <SnapshotEntryRow key={entry.rowId} entry={entry} />
            ))}
          </>}
    </section>
    <ContinueBox
      actions={actions} t={t}
      nodeId={fallback.nodeId}
      workspacePath={fallback.workspacePath}
      targetLabel={`${fallback.nodeLabel} / ${resolveWorkspaceName(fallback.nodeId, fallback.workspacePath) ?? fallback.workspaceLabel}`}
      desktopTaskId={desktopTaskId}
      desktopTaskTitle={title}
      continuable={item?.continuable ?? false}
      reason={item?.notContinuableReason ?? fallbackReason}
      onDispatched={onDispatched}
    />
    <details className={css.runDetails}>
      <summary>{t('runDetails')}</summary>
      <p className={css.scopeNote}>{t('nativeSummaryNote')}</p>
      <dl className={css.infoList}>
        {/* The full desktop task id stays off the first screen by design:
            copyable here for diagnostics, abbreviated nowhere else. */}
        <div className={css.infoItem}><dt>{t('originalDesktopTask')}</dt><dd>{desktopTaskId}</dd></div>
        {snapshot?.state === 'ok' && <div className={css.infoItem}><dt>{t('nativeSnapshotPhase')}</dt><dd>{snapshot.snapshot.phase ?? t('none')}</dd></div>}
      </dl>
    </details>
  </section>
}

/** Node + workspace selectors shared by composition and routing forms. */
function TargetPicker(props: {
  nodesList: readonly ZcodeNodeView[]
  nodeId: string
  workspacePath: string
  listing: ZcodeWorkspaceListing | null
  loadingWorkspaces: boolean
  workspaceError: string
  t: WorkbenchPanelProps['t']
  onNode: (nodeId: string) => void
  onWorkspace: (path: string) => void
}) {
  const { nodesList, nodeId, workspacePath, listing, loadingWorkspaces, workspaceError, t, onNode, onWorkspace } = props
  const [search, setSearch] = useState('')
  const options = useMemo(() => {
    if (listing === null) return []
    const needle = search.trim().toLowerCase()
    if (needle.length === 0) return listing.options
    return listing.options.filter(option => option.label.toLowerCase().includes(needle)
      || option.path.toLowerCase().includes(needle))
  }, [listing, search])
  return <div className={css.targetGrid}>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('nodeField')}</span>
      <select value={nodeId} onChange={(event) => { onNode(event.target.value) }}>
        <option value="">{t('pickNode')}</option>
        {nodesList.map(node => <option key={node.id} value={node.id}>{node.label} · {node.kind === 'local' ? t('kindLocal') : t('kindRemote')}</option>)}
      </select>
    </label>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('workspaceField')}</span>
      <select
        value={workspacePath}
        disabled={nodeId.length === 0 || loadingWorkspaces}
        onChange={(event) => { onWorkspace(event.target.value) }}
      >
        {nodeId.length === 0
          ? <option value="">{t('pickNodeFirst')}</option>
          : loadingWorkspaces
            ? <option value="">{t('loadingWorkspaces')}</option>
            : <>
              <option value="">{t('pickWorkspace')}</option>
              {options.map(option => <option key={option.path} value={option.path}>{option.label}</option>)}
            </>}
      </select>
    </label>
    {nodeId.length > 0 && listing !== null && listing.options.length > 4 && (
      <input className={css.search} aria-label={t('workspaceSearch')} placeholder={t('workspaceSearch')} value={search} onChange={(event) => { setSearch(event.target.value) }} />
    )}
    {workspaceError.length > 0 && <p role="alert" className={css.error}>{workspaceError}</p>}
  </div>
}

/**
 * Composition form. Opened from a workspace it arrives with the preset target
 * and shows it — no duplicate node/workspace pickers — while the send path is
 * unchanged: the server re-validates the location and the route locks after
 * the first dispatch. Routing an un-routed task keeps the full picker and its
 * own prompt: the original task carries its instruction, so the form renders
 * it read-only and the send stays disabled until that original has loaded — a
 * send before the load could only ever mint a wrong second task. A failed
 * send keeps the user's input.
 */
function ComposePane(props: {
  actions: WorkbenchActions
  t: WorkbenchPanelProps['t']
  preset: WorkspaceSelection | null
  presetTaskId?: string | undefined
  onDispatched: (id: string, view?: WorkbenchTaskView) => void
  onBack: () => void
}) {
  const { actions, t, preset, presetTaskId, onDispatched, onBack } = props
  const [nodesList, setNodesList] = useState<ZcodeNodeView[]>([])
  const [nodeId, setNodeId] = useState(preset?.nodeId ?? '')
  const [workspacePath, setWorkspacePath] = useState(preset?.workspacePath ?? '__fixed__')
  const [listing, setListing] = useState<ZcodeWorkspaceListing | null>(null)
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [presetTask, setPresetTask] = useState<WorkbenchTaskDetailView | null>(null)
  const [presetMissing, setPresetMissing] = useState(false)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const needsPicker = preset === null
  const routing = presetTaskId !== undefined
  useEffect(() => {
    if (!needsPicker) return
    let active = true
    void actions.nodes().then(
      (value) => { if (active) setNodesList(value) },
      (reason: unknown) => { if (active) setError(messageOf(reason, t)) },
    )
    return () => { active = false }
  }, [actions, t, needsPicker])
  useEffect(() => {
    if (presetTaskId === undefined) return
    let active = true
    void actions.task(presetTaskId).then((detail) => {
      if (!active) return
      if (detail === undefined) { setPresetMissing(true); return }
      setPresetTask(detail)
    }, (reason: unknown) => { if (active) { setError(messageOf(reason, t)); setPresetMissing(true) } })
    return () => { active = false }
  }, [actions, presetTaskId, t])
  const pickNode = (next: string) => {
    setNodeId(next)
    setWorkspacePath('')
    setListing(null)
    setWorkspaceError('')
    if (next.length === 0) return
    setLoadingWorkspaces(true)
    void actions.listWorkspaces(next).then(
      (value) => { setListing(value) },
      (reason: unknown) => { setWorkspaceError(hintMessageOf(reason, t)) },
    ).finally(() => { setLoadingWorkspaces(false) })
  }
  const pickWorkspace = (next: string) => {
    setWorkspacePath(next)
  }
  const routeReady = nodeId.length > 0 && workspacePath.length > 0
  const presetReady = !routing || presetTask !== null
  const promptReady = routing ? presetTask !== null : prompt.trim().length > 0
  const targetNodeLabel = nodesList.find(node => node.id === nodeId)?.label ?? nodeId
  const targetLabel = preset !== null
    ? selectionTargetLabel(preset)
    : workspacePath === '__fixed__'
      // The internal pin placeholder never reaches the UI (design §2): the
      // fixed branch shows the adapter's own pinned-workspace label, or the
      // localized fixed label when the listing has not offered one. The send
      // still travels the literal __fixed__ for server-side validation.
      ? (listing?.options.find(option => option.path === workspacePath)?.label ?? t('fixedWorkspaceLabel', { node: targetNodeLabel }))
      : `${targetNodeLabel} / ${listing?.options.find(option => option.path === workspacePath)?.label ?? workspaceDisplayNameOf(listing?.options, workspacePath) ?? workspacePath}`
  const validation = !routeReady
    ? t('validationRoute')
    : !presetReady
      ? t('validationLoadingOriginal')
      : !promptReady
        ? t('validationPrompt')
        : t('readyToSend', { target: targetLabel })
  const send = () => {
    if (sending || !routeReady || !presetReady || !promptReady) return
    setSending(true)
    setError('')
    const trimmedTitle = title.trim()
    const trimmedPrompt = prompt.trim()
    const outcome = routing && presetTask !== null
      ? actions.routeTask({ workbenchTaskId: presetTask.workbenchTaskId, nodeId, workspacePath })
      : actions.composeTask({
        title: trimmedTitle,
        prompt: trimmedPrompt,
        nodeId,
        // Fixed nodes pin their workspace in private adapter configuration;
        // the placeholder path travels for them and is re-validated server-side.
        workspacePath: preset !== null && preset.workspacePath === null ? '__fixed__' : workspacePath,
      })
    void outcome.then(
      (task) => { onDispatched(task.workbenchTaskId, task) },
      (reason: unknown) => { setError(messageOf(reason, t)); setSending(false) },
    )
  }
  return <section className={css.detailColumn} aria-label={t('newTask')}>
    <header className={css.panelHead}>
      <h2>{routing ? t('chooseTarget') : t('newTask')}</h2>
      {needsPicker && <span className={css.required}>{t('targetRequired')}</span>}
    </header>
    <button type="button" className={`${css.secondary} ${css.backButton}`} onClick={onBack}>{t('back')}</button>
    {needsPicker
      ? <TargetPicker
        nodesList={nodesList} nodeId={nodeId} workspacePath={workspacePath} listing={listing}
        loadingWorkspaces={loadingWorkspaces} workspaceError={workspaceError}
        t={t} onNode={pickNode} onWorkspace={pickWorkspace}
      />
      : <div className={css.presetTarget}>
        <span className={css.fieldLabel}>{t('targetTitle')}</span>
        <strong>{targetLabel}</strong>
      </div>}
    {routing && <div className={css.presetTarget}>
      <span className={css.fieldLabel}>{t('routeTaskLine', { id: presetTaskId ?? '' })}</span>
      {presetTask !== null
        ? <div className={`${css.bubble} ${css.bubbleUser}`}><p>{presetTask.prompt}</p></div>
        : <p className={css.scopeNote}>{presetMissing ? t('routeOriginalMissing') : t('validationLoadingOriginal')}</p>}
      <p className={css.scopeNote}>{t('routePromptReadOnly')}</p>
    </div>}
    {!routing && <div className={css.composer}>
      <label className={css.field}><span className={css.fieldLabel}>{t('titleField')}</span>
        <input value={title} maxLength={200} onChange={(event) => { setTitle(event.target.value) }} />
      </label>
      <label className={css.field}><span className={css.fieldLabel}>{t('promptField')}</span>
        <textarea rows={5} value={prompt} placeholder={t('promptPlaceholder')} onChange={(event) => { setPrompt(event.target.value) }} />
      </label>
      <div className={css.composerFooter}>
        <p className={css.validation}>{validation}</p>
        <button type="button" className={css.primary} disabled={sending || !routeReady || !promptReady} onClick={send}>
          {sending ? t('sending') : t('sendTask')}
        </button>
      </div>
      {error.length > 0 && <p role="alert" className={css.error}>{error}</p>}
    </div>}
    {routing && <div className={css.composerFooter}>
      <p className={css.validation}>{validation}</p>
      <button type="button" className={css.primary} disabled={sending || !routeReady || !presetReady} onClick={send}>
        {sending ? t('sending') : t('sendTask')}
      </button>
    </div>}
    {routing && error.length > 0 && <p role="alert" className={css.error}>{error}</p>}
  </section>
}

/** Main-panel occupant: the workspace-first workbench task center. */
export function TaskCenterPanel(props: WorkbenchPanelProps) {
  const { t } = props
  const wide = useMediaQuery(WIDE_VIEWPORT_QUERY)
  const [selection, setSelection] = useState<WorkspaceSelection | null>(null)
  const [openTask, setOpenTask] = useState<TaskCenterOpenTarget | null>(null)
  const [composing, setComposing] = useState<{ preset: WorkspaceSelection | null; routeTaskId?: string } | null>(null)
  const [filter, setFilter] = useState<TaskCenterFilter>('all')
  // Home state lifted here: walking into a workspace and back must not lose
  // the node expansion or the discovery cache.
  const [homeExpandedId, setHomeExpandedId] = useState<string | null>(null)
  const [homeListings, setHomeListings] = useState<Record<string, NodeListingEntry>>({})
  const handleListingResult = useCallback((nodeId: string, entry: NodeListingEntry): void => {
    setHomeListings(current => ({ ...current, [nodeId]: entry }))
  }, [])
  const [tasks, setTasks] = useState<WorkbenchTaskView[]>([])
  const [tasksLoaded, setTasksLoaded] = useState(false)
  const [listError, setListError] = useState('')
  const [wsView, setWsView] = useState<WorkspaceTasksView | null>(null)
  const [wsScopeKey, setWsScopeKey] = useState<string | null>(null)
  const [wsFetchedAt, setWsFetchedAt] = useState<Date | null>(null)
  const [wsLoading, setWsLoading] = useState(false)
  const [wsError, setWsError] = useState('')
  const connectionState = useConnectionSnapshot(props.connection)
  useEffect(() => {
    recordWorkbenchPanelMounted()
    return () => { recordWorkbenchPanelUnmounted(props.connection?.getSnapshot() === 'connected') }
  }, [props.connection])
  // Light workbench-record poll (store reads only — it never touches the
  // desktop control channel; the desktop index is read on entry, on manual
  // refresh, and after a dispatched round settles).
  useEffect(() => {
    let active = true
    const refresh = () => {
      void props.tasks().then((value) => {
        if (active) { setTasks(value); setTasksLoaded(true); setListError('') }
      }, (reason: unknown) => {
        // While the Host is unreachable the reconnect status line speaks for
        // the outage; keep the last known task list instead of stacking
        // carrier errors over it. An absent connection seat reads as
        // connected, preserving plain error reporting.
        if (active && (props.connection?.getSnapshot() ?? 'connected') === 'connected') setListError(messageOf(reason, t))
      })
    }
    refresh()
    const timer = setInterval(refresh, LIST_POLL_MS)
    const unsubscribe = subscribeWorkbenchRefresh(refresh)
    return () => { active = false; clearInterval(timer); unsubscribe() }
  }, [props, t])
  /** Open one workspace: drops the task selection and any draft with it. */
  const openWorkspace = useCallback((next: WorkspaceSelection) => {
    setSelection(next)
    setOpenTask(null)
    setComposing(null)
  }, [])
  const backToHome = useCallback(() => {
    setSelection(null)
    setOpenTask(null)
    setComposing(null)
  }, [])
  const backToList = useCallback(() => {
    setOpenTask(null)
    setComposing(null)
  }, [])
  // Latest-selection ref: a slow workspace read that resolves after the user
  // switched workspaces must not paint the old workspace's rows.
  const selectionRef = useRef<WorkspaceSelection | null>(null)
  selectionRef.current = selection
  const refreshWorkspace = useCallback(() => {
    const current = selectionRef.current
    if (current === null) return
    setWsLoading(true)
    void props.workspaceTasks(current.nodeId, current.workspacePath ?? '').then((value) => {
      if (selectionRef.current !== current) return
      setWsScopeKey(workspaceScopeKey(current))
      setWsView(value)
      setWsFetchedAt(new Date())
      setWsError('')
      setWsLoading(false)
    }, (reason: unknown) => {
      if (selectionRef.current !== current) return
      setWsError(messageOf(reason, t))
      setWsLoading(false)
    })
  }, [props, t])
  // The applied-scope ref keeps "clear on switch" tied to actual scope
  // changes, so an effect re-run with the same selection never flashes the
  // list empty while its own read is in flight.
  const appliedScopeRef = useRef<string | null>(null)
  useEffect(() => {
    if (selection === null) {
      appliedScopeRef.current = null
      setWsView(null)
      setWsScopeKey(null)
      setWsFetchedAt(null)
      setWsError('')
      return
    }
    const key = workspaceScopeKey(selection)
    if (appliedScopeRef.current !== key) {
      // A workspace switch must never render the previous workspace's rows
      // under the new scope: drop the stale view immediately; the read below
      // re-fills it, and the scope-key gate below re-checks every render.
      appliedScopeRef.current = key
      setWsView(null)
      setWsScopeKey(null)
      setWsFetchedAt(null)
      setWsError('')
    }
    refreshWorkspace()
    const unsubscribe = subscribeWorkbenchRefresh(refreshWorkspace)
    return () => { unsubscribe() }
  }, [selection, refreshWorkspace])
  // Scope-keyed cache: even mid-flight state mistakes cannot project another
  // workspace's listing into this one — only the matching scope's view is used.
  const activeWsView = wsView !== null && selection !== null && wsScopeKey === workspaceScopeKey(selection) ? wsView : null
  const activeFetchedAt = activeWsView !== null ? wsFetchedAt : null
  /** Readable workspace name for default detail surfaces (see the helper). */
  const resolveWorkspaceName = useCallback((nodeId: string, workspacePath: string | null): string | null =>
    workspaceDisplayNameOf(homeListings[nodeId]?.listing?.options, workspacePath), [homeListings])
  // Live workbench rounds for the open workspace: the sampled listing's
  // records overlaid with the fresh light-poll records, keyed by task id.
  const liveRecords = useMemo(() => {
    if (selection === null) return []
    const byId = new Map<string, WorkbenchTaskView>()
    for (const record of activeWsView?.workbench ?? []) byId.set(record.workbenchTaskId, record)
    for (const record of tasks) {
      if (record.nodeId === selection.nodeId && sameClientWorkspacePath(record.workspacePath, selection.workspacePath)) {
        byId.set(record.workbenchTaskId, record)
      }
    }
    return [...byId.values()]
  }, [tasks, activeWsView, selection])
  const items = useMemo(() => (selection === null || activeWsView === null)
    ? []
    : mergeWorkspaceTasks({ nodeId: selection.nodeId, workspacePath: selection.workspacePath }, activeWsView.desktop, liveRecords),
  [selection, activeWsView, liveRecords])
  const desktopTruncated = activeWsView !== null && activeWsView.desktop.state === 'ok' && desktopListingMayBeTruncated(activeWsView.desktop.tasks.length)
  const openDetailFor = useCallback((target: TaskCenterOpenTarget) => {
    setOpenTask(target)
    setComposing(null)
  }, [])
  /**
   * Enter composition from any entry point (global button, list column, home
   * rail, unrouted-task routing). The form owns the main column, so whatever
   * detail occupies it steps aside — an entry that only set `composing` left
   * the old detail rendering over the form while the global button hid
   * itself, a dead end on wide screens.
   */
  const composeFrom = useCallback((preset: WorkspaceSelection | null, routeTaskId?: string): void => {
    setOpenTask(null)
    setComposing(routeTaskId === undefined ? { preset } : { preset, routeTaskId })
  }, [])
  /**
   * A dispatch resolved: open the new round's detail and, when the center had
   * no workspace open yet (home composition, unrouted routing), select the
   * workspace the record itself names so the detail keeps its list context.
   */
  const dispatched = useCallback((workbenchTaskId: string, view?: WorkbenchTaskView) => {
    setOpenTask({ kind: 'workbench', workbenchTaskId })
    setComposing(null)
    if (view !== undefined && view.nodeId !== null && selection === null) {
      setSelection({
        nodeId: view.nodeId,
        nodeLabel: view.nodeLabel ?? view.nodeId,
        workspacePath: view.workspacePath,
        workspaceLabel: view.workspaceLabel ?? view.workspacePath ?? '',
      })
    }
  }, [selection])
  const detailItem = useMemo(() => {
    if (openTask === null || selection === null) return null
    if (openTask.kind === 'workbench') {
      return items.find(item => item.rounds.some(round => round.workbenchTaskId === openTask.workbenchTaskId)) ?? null
    }
    return items.find(item => item.desktopTaskId === openTask.desktopTaskId) ?? null
  }, [items, openTask, selection])
  // When the item evidence is missing, the honest refusal reason depends on
  // why: an unavailable desktop index versus a task the index no longer covers.
  const fallbackReason: NotContinuableReason = activeWsView !== null && activeWsView.desktop.state === 'unavailable'
    ? 'index_unavailable'
    : 'not_in_index'
  // Narrow screens walk home → list → detail/new; the deepest active level
  // shows. A composition or detail opened from the home (no workspace
  // selected) is the main level, not the home.
  const narrowScreen: 'home' | 'list' | 'main' = openTask !== null || composing !== null
    ? 'main'
    : selection === null ? 'home' : 'list'
  const showHome = wide || narrowScreen === 'home'
  const showList = wide || narrowScreen === 'list'
  const showMain = wide || narrowScreen === 'main'
  return <WorkbenchBoundary t={t}>
    <div className={css.root}>
      <header className={css.pageHead}>
        <div>
          <h1>{t('panelTitle')}</h1>
          <p>{t('taskCenterHint')}</p>
        </div>
        {composing === null && <button type="button" className={css.primary} onClick={() => { composeFrom(null) }}>{t('newTask')}</button>}
      </header>
      {connectionState !== 'connected' && <p role="status" className={css.notice}>{t('reconnecting')}</p>}
      {listError.length > 0 && <p role="alert" className={css.error}>{listError}</p>}
      <div className={wide ? css.columnsWide : css.columnsNarrow}>
        {showHome && <HomeColumn
          actions={props} t={t} records={tasks} recordsLoaded={tasksLoaded}
          expandedId={homeExpandedId}
          listings={homeListings}
          onExpandNode={setHomeExpandedId}
          onListingResult={handleListingResult}
          onOpenWorkspace={openWorkspace}
          onComposeIn={(target) => { setSelection(target); composeFrom(target) }}
          onRoute={(workbenchTaskId) => { composeFrom(null, workbenchTaskId) }}
        />}
        {showList && (selection !== null
          ? <WorkspaceListColumn
            t={t} selection={selection} items={items}
            desktopUnavailableReason={activeWsView !== null && activeWsView.desktop.state === 'unavailable' ? activeWsView.desktop.reason : null}
            desktopTruncated={desktopTruncated}
            fetchedAt={activeFetchedAt}
            loading={wsLoading}
            awaitingFirstRead={activeWsView === null}
            error={wsError}
            filter={filter}
            onFilter={setFilter}
            onRefresh={refreshWorkspace}
            onOpen={openDetailFor}
            onCompose={() => { composeFrom(selection) }}
            onBack={backToHome}
          />
          : wide && <section className={css.listColumn}><p className={css.groupEmpty}>{t('pickWorkspaceHint')}</p></section>)}
        {showMain && (openTask !== null
          ? openTask.kind === 'workbench'
            // A workbench round renders its detail with or without a selected
            // workspace (home-composed and freshly routed tasks open here).
            // The panes are keyed by their subject id on purpose: without the
            // key a quick A→B switch reuses one instance, and a late result
            // of A (an earlier-round load, a slow poll) would append into
            // B's state; the unmounted instance's writes are no-ops instead.
            // The same task keeps its instance, so poll churn still lands.
            ? <TaskDetailPane
              key={openTask.workbenchTaskId}
              actions={props} t={t} taskId={openTask.workbenchTaskId} item={detailItem} fallbackReason={fallbackReason}
              resolveWorkspaceName={resolveWorkspaceName}
              onBack={backToList} onDispatched={dispatched} onSettled={refreshWorkspace}
            />
            : selection !== null && <NativeTaskPane
              key={openTask.desktopTaskId}
              actions={props} t={t} item={detailItem} desktopTaskId={openTask.desktopTaskId} fallback={selection}
              fallbackReason={fallbackReason}
              resolveWorkspaceName={resolveWorkspaceName}
              onBack={backToList} onDispatched={dispatched}
            />
          : composing !== null
            ? <ComposePane
              key={`${composing.preset?.nodeId ?? ''}::${composing.preset?.workspacePath ?? ''}::${composing.routeTaskId ?? ''}`}
              actions={props} t={t} preset={composing.preset} presetTaskId={composing.routeTaskId}
              onDispatched={dispatched} onBack={backToList}
            />
            : wide && selection !== null && <section className={css.detailColumn}><p className={css.groupEmpty}>{t('pickTaskHint')}</p></section>)}
      </div>
    </div>
  </WorkbenchBoundary>
}

/** One node card with health and edit entry. */
const HEALTH_KEYS: Record<ZcodeNodeView['health']['state'], WorkbenchKey> = {
  online: 'online',
  offline: 'offline',
  checking: 'checking',
  unknown: 'unknown',
}

function NodeCard(props: { node: ZcodeNodeView; t: NodeSettingsProps['t']; onCheck: () => void; onEdit: () => void; onRemove: () => void; busy: boolean }) {
  const { node, t, onCheck, onEdit, onRemove, busy } = props
  const health = node.health
  const pillClass = health.state === 'online' ? css.pillOk : health.state === 'offline' ? css.pillFail : css.pillWarn
  const caption = [
    node.kind === 'local' ? t('kindLocal') : t('kindRemote'),
    health.desktopVersion ?? null,
    health.workspaceCount === null ? null : t('workspacesCount', { count: String(health.workspaceCount) }),
    health.checkedAt === null ? t('neverChecked') : formatTime(health.checkedAt),
  ].filter((part): part is string => part !== null).join(' · ')
  return <article className={css.nodeCard}>
    <div className={css.nodeMain}>
      <div className={css.nodeCopy}>
        <strong>{node.label} <span className={`${css.pill} ${pillClass}`}>{t(HEALTH_KEYS[health.state])}</span></strong>
        <p>{caption}</p>
        {health.state === 'offline' && health.detail !== null && health.detail.length > 0
          && <p role="alert" className={css.error}>{health.detail}</p>}
      </div>
    </div>
    <div className={css.nodeActions}>
      <button type="button" className={css.secondary} disabled={busy} onClick={onCheck}>{t('recheck')}</button>
      <button type="button" className={css.secondary} onClick={onEdit}>{t('editNode')}</button>
      <button type="button" className={css.secondary} disabled={busy} onClick={onRemove}>{t('removeNode')}</button>
    </div>
  </article>
}

/** Node create/edit form; connection settings live in the node's private adapter configuration. */
function NodeEditor(props: {
  initial: WorkbenchNodeInput | null
  t: NodeSettingsProps['t']
  onSave: (input: WorkbenchNodeInput) => Promise<void>
  onCancel: () => void
}) {
  const { initial, t, onSave, onCancel } = props
  const [draft, setDraft] = useState<WorkbenchNodeInput>(initial ?? {
    id: '', kind: 'remote', label: '', siteLabel: '', command: '', args: [], workspaceSelection: 'session',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const field = (key: keyof WorkbenchNodeInput, value: WorkbenchNodeInput[typeof key]) => {
    setDraft(current => ({ ...current, [key]: value }))
  }
  return <form className={css.nodeEditor} onSubmit={(event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    void onSave(draft).then(() => { setBusy(false) }, (reason: unknown) => { setError(hintMessageOf(reason, t)); setBusy(false) })
  }}>
    <div className={css.editorGrid}>
      <label className={css.field}><span className={css.fieldLabel}>{t('fieldId')}</span>
        <input value={draft.id} required disabled={initial !== null} onChange={(event) => { field('id', event.target.value) }} />
      </label>
      <label className={css.field}><span className={css.fieldLabel}>{t('kindLocal')} / {t('kindRemote')}</span>
        <select value={draft.kind} onChange={(event) => { field('kind', event.target.value === 'local' ? 'local' : 'remote') }}>
          <option value="local">{t('kindLocal')}</option>
          <option value="remote">{t('kindRemote')}</option>
        </select>
      </label>
      <label className={css.field}><span className={css.fieldLabel}>{t('fieldLabel')}</span>
        <input value={draft.label} required maxLength={80} onChange={(event) => { field('label', event.target.value) }} />
      </label>
      <label className={css.field}><span className={css.fieldLabel}>{t('fieldSite')}</span>
        <input value={draft.siteLabel} maxLength={80} onChange={(event) => { field('siteLabel', event.target.value) }} />
      </label>
      <label className={css.field}><span className={css.fieldLabel}>{t('fieldWorkspaceSelection')}</span>
        <select value={draft.workspaceSelection} onChange={(event) => { field('workspaceSelection', event.target.value === 'fixed' ? 'fixed' : 'session') }}>
          <option value="session">{t('selectionSession')}</option>
          <option value="fixed">{t('selectionFixed')}</option>
        </select>
      </label>
      <label className={css.field}><span className={css.fieldLabel}>{t('fieldCommand')}</span>
        <input value={draft.command} required onChange={(event) => { field('command', event.target.value) }} />
      </label>
    </div>
    <label className={css.field}><span className={css.fieldLabel}>{t('fieldArgs')}</span>
      <textarea rows={3} value={draft.args.join('\n')} onChange={(event) => { field('args', event.target.value.split('\n').map(line => line.trim()).filter(line => line.length > 0)) }} />
    </label>
    <div className={css.detailActions}>
      <button type="submit" className={css.primary} disabled={busy}>{t('saveNode')}</button>
      <button type="button" className={css.secondary} onClick={onCancel}>{t('cancelEdit')}</button>
    </div>
    {error.length > 0 && <p role="alert" className={css.error}>{error}</p>}
  </form>
}

/** Settings-section occupant: node administration and ingress status. */
export function NodeSettings(props: NodeSettingsProps) {
  const { t } = props
  const [nodesList, setNodesList] = useState<ZcodeNodeView[]>([])
  const [ingress, setIngress] = useState<IngressInfo | null>(null)
  const [editing, setEditing] = useState<WorkbenchNodeInput | null | undefined>(undefined)
  const [busyNode, setBusyNode] = useState('')
  const [error, setError] = useState('')
  const connectionState = useConnectionSnapshot(props.connection)
  const refresh = useCallback(() => {
    void props.nodes().then((value) => { setNodesList(value); setError('') }, (reason: unknown) => {
      // The reconnect status line owns outage reporting; carrier errors are
      // dropped while disconnected so recovery shows the list again cleanly.
      // An absent connection seat reads as connected, preserving plain
      // error reporting.
      if ((props.connection?.getSnapshot() ?? 'connected') === 'connected') setError(messageOf(reason, t))
    })
    void props.ingressInfo().then(setIngress, () => { setIngress(null) })
  }, [props, t])
  useEffect(() => {
    refresh()
    const unsubscribe = subscribeWorkbenchRefresh(refresh)
    return () => { unsubscribe() }
  }, [refresh])
  const local = nodesList.filter(node => node.kind === 'local')
  const remote = nodesList.filter(node => node.kind === 'remote')
  return <WorkbenchBoundary t={t}>
    <section className={css.root}>
      <header className={css.pageHead}>
        <div>
          <h2>{t('nodesTitle')}</h2>
          <p>{t('nodesIntro')}</p>
        </div>
        {editing === undefined && <button type="button" className={css.primary} onClick={() => { setEditing(null) }}>{t('addNode')}</button>}
      </header>
      {connectionState !== 'connected' && <p role="status" className={css.notice}>{t('reconnecting')}</p>}
      {ingress !== null && <div className={css.ingressBar}>
        <strong>{t('ingressTitle')}</strong>
        <span>{t('ingressPath')}: {ingress.path}</span>
        <span className={ingress.provisioned ? css.pillOk : css.pillWarn}>{ingress.provisioned ? t('ingressReady') : t('ingressMissing')}</span>
      </div>}
      {editing !== undefined && <NodeEditor
        initial={editing} t={t} onCancel={() => { setEditing(undefined) }}
        onSave={async (input) => { await props.saveNode(input); setEditing(undefined); refresh() }}
      />}
      {editing === undefined && <>
        {([['localGroup', local], ['remoteGroup', remote]] as const).map(([groupKey, group]) => (
          <div key={groupKey}>
            <div className={css.sectionBar}><h2>{t(groupKey)}</h2></div>
            {group.length === 0 && <p className={css.groupEmpty}>{t('noNodes')}</p>}
            <div className={css.nodeList}>
              {group.map(node => <NodeCard
                key={node.id} node={node} t={t} busy={busyNode === node.id}
                onCheck={() => {
                  setBusyNode(node.id)
                  void props.checkNode(node.id).then(() => { setBusyNode(''); refresh() }, (reason: unknown) => { setError(messageOf(reason, t)); setBusyNode('') })
                }}
                onEdit={() => { setEditing({ ...node }) }}
                onRemove={() => {
                  if (!window.confirm(t('removeNodeConfirm'))) return
                  setBusyNode(node.id)
                  void props.removeNode(node.id).then(() => { setBusyNode(''); refresh() }, (reason: unknown) => { setError(messageOf(reason, t)); setBusyNode('') })
                }}
              />)}
            </div>
          </div>
        ))}
      </>}
      {error.length > 0 && <p role="alert" className={css.error}>{error}</p>}
    </section>
  </WorkbenchBoundary>
}
