// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeSettings, TaskCenterPanel, notifyWorkbenchRefresh, type WorkbenchActions, type WorkbenchPanelProps, type NodeSettingsProps } from '../src/client/Panel.tsx'
import { zh, type WorkbenchKey } from '../src/client/locales.ts'
import type { WorkbenchComposeRequest, WorkbenchNodeInput, WorkbenchTaskDetailView, WorkbenchTaskView, WorkspaceTasksView, ZcodeDesktopTaskSnapshotResult, ZcodeNodeView, ZcodeWorkspaceListing } from '../src/types.ts'

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
    args: ['adapter.mjs', '--config', 'C:\\private\\adapter.json'],
    workspaceSelection: 'session' as const,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
  }
  return [
    { ...base, id: 'local-1', kind: 'local', label: '本机 Zcode', health: { state: 'online', checkedAt: '2026-09-21T01:00:00.000Z', desktopVersion: '3.14.0', workspaceCount: 4, detail: null } },
    { ...base, id: 'site-1', kind: 'remote', label: '现场节点', health: { state: 'offline', checkedAt: '2026-09-21T01:00:00.000Z', desktopVersion: null, workspaceCount: null, detail: 'offline' } },
  ]
}

function fixtureListing(): ZcodeWorkspaceListing {
  return {
    options: [
      { path: '/site/default', label: 'default' },
      { path: '/site/progo', label: 'deephik-progo' },
    ],
    desktopVersion: '3.14.0',
  }
}

/** A workspace listing with one desktop-only row and one joined workbench round. */
function fixtureWorkspaceTasks(): WorkspaceTasksView {
  return {
    nodeId: 'site-1',
    workspacePath: '/site/default',
    desktop: {
      state: 'ok',
      desktopVersion: '3.14.0',
      tasks: [
        {
          taskId: 'sess-11112222333344445555', title: '桌面创建的任务', status: 'running',
          createdAt: '2026-09-21T02:00:00.000Z', updatedAt: '2026-09-21T02:10:00.000Z',
          origin: 'desktop', workbenchTaskId: null,
        },
        {
          taskId: 'dtask-wb-1', title: '工作台派发的任务', status: 'completed',
          createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-21T01:05:00.000Z',
          origin: 'workbench', workbenchTaskId: 'WB-20260921-001',
        },
      ],
    },
    workbench: [viewOf('WB-20260921-001', { status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', desktopTaskId: null, acpSessionId: 'fake-acp-session-1' })],
  }
}

/** One desktop task joined to two workbench rounds, for the round-chain tests. */
function twoRoundWorkspaceTasks(): WorkspaceTasksView {
  const listing = fixtureWorkspaceTasks()
  if (listing.desktop.state === 'ok') {
    listing.workbench = [
      viewOf('WB-round-1', { status: 'failed', terminalOutcome: 'failed', zcodeDelivery: 'terminal', desktopTaskId: 'dtask-wb-1', title: '第一轮', createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-21T01:05:00.000Z' }),
      viewOf('WB-round-2', { status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', desktopTaskId: 'dtask-wb-1', title: '第二轮', createdAt: '2026-09-21T02:00:00.000Z', updatedAt: '2026-09-21T02:05:00.000Z' }),
    ]
    listing.desktop.tasks[1]!.workbenchTaskId = 'WB-round-2'
  }
  return listing
}

/** A distinct listing for the progo workspace (cross-workspace race tests). */
function progoWorkspaceTasks(): WorkspaceTasksView {
  return {
    nodeId: 'site-1',
    workspacePath: '/site/progo',
    desktop: {
      state: 'ok',
      desktopVersion: '3.14.0',
      tasks: [{
        taskId: 'dtask-progo-1', title: 'progo 任务', status: 'completed',
        createdAt: '2026-09-21T03:00:00.000Z', updatedAt: '2026-09-21T03:30:00.000Z',
        origin: 'desktop', workbenchTaskId: null,
      }],
    },
    workbench: [],
  }
}

/** Two independent desktop tasks (A with two rounds, B with one) for switch-isolation tests. */
function twoTaskWorkspaceTasks(): WorkspaceTasksView {
  return {
    nodeId: 'site-1',
    workspacePath: '/site/default',
    desktop: {
      state: 'ok',
      desktopVersion: '3.14.0',
      tasks: [
        {
          taskId: 'dtask-a', title: 'A 任务', status: 'completed',
          createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-21T02:05:00.000Z',
          origin: 'workbench', workbenchTaskId: 'WB-A2',
        },
        {
          taskId: 'dtask-b', title: 'B 任务', status: 'completed',
          createdAt: '2026-09-21T03:00:00.000Z', updatedAt: '2026-09-21T03:05:00.000Z',
          origin: 'workbench', workbenchTaskId: 'WB-B1',
        },
      ],
    },
    workbench: [
      viewOf('WB-A1', { desktopTaskId: 'dtask-a', title: 'A 第一轮', status: 'failed', terminalOutcome: 'failed', zcodeDelivery: 'terminal', createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-21T01:05:00.000Z' }),
      viewOf('WB-A2', { desktopTaskId: 'dtask-a', title: 'A 第二轮', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', createdAt: '2026-09-21T02:00:00.000Z', updatedAt: '2026-09-21T02:05:00.000Z' }),
      viewOf('WB-B1', { desktopTaskId: 'dtask-b', title: 'B 记录', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', createdAt: '2026-09-21T03:00:00.000Z', updatedAt: '2026-09-21T03:05:00.000Z' }),
    ],
  }
}

/** Force the wide three-column layout so workspaces can switch directly. */
function stubWideViewport(): () => void {
  const media = {
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  } as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', () => media)
  return () => { vi.unstubAllGlobals() }
}

/** A minimal wire-shaped task view for spy return values. */
function viewOf(id: string, over: Partial<WorkbenchTaskView> = {}): WorkbenchTaskView {
  return {
    workbenchTaskId: id, source: 'workbench', sourceTaskId: null, threadId: null, title: 't',
    promptPreview: 'p', status: 'dispatching', terminalOutcome: null, zcodeDelivery: 'pending', awaitingInput: false,
    echoLost: false, lastError: null, nodeId: 'site-1', nodeLabel: '现场节点', workspacePath: '/site/default',
    workspaceLabel: 'default', acpSessionId: null, desktopTaskId: null, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
    ...over,
  }
}

/** A workbench task detail fixture. */
function detailOf(id: string, over: Partial<WorkbenchTaskDetailView> = {}): WorkbenchTaskDetailView {
  return {
    ...viewOf(id, over),
    prompt: 'full prompt body',
    transcript: [],
    retryAllowed: false,
    ...over,
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
    workspaceTasks: async () => fixtureWorkspaceTasks(),
    desktopTaskSnapshot: async () => ({ state: 'unavailable', reason: 'not read in this test' }),
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

/** Expand one node's workspaces on the home column. */
async function expandNode(label: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(label) }))
}

/** Expand site-1 and open its default workspace, landing on the unified list. */
async function openDefaultWorkspace(): Promise<void> {
  await expandNode('现场节点')
  const workspaceButton = await screen.findByRole('button', { name: /^default/ })
  fireEvent.click(workspaceButton)
  await screen.findByRole('region', { name: '任务列表' })
}

describe('delivery wording distinguishes submitted from remote-confirmed', () => {
  it('keeps the dictionaries honest: nothing claims 已送达 before the remote confirms', async () => {
    const { en, zh } = await import('../src/client/locales.ts')
    expect(zh.status_zcode_acknowledged).not.toContain('已送达')
    expect(zh.delivery_acknowledged).toContain('确认中')
    expect(zh.delivery_acknowledged).not.toBe('已送达')
    expect(zh.delivery_acknowledged).not.toContain('已送达')
    expect(zh.delivery_running).toContain('已送达')
    expect(zh.delivery_echo_lost).toContain('核实')
    expect(zh.echoLost).toContain('结果未知')
    expect(en.delivery_acknowledged).toContain('Submitted')
    expect(en.delivery_acknowledged).not.toContain('Delivered')
    expect(en.delivery_running).toContain('Delivered')
    expect(en.delivery_echo_lost.toLowerCase()).toContain('verify')
  })

  it('keeps every locale key the sidebar/settings bindings reference present in both dictionaries', async () => {
    // Regression: the sidebar binds 'taskCenter' from client/index.ts; a
    // dictionary rewrite once dropped it and only the standalone typecheck
    // noticed. Guard every bound key against both dictionaries.
    const { en, zh } = await import('../src/client/locales.ts')
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'client', 'index.ts'), 'utf8')
    const bound = [...source.matchAll(/bind\('zcode\.workbench'\)\('([A-Za-z0-9_]+)'\)/g)].map(match => match[1]!)
    expect(bound.length).toBeGreaterThan(0)
    for (const key of bound) {
      expect(key in en, `en dictionary is missing the bound key ${key}`).toBe(true)
      expect(key in zh, `zh dictionary is missing the bound key ${key}`).toBe(true)
    }
    expect(en.taskCenter).toBe('Task center')
    expect(zh.taskCenter).toBe('任务中心')
  })

  it('shows the submitted-vs-delivered distinction in run details, never a bare 已送达', async () => {
    render(<TaskCenterPanel {...panelProps({
      workspaceTasks: async () => fixtureWorkspaceTasks(),
      task: async (id: string) => detailOf(id, {
        title: '送达措辞任务', status: 'reported', terminalOutcome: 'completed', zcodeDelivery: 'terminal', desktopTaskId: 'dtask-wb-1',
      }),
    })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /工作台派发的任务/ }))
    expect(await screen.findByText('送达措辞任务')).toBeDefined()
    // Run details carry the delivery facet wording (terminal here).
    expect(screen.getByText('已结束')).toBeDefined()
    expect(screen.queryByText('已送达')).toBeNull()
  })
})

describe('workspace-first home', () => {
  it('lists nodes with health, expands one node, and discovers only that node\'s workspaces', async () => {
    const listWorkspaces = vi.fn(async (nodeId: string) => nodeId === 'site-1'
      ? fixtureListing()
      : { options: [{ path: '/local/one', label: 'one' }], desktopVersion: null }) as unknown as WorkbenchActions['listWorkspaces']
    render(<TaskCenterPanel {...panelProps({ listWorkspaces })} />)
    expect(await screen.findByText('现场节点')).toBeDefined()
    expect(screen.getByText('离线')).toBeDefined()
    // No discovery before a node is viewed.
    expect(listWorkspaces).not.toHaveBeenCalled()
    await expandNode('现场节点')
    expect(await screen.findByRole('button', { name: /^default/ })).toBeDefined()
    expect(listWorkspaces).toHaveBeenCalledTimes(1)
    expect(listWorkspaces).toHaveBeenCalledWith('site-1')
  })

  it('keeps the phone header usable: the CTA never squeezes into vertical text (style contract)', async () => {
    // jsdom has no layout engine, so the narrow-viewport guarantee is locked
    // as a stylesheet contract: the header wraps instead of squeezing, the
    // CTA never shrinks below its label, and below 480px it takes a full row
    // with its >=44px touch target — while the wide three-column layout and
    // the state machine stay untouched (covered by the suites above).
    const cssSource = await readFile(join(import.meta.dirname, '..', 'src', 'client', 'style.module.css'), 'utf8')
    const pageHead = /\.pageHead\s*\{[^}]*\}/.exec(cssSource)?.[0] ?? ''
    expect(pageHead).toContain('flex-wrap: wrap')
    const headerCta = /\.pageHead \.primary\s*\{[^}]*\}/.exec(cssSource)?.[0] ?? ''
    expect(headerCta).toContain('flex-shrink: 0')
    expect(headerCta).toContain('white-space: nowrap')
    const narrow = /@media \(max-width: 480px\)\s*\{[\s\S]*?\n\}/.exec(cssSource)?.[0] ?? ''
    expect(narrow).toContain('.pageHead .primary')
    expect(narrow).toContain('flex: 1 1 100%')
    // The home workspace card follows the same discipline: the entry wraps
    // instead of squeezing its CTA into vertical text; the CTA never shrinks
    // below its label; below 480px summary button and CTA each take a full
    // row (>=44px touch, workspace label and meta fully visible).
    const workspaceEntry = /\.workspaceEntry\s*\{[^}]*\}/.exec(cssSource)?.[0] ?? ''
    expect(workspaceEntry).toContain('flex-wrap: wrap')
    const entryCta = /\.workspaceEntry \.secondary\s*\{[^}]*\}/.exec(cssSource)?.[0] ?? ''
    expect(entryCta).toContain('flex-shrink: 0')
    expect(entryCta).toContain('white-space: nowrap')
    expect(narrow).toContain('.workspaceEntry .workspaceButton')
    expect(narrow).toContain('.workspaceEntry .secondary')
    expect((narrow.match(/flex: 1 1 100%/g) ?? []).length).toBeGreaterThanOrEqual(4)
    const secondary = /\n\.secondary\s*\{[^}]*\}/.exec(cssSource)?.[0] ?? ''
    expect(secondary).toContain('min-height: 44px')
    const primary = /\n\.primary\s*\{[^}]*\}/.exec(cssSource)?.[0] ?? ''
    expect(primary).toContain('min-height: 44px')
    // Grid children keep min-width: 0 so long labels wrap instead of
    // overflowing the page horizontally.
    expect(cssSource).toMatch(/\.columnsWide > \*,\s*\.columnsNarrow > \*\s*\{[^}]*min-width: 0/)
    // And the DOM shape the styles apply to: the CTA lives in the page header
    // beside the panel title, reachable by name on the narrow default viewport.
    render(<TaskCenterPanel {...panelProps()} />)
    const cta = screen.getByRole('button', { name: '新建任务' })
    const header = cta.closest('header')
    expect(header).not.toBeNull()
    expect(header!.textContent).toContain('Zcode 工作台')
  })

  it('shows unrouted tasks on the home strip and routes them through the gated form', async () => {
    const routeTask = vi.fn(async () => viewOf('WB-20260921-009', {
      nodeId: 'site-1', nodeLabel: '现场节点', workspacePath: '/site/default', workspaceLabel: 'default',
    })) as NonNullable<WorkbenchActions['routeTask']>
    const workspaceTasks = vi.fn(async () => fixtureWorkspaceTasks()) as NonNullable<WorkbenchActions['workspaceTasks']>
    const props = panelProps({
      routeTask,
      workspaceTasks,
      tasks: async () => [{
        workbenchTaskId: 'WB-20260921-009', source: 'codex', sourceTaskId: 'c1', threadId: 't1',
        title: 'Codex 任务', promptPreview: 'p', status: 'awaiting_route', terminalOutcome: null, zcodeDelivery: 'pending',
        awaitingInput: false, echoLost: false, lastError: null, nodeId: null, nodeLabel: null,
        workspacePath: null, workspaceLabel: null, acpSessionId: null, desktopTaskId: null,
        createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
      }],
      task: async (id: string) => detailOf(id, {
        source: 'codex', status: 'awaiting_route', title: 'Codex 任务', nodeId: null, nodeLabel: null,
        workspacePath: null, workspaceLabel: null, prompt: 'full prompt body',
      }),
    })
    render(<TaskCenterPanel {...props} />)
    // The strip opens the routing form on the narrow main level, not on the home.
    fireEvent.click(await screen.findByRole('button', { name: '选择位置' }))
    const selects = await screen.findAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'site-1' } })
    await waitFor(() => { expect(selects[1]!.querySelector('option[value="/site/default"]')).not.toBeNull() })
    fireEvent.change(selects[1]!, { target: { value: '/site/default' } })
    // The original task's prompt renders read-only; no editable 任务描述 exists.
    expect(await screen.findByText('full prompt body')).toBeDefined()
    expect(screen.queryByRole('textbox', { name: '任务描述' })).toBeNull()
    expect(screen.getByText('原任务自带任务描述，此处只选择执行位置，描述不可编辑。')).toBeDefined()
    const send = screen.getByRole('button', { name: '发送任务' })
    await waitFor(() => { expect((send as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(send)
    await waitFor(() => { expect(routeTask).toHaveBeenCalledWith({ workbenchTaskId: 'WB-20260921-009', nodeId: 'site-1', workspacePath: '/site/default' }) })
    // The dispatched record selects its workspace, so its detail opens with list context.
    expect(await screen.findByText('Codex 任务')).toBeDefined()
    await waitFor(() => { expect(workspaceTasks).toHaveBeenCalled() })
  })

  it('keeps the routing send disabled until the original task has loaded, never composing a second task', async () => {
    const composeTask = vi.fn(async () => viewOf('WB-wrong')) as NonNullable<WorkbenchActions['composeTask']>
    const routeTask = vi.fn(async () => viewOf('WB-20260921-009')) as NonNullable<WorkbenchActions['routeTask']>
    let releaseOriginal: ((value: WorkbenchTaskDetailView | undefined) => void) | undefined
    render(<TaskCenterPanel {...panelProps({
      composeTask,
      routeTask,
      tasks: async () => [viewOf('WB-20260921-009', { source: 'codex', status: 'awaiting_route', nodeId: null, workspacePath: null })],
      task: async (id: string) => new Promise<WorkbenchTaskDetailView | undefined>(resolve => {
        if (id !== 'WB-20260921-009') { resolve(detailOf(id)); return }
        releaseOriginal = resolve
      }),
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: '选择位置' }))
    const selects = await screen.findAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'site-1' } })
    await waitFor(() => { expect(selects[1]!.querySelector('option[value="/site/default"]')).not.toBeNull() })
    fireEvent.change(selects[1]!, { target: { value: '/site/default' } })
    // While the original is still loading, the send stays disabled with the loading note.
    await waitFor(() => { expect(screen.getAllByText('正在读取原任务，完成后才能选择位置发送…').length).toBeGreaterThan(0) })
    expect((screen.getByRole('button', { name: '发送任务' }) as HTMLButtonElement).disabled).toBe(true)
    releaseOriginal?.(detailOf('WB-20260921-009', { source: 'codex', status: 'awaiting_route', nodeId: null, workspacePath: null }))
    await waitFor(() => { expect((screen.getByRole('button', { name: '发送任务' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '发送任务' }))
    await waitFor(() => { expect(routeTask).toHaveBeenCalledTimes(1) })
    expect(composeTask).not.toHaveBeenCalled()
  })

  it('completes a slow workspace discovery across a home remount', async () => {
    // Regression: the discovery used to gate its result write on the effect's
    // lifetime, so an unmount mid-request dropped the listing while the
    // parent cache stayed "loading" and a remount never re-requested.
    let releaseListing: ((value: ZcodeWorkspaceListing) => void) | undefined
    const listWorkspaces = vi.fn((): Promise<ZcodeWorkspaceListing> =>
      new Promise(resolve => { releaseListing = resolve }))
    const unrouted: WorkbenchTaskView = {
      workbenchTaskId: 'WB-unrouted', source: 'codex', sourceTaskId: 'c1', threadId: null,
      title: '未路由任务', promptPreview: 'p', status: 'awaiting_route', terminalOutcome: null,
      zcodeDelivery: 'pending', awaitingInput: false, echoLost: false, lastError: null,
      nodeId: null, nodeLabel: null, workspacePath: null, workspaceLabel: null, acpSessionId: null,
      desktopTaskId: null, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
    }
    render(<TaskCenterPanel {...panelProps({
      listWorkspaces: listWorkspaces as unknown as WorkbenchActions['listWorkspaces'],
      tasks: async () => [unrouted],
    })} />)
    await expandNode('现场节点')
    await waitFor(() => { expect(listWorkspaces).toHaveBeenCalledTimes(1) })
    expect(screen.getByText('正在读取工作区…')).toBeDefined()
    // Leave the home (the unrouted task's routing form owns the narrow main
    // level) — the home column unmounts with the discovery still in flight.
    fireEvent.click(await screen.findByRole('button', { name: '选择位置' }))
    expect((await screen.findAllByRole('combobox')).length).toBe(2)
    // Back: the home remounts over the parent's loading cache — no re-request.
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await screen.findByText('正在读取工作区…')
    expect(listWorkspaces).toHaveBeenCalledTimes(1)
    // The slow result lands and paints the workspaces; still exactly one call.
    act(() => { releaseListing?.(fixtureListing()) })
    expect(await screen.findByRole('button', { name: /^default/ })).toBeDefined()
    expect(listWorkspaces).toHaveBeenCalledTimes(1)
  })

  it('completes a slow workspace discovery across a reconnect-driven node reload', async () => {
    let releaseListing: ((value: ZcodeWorkspaceListing) => void) | undefined
    const listWorkspaces = vi.fn((): Promise<ZcodeWorkspaceListing> =>
      new Promise(resolve => { releaseListing = resolve }))
    render(<TaskCenterPanel {...panelProps({
      listWorkspaces: listWorkspaces as unknown as WorkbenchActions['listWorkspaces'],
    })} />)
    await expandNode('现场节点')
    await waitFor(() => { expect(listWorkspaces).toHaveBeenCalledTimes(1) })
    // A reconnect re-reads the nodes (fresh identities) and re-runs the
    // discovery effect; the in-flight request must not be torn down.
    notifyWorkbenchRefresh()
    expect(screen.getByText('正在读取工作区…')).toBeDefined()
    act(() => { releaseListing?.(fixtureListing()) })
    expect(await screen.findByRole('button', { name: /^default/ })).toBeDefined()
    expect(listWorkspaces).toHaveBeenCalledTimes(1)
  })

  it('retries a rejecting workspace discovery a bounded number of times', async () => {
    let failures = 0
    const listWorkspaces = vi.fn(async (): Promise<ZcodeWorkspaceListing> => {
      failures += 1
      if (failures <= 2) throw new Error('transient discovery failure')
      return fixtureListing()
    })
    render(<TaskCenterPanel {...panelProps({
      listWorkspaces: listWorkspaces as unknown as WorkbenchActions['listWorkspaces'],
    })} />)
    await expandNode('现场节点')
    // Two rejections, then the third attempt delivers the workspaces.
    expect(await screen.findByRole('button', { name: /^default/ })).toBeDefined()
    expect(listWorkspaces).toHaveBeenCalledTimes(3)
  })

  it('counts workbench sessions by verified desktop conversation, not audit rounds', async () => {
    // Two rounds share one verified desktopTaskId (one conversation), one
    // round is unbound (its own row), and other-workspace / other-node
    // records must not leak into this card. Last activity spans all rounds.
    const tasks: WorkbenchTaskView[] = [
      viewOf('WB-a1', { desktopTaskId: 'dtask-shared', title: '第一轮', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-21T01:05:00.000Z' }),
      viewOf('WB-a2', { desktopTaskId: 'dtask-shared', title: '第二轮', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', createdAt: '2026-09-21T02:00:00.000Z', updatedAt: '2026-09-21T02:05:00.000Z' }),
      viewOf('WB-free', { desktopTaskId: null, title: '未绑定轮', createdAt: '2026-09-21T03:00:00.000Z', updatedAt: '2026-09-21T03:00:00.000Z' }),
      // Other workspace (same node) and other node: never counted here.
      viewOf('WB-other-ws', { desktopTaskId: 'dtask-other-ws', nodeId: 'site-1', workspacePath: '/site/progo', createdAt: '2026-09-21T04:00:00.000Z', updatedAt: '2026-09-21T04:00:00.000Z' }),
      viewOf('WB-other-node', { desktopTaskId: null, nodeId: 'local-1', nodeLabel: '本机 Zcode', workspacePath: '/site/default', createdAt: '2026-09-21T05:00:00.000Z', updatedAt: '2026-09-21T05:00:00.000Z' }),
    ]
    render(<TaskCenterPanel {...panelProps({ tasks: async () => tasks })} />)
    await expandNode('现场节点')
    const defaultEntry = await screen.findByRole('button', { name: /^default/ })
    // 1 conversation (dtask-shared, two rounds) + 1 unbound = 2 sessions.
    expect(within(defaultEntry).getByText(/2 条工作台会话/)).toBeDefined()
    // Last activity is the newest round's instant (the unbound 03:00 round),
    // rendered with the environment's own formatter.
    const expectedActivity = new Date('2026-09-21T03:00:00.000Z').toLocaleString()
    expect(within(defaultEntry).getByText(/最近活动/).textContent).toContain(expectedActivity)
    // The progo card counts only progo's own record.
    const progoEntry = screen.getByRole('button', { name: /deephik-progo/ })
    expect(within(progoEntry).getByText(/1 条工作台会话/)).toBeDefined()
    // The other node's own card counts its own record, never the site's.
    await expandNode('本机 Zcode')
    const localEntry = (await screen.findAllByRole('button', { name: /^default/ }))[0]!
    expect(within(localEntry).getByText(/1 条工作台会话/)).toBeDefined()
  })

  it('maps a no-workspace-option listing failure to the actionable hint instead of a cryptic error', async () => {
    render(<TaskCenterPanel {...panelProps({
      listWorkspaces: async () => {
        throw new Error('the node\'s adapter answered session/new without offering a workspace option — it looks like a fixed-workspace adapter (or an adapter too old for per-session selection); save the node as fixed, or enable per-session workspace selection in the adapter configuration')
      },
    })} />)
    await expandNode('现场节点')
    expect(await screen.findByText(zh.noWorkspaceOptionHint)).toBeDefined()
    expect(screen.queryByText(/looks like a fixed-workspace adapter/)).toBeNull()
  })
})

describe('unified workspace task list', () => {
  it('merges the desktop row with its workbench round into one row and opens the round detail', async () => {
    render(<TaskCenterPanel {...panelProps({
      task: async () => detailOf('WB-20260921-001', {
        title: '绑定任务的详情', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', desktopTaskId: null,
        transcript: [{ at: '2026-09-21T01:04:00.000Z', kind: 'assistant_message', text: 'final answer', key: 'm1', toolStatus: null }],
      }),
    })} />)
    await openDefaultWorkspace()
    // One desktop conversation is one row: the joined pair appears once.
    const joinedRow = screen.getByRole('button', { name: /工作台派发的任务/ })
    expect(joinedRow).toBeDefined()
    expect(screen.getAllByText(/dtask-wb-1|工作台派发的任务/).length).toBeGreaterThan(0)
    // Native desktop-only row also present with its source label.
    expect(screen.getByRole('button', { name: /桌面创建的任务/ })).toBeDefined()
    expect(screen.getByText('ZCode 原生')).toBeDefined()
    // The running pill renders beside the identically-named filter button.
    expect(screen.getAllByText('进行中').length).toBeGreaterThan(1)

    fireEvent.click(joinedRow)
    expect(await screen.findByText('绑定任务的详情')).toBeDefined()
    expect(screen.getByText('原问题')).toBeDefined()
    expect(screen.getByText('full prompt body')).toBeDefined()
    expect(screen.getByText('final answer')).toBeDefined()
    // Run details carry the full task id for diagnostics.
    expect(screen.getByText('统一任务编号')).toBeDefined()
  })

  it('keeps workbench rows visible when the desktop facet is unavailable', async () => {
    const listing = fixtureWorkspaceTasks()
    listing.desktop = { state: 'unavailable', reason: 'the desktop task listing failed' }
    listing.workbench = [viewOf('WB-20260921-001', { title: '未绑定轮', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', desktopTaskId: null })]
    render(<TaskCenterPanel {...panelProps({ workspaceTasks: async () => listing })} />)
    await openDefaultWorkspace()
    expect(await screen.findByText(/Zcode 已同步任务暂不可用：the desktop task listing failed/)).toBeDefined()
    expect(screen.getByRole('button', { name: /未绑定轮/ })).toBeDefined()
    expect(screen.queryByRole('button', { name: /桌面创建的任务/ })).toBeNull()
  })

  it('drops the previous workspace\'s rows the instant the selection switches', async () => {
    // Regression: the previous workspace's listing used to survive until the
    // new read landed, projecting its rows under the new workspace's scope.
    const restoreViewport = stubWideViewport()
    try {
      let releaseProgo: ((value: WorkspaceTasksView) => void) | undefined
      const workspaceTasks = vi.fn((_nodeId: string, path: string): Promise<WorkspaceTasksView> => {
        if (path === '/site/progo') return new Promise(resolve => { releaseProgo = resolve })
        return Promise.resolve(fixtureWorkspaceTasks())
      })
      render(<TaskCenterPanel {...panelProps({
        workspaceTasks: workspaceTasks as NonNullable<WorkbenchActions['workspaceTasks']>,
      })} />)
      await openDefaultWorkspace()
      expect(await screen.findByRole('button', { name: /桌面创建的任务/ })).toBeDefined()
      expect(screen.getByRole('button', { name: /工作台派发的任务/ })).toBeDefined()
      // Switch straight to the other workspace (wide rail); its read pends.
      fireEvent.click(screen.getByRole('button', { name: /deephik-progo/ }))
      // The old rows vanish immediately: reading, never misattributed.
      expect(screen.queryByRole('button', { name: /桌面创建的任务/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /工作台派发的任务/ })).toBeNull()
      expect(screen.getAllByText('正在读取任务…').length).toBeGreaterThan(0)
      // The new workspace's own listing lands and renders.
      act(() => { releaseProgo?.(progoWorkspaceTasks()) })
      expect(await screen.findByRole('button', { name: /progo 任务/ })).toBeDefined()
      expect(screen.queryByRole('button', { name: /桌面创建的任务/ })).toBeNull()
    } finally {
      restoreViewport()
    }
  })

  it('discards a slow response from the workspace that is no longer selected', async () => {
    const restoreViewport = stubWideViewport()
    try {
      let releaseDefault: ((value: WorkspaceTasksView) => void) | undefined
      const workspaceTasks = vi.fn((_nodeId: string, path: string): Promise<WorkspaceTasksView> => {
        if (path === '/site/default') return new Promise(resolve => { releaseDefault = resolve })
        return Promise.resolve(progoWorkspaceTasks())
      })
      render(<TaskCenterPanel {...panelProps({
        workspaceTasks: workspaceTasks as NonNullable<WorkbenchActions['workspaceTasks']>,
      })} />)
      await expandNode('现场节点')
      fireEvent.click(await screen.findByRole('button', { name: /^default/ }))
      // Default's read is slow; switch to progo before it answers.
      fireEvent.click(screen.getByRole('button', { name: /deephik-progo/ }))
      expect(await screen.findByRole('button', { name: /progo 任务/ })).toBeDefined()
      // The stale default response resolves now — it must not paint anything.
      act(() => { releaseDefault?.(fixtureWorkspaceTasks()) })
      await waitFor(() => { expect(screen.getByRole('button', { name: /progo 任务/ })).toBeDefined() })
      expect(screen.queryByRole('button', { name: /桌面创建的任务/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /工作台派发的任务/ })).toBeNull()
    } finally {
      restoreViewport()
    }
  })

  it('flags a 200-row desktop listing as recent-only', async () => {
    const listing = fixtureWorkspaceTasks()
    if (listing.desktop.state === 'ok') {
      listing.desktop.tasks = Array.from({ length: 200 }, (_unused, index) => ({
        taskId: `dtask-bulk-${index}`, title: `bulk ${index}`, status: 'completed' as const,
        createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:01:00.000Z',
        origin: 'desktop' as const, workbenchTaskId: null,
      }))
    }
    render(<TaskCenterPanel {...panelProps({ workspaceTasks: async () => listing })} />)
    await openDefaultWorkspace()
    expect(await screen.findByText('仅显示最近 200 条')).toBeDefined()
  })

  it('filters the unified rows by status bucket', async () => {
    render(<TaskCenterPanel {...panelProps()} />)
    await openDefaultWorkspace()
    expect(await screen.findByRole('button', { name: /桌面创建的任务/ })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '进行中' }))
    expect(screen.getByRole('button', { name: /桌面创建的任务/ })).toBeDefined()
    expect(screen.queryByRole('button', { name: /工作台派发的任务/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '已完成' }))
    expect(screen.getByRole('button', { name: /工作台派发的任务/ })).toBeDefined()
    expect(screen.queryByRole('button', { name: /桌面创建的任务/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByRole('button', { name: /桌面创建的任务/ })).toBeDefined()
  })

  it('refreshes the desktop index on demand and shows its sampled time', async () => {
    const workspaceTasks = vi.fn(async () => fixtureWorkspaceTasks()) as NonNullable<WorkbenchActions['workspaceTasks']>
    render(<TaskCenterPanel {...panelProps({ workspaceTasks })} />)
    await openDefaultWorkspace()
    await waitFor(() => { expect(workspaceTasks).toHaveBeenCalledTimes(1) })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(workspaceTasks).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(/桌面索引读取于/)).toBeDefined()
  })

  it('switching workspaces drops the open detail and any draft', async () => {
    const perPath: Record<string, WorkspaceTasksView> = {
      '/site/default': fixtureWorkspaceTasks(),
      '/site/progo': {
        nodeId: 'site-1', workspacePath: '/site/progo',
        desktop: { state: 'ok', desktopVersion: '3.14.0', tasks: [] },
        workbench: [],
      },
    }
    render(<TaskCenterPanel {...panelProps({
      workspaceTasks: async (_nodeId, path) => perPath[path] ?? fixtureWorkspaceTasks(),
      task: async (id: string) => detailOf(id, { title: '绑定任务的详情' }),
    })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /工作台派发的任务/ }))
    expect(await screen.findByText('绑定任务的详情')).toBeDefined()
    // Back to the list, then back home, then into the other workspace.
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await screen.findByRole('region', { name: '任务列表' })
    fireEvent.click(screen.getByRole('button', { name: '返回工作区' }))
    // The home kept its node expansion through the round trip.
    await screen.findByRole('button', { name: /^default/ })
    fireEvent.click(screen.getByRole('button', { name: /^default/ }))
    await screen.findByRole('region', { name: '任务列表' })
    expect(screen.queryByText('绑定任务的详情')).toBeNull()
    // The default workspace's rows never leak into the progo listing.
    fireEvent.click(screen.getByRole('button', { name: '返回工作区' }))
    fireEvent.click(await screen.findByRole('button', { name: /deephik-progo/ }))
    await waitFor(() => { expect(screen.getByText('没有符合当前筛选的任务。')).toBeDefined() })
    expect(screen.queryByRole('button', { name: /桌面创建的任务/ })).toBeNull()
  })
})

describe('composition with a preset workspace', () => {
  it('preselects the workspace, shows the target, and sends without duplicate pickers', async () => {
    const composeTask = vi.fn(async () => viewOf('WB-20260921-001')) as NonNullable<WorkbenchActions['composeTask']>
    render(<TaskCenterPanel {...panelProps({ composeTask })} />)
    await openDefaultWorkspace()
    fireEvent.click(screen.getByRole('button', { name: '在此新建' }))
    // Preset route: no node/workspace combobox at all.
    await waitFor(() => { expect(screen.getByRole('textbox', { name: '任务描述' })).toBeDefined() })
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText('现场节点 / default')).toBeDefined()
    fireEvent.change(screen.getByRole('textbox', { name: '任务描述' }), { target: { value: 'fixture prompt' } })
    const send = screen.getByRole('button', { name: '发送任务' })
    expect((send as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('任务将发送到：现场节点 / default。')).toBeDefined()
    fireEvent.click(send)
    await waitFor(() => { expect(composeTask).toHaveBeenCalledWith({ title: '', prompt: 'fixture prompt', nodeId: 'site-1', workspacePath: '/site/default' }) })
  })

  it('keeps send disabled until the prompt is described', async () => {
    const composeTask = vi.fn(async (_request: WorkbenchComposeRequest) => viewOf('WB-20260921-001'))
    render(<TaskCenterPanel {...panelProps({ composeTask: composeTask as NonNullable<WorkbenchActions['composeTask']> })} />)
    await openDefaultWorkspace()
    fireEvent.click(screen.getByRole('button', { name: '在此新建' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '发送任务' })).toBeDefined() })
    const send = screen.getByRole('button', { name: '发送任务' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(screen.getByText('执行位置已就绪，请描述任务。')).toBeDefined()
    // A failed send keeps the input for retry, and one click dispatches once.
    let calls = 0
    composeTask.mockImplementation(async () => {
      calls += 1
      if (calls === 1) throw new Error('transport hiccup')
      return viewOf('WB-20260921-001')
    })
    fireEvent.change(screen.getByRole('textbox', { name: '任务描述' }), { target: { value: 'retry me' } })
    expect((screen.getByRole('button', { name: '发送任务' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '发送任务' }))
    await waitFor(() => { expect(composeTask).toHaveBeenCalledTimes(1) })
    expect((screen.getByRole('textbox', { name: '任务描述' }) as HTMLTextAreaElement).value).toBe('retry me')
    expect(screen.getByRole('button', { name: '发送任务' })).toBeDefined()
  })

  it('composes against a fixed node\'s pinned workspace without a picker', async () => {
    const composeTask = vi.fn(async () => viewOf('WB-20260921-010')) as NonNullable<WorkbenchActions['composeTask']>
    const nodes = fixtureNodes().map(node => ({ ...node, id: 'fixed-1', label: '固定节点', workspaceSelection: 'fixed' as const }))
    render(<TaskCenterPanel {...panelProps({
      composeTask,
      nodes: async () => [nodes[0]!],
    })} />)
    // Single node auto-expands; the fixed workspace entry needs no discovery.
    await screen.findByRole('button', { name: /固定节点 的固定工作区/ })
    fireEvent.click(screen.getByRole('button', { name: '在此新建' }))
    await waitFor(() => { expect(screen.getByRole('textbox', { name: '任务描述' })).toBeDefined() })
    fireEvent.change(screen.getByRole('textbox', { name: '任务描述' }), { target: { value: 'read-only fixture' } })
    fireEvent.click(screen.getByRole('button', { name: '发送任务' }))
    await waitFor(() => { expect(composeTask).toHaveBeenCalledWith({
      title: '', prompt: 'read-only fixture', nodeId: 'fixed-1', workspacePath: '__fixed__',
    }) })
  })

  it('entering composition from an open detail replaces it and leaves no hidden composing state', async () => {
    // Regression: the global and list-column compose entries only set
    // composing without clearing the open detail, so on wide screens the form
    // stayed hidden behind the old detail while the global button hid itself.
    const restoreViewport = stubWideViewport()
    try {
      const composeTask = vi.fn(async (_request: WorkbenchComposeRequest) => viewOf('WB-new', {
        title: '新任务', nodeId: 'site-1', nodeLabel: '现场节点', workspacePath: '/site/default', workspaceLabel: 'default',
      }))
      const task = vi.fn(async (id: string): Promise<WorkbenchTaskDetailView | undefined> => {
        if (id === 'WB-A1') {
          return detailOf(id, { title: 'A 第一轮', status: 'failed', terminalOutcome: 'failed', desktopTaskId: 'dtask-a', createdAt: '2026-09-21T01:00:00.000Z', prompt: 'A 第一轮指令' })
        }
        if (id === 'WB-A2') {
          return detailOf(id, { title: 'A 第二轮', status: 'completed', terminalOutcome: 'completed', desktopTaskId: 'dtask-a', createdAt: '2026-09-21T02:00:00.000Z', prompt: 'A 第二轮指令' })
        }
        if (id === 'WB-B1') {
          return detailOf(id, { title: 'B 记录', status: 'completed', terminalOutcome: 'completed', desktopTaskId: 'dtask-b', createdAt: '2026-09-21T03:00:00.000Z', prompt: 'B 指令' })
        }
        return detailOf(id, { title: '新任务', status: 'dispatching', terminalOutcome: null, desktopTaskId: null })
      })
      render(<TaskCenterPanel {...panelProps({
        composeTask: composeTask as NonNullable<WorkbenchActions['composeTask']>,
        task: task as NonNullable<WorkbenchActions['task']>,
        workspaceTasks: async () => twoTaskWorkspaceTasks(),
      })} />)
      await openDefaultWorkspace()
      // A detail is open in the main column.
      fireEvent.click(await screen.findByRole('button', { name: /A 任务/ }))
      expect(await screen.findByText('A 第二轮指令')).toBeDefined()
      // The global button enters composition: the form takes the column (its
      // own header, required marker, and route validation appear), the old
      // detail unmounts (its conversation and continue composer are gone),
      // and the button hides itself while active.
      fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
      await screen.findByText('必选')
      expect(screen.getByText('请先选择执行节点和工作区。')).toBeDefined()
      expect(screen.queryByRole('region', { name: '继续这个任务' })).toBeNull()
      expect(screen.queryByText('A 第二轮指令')).toBeNull()
      expect(screen.queryByRole('button', { name: '新建任务' })).toBeNull()
      const selects = screen.getAllByRole('combobox')
      fireEvent.change(selects[0]!, { target: { value: 'site-1' } })
      await waitFor(() => { expect(selects[1]!.querySelector('option[value="/site/default"]')).not.toBeNull() })
      fireEvent.change(selects[1]!, { target: { value: '/site/default' } })
      fireEvent.change(screen.getByRole('textbox', { name: '任务描述' }), { target: { value: '全新任务' } })
      fireEvent.click(screen.getByRole('button', { name: '发送任务' }))
      await waitFor(() => { expect(composeTask).toHaveBeenCalledWith({ title: '', prompt: '全新任务', nodeId: 'site-1', workspacePath: '/site/default' }) })
      // The dispatched round opens its detail; the global button returns.
      expect(await screen.findByText('新任务')).toBeDefined()
      expect(screen.getByRole('button', { name: '新建任务' })).toBeDefined()
      // From another open detail, the list-column entry presets the target.
      fireEvent.click(screen.getByRole('button', { name: '返回' }))
      fireEvent.click(await screen.findByRole('button', { name: /B 任务/ }))
      expect(await screen.findByText('B 指令')).toBeDefined()
      const composeButtons = screen.getAllByRole('button', { name: '在此新建' })
      fireEvent.click(composeButtons[2]!)
      await waitFor(() => { expect(screen.getAllByText('现场节点 / default').length).toBeGreaterThan(0) })
      expect(screen.queryByText('B 指令')).toBeNull()
      expect(screen.queryByRole('region', { name: '继续这个任务' })).toBeNull()
      expect(screen.queryByRole('button', { name: '新建任务' })).toBeNull()
      // Opening a task directly clears the form — no composing survives hidden.
      fireEvent.click(screen.getByRole('button', { name: /A 任务/ }))
      expect(await screen.findByText('A 第二轮指令')).toBeDefined()
      expect(screen.queryByText('必选')).toBeNull()
      expect(screen.getByRole('region', { name: '继续这个任务' })).toBeDefined()
      expect(screen.getByRole('button', { name: '新建任务' })).toBeDefined()
    } finally {
      restoreViewport()
    }
  })

  it('routing an unrouted task from an open detail replaces it with the routing form', async () => {
    const restoreViewport = stubWideViewport()
    try {
      const unrouted: WorkbenchTaskView = {
        workbenchTaskId: 'WB-unrouted', source: 'codex', sourceTaskId: 'c1', threadId: null,
        title: '未路由任务', promptPreview: 'p', status: 'awaiting_route', terminalOutcome: null,
        zcodeDelivery: 'pending', awaitingInput: false, echoLost: false, lastError: null,
        nodeId: null, nodeLabel: null, workspacePath: null, workspaceLabel: null, acpSessionId: null,
        desktopTaskId: null, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
      }
      const task = vi.fn(async (id: string): Promise<WorkbenchTaskDetailView | undefined> => {
        if (id === 'WB-unrouted') {
          return detailOf(id, { source: 'codex', status: 'awaiting_route', title: '未路由任务', nodeId: null, nodeLabel: null, workspacePath: null, workspaceLabel: null, prompt: '原任务描述' })
        }
        if (id === 'WB-A1') {
          return detailOf(id, { title: 'A 第一轮', status: 'failed', terminalOutcome: 'failed', desktopTaskId: 'dtask-a', createdAt: '2026-09-21T01:00:00.000Z', prompt: 'A 第一轮指令' })
        }
        return detailOf(id, { title: 'A 第二轮', status: 'completed', terminalOutcome: 'completed', desktopTaskId: 'dtask-a', createdAt: '2026-09-21T02:00:00.000Z', prompt: 'A 第二轮指令' })
      })
      render(<TaskCenterPanel {...panelProps({
        task: task as NonNullable<WorkbenchActions['task']>,
        workspaceTasks: async () => twoTaskWorkspaceTasks(),
        tasks: async () => [unrouted],
      })} />)
      await openDefaultWorkspace()
      fireEvent.click(await screen.findByRole('button', { name: /A 任务/ }))
      expect(await screen.findByText('A 第二轮指令')).toBeDefined()
      // The unrouted strip lives on the always-visible wide rail.
      fireEvent.click(screen.getByRole('button', { name: '选择位置' }))
      expect(await screen.findByText('必选')).toBeDefined()
      expect((await screen.findAllByRole('combobox')).length).toBe(2)
      expect(await screen.findByText('原任务描述')).toBeDefined()
      expect(screen.queryByText('A 第二轮指令')).toBeNull()
      expect(screen.queryByRole('region', { name: '继续这个任务' })).toBeNull()
      expect(screen.queryByRole('button', { name: '新建任务' })).toBeNull()
    } finally {
      restoreViewport()
    }
  })

  it('shows the ready-to-send target readably: site label, never the full local path', async () => {
    // The live-evidence shape: a site workspace whose path IS a long local
    // directory. Typing a prompt WITHOUT sending must show a ready line that
    // names the site's own label — no full path, no double slash — while the
    // eventual send still routes by the exact workspace path.
    const composeTask = vi.fn(async (_request: WorkbenchComposeRequest) => viewOf('WB-pathless-1'))
    render(<TaskCenterPanel {...panelProps({
      composeTask: composeTask as NonNullable<WorkbenchActions['composeTask']>,
      listWorkspaces: async () => ({
        options: [{ path: '/Users/wdj/dsh探索', label: 'dsh探索' }],
        desktopVersion: '3.14.0',
      }),
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: '新建任务' }))
    const selects = await screen.findAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'site-1' } })
    await waitFor(() => { expect(selects[1]!.querySelector('option[value="/Users/wdj/dsh探索"]')).not.toBeNull() })
    fireEvent.change(selects[1]!, { target: { value: '/Users/wdj/dsh探索' } })
    fireEvent.change(screen.getByRole('textbox', { name: '任务描述' }), { target: { value: 'drafted but not sent' } })
    // Drafted, unsent: the ready line reads "node / site label".
    expect(screen.getByText('任务将发送到：现场节点 / dsh探索。')).toBeDefined()
    // No full local path anywhere in the visible text, and no double slash.
    expect(screen.queryByText(/\/Users\//)).toBeNull()
    expect(screen.queryByText(/现场节点 \/ \/Users/)).toBeNull()
    // Sending still routes by the exact workspace path — display-only change.
    fireEvent.click(screen.getByRole('button', { name: '发送任务' }))
    await waitFor(() => { expect(composeTask).toHaveBeenCalledWith({
      title: '', prompt: 'drafted but not sent', nodeId: 'site-1', workspacePath: '/Users/wdj/dsh探索',
    }) })
  })

  it('never surfaces the internal fixed-pin placeholder in the ready line', async () => {
    // Fixed-node composition: the pin is chosen from the listing's own fixed
    // option, and the ready line shows that readable label. The internal
    // __fixed__ placeholder never appears as visible text (the listing-less
    // fallback localizes it too — defense in depth), while the send still
    // travels the literal for server-side validation.
    const composeTask = vi.fn(async (_request: WorkbenchComposeRequest) => viewOf('WB-fixed-1'))
    const nodes = fixtureNodes().map(node => ({ ...node, workspaceSelection: 'fixed' as const }))
    render(<TaskCenterPanel {...panelProps({
      composeTask: composeTask as NonNullable<WorkbenchActions['composeTask']>,
      nodes: async () => [nodes[1]!],
      listWorkspaces: async () => ({
        options: [{ path: '__fixed__', label: '现场节点 · pinned in node configuration' }],
        desktopVersion: null,
      }),
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: '新建任务' }))
    const selects = await screen.findAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'site-1' } })
    await waitFor(() => { expect(selects[1]!.querySelector('option[value="__fixed__"]')).not.toBeNull() })
    fireEvent.change(selects[1]!, { target: { value: '__fixed__' } })
    fireEvent.change(screen.getByRole('textbox', { name: '任务描述' }), { target: { value: 'pinned draft' } })
    // The pinned label already names the node; no duplicated prefix.
    expect(screen.getByText('任务将发送到：现场节点 · pinned in node configuration。')).toBeDefined()
    // The internal placeholder is never user-visible in any compose state.
    expect(screen.queryByText(/__fixed__/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '发送任务' }))
    await waitFor(() => { expect(composeTask).toHaveBeenCalledWith({
      title: '', prompt: 'pinned draft', nodeId: 'site-1', workspacePath: '__fixed__',
    }) })
  })

  it('supports the global new-task entry with the full target picker', async () => {
    const composeTask = vi.fn(async () => viewOf('WB-20260921-011')) as NonNullable<WorkbenchActions['composeTask']>
    render(<TaskCenterPanel {...panelProps({ composeTask })} />)
    fireEvent.click(await screen.findByRole('button', { name: '新建任务' }))
    const selects = await screen.findAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'site-1' } })
    await waitFor(() => { expect(selects[1]!.querySelector('option[value="/site/default"]')).not.toBeNull() })
    fireEvent.change(selects[1]!, { target: { value: '/site/default' } })
    fireEvent.change(screen.getByRole('textbox', { name: '任务描述' }), { target: { value: 'fixture prompt' } })
    const send = screen.getByRole('button', { name: '发送任务' })
    expect((send as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(send)
    await waitFor(() => { expect(composeTask).toHaveBeenCalledWith({ title: '', prompt: 'fixture prompt', nodeId: 'site-1', workspacePath: '/site/default' }) })
  })
})

describe('result-first details and safe continuation', () => {
  it('renders the reported round with its real outcome; 已回报 lives in run details only', async () => {
    render(<TaskCenterPanel {...panelProps({
      task: async () => detailOf('WB-20260921-001', {
        title: '已回报的任务', status: 'reported', terminalOutcome: 'failed', zcodeDelivery: 'terminal', desktopTaskId: 'dtask-wb-1',
        lastError: 'the turn failed',
      }),
    })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /工作台派发的任务/ }))
    expect(await screen.findByText('已回报的任务')).toBeDefined()
    // The main pill is the real outcome — 失败 — never a blanket success.
    expect(screen.getAllByText('失败').length).toBeGreaterThan(0)
    expect(screen.queryByText('已回报')).toBeNull()
    // The run details name the reported state and the actual outcome.
    expect(screen.getByText('已回报给来源；实际结果：失败')).toBeDefined()
    expect(screen.getByText('回报状态')).toBeDefined()
  })

  it('enables continuation from a verified-completed desktop task and sends through continueDesktopTask', async () => {
    const continueDesktopTask = vi.fn(async () => viewOf('WB-20260922-001', {
      title: '后续轮记录', status: 'dispatching', desktopTaskId: 'dtask-wb-1', zcodeDelivery: 'pending',
    })) as NonNullable<WorkbenchActions['continueDesktopTask']>
    render(<TaskCenterPanel {...panelProps({
      continueDesktopTask,
      task: async (id: string) => detailOf(id, id === 'WB-20260922-001'
        ? { title: '后续轮记录', status: 'dispatching', terminalOutcome: null, zcodeDelivery: 'pending', desktopTaskId: 'dtask-wb-1' }
        : {
          title: '原始轮', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', desktopTaskId: 'dtask-wb-1',
          acpSessionId: 'fake-acp-session-1',
          // Session-node records store the raw workspace path as their label —
          // the default continue hint must NOT leak it (design §5).
          workspaceLabel: '/site/default',
        }),
    })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /工作台派发的任务/ }))
    expect(await screen.findByText('原始轮')).toBeDefined()
    const box = await screen.findByRole('region', { name: '继续这个任务' })
    // The hint reads "node / readable workspace name" — no full path, no
    // double slash — while run details keep the full path for diagnostics.
    const hintLine = within(box).getByText(/原任务：/).textContent ?? ''
    expect(hintLine).toContain('现场节点 / default')
    expect(hintLine).not.toContain('/site/')
    expect(screen.queryByText(/现场节点 \/ \/site\/default/)).toBeNull()
    const runDetails = screen.getByText('运行详情').closest('details')!
    expect(within(runDetails).getByText('/site/default')).toBeDefined()
    const textarea = within(box).getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    fireEvent.change(textarea, { target: { value: '第二轮指令' } })
    fireEvent.click(within(box).getByRole('button', { name: '发送后续指令' }))
    await waitFor(() => { expect(continueDesktopTask).toHaveBeenCalledWith({
      nodeId: 'site-1', workspacePath: '/site/default', desktopTaskId: 'dtask-wb-1', prompt: '第二轮指令', title: '',
    }) })
    // The dispatched round opens its own detail inside the same desktop task.
    expect(await screen.findByText('后续轮记录')).toBeDefined()
  })

  it('chains every workbench round of the desktop task in time order, keeping each round\'s errors', async () => {
    const task = vi.fn(async (id: string) => {
      if (id === 'WB-round-1') return detailOf(id, {
        title: '第一轮', status: 'failed', terminalOutcome: 'failed', zcodeDelivery: 'terminal',
        desktopTaskId: 'dtask-wb-1', createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-21T01:05:00.000Z',
        lastError: 'round one broke', prompt: '第一轮指令',
        transcript: [{ at: '2026-09-21T01:04:00.000Z', kind: 'assistant_message', text: 'partial answer', key: 'm1', toolStatus: null }],
      })
      return detailOf(id, {
        title: '第二轮', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal',
        desktopTaskId: 'dtask-wb-1', createdAt: '2026-09-21T02:00:00.000Z', updatedAt: '2026-09-21T02:05:00.000Z',
        prompt: '第二轮指令',
        transcript: [{ at: '2026-09-21T02:04:00.000Z', kind: 'assistant_message', text: 'final answer', key: 'm2', toolStatus: null }],
      })
    }) as NonNullable<WorkbenchActions['task']>
    const listing = fixtureWorkspaceTasks()
    if (listing.desktop.state === 'ok') {
      // The desktop row joins the newest round; the earlier round rides the same desktop task id.
      listing.workbench = [
        viewOf('WB-round-1', { status: 'failed', terminalOutcome: 'failed', zcodeDelivery: 'terminal', desktopTaskId: 'dtask-wb-1', title: '第一轮', createdAt: '2026-09-21T01:00:00.000Z', updatedAt: '2026-09-21T01:05:00.000Z' }),
        viewOf('WB-round-2', { status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', desktopTaskId: 'dtask-wb-1', title: '第二轮', createdAt: '2026-09-21T02:00:00.000Z', updatedAt: '2026-09-21T02:05:00.000Z' }),
      ]
      listing.desktop.tasks[1]!.workbenchTaskId = 'WB-round-2'
    }
    render(<TaskCenterPanel {...panelProps({ task, workspaceTasks: async () => listing })} />)
    await openDefaultWorkspace()
    // One row for the desktop conversation, labelled with its two rounds.
    const row = await screen.findByRole('button', { name: /工作台派发的任务/ })
    expect(within(row).getByText(/2 轮/)).toBeDefined()
    fireEvent.click(row)
    // Both rounds render in order with their own prompts, replies, and errors.
    expect(await screen.findByText('第 1 轮')).toBeDefined()
    expect(screen.getByText('第 2 轮')).toBeDefined()
    expect(screen.getByText('第一轮指令')).toBeDefined()
    expect(screen.getByText('第二轮指令')).toBeDefined()
    expect(screen.getByText('partial answer')).toBeDefined()
    expect(screen.getByText('final answer')).toBeDefined()
    expect(screen.getByText(/最近错误: round one broke/)).toBeDefined()
    // The run details list the earlier round ids for diagnostics.
    expect(screen.getByText('WB-round-1')).toBeDefined()
  })

  it('keeps an earlier round that resolves only after the merged item has been rebuilt', async () => {
    // Regression: poll-driven item rebuilds used to tear down the in-flight
    // earlier-round load; its late result was dropped while the round stayed
    // marked as loaded, so the old round never appeared.
    let releaseFirstRound: ((value: WorkbenchTaskDetailView) => void) | undefined
    const task = vi.fn(async (id: string): Promise<WorkbenchTaskDetailView | undefined> => {
      if (id === 'WB-round-1') {
        return new Promise<WorkbenchTaskDetailView>(resolve => { releaseFirstRound = resolve })
      }
      return detailOf(id, {
        title: '第二轮', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal',
        desktopTaskId: 'dtask-wb-1', createdAt: '2026-09-21T02:00:00.000Z', prompt: '第二轮指令',
      })
    })
    const workspaceTasks = vi.fn(async () => twoRoundWorkspaceTasks())
    render(<TaskCenterPanel {...panelProps({
      task: task as NonNullable<WorkbenchActions['task']>,
      workspaceTasks: workspaceTasks as NonNullable<WorkbenchActions['workspaceTasks']>,
    })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /工作台派发的任务/ }))
    // The polled round renders under its TRUE number from the projection's
    // complete round list; the still-loading earlier round holds a reserved
    // placeholder, so nothing renumbers when it lands.
    expect(await screen.findByText('第二轮指令')).toBeDefined()
    expect(screen.getByText('第 2 轮')).toBeDefined()
    expect(screen.getByText('第 1 轮')).toBeDefined()
    expect(screen.getByText('正在读取该轮内容…')).toBeDefined()
    expect(screen.queryByText('第一轮指令')).toBeNull()
    // Two reconnect-driven workspace refreshes rebuild the merged item (fresh
    // identities, same rounds) without leaving the open detail.
    notifyWorkbenchRefresh()
    notifyWorkbenchRefresh()
    await waitFor(() => { expect(workspaceTasks).toHaveBeenCalledTimes(3) })
    // The earlier round resolves only now, after the churn — it must still land.
    act(() => { releaseFirstRound?.(detailOf('WB-round-1', {
      title: '第一轮', status: 'failed', terminalOutcome: 'failed', zcodeDelivery: 'terminal',
      desktopTaskId: 'dtask-wb-1', createdAt: '2026-09-21T01:00:00.000Z', prompt: '第一轮指令',
    })) })
    expect(await screen.findByText('第一轮指令')).toBeDefined()
    // Stable numbering: the placeholder is replaced in place, both slots keep
    // the numbers they were opened with, and exactly one of each exists.
    expect(screen.queryByText('正在读取该轮内容…')).toBeNull()
    expect(screen.getAllByText('第 1 轮')).toHaveLength(1)
    expect(screen.getAllByText('第 2 轮')).toHaveLength(1)
    // The content-keyed round list means exactly one load for the earlier round.
    expect(task.mock.calls.filter(([id]) => id === 'WB-round-1')).toHaveLength(1)
  })

  it('retries a rejecting earlier-round load a bounded number of times until it succeeds', async () => {
    let failures = 0
    const task = vi.fn(async (id: string): Promise<WorkbenchTaskDetailView | undefined> => {
      if (id === 'WB-round-1') {
        failures += 1
        if (failures <= 2) throw new Error('transient read failure')
      }
      return detailOf(id, id === 'WB-round-1'
        ? {
          title: '第一轮', status: 'failed', terminalOutcome: 'failed', zcodeDelivery: 'terminal',
          desktopTaskId: 'dtask-wb-1', createdAt: '2026-09-21T01:00:00.000Z', prompt: '第一轮指令',
        }
        : {
          title: '第二轮', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal',
          desktopTaskId: 'dtask-wb-1', createdAt: '2026-09-21T02:00:00.000Z', prompt: '第二轮指令',
        })
    })
    render(<TaskCenterPanel {...panelProps({
      task: task as NonNullable<WorkbenchActions['task']>,
      workspaceTasks: async () => twoRoundWorkspaceTasks(),
    })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /工作台派发的任务/ }))
    // Two rejections, then the third attempt delivers the round.
    expect(await screen.findByText('第一轮指令')).toBeDefined()
    expect(task.mock.calls.filter(([id]) => id === 'WB-round-1')).toHaveLength(3)
  })

  it('does not live-overlay records of a differently-cased workspace path', async () => {
    // The Host scopes records case-sensitively on this platform: the exact-case
    // record live-overlays into the list, the differently-cased one does not.
    const listing = fixtureWorkspaceTasks()
    listing.workbench = []
    render(<TaskCenterPanel {...panelProps({
      workspaceTasks: async () => listing,
      tasks: async () => [
        viewOf('WB-case-drift', { title: '大小写漂移轮', workspacePath: '/site/Default', status: 'completed', terminalOutcome: 'completed' }),
        viewOf('WB-case-exact', { title: '精确匹配轮', workspacePath: '/site/default', status: 'completed', terminalOutcome: 'completed' }),
      ],
    })} />)
    await openDefaultWorkspace()
    await screen.findByRole('button', { name: /精确匹配轮/ })
    expect(screen.queryByRole('button', { name: /大小写漂移轮/ })).toBeNull()
  })

  it('a late earlier-round load never bleeds into the task switched to', async () => {
    // Regression: the detail pane was one unkeyed instance, so a quick A→B
    // switch let A's late earlier-round load append into B's round chain (and
    // A's continuation draft survive into B's composer).
    let releaseFirstRoundA: ((value: WorkbenchTaskDetailView) => void) | undefined
    const task = vi.fn(async (id: string): Promise<WorkbenchTaskDetailView | undefined> => {
      if (id === 'WB-A1') {
        return new Promise<WorkbenchTaskDetailView>(resolve => { releaseFirstRoundA = resolve })
      }
      return detailOf(id, id === 'WB-A2'
        ? { title: 'A 第二轮', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', desktopTaskId: 'dtask-a', createdAt: '2026-09-21T02:00:00.000Z', prompt: 'A 第二轮指令' }
        : { title: 'B 记录', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', desktopTaskId: 'dtask-b', createdAt: '2026-09-21T03:00:00.000Z', prompt: 'B 指令' })
    })
    render(<TaskCenterPanel {...panelProps({
      task: task as NonNullable<WorkbenchActions['task']>,
      workspaceTasks: async () => twoTaskWorkspaceTasks(),
    })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /A 任务/ }))
    expect(await screen.findByText('A 第二轮指令')).toBeDefined()
    // A continuation draft is typed into A's composer before switching.
    const boxA = within(await screen.findByRole('region', { name: '继续这个任务' })).getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(boxA, { target: { value: 'A 的草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(await screen.findByRole('button', { name: /B 任务/ }))
    expect(await screen.findByText('B 指令')).toBeDefined()
    // A's earlier round resolves only now — it must not append into B.
    act(() => { releaseFirstRoundA?.(detailOf('WB-A1', {
      title: 'A 第一轮', status: 'failed', terminalOutcome: 'failed', zcodeDelivery: 'terminal',
      desktopTaskId: 'dtask-a', createdAt: '2026-09-21T01:00:00.000Z', prompt: 'A 第一轮指令',
    })) })
    await waitFor(() => { expect(screen.getByText('B 指令')).toBeDefined() })
    expect(screen.queryByText('A 第一轮指令')).toBeNull()
    expect(screen.queryByText(/WB-A1/)).toBeNull()
    // B's composer starts fresh: A's draft did not survive the switch.
    const boxB = within(screen.getByRole('region', { name: '继续这个任务' })).getByRole('textbox') as HTMLTextAreaElement
    expect(boxB.value).toBe('')
  })

  it('a slow polled detail never overwrites the task switched to', async () => {
    let releaseDetailA: ((value: WorkbenchTaskDetailView) => void) | undefined
    const task = vi.fn(async (id: string): Promise<WorkbenchTaskDetailView | undefined> => {
      if (id === 'WB-A2') {
        return new Promise<WorkbenchTaskDetailView>(resolve => { releaseDetailA = resolve })
      }
      return detailOf(id, { title: 'B 记录', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal', desktopTaskId: 'dtask-b', createdAt: '2026-09-21T03:00:00.000Z', prompt: 'B 指令' })
    })
    render(<TaskCenterPanel {...panelProps({
      task: task as NonNullable<WorkbenchActions['task']>,
      workspaceTasks: async () => twoTaskWorkspaceTasks(),
    })} />)
    await openDefaultWorkspace()
    // Open A while its polled detail is still in flight, then switch to B.
    fireEvent.click(await screen.findByRole('button', { name: /A 任务/ }))
    expect(screen.getByText('正在读取工作区…')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(await screen.findByRole('button', { name: /B 任务/ }))
    expect(await screen.findByText('B 指令')).toBeDefined()
    // A's slow detail resolves only now — B's view stays B's.
    act(() => { releaseDetailA?.(detailOf('WB-A2', {
      title: 'A 第二轮', status: 'completed', terminalOutcome: 'completed', zcodeDelivery: 'terminal',
      desktopTaskId: 'dtask-a', createdAt: '2026-09-21T02:00:00.000Z', prompt: 'A 第二轮指令',
    })) })
    await waitFor(() => { expect(screen.getByText('B 指令')).toBeDefined() })
    expect(screen.queryByText('A 第二轮指令')).toBeNull()
    expect(screen.queryByText('A 第二轮')).toBeNull()
  })

  it('re-keying the composer resets the preset route when the target changes', async () => {
    const restoreViewport = stubWideViewport()
    try {
      render(<TaskCenterPanel {...panelProps({
        workspaceTasks: async (_nodeId, path) => path === '/site/progo' ? progoWorkspaceTasks() : twoTaskWorkspaceTasks(),
      })} />)
      await openDefaultWorkspace()
      // Rail order: default entry, progo entry, then the list column's own button.
      const composeButtons = await screen.findAllByRole('button', { name: '在此新建' })
      fireEvent.click(composeButtons[0]!)
      // Wide layout: the list header carries the same target line, so count.
      await waitFor(() => { expect(screen.getAllByText('现场节点 / default').length).toBeGreaterThan(0) })
      // Compose in progo straight from the rail: the composer re-keys and
      // takes progo's preset instead of keeping default's stale route.
      fireEvent.click(screen.getAllByRole('button', { name: '在此新建' })[1]!)
      await waitFor(() => { expect(screen.getAllByText('现场节点 / deephik-progo').length).toBeGreaterThan(0) })
      expect(screen.queryByText('现场节点 / default')).toBeNull()
    } finally {
      restoreViewport()
    }
  })

  it('states the refusal reason for a running desktop row', async () => {
    render(<TaskCenterPanel {...panelProps({
      task: async () => detailOf('WB-20260921-001', { title: '运行中的绑定任务' }),
    })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /桌面创建的任务/ }))
    const box = await screen.findByRole('region', { name: '继续这个任务' })
    const textarea = within(box).getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(within(box).getByRole('button', { name: '发送后续指令' }).getAttribute('disabled')).not.toBeNull()
    expect(within(box).getByText('任务运行中，结束后才能继续。')).toBeDefined()
  })
})

describe('native desktop task detail is summary-only', () => {
  it('shows the summary and the honest history gap, never a faked conversation', async () => {
    render(<TaskCenterPanel {...panelProps()} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /桌面创建的任务/ }))
    expect(await screen.findByText('桌面创建的任务')).toBeDefined()
    expect(screen.getByText(/当前只能读取任务摘要/)).toBeDefined()
    expect(screen.getByText('运行中')).toBeDefined()
    // No transcript section is rendered for a native task.
    expect(screen.queryByLabelText('任务对话')).toBeNull()
    expect(screen.queryByText('原问题')).toBeNull()
    // The full desktop task id stays off the first screen (design §5): the
    // summary card carries no technical id, and the collapsed run details
    // hold the copyable full id instead.
    const summaryCard = screen.getByRole('region', { name: '任务信息' })
    expect(within(summaryCard).queryByText('sess-11112222333344445555')).toBeNull()
    const runDetails = screen.getByText('运行详情').closest('details')!
    expect(within(runDetails).getByText('sess-11112222333344445555')).toBeDefined()
    // The continue hint names the workspace readably — never its full path.
    const nativeBox = screen.getByRole('region', { name: '继续这个任务' })
    const nativeHint = within(nativeBox).getByText(/原任务：/).textContent ?? ''
    expect(nativeHint).toContain('现场节点 / default')
    expect(nativeHint).not.toContain('/site/')
  })

  it('renders the native task snapshot in desktop order with the partial note', async () => {
    const desktopTaskSnapshot = vi.fn(async (): Promise<ZcodeDesktopTaskSnapshotResult> => ({
      state: 'ok',
      snapshot: {
        taskId: 'sess-11112222333344445555',
        phase: 'completedSuccess',
        pendingInteractions: 0,
        partial: true,
        rowCount: 3,
        sampledAt: '2026-09-21T05:00:00.000Z',
        summary: [
          { rowId: 0, kind: 'user', text: '原生任务的原问题', toolTitle: null, toolStatus: null },
          { rowId: 1, kind: 'tool', text: null, toolTitle: 'Read', toolStatus: 'completed' },
          { rowId: 2, kind: 'assistant', text: '原生任务的回答，含 **要点**。', toolTitle: null, toolStatus: null },
        ],
      },
    })) as unknown as WorkbenchActions['desktopTaskSnapshot']
    render(<TaskCenterPanel {...panelProps({ desktopTaskSnapshot })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /桌面创建的任务/ }))
    // Read once on open with the exact identity; never on a timer.
    await waitFor(() => { expect(desktopTaskSnapshot).toHaveBeenCalledWith('site-1', '/site/default', 'sess-11112222333344445555') })
    expect(desktopTaskSnapshot).toHaveBeenCalledTimes(1)
    // Desktop order: user bubble, tool card, assistant Markdown with bold parsed.
    expect(await screen.findByText('原生任务的原问题')).toBeDefined()
    expect(screen.getByText('Read')).toBeDefined()
    expect(screen.getByText('要点').tagName).toBe('STRONG')
    // The tail window is named for what it is.
    expect(screen.getByText('仅显示最近内容——桌面快照是尾窗口，不是完整历史。')).toBeDefined()
    expect(screen.queryByText(/当前只能读取任务摘要/)).toBeNull()
  })

  it('keeps the boundary honest when the native snapshot read fails', async () => {
    const desktopTaskSnapshot = vi.fn(async (): Promise<ZcodeDesktopTaskSnapshotResult> => ({
      state: 'unavailable',
      reason: 'task-missing',
    })) as unknown as WorkbenchActions['desktopTaskSnapshot']
    render(<TaskCenterPanel {...panelProps({ desktopTaskSnapshot })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /桌面创建的任务/ }))
    expect(await screen.findByText(/任务对话快照暂不可用：task-missing/)).toBeDefined()
    expect(screen.getByText(/当前只能读取任务摘要/)).toBeDefined()
    // No conversation content is invented for a failed read.
    expect(screen.queryByText('原生任务的原问题')).toBeNull()
  })

  it('continues a completed native task through the same evidence-gated path', async () => {
    const continueDesktopTask = vi.fn(async () => viewOf('WB-20260922-002', {
      title: '原生续写轮', status: 'dispatching', desktopTaskId: 'dtask-legacy-9999xxxx', zcodeDelivery: 'pending',
    })) as NonNullable<WorkbenchActions['continueDesktopTask']>
    const listing = fixtureWorkspaceTasks()
    if (listing.desktop.state === 'ok') {
      listing.desktop.tasks = [
        {
          taskId: 'dtask-legacy-9999xxxx', title: '已完成的桌面任务', status: 'completed',
          createdAt: '2026-09-21T04:00:00.000Z', updatedAt: '2026-09-21T04:20:00.000Z',
          origin: 'desktop', workbenchTaskId: null,
        },
      ]
    }
    render(<TaskCenterPanel {...panelProps({
      continueDesktopTask,
      workspaceTasks: async () => listing,
      task: async (id: string) => detailOf(id, {
        title: '原生续写轮', status: 'dispatching', terminalOutcome: null, zcodeDelivery: 'pending', desktopTaskId: 'dtask-legacy-9999xxxx',
      }),
    })} />)
    await openDefaultWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /已完成的桌面任务/ }))
    const box = await screen.findByRole('region', { name: '继续这个任务' })
    const textarea = within(box).getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    fireEvent.change(textarea, { target: { value: '原生续写' } })
    fireEvent.click(within(box).getByRole('button', { name: '发送后续指令' }))
    await waitFor(() => { expect(continueDesktopTask).toHaveBeenCalledWith({
      nodeId: 'site-1', workspacePath: '/site/default', desktopTaskId: 'dtask-legacy-9999xxxx', prompt: '原生续写', title: '',
    }) })
    expect(await screen.findByText('原生续写轮')).toBeDefined()
  })
})

describe('node settings section', () => {
  it('groups nodes, shows health and ingress state, and hides connection data', async () => {
    const props: NodeSettingsProps = panelProps() as unknown as NodeSettingsProps
    render(<NodeSettings {...props} />)

    expect(await screen.findByText('本机')).toBeDefined()
    expect(screen.getByText('远程现场')).toBeDefined()
    expect(screen.getByText('本机 Zcode')).toBeDefined()
    expect(screen.getByText('在线')).toBeDefined()
    expect(screen.getByText('离线')).toBeDefined()
    expect(document.body.textContent).toContain('3.14.0')
    expect(document.body.textContent).toContain('4 个工作区')
    expect(screen.getByText('已就绪')).toBeDefined()

    // Connection addresses never render: the registry holds launcher paths,
    // and the private adapter configuration is never part of any view.
    expect(document.body.textContent).not.toMatch(/https?:\/\//)
    expect(document.body.textContent).not.toContain('sid')

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!)
    expect(await screen.findByText('适配器命令（高级）')).toBeDefined()
  })

  it('shows the offline reason on a node card when health carries a detail', async () => {
    const nodes = fixtureNodes()
    nodes[1]!.health = {
      state: 'offline', checkedAt: '2026-09-21T02:00:00.000Z', desktopVersion: null, workspaceCount: null,
      detail: 'node is reachable but session workspace discovery failed: the node\'s adapter answered session/new without offering a workspace option',
    }
    const props: NodeSettingsProps = panelProps({ nodes: async () => nodes }) as unknown as NodeSettingsProps
    render(<NodeSettings {...props} />)
    expect(await screen.findByText('现场节点')).toBeDefined()
    expect(screen.getByText(/session workspace discovery failed/)).toBeDefined()
  })

  it('maps a no-workspace-option save failure to the actionable hint in the node editor', async () => {
    const saveNode = vi.fn(async () => {
      throw new Error('cannot save this node for per-session workspace selection: the node\'s adapter answered session/new without offering a workspace option — it looks like a fixed-workspace adapter (or an adapter too old for per-session selection); save the node as fixed, or enable per-session workspace selection in the adapter configuration')
    }) as unknown as WorkbenchActions['saveNode']
    const props: NodeSettingsProps = panelProps({ saveNode }) as unknown as NodeSettingsProps
    render(<NodeSettings {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: '添加节点' }))
    fireEvent.change(screen.getByLabelText('节点标识（小写）'), { target: { value: 'site-2' } })
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '漂移节点' } })
    fireEvent.change(screen.getByLabelText('适配器命令（高级）'), { target: { value: 'node' } })
    fireEvent.click(screen.getByRole('button', { name: '保存节点' }))

    expect(await screen.findByText(zh.noWorkspaceOptionHint)).toBeDefined()
    // The raw English detail is replaced by the localized actionable hint.
    expect(screen.queryByText(/cannot save this node/)).toBeNull()
  })
})
