# 显示可用命令
default:
    @just --list

# 构建当前架构的 AppImage
build-appimage:
    pnpm build:appimage
