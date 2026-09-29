/** Client plugin: the Zcode workbench task center panel and node settings section. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import remoteContribution from '@deepseek-ai/dsh-experimental-zcode-workbench/remote'
import type {
  IngressInfo, WorkbenchComposeRequest, WorkbenchContinueRequest, WorkbenchNodeInput, WorkbenchRouteRequest,
  WorkbenchTaskDetailView, WorkbenchTaskView, WorkspaceTasksView, ZcodeWorkspaceListing,
} from '../types.ts'
import { en, zh, type WorkbenchKey } from './locales.ts'
import {
  NodeSettings, TaskCenterPanel, notifyWorkbenchRefresh, readWorkbenchPanelOpenIntent,
  type WorkbenchActions, type WorkbenchConnection, type WorkbenchRuntimeState, ZcodePanelIcon,
} from './Panel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'zcode.workbench': WorkbenchKey }
}

/** Required runtime contributions: slots, locale, and the Remote transport. */
export const inject = ['slots', 'locale', 'remote']

/** Keyed `main` slot entry that hosts the task center. */
const WORKBENCH_PANEL_KEY = 'zcode-tasks'

/** Structural seat of `ctx.connection` the recovery glue reads (no package edge added). */
interface ConnectionStateSeat {
  readonly state: {
    getSnapshot(): 'connected' | 'connecting' | 'disconnected' | undefined
    subscribe(listener: () => void): () => void
  }
}

/** Structural seat of `ctx.layout` the recovery glue writes through. */
interface LayoutSeat {
  selectPanel(panelId: string | null): void
}

/** Structural seat for the connection-reset event subscription. */
interface ConnectionResetSeat {
  on(event: 'connection/reset', listener: () => void): () => void
}

/** Unwrap one Remote result into a plain value or a thrown Error. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

/** @param ctx - Client context owning the workbench surfaces. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(remoteContribution)
  // Filled by the recovery glue fiber below; read through the actions face's
  // getter so surfaces re-render with the live connection state as soon as
  // the shell provides the connection service.
  const runtime: { connection?: WorkbenchConnection } = {}
  ctx.inject(['remote.zcodeWorkbench'], (ctx) => {
    const actions: WorkbenchActions & Partial<WorkbenchRuntimeState> = {
      nodes: async () => unwrap(await ctx.remote.zcodeWorkbench.nodes()),
      saveNode: async (input: WorkbenchNodeInput) => unwrap(await ctx.remote.zcodeWorkbench.saveNode(input)),
      removeNode: async (id: string) => unwrap(await ctx.remote.zcodeWorkbench.removeNode(id)),
      checkNode: async (id: string) => unwrap(await ctx.remote.zcodeWorkbench.checkNode(id)),
      listWorkspaces: async (id: string) => unwrap(await ctx.remote.zcodeWorkbench.listWorkspaces(id)) as ZcodeWorkspaceListing,
      workspaceTasks: async (id: string, workspacePath: string) =>
        unwrap(await ctx.remote.zcodeWorkbench.workspaceTasks(id, workspacePath)) as WorkspaceTasksView,
      tasks: async () => unwrap(await ctx.remote.zcodeWorkbench.tasks()) as WorkbenchTaskView[],
      task: async (id: string) => unwrap(await ctx.remote.zcodeWorkbench.task(id)) as WorkbenchTaskDetailView | undefined,
      composeTask: async (request: WorkbenchComposeRequest) => unwrap(await ctx.remote.zcodeWorkbench.composeTask(request)),
      continueDesktopTask: async (request: WorkbenchContinueRequest) =>
        unwrap(await ctx.remote.zcodeWorkbench.continueDesktopTask(request)),
      routeTask: async (request: WorkbenchRouteRequest) => unwrap(await ctx.remote.zcodeWorkbench.routeTask(request)),
      retryTask: async (id: string) => unwrap(await ctx.remote.zcodeWorkbench.retryTask(id)),
      cancelTask: async (id: string) => unwrap(await ctx.remote.zcodeWorkbench.cancelTask(id)),
      ingressInfo: async () => unwrap(await ctx.remote.zcodeWorkbench.ingressInfo()) as IngressInfo,
      get connection(): WorkbenchConnection | undefined { return runtime.connection },
    }
    ctx.effect(() => ctx.locale.register('zcode.workbench', { en, zh }), 'zcode workbench locales')
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: WORKBENCH_PANEL_KEY,
      locale: 'zcode.workbench',
      inject: () => actions,
    }, TaskCenterPanel))
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: WORKBENCH_PANEL_KEY,
      order: 30,
      locale: 'zcode.workbench',
      label: () => ctx.locale.bind('zcode.workbench')('taskCenter'),
    }, ZcodePanelIcon))
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'zcode-nodes',
      order: 30,
      locale: 'zcode.workbench',
      label: () => ctx.locale.bind('zcode.workbench')('nodesTitle'),
      inject: () => actions,
    }, NodeSettings))
    // Host-restart recovery glue: publish the live connection state to the
    // surfaces, and on every re-established generation (a) wake the mounted
    // surfaces for an immediate re-pull and (b) re-select the task center
    // panel when it was showing before the outage — restart-time slot churn
    // resets the shell's panel selection, and the old tab must return to the
    // workbench by itself instead of staying on a blank/reset shell.
    ctx.inject(['connection', 'layout'], (recovery) => {
      const connection = recovery.get('connection') as ConnectionStateSeat | undefined
      const layout = recovery.get('layout') as LayoutSeat | undefined
      if (connection !== undefined) {
        runtime.connection = {
          getSnapshot: () => connection.state.getSnapshot() ?? 'connecting',
          subscribe: listener => connection.state.subscribe(listener),
        }
      }
      const recover = (): void => {
        notifyWorkbenchRefresh()
        if (layout === undefined || !readWorkbenchPanelOpenIntent()) return
        if (!recovery.slots.entries('main').some(entry => entry.options.key === WORKBENCH_PANEL_KEY)) return
        try {
          layout.selectPanel(WORKBENCH_PANEL_KEY)
        } catch (error) {
          console.error('[zcode-workbench] re-selecting the task center after reconnect failed:', error)
        }
      }
      ;(recovery as unknown as ConnectionResetSeat).on('connection/reset', recover)
    })
  })
  return unmount
}
