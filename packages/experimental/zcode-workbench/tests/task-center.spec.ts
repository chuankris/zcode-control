import { describe, expect, it } from 'vitest'
import {
  applyTaskCenterFilter, desktopListingMayBeTruncated, mainStatusOfView, mergeWorkspaceTasks, outcomeOf,
  sortItems, type TaskCenterItem,
} from '../src/taskCenter.ts'
import type { WorkbenchTaskStatus, WorkbenchTaskView, WorkspaceTasksView, ZcodeDesktopTaskStatus } from '../src/types.ts'

/** A workbench task view fixture; every field defaults to a settled round. */
function view(fields: Partial<WorkbenchTaskView> = {}): WorkbenchTaskView {
  return {
    workbenchTaskId: 'WB-20260921-001',
    source: 'workbench',
    sourceTaskId: null,
    threadId: null,
    title: 'fixture round',
    promptPreview: 'round prompt preview',
    status: 'completed',
    terminalOutcome: 'completed',
    zcodeDelivery: 'terminal',
    awaitingInput: false,
    echoLost: false,
    lastError: null,
    nodeId: 'node-a',
    nodeLabel: 'Node A',
    workspacePath: '/site/default',
    workspaceLabel: 'default',
    acpSessionId: 'dsh-session-1',
    desktopTaskId: 'dtask-1',
    createdAt: '2026-09-21T01:00:00.000Z',
    updatedAt: '2026-09-21T01:05:00.000Z',
    ...fields,
  }
}

type DesktopRow = {
  taskId: string
  title?: string
  status?: ZcodeDesktopTaskStatus
  updatedAt?: string
  createdAt?: string
  origin?: 'workbench' | 'desktop'
  workbenchTaskId?: string | null
}

function facetOk(rows: DesktopRow[]): WorkspaceTasksView['desktop'] {
  return {
    state: 'ok',
    desktopVersion: '3.14.0',
    tasks: rows.map(row => ({
      taskId: row.taskId,
      title: row.title ?? '',
      status: row.status ?? 'completed',
      createdAt: row.createdAt ?? '2026-09-21T00:00:00.000Z',
      updatedAt: row.updatedAt ?? '2026-09-21T00:30:00.000Z',
      origin: row.origin ?? 'desktop',
      workbenchTaskId: row.workbenchTaskId ?? null,
    })),
  }
}

const SCOPE = { nodeId: 'node-a', workspacePath: '/site/default' }

/** Merge under the default scope. */
function merge(facet: WorkspaceTasksView['desktop'], records: readonly WorkbenchTaskView[]): TaskCenterItem[] {
  return mergeWorkspaceTasks(SCOPE, facet, records)
}

describe('workspace task identity and dedup', () => {
  it('merges a desktop row with the rounds that carry its task id — one row per desktop conversation', () => {
    const items = merge(facetOk([{ taskId: 'dtask-1', workbenchTaskId: null }]), [
      view({ workbenchTaskId: 'WB-1', desktopTaskId: 'dtask-1', createdAt: '2026-09-21T01:00:00.000Z' }),
      view({ workbenchTaskId: 'WB-2', desktopTaskId: 'dtask-1', promptPreview: 'second round', createdAt: '2026-09-21T02:00:00.000Z', updatedAt: '2026-09-21T02:05:00.000Z' }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.desktopTaskId).toBe('dtask-1')
    expect(items[0]!.rounds.map(round => round.workbenchTaskId)).toEqual(['WB-1', 'WB-2'])
    // The item opens the newest round, and its identity is scoped by node+workspace.
    expect(items[0]!.open).toEqual({ kind: 'workbench', workbenchTaskId: 'WB-2' })
    expect(items[0]!.key).toBe('node-a::/site/default::dtask-1')
  })

  it('joins through the adapter binding when the round has no desktop task id of its own', () => {
    const items = merge(facetOk([{ taskId: 'dtask-9', origin: 'workbench', workbenchTaskId: 'WB-1' }]), [
      view({ workbenchTaskId: 'WB-1', desktopTaskId: null, acpSessionId: 'dsh-bound' }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.desktopTaskId).toBe('dtask-9')
    expect(items[0]!.rounds).toHaveLength(1)
  })

  it('never merges by title or short id: same-looking rows stay separate', () => {
    const items = merge(facetOk([
      { taskId: 'dtask-1', title: '报告' },
      { taskId: 'dtask-2', title: '报告' },
    ]), [
      view({ workbenchTaskId: 'WB-1', desktopTaskId: 'dtask-1', title: '报告' }),
    ])
    expect(items).toHaveLength(2)
    expect(items.filter(item => item.rounds.length > 0)).toHaveLength(1)
  })

  it('isolates the same site path on different nodes: identities differ', () => {
    const nodeA = mergeWorkspaceTasks({ nodeId: 'node-a', workspacePath: '/site/default' }, facetOk([{ taskId: 'dtask-1' }]), [view({ desktopTaskId: 'dtask-1' })])
    const nodeB = mergeWorkspaceTasks({ nodeId: 'node-b', workspacePath: '/site/default' }, facetOk([{ taskId: 'dtask-1' }]), [])
    expect(nodeA[0]!.key).toBe('node-a::/site/default::dtask-1')
    expect(nodeB[0]!.key).toBe('node-b::/site/default::dtask-1')
    expect(new Set([nodeA[0]!.key, nodeB[0]!.key]).size).toBe(2)
  })

  it('keeps a record whose desktop task vanished from the index visible and unmergeable', () => {
    const items = merge(facetOk([{ taskId: 'dtask-other' }]), [
      view({ workbenchTaskId: 'WB-1', desktopTaskId: 'dtask-gone' }),
    ])
    expect(items).toHaveLength(2)
    const gone = items.find(item => item.desktopTaskId === 'dtask-gone')!
    expect(gone.rounds).toHaveLength(1)
    expect(gone.continuable).toBe(false)
    expect(gone.notContinuableReason).toBe('not_in_index')
  })

  it('keeps workbench rows when the desktop facet is unavailable, without faking the index', () => {
    const facet: WorkspaceTasksView['desktop'] = { state: 'unavailable', reason: 'the desktop task listing failed' }
    const items = merge(facet, [
      view({ workbenchTaskId: 'WB-1', desktopTaskId: 'dtask-1' }),
      view({ workbenchTaskId: 'WB-2', desktopTaskId: null, nodeId: 'node-a' }),
    ])
    expect(items).toHaveLength(2)
    expect(items.every(item => item.rounds.length === 1)).toBe(true)
    expect(items.every(item => item.continuable)).toBe(false)
    expect(items.every(item => item.notContinuableReason === 'index_unavailable')).toBe(true)
  })

  it('groups index-missed bound rounds of one desktop task into a single row while the index is down', () => {
    const facet: WorkspaceTasksView['desktop'] = { state: 'unavailable', reason: 'offline' }
    const items = merge(facet, [
      view({ workbenchTaskId: 'WB-1', desktopTaskId: 'dtask-shared', createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-21T01:05:00.000Z' }),
      view({ workbenchTaskId: 'WB-unbound', desktopTaskId: null, createdAt: '2026-09-21T00:30:00.000Z' }),
      view({ workbenchTaskId: 'WB-3', desktopTaskId: 'dtask-shared', promptPreview: 'third round', createdAt: '2026-09-21T03:00:00.000Z', updatedAt: '2026-09-21T03:05:00.000Z' }),
      view({ workbenchTaskId: 'WB-2', desktopTaskId: 'dtask-shared', createdAt: '2026-09-21T02:00:00.000Z', updatedAt: '2026-09-21T02:05:00.000Z' }),
    ])
    // One row for the shared desktop conversation, one for the unbound record.
    expect(items).toHaveLength(2)
    const shared = items.find(item => item.desktopTaskId === 'dtask-shared')!
    expect(shared.rounds.map(round => round.workbenchTaskId)).toEqual(['WB-1', 'WB-2', 'WB-3'])
    expect(shared.open).toEqual({ kind: 'workbench', workbenchTaskId: 'WB-3' })
    expect(shared.key).toBe('node-a::/site/default::dtask-shared')
    expect(shared.continuable).toBe(false)
    expect(shared.notContinuableReason).toBe('index_unavailable')
    const unbound = items.find(item => item.desktopTaskId === null)!
    expect(unbound.rounds.map(round => round.workbenchTaskId)).toEqual(['WB-unbound'])
    expect(unbound.key).toBe('node-a::/site/default::wb-WB-unbound')
  })

  it('groups bound rounds the index no longer covers (pinned/archived) the same way', () => {
    const items = merge(facetOk([{ taskId: 'dtask-other' }]), [
      view({ workbenchTaskId: 'WB-1', desktopTaskId: 'dtask-pinned', createdAt: '2026-09-21T01:00:00.000Z' }),
      view({ workbenchTaskId: 'WB-2', desktopTaskId: 'dtask-pinned', createdAt: '2026-09-21T02:00:00.000Z' }),
    ])
    expect(items).toHaveLength(2)
    const pinned = items.find(item => item.desktopTaskId === 'dtask-pinned')!
    expect(pinned.rounds).toHaveLength(2)
    expect(pinned.notContinuableReason).toBe('not_in_index')
  })
})

describe('main status evidence', () => {
  it('maps every reported outcome to the real result, never to a blanket success', () => {
    expect(mainStatusOfView(view({ status: 'reported', terminalOutcome: 'completed' }))).toBe('completed')
    expect(mainStatusOfView(view({ status: 'reported', terminalOutcome: 'failed' }))).toBe('failed')
    expect(mainStatusOfView(view({ status: 'reported', terminalOutcome: 'cancelled' }))).toBe('cancelled')
    expect(mainStatusOfView(view({ status: 'reported', terminalOutcome: null }))).toBe('unknown')
  })

  it('keeps terminal outcomes queryable behind reported', () => {
    expect(outcomeOf(view({ status: 'reported', terminalOutcome: 'failed' }))).toBe('failed')
    expect(outcomeOf(view({ status: 'completed', terminalOutcome: 'completed' }))).toBe('completed')
    expect(outcomeOf(view({ status: 'running', terminalOutcome: null }))).toBeNull()
  })

  it('does not mask a failed newest round with a stale index sample still showing completed', () => {
    // The previous round completed at 00:30; the newest round failed at 02:00
    // while the index sample still shows the old completion.
    const items = merge(facetOk([{ taskId: 'dtask-1', status: 'completed', updatedAt: '2026-09-21T00:30:00.000Z' }]), [
      view({ workbenchTaskId: 'WB-old', desktopTaskId: 'dtask-1', status: 'completed', terminalOutcome: 'completed', updatedAt: '2026-09-21T00:30:00.000Z', createdAt: '2026-09-21T00:00:00.000Z' }),
      view({ workbenchTaskId: 'WB-new', desktopTaskId: 'dtask-1', status: 'failed', terminalOutcome: 'failed', updatedAt: '2026-09-21T02:00:00.000Z', createdAt: '2026-09-21T01:58:00.000Z', lastError: 'boom' }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.mainStatus).toBe('failed')
    // The desktop row stays visible as its own sampled fact.
    expect(items[0]!.desktopStatus).toBe('completed')
    // Continuation is conservatively disabled: the failure is newer than the sample.
    expect(items[0]!.continuable).toBe(false)
    expect(items[0]!.notContinuableReason).toBe('round_unsuccessful')
  })

  it('reopens continuation once a fresher sample reconciles the evidence', () => {
    // The desktop task settled again after the failed round, and the index
    // sample taken afterwards carries the newer timestamp.
    const items = merge(facetOk([{ taskId: 'dtask-1', status: 'completed', updatedAt: '2026-09-21T03:00:00.000Z' }]), [
      view({ workbenchTaskId: 'WB-old', desktopTaskId: 'dtask-1', status: 'completed', terminalOutcome: 'completed', updatedAt: '2026-09-21T00:30:00.000Z', createdAt: '2026-09-21T00:00:00.000Z' }),
      view({ workbenchTaskId: 'WB-new', desktopTaskId: 'dtask-1', status: 'failed', terminalOutcome: 'failed', updatedAt: '2026-09-21T02:00:00.000Z', createdAt: '2026-09-21T01:58:00.000Z' }),
    ])
    expect(items[0]!.mainStatus).toBe('completed')
    expect(items[0]!.continuable).toBe(true)
    expect(items[0]!.notContinuableReason).toBeNull()
  })

  it('keeps a cancelled newest round conservative too', () => {
    const items = merge(facetOk([{ taskId: 'dtask-1', status: 'completed', updatedAt: '2026-09-21T00:30:00.000Z' }]), [
      view({ workbenchTaskId: 'WB-1', desktopTaskId: 'dtask-1', status: 'cancelled', terminalOutcome: 'cancelled', updatedAt: '2026-09-21T01:00:00.000Z' }),
    ])
    expect(items[0]!.notContinuableReason).toBe('round_unsuccessful')
  })

  it('shows running when the desktop row is newer than the settled round (someone resumed the task)', () => {
    const items = merge(facetOk([{ taskId: 'dtask-1', status: 'running', updatedAt: '2026-09-21T03:00:00.000Z' }]), [
      view({ workbenchTaskId: 'WB-1', desktopTaskId: 'dtask-1', status: 'completed', terminalOutcome: 'completed', updatedAt: '2026-09-21T01:05:00.000Z' }),
    ])
    expect(items[0]!.mainStatus).toBe('running')
  })

  it('prefers an in-flight round over the sampled row and maps live statuses', () => {
    for (const status of ['dispatching', 'zcode_acknowledged'] as const) {
      const items = merge(facetOk([{ taskId: 'dtask-1', status: 'completed' }]), [
        view({ workbenchTaskId: 'WB-1', desktopTaskId: 'dtask-1', status, terminalOutcome: null, updatedAt: '2026-09-21T00:10:00.000Z' }),
      ])
      expect(items[0]!.mainStatus).toBe('submitting')
    }
    const running = merge(facetOk([{ taskId: 'dtask-1', status: 'completed', updatedAt: '2026-09-21T00:30:00.000Z' }]), [
      view({ workbenchTaskId: 'WB-1', desktopTaskId: 'dtask-1', status: 'running', terminalOutcome: null, zcodeDelivery: 'running', updatedAt: '2026-09-21T00:40:00.000Z' }),
    ])
    expect(running[0]!.mainStatus).toBe('running')
  })

  it('maps awaiting input and echo lost above every other signal', () => {
    const awaiting = merge(facetOk([{ taskId: 'dtask-1', status: 'completed' }]), [
      view({ desktopTaskId: 'dtask-1', status: 'running', awaitingInput: true }),
    ])
    expect(awaiting[0]!.mainStatus).toBe('needs_input')
    const lost = merge(facetOk([{ taskId: 'dtask-1', status: 'completed' }]), [
      view({ desktopTaskId: 'dtask-1', status: 'zcode_acknowledged', echoLost: true }),
    ])
    expect(lost[0]!.mainStatus).toBe('unknown')
  })

  it('maps native rows through the desktop status vocabulary', () => {
    const items = merge(facetOk([{ taskId: 'dtask-1', status: 'error' }]), [])
    expect(items[0]!.mainStatus).toBe('failed')
    expect(items[0]!.open).toEqual({ kind: 'native', desktopTaskId: 'dtask-1' })
    expect(items[0]!.source).toBe('desktop')
  })
})

describe('continuation evidence', () => {
  it('enables continuation only for index-proven completions without an owning round', () => {
    const items = merge(facetOk([{ taskId: 'dtask-1', status: 'completed' }]), [])
    expect(items[0]!.continuable).toBe(true)
    expect(items[0]!.notContinuableReason).toBeNull()
  })

  it('refuses continuation while a round is in flight or its outcome is unknown', () => {
    for (const [status, reason] of [['dispatching', 'round_in_flight'], ['running', 'round_in_flight']] as const) {
      const items = merge(facetOk([{ taskId: 'dtask-1', status: 'completed' }]), [
        view({ desktopTaskId: 'dtask-1', status, terminalOutcome: null }),
      ])
      expect(items[0]!.notContinuableReason).toBe(reason)
    }
    const lost = merge(facetOk([{ taskId: 'dtask-1', status: 'completed' }]), [
      view({ desktopTaskId: 'dtask-1', status: 'zcode_acknowledged', terminalOutcome: null, echoLost: true }),
    ])
    expect(lost[0]!.notContinuableReason).toBe('echo_lost')
  })

  it('refuses continuation for running, error, and unknown desktop rows with distinct reasons', () => {
    for (const [status, reason] of [['running', 'desktop_running'], ['error', 'desktop_error'], ['unknown', 'desktop_unknown_status']] as const) {
      const items = merge(facetOk([{ taskId: 'dtask-1', status }]), [])
      expect(items[0]!.notContinuableReason).toBe(reason)
    }
  })
})

describe('sorting, filtering, and the index cap', () => {
  const settled = (id: string, updatedAt: string, status: WorkbenchTaskStatus = 'completed'): WorkbenchTaskView =>
    view({ workbenchTaskId: id, desktopTaskId: null, status, terminalOutcome: status === 'completed' ? 'completed' : null, updatedAt, createdAt: updatedAt })

  it('sorts needs-handling and in-flight first, then newest first, stably', () => {
    const items = merge(facetOk([]), [
      settled('WB-old-done', '2026-09-21T01:00:00.000Z'),
      settled('WB-new-done', '2026-09-21T03:00:00.000Z'),
      settled('WB-running', '2026-09-21T00:30:00.000Z', 'running'),
      settled('WB-route', '2026-09-20T23:00:00.000Z', 'awaiting_route'),
    ])
    expect(items.map(item => item.rounds[0]!.workbenchTaskId)).toEqual(['WB-running', 'WB-route', 'WB-new-done', 'WB-old-done'])
    // Equal timestamps keep input order.
    const sameTime = merge(facetOk([]), [settled('WB-a', '2026-09-21T01:00:00.000Z'), settled('WB-b', '2026-09-21T01:00:00.000Z')])
    expect(sameTime.map(item => item.rounds[0]!.workbenchTaskId)).toEqual(['WB-a', 'WB-b'])
    // sortItems is stable by construction on equal rank+time.
    expect(sortItems(sameTime)).toEqual(sameTime)
  })

  it('filters into the all/active/completed/attention buckets', () => {
    const items = merge(facetOk([
      { taskId: 'dtask-run', status: 'running' },
      { taskId: 'dtask-done', status: 'completed' },
    ]), [
      settled('WB-route', '2026-09-20T23:00:00.000Z', 'awaiting_route'),
      view({ workbenchTaskId: 'WB-unknown', desktopTaskId: 'dtask-x', status: 'zcode_acknowledged', terminalOutcome: null, echoLost: true, updatedAt: '2026-09-21T02:00:00.000Z' }),
    ])
    expect(applyTaskCenterFilter(items, 'all')).toHaveLength(4)
    expect(applyTaskCenterFilter(items, 'active').map(item => item.key)).toEqual(['node-a::/site/default::dtask-run'])
    expect(applyTaskCenterFilter(items, 'completed').map(item => item.key)).toEqual(['node-a::/site/default::dtask-done'])
    expect(applyTaskCenterFilter(items, 'attention')).toHaveLength(2)
  })

  it('flags listings at the adapter row cap as possibly truncated', () => {
    expect(desktopListingMayBeTruncated(199)).toBe(false)
    expect(desktopListingMayBeTruncated(200)).toBe(true)
  })
})
