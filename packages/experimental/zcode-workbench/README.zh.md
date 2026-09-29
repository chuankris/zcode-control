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

任务中心面板以工作区为入口。首页先列节点与连接状态，点开一个节点才为该节点做一次工作区发现（只为正在查看的节点发现，绝不按 2–3 秒轮询所有工作区——每次发现都占用该设备唯一的远控控制通道）；只有一个可用节点时自动展开。首页工作区卡片显示的是可确认的**工作台会话数**——与统一列表同一口径：已绑定轮次按已验证 `desktopTaskId` 聚合成一会话，未绑定记录各计一条，绝不以此猜测桌面原生任务总数；最近活动时间取该工作区全部轮次的最新值。进入工作区后是统一任务列表：Zcode 桌面端自己的已同步任务索引（经适配器只读 `--list-tasks` 模式读取，仅含该工作区已同步、未置顶、未归档的任务——这是桌面的真实能力边界）与本存储的工作台轮次，按已验证身份 `(nodeId, workspaceIdentity, desktopTaskId)` 合成一行——桌面行与工作台记录只在记录自身携带同一 `desktopTaskId` 或 Host 端适配器绑定 join 命中时合并，绝不按标题、短 ID 或路径猜测合并，同一路径出现在不同节点时严格隔离。新建轮自身的 `desktopTaskId` 由 Host 在首次读到桌面索引时依据适配器行内已验证的 `dshSessionId → taskId` 绑定保守回填（仅限尚无 `desktopTaskId` 的记录、会话唯一指向一个任务；绑定缺失或冲突时不写任何东西），因此轮次链在完成后、Host 重启后和索引暂不可用时都保持同一桌面会话一行多轮。索引读取失败时工作台行保持可见、桌面侧显示”暂不可用”与原因；行数达到适配器上限时明示”仅显示最近 200 条”；列表标注桌面索引的采样时间，只在进入工作区、手动刷新或某一轮派发结束后读取。状态筛选为”全部／进行中／已完成／需处理”，需处理与在途任务排前、其余按最近活动倒序。窄屏按”工作区 → 列表 → 详情／新建”逐级导航，宽屏（≥1080px）三栏并排且沿用同一状态。

任务详情结果优先：标题与主状态 → 原问题 → 对话内容（助手文本按安全 Markdown 子集渲染——不解析原始 HTML，仅 http(s) 链接成为可点链接，代码块横向滚动）→ 续写输入 → 默认折叠的”运行详情”（完整任务 ID、送达阶段、状态轨迹与回报状态，诊断时可复制）。`reported` 不再覆盖真实终态：记录与 wire view 保留 `terminalOutcome`，主状态与详情按真实执行结果显示，早于该字段的存量记录从状态轨迹恢复，无法恢复时显示”结果待核实”——“已回报”只在运行详情出现。同一桌面任务的多轮续写在详情里按时间串联，每轮保留自己的描述、错误与回复；较早的轮次各自加载一次，读取迟到或瞬时失败不会丢失（迟到结果照常落位，失败按有界次数重试，确认缺失的轮次不再重试）。原生桌面任务的详情读取桌面自己的只读快照（第二阶段）：打开详情或手动刷新时经 `desktopTaskSnapshot` Remote 一次性读取适配器的 `--task-snapshot` 模式——先按节点、工作区与完整 `desktopTaskId` 在该工作区自己的已同步索引中验证身份，再走官方订阅路径读取对话快照；打开详情绝不 `session/adopt`、不改变桌面任务、不抢占执行中的控制权（读取经节点队列与派发串行，占用时延后而非并发配对）。快照按桌面原序渲染有界、脱敏的用户／助手／工具摘要（助手文本同样走安全 Markdown），尾窗口显示”仅显示最近内容”；读取失败明确显示 `unavailable` 与原因，绝不用工作台 transcript 伪装桌面对话，也不在定时器上轮询。

新建任务从工作区进入时预选节点与工作区（表单不再重复选择，但发送前清楚显示目标；服务端仍重新验证位置，首轮派发后路由锁定）；全局”新建任务”入口保留完整的节点/工作区选择。未路由的 Codex 任务在首页以”待选择位置”出现，路由表单只读显示原任务的描述，原文加载完成前发送保持禁用——绝不会因竞场误建第二条任务。继续一条已完成的桌面任务是详情内明确的第二种模式：”继续这个任务”仅当桌面索引证明 `completed` 且该桌面任务没有在途或结果未知的轮次时启用，禁用时显示原因（运行中、已出错、状态未知、索引不可用、已置顶/归档不可验证等）。发送走独立的 `continueDesktopTask` 请求：该轮记录为一条携带原 `desktopTaskId` 的独立任务，适配器的 `session/adopt` 先以桌面自身的 `zcode-task/listTasks` 索引与实时会话快照验证该任务（属于所选工作区、已完成、无待处理交互）再建立绑定，随后指令经 `sendText`/`startNow` 发往同一条桌面任务——适配器绝不退化为新建替代任务。同一节点/工作区下，一条桌面任务同时最多允许一轮在途后续（已有运行中或结果未知的轮次时再次提交会被拒绝）；已由工作台派发过的任务复用既有绑定。提交成功后仍停留在同一桌面任务的详情里展示新的一轮并标注”确认中／运行中”。

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
- **Client**（`src/client/`）：注册 `main` 面板 `zcode-tasks`（工作区优先首页、按工作区的统一任务列表、结果优先的安全 Markdown 详情与折叠运行详情、快照驱动的原生任务详情、预选工作区的新建）和节点的 `settings.section` 页；全部文案归 locale（`zcode.workbench` 命名空间，zh 按类型键完备）；可见时轮询更新。生成的 Typert remote 贡献提供 RPC 面。
- **任务中心投影**（`src/taskCenter.ts`）：客户端共用的纯合并层——桌面索引行与工作台轮次按 `(nodeId, 工作区, desktopTaskId)` 合成 `TaskCenterItem`，主状态由证据推导（最新轮次失败不会被滞后的索引样本掩盖）、续写门槛、排序与筛选都在这里；无 I/O、不修改任何持久状态。
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
