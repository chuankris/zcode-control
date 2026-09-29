# zcode-desktop-adapter

[English](README.md) | 中文

一个 ACP over stdio 的 Agent 门面：让从 `dsh-acp-adapter` 工作台提交的任务以**本机 ZCode 桌面可见任务**的形式运行，与既有的 ACP 后台节点、`zcode-hub-adapter` 节点并存。它复用已验证的 `remote-client` 传输走桌面官方远程控制通道，不重写传输：中继配对、bootstrap、精确唯一的 workspace 桥接，以及官方网页客户端使用的同一组 `zcode-agent` / `zcode-task` channel 面（`helloConversationV4`、`initializeConversationV4`、`sendConversationCommandV4` 的 `createSession` / `sendText` / `stop`，实时 V4 会话订阅 `subscribeConversationV4` / `resyncConversationV4` / `unsubscribeConversationV4` 及 `onDynamicConversationFrame` 工作区帧流，以及用于原生任务列表登记的 `zcode-task/createTask`）。回合输出只从订阅流投影；`zcode-task/getTaskSnapshot` 轮询路径刻意不用（3.14.0 桌面上该读路径的 `resumeSession` 对长任务可能返回陈旧的内存投影）。 已存在的桌面任务可通过 `session/adopt` 原地续写：先以桌面自身的 `zcode-task/listTasks` 索引与实时会话快照验证该任务，再为其建立绑定，后续指令因此走同一任务的 `sendText` / `startNow`，而不是另建替代任务。

它是外部 Agent stdio 程序，不是 DSH 应用入口：不复制插件代码、不改 `node_modules`，工作台继续使用已安装的 `@zaimokuza/dsh-acp-adapter`。

同一适配器也可以充当**现场节点**：对一台已配对的现场桌面只建一个节点（`workspaceSelection: "session"`），该站点注册的多个工作区由每个会话从站点实时返回的列表中精确选定后才能派发。见下文"现场节点"一节。

要求 Node 24，并使用 `--experimental-transform-types` 加载外部 remote-client 源码检出。该检出的依赖需单独安装；适配器不增加包依赖。

真实验收证据与剩余验证项记录在[集成清单](../../DOC/integration/zcode-desktop-manifest.json)中。

## remote-client 源码检出（跨机部署）

在上游 DSH 仓库中，`remote-client` 传输是**独立的源码检出**，不是本适配器的包依赖（测试里的 `fake-remote` fixture 只是测试替身）。本 `zcode-control` 集成仓库为可重现部署随附了固定提交的 `remote-client` 源码快照；每台目标机可直接使用该快照，也可自行准备一份 [zcode-cli](https://github.com/valeriikot/zcode-cli.git) 检出，固定在已验证提交上，并在该检出内安装其依赖：

```sh
git clone https://github.com/valeriikot/zcode-cli.git remote-client
cd remote-client
git checkout dd001952e2bac15c28d370f204c33f7d96d0d3ef
# install the checkout's own dependencies (it ships package.json / bun.lock)
```

检出内无需构建：Node 24 配合 `--experimental-transform-types`（即下文的启动参数）直接加载 TypeScript 源码，适配器会从检出根目录动态导入 `src/remote/client.ts`、`src/remote/connection-params.ts` 与 `src/remote/crc32.ts`——私有配置里的 `remoteClientRoot` 键指向该检出根目录。

## 作为 dsh-acp-adapter 的 Agent 节点接入

在插件的 Agent 设置中配置：

- command：Node 24 可执行文件的绝对路径
- arguments：`["--experimental-transform-types", "<repo>/integrations/zcode-desktop-adapter/adapter.mjs", "--config", "<私有配置文件路径>"]`

配置文件与所有私有数据都放在本仓库之外。示例：

```json
{
  "remoteClientRoot": "D:/本地工作台/zcode-lab/remote-client",
  "connectionUrlFile": "D:/local-private/zcode-desktop-url.txt",
  "workspace": "D:/site/project-a",
  "stateDir": "D:/local-private/zcode-desktop-adapter-state",
  "requestTimeoutMs": 20000,
  "pollIntervalMs": 2500,
  "turnTimeoutMs": 600000
}
```

现场节点去掉固定 `workspace`，改为按会话选择：

```json
{
  "remoteClientRoot": "D:/本地工作台/zcode-lab/remote-client",
  "connectionUrlFile": "D:/local-private/remote-site-url.txt",
  "workspaceSelection": "session",
  "siteName": "PC1-HZ20035172",
  "stateDir": "D:/local-private/remote-site-adapter-state"
}
```

## 配置

只有 `adapter.mjs --config <file>` 一种启动形式。所有键都会校验；配置错误在任何连接之前退出。

ACP 模式之外有两个只读一次性标志。`--health` 执行一次发现并打印固定字符串站点摘要（在线退出 0，离线退出 1）。`--list-tasks [<workspacePath>]` 连接一次、桥接恰好一个工作区，并通过官方 `zcode-task/listTasks` 通道读取桌面自己的已同步任务索引（`ZCodeTaskMeta` 行：任务 ID、标题、持久化状态、时间戳），输出一行 `[zcode-desktop-adapter] tasks: <json>`。session 模式必须给出工作区路径；fixed 模式不接受路径（工作区已固定在配置中）。本适配器通过已记录绑定拥有的行标记 `origin: "workbench"` 并携带 DSH 侧会话 ID，供工作台连接两份任务列表；其余行为 `origin: "desktop"`。标题经过凭据与 URL 清洗，行数有上限；列举失败以固定字符串原因退出 1——索引边界是真实的：只包含该工作区在桌面已同步、未置顶、未归档的任务，不是完整历史。

| 键 | 含义 |
| --- | --- |
| `remoteClientRoot` | 复用的 remote-client 检出路径；以动态 import 加载其中的 `src/remote/client.ts` 与 `src/remote/connection-params.ts`。 |
| `connectionUrlFile` | 存放桌面远程控制 URL（`sid`/`hash`/`t`）的文件。秘密只从这里读取；每次连接时重新读取，因此重连时会读取更新的凭据。桌面会话身份变化时拒绝旧绑定。 |
| `workspaceSelection` | `"fixed"`（默认）或 `"session"`。`"fixed"` 要求 `workspace`，保持既有的精确匹配行为；`"session"` 禁止 `workspace`：一个节点服务站点上报的全部工作区，由会话逐一选定（见下）。 |
| `workspace` | 必须与桌面已注册工作区精确唯一匹配的路径（反斜杠/尾斜杠归一化，Windows 上不区分大小写）。零个或多个匹配都是硬错误——绝不回退到桌面 default 工作区或其他机器的项目。仅当 `workspaceSelection` 为 `"fixed"` 时必填。 |
| `siteName` | 面向运维的站点标签，用于固定字符串诊断与 workspace 选项描述（默认 `remote site`）。绝不从连接 URL 读取。 |
| `stateDir` | 会话绑定的私有目录（见下）。绝不放在本仓库内。 |
| `requestTimeoutMs` | 对桌面的单次 RPC 预算，整数 1000–120000，默认 20000。 |
| `pollIntervalMs` | 截止/取消检查的空闲唤醒间隔，整数 100–60000，默认 2500（帧驱动进度；该定时器不承载失败语义）。 |
| `turnTimeoutMs` | 单个 prompt 回合的墙上时钟预算，整数 1000–3600000，默认 600000。 |

配置的 `workspace` 决定桌面任务的执行目录。DSH 传给 `session/new` 的 `cwd` 会被记录并出现在 `session/list` 里，但不改变执行位置：桌面在它注册的工作区内执行。

## 现场节点（一个节点，多个工作区）

`workspaceSelection: "session"` 把适配器变成服务整个站点的单一节点——不按工作区克隆节点。流程：

1. **建会话时发现。** `session/new` 执行一次只读探测（中继配对 + bootstrap + 断开，不开桥、不走会话通道），返回一个 `workspace` select 配置项，取值为站点已注册的工作区路径。探测失败——站点离线、连接文件不可读、工作区为零或路径重复——都是显式的 `session/new` 错误；不写绑定、不派发任何内容。工作台设置页的"重新检查"走同一路径，因此它同时就是在线/离线健康检查。prompt 回合进行中时，`session/new` 直接返回 busy 而不再探测：中继对每设备只授予一条控制器连接，第二次配对会踢掉正在为回合流送的那条——2026-09-21 的验收现场正是这样丢掉一个回合（流在中途死亡、结局未知，而桌面端其实早已完成）。
2. **按会话选择。** 工作台把该选项渲染在会话的 Agent 控制菜单里（与模型选择同一条 `session/set_config_option` 通道）。选定值会对照一次全新发现重新校验——陈旧菜单选不到站点已下线的工作区——并把选择（归一化作用域加工作区身份）钉在绑定上。
3. **精确派发。** 未选定工作区时 `session/prompt` 以显式错误拒绝；选定后才桥接该工作区并在其中创建桌面任务。没有默认工作区、没有取第一项的回退；任务派发后选择不可再改。每次派发都会把选择重新对照站点当前列表，选择与派发之间被移除的工作区会响亮失败，而不是落进错误的项目。

**健康元数据与 UI 边界。** ACP 卡片协议没有承载站点元数据的一等字段，因此只读事实——站点标签、实际桌面版本、已注册工作区数——放在 `workspace` 选项的描述文本里，`--health` 则把同样的事实打印成单行固定字符串报告（在线退出 0，离线退出 1）：

```sh
node adapter.mjs --config <private-json> --health
# [zcode-desktop-adapter] health: PC1-HZ20035172: online, desktop 3.14.0, 19 registered workspace(s), workspace selection per session
```

两个出口都不携带 URL、`sid` 或 `hash`。作用域隔离与固定模式一致：绑定按连接身份（设备 + 桌面会话）拒绝与过滤，现场节点即使与本机桌面节点共用同一中继主机也看不到对方的会话；绑定记录自己选定的工作区，会话只可能派发到被指定的位置。

## 协议面

- `initialize` —— protocolVersion 1；能力如实声明且仅文本：`loadSession: true`、一个作用域受限的 `session/list`、`promptCapabilities` 全 false（不支持图片/音频/嵌入上下文）、`mcpCapabilities` 全 false。不伪称 MCP、图片或审批能力。
- `session/new` —— 懒创建稳定的 DSH 侧会话 ID（`zdsk-<uuid>`）与绑定文件。固定工作区模式下首个 prompt 之前不触碰桌面，响应携带唯一的固定配置项：模型 select `follow-desktop`（模型选择归桌面），同时用于应答工作台的模型探测。会话模式下响应额外携带来自只读发现的 `workspace` select 配置项（见"现场节点"一节）。
- `session/adopt` —— 把一条已存在的桌面任务绑定进可恢复的绑定，使后续 prompt 续写该任务。验证在两个独立桌面来源上失败即拒绝：桥接工作区的官方 `zcode-task/listTasks` 索引必须以 `completed` 状态携带该任务 ID，且实时会话快照必须处于终态并无待处理交互。session 模式必须给出该任务所属的 `workspacePath`；fixed 模式不接受任何路径（固定在配置中）。已拥有该任务的绑定（同一连接、同一工作区）原样复用——绝不建第二个绑定；其上一条命令回执未知的绑定先被拒绝。新建的绑定带 `registration: "adopted"`，永不走 `zcode-task/createTask`：该任务由桌面自行登记。adopt 从不创建桌面会话、从不发送输入；后续 prompt 走普通 `sendText`（`startNow`）路径。
- `session/prompt` —— 每个适配器进程同时只允许一个回合（并发 prompt 会被拒绝）。仅接受 text block；任何非 text block 在派发前即被拒绝。若 DSH 在首块前置了宿主指令块（`Current host instructions (replace earlier host instructions for this request).`），其内容原样保留但移动到真实用户任务之后，使桌面任务标题反映任务本身。命令 ID 先于发送持久化；应答按已证实的 V4 契约（`commandAckSchema`）严格解释：状态必须是 `accepted` / `rejected` / `stale` / `duplicate` / `noop` / `failed` 之一，位置在回包顶层或 `ack` 信封内（两者均有实机观察），且回执另名命令 ID 即作废。`accepted`（及回放缓存结果的 `duplicate`）才算送达确认，以一次原子写入记录真实桌面会话 ID；`rejected` 与 `stale` 是已证实的未应用拒绝，清除台账允许恰好一次换新命令 ID 的重试；`noop` 是已识别的未应用决议，保留台账阻断等待人工核实；`failed` 与一切未识别形态失败关闭、台账保留——绝不重发、绝不猜测成功。prompt 回合只流回 agent/工具更新——用户文本绝不回显（DSH 已自行记录）；user chunk 只出现在 `session/load` 的历史回放中。
- 回合跟踪 —— 通过官方 V4 流订阅会话主题 `conversation/<sessionId>`，回合由事件驱动。投影遵循官方 store 契约：snapshot 帧整体替换状态；delta 帧仅在区间衔接（`fromSeq === seq`）时应用；断档、组装故障或桥恢复先走 `resyncConversationV4`，失败则依次降级为新订阅快照、重配对控制器后只读重订阅；有界空闲静默走同一阶梯、resync 优先，强制快照始终未落地的路由在下一个空闲唤醒升级为重建订阅——命令绝不重发。分片物理帧按 crc32 校验组装、fail closed。输出以 `agent_message_chunk` 流回（按行键 `v4row-<rowId>`；官方 `text` / `output.text` 增量在同一 `messageId` 下追加；合法的 `row.upserted` 正文替换会新开消息修订，因为 ACP 无法撤回已经发送的 chunk）。历史绝不重放：既有任务以派发前的订阅快照为基线，且基线必须是终态（`control.phase` 完成且无待审批交互）——任务仍在运行时拒绝 `startNow` 追加而不是覆盖它。回合完成需要新的 assistant 行：终态 phase 可能先于 assistant 行投影落定，因此仅观察到终态绝不结束回合——回合保持开启直到该行真正落定（或带证据地失败）。当本回合的实时 phase 迁移进入 `completedSuccess` 且已有 assistant 证据后，回合还要收尾尾部：只有在投影保持静默满一个有界窗口（每个新排干的行都会重置该窗口）或收尾上限到期后才结束——真实桌面可能把回复的最终全文行紧随终态补丁之后送达（2026-09-28 实测：transcript 只留部分正文 "CONT"，而桌面快照里是完整答案）。永不静默的流会在上限处携带尽力而为的尾部放行，命令绝不重发；终态迁移之后才耗尽的回合预算仍成功结束回合——被截断的只是尾部，不是结果。仅有新 user 行加终态 phase、或基线里已可见的工具，都不能结束回合。无 `rowId` 的行按保守方式处理：触发重同步，既不流送也不作为证据。`reasoning` 行绝不投影。
- 任务登记 —— 直接 `createSession` 不会初始化桌面的 task facade。accepted 后适配器以 `draftSessionId`（同一个 accepted ID，`v4Create: true`）调用 `zcode-task/createTask`，以结果回显的 taskId 为校验，让桌面收编既有草稿而不派发新输入，之后才把绑定标为 `registered`。登记失败标为 `unknown`，保留绑定、绝不自动重试；`session/load` 拒绝 `unknown` 绑定（先去原生任务核实），并为早于该字段存在的历史绑定补登记。
- 工具与审批 —— `toolCall` 行（稳定 ID 在 `row.toolCallId`，官方状态集）投影为 ACP `tool_call` / `tool_call_update` 卡片。桌面侧待审批的权限/问询以一张常驻卡片提示需要去 Zcode 桌面处理；回合保持运行，适配器绝不自动同意、绝不配置 yolo。
- `session/cancel` —— 映射到桌面真实的 `stop` 会话命令（已对照已安装桌面自身的 stopGeneration 调用点核实）。stop 的 accepted 只是送达而非终态：只有流上观测到终态 phase（`completedInterrupted`）后才返回 `cancelled`；截止期限内无法确认 stop 时，返回"远端状态未知"的错误而不是假称成功。
- `session/load` —— 从绑定文件恢复所绑定的桌面会话，并按新订阅快照回放历史（realUser/guided 输入与 assistant 行，按行 ID 键控），因此工作台重启或适配器重启都能续接同一桌面任务。

## 失败语义

- 超时与断链绝不触发重发。命令结局未知（丢失应答、适配器在发送与应答之间重启）时，绑定保留派发记录，该会话的后续 prompt 被拒绝，直到有人去 Zcode 桌面核实任务状态。适配器绝不自动创建替代会话。回合截止在每次循环唤醒顶部检查（含重同步重试路径），持续的流故障不会把回合拖过 `turnTimeoutMs`。恢复走 `--reconcile-dispatch` 模式（见下一节）：它收集只读桌面证据，并在明确的人工核验下核销台账——绝不手工编辑绑定文件。
- 超过 `turnTimeoutMs` 的回合返回错误，并明确说明桌面任务可能仍在运行。
- 进程退出（stdin EOF、信号）只断开中继连接；不重新派发任何内容，绑定保留供 `session/load` 使用。
- 绑定按设备身份与工作区做作用域校验，而非仅中继主机：身份以安全哈希存储（绝不存凭据原文），连接文件或工作区变化时，load、prompt、list 都拒绝旧绑定。
- stdout 只有 JSON-RPC。stderr 只输出经过凭据清洗的诊断。跨 stdio 的错误文本一律清洗：连接凭据与 URL 绝不出现在协议错误或 stderr 中。

| 退出码 | 含义 |
| --- | --- |
| 0 | 正常结束（stdio 关闭或信号）。 |
| 1 | `--health` 判定站点离线或配置不可用、`--list-tasks` 失败，或 `--reconcile-dispatch` 被拒绝（未核销任何内容）。 |
| 2 | 配置错误。 |
| 7 | 入站 JSON-RPC 帧超过大小限制。 |
| 8 | remoteClientRoot 未暴露预期模块。 |

## 核销未决派发

`--reconcile-dispatch <taskId> [<workspacePath>] [--confirm human-verified] [--operator <label>]` 是派发台账处于未决状态（丢失应答、适配器在发送与应答之间重启）时针对单个绑定的恢复路径。桌面协议无法事后证明“未应用”——命令 ID 不会再次出现在会话快照里，而快照只是行尾窗口——因此该模式收集桌面确实暴露的全部只读事实，并在任何相反或不可读信号上拒绝：作用域内没有绑定拥有该任务（`binding-not-found`）、绑定没有未决派发（`nothing-to-reconcile`）、任务索引行缺失、仍在运行或状态未知（`task-missing`、`task-running`、`task-status-unknown`）或索引不可读（`index-unreadable`）、实时会话快照不可读（`snapshot-unreadable`）、非终态（`phase-not-terminal`）或有待处理交互（`awaiting-input`）、或旧指令以 user 行出现在快照里（`prompt-matched`——命令已被应用）。期望的 prompt 正文经 stdin 以一行 JSON `{"expectedPromptText":"..."}` 传入——绝不经 argv、绝不落盘；confirm 缺少它即拒绝（`expected-prompt-missing`）。session 模式必填工作区路径且绑定必须属于该工作区；fixed 模式不接受路径，与 `--list-tasks` 和 `session/adopt` 一致。

干跑（不带 `--confirm`）打印一行 `[zcode-desktop-adapter] reconcile: <json>` 报告，携带证据——命令 ID、类型、签发时刻、任务状态与更新时间、任务是否在派发之后又变化、实时 phase、待处理交互数、user 轮数、正文匹配结果——且不写任何状态。`--confirm human-verified` 是操作者对“已在现场核实桌面任务、该命令未被应用”的明确核验声明；承担剩余不确定性（尾窗口可能截断历史；派发后的 `updatedAt` 变化可能是同步噪声）的是这份人工核验，而不是协议。confirm 在同一趟里重跑全部检查，随后向只追加的 `stateDir/reconcile-ledger.jsonl` 审计账本写入一条记录（任务 ID、DSH 侧会话 ID、命令 ID 与类型、证据摘要、模式、操作者来源、时间——绝不包含 prompt 正文、URL 或凭据），然后才以一次原子写清除绑定的派发记录。台账中已存在同一命令 ID 而绑定仍上锁时按 `ledger-conflict` 拒绝（中断的核销：从账本解决，绝不写第二条记录）；已被核销清除的绑定以 `alreadyReconciled` 幂等应答、不改任何状态。该模式绝不重发旧命令、绝不创建桌面任务、绝不触碰派发已正常落定的绑定；核销之后，该桌面任务与之前完全一样经 `session/adopt` 续写。

## 能力边界

- **依赖互联网中继。** 桌面远程控制通道走官方互联网中继（`wss://<relay-host>/ws`），即使桌面就在本机。本适配器不是离线的本机 RPC；中继可达性与账号状态都会影响它。
- **桌面授权/配对生命周期。** 远程控制 URL 由桌面"移动端远程控制"界面按次配对生成，桌面重新配对或撤销即失效。适配器每次连接都重读 URL 文件，因此重连时会读取更新的凭据。设备或桌面会话身份变化时拒绝旧绑定；适配器无法自行重新配对。
- **审批留在桌面。** 桌面任务内部产生的权限请求与问询无法从工作台应答；适配器以等待卡片呈现并保持回合开启。
- **模型选择跟随桌面。** 唯一广播的模型选项是固定值 `follow-desktop`；换模型请去 Zcode 桌面。
- **连接归属。** 每个 prompt 和空闲的 session/load 结束后释放中继连接。下一轮重新连接并保留同一桌面任务绑定。执行期间其他远控客户端不能抢占连接。适配器对自身执行同一条单槽位规则：进程内的每一次配对——站点发现与任务链接——都经同一道控制器门串行，发现尚未结束时到达的 prompt 会等它释放槽位，而不是与之并行配对。
- **单驱动者假设。** 适配器假设由它驱动自己创建的任务。若有人或其他客户端同时操作同一桌面任务，回合边界只能按实时流尽力归因。
- **V4 协议形状。** 线帧/快照/行投影（wireVersion 3；`ConversationSnapshot` 的 `control.phase`、`rows.window`、`pendingInteractions`；`assistantText`/`toolCall` 行的 `rowId`/`toolCallId`）遵循官方 3.14.0 协议（已对照该版本的 ZCode-official 开源源码核实）；桌面升级若改变这些形状，行为退化为保守（重同步循环、回合超时）而非数据丢失。

## 与其他节点并存

本适配器不取代任何现有节点：ACP 后台节点（独立无头执行）与 `integrations/zcode-hub-adapter`（远程 hub 透传、完整审批桥接）保持原样。当要求是任务*在正在运行的 Zcode 桌面中可见、可接管*时用本节点；无头执行用 ACP 节点；hub 托管会话用 hub 适配器。

## 测试

fake-remote 集成测试拉起真实 stdio 入口；只伪造桌面（无网络、无中继、无真实桌面）：

```sh
node --test integrations/zcode-desktop-adapter/test/adapter.test.mjs
```

覆盖：能力声明、create → prompt 全回合流与宿主指令顺序及每回合订阅/退订生命周期、重启后 session/load 续接与快照回放、工作区精确唯一匹配、非文本拒绝、并发与未决派发阻塞、内容块凭据不泄露且错误/stderr 不泄露 URL、终态无正文与仅新 user 行回合纪律、终态先于正文行投影的纪律、基线工具覆盖、非终态基线拒绝、真实 stop 取消与终态观测（含 accepted-即-cancelled 与 stop 不可确认两个反例）、持续流故障回合经重同步不重发也不越过截止期限、空闲漏终态经且仅经一次对既有订阅的强制 resync 恢复（不重建路由、答案完整流回）、静默 resync 升级为恰好一次订阅重建、resync 被拒时降级重建（三者均不重发命令）、增长行同一 messageId 增量、快照整体替换不重放、无 rowId 保守处理、seq 断档经且仅经一次服务端重同步恢复并补流缺失行、crc32 分片组装与损坏分片 fail-closed、工具/审批卡片（按 SDK 强制的 ACP ToolCallContent 形状校验）、硬断言 zcode-task/getTaskSnapshot 从不被调用、任务登记（复用不重复派发、失败保留绑定且不自动重试、session/load 补登记历史绑定并拒绝未确认绑定）、固定模型选项、含设备身份隔离与身份不可确认拒绝的绑定作用域防护，以及 sendConversationCommandV4 确认包契约：扁平与信封两种 accepted 确认、rejected/stale 拒绝并清台账限恰好一次重试、failed 保持结果未知、noop 已识别未应用、未识别形态（未知状态、外来命令 ID、冲突位置）失败关闭且不重发。

现场模式新增覆盖：只读发现输出工作区选项（取值、标签、健康元数据）、发现失败不留绑定也不派发、路径重复拒绝、未选择即 prompt 被拒、列表外选择被拒且绑定保持未选定、选择钉定并以真实 `createSession` 工作区 ID 验证、派发后选择不可变、站点绑定的设备身份隔离、未派发会话 session/load 重新发现并保持（或拒绝已消失的）选择、`--health` 在线/离线输出与凭据清洗、两种模式的配置校验（旧固定配置行为不变、session 加固定 workspace 拒绝、fixed 缺 workspace 仍拒绝、未知选择器拒绝）。针对单控制器槽位的并发：回合进行中的 `session/new` 发现返回 busy，不再开出第二条中继配对（不踢控制器、不写绑定）；回合仍完整流回最终回答——包括终态补丁先于最后一段完整正文行的收尾帧；排在未完成发现之后的 prompt 等待槽位释放而不是争抢。

`--list-tasks` 新增覆盖：以精确 `zcode-task/listTasks` 作用域（从 bridge 日志断言工作区路径与身份）读取单个工作区的已同步索引、行投影（无效行跳过、未知状态回退、标题 URL 清洗、按更新时间降序、其他工作区行绝不串入）；绑定归属经端到端验证（先跑一轮真实派发，再列举时该桌面任务标记 `origin: "workbench"` 并携带 DSH 会话 ID，而桌面创建的任务保持 `origin: "desktop"`）；离线、工作区未注册、桌面索引错误均以清洗后的固定字符串原因退出 1；模式参数规则（session 无路径、fixed 带路径）在任何连接之前退出 2。

`session/adopt` 新增覆盖：对已存在桌面任务的端到端续写——仅一条 `sendText`（`startNow`）命令发往同一任务 ID，断言 `createSession` 与 `zcode-task/createTask` 全程缺席，任务经桥接工作区作用域内的 `listTasks` 验证；无法证明可续写任务的拒绝矩阵（索引缺失、索引 running/error、索引 completed 但实时会话仍在运行或等待输入）均不写绑定、不派发；跨适配器重启复用工作台派发已创建的绑定（单绑定、`created: false`）；被 adopt 绑定的重启恢复（`session/load` 回放加同一任务 ID 的又一轮 `sendText`）；发送回执丢失时派发台账保留并阻断后续 prompt 且不重发；工作区参数规则（session 模式必填路径并把绑定钉在规范化工作区、经不同拼写路径重新 adopt 复用绑定、fixed 模式拒绝路径）。尾部收尾新增覆盖：经门控延迟到终态补丁之后的全文行仍完整流回（2026-09-28 实测截断形态），全程仅一条命令、绝不新建替代任务；完整短答靠静默收敛在回合预算内远早于截止地结束，而不是等待不会到来的帧；终态补丁之后的慢速 row.delta 尾滴在回合结束前全部流回，且绝不触发重发。


`--reconcile-dispatch` 新增覆盖：丢失应答的续写派发留下一条未决 `sendText` 台账后——干跑报告完整证据行且台账保留、审计账本为空、旧命令绝不重发、正文与凭据绝不回显；人工核验 confirm 清除台账并恰好追加一条审计记录（命令 ID、模式、操作者来源、证据，无 prompt 正文），重复 confirm 幂等应答（`alreadyReconciled`、无第二条记录），同一桌面任务经 adopt 重新可续写且断言 `createTask` 全程缺席，中断核销按名拒绝（`ledger-conflict`）且不写第二条记录；应用信号（旧指令以 user 行出现在实时快照中）拒绝且锁保留；任务索引拒绝（running、未知状态、缺失行）；实时会话拒绝（非终态 phase、待处理交互）；作用域拒绝（无绑定任务、连接身份变化、session 模式工作区不匹配而本工作区通过）；缺期望正文的 confirm 拒绝与干跑的 `promptMatched: null` 只读报告并列；以及 argv 规则（核验字面量、fixed 模式工作区路径）在任何连接之前以退出码 2 失败。
