/**
 * ACP-over-stdio dispatch layer. The workbench never speaks the Zcode remote
 * protocol: it launches the operator-configured ACP agent program (the
 * verified `integrations/zcode-desktop-adapter` in production, a fixture in
 * tests) and drives it through the documented ACP method surface —
 * `initialize`, `session/new`, `session/set_config_option`, `session/prompt`,
 * `session/cancel`, plus the adapter's `session/adopt` continuation entry —
 * while consuming `session/update` notifications.
 *
 * Everything persisted or surfaced is scrubbed of URLs and capped; adapter
 * stderr is used only as fixed-string failure detail.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { NO_WORKSPACE_OPTION_MARKER, type ZcodeNodeRecord, type ZcodeWorkspaceOption } from './types.ts'

/** JSON-RPC request frame written to the agent. */
interface AcpRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: unknown
}

/** JSON-RPC notification frame written to the agent. */
interface AcpNotification {
  jsonrpc: '2.0'
  method: string
  params: unknown
}

/** One `session/update` params payload. */
interface AcpSessionUpdate {
  sessionUpdate?: string
  content?: { type?: string; text?: string }
  messageId?: string
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
}

/** One JSON-RPC error body. */
interface AcpRpcError {
  code: number
  message: string
}

/** Adapter error codes mirrored from the desktop adapter contract. */
const ERR_LINK = -32003
const ERR_TURN = -32005

/** Inbound line budget; one ACP message frame. */
const MAX_LINE_CHARS = 4 * 1024 * 1024

/** Transcript text cap per event, applied after scrubbing. */
const EVENT_TEXT_CAP = 16_384

/** Stderr tail kept for spawn diagnostics. */
const STDERR_TAIL_CHARS = 300

/**
 * Removes any URL before text crosses into workbench state. The adapter
 * scrubs its own output; this is the workbench-side defense in depth.
 */
function scrubText(value: string): string {
  return value.replace(/(?:https?|wss?):\/\/\S+/g, '[url]').slice(0, EVENT_TEXT_CAP)
}

/**
 * Whether two workspace paths name the same site workspace: backslashes and
 * trailing slashes normalize away, and Windows site paths compare
 * case-insensitively (mirroring the adapter's normalization). Task records
 * store the raw option value, so matching a later selection must tolerate
 * spelling drift without hiding tasks. Host-side only — the client face has
 * no platform signal.
 * @param left - one workspace path.
 * @param right - other workspace path.
 * @returns whether both normalize to the same site workspace.
 */
export function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replaceAll('\\', '/').replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Minimal env allowlist for the adapter process: no ambient secrets cross. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'USERPROFILE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

/**
 * One live ACP agent process: line-framed JSON-RPC over stdio. Calls resolve
 * with the agent's result or reject with a typed failure; notifications
 * surface through the constructor callback.
 */
export class AcpAgentProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly exited: Promise<number | null>
  private nextId = 1
  private buffer = ''
  private stderrTail = ''
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: AcpAgentError) => void
    timer: NodeJS.Timeout
  }>()
  #closed = false

  /**
   * @param command - adapter launcher executable.
   * @param args - adapter arguments (including `--config` and any mode flags).
   * @param onSessionUpdate - called for every `session/update` notification.
   * @param onRawLine - optional raw stdout line hook, before JSON parsing (health probes).
   */
  constructor(
    command: string,
    args: readonly string[],
    onSessionUpdate: (update: AcpSessionUpdate) => void,
    onRawLine?: (line: string) => void,
  ) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() })
    this.exited = new Promise<number | null>((resolve) => {
      this.child.once('error', () => { resolve(null) })
      this.child.once('exit', (code) => { resolve(code) })
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      if (this.buffer.length > MAX_LINE_CHARS * 2) { this.failPending(new AcpAgentError('agent-frame-limit', 'the agent stream exceeded the frame limit')); this.buffer = ''; return }
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line.length > MAX_LINE_CHARS) {
          this.failPending(new AcpAgentError('agent-frame-limit', 'an agent message exceeded the frame limit'))
          continue
        }
        if (line.length === 0) continue
        onRawLine?.(line)
        this.acceptLine(line, onSessionUpdate)
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })
    this.child.on('error', () => {
      this.failPending(new AcpAgentError('agent-start-failed', 'the agent process could not be started'))
    })
    this.child.on('exit', () => {
      this.failPending(new AcpAgentError('agent-exited', 'the agent process exited before answering'))
    })
  }

  private acceptLine(line: string, onSessionUpdate: (update: AcpSessionUpdate) => void): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null) return
    const frame = message as { id?: unknown; result?: unknown; error?: AcpRpcError; method?: unknown; params?: unknown }
    if (frame.method === 'session/update') {
      const params = frame.params as { update?: AcpSessionUpdate } | undefined
      if (typeof params === 'object' && params !== null && typeof params.update === 'object' && params.update !== null) {
        onSessionUpdate(params.update)
      }
      return
    }
    if (frame.id === undefined || frame.error !== undefined) {
      if (frame.id === undefined) return
      const waiter = this.pending.get(Number(frame.id))
      if (waiter === undefined) return
      this.pending.delete(Number(frame.id))
      clearTimeout(waiter.timer)
      waiter.reject(new AcpAgentError(`agent-code-${String(frame.error?.code)}`, scrubText(String(frame.error?.message ?? 'the agent rejected the call'))))
      return
    }
    const waiter = this.pending.get(Number(frame.id))
    if (waiter === undefined) return
    this.pending.delete(Number(frame.id))
    clearTimeout(waiter.timer)
    waiter.resolve(frame.result)
  }

  private failPending(error: AcpAgentError): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  /**
   * Fixed-string diagnostic tail from agent stderr (already bounded).
   * @returns the scrubbed stderr tail.
   */
  stderrDetail(): string {
    return this.stderrTail.replace(/(?:https?|wss?):\/\/\S+/g, '[url]').slice(-STDERR_TAIL_CHARS)
  }

  /**
   * One JSON-RPC call with a per-call timeout.
   * @param method - ACP method name.
   * @param params - ACP method parameters.
   * @param timeoutMs - call budget.
   * @returns the agent's result for this call.
   */
  call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.#closed) return Promise.reject(new AcpAgentError('agent-closed', 'the agent process is already closed'))
    const id = this.nextId++
    const request: AcpRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AcpAgentError('agent-timeout', `the agent did not answer ${method} within the budget`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (value) => { resolve(value as T) },
        reject: (error) => { reject(error) },
        timer,
      })
      this.child.stdin.write(`${JSON.stringify(request)}\n`)
    })
  }

  /**
   * Fire-and-forget notification (session/cancel).
   * @param method - ACP notification method name.
   * @param params - ACP notification parameters.
   */
  notify(method: string, params: unknown): void {
    if (this.#closed) return
    const notification: AcpNotification = { jsonrpc: '2.0', method, params }
    this.child.stdin.write(`${JSON.stringify(notification)}\n`)
  }

  /**
   * One raw stdin line for an adapter maintenance mode (`--reconcile-dispatch`),
   * written verbatim ahead of any JSON-RPC frames that mode would not read.
   * @param line - complete JSON text without the trailing newline.
   */
  writeRawLine(line: string): void {
    if (this.#closed) return
    this.child.stdin.write(`${line}\n`)
  }

  /** Whether the process is still alive. */
  get alive(): boolean {
    return !this.#closed && this.child.exitCode === null && this.child.signalCode === null
  }

  /**
   * Resolves with the exit code (or null for a spawn failure) once the process is gone.
   * @returns the process exit outcome.
   */
  waitExited(): Promise<number | null> {
    return this.exited
  }

  /** End stdin, then escalate to kill; resolves when the process is gone. */
  close(): Promise<void> {
    if (this.#closed) return this.exited.then(() => undefined)
    this.#closed = true
    this.failPending(new AcpAgentError('agent-closed', 'the agent process was closed by the workbench'))
    try {
      this.child.stdin.end()
    } catch {
      /* stdin may already be destroyed */
    }
    const force = setTimeout(() => { this.child.kill('SIGKILL') }, 4000)
    force.unref?.()
    return this.exited.then(() => undefined).finally(() => { clearTimeout(force) })
  }

  /** Terminate without the graceful stdin close (timeouts, dead links). */
  kill(): Promise<void> {
    if (!this.#closed && this.child.exitCode === null) this.child.kill('SIGTERM')
    return this.close()
  }
}

/** Typed dispatch-layer failure. */
export class AcpAgentError extends Error {
  constructor(
    /** Stable machine kind, e.g. `agent-timeout`. */
    readonly kind: string,
    /** Fixed-string human detail; scrubbed and bounded. */
    message: string,
  ) {
    super(message)
  }
}

/** Events surfaced by one dispatch run, in occurrence order. */
export type DispatchEvent =
  | { kind: 'acknowledged' }
  | { kind: 'running' }
  | { kind: 'transcript'; messageId: string; text: string }
  | { kind: 'tool'; toolCallId: string; title: string; status: string }
  | { kind: 'awaiting_input'; value: boolean }
  | { kind: 'completed' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string; echoLost: boolean }

/** Extract the `workspace` select option from session/new configOptions. */
function workspaceOptionOf(configOptions: unknown): { options: { value: string; name: string }[] } | undefined {
  if (!Array.isArray(configOptions)) return undefined
  for (const option of configOptions) {
    if (typeof option !== 'object' || option === null) continue
    const entry = option as { id?: unknown; options?: unknown }
    if (entry.id !== 'workspace' || !Array.isArray(entry.options)) continue
    const values: { value: string; name: string }[] = []
    for (const choice of entry.options) {
      if (typeof choice !== 'object' || choice === null) continue
      const item = choice as { value?: unknown; name?: unknown }
      if (typeof item.value === 'string') values.push({ value: item.value, name: typeof item.name === 'string' ? item.name : item.value })
    }
    return { options: values }
  }
  return undefined
}

/**
 * Actionable detail when the adapter completed session/new without a
 * per-session workspace option: a fixed-workspace adapter saved as a
 * per-session node (or an adapter too old to offer the option). Its `--health`
 * can still answer online, which is exactly why this must be named instead of
 * surfacing as an empty list. The marker substring is mapped to a localized
 * hint on the client.
 */
export const NO_WORKSPACE_OPTION_DETAIL = `the node's adapter ${NO_WORKSPACE_OPTION_MARKER} — it looks like a fixed-workspace adapter (or an adapter too old for per-session selection); save the node as fixed, or enable per-session workspace selection in the adapter configuration`

/** The session-mode capability failure: no dispatchable workspace exists. */
function noWorkspaceOptionError(): AcpAgentError {
  return new AcpAgentError('agent-no-workspace-option', NO_WORKSPACE_OPTION_DETAIL)
}

/**
 * Whether a post-prompt failure leaves the desktop outcome unknown (echo
 * lost) rather than a confirmed execution failure.
 */
function echoLostFailure(error: AcpAgentError): boolean {
  if (error.kind === 'agent-exited' || error.kind === 'agent-timeout' || error.kind === 'agent-closed') return true
  if (error.kind === `agent-code-${String(ERR_LINK)}`) return true
  return error.kind === `agent-code-${String(ERR_TURN)}` && error.message.includes('outcome is unknown')
}

/**
 * One full dispatch run against a node: session creation, per-session
 * workspace pin, first prompt, and the streamed turn. Every state movement is
 * reported through `onEvent`; the returned promise settles when the turn does.
 *
 * With `adopt` set, no session is created and no workspace option is set:
 * the adapter's `session/adopt` first verifies the named desktop task
 * (workspace ownership, completed, no pending interaction) and returns the
 * binding that owns it, and the prompt then continues that same desktop task.
 * @param options - dispatch inputs; `onAgent` receives the live process for
 *   cancellation before the turn settles.
 */
export async function runDispatch(options: {
  node: ZcodeNodeRecord
  workspacePath: string
  prompt: string
  timeoutMs: number
  onEvent: (event: DispatchEvent) => void
  onAgent?: (agent: AcpAgentProcess, acpSessionId: string) => void
  /** Original desktop task id to continue instead of creating a session. */
  adopt?: string
}): Promise<void> {
  const { node, workspacePath, prompt, timeoutMs, onEvent, onAgent, adopt } = options
  const mergeBuffer = new Map<string, string>()
  let runningSeen = false
  let awaitingInput = false
  const agent = new AcpAgentProcess(node.command, node.args, (update) => {
    const sessionUpdate = update.sessionUpdate ?? ''
    if (sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string' && update.content.text.length > 0) {
      if (!runningSeen) { runningSeen = true; onEvent({ kind: 'running' }) }
      const key = update.messageId ?? ''
      const merged = (mergeBuffer.get(key) ?? '') + update.content.text
      mergeBuffer.set(key, merged)
      onEvent({ kind: 'transcript', messageId: key, text: scrubText(merged) })
      return
    }
    if ((sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
      && typeof update.toolCallId === 'string' && update.toolCallId.length > 0) {
      if (update.toolCallId === 'zdesktop-approval') {
        const value = update.status !== 'completed'
        if (value !== awaitingInput) {
          awaitingInput = value
          onEvent({ kind: 'awaiting_input', value })
        }
        return
      }
      if (!runningSeen) { runningSeen = true; onEvent({ kind: 'running' }) }
      onEvent({
        kind: 'tool',
        toolCallId: update.toolCallId,
        title: scrubText(typeof update.title === 'string' && update.title.length > 0 ? update.title : 'tool').slice(0, 200),
        status: typeof update.status === 'string' ? update.status : 'pending',
      })
    }
  })
  try {
    await agent.call<{ protocolVersion?: number }>('initialize', { protocolVersion: 1 }, timeoutMs)
    let acpSessionId: string
    if (adopt !== undefined) {
      // Continuation: the adapter verifies the desktop task and hands back the
      // binding that owns it — new or reused. A failure here leaves nothing
      // sent, which keeps the record retryable.
      const adopted = await agent.call<{ sessionId?: unknown }>('session/adopt', {
        taskId: adopt,
        ...(workspacePath.length > 0 ? { workspacePath } : {}),
      }, timeoutMs)
      if (typeof adopted.sessionId !== 'string' || adopted.sessionId.length === 0) {
        throw new AcpAgentError('agent-protocol', 'session/adopt returned no session id')
      }
      acpSessionId = adopted.sessionId
      onAgent?.(agent, acpSessionId)
    } else {
      const created = await agent.call<{ sessionId?: unknown; configOptions?: unknown }>('session/new', {}, timeoutMs)
      if (typeof created.sessionId !== 'string' || created.sessionId.length === 0) {
        throw new AcpAgentError('agent-protocol', 'session/new returned no session id')
      }
      acpSessionId = created.sessionId
      onAgent?.(agent, acpSessionId)
      if (node.workspaceSelection === 'session') {
        if (workspacePath.length === 0) {
          throw new AcpAgentError('route-missing', 'this node selects its workspace per session; pick one before dispatch')
        }
        // Route-time capability check: a session node whose adapter answers
        // session/new without a workspace option (fixed adapter misconfigured as
        // session, or drift after the node was saved) has nothing dispatchable —
        // fail with the actionable reason instead of a cryptic set_config_option
        // rejection. Health being online never proved this path works.
        const workspace = workspaceOptionOf(created.configOptions)
        if (workspace === undefined || workspace.options.length === 0) {
          throw noWorkspaceOptionError()
        }
        await agent.call('session/set_config_option', { sessionId: acpSessionId, configId: 'workspace', value: workspacePath }, timeoutMs)
      }
    }
    // "acknowledged" marks the moment the prompt envelope is about to be written
    // to the adapter — it is submission, not remote confirmation. Delivery is
    // only proven once the adapter streams the desktop's frames ('running') or
    // the turn settles; the workbench UI words this stage accordingly.
    onEvent({ kind: 'acknowledged' })
    let result: { stopReason?: unknown }
    try {
      result = await agent.call<{ stopReason?: unknown }>('session/prompt', {
        sessionId: acpSessionId,
        prompt: [{ type: 'text', text: prompt }],
      }, Math.max(timeoutMs, 1000))
    } catch (error) {
      if (error instanceof AcpAgentError) {
        const echoLost = echoLostFailure(error)
        onEvent({ kind: 'failed', error: echoLost ? `${error.message}; the desktop outcome is unknown — verify the task in the Zcode desktop` : error.message, echoLost })
        return
      }
      throw error
    }
    const stopReason = typeof result.stopReason === 'string' ? result.stopReason : ''
    if (stopReason === 'cancelled') onEvent({ kind: 'cancelled' })
    else if (stopReason === 'end_turn') onEvent({ kind: 'completed' })
    else onEvent({ kind: 'failed', error: `the agent ended the turn with stop reason ${stopReason || 'unknown'}`, echoLost: false })
  } catch (error) {
    if (error instanceof AcpAgentError) {
      const detail = error.kind === 'agent-start-failed' && agent.stderrDetail().length > 0
        ? `${error.message} (${agent.stderrDetail()})`
        : error.message
      onEvent({ kind: 'failed', error: detail, echoLost: false })
      return
    }
    onEvent({ kind: 'failed', error: 'the dispatch failed with an internal error', echoLost: false })
  } finally {
    await agent.close()
  }
}

/**
 * Read-only health probe: run the adapter's `--health` mode and parse its
 * fixed-string summary line.
 * @param node - target node launcher.
 * @param timeoutMs - probe budget.
 * @returns online/offline plus desktop version and workspace count when known.
 */
export async function probeHealth(node: ZcodeNodeRecord, timeoutMs: number): Promise<{
  online: boolean
  desktopVersion: string | null
  workspaceCount: number | null
  detail: string
}> {
  let stdout = ''
  const agent = new AcpAgentProcess(node.command, [...node.args, '--health'], () => {}, (line) => { stdout += `${line}\n` })
  const timer = setTimeout(() => { void agent.kill() }, timeoutMs)
  timer.unref?.()
  try {
    await agent.waitExited()
  } finally {
    clearTimeout(timer)
    await agent.close().catch(() => undefined)
  }
  const line = stdout.split('\n').map(part => part.trim()).find(part => part.includes('health:')) ?? stdout.trim()
  const scrubbed = line.replace(/(?:https?|wss?):\/\/\S+/g, '[url]').slice(0, 300)
  const online = /health:.*\bonline\b/.test(scrubbed)
  const version = /desktop ([^,]+)/.exec(scrubbed)?.[1] ?? null
  const countText = /(\d+) registered workspace/.exec(scrubbed)?.[1]
  return {
    online,
    desktopVersion: version,
    workspaceCount: countText === undefined ? null : Number(countText),
    detail: scrubbed.length > 0 ? scrubbed : 'the node reported no health line',
  }
}

/**
 * Read one node's live workspace options through `session/new` discovery.
 * `fixed` nodes answer one opaque option: their pin lives in private adapter
 * configuration the workbench never reads. A `session` node whose adapter
 * completes session/new without a workspace option fails with the actionable
 * fixed-adapter detail — this is also the save-time capability probe.
 * @param node - target node launcher.
 * @param timeoutMs - discovery budget.
 * @returns the node's workspace options plus the desktop version it reported.
 */
export async function listWorkspaceOptions(node: ZcodeNodeRecord, timeoutMs: number): Promise<{
  options: ZcodeWorkspaceOption[]
  desktopVersion: string | null
}> {
  if (node.workspaceSelection === 'fixed') {
    return { options: [{ path: '__fixed__', label: `${node.label} · pinned in node configuration` }], desktopVersion: null }
  }
  const agent = new AcpAgentProcess(node.command, node.args, () => {})
  try {
    await agent.call('initialize', { protocolVersion: 1 }, timeoutMs)
    const created = await agent.call<{ configOptions?: unknown }>('session/new', {}, timeoutMs)
    const workspace = workspaceOptionOf(created.configOptions)
    if (workspace === undefined || workspace.options.length === 0) {
      throw noWorkspaceOptionError()
    }
    const description = Array.isArray(created.configOptions)
      ? String((created.configOptions as { description?: unknown }[]).find(option => typeof option === 'object' && option !== null && (option as { id?: unknown }).id === 'workspace')?.description ?? '')
      : ''
    return {
      options: workspace.options.map(choice => ({ path: choice.value, label: choice.name })),
      desktopVersion: /desktop ([^,]+)/.exec(description)?.[1] ?? null,
    }
  } finally {
    await agent.close()
  }
}

/** One desktop task row as the adapter's `--list-tasks` line reports it. */
export interface DesktopTaskWireRow {
  taskId: string
  title: string
  status: 'running' | 'completed' | 'error' | 'unknown'
  createdAt: string
  updatedAt: string
  origin: 'workbench' | 'desktop'
  /** Present when the adapter's own binding owns this desktop task. */
  dshSessionId?: string
}

/** Marker prefix of the adapter's one-line `--list-tasks` report. */
const TASKS_LINE_MARKER = '] tasks: '

/** Rows one desktop listing reports; bounded like the adapter caps them. */
export interface DesktopTasksReport {
  desktopVersion: string | null
  tasks: DesktopTaskWireRow[]
}

/**
 * Read the Zcode desktop's own synced task index for one workspace through the
 * adapter's read-only `--list-tasks` mode: one short-lived adapter process,
 * no session, no dispatch. The adapter output is a process boundary — every
 * row is validated and unusable rows are dropped, never guessed.
 * @param node - target node launcher.
 * @param workspacePath - selected workspace; empty for `fixed` nodes (the
 *   adapter resolves its pinned workspace from private configuration).
 * @param timeoutMs - listing budget.
 * @returns validated desktop task rows plus the desktop version.
 * @throws AcpAgentError with a fixed-string reason when the listing fails.
 */
export async function listDesktopTasks(node: ZcodeNodeRecord, workspacePath: string, timeoutMs: number): Promise<DesktopTasksReport> {
  const args = workspacePath.length > 0 ? [...node.args, '--list-tasks', workspacePath] : [...node.args, '--list-tasks']
  let stdout = ''
  const agent = new AcpAgentProcess(node.command, args, () => {}, (line) => { stdout += `${line}\n` })
  const timer = setTimeout(() => { void agent.kill() }, timeoutMs)
  timer.unref?.()
  try {
    await agent.waitExited()
  } finally {
    clearTimeout(timer)
    await agent.close().catch(() => undefined)
  }
  const line = stdout.split('\n').map(part => part.trim()).find(part => part.includes(TASKS_LINE_MARKER))
  if (line === undefined) {
    const detail = agent.stderrDetail().length > 0 ? ` (${agent.stderrDetail()})` : ''
    throw new AcpAgentError('agent-tasks-read', `the node did not report a desktop task listing${detail}`)
  }
  const parsed: unknown = JSON.parse(line.slice(line.indexOf(TASKS_LINE_MARKER) + TASKS_LINE_MARKER.length))
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    throw new AcpAgentError('agent-tasks-read', 'the node reported a malformed desktop task listing')
  }
  const report = parsed as { tasks: unknown[]; desktopVersion?: unknown }
  const tasks: DesktopTaskWireRow[] = []
  for (const entry of report.tasks) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Partial<DesktopTaskWireRow>
    if (typeof row.taskId !== 'string' || row.taskId.length === 0) continue
    tasks.push({
      taskId: row.taskId,
      title: typeof row.title === 'string' ? row.title : '',
      status: row.status === 'running' || row.status === 'completed' || row.status === 'error' ? row.status : 'unknown',
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
      origin: row.origin === 'workbench' ? 'workbench' : 'desktop',
      ...(typeof row.dshSessionId === 'string' && row.dshSessionId.length > 0 ? { dshSessionId: row.dshSessionId } : {}),
    })
  }
  return {
    desktopVersion: typeof report.desktopVersion === 'string' ? report.desktopVersion : null,
    tasks,
  }
}

/** Marker prefix of the adapter's one-line `--reconcile-dispatch` report. */
const RECONCILE_LINE_MARKER = '] reconcile: '

/** One `--reconcile-dispatch` verdict as the adapter reports it (validated row). */
export interface ReconcileDispatchReport {
  taskId: string
  dshSessionId: string | null
  commandId: string | null
  commandKind: string | null
  issuedAt: number | null
  taskStatus: string | null
  taskUpdatedAt: string | null
  taskUpdatedAfterIssued: boolean | null
  phase: string | null
  pendingInteractions: number | null
  userTurnCount: number | null
  promptMatched: boolean | null
  expectedPromptProvided: boolean
  writtenOff: boolean
  alreadyReconciled: boolean
  reconciledAt: string
  /** Machine-stable refusal code; null when the pass reported usable evidence. */
  reason: string | null
}

/** Inputs of one reconcile pass against a node's adapter. */
export interface ReconcileFollowupOptions {
  desktopTaskId: string
  /** Selected workspace; empty for `fixed` nodes. */
  workspacePath: string
  /**
   * The echo-lost round's prompt text. It crosses to the adapter over stdin
   * for the snapshot comparison and is never persisted by either side.
   */
  expectedPromptText: string
  /** Whether to run the confirm pass (write-off) instead of the read-only pass. */
  confirmHumanVerified: boolean
  /** Operator label recorded in the site ledger; used only by the confirm pass. */
  operator: string
  timeoutMs: number
}

/** Reads one optional string field of a raw report row. */
function optionalString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

/** Reads one optional numeric field of a raw report row. */
function optionalNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Reads one optional boolean field of a raw report row. */
function optionalBoolean(row: Record<string, unknown>, key: string): boolean | null {
  const value = row[key]
  return typeof value === 'boolean' ? value : null
}

/**
 * Runs one `--reconcile-dispatch` pass against a node's adapter: the read-only
 * evidence gathering by default, or the human-attested write-off with
 * `confirmHumanVerified`. The pass never sends a prompt and never creates a
 * session; the expected prompt text rides stdin so it never appears in argv.
 * @param node - target node launcher.
 * @param options - desktop task, workspace, expected text, mode, and budget.
 * @returns the validated report row.
 * @throws AcpAgentError with a fixed-string reason when the adapter reports no
 *   verdict line (unreadable, misconfigured, or timed out).
 */
export async function reconcileFollowupDispatch(
  node: ZcodeNodeRecord,
  options: ReconcileFollowupOptions,
): Promise<ReconcileDispatchReport> {
  const args = [
    ...node.args,
    '--reconcile-dispatch',
    options.desktopTaskId,
    ...(options.workspacePath.length > 0 ? [options.workspacePath] : []),
    ...(options.confirmHumanVerified
      ? ['--confirm', 'human-verified', '--operator', options.operator]
      : []),
  ]
  let stdout = ''
  const agent = new AcpAgentProcess(node.command, args, () => {}, (line) => { stdout += `${line}\n` })
  agent.writeRawLine(JSON.stringify({ expectedPromptText: options.expectedPromptText }))
  const timer = setTimeout(() => { void agent.kill() }, options.timeoutMs)
  timer.unref()
  try {
    await agent.waitExited()
  } finally {
    clearTimeout(timer)
    await agent.close().catch(() => undefined)
  }
  const line = stdout.split('\n').map(part => part.trim()).find(part => part.includes(RECONCILE_LINE_MARKER))
  if (line === undefined) {
    const detail = agent.stderrDetail().length > 0 ? ` (${agent.stderrDetail()})` : ''
    throw new AcpAgentError('agent-reconcile-read', `the node did not report a reconcile verdict${detail}`)
  }
  const parsed: unknown = JSON.parse(line.slice(line.indexOf(RECONCILE_LINE_MARKER) + RECONCILE_LINE_MARKER.length))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AcpAgentError('agent-reconcile-read', 'the node reported a malformed reconcile verdict')
  }
  const row = parsed as Record<string, unknown>
  const taskId = optionalString(row, 'taskId')
  const reconciledAt = optionalString(row, 'reconciledAt')
  if (taskId === null || taskId !== options.desktopTaskId || reconciledAt === null) {
    throw new AcpAgentError('agent-reconcile-read', 'the node reported a reconcile verdict for another task')
  }
  return {
    taskId,
    dshSessionId: optionalString(row, 'dshSessionId'),
    commandId: optionalString(row, 'commandId'),
    commandKind: optionalString(row, 'commandKind'),
    issuedAt: optionalNumber(row, 'issuedAt'),
    taskStatus: optionalString(row, 'taskStatus'),
    taskUpdatedAt: optionalString(row, 'taskUpdatedAt'),
    taskUpdatedAfterIssued: optionalBoolean(row, 'taskUpdatedAfterIssued'),
    phase: optionalString(row, 'phase'),
    pendingInteractions: optionalNumber(row, 'pendingInteractions'),
    userTurnCount: optionalNumber(row, 'userTurnCount'),
    promptMatched: optionalBoolean(row, 'promptMatched'),
    expectedPromptProvided: row.expectedPromptProvided === true,
    writtenOff: row.writtenOff === true,
    alreadyReconciled: row.alreadyReconciled === true,
    reconciledAt,
    reason: optionalString(row, 'reason'),
  }
}
