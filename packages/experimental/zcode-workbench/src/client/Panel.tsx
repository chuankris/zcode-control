/**
 * Client surfaces of the Zcode workbench: the `main` panel hosting the task
 * center, task composition, and task detail, plus the settings section for
 * node administration. All Host access goes through the injected action face;
 * the components hold only view state and poll while mounted. Surfaces are
 * restart-safe: a render failure is contained inside the surface instead of
 * unmounting the page, and connection loss shows a reconnect status while
 * polling keeps running, so the workbench rehydrates by itself once the Host
 * is back.
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NO_WORKSPACE_OPTION_MARKER } from '../types.ts'
import type {
  IngressInfo, WorkbenchComposeRequest, WorkbenchContinueRequest, WorkbenchNodeInput, WorkbenchRouteRequest,
  WorkbenchTaskDetailView, WorkbenchTaskStatus, WorkbenchTaskView, WorkbenchTranscriptEvent, WorkspaceTasksView,
  ZcodeDesktopTaskStatus, ZcodeDesktopTaskView, ZcodeDeliveryState, ZcodeNodeView, ZcodeWorkspaceListing,
} from '../types.ts'
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

/** Desktop task-index status → dictionary key. */
const DESKTOP_STATUS_KEYS: Record<ZcodeDesktopTaskStatus, WorkbenchKey> = {
  running: 'desktopStatus_running',
  completed: 'desktopStatus_completed',
  error: 'desktopStatus_error',
  unknown: 'desktopStatus_unknown',
}

/** Desktop task-index status → pill tone class. */
function desktopPillClassOf(status: ZcodeDesktopTaskStatus): string | undefined {
  if (status === 'completed') return css.pillOk
  if (status === 'error') return css.pillFail
  if (status === 'unknown') return css.pillMuted
  return css.pillWarn
}

/** Why one desktop status cannot be selected for continuation. */
const NOT_CONTINUABLE_KEYS: Record<Exclude<ZcodeDesktopTaskStatus, 'completed'>, WorkbenchKey> = {
  running: 'notContinuable_running',
  error: 'notContinuable_error',
  unknown: 'notContinuable_unknown',
}

/**
 * Abbreviate a stable session/task id for display: the leading characters keep
 * it recognizable and matchable while the full value stays off the page.
 */
function abbreviateId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 10)}…`
}

/** Delivery facet → dictionary key. */
const DELIVERY_KEYS: Record<ZcodeDeliveryState, WorkbenchKey> = {
  pending: 'delivery_pending',
  acknowledged: 'delivery_acknowledged',
  running: 'delivery_running',
  terminal: 'delivery_terminal',
  echo_lost: 'delivery_echo_lost',
}

/** Status → pill tone class. */
function pillClassOf(status: WorkbenchTaskStatus): string | undefined {
  if (status === 'completed' || status === 'reported') return css.pillOk
  if (status === 'failed') return css.pillFail
  if (status === 'cancelled') return css.pillMuted
  return css.pillWarn
}

/** Host operations injected into both surfaces. */
export interface WorkbenchActions {
  nodes: () => Promise<ZcodeNodeView[]>
  saveNode: (input: WorkbenchNodeInput) => Promise<ZcodeNodeView>
  removeNode: (id: string) => Promise<boolean>
  checkNode: (id: string) => Promise<ZcodeNodeView>
  listWorkspaces: (nodeId: string) => Promise<ZcodeWorkspaceListing>
  workspaceTasks: (nodeId: string, workspacePath: string) => Promise<WorkspaceTasksView>
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

/** Polling intervals while the surfaces are mounted. */
const LIST_POLL_MS = 3000
const DETAIL_POLL_MS = 2000

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

/** One task row of the center list. */
function TaskRow(
  props: { task: WorkbenchTaskView; t: WorkbenchPanelProps['t']; onOpen: () => void; onRoute: () => void },
) {
  const { task, t, onOpen, onRoute } = props
  return <article className={css.taskRow}>
    <div className={css.taskPrimary}>
      <div className={css.taskTitleLine}>
        <strong>{task.title}</strong>
        {task.source === 'codex'
          ? <span className={css.badgeCodex}>{t('sourceCodex')}</span>
          : <span className={task.desktopTaskId === null ? css.badgeWorkbench : css.badgeContinue}>
            {task.desktopTaskId === null ? t('composeBadge') : t('continueBadge')}
          </span>}
        <span className={`${css.pill} ${pillClassOf(task.status)}`}>{t(STATUS_KEYS[task.status])}</span>
        {task.awaitingInput && <span className={`${css.pill} ${css.pillWarn}`}>{t('awaitingInput')}</span>}
        {task.echoLost && <span className={`${css.pill} ${css.pillWarn}`}>{t('echoLost')}</span>}
      </div>
      <p className={css.taskMeta}>
        {task.workbenchTaskId}
        {task.desktopTaskId !== null && ` · ${t('originalDesktopTask')} ${abbreviateId(task.desktopTaskId)}`}
        {` · ${formatTime(task.updatedAt)}`}
      </p>
      <div className={css.delivery}>
        <span className={css.deliveryOk}>✓ {t('syncWorkbenchRegistered')}</span>
        <span className={task.zcodeDelivery === 'pending' ? css.deliveryWaiting : css.deliveryOk}>
          {task.zcodeDelivery === 'pending' ? t('syncZcodePending') : `✓ ${t(DELIVERY_KEYS[task.zcodeDelivery])}`}
        </span>
      </div>
    </div>
    <div className={css.taskRoute}>
      <span className={css.routeCaption}>{t('route')}</span>
      <strong>{task.nodeLabel === null ? t('unrouted') : `${task.nodeLabel} / ${task.workspaceLabel ?? ''}`}</strong>
      <p>{task.nodeLabel === null ? t('chooseTargetFirst') : task.promptPreview}</p>
    </div>
    {task.nodeLabel === null
      ? <button type="button" className={css.secondary} onClick={onRoute}>{t('chooseTarget')}</button>
      : <button type="button" className={css.secondary} onClick={onOpen}>{t('viewTask')}</button>}
  </article>
}

/** Fixed binding bar of the task detail: target, lock, and live state. */
function BindingBar(props: { task: WorkbenchTaskDetailView; t: WorkbenchPanelProps['t'] }) {
  const { task, t } = props
  return <div className={css.bindingBar}>
    <span className={task.echoLost ? css.dotOffline : css.dotOnline} aria-hidden="true" />
    <div className={css.bindingMain}>
      <strong>{task.nodeLabel === null ? t('unrouted') : `${task.nodeLabel} / ${task.workspaceLabel ?? ''}`}</strong>
      <span>{task.echoLost ? t('echoLost') : task.awaitingInput ? t('awaitingInput') : t('lockedHint')}</span>
    </div>
    <span className={`${css.pill} ${pillClassOf(task.status)}`}>{t(STATUS_KEYS[task.status])}</span>
    <span className={css.lockedMark}>{t('locked')}</span>
  </div>
}

/** Three-party delivery strip: origin → workbench → Zcode. */
const SYNC_ZCODE_KEYS: Record<ZcodeDeliveryState, WorkbenchKey> = {
  pending: 'syncZcodePending',
  acknowledged: 'syncZcodeAcknowledged',
  running: 'syncZcodeRunning',
  terminal: 'syncZcodeTerminal',
  echo_lost: 'syncZcodeEchoLost',
}

function SyncStrip(props: { task: WorkbenchTaskDetailView; t: WorkbenchPanelProps['t'] }) {
  const { task, t } = props
  return <div className={css.syncStrip}>
    <div className={css.syncStage}><strong>{t('syncOrigin')}</strong><span>✓ {t('syncOriginSubmitted')}</span></div>
    <div className={css.syncStage}><strong>{t('syncWorkbench')}</strong><span>✓ {task.workbenchTaskId} · {t('syncWorkbenchRegistered')}</span></div>
    <div className={css.syncStage}><strong>{t('syncZcode')}</strong><span className={task.echoLost ? css.syncWarn : undefined}>{t(SYNC_ZCODE_KEYS[task.zcodeDelivery])}</span></div>
  </div>
}

/** Inspector facts panel of the task detail. */
function TaskInspector(props: { task: WorkbenchTaskDetailView; t: WorkbenchPanelProps['t'] }) {
  const { task, t } = props
  const rows: [string, string][] = [
    [t('taskId'), task.workbenchTaskId],
    [t('origin'), task.source === 'codex' ? t('sourceCodex') : t('sourceWorkbench')],
    [t('nodeField'), task.nodeLabel ?? t('none')],
    [t('workspaceField'), task.workspaceLabel ?? t('none')],
    [t('deliveryField'), t(DELIVERY_KEYS[task.zcodeDelivery])],
    [t('acpSession'), task.acpSessionId ?? t('none')],
    [t('originalDesktopTask'), task.desktopTaskId === null ? t('none') : abbreviateId(task.desktopTaskId)],
    [t('createdAt'), formatTime(task.createdAt)],
    [t('updatedAt'), formatTime(task.updatedAt)],
  ]
  return <aside className={css.inspector}>
    <h3>{t('taskInfo')}</h3>
    <dl className={css.infoList}>
      {rows.map(([label, value]) => <div className={css.infoItem} key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    {task.lastError !== null && <p role="alert" className={css.error}>{t('lastError')}: {task.lastError}</p>}
  </aside>
}

/** Streamed conversation of one task: status lines, tool cards, assistant text. */
function Transcript(props: { events: readonly WorkbenchTranscriptEvent[]; t: WorkbenchPanelProps['t'] }) {
  const { events, t } = props
  return <section className={css.conversation} aria-label={t('transcriptTitle')}>
    <h3>{t('transcriptTitle')}</h3>
    {events.map((event, index) => {
      if (event.kind === 'assistant_message') {
        return <div className={`${css.message} ${css.messageAssistant}`} key={index}>
          <div className={css.bubble}><p>{event.text}</p></div>
        </div>
      }
      if (event.kind === 'tool_call') {
        return <div className={`${css.message} ${css.messageAssistant}`} key={index}>
          <div className={css.toolCard}><strong>{event.text}</strong><small>{event.toolStatus}</small></div>
        </div>
      }
      const statusEntry = STATUS_KEYS[event.text as WorkbenchTaskStatus]
      return <div className={css.statusLine} key={index}>{statusEntry === undefined ? event.text : t(statusEntry)}</div>
    })}
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

/** One row of the desktop-synced task group. */
function DesktopTaskRow(props: {
  task: ZcodeDesktopTaskView
  t: WorkbenchPanelProps['t']
  onOpen: (workbenchTaskId: string) => void
  selectable: boolean
  selected: boolean
  onSelect: (task: ZcodeDesktopTaskView) => void
}) {
  const { task, t, onOpen, selectable, selected, onSelect } = props
  const workbenchTaskId = task.workbenchTaskId
  const continuable = task.status === 'completed'
  return <article className={css.wsTaskRow}>
    {selectable && <input
      type="radio"
      name="zcode-continue-desktop-task"
      className={css.continueRadio}
      aria-label={t('selectForContinue')}
      checked={selected}
      disabled={!continuable}
      onChange={() => { onSelect(task) }}
    />}
    <div className={css.taskPrimary}>
      <div className={css.taskTitleLine}>
        <strong>{task.title.length > 0 ? task.title : t('untitledTask')}</strong>
        <span className={task.origin === 'workbench' ? css.badgeWorkbench : css.badgeCodex}>
          {task.origin === 'workbench' ? t('workbenchOrigin') : t('desktopOrigin')}
        </span>
        <span className={`${css.pill} ${desktopPillClassOf(task.status)}`}>{t(DESKTOP_STATUS_KEYS[task.status])}</span>
      </div>
      <p className={css.taskMeta}>{abbreviateId(task.taskId)} · {formatTime(task.updatedAt)}</p>
      {selectable && task.status !== 'completed' && <p className={css.scopeNote}>{t(NOT_CONTINUABLE_KEYS[task.status])}</p>}
    </div>
    {workbenchTaskId !== null
      && <button type="button" className={css.secondary} onClick={() => { onOpen(workbenchTaskId) }}>{t('viewTask')}</button>}
  </article>
}

/** One row of the workbench-recorded task group. */
function WorkbenchWsTaskRow(props: { task: WorkbenchTaskView; t: WorkbenchPanelProps['t']; onOpen: () => void }) {
  const { task, t, onOpen } = props
  return <article className={css.wsTaskRow}>
    <div className={css.taskPrimary}>
      <div className={css.taskTitleLine}>
        <strong>{task.title}</strong>
        {task.source === 'codex'
          ? <span className={css.badgeCodex}>{t('sourceCodex')}</span>
          : <span className={task.desktopTaskId === null ? css.badgeWorkbench : css.badgeContinue}>
            {task.desktopTaskId === null ? t('composeBadge') : t('continueBadge')}
          </span>}
        <span className={`${css.pill} ${pillClassOf(task.status)}`}>{t(STATUS_KEYS[task.status])}</span>
        {task.awaitingInput && <span className={`${css.pill} ${css.pillWarn}`}>{t('awaitingInput')}</span>}
      </div>
      <p className={css.taskMeta}>
        {task.workbenchTaskId}
        {task.desktopTaskId !== null && ` · ${t('originalDesktopTask')} ${abbreviateId(task.desktopTaskId)}`}
        {task.acpSessionId !== null && ` · ${t('acpSession')} ${abbreviateId(task.acpSessionId)}`}
        {` · ${formatTime(task.updatedAt)}`}
      </p>
    </div>
    <button type="button" className={css.secondary} onClick={onOpen}>{t('viewTask')}</button>
  </article>
}

/**
 * The task browser of one selected workspace: the Zcode desktop's own synced
 * task index beside the workbench's recorded tasks. The two sources stay
 * visually separated — the desktop side states its real boundary (synced,
 * non-pinned, non-archived) and an unavailable desktop listing shows the
 * reason instead of being faked from the workbench side. Switching node or
 * workspace drops the previous rows before the next listing lands.
 *
 * When `selectable`, each desktop row carries a single-choice radio for
 * continuation; every fresh listing re-verifies the selection and clears it
 * (with a notice) once the task can no longer be proven completed here.
 */
function WorkspaceTaskBrowser(props: {
  actions: WorkbenchActions
  t: WorkbenchPanelProps['t']
  nodeId: string
  workspacePath: string
  targetLabel: string
  onOpenWorkbenchTask: (workbenchTaskId: string) => void
  selectable: boolean
  selectedTaskId: string | null
  onSelectTask: (task: ZcodeDesktopTaskView | null) => void
}) {
  const { actions, t, nodeId, workspacePath, targetLabel, onOpenWorkbenchTask, selectable, onSelectTask } = props
  const [view, setView] = useState<WorkspaceTasksView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [staleNotice, setStaleNotice] = useState(false)
  const [tick, setTick] = useState(0)
  const selectedTaskIdRef = useRef(props.selectedTaskId)
  selectedTaskIdRef.current = props.selectedTaskId
  const onSelectTaskRef = useRef(props.onSelectTask)
  onSelectTaskRef.current = props.onSelectTask
  useEffect(() => {
    let active = true
    setView(null)
    setError('')
    setStaleNotice(false)
    setLoading(true)
    void actions.workspaceTasks(nodeId, workspacePath).then((value) => {
      if (!active) return
      setView(value)
      setLoading(false)
      // Stale-data recheck: the selection survives only while the fresh
      // listing itself still proves the task completed in this workspace.
      const selected = selectedTaskIdRef.current
      if (selected === null) return
      const row = value.desktop.state === 'ok' ? value.desktop.tasks.find(task => task.taskId === selected) : undefined
      if (row === undefined || row.status !== 'completed') {
        onSelectTaskRef.current(null)
        setStaleNotice(true)
      }
    }, (reason: unknown) => {
      if (!active) return
      setError(messageOf(reason, t))
      setLoading(false)
    })
    return () => { active = false }
  }, [actions, t, nodeId, workspacePath, tick])
  return <section className={css.panel} aria-label={t('workspaceTasksTitle')}>
    <header className={css.sectionBar}>
      <h2>{t('workspaceTasksTitle')}</h2>
      <span>{targetLabel}</span>
      <button type="button" className={css.secondary} disabled={loading} onClick={() => { setTick(tick + 1) }}>
        {loading ? t('loadingWorkspaceTasks') : t('refreshTasks')}
      </button>
    </header>
    {error.length > 0 && <p role="alert" className={css.error}>{error}</p>}
    {staleNotice && <p role="status" className={css.notice}>{t('selectionClearedStale')}</p>}
    {view === null
      ? error.length === 0 && <p>{t('loadingWorkspaceTasks')}</p>
      : <>
        <h3 className={css.wsGroupHead}>{t('desktopSyncedTasks')}</h3>
        <p className={css.scopeNote}>{t('desktopTasksScopeNote')}</p>
        {selectable && <p className={css.scopeNote}>{t('selectTaskToContinue')}</p>}
        {view.desktop.state === 'unavailable'
          ? <p role="status" className={css.notice}>{t('desktopTasksUnavailable', { reason: view.desktop.reason })}</p>
          : view.desktop.tasks.length === 0
            ? <p className={css.groupEmpty}>{t('desktopTasksEmpty')}</p>
            : <div className={css.taskList}>
              {view.desktop.tasks.map(task => <DesktopTaskRow
                key={task.taskId} task={task} t={t} onOpen={onOpenWorkbenchTask}
                selectable={selectable} selected={selectable && task.taskId === props.selectedTaskId}
                onSelect={onSelectTask}
              />)}
            </div>}
        <h3 className={css.wsGroupHead}>{t('workbenchRecordedTasks')}</h3>
        {view.workbench.length === 0
          ? <p className={css.groupEmpty}>{t('workbenchTasksEmpty')}</p>
          : <div className={css.taskList}>
            {view.workbench.map(task => (
              <WorkbenchWsTaskRow
                key={task.workbenchTaskId}
                task={task}
                t={t}
                onOpen={() => { onOpenWorkbenchTask(task.workbenchTaskId) }}
              />
            ))}
          </div>}
      </>}
  </section>
}

/** Composition form: route selection gates the send; a completed route shows the workspace's tasks. */
function ComposeForm(props: {
  actions: WorkbenchActions
  t: WorkbenchPanelProps['t']
  onDispatched: (id: string) => void
  onOpenTask: (id: string) => void
  presetTaskId?: string | undefined
}) {
  const { actions, t, onDispatched, onOpenTask, presetTaskId } = props
  const [nodesList, setNodesList] = useState<ZcodeNodeView[]>([])
  const [nodeId, setNodeId] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [listing, setListing] = useState<ZcodeWorkspaceListing | null>(null)
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [presetTask, setPresetTask] = useState<WorkbenchTaskView | null>(null)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  // The desktop task chosen for continuation; null composes a fresh task.
  // Selection and route move together: switching node or workspace drops it.
  const [continueTarget, setContinueTarget] = useState<{ taskId: string; title: string } | null>(null)
  useEffect(() => {
    let active = true
    void actions.nodes().then(
      (value) => { if (active) setNodesList(value) },
      (reason: unknown) => { if (active) setError(messageOf(reason, t)) },
    )
    return () => { active = false }
  }, [actions, t])
  useEffect(() => {
    if (presetTaskId === undefined) return
    let active = true
    void actions.task(presetTaskId).then((detail) => {
      if (!active || detail === undefined) return
      setPresetTask(detail)
      setPrompt(detail.promptPreview)
      setTitle(detail.title)
    })
    return () => { active = false }
  }, [actions, presetTaskId])
  const pickNode = (next: string) => {
    setNodeId(next)
    setWorkspacePath('')
    setListing(null)
    setWorkspaceError('')
    setContinueTarget(null)
    if (next.length === 0) return
    setLoadingWorkspaces(true)
    void actions.listWorkspaces(next).then(
      (value) => { setListing(value) },
      (reason: unknown) => { setWorkspaceError(hintMessageOf(reason, t)) },
    ).finally(() => { setLoadingWorkspaces(false) })
  }
  const pickWorkspace = (next: string) => {
    setWorkspacePath(next)
    setContinueTarget(null)
  }
  const routeReady = nodeId.length > 0 && workspacePath.length > 0
  const promptReady = prompt.trim().length > 0
  const composing = presetTask === null
  const workspaceTarget = workspacePath === '__fixed__'
    ? listing?.options.find(option => option.path === workspacePath)?.label ?? workspacePath
    : workspacePath
  const targetLabel = `${nodesList.find(node => node.id === nodeId)?.label ?? nodeId} / ${workspaceTarget}`
  const validation = !routeReady
    ? t('validationRoute')
    : !promptReady
      ? t('validationPrompt')
      : continueTarget !== null
        ? t('readyToSendContinue', { task: continueTarget.title.length > 0 ? continueTarget.title : t('untitledTask'), target: targetLabel })
        : t('readyToSend', { target: targetLabel })
  const send = () => {
    if (sending || !routeReady || !promptReady) return
    setSending(true)
    setError('')
    const trimmedTitle = title.trim()
    const trimmedPrompt = prompt.trim()
    const outcome = presetTask === null && continueTarget !== null
      ? actions.continueDesktopTask({
        nodeId,
        workspacePath,
        desktopTaskId: continueTarget.taskId,
        prompt: trimmedPrompt,
        title: trimmedTitle,
      })
      : presetTask === null
        ? actions.composeTask({ title: trimmedTitle, prompt: trimmedPrompt, nodeId, workspacePath })
        : actions.routeTask({ workbenchTaskId: presetTask.workbenchTaskId, nodeId, workspacePath })
    void outcome.then(
      (task) => { onDispatched(task.workbenchTaskId) },
      (reason: unknown) => { setError(messageOf(reason, t)) },
    ).finally(() => { setSending(false) })
  }
  return <section className={css.panel}>
    <header className={css.panelHead}>
      <h2>{t('targetTitle')}</h2>
      <span className={css.required}>{t('targetRequired')}</span>
    </header>
    <TargetPicker
      nodesList={nodesList} nodeId={nodeId} workspacePath={workspacePath} listing={listing}
      loadingWorkspaces={loadingWorkspaces} workspaceError={workspaceError}
      t={t} onNode={pickNode} onWorkspace={pickWorkspace}
    />
    {composing && continueTarget !== null && <div className={css.continueCard}>
      <strong>{t('continueBadge')}</strong>
      <p>{t('continueTargetLine', {
        title: continueTarget.title.length > 0 ? continueTarget.title : t('untitledTask'),
        taskId: abbreviateId(continueTarget.taskId),
        target: targetLabel,
      })}</p>
      <p className={css.scopeNote}>{t('continueSelectedHint')}</p>
      <button type="button" className={css.secondary} onClick={() => { setContinueTarget(null) }}>{t('clearSelection')}</button>
    </div>}
    <div className={css.composer}>
      <label className={css.field}><span className={css.fieldLabel}>{t('titleField')}</span>
        <input value={title} maxLength={200} onChange={(event) => { setTitle(event.target.value) }} />
      </label>
      <label className={css.field}><span className={css.fieldLabel}>{t('promptField')}</span>
        <textarea rows={5} value={prompt} placeholder={t('promptPlaceholder')} onChange={(event) => { setPrompt(event.target.value) }} />
      </label>
      <div className={css.composerFooter}>
        <p className={css.validation}>{validation}</p>
        <button type="button" className={css.primary} disabled={sending || !routeReady || !promptReady} onClick={send}>
          {sending ? t('sending') : composing && continueTarget !== null ? t('sendContinue') : t('sendTask')}
        </button>
      </div>
      {error.length > 0 && <p role="alert" className={css.error}>{error}</p>}
    </div>
    {routeReady
      ? <WorkspaceTaskBrowser
        actions={actions} t={t} nodeId={nodeId} workspacePath={workspacePath}
        targetLabel={targetLabel}
        onOpenWorkbenchTask={onOpenTask}
        selectable={composing}
        selectedTaskId={continueTarget?.taskId ?? null}
        onSelectTask={(task) => { setContinueTarget(task === null ? null : { taskId: task.taskId, title: task.title }) }}
      />
      : <section className={css.panel}><p>{t('pickWorkspaceForTasks')}</p></section>}
  </section>
}

/** Task detail with the fixed binding, sync strip, transcript, and inspector. */
function TaskDetail(props: { actions: WorkbenchActions; taskId: string; t: WorkbenchPanelProps['t']; onBack: () => void }) {
  const { actions, taskId, t, onBack } = props
  const [detail, setDetail] = useState<WorkbenchTaskDetailView | null>(null)
  const [error, setError] = useState('')
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
  if (detail === null) {
    return <div className={css.panel}><p>{error.length > 0 ? error : t('loadingWorkspaces')}</p><button type="button" className={css.secondary} onClick={onBack}>{t('back')}</button></div>
  }
  const cancellable = detail.status === 'running' || detail.status === 'zcode_acknowledged' || detail.status === 'dispatching' || detail.echoLost
  return <div>
    <header className={css.detailHead}>
      <div>
        <h2>{detail.title}</h2>
        {detail.desktopTaskId !== null && <p className={css.taskMeta}>
          <span className={css.badgeContinue}>{t('continueBadge')}</span>
          {` ${t('originalDesktopTask')} ${abbreviateId(detail.desktopTaskId)}`}
        </p>}
        <p>{detail.promptPreview}</p>
      </div>
      <div className={css.detailActions}>
        {detail.retryAllowed && <button type="button" className={css.secondary} onClick={() => { void actions.retryTask(taskId).then(() => { refresh() }, (reason: unknown) => { setError(messageOf(reason, t)) }) }}>{t('retry')}</button>}
        {cancellable && <button type="button" className={css.secondary} onClick={() => { void actions.cancelTask(taskId).then(() => { refresh() }, (reason: unknown) => { setError(messageOf(reason, t)) }) }}>{t('cancel')}</button>}
        <button type="button" className={css.secondary} onClick={onBack}>{t('back')}</button>
      </div>
    </header>
    {detail.nodeLabel !== null && <BindingBar task={detail} t={t} />}
    {detail.nodeLabel !== null && <SyncStrip task={detail} t={t} />}
    {detail.awaitingInput && <p role="status" className={css.notice}>{t('awaitingInput')}</p>}
    {detail.echoLost && <p role="alert" className={css.noticeWarn}>{t('echoLost')}</p>}
    {detail.lastError !== null && !detail.echoLost && <p role="alert" className={css.noticeWarn}>{t('lastError')}: {detail.lastError}</p>}
    <div className={css.runGrid}>
      <Transcript events={detail.transcript} t={t} />
      <TaskInspector task={detail} t={t} />
    </div>
    {error.length > 0 && <p role="alert" className={css.error}>{error}</p>}
  </div>
}

/** Main-panel occupant: the workbench task center. */
export function TaskCenterPanel(props: WorkbenchPanelProps) {
  const { t } = props
  const [mode, setMode] = useState<'list' | 'new' | 'detail'>('list')
  const [tasks, setTasks] = useState<WorkbenchTaskView[]>([])
  const [detailId, setDetailId] = useState('')
  const [routeTaskId, setRouteTaskId] = useState<string | undefined>(undefined)
  const [listError, setListError] = useState('')
  const connectionState = useConnectionSnapshot(props.connection)
  useEffect(() => {
    recordWorkbenchPanelMounted()
    return () => { recordWorkbenchPanelUnmounted(props.connection?.getSnapshot() === 'connected') }
  }, [props.connection])
  useEffect(() => {
    if (mode === 'detail') return
    let active = true
    const refresh = () => {
      void props.tasks().then((value) => {
        if (active) { setTasks(value); setListError('') }
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
  }, [props, t, mode])
  return <WorkbenchBoundary t={t}>
    <div className={css.root}>
      <header className={css.pageHead}>
        <div>
          <h1>{t('panelTitle')}</h1>
          <p>{t('taskListHint')}</p>
        </div>
        {mode !== 'new' && <button type="button" className={css.primary} onClick={() => { setRouteTaskId(undefined); setMode('new') }}>{t('newTask')}</button>}
      </header>
      {connectionState !== 'connected' && <p role="status" className={css.notice}>{t('reconnecting')}</p>}
      {mode === 'new' && <ComposeForm
        actions={props} t={t} presetTaskId={routeTaskId}
        onDispatched={(id) => { setDetailId(id); setMode('detail') }}
        onOpenTask={(id) => { setDetailId(id); setMode('detail') }}
      />}
      {mode === 'detail' && <TaskDetail actions={props} taskId={detailId} t={t} onBack={() => { setMode('list') }} />}
      {mode === 'list' && <>
        <div className={css.sectionBar}><h2>{t('taskListTitle')}</h2><span>{t('taskListHint')}</span></div>
        {listError.length > 0 && <p role="alert" className={css.error}>{listError}</p>}
        {tasks.length === 0 && <div className={css.panel}><p>{t('empty')}</p></div>}
        <div className={css.taskList}>
          {tasks.map(task => <TaskRow
            key={task.workbenchTaskId} task={task} t={t}
            onOpen={() => { setDetailId(task.workbenchTaskId); setMode('detail') }}
            onRoute={() => { setRouteTaskId(task.workbenchTaskId); setMode('new') }}
          />)}
        </div>
      </>}
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
