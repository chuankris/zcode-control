import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ZcodeWorkbench from '../src/index.ts'
import type { WorkbenchNodeInput, WorkbenchTaskStatus, WorkbenchTaskView } from '../src/types.ts'

const fixtureAgent = join(import.meta.dirname, 'fixtures', 'fake-acp-agent.mjs')

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Boot the REAL composition: Loader-shaped Context with Typert + the plugin (no node saved yet). */
async function bootComposition(scenario: string): Promise<{ ctx: Context; adapterConfig: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-dispatch-'))
  directories.push(dir)
  const adapterConfig = join(dir, 'adapter.json')
  await writeFile(adapterConfig, `${JSON.stringify({ scenario }, null, 2)}\n`, 'utf8')
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
  return { ctx, adapterConfig }
}

/** The per-session fixture node submission pointing at one adapter config. */
function nodeInput(adapterConfig: string, workspaceSelection: 'fixed' | 'session' = 'session'): WorkbenchNodeInput {
  return {
    id: 'fixture-site',
    kind: 'remote',
    label: 'Fixture site',
    siteLabel: 'test',
    command: process.execPath,
    args: [fixtureAgent, '--config', adapterConfig],
    workspaceSelection,
  }
}

/** Boot the composition and save the fixture node (its save-time capability probe must pass). */
async function boot(scenario: string): Promise<{ ctx: Context; nodeId: string; adapterConfig: string }> {
  const { ctx, adapterConfig } = await bootComposition(scenario)
  const node = await ctx.zcodeWorkbench.saveNode(nodeInput(adapterConfig))
  return { ctx, nodeId: node.id, adapterConfig }
}

/** Rewrite the fixture agent's scenario file in place (operator repair/drift). */
async function setScenario(adapterConfig: string, scenario: string): Promise<void> {
  await writeFile(adapterConfig, `${JSON.stringify({ scenario }, null, 2)}\n`, 'utf8')
}

/** Sample the task status until `done` holds; records every observed status. */
async function observe(
  ctx: Context, workbenchTaskId: string, done: (view: WorkbenchTaskView) => boolean,
): Promise<{ final: WorkbenchTaskView; seen: Set<WorkbenchTaskStatus>; sawAwaitingInput: boolean }> {
  const seen = new Set<WorkbenchTaskStatus>()
  let sawAwaitingInput = false
  for (;;) {
    const detail = await ctx.zcodeWorkbench.task(workbenchTaskId)
    expect(detail).toBeDefined()
    const view = detail!
    seen.add(view.status)
    if (view.awaitingInput) sawAwaitingInput = true
    if (done(view)) return { final: view, seen, sawAwaitingInput }
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
}

describe('zcode workbench dispatch (REAL composition over the fixture agent)', () => {
  it('walks the full chain with transcript, approval tracking, and a locked route', async () => {
    const { ctx, nodeId } = await boot('happy')
    try {
      const health = await ctx.zcodeWorkbench.checkNode(nodeId)
      expect(health.health.state).toBe('online')
      expect(health.health.desktopVersion).toBe('3.14.0')
      expect(health.health.workspaceCount).toBe(3)

      const listing = await ctx.zcodeWorkbench.listWorkspaces(nodeId)
      expect(listing.options.map(option => option.path)).toEqual(['/site/default', '/site/deephik-progo', '/site/lab'])

      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'fixture turn',
        prompt: 'run the fixture task',
        nodeId,
        workspacePath: '/site/default',
      })
      expect(['dispatching', 'zcode_acknowledged', 'running']).toContain(created.status)
      const { final, seen, sawAwaitingInput } = await observe(ctx, created.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      // The intermediate chain is asserted from the durable status trace, not
      // from polled observation: on slow hosts one poll iteration can skip the
      // brief zcode_acknowledged window while the transitions still happened.
      const detail = await ctx.zcodeWorkbench.task(created.workbenchTaskId)
      const statusTrace = detail!.transcript.filter(event => event.kind === 'status').map(event => event.text)
      expect(statusTrace).toEqual(expect.arrayContaining(['dispatching', 'zcode_acknowledged', 'running']))
      // The observer's own read marks the terminal workbench-origin task reported.
      expect(seen.has('completed') || seen.has('reported')).toBe(true)
      expect(sawAwaitingInput).toBe(true)
      expect(final.awaitingInput).toBe(false)
      expect(final.zcodeDelivery).toBe('terminal')
      expect(final.echoLost).toBe(false)
      expect(final.acpSessionId).toBe('fake-acp-session-1')

      const texts = detail!.transcript.map(event => event.text)
      expect(texts).toContain('first segment plus appended segment')
      expect(texts).toContain('final answer')
      expect(texts).toContain('Read')
      // The approval card never lands in the transcript; it drives awaitingInput only.
      expect(detail!.transcript.every(event => event.key !== 'zdesktop-approval')).toBe(true)
      // Reading the terminal workbench-origin task marks it reported.
      expect(detail!.status).toBe('reported')

      // The route locked with the first dispatched prompt.
      await expect(ctx.zcodeWorkbench.routeTask({ workbenchTaskId: created.workbenchTaskId, nodeId, workspacePath: '/site/lab' }))
        .rejects.toThrow('route is locked')
      await expect(ctx.zcodeWorkbench.retryTask(created.workbenchTaskId))
        .rejects.toThrow('already sent a prompt')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('keeps an echo-lost task non-terminal and refuses re-dispatch', async () => {
    const { ctx, nodeId } = await boot('die-mid-turn')
    try {
      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'die mid turn', prompt: 'p', nodeId, workspacePath: '/site/default',
      })
      const { final } = await observe(ctx, created.workbenchTaskId, view => view.echoLost)
      expect(['running', 'zcode_acknowledged']).toContain(final.status)
      expect(final.zcodeDelivery).toBe('echo_lost')
      await expect(ctx.zcodeWorkbench.retryTask(created.workbenchTaskId)).rejects.toThrow('already sent a prompt')
      const cancelled = await ctx.zcodeWorkbench.cancelTask(created.workbenchTaskId)
      expect(['cancelled', 'running', 'zcode_acknowledged']).toContain(cancelled.status)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('marks a link-lost turn after the ack as echo lost, not failed', async () => {
    const { ctx, nodeId } = await boot('link-lost-turn')
    try {
      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'link lost', prompt: 'p', nodeId, workspacePath: '/site/default',
      })
      const { final } = await observe(ctx, created.workbenchTaskId, view => view.echoLost)
      expect(final.status).toBe('zcode_acknowledged')
      expect(final.lastError).toContain('unknown')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('retries a pre-ack failure under the same task id once the node recovers', async () => {
    // The node is saved while healthy (a session node whose adapter cannot
    // serve workspace options is refused at save time), then the site breaks:
    // dispatch fails at session creation, the operator repairs the node, and
    // the retry reuses the same task id.
    const { ctx, nodeId, adapterConfig } = await boot('happy')
    try {
      await setScenario(adapterConfig, 'reject-session')
      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'reject then retry', prompt: 'p', nodeId, workspacePath: '/site/default',
      })
      const { final } = await observe(ctx, created.workbenchTaskId, view => view.status === 'failed')
      expect(final.lastError).toContain('refused session creation')
      const failedDetail = await ctx.zcodeWorkbench.task(created.workbenchTaskId)
      expect(failedDetail!.retryAllowed).toBe(true)

      // The operator fixes the node; the retry reuses the same task id.
      await setScenario(adapterConfig, 'happy')
      const retried = await ctx.zcodeWorkbench.retryTask(created.workbenchTaskId)
      expect(retried.workbenchTaskId).toBe(created.workbenchTaskId)
      const { final: done } = await observe(ctx, created.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      expect(['completed', 'reported']).toContain(done.status)
      const every = await ctx.zcodeWorkbench.tasks()
      expect(every.filter(task => task.source === 'workbench')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('refuses to save a per-session node whose adapter offers no workspace option', async () => {
    // The live regression shape: --health answers online, but session/new
    // completes without a workspace option (a fixed-workspace adapter saved as
    // a per-session node). Saving must be refused with the actionable reason;
    // the same launcher saved as fixed needs no session capability.
    const { ctx, adapterConfig } = await bootComposition('no-workspaces')
    try {
      await expect(ctx.zcodeWorkbench.saveNode(nodeInput(adapterConfig)))
        .rejects.toThrow(/answered session\/new without offering a workspace option/)
      const fixed = await ctx.zcodeWorkbench.saveNode(nodeInput(adapterConfig, 'fixed'))
      expect(fixed.workspaceSelection).toBe('fixed')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('refuses to save a per-session node while its site is unreachable, then saves once it recovers', async () => {
    const { ctx, adapterConfig } = await bootComposition('reject-session')
    try {
      await expect(ctx.zcodeWorkbench.saveNode(nodeInput(adapterConfig)))
        .rejects.toThrow('refused session creation')
      await setScenario(adapterConfig, 'happy')
      const saved = await ctx.zcodeWorkbench.saveNode(nodeInput(adapterConfig))
      expect(saved.id).toBe('fixture-site')
      expect(saved.workspaceSelection).toBe('session')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('keeps health and routing consistent when a saved session node drifts into a no-workspace adapter', async () => {
    // The exact 2026-09-22 live scenario: the node passed its save-time
    // capability probe, then the adapter configuration drifted. The raw
    // --health line stays online, so the workbench's own health gate must
    // surface the discovery failure, the routing page must explain it, and a
    // dispatch must fail with the actionable reason instead of a cryptic one.
    const { ctx, nodeId, adapterConfig } = await boot('happy')
    try {
      await setScenario(adapterConfig, 'no-workspaces')
      const health = await ctx.zcodeWorkbench.checkNode(nodeId)
      expect(health.health.state).toBe('offline')
      expect(health.health.detail).toMatch(/answered session\/new without offering a workspace option/)

      await expect(ctx.zcodeWorkbench.listWorkspaces(nodeId))
        .rejects.toThrow(/answered session\/new without offering a workspace option/)

      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'drifted node', prompt: 'p', nodeId, workspacePath: '/site/default',
      })
      const { final } = await observe(ctx, created.workbenchTaskId, view => view.status === 'failed')
      expect(final.lastError).toMatch(/answered session\/new without offering a workspace option/)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)

  it('surfaces no addresses or credentials on any wire view', async () => {
    const { ctx, nodeId } = await boot('happy')
    try {
      await ctx.zcodeWorkbench.checkNode(nodeId)
      const created = await ctx.zcodeWorkbench.composeTask({
        title: 'scrub', prompt: 'plain fixture prompt', nodeId, workspacePath: '/site/default',
      })
      await observe(ctx, created.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')
      // None of the workbench state originates from the adapter's private
      // configuration, so no wire view can carry an address or credential.
      const dump = JSON.stringify({
        nodes: await ctx.zcodeWorkbench.nodes(),
        tasks: await ctx.zcodeWorkbench.tasks(),
        detail: await ctx.zcodeWorkbench.task(created.workbenchTaskId),
      })
      expect(dump).not.toMatch(/https?:\/\//)
      expect(dump).not.toMatch(/wss?:\/\//)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 90_000)
})
