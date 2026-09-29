import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
