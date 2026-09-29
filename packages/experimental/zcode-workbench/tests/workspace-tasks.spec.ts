import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ZcodeWorkbench from '../src/index.ts'
import { TaskStore } from '../src/store.ts'
import type { WorkbenchNodeInput, WorkbenchTaskView } from '../src/types.ts'

const fixtureAgent = join(import.meta.dirname, 'fixtures', 'fake-acp-agent.mjs')

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Boot the REAL composition (Loader-shaped Context with Typert + plugin). */
async function bootComposition(): Promise<{ ctx: Context; adapterConfig: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-wstasks-'))
  directories.push(dir)
  const adapterConfig = join(dir, 'adapter.json')
  await writeFile(adapterConfig, `${JSON.stringify({ scenario: 'happy' }, null, 2)}\n`, 'utf8')
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const fork = ctx.plugin(ZcodeWorkbench, {
    stateDir: dir,
    ingressPath: '/zcode-workbench/ingress',
    ingressTokenFile: join(dir, 'ingress-token'),
    maxTasks: 50,
    dispatchTimeoutMs: 15_000,
    healthTimeoutMs: 20_000,
  })
  await fork
  return { ctx, adapterConfig, dir }
}

/** A node submission pointing one adapter config; fixed nodes pin in config. */
function nodeInput(id: string, adapterConfig: string, workspaceSelection: 'fixed' | 'session' = 'session'): WorkbenchNodeInput {
  return {
    id,
    kind: 'remote',
    label: `Fixture ${id}`,
    siteLabel: 'test',
    command: process.execPath,
    args: [fixtureAgent, '--config', adapterConfig],
    workspaceSelection,
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

describe('workspace task listing (REAL composition over the fixture agent)', () => {
  it('lists desktop-synced and workbench-recorded tasks with the binding join', async () => {
    const { ctx, adapterConfig } = await bootComposition()
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'default workspace task', prompt: 'p', nodeId: node.id, workspacePath: '/site/default',
      })
      const settled = await observe(ctx, created.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')

      const listing = await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/default')
      expect(listing.nodeId).toBe(node.id)
      expect(listing.workspacePath).toBe('/site/default')
      expect(listing.desktop).toEqual({
        state: 'ok',
        desktopVersion: '3.14.0',
        tasks: [
          {
            taskId: 'dtask-wb-1', title: 'workbench dispatched task', status: 'completed',
            createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-21T01:05:00.000Z',
            origin: 'workbench', workbenchTaskId: created.workbenchTaskId,
          },
          {
            taskId: 'dtask-desktop-only', title: 'created on the desktop', status: 'running',
            createdAt: '2026-09-21T02:00:00.000Z', updatedAt: '2026-09-21T02:10:00.000Z',
            origin: 'desktop', workbenchTaskId: null,
          },
        ],
      })
      // The fixture's adapter session id binds the desktop row to the record.
      expect(settled.acpSessionId).toBe('fake-acp-session-1')
      expect(listing.workbench.map(task => task.workbenchTaskId)).toEqual([created.workbenchTaskId])
      expect(listing.workbench[0]!.nodeId).toBe(node.id)
      expect(listing.workbench[0]!.workspacePath).toBe('/site/default')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('isolates listings by workspace: no cross-workspace rows on either side', async () => {
    const { ctx, adapterConfig } = await bootComposition()
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const onDefault = await ctx.zcodeWorkbench.composeTask({
        title: 'default ws', prompt: 'p', nodeId: node.id, workspacePath: '/site/default',
      })
      await observe(ctx, onDefault.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      const onLab = await ctx.zcodeWorkbench.composeTask({
        title: 'lab ws', prompt: 'p', nodeId: node.id, workspacePath: '/site/lab',
      })
      await observe(ctx, onLab.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')

      const lab = await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/lab')
      expect(lab.desktop.state).toBe('ok')
      if (lab.desktop.state === 'ok') {
        expect(lab.desktop.tasks.map(task => task.taskId)).toEqual(['dtask-legacy-1'])
        expect(lab.desktop.tasks.every(task => task.workbenchTaskId === null)).toBe(true)
      }
      expect(lab.workbench.map(task => task.workbenchTaskId)).toEqual([onLab.workbenchTaskId])

      const progo = await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/deephik-progo')
      expect(progo.desktop.state).toBe('ok')
      if (progo.desktop.state === 'ok') {
        expect(progo.desktop.tasks.map(task => task.taskId)).toEqual(['dtask-progo-1'])
        expect(progo.desktop.tasks.every(task => task.workbenchTaskId === null)).toBe(true)
      }
      expect(progo.workbench).toEqual([])

      const def = await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/default')
      expect(def.workbench.map(task => task.workbenchTaskId)).toEqual([onDefault.workbenchTaskId])
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('isolates listings by node: another node sees the same site but none of the first node\'s records', async () => {
    const { ctx, adapterConfig } = await bootComposition()
    try {
      const first = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'routed to first node', prompt: 'p', nodeId: first.id, workspacePath: '/site/default',
      })
      await observe(ctx, created.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')

      const secondConfig = join(dirname(adapterConfig), 'adapter-other.json')
      await writeFile(secondConfig, `${JSON.stringify({ scenario: 'happy' }, null, 2)}\n`, 'utf8')
      const second = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-other', secondConfig))

      const other = await ctx.zcodeWorkbench.workspaceTasks(second.id, '/site/default')
      // The desktop index is the site's own fact and stays visible; the
      // workbench side is routed per node and stays empty for the second node.
      expect(other.desktop.state).toBe('ok')
      expect(other.workbench).toEqual([])

      const mine = await ctx.zcodeWorkbench.workspaceTasks(first.id, '/site/default')
      expect(mine.workbench.map(task => task.workbenchTaskId)).toEqual([created.workbenchTaskId])
      if (mine.desktop.state === 'ok') {
        const joined = mine.desktop.tasks.find(task => task.taskId === 'dtask-wb-1')
        expect(joined?.workbenchTaskId).toBe(created.workbenchTaskId)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('keeps fixed nodes compatible: no workspace argument, node-level filtering', async () => {
    const { ctx, adapterConfig } = await bootComposition()
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-fixed', adapterConfig, 'fixed'))
      expect(node.workspaceSelection).toBe('fixed')

      const listing = await ctx.zcodeWorkbench.workspaceTasks(node.id, '')
      expect(listing.workspacePath).toBeNull()
      expect(listing.desktop.state).toBe('ok')
      if (listing.desktop.state === 'ok') {
        expect(listing.desktop.tasks.map(task => task.taskId)).toEqual(['dtask-wb-1', 'dtask-desktop-only'])
      }
      expect(listing.workbench).toEqual([])

      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'fixed node task', prompt: 'p', nodeId: node.id, workspacePath: '__fixed__',
      })
      await observe(ctx, created.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      const after = await ctx.zcodeWorkbench.workspaceTasks(node.id, '')
      expect(after.workbench.map(task => task.workbenchTaskId)).toEqual([created.workbenchTaskId])
      expect(after.workbench[0]!.workspacePath).toBeNull()
      // The adapter session id is recorded on the workbench record, so a
      // re-read of the same listing cannot re-dispatch under a new binding.
      expect(after.workbench[0]!.acpSessionId).toBe('fake-acp-session-1')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('refuses a session node without a workspace and states the desktop boundary on failure', async () => {
    const { ctx, adapterConfig } = await bootComposition()
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      await expect(ctx.zcodeWorkbench.workspaceTasks(node.id, ''))
        .rejects.toThrow('pick one before reading its tasks')

      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'kept record', prompt: 'p', nodeId: node.id, workspacePath: '/site/default',
      })
      await observe(ctx, created.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')

      // The site's task index breaks: the desktop facet reports unavailable
      // with the fixed reason while workbench records stay listable.
      await writeFile(adapterConfig, `${JSON.stringify({ scenario: 'tasks-fail' }, null, 2)}\n`, 'utf8')
      const broken = await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/default')
      expect(broken.desktop.state).toBe('unavailable')
      if (broken.desktop.state === 'unavailable') {
        expect(broken.desktop.reason).toContain('task listing failed')
      }
      expect(broken.workbench.map(task => task.workbenchTaskId)).toEqual([created.workbenchTaskId])
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('stamps the adapter-verified desktop task id onto compose rounds, keeping the chain one conversation durably', async () => {
    // The live regression shape: a compose round records only its ACP session
    // id, so once a follow-up round takes over the row's join the older round
    // loses its only link and the chain splits. The index's verified
    // dshSessionId→taskId binding backfills the durable desktopTaskId instead.
    const { ctx, adapterConfig, dir } = await bootComposition()
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const roundA = await ctx.zcodeWorkbench.composeTask({
        title: 'round a', prompt: 'p', nodeId: node.id, workspacePath: '/site/default',
      })
      await observe(ctx, roundA.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      // Before any listing, the compose round has no desktop task id of its own.
      expect((await ctx.zcodeWorkbench.task(roundA.workbenchTaskId))!.desktopTaskId).toBeNull()
      // The first listing that sees the adapter binding stamps it durably.
      await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/default')
      expect((await ctx.zcodeWorkbench.task(roundA.workbenchTaskId))!.desktopTaskId).toBe('dtask-wb-1')

      // A follow-up round rides the same binding; after it settles and the
      // index is re-read, the row points at the newest round while BOTH
      // records carry the same verified desktop task id — one conversation
      // no matter what the sampled join says.
      const roundB = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/default', desktopTaskId: 'dtask-wb-1', title: 'round b', prompt: 'p2',
      })
      await observe(ctx, roundB.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      const after = await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/default')
      expect(after.desktop.state).toBe('ok')
      if (after.desktop.state === 'ok') {
        const row = after.desktop.tasks.find(task => task.taskId === 'dtask-wb-1')
        expect(row?.workbenchTaskId).toBe(roundB.workbenchTaskId)
      }
      const every = await ctx.zcodeWorkbench.tasks()
      expect(every.filter(task => task.desktopTaskId === 'dtask-wb-1').map(task => task.workbenchTaskId))
        .toEqual([roundB.workbenchTaskId, roundA.workbenchTaskId])
      // The stamped id is durable: a fresh store over the same state dir
      // reads it back (restart- and index-outage-safe grouping basis).
      const reopened = new TaskStore(dir, 50)
      await reopened.load()
      expect(reopened.get(roundA.workbenchTaskId)?.desktopTaskId).toBe('dtask-wb-1')
      expect(reopened.get(roundB.workbenchTaskId)?.desktopTaskId).toBe('dtask-wb-1')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('never backfills a round whose session the index does not bind', async () => {
    const { ctx, adapterConfig } = await bootComposition()
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      // The lab workspace's only index row is desktop-origin with no session
      // binding: a compose round there keeps desktopTaskId null — nothing is
      // guessed, even after the bound default workspace is listed too, and it
      // never merges into another workspace's chain.
      const lab = await ctx.zcodeWorkbench.composeTask({
        title: 'lab round', prompt: 'p', nodeId: node.id, workspacePath: '/site/lab',
      })
      await observe(ctx, lab.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/lab')
      await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/default')
      expect((await ctx.zcodeWorkbench.task(lab.workbenchTaskId))!.desktopTaskId).toBeNull()
      const every = await ctx.zcodeWorkbench.tasks()
      expect(every.filter(task => task.desktopTaskId === 'dtask-wb-1')).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('concurrent listings stamp the compose round once — the serialized re-check never rewrites', async () => {
    // Two listings racing on the same workspace both snapshot the record with
    // desktopTaskId null; their store transactions serialize, and the second
    // one's in-transaction re-check must see the id already claimed and no-op
    // instead of blindly writing again.
    const { ctx, adapterConfig } = await bootComposition()
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const roundA = await ctx.zcodeWorkbench.composeTask({
        title: 'raced round', prompt: 'p', nodeId: node.id, workspacePath: '/site/default',
      })
      await observe(ctx, roundA.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      const [first, second] = await Promise.all([
        ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/default'),
        ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/default'),
      ])
      expect(first.desktop.state).toBe('ok')
      expect(second.desktop.state).toBe('ok')
      for (const listing of [first, second]) {
        if (listing.desktop.state === 'ok') {
          const row = listing.desktop.tasks.find(task => task.taskId === 'dtask-wb-1')
          expect(row?.workbenchTaskId).toBe(roundA.workbenchTaskId)
        }
      }
      // Exactly one record carries the stamped id, exactly once-written.
      expect((await ctx.zcodeWorkbench.task(roundA.workbenchTaskId))!.desktopTaskId).toBe('dtask-wb-1')
      const every = await ctx.zcodeWorkbench.tasks()
      expect(every.filter(task => task.desktopTaskId === 'dtask-wb-1').map(task => task.workbenchTaskId))
        .toEqual([roundA.workbenchTaskId])
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('surfaces no addresses or credentials on the listing views', async () => {
    const { ctx, adapterConfig } = await bootComposition()
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const listing = await ctx.zcodeWorkbench.workspaceTasks(node.id, '/site/default')
      const dump = JSON.stringify(listing)
      expect(dump).not.toMatch(/https?:\/\//)
      expect(dump).not.toMatch(/wss?:\/\//)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)
})
