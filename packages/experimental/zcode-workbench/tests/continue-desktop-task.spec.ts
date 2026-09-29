import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ZcodeWorkbench from '../src/index.ts'
import type { WorkbenchNodeInput, WorkbenchTaskView } from '../src/types.ts'

const fixtureAgent = join(import.meta.dirname, 'fixtures', 'fake-acp-agent.mjs')

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One fixture agent config file plus the journal its methods append to. */
async function fixtureSite(scenario: string): Promise<{ ctx: Context; adapterConfig: string; journalFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-continue-'))
  directories.push(dir)
  const adapterConfig = join(dir, 'adapter.json')
  const journalFile = join(dir, 'agent-calls.jsonl')
  await writeFile(adapterConfig, `${JSON.stringify({ scenario, journal: journalFile }, null, 2)}\n`, 'utf8')
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const fork = ctx.plugin(ZcodeWorkbench, {
    stateDir: dir,
    ingressPath: '/zcode-workbench/ingress',
    ingressTokenFile: join(dir, 'ingress-token'),
    maxTasks: 50,
    dispatchTimeoutMs: 20_000,
    healthTimeoutMs: 20_000,
  })
  await fork
  return { ctx, adapterConfig, journalFile }
}

/** A session-mode node submission pointing at one adapter config. */
function nodeInput(id: string, adapterConfig: string): WorkbenchNodeInput {
  return {
    id,
    kind: 'remote',
    label: `Fixture ${id}`,
    siteLabel: 'test',
    command: process.execPath,
    args: [fixtureAgent, '--config', adapterConfig],
    workspaceSelection: 'session',
  }
}

/** Sample the task status until `done` holds. */
async function observe(ctx: Context, workbenchTaskId: string, done: (view: WorkbenchTaskView) => boolean): Promise<WorkbenchTaskView> {
  for (;;) {
    const detail = await ctx.zcodeWorkbench.task(workbenchTaskId)
    expect(detail).toBeDefined()
    if (done(detail!)) return detail!
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
}

/** Method names the fixture agent journaled, in call order. */
async function journalMethods(journalFile: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(journalFile, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as { method: string }).map(entry => entry.method)
}

describe('continue desktop task (REAL composition over the fixture agent)', () => {
  it('continues a desktop-origin task through adoption: same binding reused, no session/new, no second desktop task', async () => {
    const { ctx, adapterConfig, journalFile } = await fixtureSite('happy')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const continued = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'one more pass over the report',
      })
      expect(continued.desktopTaskId).toBe('dtask-legacy-1')
      const settled = await observe(ctx, continued.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      // This round rides the adopted binding; the desktop side stays the one task.
      expect(settled.acpSessionId).toBe('fake-acp-session-adopted-1')
      expect(['completed', 'reported']).toContain(settled.status)

      const methods = await journalMethods(journalFile)
      // The session-node capability probe at saveNode ran initialize +
      // session/new exactly once; the continuation dispatch itself contributed
      // only session/adopt and session/prompt. A dispatch-side session/new (the
      // new-task path) would make this count 2, and the per-session workspace
      // pin never ran.
      expect(methods.filter(method => method === 'session/new')).toHaveLength(1)
      expect(methods.filter(method => method === 'session/set_config_option')).toEqual([])
      expect(methods.filter(method => method === 'session/adopt')).toEqual(['session/adopt'])

      // The workspace listing joins the desktop row to this continuation round.
      const listing = await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/lab')
      expect(listing.desktop.state).toBe('ok')
      if (listing.desktop.state === 'ok') {
        expect(listing.desktop.tasks.map(task => task.taskId)).toEqual(['dtask-legacy-1'])
        expect(listing.desktop.tasks[0]!.workbenchTaskId).toBe(continued.workbenchTaskId)
      }
      expect(listing.workbench.map(task => task.workbenchTaskId)).toEqual([continued.workbenchTaskId])
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('continues a workbench-dispatched task on the same adapter session id instead of a second binding', async () => {
    const { ctx, adapterConfig, journalFile } = await fixtureSite('happy')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'original round', prompt: 'p', nodeId: node.id, workspacePath: '/site/default',
      })
      const original = await observe(ctx, created.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      expect(original.acpSessionId).toBe('fake-acp-session-1')

      const continued = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/default', desktopTaskId: 'dtask-wb-1', title: 'follow-up round', prompt: 'and then verify it',
      })
      const settled = await observe(ctx, continued.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      // The existing binding is reused: the follow-up round shares the adapter
      // session id of the round that created the desktop task.
      expect(settled.acpSessionId).toBe('fake-acp-session-1')
      expect(settled.desktopTaskId).toBe('dtask-wb-1')
      const methods = await journalMethods(journalFile)
      expect(methods.filter(method => method === 'session/adopt')).toEqual(['session/adopt'])
      // Exactly the two dispatches plus the save probe: no third session.
      expect(methods.filter(method => method === 'session/new')).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('continues through a fixed node with no workspace argument and zero session/new', async () => {
    const { ctx, adapterConfig, journalFile } = await fixtureSite('happy')
    try {
      // A fixed node runs no capability probe, so every journaled call comes
      // from the continuation dispatch alone.
      const node = await ctx.zcodeWorkbench.saveNode({ ...nodeInput('fixture-fixed', adapterConfig), workspaceSelection: 'fixed' })
      const continued = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '__fixed__', desktopTaskId: 'dtask-wb-1', title: '', prompt: 'continue on the pinned workspace',
      })
      const settled = await observe(ctx, continued.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      expect(settled.acpSessionId).toBe('fake-acp-session-1')
      expect(settled.desktopTaskId).toBe('dtask-wb-1')
      expect(settled.workspacePath).toBeNull()
      const methods = await journalMethods(journalFile)
      expect(methods).toEqual(['initialize', 'session/adopt', 'session/prompt'])
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('refuses continuation of a running desktop task and keeps the round retryable', async () => {
    const { ctx, adapterConfig } = await fixtureSite('happy')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const continued = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/default', desktopTaskId: 'dtask-desktop-only', title: '', prompt: 'push further',
      })
      const failed = await observe(ctx, continued.workbenchTaskId, view => view.status === 'failed')
      expect(failed.lastError).toContain('the desktop task is not completed (running)')
      // Nothing was sent, so the same round may retry once the task finishes.
      const detail = await ctx.zcodeWorkbench.task(continued.workbenchTaskId)
      expect(detail!.retryAllowed).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('refuses cross-workspace and cross-node continuation: the task must be in the routed workspace', async () => {
    const { ctx, adapterConfig } = await fixtureSite('happy')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      // dtask-legacy-1 lives in /site/lab; asking for it from /site/default is refused.
      const wrongWorkspace = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/default', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'p',
      })
      const failed = await observe(ctx, wrongWorkspace.workbenchTaskId, view => view.status === 'failed')
      expect(failed.lastError).toContain("not in this workspace's synced task index")

      // A second node on the same site holds none of the first node's tasks:
      // its own default-workspace rows are the only ones it may continue.
      const secondConfig = join(adapterConfig, '../adapter-other.json')
      await writeFile(secondConfig, `${JSON.stringify({ scenario: 'happy' }, null, 2)}\n`, 'utf8')
      const second = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-other', secondConfig))
      const wrongNode = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: second.id, workspacePath: '/site/default', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'p',
      })
      const failedToo = await observe(ctx, wrongNode.workbenchTaskId, view => view.status === 'failed')
      expect(failedToo.lastError).toContain("not in this workspace's synced task index")
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('refuses a second follow-up while one is in flight on the same desktop task', async () => {
    const { ctx, adapterConfig } = await fixtureSite('hold-turn')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const first = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'slow round',
      })
      // The fixture holds the turn open for seconds; the guard must fire while
      // the round is beyond dispatching but not yet settled. A failure that
      // settles the round early also ends the wait instead of hanging.
      await observe(ctx, first.workbenchTaskId, view => view.status !== 'received' && view.status !== 'dispatching')
      await expect(ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'double click',
      })).rejects.toThrow('already has a follow-up in flight')
      await observe(ctx, first.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported' || view.status === 'failed')

      // Once the round settles, the next follow-up is a fresh record for the same task.
      const second = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'next round',
      })
      const settled = await observe(ctx, second.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported' || view.status === 'failed')
      expect(settled.desktopTaskId).toBe('dtask-legacy-1')
      expect(settled.workbenchTaskId).not.toBe(first.workbenchTaskId)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('retries an unsent continuation round after adoption refused, under the same task id', async () => {
    const { ctx, adapterConfig } = await fixtureSite('reject-adopt')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const continued = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'p',
      })
      const failed = await observe(ctx, continued.workbenchTaskId, view => view.status === 'failed')
      expect(failed.lastError).toContain('refused task adoption')
      const before = await ctx.zcodeWorkbench.task(continued.workbenchTaskId)
      expect(before!.retryAllowed).toBe(true)

      // The site recovers; the retry re-runs adoption under the same record id.
      await writeFile(adapterConfig, `${JSON.stringify({ scenario: 'happy', journal: join(adapterConfig, '../agent-calls.jsonl') }, null, 2)}\n`, 'utf8')
      const retried = await ctx.zcodeWorkbench.retryTask(continued.workbenchTaskId)
      expect(retried.workbenchTaskId).toBe(continued.workbenchTaskId)
      const settled = await observe(ctx, continued.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      expect(settled.acpSessionId).toBe('fake-acp-session-adopted-1')
      expect(settled.desktopTaskId).toBe('dtask-legacy-1')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('validates the request shape before creating any record', async () => {
    const { ctx, adapterConfig } = await fixtureSite('happy')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      await expect(ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: '', title: '', prompt: 'p',
      })).rejects.toThrow('desktopTaskId must be 1..200 characters')
      await expect(ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: '',
      })).rejects.toThrow('prompt must be 1..20000 characters')
      await expect(ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: 'missing', workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'p',
      })).rejects.toThrow('unknown node missing')
      // Nothing was created by the refused submissions.
      expect((await ctx.zcodeWorkbench.tasks()).length).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)
})
