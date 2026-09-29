# zcode-hub-adapter

[English](README.md) | 中文

零依赖的 stdio↔WebSocket 传输适配器：让远程（或本机环回）的 [zcode-acp](https://github.com/william0wang/zcode-acp) hub 以普通本地 stdio Agent 节点的身份进入 `dsh-acp-adapter` 工作台。它是外部 Agent 的传输程序，不是 DSH 应用入口：不复制插件代码、不改 `node_modules`，工作台继续使用插件自身的节点设置、会话 UI、审批卡与历史。

要求 Node >= 22.4（原生 WebSocket）。运行时依赖：无。

## 作为 dsh-acp-adapter Agent 节点使用

在插件设置（设置 → ACP adapter → 添加 Agent）中配置节点：

- command：Node >= 22.4 可执行文件的绝对路径
- arguments：`["<仓库>/integrations/zcode-hub-adapter/adapter.mjs", "--config", "<私有配置文件路径>"]`

推荐形态是让凭据不进工作台设置、不进版本库：DSH 设置项只保存配置文件路径，文件本身放在本仓库之外的私有目录（例如 `<私有存储>/zcode-hub-adapter.json`）。文件内容示例：

```json
{
  "hubUrl": "wss://hub.example.internal:8377",
  "token": "<a-long-random-secret>",
  "workspace": "D:/site/project-a",
  "instance": "optional-explicit-instance-id",
  "timeoutMs": 8000
}
```

## 配置

优先级：`--config <file>` > `ZCODE_ACP_HUB_CONFIG` > 直接环境变量。

| 键 | 环境变量 | 含义 |
| --- | --- | --- |
| `hubUrl` | `ZCODE_ACP_HUB_URL` | hub 基址；仅允许 `http(s)`/`ws(s)`，禁止 userinfo/query/fragment，末尾斜杠规范化。明文 `http`/`ws` 仅允许 `localhost`、`127.0.0.1`、`[::1]`。 |
| `token` | `ZCODE_ACP_HUB_TOKEN` | hub 认证 token。仅出现在发现请求的 `Authorization: Bearer` 头与 WebSocket 查询串中，绝不打印、记录或回显。 |
| `instance` | `ZCODE_ACP_HUB_INSTANCE` | 显式实例 id；完全跳过发现。 |
| `workspace` | `ZCODE_ACP_HUB_WORKSPACE` | 实例选择的精确匹配过滤。 |
| `timeoutMs` | `ZCODE_ACP_HUB_TIMEOUT_MS` | 发现/建连超时，整数 1–120000，默认 8000。 |

实例选择绝不静默挑选：显式 `instance` 直接连接；配置 `workspace` 时，只有规范化 workspace（反斜杠→正斜杠、去末尾斜杠）精确相等且唯一时才连接；两者皆无时，hub 恰好通告一个实例才连接。零候选与多候选同样是错误（退出码 3）。

## 行为与失败语义

适配器做 JSON-RPC 载荷透传：stdio 侧按行分隔消息，WebSocket 侧每条文本帧一条消息。帧仅去除首尾空白、其余原样通过——包括 `session/request_permission` 这类服务端→客户端请求——审批由工作台原生审批界面呈现。适配器不解析载荷、不重连、不重发任何内容；中断后的续接由用户执行 `session/load`，而不是自动重放。

界限：双向单帧 ≤ 16,777,216 字符（按 JavaScript `string.length` 计）；建连前队列 ≤ 256 帧且总计 ≤ 67,108,864 字符；socket 与 stdout 写缓冲（按字节计）上限 67,108,864。二进制帧、内嵌换行帧、超限帧一律失败关闭。

| 退出码 | 含义 |
| --- | --- |
| 0 | 正常结束（stdio 关闭、信号、或建连前 stdin EOF）。 |
| 1 | 会话中 hub 连接关闭、发送/stdout 失败。 |
| 2 | 配置错误或 hub URL 非法。 |
| 3 | 无唯一确定的 hub 实例（零或多候选）。 |
| 4 | 发现被拒（HTTP 401/403）。 |
| 5 | 发现传输失败或超时、发现响应格式错误。 |
| 6 | WebSocket 建连失败或超时。 |
| 7 | 帧/队列界限违规。 |

所有 stderr 文案均为固定字符串加数字码——不回显 URL、token 或 hub 提供的任何值。

## 测试

在仓库根目录执行：

```sh
node --test integrations/zcode-hub-adapter/test/adapter.test.mjs
```

测试的 WebSocket 服务端加载仓库已锁定的 `ws` 依赖（`packages/api/gateway`，^8.21.0），经 `createRequire` 锚点解析：pnpm 严格隔离使 `integrations/` 没有自己的 `node_modules`，而仅为测试新增安装会改动锁文件。若 gateway 将来移除 `ws`，该 require 会立即报错——届时改锚到另一个锁定 `ws` 的工作区包。

## 验证边界

单元测试覆盖配置校验、URL 策略、选择歧义、含审批的双向透传、断开/关闭清理、界限违规、凭据不泄露；两个独立的 `node --test` 进程已各自 20/20 通过。对真实 `zcode-acp` hub+serve（0.44.1，build 模式）的环回运行验证了全链路——包括杀掉适配器进程后以 `session/load` 续接上下文——且工作台已把环回 hub 作为 Agent 节点接入，完成两轮对话并正确复述标记。运行的配置、凭据与日志保存在仓库外的私有存储；真实跨网远程现场与隧道尚未实测。
