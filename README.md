# Codex Desktop Linux

[简体中文](README.zh-CN.md)

An independent Linux desktop client for the Codex app-server protocol, built with Tauri 2, React, TypeScript, and Rust

> [!IMPORTANT]
> This is an unofficial community project. It is not affiliated with, sponsored by, or endorsed by OpenAI. Codex and OpenAI are trademarks of OpenAI

> [!WARNING]
> The project is under active development. Expect protocol and user-interface changes throughout the 0.x releases

![Codex Desktop Linux conversation view](tests/visual/baselines/1440x900-dark-conversation.png)

The screenshot is generated from the project's deterministic visual-regression fixture and contains no account or app-server data

## Features

- Local stdio connections to a Codex app-server process
- Experimental remote WebSocket connections over direct TLS, HTTP CONNECT, SOCKS5, or SSH direct-tcpip paths
- Reusable server and proxy profiles with credentials stored through Linux Secret Service
- Restorable conversations, streaming responses, tool activity, approvals, steering, interruption, and forking
- Model, reasoning effort, working directory, approval policy, and sandbox configuration
- Safe Markdown rendering and previews for common local and remote file references
- Native multi-window behavior, single-instance deep links, desktop notifications, and rate-limit visibility

## Differences from the official desktop app

This project uses the same Codex app-server protocol but has a different deployment focus from the [official desktop app](https://learn.chatgpt.com/docs/app)

| Area | Codex Desktop Linux | Official desktop app |
| --- | --- | --- |
| Platform | Native Linux client with planned AppImage, deb, and rpm packages | First-party desktop app documented for macOS and Windows |
| Self-managed remote Codex | Manages multiple local or self-hosted remote app-server profiles and connects through direct WebSocket, HTTP CONNECT, SOCKS5, or SSH | Published desktop workflows focus on local projects, worktrees, and OpenAI-hosted cloud tasks; the [Codex CLI](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli) separately provides experimental remote app-server support |
| Closing the client | A turn on an independently managed remote app-server can continue after the desktop client closes, provided the server remains running and the turn does not require approval or user input | Local desktop workflows follow the desktop application's lifecycle, while cloud tasks run in an OpenAI-hosted environment |
| Network boundary | The desktop host only needs a route to the configured app-server and does not need direct OpenAI connectivity; the app-server host still needs authentication and access to OpenAI or its configured model provider | Connectivity depends on whether the selected official workflow runs locally or in OpenAI's cloud |

This is a comparison of deployment models, not a complete feature comparison. The project does not replace first-party cloud, ChatGPT, or platform-integration capabilities

## Project status

The first P0 release is available from [GitHub Releases](https://github.com/hebo6/codex-desktop-linux/releases)

The interface is currently available in Simplified Chinese. Internationalization is not implemented yet

Remote WebSocket transport and several app-server methods are experimental upstream. Only connect to trusted TLS-protected endpoints and review the configured approval and sandbox policies before starting a task

See the [product scope](docs/product-scope.md), [implementation plan](docs/implementation-plan.md), and [release requirements](docs/release-requirements.md) for the planned release boundary

## Requirements

Running the application requires

- x86_64 or aarch64 Linux with glibc 2.35 or newer
- An X11 or Wayland desktop session
- Linux Secret Service for persistent credentials
- A compatible [Codex CLI](https://developers.openai.com/codex/cli) installation for local stdio connections, already authenticated for the intended account

deb and rpm packages use GTK 3 and WebKitGTK 4.1 from the distribution. The AppImage carries its WebKit runtime dependencies

## First connection

### Local stdio

For a local Codex connection

1. Verify that the Codex CLI starts and is authenticated
2. Resolve its absolute executable path with `command -v codex`
3. In Codex Desktop Linux, create a **Local stdio** server
4. Set the executable path to the absolute path from the previous step
5. Add `app-server` as the first argument and optionally select a default working directory
6. Test the connection, save the server, and choose a project directory before starting a thread

### Remote WebSocket

A remote connection requires a compatible Codex CLI on the server host, an authenticated Codex account there, and an app-server process managed independently from the desktop client

The recommended first setup uses an SSH connection path and keeps the app-server listener on the remote loopback interface

1. Create a cryptographically random capability token on the server, store it in a file readable only by the app-server account, and note the file's absolute path
2. Start the compatible app-server on the remote host

```bash
codex app-server \
  --listen ws://127.0.0.1:4500 \
  --ws-auth capability-token \
  --ws-token-file /absolute/path/to/codex-app-server.token
```

3. In **Settings → Proxies**, create an SSH proxy for the remote host and verify its host key fingerprint
4. Create a **Remote WebSocket** server with URL `ws://127.0.0.1:4500`
5. Select **Bearer token** authentication and enter the capability token stored in the server-side token file
6. Select the saved SSH proxy as the connection path, acknowledge the `ws://` warning, and test the connection before saving

The WebSocket leg in this layout is carried inside the encrypted SSH connection. The client still shows the plaintext warning because the configured target URL itself uses `ws://`

For a direct Internet-facing connection, keep app-server on a private or loopback `ws://` listener and place a trusted TLS reverse proxy in front of it. Configure the client with the public `wss://` URL, strict certificate validation, and the matching bearer token. The reverse proxy must support WebSocket upgrades and forward the `Authorization` header

Do not expose an unauthenticated app-server listener to an untrusted network. app-server WebSocket transport is experimental and accepts `ws://` listen URLs, so public TLS termination must be provided separately

The command above runs in the foreground. To let remote turns continue after closing the desktop client, run app-server with an independently managed process supervisor already trusted on the server. Closing Codex Desktop Linux disconnects its WebSocket but does not stop that remote process. A turn waiting for approval or user input cannot progress until a client reconnects

## Protocol compatibility

Protocol types and runtime validators are generated from the experimental JSON Schema at upstream Codex commit `ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c`

Compatibility with older or newer Codex builds is not implied. See the [protocol baseline](docs/protocol-baseline.md) for generation, validation, and wire-envelope details

## Development

### Prerequisites

- Node.js 24 or newer
- pnpm 11.3.0 through Corepack
- Rust 1.85 or newer
- The [Tauri 2 Linux system dependencies](https://v2.tauri.app/start/prerequisites/#linux)

Install the locked JavaScript dependencies

```bash
corepack enable
pnpm install --frozen-lockfile
```

Run the desktop application in development mode

```bash
pnpm tauri dev
```

Run the frontend and protocol tests

```bash
pnpm test
```

Run the Rust tests

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Build the frontend

```bash
pnpm build
```

Build the current architecture without creating an installer

```bash
pnpm tauri build --debug --no-bundle
```

Protocol generation and visual-regression workflows are documented in [protocol baseline](docs/protocol-baseline.md) and [visual regression](docs/visual-regression.md)

## Documentation

- [Product requirements](docs/prd/README.md)
- [Technical design](docs/technical-design.md)
- [Test plan](docs/test-plan.md)
- [Release requirements](docs/release-requirements.md)

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead

## License

The project is licensed under the [Apache License 2.0](LICENSE)

Protocol schemas generated from OpenAI Codex and other third-party material retain their respective notices as described in [NOTICE](NOTICE)
