# 发布要求

## 支持基线

P0 验证 Ubuntu 22.04、Debian 12、Fedora 当前稳定版和 Arch Linux 当前滚动版

同时覆盖 X11 和 Wayland，会话功能不得依赖特定桌面环境

最低系统要求由 Tauri 2 WebView 和实际构建产物依赖确定，并在发布说明中明确

## 安装包

P0 发布 x86_64 和 aarch64 的 AppImage、deb 和 rpm

AppImage 用作跨发行版便携交付，deb 和 rpm 提供桌面条目、图标、MIME 和卸载集成

P1 增加 Flatpak，并单独处理沙箱内子进程和文件访问授权

## 桌面集成

- 提供应用图标、桌面条目和单实例激活
- 注册产品支持的深链处理器
- 提供桌面通知集成能力

## 发布验证

- AppImage、deb 和 rpm 在目标架构生成可安装产物
- 安装、启动、桌面集成和卸载在目标发行版通过验证
- X11 和 Wayland 下核心流程可用
- 缺少 Linux Secret Service 时能够在用户确认明文文件风险后持久化凭据
- 安装包不要求用户全局安装前端或 Rust 工具
- 发布说明明确协议基线、远程 WebSocket 实验性质和最低系统要求

Tauri 分发参考

- [Tauri Linux 分发](https://v2.tauri.app/distribute/)
- [Tauri AppImage](https://v2.tauri.app/distribute/appimage/)
