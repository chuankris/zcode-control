// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeSettings, TaskCenterPanel, type WorkbenchActions, type WorkbenchPanelProps, type NodeSettingsProps } from '../src/client/Panel.tsx'
import { zh, type WorkbenchKey } from '../src/client/locales.ts'
import type { WorkbenchNodeInput, WorkbenchTaskView, WorkspaceTasksView, ZcodeNodeView, ZcodeWorkspaceListing } from '../src/types.ts'

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

/** A workspace listing with one desktop-only row and one joined workbench row. */
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
    workbench: [viewOf('WB-20260921-001')],
  }
}

/** A minimal wire-shaped task view for spy return values. */
function viewOf(id: string): WorkbenchTaskView {
  return {
    workbenchTaskId: id, source: 'workbench', sourceTaskId: null, threadId: null, title: 't',
    promptPreview: 'p', status: 'dispatching', zcodeDelivery: 'pending', awaitingInput: false,
    echoLost: false, lastError: null, nodeId: 'site-1', nodeLabel: 'n', workspacePath: '/w',
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
    workspaceTasks: async () => fixtureWorkspaceTasks(),
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

  it('renders the three delivery stages without ever showing a bare 已送达', async () => {
    const task = (over: Partial<WorkbenchTaskView>): WorkbenchTaskView => ({ ...viewOf('WB-20260921-001'), ...over })
    render(<TaskCenterPanel {...panelProps({
      tasks: async () => [
        task({ workbenchTaskId: 'WB-A', title: '已提交任务', status: 'zcode_acknowledged', zcodeDelivery: 'acknowledged' }),
        task({ workbenchTaskId: 'WB-B', title: '远端执行任务', status: 'running', zcodeDelivery: 'running' }),
        task({ workbenchTaskId: 'WB-C', title: '回显丢失任务', status: 'zcode_acknowledged', zcodeDelivery: 'echo_lost', echoLost: true }),
      ],
    })} />)
    expect(await screen.findByText('✓ 已提交 · 确认中')).toBeDefined()
    expect(screen.getByText('✓ 已送达 · 远端执行中')).toBeDefined()
    expect(screen.getByText('✓ 结果未知 · 先核实桌面')).toBeDefined()
    expect(screen.queryByText('已送达')).toBeNull()
    expect(screen.queryByText('✓ 已送达')).toBeNull()
    expect(screen.getAllByText('已提交').length).toBeGreaterThan(0)
  })
})

describe('task center panel', () => {
  it('keeps send disabled until node, workspace, and prompt are all set', async () => {
    const composeTask = vi.fn(async () => viewOf('WB-20260921-001')) as NonNullable<WorkbenchActions['composeTask']>
    render(<TaskCenterPanel {...panelProps({ composeTask })} />)

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    const send = await screen.findByRole('button', { name: '发送任务' })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('请先选择执行节点和工作区。')).toBeDefined()

    const selects = screen.getAllByRole('combobox')
    const nodeSelect = selects[0]!
    const workspaceSelect = selects[1]!
    fireEvent.change(nodeSelect, { target: { value: 'site-1' } })
    await waitFor(() => { expect(workspaceSelect.querySelector('option[value="/site/default"]')).not.toBeNull() })
    fireEvent.change(workspaceSelect, { target: { value: '/site/default' } })
    expect(screen.getByText('执行位置已就绪，请描述任务。')).toBeDefined()
    expect((send as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByRole('textbox', { name: '任务描述' }), { target: { value: 'fixture prompt' } })
    expect((send as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('任务将发送到：现场节点 / /site/default。')).toBeDefined()

    fireEvent.click(send)
    await waitFor(() => { expect(composeTask).toHaveBeenCalledWith({ title: '', prompt: 'fixture prompt', nodeId: 'site-1', workspacePath: '/site/default' }) })
  })

  it('routes an awaiting-route Codex task through the same gated form', async () => {
    const routeTask = vi.fn(async () => viewOf('WB-20260921-009')) as NonNullable<WorkbenchActions['routeTask']>
    const props = panelProps({
      routeTask,
      tasks: async () => [{
        workbenchTaskId: 'WB-20260921-009', source: 'codex', sourceTaskId: 'c1', threadId: 't1',
        title: 'Codex 任务', promptPreview: 'p', status: 'awaiting_route', zcodeDelivery: 'pending',
        awaitingInput: false, echoLost: false, lastError: null, nodeId: null, nodeLabel: null,
        workspacePath: null, workspaceLabel: null, acpSessionId: null, desktopTaskId: null,
        createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
      }],
      task: async () => ({
        workbenchTaskId: 'WB-20260921-009', source: 'codex', sourceTaskId: 'c1', threadId: 't1',
        title: 'Codex 任务', promptPreview: 'full prompt body', status: 'awaiting_route', zcodeDelivery: 'pending',
        awaitingInput: false, echoLost: false, lastError: null, nodeId: null, nodeLabel: null,
        workspacePath: null, workspaceLabel: null, acpSessionId: null, desktopTaskId: null,
        createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
        transcript: [], retryAllowed: false,
      }),
    })
    render(<TaskCenterPanel {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: '选择位置' }))

    const selects = await screen.findAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'site-1' } })
    await waitFor(() => { expect(selects[1]!.querySelector('option[value="/site/default"]')).not.toBeNull() })
    fireEvent.change(selects[1]!, { target: { value: '/site/default' } })
    // The preset prompt loads asynchronously; once it lands the form is sendable.
    const promptBox = screen.getByRole('textbox', { name: '任务描述' }) as HTMLTextAreaElement
    await waitFor(() => { expect(promptBox.value).toBe('full prompt body') })
    const send = screen.getByRole('button', { name: '发送任务' })
    expect((send as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(send)
    await waitFor(() => { expect(routeTask).toHaveBeenCalledWith({ workbenchTaskId: 'WB-20260921-009', nodeId: 'site-1', workspacePath: '/site/default' }) })
  })

  it('allows a fixed node to select its private pinned workspace', async () => {
    const composeTask = vi.fn(async () => viewOf('WB-20260921-010')) as NonNullable<WorkbenchActions['composeTask']>
    render(<TaskCenterPanel {...panelProps({
      composeTask,
      listWorkspaces: async () => ({
        options: [{ path: '__fixed__', label: '本机 Zcode · pinned in node configuration' }],
        desktopVersion: null,
      }),
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    const selects = await screen.findAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'local-1' } })
    await waitFor(() => { expect(selects[1]!.querySelector('option[value="__fixed__"]')).not.toBeNull() })
    fireEvent.change(selects[1]!, { target: { value: '__fixed__' } })
    fireEvent.change(screen.getByRole('textbox', { name: '任务描述' }), { target: { value: 'read-only fixture' } })
    const send = screen.getByRole('button', { name: '发送任务' })
    expect((send as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(send)
    await waitFor(() => { expect(composeTask).toHaveBeenCalledWith({
      title: '', prompt: 'read-only fixture', nodeId: 'local-1', workspacePath: '__fixed__',
    }) })
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

describe('workspace capability consistency in the composer', () => {
  it('maps a no-workspace-option listing failure to the actionable hint instead of a cryptic error', async () => {
    render(<TaskCenterPanel {...panelProps({
      listWorkspaces: async () => {
        throw new Error('the node\'s adapter answered session/new without offering a workspace option — it looks like a fixed-workspace adapter (or an adapter too old for per-session selection); save the node as fixed, or enable per-session workspace selection in the adapter configuration')
      },
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    const selects = await screen.findAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'site-1' } })
    expect(await screen.findByText(zh.noWorkspaceOptionHint)).toBeDefined()
    expect(screen.queryByText(/looks like a fixed-workspace adapter/)).toBeNull()
    // The send stays gated: there is no dispatchable workspace.
    expect((screen.getByRole('button', { name: '发送任务' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('workspace task browser in the composer', () => {
  /** Selects node site-1 and workspace path through the composer form. */
  async function selectRoute(workspacePath: string): Promise<void> {
    const selects = await screen.findAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'site-1' } })
    await waitFor(() => { expect(selects[1]!.querySelector(`option[value="${workspacePath}"]`)).not.toBeNull() })
    fireEvent.change(selects[1]!, { target: { value: workspacePath } })
  }

  it('shows the workspace tasks once the route is complete, grouped by source', async () => {
    const workspaceTasks = vi.fn(async () => fixtureWorkspaceTasks()) as NonNullable<WorkbenchActions['workspaceTasks']>
    render(<TaskCenterPanel {...panelProps({ workspaceTasks })} />)
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    // Before the route is complete only the hint shows.
    expect(screen.getByText('选择节点和工作区后，即可查看该工作区的任务。')).toBeDefined()

    await selectRoute('/site/default')
    expect(await screen.findByRole('region', { name: '该工作区的任务' })).toBeDefined()
    expect(screen.getByText('Zcode 已同步任务')).toBeDefined()
    expect(screen.getByText('工作台已记录任务')).toBeDefined()
    // Desktop rows: title, localized status, origin badge, abbreviated id.
    expect(screen.getByText('桌面创建的任务')).toBeDefined()
    expect(screen.getByText('运行中')).toBeDefined()
    expect(screen.getByText('Zcode 桌面')).toBeDefined()
    expect(screen.getByText(/sess-11112…/)).toBeDefined()
    expect(screen.queryByText(/sess-11112222333344445555/)).toBeNull()
    // The joined desktop row carries the workbench binding.
    expect(screen.getByText('工作台派发')).toBeDefined()
    // Workbench rows: id, source badge, ACP session id abbreviated.
    expect(screen.getByText(/WB-20260921-001/)).toBeDefined()
    expect(screen.queryByText(/fake-acp-session-1/)).toBeNull()
    // Refresh re-pulls the listing.
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(workspaceTasks).toHaveBeenCalledTimes(2) })
  })

  it('keeps workbench rows visible when the desktop facet is unavailable', async () => {
    const listing = fixtureWorkspaceTasks()
    listing.desktop = { state: 'unavailable', reason: 'the desktop task listing failed' }
    render(<TaskCenterPanel {...panelProps({ workspaceTasks: async () => listing })} />)
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    await selectRoute('/site/default')
    expect(await screen.findByText(/Zcode 已同步任务暂不可用：the desktop task listing failed/)).toBeDefined()
    expect(screen.getByText(/WB-20260921-001/)).toBeDefined()
  })

  it('clears the previous workspace rows when the workspace switches', async () => {
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
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    await selectRoute('/site/default')
    expect(await screen.findByText('桌面创建的任务')).toBeDefined()

    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[1]!, { target: { value: '/site/progo' } })
    await waitFor(() => { expect(screen.getByText('该工作区暂无 Zcode 已同步任务。')).toBeDefined() })
    expect(screen.getByText('该工作区暂无工作台已记录任务。')).toBeDefined()
    // The default workspace's rows never leak into the progo listing.
    expect(screen.queryByText('桌面创建的任务')).toBeNull()
    expect(screen.queryByText(/WB-20260921-001/)).toBeNull()
  })

  it('shows an error state when the listing RPC itself fails', async () => {
    render(<TaskCenterPanel {...panelProps({
      workspaceTasks: async () => { throw new Error('工作台服务暂不可用') },
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    await selectRoute('/site/default')
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText('工作台服务暂不可用')).toBeDefined()
    expect(screen.queryByText('Zcode 已同步任务')).toBeNull()
  })

  it('opens the existing task detail from a joined desktop row', async () => {
    render(<TaskCenterPanel {...panelProps({
      task: async () => ({
        workbenchTaskId: 'WB-20260921-001', source: 'workbench', sourceTaskId: null, threadId: null,
        title: '绑定任务的详情', promptPreview: 'p', status: 'completed', zcodeDelivery: 'terminal',
        awaitingInput: false, echoLost: false, lastError: null, nodeId: 'site-1', nodeLabel: '现场节点',
        workspacePath: '/site/default', workspaceLabel: 'default', acpSessionId: 'fake-acp-session-1', desktopTaskId: null,
        createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T01:05:00.000Z',
        transcript: [], retryAllowed: false,
      }),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    await selectRoute('/site/default')
    const viewButtons = await screen.findAllByRole('button', { name: '查看任务' })
    fireEvent.click(viewButtons[0]!)
    expect(await screen.findByText('绑定任务的详情')).toBeDefined()
    expect(screen.getByText('统一任务编号')).toBeDefined()
  })
})

/** Workspace listing shaped for continuation: one completed desktop row, one running, one error. */
function continuationWorkspaceTasks(): WorkspaceTasksView {
  return {
    nodeId: 'site-1',
    workspacePath: '/site/default',
    desktop: {
      state: 'ok',
      desktopVersion: '3.14.0',
      tasks: [
        {
          taskId: 'dtask-legacy-9999xxxx', title: '已完成的桌面任务', status: 'completed',
          createdAt: '2026-09-21T04:00:00.000Z', updatedAt: '2026-09-21T04:20:00.000Z',
          origin: 'desktop', workbenchTaskId: null,
        },
        {
          taskId: 'sess-11112222333344445555', title: '桌面创建的任务', status: 'running',
          createdAt: '2026-09-21T02:00:00.000Z', updatedAt: '2026-09-21T02:10:00.000Z',
          origin: 'desktop', workbenchTaskId: null,
        },
        {
          taskId: 'dtask-err-00000000001', title: '出错的桌面任务', status: 'error',
          createdAt: '2026-09-21T03:00:00.000Z', updatedAt: '2026-09-21T03:30:00.000Z',
          origin: 'desktop', workbenchTaskId: null,
        },
      ],
    },
    workbench: [],
  }
}

describe('continuing a desktop task from the workspace browser', () => {
  /** Selects node site-1 and the default workspace through the composer form. */
  async function selectRoute(): Promise<void> {
    const selects = await screen.findAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'site-1' } })
    await waitFor(() => { expect(selects[1]!.querySelector('option[value="/site/default"]')).not.toBeNull() })
    fireEvent.change(selects[1]!, { target: { value: '/site/default' } })
  }

  it('selects one completed desktop row and sends the follow-up through continueDesktopTask', async () => {
    const continueDesktopTask = vi.fn(async () => viewOf('WB-20260922-001')) as NonNullable<WorkbenchActions['continueDesktopTask']>
    render(<TaskCenterPanel {...panelProps({
      workspaceTasks: async () => continuationWorkspaceTasks(),
      continueDesktopTask,
      task: async () => ({
        workbenchTaskId: 'WB-20260922-001', source: 'workbench', sourceTaskId: null, threadId: null,
        title: '后续轮记录', promptPreview: '第二轮指令', status: 'completed', zcodeDelivery: 'terminal',
        awaitingInput: false, echoLost: false, lastError: null, nodeId: 'site-1', nodeLabel: '现场节点',
        workspacePath: '/site/default', workspaceLabel: 'default', acpSessionId: 'fake-acp-session-1',
        desktopTaskId: 'dtask-legacy-9999xxxx',
        createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:05:00.000Z',
        transcript: [], retryAllowed: false,
      }),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    await selectRoute()
    expect(await screen.findByText('已完成的桌面任务')).toBeDefined()
    expect(screen.getByText(/在列表中选择一条“已完成”的 Zcode 已同步任务/)).toBeDefined()

    // Only the completed row is selectable; running and error rows state why not.
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect((radios[0] as HTMLInputElement).disabled).toBe(false)
    expect((radios[1] as HTMLInputElement).disabled).toBe(true)
    expect((radios[2] as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('任务运行中，结束后才能继续。')).toBeDefined()
    expect(screen.getByText('任务已出错，此处不支持继续。')).toBeDefined()

    fireEvent.click(radios[0]!)
    // The selection card names the original task, its id, and the workspace.
    expect(await screen.findByText('继续原任务')).toBeDefined()
    expect(screen.getByText(/原任务：已完成的桌面任务（dtask-lega…）· 现场节点 \/ \/site\/default/)).toBeDefined()
    expect(screen.getByText('后续指令将发送到 Zcode 桌面中的这条原任务——桌面端仍是同一条任务。')).toBeDefined()

    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder!), { target: { value: '第二轮指令' } })
    const send = screen.getByRole('button', { name: '发送后续指令' })
    expect((send as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(send)
    await waitFor(() => { expect(continueDesktopTask).toHaveBeenCalledWith({
      nodeId: 'site-1', workspacePath: '/site/default', desktopTaskId: 'dtask-legacy-9999xxxx',
      prompt: '第二轮指令', title: '',
    }) })
    // The dispatched continuation round opens its own detail with the original task named.
    expect(await screen.findByText('后续轮记录')).toBeDefined()
    expect(screen.getByText(/原桌面任务 dtask-lega…/)).toBeDefined()
  })

  it('clearing the selection returns the form to new-task composition', async () => {
    const continueDesktopTask = vi.fn(async () => viewOf('WB-1')) as NonNullable<WorkbenchActions['continueDesktopTask']>
    const composeTask = vi.fn(async () => viewOf('WB-2')) as NonNullable<WorkbenchActions['composeTask']>
    render(<TaskCenterPanel {...panelProps({
      workspaceTasks: async () => continuationWorkspaceTasks(), continueDesktopTask, composeTask,
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    await selectRoute()
    fireEvent.click((await screen.findAllByRole('radio'))[0]!)
    expect(await screen.findByRole('button', { name: '清除选择' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '清除选择' }))
    expect(screen.queryByText('清除选择')).toBeNull()
    expect(screen.getByRole('button', { name: '发送任务' })).toBeDefined()
    expect((screen.getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(false)

    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder!), { target: { value: '全新任务' } })
    fireEvent.click(screen.getByRole('button', { name: '发送任务' }))
    await waitFor(() => { expect(composeTask).toHaveBeenCalledTimes(1) })
    expect(continueDesktopTask).not.toHaveBeenCalled()
  })

  it('drops the selection when the workspace switches', async () => {
    const perPath: Record<string, WorkspaceTasksView> = {
      '/site/default': continuationWorkspaceTasks(),
      '/site/progo': {
        nodeId: 'site-1', workspacePath: '/site/progo',
        desktop: { state: 'ok', desktopVersion: '3.14.0', tasks: [] },
        workbench: [],
      },
    }
    render(<TaskCenterPanel {...panelProps({
      workspaceTasks: async (_nodeId, path) => perPath[path] ?? continuationWorkspaceTasks(),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    await selectRoute()
    fireEvent.click((await screen.findAllByRole('radio'))[0]!)
    expect(await screen.findByText('继续原任务')).toBeDefined()

    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[1]!, { target: { value: '/site/progo' } })
    // The empty progo listing renders; the selection card is gone without a stale notice.
    await waitFor(() => { expect(screen.getByText('该工作区暂无 Zcode 已同步任务。')).toBeDefined() })
    expect(screen.queryByText('继续原任务')).toBeNull()
    expect(screen.queryByText(/选择已清除/)).toBeNull()
  })

  it('re-verifies the selection on refresh and clears it with a notice when the task disappears', async () => {
    let listing = continuationWorkspaceTasks()
    render(<TaskCenterPanel {...panelProps({ workspaceTasks: async () => listing })} />)
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    await selectRoute()
    fireEvent.click((await screen.findAllByRole('radio'))[0]!)
    expect(await screen.findByText('继续原任务')).toBeDefined()

    listing = { nodeId: 'site-1', workspacePath: '/site/default', desktop: { state: 'ok', desktopVersion: '3.14.0', tasks: [] }, workbench: [] }
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText(/所选任务在最新列表中已无法确认“已完成”，选择已清除。/)).toBeDefined()
    expect(screen.queryByText('继续原任务')).toBeNull()
    expect(screen.getByRole('button', { name: '发送任务' })).toBeDefined()
  })

  it('marks continuation rounds in the task list with their original desktop task', async () => {
    const round = { ...viewOf('WB-20260922-001'), desktopTaskId: 'dtask-legacy-9999xxxx', title: '后续轮记录' }
    render(<TaskCenterPanel {...panelProps({ tasks: async () => [round] })} />)
    expect(await screen.findByText('后续轮记录')).toBeDefined()
    expect(screen.getAllByText('继续原任务').length).toBeGreaterThan(0)
    expect(screen.getByText(/原桌面任务 dtask-lega…/)).toBeDefined()
  })
})
