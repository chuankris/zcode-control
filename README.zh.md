# ZCode 控制代码源码包

## 内容
- integrations/zcode-desktop-adapter：ACP stdio 控制适配器、文档及测试。
- remote-client：valeriikot/zcode-cli 的完整固定提交源码，保留依赖清单、锁文件和许可证。
- adapter.example.json：无凭据的配置模板。

## 接入步骤
1. 使用 Node 24，将本包解压到例如 D:/zcode-control。
2. 在 remote-client 目录安装依赖：`npx --yes bun@1.3.12 install --frozen-lockfile`。
3. 在 ZCode 桌面开启移动端远程控制，把配对链接单独保存到包外的 D:/zcode-private/remote-url.txt。
4. 把 adapter.example.json 复制到包外的 D:/zcode-private/adapter.json，按实际路径修改 remoteClientRoot、connectionUrlFile 和 stateDir。
5. 健康检查：
   `node --experimental-transform-types D:/zcode-control/integrations/zcode-desktop-adapter/adapter.mjs --config D:/zcode-private/adapter.json --health`
6. 健康检查成功后，在 DSH 的 ZCode 节点中使用 Node 24 的绝对路径作为 command，参数为：
   `["--experimental-transform-types", "D:/zcode-control/integrations/zcode-desktop-adapter/adapter.mjs", "--config", "D:/zcode-private/adapter.json"]`

这是源码包，需要单独安装依赖，并配合已安装的 DSH ACP 插件使用；不包含完整 DSH 工作台或 Node/Bun 可执行文件。适配器通过官方互联网中继连接桌面，权限审批仍在 ZCode 桌面完成。原始 README 中的仓库外相对链接请回到原项目查看。

本包不包含本机配对链接、私有配置、状态、日志、node_modules 或 Git 历史。此次仅打包及检查包内容，没有新建远程任务或重新进行在线验收。
