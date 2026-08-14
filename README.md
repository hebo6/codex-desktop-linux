# Codex Desktop Linux

基于 Tauri 2、React、TypeScript 和 Rust 构建的独立 Linux Codex app-server 协议桌面客户端

![Codex Desktop Linux 会话界面](tests/visual/baselines/1440x900-dark-conversation.png)

更多界面截图见[视觉回归基线目录](tests/visual/baselines)

## 适用场景

[官方桌面应用](https://learn.chatgpt.com/docs/app)已经支持 macOS、Windows 和[通过 SSH 使用远程项目](https://learn.chatgpt.com/docs/remote-connections)。本项目并不以复刻全部官方能力为目标，而是面向 Linux 桌面和自主管理 Codex 基础设施的使用场景

- **服务端只需 Codex** — 服务端只运行 Codex app-server，无需安装本项目的配套代理、桌面环境或其他后端服务
- **服务端采用无头设计** — app-server 不依赖图形会话，适合运行在开发机、容器或私有网络中
- **客户端与服务端之间不经 OpenAI 中转** — 协议数据通过用户配置的直连、代理或 SSH 路径传输，不经过 OpenAI 中继，app-server 仍会单独连接 OpenAI 或配置的模型服务
- **客户端与服务端可运行在不同电脑上** — 桌面界面留在 Linux 工作站，app-server、源代码和工具链留在实际执行工作的主机

本项目更适合需要 Linux 原生界面、自主管理 app-server 或复杂远程网络路径的开发者。需要官方云端任务、ChatGPT、浏览器、插件及平台集成时，应使用官方桌面应用

## 运行要求

运行应用需要

- 使用 glibc 2.35 或更高版本的 x86_64 或 aarch64 Linux
- X11 或 Wayland 桌面会话
- 建议提供 Linux Secret Service；缺失时应用会在保存凭据前要求确认仅受本机文件权限保护的明文存储
- 本机 stdio 连接需要安装兼容的 [Codex CLI](https://developers.openai.com/codex/cli)，并提前完成目标账户认证

## 快速开始

### 连接本机

1. 安装并登录 Codex CLI
2. 执行 `command -v codex` 获取可执行文件绝对路径
3. 新建“本机 stdio”服务器，填写可执行文件路径，并将 `app-server` 添加为第一个参数
4. 测试并保存连接，选择项目目录后新建会话

### 连接远程主机

在远程主机安装并登录 Codex CLI，然后生成 capability token

```bash
openssl rand -base64 32 > ~/.codex/app-server-token
```

使用相同的 token 文件路径启动服务

```bash
codex app-server \
  --listen ws://0.0.0.0:4500 \
  --ws-auth capability-token \
  --ws-token-file ~/.codex/app-server-token
```

1. 在“设置 → 代理”中添加 SSH 代理并核对主机密钥指纹
2. 新建“远程 WebSocket”服务器，将 URL 设为 `ws://127.0.0.1:4500`
3. 选择“Bearer 令牌”认证并填写 capability token，再选择 SSH 代理，测试并保存连接

SSH 会加密上述 `ws://` 连接。公网直连必须使用 `wss://`、严格校验证书并启用认证，切勿暴露无认证的 app-server

## 开发

### 环境要求

- Node.js 24 或更高版本
- 通过 Corepack 使用 pnpm 11.3.0
- Rust 1.88 或更高版本
- [Tauri 2 Linux 系统依赖](https://v2.tauri.app/start/prerequisites/#linux)

### 开发与测试

安装依赖并启动

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm tauri dev
```

运行测试

```bash
pnpm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

### 构建 AppImage

使用本机环境构建

```bash
just build-appimage
```

使用 Dev Container 构建

```bash
just build-appimage-devcontainer
```

产物位于 `src-tauri/target/<Rust 目标>/release/bundle/appimage`

协议生成和视觉回归流程见[协议基线](docs/protocol-baseline.md)与[视觉回归](docs/visual-regression.md)

## 许可证

项目采用 [Apache License 2.0](LICENSE)

从 OpenAI Codex 生成的协议 Schema 和其他第三方内容保留各自声明，详见 [NOTICE](NOTICE)
