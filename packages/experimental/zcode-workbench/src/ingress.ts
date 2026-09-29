/**
 * Local Codex ingress: one exact route on the Host web server. Creation is
 * idempotent by source identity and returns the shared `workbenchTaskId`;
 * status reads mark terminal tasks reported. Authentication is a bearer token
 * read from an operator-owned token file (rotation-friendly, never persisted
 * by the workbench) and the authority must be loopback. Bodies are bounded
 * and validated; failures are fixed-string.
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { timingSafeEqual } from 'node:crypto'
import type { TaskStore } from './store.ts'
import { isTerminal, projectTaskView, resultPreviewOf } from './state.ts'
import type { IngressCreateTaskRequest, IngressTaskStatusResponse } from './types.ts'

/** Inbound body budget. */
const MAX_BODY_BYTES = 64 * 1024

/** Ingress prompt bound. */
const PROMPT_MAX_CHARS = 20_000

/** Field bounds for origin identity. */
const SOURCE_TASK_ID_MAX = 128

function timingSafeMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(actualBytes, expectedBytes)
}

/** Loopback authorities the ingress accepts (the web server may bind more). */
function isLoopbackAuthority(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false
  const host = hostHeader.split(':')[0]?.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/** Read the ingress token; absent or empty file means not provisioned. */
async function readToken(tokenFile: string): Promise<string | null> {
  let raw: string
  try {
    raw = await readFile(tokenFile, 'utf8')
  } catch {
    return null
  }
  const token = raw.trim()
  return token.length >= 16 ? token : null
}

/** Parse and bound one creation request; throws a message naming the violation. */
function parseCreateRequest(body: unknown): IngressCreateTaskRequest {
  if (typeof body !== 'object' || body === null) throw new Error('body must be a JSON object')
  const raw = body as Record<string, unknown>
  if (raw.source !== 'codex') throw new Error('source must be "codex"')
  if (typeof raw.sourceTaskId !== 'string' || raw.sourceTaskId.length === 0 || raw.sourceTaskId.length > SOURCE_TASK_ID_MAX) {
    throw new Error(`sourceTaskId must be 1..${SOURCE_TASK_ID_MAX} characters`)
  }
  const threadId = raw.threadId ?? null
  if (threadId !== null && (typeof threadId !== 'string' || threadId.length > SOURCE_TASK_ID_MAX)) {
    throw new Error(`threadId must be at most ${SOURCE_TASK_ID_MAX} characters`)
  }
  const title = raw.title ?? null
  if (title !== null && (typeof title !== 'string' || title.length > 200)) throw new Error('title must be at most 200 characters')
  if (typeof raw.prompt !== 'string' || raw.prompt.length === 0 || raw.prompt.length > PROMPT_MAX_CHARS) {
    throw new Error(`prompt must be 1..${PROMPT_MAX_CHARS} characters`)
  }
  return { source: 'codex', sourceTaskId: raw.sourceTaskId, threadId, title, prompt: raw.prompt }
}

/** Read the whole request body with a byte cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.byteLength
      if (received > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', () => { reject(new Error('request body could not be read')) })
  })
}

/**
 * Register the ingress route on one web server.
 * @param route - ingress path prefix, e.g. `/zcode-workbench/ingress`.
 * @param tokenFile - operator-owned bearer token file path.
 * @param store - task store used for idempotent creation and status reads.
 * @returns the prefix WebRoute ready for `webServer.register`.
 */
export function createIngressRoute(route: string, tokenFile: string, store: TaskStore): WebRoute {
  const tasksPath = `${route}/tasks`
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const createPath = url.pathname === route || url.pathname === `${route}/`
      || url.pathname === tasksPath || url.pathname === `${tasksPath}/`
    const taskPath = url.pathname.startsWith(`${tasksPath}/`) && url.pathname.length > `${tasksPath}/`.length + 1
    if (!createPath && !taskPath) {
      sendJson(res, 404, { error: 'not-found' })
      return
    }
    if (!isLoopbackAuthority(req.headers.host)) {
      sendJson(res, 403, { error: 'forbidden-authority' })
      return
    }
    const token = await readToken(tokenFile)
    if (token === null) {
      sendJson(res, 503, { error: 'ingress-token-not-provisioned' })
      return
    }
    const authorization = req.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')
      || !timingSafeMatch(authorization.slice('Bearer '.length), token)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    if (req.method === 'POST' && (url.pathname === route || url.pathname === `${route}/tasks`)) {
      let parsed: unknown
      try {
        parsed = JSON.parse((await readBody(req)).toString('utf8'))
      } catch (error) {
        sendJson(res, 400, { error: 'invalid-json', detail: error instanceof Error ? error.message : 'unreadable body' })
        return
      }
      let request: IngressCreateTaskRequest
      try {
        request = parseCreateRequest(parsed)
      } catch (error) {
        sendJson(res, 400, { error: 'invalid-request', detail: error instanceof Error ? error.message : 'invalid body' })
        return
      }
      const { record, created } = await store.create({
        source: 'codex',
        sourceTaskId: request.sourceTaskId,
        threadId: request.threadId,
        title: request.title ?? request.prompt.slice(0, 60),
        prompt: request.prompt,
        now: new Date(),
      })
      if (created) await store.transition(record.workbenchTaskId, 'awaiting_route')
      const current = store.get(record.workbenchTaskId)
      sendJson(res, created ? 201 : 200, {
        workbenchTaskId: record.workbenchTaskId,
        created,
        status: (current ?? record).status,
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith(`${tasksPath}/`)) {
      let workbenchTaskId: string
      try {
        workbenchTaskId = decodeURIComponent(url.pathname.slice(`${tasksPath}/`.length))
      } catch {
        sendJson(res, 400, { error: 'invalid-task-id' })
        return
      }
      let record = store.get(workbenchTaskId)
      if (record === undefined) {
        sendJson(res, 404, { error: 'task-not-found' })
        return
      }
      let reported = record.status === 'reported'
      if (!reported && isTerminal(record.status)) {
        await store.transition(workbenchTaskId, 'reported')
        reported = true
        record = store.get(workbenchTaskId) ?? record
      }
      const view = projectTaskView(record)
      const response: IngressTaskStatusResponse = {
        workbenchTaskId: view.workbenchTaskId,
        source: view.source,
        status: view.status,
        terminalOutcome: view.terminalOutcome,
        zcodeDelivery: view.zcodeDelivery,
        awaitingInput: view.awaitingInput,
        echoLost: view.echoLost,
        lastError: view.lastError,
        nodeId: view.nodeId,
        workspacePath: view.workspacePath,
        resultPreview: isTerminal(record.status) || record.status === 'reported' ? resultPreviewOf(record) : null,
        reported,
      }
      sendJson(res, 200, response)
      return
    }
    sendJson(res, 405, { error: 'method-not-allowed' })
  }
  return { kind: 'prefix', path: route, handler }
}
