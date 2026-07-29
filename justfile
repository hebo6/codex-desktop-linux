workspace := justfile_directory()

# 显示可用命令
default:
    @just --list

# 构建当前架构的 AppImage
build-appimage:
    pnpm build:appimage

# 启动 Dev Container
devcontainer-up:
    env DOCKER_BUILDKIT=1 devcontainer up --workspace-folder "{{workspace}}"

# 在 Dev Container 中构建当前架构的 AppImage
build-appimage-devcontainer: devcontainer-up
    devcontainer exec --workspace-folder "{{workspace}}" bash -lc 'pnpm build:appimage'
