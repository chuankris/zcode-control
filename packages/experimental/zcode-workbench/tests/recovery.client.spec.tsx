// @vitest-environment jsdom
// Host-restart recovery: the surfaces must survive a temporarily-unreachable
// Host, keep polling, and rehydrate by themselves once the connection is
// re-established — no manual refresh, and a render failure may never unmount
// the surrounding page.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NodeSettings, TaskCenterPanel, notifyWorkbenchRefresh, readWorkbenchPanelOpenIntent,
  subscribeWorkbenchRefresh, type WorkbenchActions, type WorkbenchConnection,
  type WorkbenchConnectionSnapshot, type WorkbenchPanelProps, type NodeSettingsProps,
} from '../src/client/Panel.tsx'
import { zh, type WorkbenchKey } from '../src/client/locales.ts'
import type { WorkbenchNodeInput, WorkbenchTaskView, ZcodeNodeView, ZcodeWorkspaceListing } from '../src/types.ts'

afterEach(cleanup)

/** Locale stub: the real Chinese dictionary with {param} substitution. */
function translateStub(key: WorkbenchKey | string, params?: Record<string, unknown>): string {
  const entry = zh[key as WorkbenchKey]
  let text: string = entry ?? String(key)
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

function fixtureNodes(): ZcodeNodeView[] {
  const base = {
    siteLabel: 'test',
    command: 'node',
    args: ['adapter.mjs'],
    workspaceSelection: 'session' as const,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
  }
  return [
    { ...base, id: 'local-1', kind: 'local', label: '本机 Zcode', health: { state: 'online', checkedAt: '2026-09-21T01:00:00.000Z', desktopVersion: '3.14.0', workspaceCount: 1, detail: null } },
  ]
}

function fixtureListing(): ZcodeWorkspaceListing {
  return { options: [{ path: '/site/default', label: 'default' }], desktopVersion: '3.14.0' }
}

/** A minimal wire-shaped task view for spy return values. */
function viewOf(id: string): WorkbenchTaskView {
  return {
    workbenchTaskId: id, source: 'workbench', sourceTaskId: null, threadId: null, title: 't',
    promptPreview: 'p', status: 'dispatching', zcodeDelivery: 'pending', awaitingInput: false,
    echoLost: false, lastError: null, nodeId: 'local-1', nodeLabel: 'n', workspacePath: '/w',
    workspaceLabel: 'w', acpSessionId: null, desktopTaskId: null, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
  }
}

/** Build panel props with the given action overrides; runtime seats stay absent. */
function panelProps(overrides: Partial<WorkbenchActions> = {}): WorkbenchPanelProps {
  const actions: WorkbenchActions = {
    nodes: async () => fixtureNodes(),
    saveNode: async (_input: WorkbenchNodeInput) => { throw new Error('unused') },
    removeNode: async () => false,
    checkNode: async (_id: string) => { throw new Error('unused') },
    listWorkspaces: async () => fixtureListing(),
    workspaceTasks: async () => ({
      nodeId: 'local-1', workspacePath: '/site/default',
      desktop: { state: 'ok', desktopVersion: '3.14.0', tasks: [] },
      workbench: [],
    }),
    tasks: async () => [],
    task: async () => undefined,
    composeTask: async () => { throw new Error('unused') },
    continueDesktopTask: async () => { throw new Error('unused') },
    routeTask: async () => { throw new Error('unused') },
    retryTask: async () => { throw new Error('unused') },
    cancelTask: async () => { throw new Error('unused') },
    ingressInfo: async () => ({ path: '/zcode-workbench/ingress', provisioned: true }),
    ...overrides,
  }
  return { t: translateStub, ...actions } as unknown as WorkbenchPanelProps
}

/** Manually-driven connection source standing in for the injected carrier state. */
function connectionStub(initial: WorkbenchConnectionSnapshot): {
  source: WorkbenchConnection
  set(next: WorkbenchConnectionSnapshot): void
} {
  const listeners = new Set<() => void>()
  let snapshot = initial
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('host restart recovery', () => {
  it('keeps the task center alive through a Host outage and rehydrates on reconnect', async () => {
    const views = [viewOf('WB-20260921-020')]
    let reachable = false
    const tasks = vi.fn((): Promise<WorkbenchTaskView[]> => reachable
      ? Promise.resolve(views)
      : Promise.reject(new Error('transport failure for /api/zcodeWorkbench/tasks: HTTP -1')))
    const connection = connectionStub('disconnected')
    render(<TaskCenterPanel
      {...panelProps({ tasks: tasks as unknown as WorkbenchActions['tasks'] })}
      connection={connection.source}
    />)

    // Outage: the reconnect status line speaks for the carrier; raw transport
    // errors are not stacked over the empty list.
    expect(await screen.findByText('工作台服务暂不可用，正在自动重连…')).toBeDefined()

    // Host back: the reconnect notification drives an immediate re-pull.
    reachable = true
    connection.set('connected')
    notifyWorkbenchRefresh()
    expect(await screen.findByText('t')).toBeDefined()
    expect(screen.queryByText(/transport failure/)).toBeNull()
  })

  it('contains a surface render failure instead of unmounting the page, and retries', async () => {
    let poisoned = true
    const translate = (key: WorkbenchKey | string, params?: Record<string, unknown>): string => {
      if (poisoned && key === 'status_dispatching') throw new Error('render boom')
      return translateStub(key, params)
    }
    const props = {
      ...panelProps({ tasks: async () => [viewOf('WB-20260921-021')] }),
      t: translate,
    } as unknown as WorkbenchPanelProps
    render(<div>
      <span>page-root-sentinel</span>
      <TaskCenterPanel {...props} />
    </div>)

    expect(await screen.findByText('工作台界面渲染出错。')).toBeDefined()
    // The surrounding page survives the contained failure.
    expect(screen.getByText('page-root-sentinel')).toBeDefined()

    poisoned = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('t')).toBeDefined()
    expect(screen.getByText('page-root-sentinel')).toBeDefined()
  })

  it('re-fetches immediately when the plugin notifies a reconnect', async () => {
    const tasks = vi.fn(async () => [] as WorkbenchTaskView[])
    render(<TaskCenterPanel {...panelProps({ tasks })} />)
    await waitFor(() => { expect(tasks.mock.calls.length).toBeGreaterThanOrEqual(1) })
    const before = tasks.mock.calls.length
    notifyWorkbenchRefresh()
    await waitFor(() => { expect(tasks.mock.calls.length).toBeGreaterThan(before) })
  })

  it('isolates a throwing refresh listener from the other listeners', () => {
    const second = vi.fn()
    const disposeFirst = subscribeWorkbenchRefresh(() => { throw new Error('listener boom') })
    const disposeSecond = subscribeWorkbenchRefresh(second)
    try {
      expect(() => { notifyWorkbenchRefresh() }).not.toThrow()
      expect(second).toHaveBeenCalledOnce()
    } finally {
      disposeFirst()
      disposeSecond()
    }
  })

  it('drops the panel-open intent on a healthy unmount but keeps it through restart churn', async () => {
    const healthy = connectionStub('connected')
    const first = render(<TaskCenterPanel {...panelProps()} connection={healthy.source} />)
    await waitFor(() => { expect(readWorkbenchPanelOpenIntent()).toBe(true) })
    first.unmount()
    expect(readWorkbenchPanelOpenIntent()).toBe(false)

    const down = connectionStub('disconnected')
    const second = render(<TaskCenterPanel {...panelProps()} connection={down.source} />)
    await waitFor(() => { expect(readWorkbenchPanelOpenIntent()).toBe(true) })
    second.unmount()
    expect(readWorkbenchPanelOpenIntent()).toBe(true)
  })

  it('shows the reconnect status in node settings and clears it after recovery', async () => {
    let reachable = false
    const nodes = vi.fn((): Promise<ZcodeNodeView[]> => reachable
      ? Promise.resolve(fixtureNodes())
      : Promise.reject(new Error('transport failure for /api/zcodeWorkbench/nodes: HTTP -1')))
    const connection = connectionStub('disconnected')
    const props = {
      ...panelProps({ nodes: nodes as unknown as WorkbenchActions['nodes'] }),
      connection: connection.source,
    } as unknown as NodeSettingsProps
    render(<NodeSettings {...props} />)

    expect(await screen.findByText('工作台服务暂不可用，正在自动重连…')).toBeDefined()
    expect(screen.queryByText(/transport failure/)).toBeNull()

    reachable = true
    connection.set('connected')
    notifyWorkbenchRefresh()
    expect(await screen.findByText('本机 Zcode')).toBeDefined()
    expect(screen.queryByText('工作台服务暂不可用，正在自动重连…')).toBeNull()
  })
})
