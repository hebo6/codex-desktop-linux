# Codex Desktop Linux

基于 Tauri 2、React、TypeScript 和 Rust 构建的独立 Linux Codex app-server 协议桌面客户端

![Codex Desktop Linux 会话界面](tests/visual/baselines/1440x900-dark-conversation.png)

更多界面截图见[视觉回归基线目录](tests/visual/baselines)

## 项目特点

### 远程

- **界面与工作环境分离** — 桌面客户端与 app-server 可以运行在不同电脑上，源代码、工具链和命令执行始终留在实际工作的主机
- **服务端保持轻量** — 远程主机只需运行 Codex app-server，无需安装本项目的配套代理、桌面环境或其他后端服务
- **连接路径由用户掌控** — 支持直连、HTTP CONNECT、SOCKS5 和 SSH，客户端与 app-server 之间的协议数据不经过 OpenAI 中继，app-server 仍会单独连接 OpenAI 或配置的模型服务

### 后台

- **切换后继续执行** — 切换会话、窗口或最小化应用不会中断正在运行的任务，非当前会话仍会接收状态，任务完成后可通过桌面通知和待查看标记提醒
- **断开后继续执行** — 独立托管的远程 app-server 不依赖桌面客户端存活，关闭客户端或连接中断后任务仍可在服务端继续，重新连接即可恢复会话并查看结果
- **交互边界明确** — 等待审批或用户输入的任务不会被自动放行，需要重新连接后由用户继续处理

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
