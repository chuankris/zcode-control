# ZCode Control 源码仓库

这个仓库保存 ZCode 与 DeepSeek Harness（DSH）的工作台、桌面远程控制和 Hub 接入源码切片。当前内容以本地交付包 `zcode-workbench-handoff-20260929-094910.zip` 为最新基线；具体来源提交和交付包 SHA-256 见 [`SOURCE-VERSIONS.json`](SOURCE-VERSIONS.json)。

## 内容

- `packages/experimental/zcode-workbench`：DSH 工作台任务中心，包含节点与工作区选择、持久任务、Codex ingress、桌面任务索引、原任务续写和结果未知核销流程。
- `integrations/zcode-desktop-adapter`：通过 ZCode 官方远程控制链路把 ACP stdio 任务映射为桌面可见任务。
- `integrations/zcode-hub-adapter`：把 `zcode-acp` Hub 的 WebSocket 通道适配为本地 ACP stdio 节点。
- `remote-client`：`valeriikot/zcode-cli` 的固定提交源码快照，保留依赖清单、锁文件和许可证。
- `DOC`：连续任务交接说明、集成清单和两份可点击交互原型。原型仅使用模拟数据，不代表后端能力已上线。
- `adapter.example.json`：无凭据的桌面适配器配置模板。

## 验证状态

本次合并已在完整 DeepSeek Harness 工作区中完成离线验证：

- 桌面适配器：82/82 通过。
- Hub 适配器：20/20 通过。
- ZCode 工作台：66/66 通过。

工作台包和 Hub 适配器测试依赖完整 DSH workspace；本仓库是可审查、可同步的源码集成快照，不是可独立构建的 DSH 发行版。

## 桌面适配器接入

1. 使用 Node 24，在 `remote-client` 目录安装依赖：`npx --yes bun@1.3.12 install --frozen-lockfile`。
2. 在 ZCode 桌面开启移动端远程控制，把配对链接保存在仓库外的私有文件中。
3. 把 `adapter.example.json` 复制到仓库外，按实际路径修改 `remoteClientRoot`、`connectionUrlFile` 和 `stateDir`。
4. 健康检查：
   `node --experimental-transform-types <repo>/integrations/zcode-desktop-adapter/adapter.mjs --config <private>/adapter.json --health`
5. 在 DSH 的 ZCode 节点中使用 Node 24 绝对路径作为 command，并传入：
   `["--experimental-transform-types", "<repo>/integrations/zcode-desktop-adapter/adapter.mjs", "--config", "<private>/adapter.json"]`

本仓库不保存配对链接、token、私有配置、运行状态、日志或 `node_modules`。权限审批仍由 ZCode 桌面完成。
