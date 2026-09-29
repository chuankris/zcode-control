# ZCode Control 源码仓库

简体中文 | [English](README.md)

这个仓库保存 ZCode 与 DeepSeek Harness（DSH）的任务中心、桌面远程控制和 Hub 接入源码切片。仓库最初从本地交付包 `zcode-workbench-handoff-20260929-094910.zip` 导入，之后继续加入任务中心 V2 实现；导入时的来源提交和交付包 SHA-256 见 [`SOURCE-VERSIONS.json`](SOURCE-VERSIONS.json)。

## 内容

- [DSH 工作台插件](packages/experimental/zcode-workbench/README.zh.md)：节点与工作区选择、持久任务、Codex ingress、统一桌面任务列表、原任务续写和结果未知核销流程。
- [桌面适配器](integrations/zcode-desktop-adapter/README.zh.md)：通过桌面远程控制连接，把 ACP stdio 任务映射为 ZCode 桌面可见任务。
- [Hub 适配器](integrations/zcode-hub-adapter/README.zh.md)：把 `zcode-acp` Hub 的 WebSocket 通道适配为本地 ACP stdio 节点。
- [远程客户端](remote-client/README.md)：`valeriikot/zcode-cli` 的固定提交源码快照，保留依赖清单、锁文件和许可证。
- [设计与交接文档](DOC/task-center-v2-design.zh.md)：任务中心设计、集成清单和交互原型。原型仅使用模拟数据，不代表实时后端。
- [适配器配置示例](adapter.example.json)：无凭据的桌面节点配置模板。

## 桌面适配器接入

1. 使用 Node 24，在 `remote-client` 目录安装依赖：`npx --yes bun@1.3.12 install --frozen-lockfile`。
2. 在 ZCode 桌面开启移动端远程控制，把配对链接保存在**仓库外**的私有文件中。
3. 把 [adapter.example.json](adapter.example.json) 复制到仓库外，按实际路径修改 `remoteClientRoot`、`connectionUrlFile` 和 `stateDir`。
4. 健康检查：
   `node --experimental-transform-types <repo>/integrations/zcode-desktop-adapter/adapter.mjs --config <private>/adapter.json --health`
5. 在 DSH 的 ZCode 节点中使用 Node 24 绝对路径作为 command，并传入：
   `["--experimental-transform-types", "<repo>/integrations/zcode-desktop-adapter/adapter.mjs", "--config", "<private>/adapter.json"]`

插件安装和任务中心行为详见[工作台 README](packages/experimental/zcode-workbench/README.zh.md)。工作台插件和 Hub 适配器的构建与测试依赖完整 DSH 工作区；本仓库是集成源码快照，不是可独立构建的 DSH 发行版。

## 安全与许可

不要把配对链接、token、私有配置、运行状态、日志或 `node_modules` 提交到 Git。权限审批仍由 ZCode 桌面完成。各组件的来源和许可条件不同；重新分发前请核对[导入来源记录](SOURCE-VERSIONS.json)、[远程客户端许可证](remote-client/LICENSE)和 [DSH 源码许可证](licenses/deephik-progo/LICENSE)。
