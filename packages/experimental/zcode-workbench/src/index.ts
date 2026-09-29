/**
 * Zcode workbench Host plugin: the durable task center, the dispatched-node
 * registry, the ACP dispatch layer, and the local Codex ingress. The service
 * is exposed to the Client through Typert Remote methods; every view crossing
 * the wire is scrubbed and carries no connection addresses or credentials.
 */
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { AcpAgentProcess, listDesktopTasks, listWorkspaceOptions, probeHealth, readDesktopTaskSnapshot, reconcileFollowupDispatch, runDispatch, sameWorkspacePath, type DispatchEvent } from './acp.ts'
import { createIngressRoute } from './ingress.ts'
import { NodeStore, validateNodeInput } from './nodes.ts'
import { isTerminal, projectTaskView, retryAllowed, routeLocked, transitionAllowed } from './state.ts'
import { TaskStore } from './store.ts'
import type {
  IngressInfo, WorkbenchComposeRequest, WorkbenchContinueRequest, WorkbenchNodeInput, WorkbenchReconcileFollowupRequest,
  WorkbenchReconcileFollowupResult, WorkbenchRouteRequest, WorkbenchTaskDetailView, WorkbenchTaskStatus, WorkbenchTaskView,
  WorkspaceTasksView, ZcodeDesktopTaskSnapshotResult, ZcodeDesktopTaskView, ZcodeNodeRecord, ZcodeNodeView,
  ZcodeWorkspaceListing,
} from './types.ts'

/** Deployment-owned settings; credentials live in adapter configuration files the nodes point at. */
export interface Config {
  /** Private directory for task and node records; outside the repository. */
  stateDir: string
  /** Ingress route path on the web server. @default '/zcode-workbench/ingress' */
  ingressPath: string
  /** Operator-owned bearer token file; the ingress answers 503 until it exists. */
  ingressTokenFile: string
  /** Retained task records. @default 200 */
  maxTasks: number
  /** Whole-turn dispatch budget in milliseconds. @default 600000 */
  dispatchTimeoutMs: number
  /** Health probe and workspace-discovery budget in milliseconds. @default 20000 */
  healthTimeoutMs: number
}

/** Required state settings with bounded tunables; no defaults hide deployment choices. */
export const Config: z<Config> = z.object({
  stateDir: z.string().required(),
  ingressPath: z.string().default('/zcode-workbench/ingress'),
  ingressTokenFile: z.string().required(),
  maxTasks: z.number().min(10).max(1000).step(1).default(200),
  dispatchTimeoutMs: z.number().min(1000).max(3_600_000).step(1).default(600_000),
  healthTimeoutMs: z.number().min(1000).max(120_000).step(1).default(20_000),
})

declare module '@deepseek-ai/cordis' {
  interface Context { /** Zcode workbench task center and dispatch owner. */ zcodeWorkbench: ZcodeWorkbench }
}

/** One in-flight (or echo-lost) dispatch handle. */
interface LiveDispatch {
  agent: AcpAgentProcess | null
  acpSessionId: string | null
}

/** One workbench-side write-off audit entry (append-only `reconcile-ledger.jsonl`). */
interface ReconcileLedgerEntry {
  v: 1
  kind: 'reconcile-followup'
  at: string
  workbenchTaskId: string
  desktopTaskId: string
  nodeId: string
  nodeLabel: string
  workspacePath: string | null
  commandId: string | null
  commandKind: string | null
  evidence: {
    taskStatus: string | null
    taskUpdatedAt: string | null
    phase: string | null
    pendingInteractions: number | null
    promptMatched: boolean | null
  }
  mode: 'human-verified'
  operator: string
  siteAlreadyReconciled: boolean
}

/** Statuses under which a desktop task's follow-up round still blocks a new one. */
const IN_FLIGHT_STATUSES: ReadonlySet<WorkbenchTaskStatus> = new Set([
  'received', 'awaiting_route', 'dispatching', 'zcode_acknowledged', 'running',
])

/** Host service owning the task center, node registry, dispatch, and ingress. */
export class ZcodeWorkbench extends TypertRemoteService {
  static inject = ['typert']
  /** Validated deployment configuration. */
  static Config = Config
  private readonly taskStore: TaskStore
  private readonly nodeRegistry: NodeStore
  private readonly config: Config
  private readonly live = new Map<string, LiveDispatch>()
  private readonly nodeQueues = new Map<string, Promise<unknown>>()
  /** Resolves when both stores are loaded; every public method awaits it. */
  private readonly ready: Promise<void>

  /**
   * @param ctx - owning Host context.
   * @param config - validated deployment configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'zcodeWorkbench')
    this.config = config
    this.taskStore = new TaskStore(config.stateDir, config.maxTasks)
    this.nodeRegistry = new NodeStore(config.stateDir)
    this.ready = this.taskStore.load()
      .then(() => this.taskStore.reconcileInterruptedDispatches())
      .then(() => this.nodeRegistry.load())
    this.ready.catch((error: unknown) => {
      ctx.logger('zcode-workbench').error('store load failed: %s', error instanceof Error ? error.message : 'unknown')
    })
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register(createIngressRoute(config.ingressPath, config.ingressTokenFile, this.taskStore)), 'zcode-workbench: ingress route')
    })
    ctx.effect(() => () => {
      for (const dispatch of this.live.values()) void dispatch.agent?.kill()
      this.live.clear()
    }, 'zcode-workbench: dispatch shutdown')
  }

  /** Serialize node-exclusive work: the site control channel is single-slot per node. */
  private enqueueNode<T>(nodeId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.nodeQueues.get(nodeId) ?? Promise.resolve()
    const next = previous.then(run, run)
    this.nodeQueues.set(nodeId, next.catch(() => undefined))
    return next
  }

  /**
   * List nodes with their last health probe result.
   * @returns independent node views.
   */
  @Remote
  async nodes(): Promise<ZcodeNodeView[]> {
    await this.ready
    return this.nodeRegistry.list().map(node => ({ ...node, health: this.nodeRegistry.healthOf(node.id) }))
  }

  /**
   * Create or update one node definition.
   *
   * A per-session (`workspaceSelection: 'session'`) node is only persisted
   * after a live capability probe proves its adapter really serves workspace
   * options through `session/new`. Health alone cannot prove this: a
   * fixed-workspace adapter answers `--health` online with workspaces while
   * session/new offers no workspace option, which would strand the routing
   * page with nothing dispatchable (the 2026-09-22 live regression). The probe
   * serializes with dispatches and other probes on the same node id.
   *
   * @param input - validated node submission.
   * @returns the stored node view.
   */
  @Remote
  async saveNode(input: WorkbenchNodeInput): Promise<ZcodeNodeView> {
    await this.ready
    validateNodeInput(input)
    if (input.workspaceSelection === 'session') {
      const probe: ZcodeNodeRecord = { ...input, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      await this.enqueueNode(input.id, () => listWorkspaceOptions(probe, this.config.healthTimeoutMs)).catch((error: unknown) => {
        throw new Error(`cannot save this node for per-session workspace selection: ${error instanceof Error ? error.message : 'unknown failure'}`)
      })
    }
    const record = await this.nodeRegistry.save(input)
    return { ...record, health: this.nodeRegistry.healthOf(record.id) }
  }

  /**
   * Remove one node definition. Tasks keep their recorded labels.
   * @param id - node id.
   * @returns whether a node was removed.
   */
  @Remote
  async removeNode(id: string): Promise<boolean> {
    await this.ready
    return this.nodeRegistry.remove(id)
  }

  /**
   * Run one read-only health probe (`--health`) and record the outcome.
   * Probes serialize with dispatches on the same node.
   * @param id - node id.
   * @returns the node view with the fresh probe result.
   */
  @Remote
  async checkNode(id: string): Promise<ZcodeNodeView> {
    await this.ready
    const node = this.nodeRegistry.get(id)
    if (node === undefined) throw new Error(`unknown node ${id}`)
    this.nodeRegistry.markChecking(id)
    const checkedAt = new Date().toISOString()
    const probe = await this.enqueueNode(id, async () => {
      const health = await probeHealth(node, this.config.healthTimeoutMs)
      if (!health.online || node.workspaceSelection === 'fixed') return health
      try {
        const listing = await listWorkspaceOptions(node, this.config.healthTimeoutMs)
        return {
          ...health,
          desktopVersion: listing.desktopVersion ?? health.desktopVersion,
          workspaceCount: listing.options.length,
        }
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : String(reason)
        return {
          online: false,
          desktopVersion: health.desktopVersion,
          workspaceCount: null,
          detail: `node is reachable but session workspace discovery failed: ${detail}`,
        }
      }
    })
    await this.nodeRegistry.saveHealth(id, probe.online
      ? {
        state: 'online',
        checkedAt,
        desktopVersion: probe.desktopVersion,
        workspaceCount: probe.workspaceCount,
        detail: probe.detail,
      }
      : { state: 'offline', checkedAt, desktopVersion: null, workspaceCount: null, detail: probe.detail })
    return { ...node, health: this.nodeRegistry.healthOf(id) }
  }

  /**
   * Read one node's live workspace options through session discovery.
   * @param id - node id.
   * @returns the site's own option list; `fixed` nodes answer their opaque pin.
   */
  @Remote
  async listWorkspaces(id: string): Promise<ZcodeWorkspaceListing> {
    await this.ready
    const node = this.nodeRegistry.get(id)
    if (node === undefined) throw new Error(`unknown node ${id}`)
    return this.enqueueNode(id, () => listWorkspaceOptions(node, this.config.healthTimeoutMs))
  }

  /**
   * Read the tasks of one selected workspace. The desktop side comes from the
   * Zcode desktop's own synced task index (read-only, no session, serialized
   * with dispatches on the node); the workbench side is this store's recorded
   * tasks filtered to the node and workspace. A failed desktop listing is
   * reported as `unavailable` — it is never faked from the workbench side.
   * @param id - node id.
   * @param workspacePath - selected workspace; required for `session` nodes,
   *   ignored for `fixed` nodes (the adapter resolves its pinned workspace).
   * @returns both task sources plus the explicit desktop capability facet.
   */
  @Remote
  async workspaceTasks(id: string, workspacePath: string): Promise<WorkspaceTasksView> {
    await this.ready
    const node = this.nodeRegistry.get(id)
    if (node === undefined) throw new Error(`unknown node ${id}`)
    if (node.workspaceSelection === 'session' && workspacePath.length === 0) {
      throw new Error('this node selects its workspace per session; pick one before reading its tasks')
    }
    const effectivePath = node.workspaceSelection === 'fixed' ? '' : workspacePath
    let records = this.taskStore.list().filter(record => record.nodeId === node.id
      && (node.workspaceSelection === 'fixed' || (record.workspacePath !== null && sameWorkspacePath(record.workspacePath, workspacePath))))
    let desktop: WorkspaceTasksView['desktop']
    try {
      const report = await this.enqueueNode(node.id, () => listDesktopTasks(node, effectivePath, this.config.healthTimeoutMs))
      // Adapter-verified identity backfill: a fresh compose round records
      // only its ACP session id — its desktop task id lives solely in the
      // adapter's binding. The index rows carry that verified link
      // (dshSessionId → taskId), so the first listing that sees it stamps the
      // durable desktopTaskId onto the round, keeping the round chain one
      // conversation after completion, restarts, and index outages (the
      // sampled join alone cannot). Conservative on purpose: only records
      // with no desktopTaskId yet, only sessions the index binds to exactly
      // one task, never a rewrite, never a guess — a missing or conflicted
      // binding leaves the record untouched.
      const sessionOwners = new Map<string, string>()
      const conflictedSessions = new Set<string>()
      for (const task of report.tasks) {
        if (task.dshSessionId === undefined || task.taskId.length === 0) continue
        const owner = sessionOwners.get(task.dshSessionId)
        if (owner === undefined) sessionOwners.set(task.dshSessionId, task.taskId)
        else if (owner !== task.taskId) conflictedSessions.add(task.dshSessionId)
      }
      let backfilled = false
      for (const record of records) {
        if (record.desktopTaskId !== null || record.acpSessionId === null) continue
        if (conflictedSessions.has(record.acpSessionId)) continue
        const taskId = sessionOwners.get(record.acpSessionId)
        if (taskId === undefined) continue
        const session = record.acpSessionId
        const updated = await this.taskStore.update(record.workbenchTaskId, current => {
          // Re-check inside the serialized transaction: an interleaved update
          // (a concurrent listing, a racing dispatch transition) may have
          // claimed the record between the snapshot and this write. The
          // adapter-verified binding only ever stamps an unclaimed record of
          // the same session on the same node — an existing desktop task id,
          // a moved session, or a rerouted record is never overwritten.
          if (current.desktopTaskId !== null || current.acpSessionId !== session || current.nodeId !== node.id) return
          current.desktopTaskId = taskId
        })
        if (updated !== undefined && updated.desktopTaskId === taskId) backfilled = true
      }
      if (backfilled) {
        records = this.taskStore.list().filter(record => record.nodeId === node.id
          && (node.workspaceSelection === 'fixed' || (record.workspacePath !== null && sameWorkspacePath(record.workspacePath, workspacePath))))
      }
      // Newest record wins per binding id: a continued desktop task may have
      // several rounds sharing one adapter session, and an explicit
      // desktopTaskId link names the newest continuation round exactly.
      const byDshSession = new Map<string, string>()
      for (const record of records) {
        if (record.acpSessionId === null || byDshSession.has(record.acpSessionId)) continue
        byDshSession.set(record.acpSessionId, record.workbenchTaskId)
      }
      const tasks: ZcodeDesktopTaskView[] = report.tasks.map(task => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        origin: task.origin,
        workbenchTaskId: records.find(record => record.desktopTaskId === task.taskId)?.workbenchTaskId
          ?? (task.dshSessionId !== undefined ? (byDshSession.get(task.dshSessionId) ?? null) : null),
      }))
      desktop = { state: 'ok', desktopVersion: report.desktopVersion, tasks }
    } catch (reason) {
      desktop = { state: 'unavailable', reason: reason instanceof Error ? reason.message : 'the desktop task listing failed' }
    }
    return {
      nodeId: node.id,
      workspacePath: node.workspaceSelection === 'fixed' ? null : workspacePath,
      desktop,
      workbench: records.map(projectTaskView),
    }
  }

  /**
   * Read one native desktop task's conversation snapshot through the node's
   * read-only `--task-snapshot` mode. The read is a one-shot adapter process
   * with no session, no `session/adopt`, and no effect on the desktop task —
   * opening a detail never adopts. The site's single control channel is
   * respected through the node queue: a snapshot read waits behind an active
   * dispatch instead of pairing a second controller connection, and a failed
   * read answers `unavailable` with its reason instead of being faked.
   * @param id - node id.
   * @param workspacePath - selected workspace; required for `session` nodes,
   *   ignored for `fixed` nodes (the adapter resolves its pinned workspace).
   * @param desktopTaskId - full desktop task (conversation session) id.
   * @returns the ok/unavailable snapshot result.
   */
  @Remote
  async desktopTaskSnapshot(id: string, workspacePath: string, desktopTaskId: string): Promise<ZcodeDesktopTaskSnapshotResult> {
    await this.ready
    if (desktopTaskId.length === 0 || desktopTaskId.length > 200) {
      throw new Error('desktopTaskId must be 1..200 characters')
    }
    const node = this.nodeRegistry.get(id)
    if (node === undefined) throw new Error(`unknown node ${id}`)
    if (node.workspaceSelection === 'session' && workspacePath.length === 0) {
      throw new Error('this node selects its workspace per session; pick one before reading a task snapshot')
    }
    const effectivePath = node.workspaceSelection === 'fixed' ? '' : workspacePath
    return this.enqueueNode(node.id, () => readDesktopTaskSnapshot(node, effectivePath, desktopTaskId, this.config.healthTimeoutMs))
  }

  /**
   * Every retained task, newest first.
   * @returns independent wire views.
   */
  @Remote
  async tasks(): Promise<WorkbenchTaskView[]> {
    await this.ready
    return this.taskStore.list().map(projectTaskView)
  }

  /**
   * One task with its capped transcript. Reading a terminal workbench-origin
   * task that cannot be retried marks it reported: the workbench is its
   * origin and has now seen the result.
   * @param workbenchTaskId - task id.
   * @returns the task detail, or undefined for an unknown id.
   */
  @Remote
  async task(workbenchTaskId: string): Promise<WorkbenchTaskDetailView | undefined> {
    await this.ready
    let record = this.taskStore.get(workbenchTaskId)
    if (record === undefined) return undefined
    if (record.source === 'workbench' && isTerminal(record.status) && !retryAllowed(record)) {
      await this.taskStore.transition(workbenchTaskId, 'reported')
      record = this.taskStore.get(workbenchTaskId) ?? record
    }
    return {
      ...projectTaskView(record),
      prompt: record.prompt,
      transcript: record.transcript.map(event => ({ ...event })),
      retryAllowed: retryAllowed(record),
    }
  }

  /**
   * Compose and dispatch one workbench-origin task. The route must be
   * complete; dispatch itself runs in the background and the task view is
   * available for polling immediately.
   * @param request - title, prompt, node, and workspace.
   * @returns the created task view.
   */
  @Remote
  async composeTask(request: WorkbenchComposeRequest): Promise<WorkbenchTaskView> {
    await this.ready
    if (request.prompt.length === 0 || request.prompt.length > 20_000) throw new Error('prompt must be 1..20000 characters')
    if (request.title.length > 200) throw new Error('title must be at most 200 characters')
    const node = this.nodeRegistry.get(request.nodeId)
    if (node === undefined) throw new Error(`unknown node ${request.nodeId}`)
    if (node.workspaceSelection === 'session' && request.workspacePath.length === 0) {
      throw new Error('this node selects its workspace per session; pick one before sending')
    }
    const { record } = await this.taskStore.create({
      source: 'workbench',
      sourceTaskId: null,
      threadId: null,
      title: request.title.length > 0 ? request.title : request.prompt.slice(0, 60),
      prompt: request.prompt,
      now: new Date(),
    })
    await this.routeAndDispatch(record.workbenchTaskId, node, request.workspacePath)
    const updated = this.taskStore.get(record.workbenchTaskId) ?? record
    return projectTaskView(updated)
  }

  /**
   * Continue one existing Zcode desktop task with a follow-up round. The
   * round is recorded as its own task carrying the original `desktopTaskId`;
   * dispatch adopts the desktop task through the adapter (which verifies
   * workspace ownership, completion, and no pending interaction before
   * binding) and then sends the prompt into that same conversation — never a
   * replacement task. One desktop task admits at most one active round per
   * node and workspace: a second submission while one is in flight, or while
   * its desktop outcome is unknown (echo lost), is refused instead of sent
   * twice.
   * @param request - node, workspace, original desktop task id, and prompt.
   * @returns the created continuation-round task view.
   */
  @Remote
  async continueDesktopTask(request: WorkbenchContinueRequest): Promise<WorkbenchTaskView> {
    await this.ready
    if (request.prompt.length === 0 || request.prompt.length > 20_000) throw new Error('prompt must be 1..20000 characters')
    if (request.title.length > 200) throw new Error('title must be at most 200 characters')
    if (request.desktopTaskId.length === 0 || request.desktopTaskId.length > 200) {
      throw new Error('desktopTaskId must be 1..200 characters')
    }
    const node = this.nodeRegistry.get(request.nodeId)
    if (node === undefined) throw new Error(`unknown node ${request.nodeId}`)
    if (node.workspaceSelection === 'session' && request.workspacePath.length === 0) {
      throw new Error('this node selects its workspace per session; pick one before sending')
    }
    const { record } = await this.taskStore.create({
      source: 'workbench',
      sourceTaskId: null,
      threadId: null,
      title: request.title.length > 0 ? request.title : request.prompt.slice(0, 60),
      prompt: request.prompt,
      now: new Date(),
      desktopTaskId: request.desktopTaskId,
    }, {
      conflicts: record => record.desktopTaskId === request.desktopTaskId && record.nodeId === node.id
        && (node.workspaceSelection === 'fixed'
          || (record.workspacePath !== null && sameWorkspacePath(record.workspacePath, request.workspacePath)))
        && (IN_FLIGHT_STATUSES.has(record.status) || record.echoLost),
      refusal: 'this desktop task already has a follow-up in flight on this node; wait for it to finish or verify it in the Zcode desktop',
    })
    await this.routeAndDispatch(record.workbenchTaskId, node, request.workspacePath)
    const updated = this.taskStore.get(record.workbenchTaskId) ?? record
    return projectTaskView(updated)
  }

  /**
   * Choose the route for an un-routed task and dispatch it. The route locks
   * with the first dispatched prompt.
   * @param request - task id, node, and workspace.
   * @returns the updated task view.
   */
  @Remote
  async routeTask(request: WorkbenchRouteRequest): Promise<WorkbenchTaskView> {
    await this.ready
    const record = this.taskStore.get(request.workbenchTaskId)
    if (record === undefined) throw new Error(`unknown task ${request.workbenchTaskId}`)
    if (routeLocked(record)) throw new Error('the task route is locked after its first dispatch')
    const node = this.nodeRegistry.get(request.nodeId)
    if (node === undefined) throw new Error(`unknown node ${request.nodeId}`)
    if (node.workspaceSelection === 'session' && request.workspacePath.length === 0) {
      throw new Error('this node selects its workspace per session; pick one before sending')
    }
    await this.routeAndDispatch(request.workbenchTaskId, node, request.workspacePath)
    const updated = this.taskStore.get(request.workbenchTaskId) ?? record
    return projectTaskView(updated)
  }

  /**
   * Retry a failed dispatch that never sent a prompt, under the same task id.
   * @param workbenchTaskId - task id.
   * @returns the updated task view.
   */
  @Remote
  async retryTask(workbenchTaskId: string): Promise<WorkbenchTaskView> {
    await this.ready
    const record = this.taskStore.get(workbenchTaskId)
    if (record === undefined) throw new Error(`unknown task ${workbenchTaskId}`)
    if (!retryAllowed(record)) {
      throw new Error('this task already sent a prompt; its desktop outcome must be verified instead of re-dispatched')
    }
    if (record.nodeId === null) throw new Error('this task has no route; choose node and workspace first')
    const node = this.nodeRegistry.get(record.nodeId)
    if (node === undefined) throw new Error(`unknown node ${record.nodeId}`)
    await this.routeAndDispatch(workbenchTaskId, node, record.workspacePath ?? '')
    const updated = this.taskStore.get(workbenchTaskId) ?? record
    return projectTaskView(updated)
  }

  /**
   * Request cancellation of a live or echo-lost task.
   * @param workbenchTaskId - task id.
   * @returns the updated task view.
   */
  @Remote
  async cancelTask(workbenchTaskId: string): Promise<WorkbenchTaskView> {
    await this.ready
    const record = this.taskStore.get(workbenchTaskId)
    if (record === undefined) throw new Error(`unknown task ${workbenchTaskId}`)
    const dispatch = this.live.get(workbenchTaskId)
    if (dispatch?.agent != null && dispatch.agent.alive && dispatch.acpSessionId !== null) {
      dispatch.agent.notify('session/cancel', { sessionId: dispatch.acpSessionId })
    } else if (record.status === 'running' || record.status === 'zcode_acknowledged' || record.echoLost) {
      await this.taskStore.transition(workbenchTaskId, 'cancelled', {
        lastError: 'cancelled by the workbench; verify the task in the Zcode desktop',
      })
    }
    const updated = this.taskStore.get(workbenchTaskId) ?? record
    return projectTaskView(updated)
  }

  /**
   * Ingress reachability summary for the settings page.
   * @returns route path and whether the token file is provisioned.
   */
  @Remote
  async ingressInfo(): Promise<IngressInfo> {
    let provisioned = false
    try {
      provisioned = (await readFile(this.config.ingressTokenFile, 'utf8')).trim().length >= 16
    } catch {
      provisioned = false
    }
    return { path: this.config.ingressPath, provisioned }
  }

  /**
   * Verify — and under an explicit human attestation, write off — one echo-lost
   * follow-up round, releasing both locks that keep its original desktop task
   * from accepting a new follow-up: the site adapter's unresolved dispatch
   * ledger entry and this record's echo-lost state. Without `confirm` the pass
   * is read-only evidence gathering. The desktop protocol cannot prove a lost
   * command was not applied, so the write-off requires the operator's
   * `humanVerified` attestation and refuses on every contrary or unreadable
   * signal: the round still dispatching, the instruction visible in the
   * desktop conversation, the task running or awaiting input, an unknown task
   * state, a missing or out-of-scope binding, or a duplicate write-off. It
   * never re-sends the old instruction and never creates a desktop task.
   * @param request - the echo-lost round plus the optional attestation.
   * @returns the site evidence and what this pass changed.
   */
  @Remote
  async reconcileEchoLostFollowup(request: WorkbenchReconcileFollowupRequest): Promise<WorkbenchReconcileFollowupResult> {
    await this.ready
    if (request.workbenchTaskId.length === 0 || request.workbenchTaskId.length > 200) {
      throw new Error('workbenchTaskId must be 1..200 characters')
    }
    const confirm = request.confirm
    if (confirm !== undefined) {
      if (!confirm.humanVerified) throw new Error('the write-off requires an explicit human verification attestation')
      if (confirm.operator.trim().length === 0 || confirm.operator.length > 100 || /[\r\n\0]/.test(confirm.operator)) {
        throw new Error('confirm.operator must be 1..100 characters without line breaks')
      }
    }
    const record = this.taskStore.get(request.workbenchTaskId)
    if (record === undefined) throw new Error(`unknown task ${request.workbenchTaskId}`)
    // The durable echo-lost flag may be written before the original dispatch
    // releases its live handle. Never clear either lock while that turn owns it.
    if (this.live.has(request.workbenchTaskId)) {
      throw new Error('this round is still dispatching in this process; wait for it to settle before reconciling')
    }
    if (!record.echoLost) {
      throw new Error('only rounds whose desktop outcome is unknown (echo lost) can be reconciled')
    }
    if (record.desktopTaskId === null) {
      throw new Error('this round is not a continuation; there is no follow-up lock to reconcile')
    }
    const node = this.nodeRegistry.get(record.nodeId ?? '')
    if (node === undefined) throw new Error('the routed node no longer exists; the follow-up lock cannot be verified')
    const desktopTaskId = record.desktopTaskId
    const report = await this.enqueueNode(node.id, () => reconcileFollowupDispatch(node, {
      desktopTaskId,
      workspacePath: record.workspacePath ?? '',
      expectedPromptText: record.prompt,
      confirmHumanVerified: confirm !== undefined,
      operator: confirm?.operator ?? '',
      timeoutMs: this.config.healthTimeoutMs,
    }))
    if (report.reason !== null) {
      throw new Error(`the node refused to reconcile the follow-up (${report.reason}); nothing was written off`)
    }
    const evidence: WorkbenchReconcileFollowupResult['evidence'] = {
      taskStatus: report.taskStatus,
      taskUpdatedAt: report.taskUpdatedAt,
      phase: report.phase,
      pendingInteractions: report.pendingInteractions,
      promptMatched: report.promptMatched,
    }
    if (confirm === undefined || !report.writtenOff) {
      return {
        workbenchTaskId: record.workbenchTaskId,
        desktopTaskId,
        writtenOff: false,
        workbenchRecordUpdated: false,
        evidence,
        commandId: report.commandId,
      }
    }
    // The site side settled: audit first, then clear this record's lock so a
    // torn run between the two leaves a retriable state, not a silent unlock.
    await this.appendReconcileLedger({
      v: 1,
      kind: 'reconcile-followup',
      at: new Date().toISOString(),
      workbenchTaskId: record.workbenchTaskId,
      desktopTaskId,
      nodeId: node.id,
      nodeLabel: node.label,
      workspacePath: record.workspacePath,
      commandId: report.commandId,
      commandKind: report.commandKind,
      evidence,
      mode: 'human-verified',
      operator: confirm.operator,
      siteAlreadyReconciled: report.alreadyReconciled,
    })
    const note = `written off after on-site verification: the desktop command ${report.commandId ?? 'unknown'} was not applied; operator ${confirm.operator}`
    await this.taskStore.update(request.workbenchTaskId, (current) => {
      if (!current.echoLost) throw new Error('the round was already reconciled while this pass ran')
      if (transitionAllowed(current.status, 'cancelled')) {
        current.status = 'cancelled'
        current.terminalOutcome = 'cancelled'
        current.transcript.push({ at: new Date().toISOString(), kind: 'status', text: 'cancelled', key: null, toolStatus: null })
      }
      current.echoLost = false
      current.awaitingInput = false
      current.lastError = note
      current.transcript.push({ at: new Date().toISOString(), kind: 'status', text: 'written off after verification', key: null, toolStatus: null })
    })
    return {
      workbenchTaskId: record.workbenchTaskId,
      desktopTaskId,
      writtenOff: true,
      workbenchRecordUpdated: true,
      evidence,
      commandId: report.commandId,
    }
  }

  /** Serialized append-only audit writes; concurrent reconciles never interleave lines. */
  private reconcileLedgerChain: Promise<void> = Promise.resolve()

  private appendReconcileLedger(entry: ReconcileLedgerEntry): Promise<void> {
    const run = this.reconcileLedgerChain
      .then(() => appendFile(join(this.config.stateDir, 'reconcile-ledger.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8'))
    this.reconcileLedgerChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Stamp the route, move to dispatching, and start the background run. */
  private async routeAndDispatch(workbenchTaskId: string, node: { id: string; label: string; workspaceSelection: 'fixed' | 'session' }, workspacePath: string): Promise<void> {
    await this.taskStore.update(workbenchTaskId, (record) => {
      record.nodeId = node.id
      record.nodeLabel = node.label
      record.workspacePath = node.workspaceSelection === 'fixed' ? null : workspacePath
      record.workspaceLabel = node.workspaceSelection === 'fixed' ? `${node.label} · pinned` : workspacePath
      record.echoLost = false
      record.lastError = null
    })
    await this.taskStore.transition(workbenchTaskId, 'dispatching')
    void this.runDispatchGuarded(workbenchTaskId)
  }

  /** Background dispatch with the full event → store mapping. */
  private async runDispatchGuarded(workbenchTaskId: string): Promise<void> {
    try {
      await this.runDispatchTracked(workbenchTaskId)
    } catch (error) {
      await this.taskStore.transition(workbenchTaskId, 'failed', {
        lastError: `internal dispatch error: ${error instanceof Error ? error.message : 'unknown'}`,
      }).catch(() => undefined)
    } finally {
      this.live.delete(workbenchTaskId)
    }
  }

  private async runDispatchTracked(workbenchTaskId: string): Promise<void> {
    const record = this.taskStore.get(workbenchTaskId)
    if (record === undefined) throw new Error(`unknown task ${workbenchTaskId}`)
    const node = this.nodeRegistry.get(record.nodeId ?? '')
    if (node === undefined) {
      await this.taskStore.transition(workbenchTaskId, 'failed', { lastError: 'the routed node no longer exists' })
      return
    }
    const dispatch: LiveDispatch = { agent: null, acpSessionId: null }
    this.live.set(workbenchTaskId, dispatch)
    // Events must land on the record in emission order: `acknowledged`
    // precedes the first streamed frame, and the state machine refuses the
    // shortcut a racing applier would attempt.
    let eventChain: Promise<void> = Promise.resolve()
    await this.enqueueNode(node.id, () => runDispatch({
      node,
      workspacePath: record.workspacePath ?? '',
      prompt: record.prompt,
      timeoutMs: this.config.dispatchTimeoutMs,
      // A continuation round adopts the original desktop task instead of
      // creating a session; fresh tasks take the session/new path unchanged.
      ...(record.desktopTaskId !== null ? { adopt: record.desktopTaskId } : {}),
      onAgent: (agent, acpSessionId) => {
        dispatch.agent = agent
        dispatch.acpSessionId = acpSessionId
        eventChain = eventChain.then(async () => {
          await this.taskStore.update(workbenchTaskId, (current) => { current.acpSessionId = acpSessionId })
        })
      },
      onEvent: (event) => {
        // One failing application must not strand the task: log it, keep order.
        eventChain = eventChain
          .then(() => this.applyDispatchEvent(workbenchTaskId, event))
          .catch((error: unknown) => {
            this.ctx.logger('zcode-workbench').error('dispatch event application failed for %s: %s', workbenchTaskId, error instanceof Error ? error.message : 'unknown')
          })
      },
    }))
    await eventChain
  }

  /** Map one dispatch event onto the durable record. */
  private async applyDispatchEvent(workbenchTaskId: string, event: DispatchEvent): Promise<void> {
    switch (event.kind) {
      case 'acknowledged':
        // Submission only: the envelope was written to the node's adapter and no
        // remote confirmation exists yet. Keep the record in this stage (the UI
        // words it "submitted · awaiting confirmation") until frames stream
        // ('running'), the turn settles, or the dispatch fails.
        await this.taskStore.update(workbenchTaskId, (record) => { record.promptSentAt = new Date().toISOString() })
        await this.taskStore.transition(workbenchTaskId, 'zcode_acknowledged')
        return
      case 'running':
        await this.taskStore.transition(workbenchTaskId, 'running')
        return
      case 'transcript':
        await this.taskStore.update(workbenchTaskId, (record) => {
          const last = record.transcript[record.transcript.length - 1]
          if (last !== undefined && last.kind === 'assistant_message' && last.key === event.messageId) {
            last.text = event.text
            return
          }
          record.transcript.push({
            at: new Date().toISOString(),
            kind: 'assistant_message',
            text: event.text,
            key: event.messageId,
            toolStatus: null,
          })
        })
        return
      case 'tool':
        await this.taskStore.update(workbenchTaskId, (record) => {
          const existing = [...record.transcript].reverse().find(entry => entry.kind === 'tool_call' && entry.key === event.toolCallId)
          if (existing !== undefined) {
            existing.toolStatus = event.status
            existing.text = event.title
            return
          }
          record.transcript.push({
            at: new Date().toISOString(),
            kind: 'tool_call',
            text: event.title,
            key: event.toolCallId,
            toolStatus: event.status,
          })
        })
        return
      case 'awaiting_input':
        await this.taskStore.update(workbenchTaskId, (record) => { record.awaitingInput = event.value })
        return
      case 'completed':
        await this.taskStore.transition(workbenchTaskId, 'completed')
        return
      case 'cancelled':
        await this.taskStore.transition(workbenchTaskId, 'cancelled')
        return
      case 'failed':
        if (event.echoLost) {
          await this.taskStore.update(workbenchTaskId, (record) => {
            record.echoLost = true
            record.lastError = event.error
          })
          return
        }
        await this.taskStore.transition(workbenchTaskId, 'failed', { lastError: event.error })
        return
    }
  }
}

export default ZcodeWorkbench
