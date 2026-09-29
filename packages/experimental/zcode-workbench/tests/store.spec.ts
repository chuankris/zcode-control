import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskStore } from '../src/store.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function freshStore(maxTasks = 200): Promise<TaskStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-store-'))
  directories.push(dir)
  const store = new TaskStore(dir, maxTasks)
  await store.load()
  return store
}

const now = new Date('2026-09-21T08:00:00.000Z')

describe('workbench task store', () => {
  it('creates idempotently by codex source identity', async () => {
    const store = await freshStore()
    const first = await store.create({ source: 'codex', sourceTaskId: 'codex-1', threadId: 'thread-9', title: 't', prompt: 'p', now })
    const second = await store.create({ source: 'codex', sourceTaskId: 'codex-1', threadId: 'thread-9', title: 't2', prompt: 'p2', now })
    expect(second.created).toBe(false)
    expect(second.record.workbenchTaskId).toBe(first.record.workbenchTaskId)
    expect(store.list()).toHaveLength(1)
    // A different thread id is a different origin task.
    const third = await store.create({ source: 'codex', sourceTaskId: 'codex-1', threadId: null, title: 't', prompt: 'p', now })
    expect(third.created).toBe(true)
    expect(store.list()).toHaveLength(2)
  })

  it('mints daily sequence ids and never reuses one', async () => {
    const store = await freshStore()
    const one = await store.create({ source: 'workbench', sourceTaskId: null, threadId: null, title: 't', prompt: 'p', now })
    const two = await store.create({ source: 'workbench', sourceTaskId: null, threadId: null, title: 't', prompt: 'p', now })
    expect(one.record.workbenchTaskId).toBe('WB-20260921-001')
    expect(two.record.workbenchTaskId).toBe('WB-20260921-002')
    const nextDay = await store.create({
      source: 'workbench', sourceTaskId: null, threadId: null, title: 't', prompt: 'p',
      now: new Date('2026-09-22T08:00:00.000Z'),
    })
    expect(nextDay.record.workbenchTaskId).toBe('WB-20260922-001')
  })

  it('refuses illegal transitions instead of coercing', async () => {
    const store = await freshStore()
    const { record } = await store.create({ source: 'codex', sourceTaskId: 'c1', threadId: null, title: 't', prompt: 'p', now })
    await expect(store.transition(record.workbenchTaskId, 'running')).rejects.toThrow('illegal task transition received -> running')
    await store.transition(record.workbenchTaskId, 'awaiting_route')
    await store.transition(record.workbenchTaskId, 'dispatching')
    await store.transition(record.workbenchTaskId, 'zcode_acknowledged')
    await expect(store.transition(record.workbenchTaskId, 'dispatching')).rejects.toThrow()
    await store.transition(record.workbenchTaskId, 'running')
    await store.transition(record.workbenchTaskId, 'completed')
    await store.transition(record.workbenchTaskId, 'reported')
    expect(store.get(record.workbenchTaskId)?.status).toBe('reported')
  })

  it('keeps the real outcome through the reported marking for every terminal result', async () => {
    for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-outcome-'))
      directories.push(dir)
      const store = new TaskStore(dir, 200)
      await store.load()
      const { record } = await store.create({ source: 'workbench', sourceTaskId: null, threadId: null, title: 't', prompt: 'p', now })
      await store.transition(record.workbenchTaskId, 'awaiting_route')
      await store.transition(record.workbenchTaskId, 'dispatching')
      await store.transition(record.workbenchTaskId, 'zcode_acknowledged')
      await store.transition(record.workbenchTaskId, 'running')
      await store.transition(record.workbenchTaskId, outcome)
      expect(store.get(record.workbenchTaskId)?.terminalOutcome).toBe(outcome)
      // The reported marking must never overwrite the recorded outcome.
      await store.transition(record.workbenchTaskId, 'reported')
      const reported = store.get(record.workbenchTaskId)
      expect(reported?.status).toBe('reported')
      expect(reported?.terminalOutcome).toBe(outcome)
      // And it survives persistence: reopening the file keeps the outcome.
      const reopened = new TaskStore(dir, 200)
      await reopened.load()
      expect(reopened.get(record.workbenchTaskId)).toMatchObject({ status: 'reported', terminalOutcome: outcome })
    }
  }, 30_000)

  it('settles the outcome again after a pre-send retry re-enters dispatch', async () => {
    const store = await freshStore()
    const { record } = await store.create({ source: 'workbench', sourceTaskId: null, threadId: null, title: 't', prompt: 'p', now })
    await store.transition(record.workbenchTaskId, 'dispatching')
    await store.transition(record.workbenchTaskId, 'failed')
    expect(store.get(record.workbenchTaskId)?.terminalOutcome).toBe('failed')
    // Retry under the same id: the record leaves its terminal state.
    await store.transition(record.workbenchTaskId, 'dispatching')
    expect(store.get(record.workbenchTaskId)?.terminalOutcome).toBeNull()
    await store.transition(record.workbenchTaskId, 'zcode_acknowledged')
    await store.transition(record.workbenchTaskId, 'running')
    await store.transition(record.workbenchTaskId, 'completed')
    await store.transition(record.workbenchTaskId, 'reported')
    expect(store.get(record.workbenchTaskId)?.terminalOutcome).toBe('completed')
  })

  it('recovers legacy outcomes from the durable status trace on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-legacy-'))
    directories.push(dir)
    const base = {
      v: 1,
      tasks: [{
        workbenchTaskId: 'WB-20260920-001',
        source: 'codex',
        sourceTaskId: 'legacy-1',
        threadId: null,
        title: 'legacy',
        prompt: 'p',
        status: 'reported',
        nodeId: 'n',
        nodeLabel: 'n',
        workspacePath: '/w',
        workspaceLabel: 'w',
        acpSessionId: 's',
        desktopTaskId: null,
        promptSentAt: '2026-09-20T00:00:01.000Z',
        awaitingInput: false,
        echoLost: false,
        lastError: null,
        transcript: [
          { at: '2026-09-20T00:00:00.000Z', kind: 'status', text: 'received', key: null, toolStatus: null },
          { at: '2026-09-20T00:00:01.000Z', kind: 'status', text: 'dispatching', key: null, toolStatus: null },
          { at: '2026-09-20T00:00:02.000Z', kind: 'status', text: 'running', key: null, toolStatus: null },
          { at: '2026-09-20T00:00:03.000Z', kind: 'status', text: 'failed', key: null, toolStatus: null },
          { at: '2026-09-20T00:00:04.000Z', kind: 'status', text: 'reported', key: null, toolStatus: null },
        ],
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:04.000Z',
      }],
    }
    await writeFile(join(dir, 'tasks.json'), `${JSON.stringify(base, null, 2)}\n`, 'utf8')
    const store = new TaskStore(dir, 200)
    await store.load()
    // The pre-field reported record recovers `failed` from its status trace
    // instead of reading as a success — or as an unrecoverable null.
    expect(store.get('WB-20260920-001')?.terminalOutcome).toBe('failed')
  })

  it('leaves unrecoverable legacy outcomes null (result needs verification)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-legacy2-'))
    directories.push(dir)
    const base = {
      v: 1,
      tasks: [{
        workbenchTaskId: 'WB-20260920-002',
        source: 'codex',
        sourceTaskId: 'legacy-2',
        threadId: null,
        title: 'legacy',
        prompt: 'p',
        status: 'reported',
        nodeId: 'n',
        nodeLabel: 'n',
        workspacePath: '/w',
        workspaceLabel: 'w',
        acpSessionId: 's',
        desktopTaskId: null,
        promptSentAt: '2026-09-20T00:00:01.000Z',
        awaitingInput: false,
        echoLost: false,
        lastError: null,
        transcript: [{ at: '2026-09-20T00:00:04.000Z', kind: 'status', text: 'reported', key: null, toolStatus: null }],
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:04.000Z',
      }],
    }
    await writeFile(join(dir, 'tasks.json'), `${JSON.stringify(base, null, 2)}\n`, 'utf8')
    const store = new TaskStore(dir, 200)
    await store.load()
    expect(store.get('WB-20260920-002')?.terminalOutcome).toBeNull()
  })

  it('persists atomically and reloads from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-store-'))
    directories.push(dir)
    const store = new TaskStore(dir, 200)
    await store.load()
    const { record } = await store.create({ source: 'codex', sourceTaskId: 'c1', threadId: 'th', title: 't', prompt: 'p', now })
    await store.update(record.workbenchTaskId, (current) => { current.nodeLabel = 'fixture node' })
    const reopened = new TaskStore(dir, 200)
    await reopened.load()
    const reloaded = reopened.get(record.workbenchTaskId)
    expect(reloaded?.nodeLabel).toBe('fixture node')
    expect(reloaded?.sourceTaskId).toBe('c1')
    // The file on disk is newline-terminated JSON.
    const raw = await readFile(join(dir, 'tasks.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw).v).toBe(1)
  })

  it('marks a dispatched task echo-lost after the owning Host restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-store-'))
    directories.push(dir)
    const store = new TaskStore(dir, 200)
    await store.load()
    const { record } = await store.create({ source: 'codex', sourceTaskId: 'restart-1', threadId: null, title: 't', prompt: 'p', now })
    await store.transition(record.workbenchTaskId, 'dispatching')
    await store.update(record.workbenchTaskId, (current) => {
      current.promptSentAt = now.toISOString()
      current.acpSessionId = 'session-1'
    })
    await store.transition(record.workbenchTaskId, 'zcode_acknowledged')

    const reopened = new TaskStore(dir, 200)
    await reopened.load()
    expect(await reopened.reconcileInterruptedDispatches(new Date('2026-09-21T12:30:00.000Z'))).toBe(1)
    expect(reopened.get(record.workbenchTaskId)).toMatchObject({
      status: 'failed',
      echoLost: true,
      awaitingInput: false,
      updatedAt: '2026-09-21T12:30:00.000Z',
    })
    expect(await reopened.reconcileInterruptedDispatches()).toBe(0)
  })

  it('caps the transcript and evicts only terminal tasks beyond the cap', async () => {
    const store = await freshStore(3)
    const base = { source: 'workbench' as const, sourceTaskId: null, threadId: null, title: 't', prompt: 'p' }
    const first = await store.create({ ...base, now })
    await store.transition(first.record.workbenchTaskId, 'awaiting_route')
    for (let index = 0; index < 4; index += 1) {
      const extra = await store.create({ ...base, now })
      await store.transition(extra.record.workbenchTaskId, 'awaiting_route')
    }
    // Live (awaiting_route) tasks survive even beyond the cap.
    expect(store.list().length).toBeGreaterThanOrEqual(5)
    expect(store.get(first.record.workbenchTaskId)).toBeDefined()

    const dir = await mkdtemp(join(tmpdir(), 'dsh-zcode-cap-'))
    directories.push(dir)
    const capped = new TaskStore(dir, 200, 8)
    await capped.load()
    const { record } = await capped.create({ ...base, now })
    for (let index = 0; index <= 8; index += 1) {
      await capped.update(record.workbenchTaskId, (current) => {
        current.transcript.push({ at: now.toISOString(), kind: 'assistant_message', text: `t${index}`, key: `m${index}`, toolStatus: null })
      })
    }
    expect(capped.get(record.workbenchTaskId)?.transcript.length).toBe(8)
  }, 30_000)
})
