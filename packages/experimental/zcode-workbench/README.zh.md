---
description: "Harness 的 Zcode 工作台任务中心、节点路由与桌面可见派发。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-zcode-workbench

[English](README.md) | 中文

## 概述

让 Codex 和工作台本身把任务交给桌面可见的 Zcode 节点的任务中心。同一个 `workbenchTaskId` 贯穿三端；工作台在任何派发之前选定执行节点与工作区；派发经由已验证的 ACP 适配器程序（`integrations/zcode-desktop-adapter`），不重新实现 Zcode 远程协议。本私有插件提供主面板（任务列表、新建、任务详情）、节点设置页、本机 Codex ingress 和持久任务存储；不改变会话格式，不新增模型可见输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 使用本包

<a id="use-this-package"></a>

在既有 Web dsh profile 中安装本包，并通过 profile 的 patch 层插入包名：

```yaml
- insert:
    - id: zcode-workbench
      name: '@deepseek-ai/dsh-experimental-zcode-workbench'
      config:
        stateDir: "<private directory outside this repository>"
        ingressPath: "/zcode-workbench/ingress"
        ingressTokenFile: "<private token file path>"
```

`stateDir` 保存持久的任务与节点记录；`ingressTokenFile` 保存 Codex ingress 要求的 Bearer 令牌（至少 16 个字符；文件存在前路由返回 503）。这两个文件都不应放进仓库。

在 设置 → Zcode 节点 注册节点。一个节点就是一个 ACP agent 启动器：`command` 加 `args`，指向适配器的私有 `--config` JSON。生产环境中命令启动 `integrations/zcode-desktop-adapter/adapter.mjs`；连接 URL 文件路径等私有设置只存在于该配置文件中，工作台从不读取它。`workspaceSelection: session` 的节点通过只读的 `session/new` 发现列出现场自己的工作区，任务表单从现场实时列表中选择；`fixed` 节点在适配器配置中固定一个工作区。

在任务中心面板新建任务：先选节点和工作区（两者必选——未完成且未填写任务描述前发送按钮保持禁用），描述任务后发送。路由在首次派发后锁定。选定节点和工作区后，任务创建区域还会分两组明确列出该工作区的任务：**Zcode 已同步任务**——经适配器只读 `--list-tasks` 模式实时读取的 Zcode 桌面端自己的任务索引（桌面的真实能力边界——仅含该工作区已同步、未置顶、未归档的任务）；**工作台已记录任务**——本存储中按节点和工作区过滤的记录。适配器绑定拥有的桌面行会连接到对应工作台任务（“查看任务”进入既有详情）；桌面列表读取失败时显示原因，绝不伪造。

继续其中一条桌面任务是与“新建任务”明确分开的第二种模式，绝不复用含糊的全新任务语义：每条 Zcode 已同步任务行带一个单选框，仅当该行可验证为“已完成”时可选（运行中、出错、未知状态的行给出不可继续的原因）。选中后显示原任务标题、缩略任务 ID 和当前工作区，说明后续指令将发送到这条原任务，并可清除选择；切换节点或工作区即清除选择，每次刷新列表都会重新校验——任务从索引消失或不再“已完成”时带提示清除选择，陈旧数据绝不越过刷新存活。发送走独立的 `continueDesktopTask` 请求：该轮记录为一条携带原 `desktopTaskId` 的独立任务，适配器的 `session/adopt` 先以桌面自身的 `zcode-task/listTasks` 索引与实时会话快照验证该任务（属于所选工作区、已完成、无待处理交互）再建立绑定，随后指令经 `sendText`/`startNow` 发往同一条桌面任务——适配器绝不退化为新建替代任务。同一节点/工作区下，一条桌面任务同时最多允许一轮在途后续（已有运行中或结果未知的轮次时再次提交会被拒绝）；已由工作台派发过的任务复用既有绑定，不建第二个。续写轮在列表、详情头部与信息栏以“继续原任务”徽标加原桌面任务 ID 展示，与本轮自己的任务描述并列。

回执丢失（`echoLost`，例如提示离开后中继链路断开）的轮次有意保留这把锁：桌面结果未知，同一条原桌面任务在有人于现场核实之前拒绝新的后续。释放它的是 `reconcileEchoLostFollowup` 维护 Remote——操作者流程而非面板界面：不带 `confirm` 时运行节点适配器的只读 `--reconcile-dispatch` 证据收集并返回现场事实（任务状态、更新时间、实时 phase、待处理交互、旧指令是否仍出现在桌面会话中）；带 `confirm: { humanVerified: true, operator }` 时重新核验同一批证据并核销该轮——站点适配器在同一核验下清除其未决派发台账，本存储向 `stateDir/reconcile-ledger.jsonl` 追加一条审计记录（任务、节点、工作区、桌面任务 ID、原命令 ID、证据摘要、模式、操作者、时间——绝不包含 prompt 正文或凭据），记录离开结果未知状态。此后 `continueDesktopTask` 接受同一条原桌面任务上的**新**后续。核销绝不重发旧指令、绝不创建桌面任务，并在每个相反信号上保守拒绝：仍在派发、非回执丢失、非续写轮、节点缺失、旧指令出现在桌面会话、任务运行中/等待输入、任务状态未知、证据不可读、重复核销。

Codex 来源的任务经本机 ingress 进入：

```sh
curl -X POST http://127.0.0.1:<port>/zcode-workbench/ingress/tasks \
  -H "Authorization: Bearer $(cat <token file>)" \
  -d '{"source":"codex","sourceTaskId":"<codex task id>","threadId":"<thread>","prompt":"..."}'
```

创建按 `source` + `sourceTaskId` + `threadId` 幂等：重复提交返回同一个 `workbenchTaskId` 且 `created: false`。`GET .../tasks/<workbenchTaskId>` 把状态回报给 Codex，并把终态任务标记为 `reported`。ingress 只接受回环地址，且必须持有令牌。

## 理解实现

<a id="understand-the-implementation"></a>

<details>
<summary>实现说明</summary>

- **任务状态机**（`src/state.ts`）：`received → awaiting_route → dispatching → zcode_acknowledged → running → completed/failed/cancelled → reported`，非法迁移表被所有入口共同拒绝。Zcode 送达侧面（pending / acknowledged / running / terminal / echo_lost）与执行失败分开推导，界面因此区分回显断开、执行失败和等待现场输入（适配器的审批卡片）。送达措辞跟随证据：`acknowledged` 只代表提示信封已写入节点适配器——界面措辞为「已提交 · 确认中」，绝不称「已送达」；「已送达」只在 `running`（远端已确认并执行）及之后出现；`echo_lost` 显示「结果未知 · 先核实桌面」。
- **幂等存储**（`src/store.ts`）：`stateDir` 下的单个 JSON 文件，tmp+rename 原子写并通过进程内单一链串行；按日序列号 `WB-YYYYMMDD-NNN`；保留上限永不驱逐未终态任务；transcript 有上限。
- **派发层**（`src/acp.ts`）：拉起节点的适配器程序并使用文档化的 ACP 面——`initialize`、`session/new`、`session/set_config_option`（按会话钉住工作区）、`session/adopt`（续写已存在的桌面任务）、`session/prompt`、`session/cancel`——消费 `session/update` 通知。`zcode_acknowledged` 在提示信封即将离开本进程时记录（`promptSentAt`）；此后拒绝再次派发——桌面结果可能未知。未送达前的失败可在同一任务号下重试。送达后的链路类失败保持任务非终态并置 `echoLost`，等待桌面核实。同一模块还驱动适配器的只读一次性模式：`--health` 健康探测与 `--list-tasks` 桌面任务索引列举（短生命周期进程、无会话、与同节点派发串行）；`--reconcile-dispatch` 证据/核销趟同样经短生命周期进程驱动，回执丢失轮的 prompt 正文经 stdin 送达比对，双方都不落盘。
- **续写核销**（`src/index.ts`）：`reconcileEchoLostFollowup` Remote 是回执丢失续写轮的受控维护入口。它拒绝除“回执丢失且已记录路由”之外的一切（在途轮、结果已知轮、全新任务、节点已消失），在记录自己的节点与工作区上运行适配器趟，并在人工核验 confirm 时先向只追加的 `reconcile-ledger.jsonl` 写一条审计记录、再在同一个串行化存储事务里清除记录的 `echoLost`——站点核销与记录更新之间被中断时可从适配器幂等的 `already-reconciled` 报告安全重试，重复核销则被原子拒绝。
- **Ingress**（`src/ingress.ts`）：Host web 服务器上的一条 prefix 路由（`webServer.register`——文档化扩展点，不改核心）。对重读的令牌文件做恒定时间比较，仅接受回环授权方，请求体有界，错误为固定字符串。
- **Client**（`src/client/`）：注册 `main` 面板 `zcode-tasks`（任务列表、新建、带固定绑定条与三端同步条的详情）和节点的 `settings.section` 页；全部文案归 locale（`zcode.workbench` 命名空间，zh 按类型键完备）；可见时轮询更新。生成的 Typert remote 贡献提供 RPC 面。
- **节点注册表**（`src/nodes.ts`）：只存启动器路径与标签；健康探测执行 `--health`，并与同节点的派发按节点串行，匹配中继每设备单控制通道的约束。

</details>

## 模型体验

<a id="model-experience"></a>

### Harness 会话，不经本包

#### 模型看到什么

无。本插件不贡献工具、提示词区块或会话事件；被派发的任务经适配器的 `session/prompt` 离开本插件，在 Zcode 桌面执行，不在 Harness 会话中。

#### Token 影响

无。插件不向任何 Harness 模型的上下文添加内容；适配器派发只是 Host 上的进程 I/O。

#### KV 缓存影响

无。插件不发送模型请求，也不改变任何提示前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 每次派发一轮提示；每轮续写是对原桌面任务的一个回合，上一轮结束（或经 `reconcileEchoLostFollowup` 在现场核实后核销）后才接受下一轮。
- 桌面协议无法证明丢失的后续命令“未被应用”；核销的 `humanVerified` 人工核验承担该剩余不确定性（快照尾窗口可能截断历史，派发后的任务时间戳可能是同步噪声）。证据报告呈现协议确实暴露的每一个事实，任何相反信号都拒绝而不是解锁。
- 桌面任务只有在所选工作区的已同步索引仍显示“已完成”时才能续写——置顶、归档或仍在运行的任务不在该路径内（即便陈旧列表曾给出，适配器也会拒绝）。

- 任务更新以轮询（可见时 2–3 秒）到达 Client；Typert 流或事件推送为后续项。
- 界面可在已打开的标签页中扛过 DSH Host 重启：渲染失败被限制在面板内部不再白屏整页，Host 暂不可用时显示重连状态并保留最后已知列表，连接重建后立即重拉数据，并在断连前任务中心处于展示状态时自动重新选中该面板。
- ingress 信任任何持有令牌的回环调用方；按来源限额与吊销为后续项。
- 桌面元数据依赖适配器文档化的 `--health` 行与工作区选项描述格式。
- 对真实 Zcode 现场的桌面可见验收由操作者的 Codex 轮次负责；本轮仅用封闭 fixture agent 验证派发。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>开发备注</summary>

决策记录见 Agent Note [2026-09-21-zcode-workbench-plugin.zh.md](../../../.agents/notes/implemented/feature/2026-09-21-zcode-workbench-plugin.zh.md)；续写既有桌面任务的决策记录见 [2026-09-24-zcode-workbench-continue-desktop-task.zh.md](../../../.agents/notes/implemented/feature/2026-09-24-zcode-workbench-continue-desktop-task.zh.md)；回执丢失后续的核实后核销见 [2026-09-28-zcode-workbench-reconcile-followup.zh.md](../../../.agents/notes/implemented/feature/2026-09-28-zcode-workbench-reconcile-followup.zh.md)。

</details>
