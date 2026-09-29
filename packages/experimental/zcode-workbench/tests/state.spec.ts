import { describe, expect, it } from 'vitest'
import {
  isTerminal, projectTaskView, resultPreviewOf, retryAllowed, routeLocked, transitionAllowed,
  zcodeDeliveryOf, type WorkbenchTaskRecord,
} from '../src/state.ts'

function record(fields: Partial<WorkbenchTaskRecord> = {}): WorkbenchTaskRecord {
  return {
    workbenchTaskId: 'WB-20260921-001',
    source: 'codex',
    sourceTaskId: 'codex-1',
    threadId: 'thread-1',
    title: 'title',
    prompt: 'prompt body',
    status: 'received',
    nodeId: null,
    nodeLabel: null,
    workspacePath: null,
    workspaceLabel: null,
    acpSessionId: null,
    desktopTaskId: null,
    promptSentAt: null,
    awaitingInput: false,
    echoLost: false,
    lastError: null,
    transcript: [],
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...fields,
  }
}

describe('workbench task state machine', () => {
  it('allows the documented forward chain and refuses every shortcut', () => {
    expect(transitionAllowed('received', 'awaiting_route')).toBe(true)
    expect(transitionAllowed('received', 'dispatching')).toBe(true)
    expect(transitionAllowed('awaiting_route', 'dispatching')).toBe(true)
    expect(transitionAllowed('dispatching', 'zcode_acknowledged')).toBe(true)
    expect(transitionAllowed('zcode_acknowledged', 'running')).toBe(true)
    expect(transitionAllowed('running', 'completed')).toBe(true)
    expect(transitionAllowed('running', 'failed')).toBe(true)
    expect(transitionAllowed('running', 'cancelled')).toBe(true)
    expect(transitionAllowed('completed', 'reported')).toBe(true)
    expect(transitionAllowed('failed', 'reported')).toBe(true)
    expect(transitionAllowed('failed', 'dispatching')).toBe(true)
    expect(transitionAllowed('cancelled', 'reported')).toBe(true)

    expect(transitionAllowed('received', 'running')).toBe(false)
    expect(transitionAllowed('awaiting_route', 'zcode_acknowledged')).toBe(false)
    expect(transitionAllowed('dispatching', 'completed')).toBe(false)
    expect(transitionAllowed('reported', 'dispatching')).toBe(false)
    expect(transitionAllowed('completed', 'running')).toBe(false)
    expect(transitionAllowed('cancelled', 'dispatching')).toBe(false)
  })

  it('locks the route at the first dispatched prompt and never earlier', () => {
    expect(routeLocked(record())).toBe(false)
    expect(routeLocked(record({ status: 'awaiting_route', nodeId: 'node', workspacePath: '/w' }))).toBe(false)
    expect(routeLocked(record({ status: 'zcode_acknowledged', promptSentAt: '2026-09-21T00:00:01.000Z' }))).toBe(true)
    expect(routeLocked(record({ status: 'reported', promptSentAt: '2026-09-21T00:00:01.000Z' }))).toBe(true)
  })

  it('allows retry only for failures that never sent a prompt', () => {
    expect(retryAllowed(record({ status: 'failed' }))).toBe(true)
    expect(retryAllowed(record({ status: 'failed', promptSentAt: '2026-09-21T00:00:01.000Z' }))).toBe(false)
    expect(retryAllowed(record({ status: 'awaiting_route' }))).toBe(false)
    expect(retryAllowed(record({ status: 'completed', promptSentAt: '2026-09-21T00:00:01.000Z' }))).toBe(false)
  })

  it('derives the Zcode delivery facet from the chain, separately from failure', () => {
    expect(zcodeDeliveryOf(record())).toBe('pending')
    expect(zcodeDeliveryOf(record({ status: 'awaiting_route' }))).toBe('pending')
    const sent = { promptSentAt: '2026-09-21T00:00:01.000Z' as const }
    expect(zcodeDeliveryOf(record({ status: 'zcode_acknowledged', ...sent }))).toBe('acknowledged')
    expect(zcodeDeliveryOf(record({ status: 'running', ...sent }))).toBe('running')
    expect(zcodeDeliveryOf(record({ status: 'completed', ...sent }))).toBe('terminal')
    expect(zcodeDeliveryOf(record({ status: 'reported', ...sent }))).toBe('terminal')
    expect(zcodeDeliveryOf(record({ status: 'failed', ...sent }))).toBe('terminal')
    expect(zcodeDeliveryOf(record({ status: 'running', echoLost: true, ...sent }))).toBe('echo_lost')
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('running')).toBe(false)
  })

  it('projects the wire view with a bounded prompt preview', () => {
    const view = projectTaskView(record({ prompt: 'x'.repeat(500), title: 't' }))
    expect(view.promptPreview.length).toBe(160)
    expect(view.workbenchTaskId).toBe('WB-20260921-001')
    expect(view).not.toHaveProperty('prompt')
    expect(view).not.toHaveProperty('transcript')
  })

  it('reports the tail of the last assistant message', () => {
    const withAnswer = record({
      promptSentAt: '2026-09-21T00:00:01.000Z',
      transcript: [
        { at: '2026-09-21T00:00:01.000Z', kind: 'status', text: 'running', key: null, toolStatus: null },
        { at: '2026-09-21T00:00:02.000Z', kind: 'assistant_message', text: 'ignored earlier answer', key: 'm1', toolStatus: null },
        { at: '2026-09-21T00:00:03.000Z', kind: 'tool_call', text: 'Read', key: 't1', toolStatus: 'success' },
        { at: '2026-09-21T00:00:04.000Z', kind: 'assistant_message', text: 'final answer', key: 'm2', toolStatus: null },
      ],
    })
    expect(resultPreviewOf(withAnswer)).toBe('final answer')
    expect(resultPreviewOf(record())).toBe(null)
  })
})
