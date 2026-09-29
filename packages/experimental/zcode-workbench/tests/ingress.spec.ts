import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ZcodeWorkbench from '../src/index.ts'

const ROUTE = '/zcode-workbench/ingress'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Boot Typert + the REAL Host web server + the plugin, and return the origin base. */
async function boot(): Promise<{ ctx: Context; base: () => string; tokenFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-ingress-'))
  directories.push(dir)
  const tokenFile = join(dir, 'ingress-token')
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const fork = ctx.plugin(ZcodeWorkbench, {
    stateDir: dir,
    ingressPath: ROUTE,
    ingressTokenFile: tokenFile,
    maxTasks: 50,
    dispatchTimeoutMs: 15_000,
    healthTimeoutMs: 5_000,
  })
  await fork
  await expect(ctx.zcodeWorkbench.tasks()).resolves.toBeInstanceOf(Array)
  return { ctx, base: () => `http://127.0.0.1:${ctx.webServer.port}`, tokenFile }
}

const TOKEN = 'ingress-fixture-token-0123456789abcdef'

const CREATE_BODY = {
  source: 'codex',
  sourceTaskId: 'codex-task-1',
  threadId: 'thread-1',
  title: 'Codex task',
  prompt: 'check the fixture and report',
}

describe('codex ingress (REAL web server route)', () => {
  it('refuses unprovisioned, unauthenticated, and non-loopback callers before any task exists', async () => {
    const { ctx, base, tokenFile } = await boot()
    try {
      const notProvisioned = await fetch(`${base()}${ROUTE}/tasks`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(CREATE_BODY),
      })
      expect(notProvisioned.status).toBe(503)

      await writeFile(tokenFile, `${TOKEN}\n`, 'utf8')
      const noToken = await fetch(`${base()}${ROUTE}/tasks`, { method: 'POST', body: JSON.stringify(CREATE_BODY) })
      expect(noToken.status).toBe(401)
      const wrongToken = await fetch(`${base()}${ROUTE}/tasks`, {
        method: 'POST', headers: { authorization: 'Bearer ingress-fixture-token-0123456789abcdeX' },
        body: JSON.stringify(CREATE_BODY),
      })
      expect(wrongToken.status).toBe(401)
      // A forged Host header needs a raw request: fetch refuses to override it.
      const foreignAuthority = await new Promise<{ status: number }>((resolve, reject) => {
        const probe = httpRequest(new URL(base()), {
          method: 'POST',
          path: `${ROUTE}/tasks`,
          headers: { authorization: `Bearer ${TOKEN}`, host: 'example.invalid:443' },
        }, (response) => { response.resume(); resolve({ status: response.statusCode ?? 0 }) })
        probe.on('error', reject)
        probe.end(JSON.stringify(CREATE_BODY))
      })
      expect(foreignAuthority.status).toBe(403)
      expect((await ctx.zcodeWorkbench.tasks())).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('creates idempotently, validates bodies, and reports status back', async () => {
    const { ctx, base, tokenFile } = await boot()
    try {
      await writeFile(tokenFile, TOKEN, 'utf8')
      const invalid = await fetch(`${base()}${ROUTE}/tasks`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ source: 'codex', sourceTaskId: '', prompt: 'x' }),
      })
      expect(invalid.status).toBe(400)

      const created = await fetch(`${base()}${ROUTE}/tasks`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(CREATE_BODY),
      })
      expect(created.status).toBe(201)
      const createdBody = await created.json() as { workbenchTaskId: string; created: boolean; status: string }
      expect(createdBody.created).toBe(true)
      expect(createdBody.workbenchTaskId).toMatch(/^WB-\d{8}-\d{3}$/)
      expect(createdBody.status).toBe('awaiting_route')

      const repeated = await fetch(`${base()}${ROUTE}/tasks`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ ...CREATE_BODY, prompt: 'a completely different body' }),
      })
      expect(repeated.status).toBe(200)
      const repeatedBody = await repeated.json() as { workbenchTaskId: string; created: boolean }
      expect(repeatedBody.created).toBe(false)
      expect(repeatedBody.workbenchTaskId).toBe(createdBody.workbenchTaskId)
      expect((await ctx.zcodeWorkbench.tasks())).toHaveLength(1)

      const status = await fetch(`${base()}${ROUTE}/tasks/${createdBody.workbenchTaskId}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(status.status).toBe(200)
      const statusBody = await status.json() as { workbenchTaskId: string; source: string; reported: boolean }
      expect(statusBody.source).toBe('codex')
      expect(statusBody.reported).toBe(false)

      const unknown = await fetch(`${base()}${ROUTE}/tasks/WB-19990101-999`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(unknown.status).toBe(404)
      const wrongMethod = await fetch(`${base()}${ROUTE}`, {
        method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}',
      })
      expect(wrongMethod.status).toBe(405)

      // No response ever echoes the token.
      const everything = JSON.stringify({ createdBody, repeatedBody, statusBody })
      expect(everything).not.toContain(TOKEN)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
