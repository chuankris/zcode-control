import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { existsSync } from 'node:fs'
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

/**
 * One fixture agent config file plus the journal its methods append to. The
 * config is re-read by every fixture spawn, so `writeConfig` switches the
 * scenario or the reconcile evidence between phases of one test.
 */
async function fixtureSite(scenario: string, extra: Record<string, unknown> = {}): Promise<{
  ctx: Context
  adapterConfig: string
  journalFile: string
  stuckDispatchFile: string
  stateDir: string
  writeConfig: (scenario: string, more?: Record<string, unknown>) => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-reconcile-'))
  directories.push(dir)
  const adapterConfig = join(dir, 'adapter.json')
  const journalFile = join(dir, 'agent-calls.jsonl')
  const stuckDispatchFile = join(dir, 'stuck-dispatch.json')
  const writeConfig = async (next: string, more: Record<string, unknown> = {}): Promise<void> => {
    await writeFile(adapterConfig, `${JSON.stringify({ scenario: next, journal: journalFile, stuckDispatchFile, ...extra, ...more }, null, 2)}\n`, 'utf8')
  }
  await writeConfig(scenario)
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
  return { ctx, adapterConfig, journalFile, stuckDispatchFile, stateDir: dir, writeConfig }
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

/** The durable echo-lost flag can precede cleanup of the original live turn. */
async function waitUntilDispatchSettled(ctx: Context, workbenchTaskId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await ctx.zcodeWorkbench.reconcileEchoLostFollowup({ workbenchTaskId })
      return
    } catch (error) {
      if (!String(error).includes('still dispatching in this process')) return
    }
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
  throw new Error('the original dispatch did not release its live handle')
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

describe('reconcile echo-lost follow-up (REAL composition over the fixture agent)', () => {
  it('writes off a verified round and reopens the same desktop task for a new follow-up', async () => {
    const { ctx, journalFile, stuckDispatchFile, stateDir, adapterConfig, writeConfig } = await fixtureSite('link-lost-turn')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const lost = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'please continue the incident report',
      })
      const stuck = await observe(ctx, lost.workbenchTaskId, view => view.zcodeDelivery === 'echo_lost')
      expect(stuck.echoLost).toBe(true)
      await waitUntilDispatchSettled(ctx, lost.workbenchTaskId)

      // Both layers hold: the workbench refuses a second round, and the site
      // adapter's binding ledger would refuse adoption of the same task.
      await expect(ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'try again',
      })).rejects.toThrow('already has a follow-up in flight')
      expect(existsSync(stuckDispatchFile)).toBe(true)

      // Dry run: evidence only, no state change on either side.
      const evidence = await ctx.zcodeWorkbench.reconcileEchoLostFollowup({ workbenchTaskId: lost.workbenchTaskId })
      expect(evidence.writtenOff).toBe(false)
      expect(evidence.workbenchRecordUpdated).toBe(false)
      expect(evidence.commandId).toBe('cmd-fixture-stuck-1')
      expect(evidence.evidence.taskStatus).toBe('completed')
      expect(evidence.evidence.phase).toBe('completedSuccess')
      expect(evidence.evidence.pendingInteractions).toBe(0)
      expect(evidence.evidence.promptMatched).toBe(false)
      expect(existsSync(stuckDispatchFile)).toBe(true)
      await expect(ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'still locked',
      })).rejects.toThrow('already has a follow-up in flight')

      // Confirm under the human attestation: both locks release.
      const writtenOff = await ctx.zcodeWorkbench.reconcileEchoLostFollowup({
        workbenchTaskId: lost.workbenchTaskId,
        confirm: { humanVerified: true, operator: 'codex-once' },
      })
      expect(writtenOff.writtenOff).toBe(true)
      expect(writtenOff.workbenchRecordUpdated).toBe(true)
      const released = await ctx.zcodeWorkbench.task(lost.workbenchTaskId)
      expect(released!.echoLost).toBe(false)
      // The reading itself moves a terminal workbench-origin record to reported.
      expect(released!.status).toBe('reported')
      expect(released!.zcodeDelivery).toBe('terminal')
      expect(released!.lastError).toContain('written off after on-site verification')
      expect(released!.lastError).toContain('cmd-fixture-stuck-1')
      expect(existsSync(stuckDispatchFile)).toBe(false)

      // The workbench audit trail records the write-off without the prompt text.
      const ledger = (await readFile(join(stateDir, 'reconcile-ledger.jsonl'), 'utf8')).split('\n').filter(line => line.length > 0)
      expect(ledger.length).toBe(1)
      const entry = JSON.parse(ledger[0]!) as Record<string, unknown>
      expect(entry['kind']).toBe('reconcile-followup')
      expect(entry['workbenchTaskId']).toBe(lost.workbenchTaskId)
      expect(entry['desktopTaskId']).toBe('dtask-legacy-1')
      expect(entry['nodeId']).toBe(node.id)
      expect(entry['commandId']).toBe('cmd-fixture-stuck-1')
      expect(entry['mode']).toBe('human-verified')
      expect(entry['operator']).toBe('codex-once')
      expect(ledger[0]).not.toContain('incident report')

      // A new follow-up round on the SAME desktop task completes normally.
      await writeConfig('happy')
      const next = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'a fresh instruction',
      })
      expect(next.workbenchTaskId).not.toBe(lost.workbenchTaskId)
      expect(next.desktopTaskId).toBe('dtask-legacy-1')
      await observe(ctx, next.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported')

      const methods = await journalMethods(journalFile)
      // Exactly one session/new: the saveNode capability probe. Both
      // continuation rounds rode session/adopt; nothing created a session.
      expect(methods.filter(method => method === 'session/new')).toHaveLength(1)
      expect(methods.filter(method => method === 'session/adopt')).toHaveLength(2)
      expect(methods.filter(method => method === 'session/prompt')).toHaveLength(2)
      expect(methods.filter(method => method === 'reconcile-confirm')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 180_000)

  it('refuses a duplicate write-off of an already reconciled round', async () => {
    const { ctx, adapterConfig } = await fixtureSite('link-lost-turn')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const lost = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'one more pass',
      })
      await observe(ctx, lost.workbenchTaskId, view => view.zcodeDelivery === 'echo_lost')
      await waitUntilDispatchSettled(ctx, lost.workbenchTaskId)
      const done = await ctx.zcodeWorkbench.reconcileEchoLostFollowup({
        workbenchTaskId: lost.workbenchTaskId,
        confirm: { humanVerified: true, operator: 'codex-once' },
      })
      expect(done.writtenOff).toBe(true)
      await expect(ctx.zcodeWorkbench.reconcileEchoLostFollowup({
        workbenchTaskId: lost.workbenchTaskId,
        confirm: { humanVerified: true, operator: 'codex-twice' },
      })).rejects.toThrow('only rounds whose desktop outcome is unknown')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('refuses rounds that are not echo-lost', async () => {
    const { ctx, adapterConfig } = await fixtureSite('hold-turn')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      // A live round has a known owner: not reconcilable.
      const live = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'slow round',
      })
      await observe(ctx, live.workbenchTaskId, view => view.status !== 'received' && view.status !== 'dispatching')
      await expect(ctx.zcodeWorkbench.reconcileEchoLostFollowup({ workbenchTaskId: live.workbenchTaskId }))
        .rejects.toThrow('this round is still dispatching in this process')
      await observe(ctx, live.workbenchTaskId, view => view.status === 'completed' || view.status === 'reported' || view.status === 'failed')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)

  it('keeps both locks when the site evidence refuses the write-off', async () => {
    const { ctx, stuckDispatchFile, stateDir, adapterConfig, writeConfig } = await fixtureSite('link-lost-turn')
    try {
      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      const lost = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'please continue the incident report',
      })
      await observe(ctx, lost.workbenchTaskId, view => view.zcodeDelivery === 'echo_lost')
      await waitUntilDispatchSettled(ctx, lost.workbenchTaskId)

      // The desktop task is running again: the command may have been applied.
      await writeConfig('link-lost-turn', { reconcileTaskStatus: 'running' })
      await expect(ctx.zcodeWorkbench.reconcileEchoLostFollowup({
        workbenchTaskId: lost.workbenchTaskId,
        confirm: { humanVerified: true, operator: 'codex-once' },
      })).rejects.toThrow('task-running')
      let record = await ctx.zcodeWorkbench.task(lost.workbenchTaskId)
      expect(record!.echoLost).toBe(true)
      expect(existsSync(stuckDispatchFile)).toBe(true)

      // The old instruction is visible in the desktop conversation: applied.
      await writeConfig('link-lost-turn', { reconcileForcePromptMatched: true })
      await expect(ctx.zcodeWorkbench.reconcileEchoLostFollowup({
        workbenchTaskId: lost.workbenchTaskId,
        confirm: { humanVerified: true, operator: 'codex-once' },
      })).rejects.toThrow('prompt-matched')
      record = await ctx.zcodeWorkbench.task(lost.workbenchTaskId)
      expect(record!.echoLost).toBe(true)
      expect(existsSync(stuckDispatchFile)).toBe(true)
      // The workbench audit trail stayed empty through every refusal.
      expect(existsSync(join(stateDir, 'reconcile-ledger.jsonl'))).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 180_000)

  it('refuses unknown tasks, missing attestation, and non-continuation rounds', async () => {
    const { ctx, adapterConfig } = await fixtureSite('link-lost-turn')
    try {
      await expect(ctx.zcodeWorkbench.reconcileEchoLostFollowup({ workbenchTaskId: 'WB-9999-999' }))
        .rejects.toThrow('unknown task WB-9999-999')

      const node = await ctx.zcodeWorkbench.saveNode(nodeInput('fixture-site', adapterConfig))
      // A fresh (non-continuation) round that lost its echo has no follow-up lock.
      const fresh = await ctx.zcodeWorkbench.composeTask({
        title: 'fresh round', prompt: 'p', nodeId: node.id, workspacePath: '/site/default',
      })
      await observe(ctx, fresh.workbenchTaskId, view => view.zcodeDelivery === 'echo_lost')
      await waitUntilDispatchSettled(ctx, fresh.workbenchTaskId)
      await expect(ctx.zcodeWorkbench.reconcileEchoLostFollowup({ workbenchTaskId: fresh.workbenchTaskId }))
        .rejects.toThrow('this round is not a continuation')

      // The attestation must be explicit and its operator label usable.
      const lost = await ctx.zcodeWorkbench.continueDesktopTask({
        nodeId: node.id, workspacePath: '/site/lab', desktopTaskId: 'dtask-legacy-1', title: '', prompt: 'round two',
      })
      await observe(ctx, lost.workbenchTaskId, view => view.zcodeDelivery === 'echo_lost')
      await expect(ctx.zcodeWorkbench.reconcileEchoLostFollowup({
        workbenchTaskId: lost.workbenchTaskId,
        confirm: { humanVerified: false, operator: 'someone' },
      })).rejects.toThrow('explicit human verification')
      await expect(ctx.zcodeWorkbench.reconcileEchoLostFollowup({
        workbenchTaskId: lost.workbenchTaskId,
        confirm: { humanVerified: true, operator: '' },
      })).rejects.toThrow('confirm.operator')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 180_000)
})
