# ZCode Control

English | [简体中文](README.zh.md)

This repository contains source snapshots for a ZCode task center in DeepSeek Harness (DSH), desktop remote-control integration, and a Hub adapter. It began with the local `zcode-workbench-handoff-20260929-094910.zip` handoff and has since gained the task-center V2 implementation. See [SOURCE-VERSIONS.json](SOURCE-VERSIONS.json) for the imported source revisions and handoff checksum.

## What's here

- [DSH workbench plugin](packages/experimental/zcode-workbench/README.md): node and workspace selection, durable tasks, Codex ingress, a unified desktop task list, in-place continuation, and a guarded reconciliation flow for uncertain outcomes.
- [Desktop adapter](integrations/zcode-desktop-adapter/README.md): exposes desktop-visible ZCode tasks through an ACP stdio agent using the desktop remote-control connection.
- [Hub adapter](integrations/zcode-hub-adapter/README.md): bridges a `zcode-acp` Hub WebSocket connection to a local ACP stdio node.
- [Remote client](remote-client/README.md): a pinned source snapshot of `valeriikot/zcode-cli`, including its dependency files and license.
- [Design and handoff documents](DOC/task-center-v2-design.zh.md): the task-center design, integration manifest, and interactive prototypes. The prototypes use sample data; they are not a live backend.
- [Adapter configuration example](adapter.example.json): a credential-free template for a desktop node.

## Run the desktop adapter

1. Use Node.js 24. Install the pinned remote client's dependencies from `remote-client`: `npx --yes bun@1.3.12 install --frozen-lockfile`.
2. Enable mobile remote control in the ZCode desktop and save its pairing URL in a private file **outside this repository**.
3. Copy [adapter.example.json](adapter.example.json) outside the repository, then set `remoteClientRoot`, `connectionUrlFile`, and `stateDir` to the paths on your machine.
4. Check the connection with `node --experimental-transform-types <repo>/integrations/zcode-desktop-adapter/adapter.mjs --config <private>/adapter.json --health`.
5. In the DSH ZCode node settings, use the absolute path to Node.js 24 as the command and `["--experimental-transform-types", "<repo>/integrations/zcode-desktop-adapter/adapter.mjs", "--config", "<private>/adapter.json"]` as the arguments.

For plugin installation and task-center behavior, follow the [workbench README](packages/experimental/zcode-workbench/README.md). The plugin and Hub adapter need a complete DSH workspace for build and tests; this repository is an integration source snapshot, not a standalone DSH distribution.

## Security and licenses

Keep pairing URLs, tokens, private configuration, runtime state, logs, and `node_modules` out of Git. Approvals remain in the ZCode desktop. Components have different origins and license terms; review the [imported-source record](SOURCE-VERSIONS.json), the [remote-client license](remote-client/LICENSE), and the [DSH source license](licenses/deephik-progo/LICENSE) before redistributing them.
