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

/** Boot the REAL composition with a journaled fixture site. */
async function bootComposition(scenario: string): Promise<{ ctx: Context; adapterConfig: string; journalFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-snapshot-'))
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

/** Sample the task status until `done` holds. */
async function observe(ctx: Context, workbenchTaskId: string, done: (view: WorkbenchTaskView) => boolean): Promise<WorkbenchTaskView> {
  for (;;) {
    const detail = await ctx.zcodeWorkbench.task(workbenchTaskId)
    expect(detail).toBeDefined()
    if (done(detail!)) return detail!
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
}

describe('desktop task snapshot (REAL composition over the fixture agent)', () => {
  it('reads a native task snapshot read-only: no adopt, no prompt, ordered summary, partial flagged', async () => {
    const { ctx, adapterConfig, journalFile } = await bootComposition('happy')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const result = await ctx.zcodeWorkbench.desktopTaskSnapshot(node.id, '/site/lab', 'dtask-legacy-1')
      expect(result.state).toBe('ok')
      if (result.state === 'ok') {
        expect(result.snapshot.taskId).toBe('dtask-legacy-1')
        expect(result.snapshot.phase).toBe('completedSuccess')
        expect(result.snapshot.pendingInteractions).toBe(0)
        // The fixture's window models a truncated tail: recent-only, honestly flagged.
        expect(result.snapshot.partial).toBe(true)
        expect(result.snapshot.summary.map(entry => entry.kind)).toEqual(['user', 'tool', 'assistant'])
        expect(result.snapshot.summary[0]!.text).toBe('原生任务的原问题')
        expect(result.snapshot.summary[1]!.toolTitle).toBe('Read')
        expect(result.snapshot.summary[2]!.text).toContain('要点')
      }
      // The journaled call set after the node's own save-time capability probe
      // (initialize + session/new): the snapshot mode entry and nothing else —
      // no session/adopt and no session/prompt ever ran for it.
      const methods = await journalMethods(journalFile)
      expect(methods[methods.length - 1]).toBe('--task-snapshot')
      expect(methods).not.toContain('session/adopt')
      expect(methods).not.toContain('session/prompt')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('isolates workspaces: a task of another workspace answers unavailable, not faked', async () => {
    const { ctx, adapterConfig } = await bootComposition('happy')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      // dtask-legacy-1 belongs to /site/lab; the default workspace's own
      // index does not carry it.
      const result = await ctx.zcodeWorkbench.desktopTaskSnapshot(node.id, '/site/default', 'dtask-legacy-1')
      expect(result.state).toBe('unavailable')
      if (result.state === 'unavailable') {
        expect(result.reason).toBe('task-missing')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('answers unavailable with the fixed-string reason when the read fails', async () => {
    const { ctx, adapterConfig } = await bootComposition('snapshot-fail')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const result = await ctx.zcodeWorkbench.desktopTaskSnapshot(node.id, '/site/lab', 'dtask-legacy-1')
      expect(result.state).toBe('unavailable')
      if (result.state === 'unavailable') {
        expect(result.reason).toContain('did not report a task snapshot')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('waits behind an active dispatch instead of contending the single controller slot', async () => {
    const { ctx, adapterConfig, journalFile } = await bootComposition('hold-turn')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      // The hold-turn scenario occupies the turn (and the controller) for
      // four seconds after the prompt ack.
      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'held turn', prompt: 'p', nodeId: node.id, workspacePath: '/site/lab',
      })
      let settled = false
      void observe(ctx, created.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
        .then(() => { settled = true })
      // The snapshot read queues on the node; while the dispatch owns the slot
      // it must stay pending, and no snapshot process may have started.
      const snapshotPromise = ctx.zcodeWorkbench.desktopTaskSnapshot(node.id, '/site/lab', 'dtask-legacy-1')
      const raced = await Promise.race([
        snapshotPromise.then(() => 'resolved'),
        new Promise<'pending'>(resolve => { setTimeout(() => { resolve('pending') }, 300) }),
      ])
      expect(raced).toBe('pending')
      expect(await journalMethods(journalFile)).not.toContain('--task-snapshot')
      // Once the turn settles, the queued read runs and answers.
      const result = await snapshotPromise
      expect(result.state).toBe('ok')
      expect(settled).toBe(true)
      expect(await journalMethods(journalFile)).toContain('--task-snapshot')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('validates its inputs like every other remote', async () => {
    const { ctx, adapterConfig } = await bootComposition('happy')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      await expect(ctx.zcodeWorkbench.desktopTaskSnapshot(node.id, '/site/lab', '')).rejects.toThrow('1..200 characters')
      await expect(ctx.zcodeWorkbench.desktopTaskSnapshot(node.id, '', 'dtask-legacy-1')).rejects.toThrow('pick one before reading')
      await expect(ctx.zcodeWorkbench.desktopTaskSnapshot('missing-node', '/site/lab', 'dtask-legacy-1')).rejects.toThrow('unknown node')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)
})
