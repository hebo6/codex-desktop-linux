#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "用法：finalize-appimage.sh <bundle 目录> <Rust 目标>" >&2
  exit 2
fi

bundle_root=$1
rust_target=$2

if [[ ! -d $bundle_root ]]; then
  echo "bundle 目录不存在：$bundle_root" >&2
  exit 2
fi

case $rust_target in
  x86_64-unknown-linux-gnu)
    appimage_architecture="x86_64"
    ;;
  aarch64-unknown-linux-gnu)
    appimage_architecture="aarch64"
    ;;
  *)
    echo "不支持的 AppImage 目标：$rust_target" >&2
    exit 2
    ;;
esac

bundle_root=$(realpath "$bundle_root")
mapfile -d '' -t appimage_paths < <(find "$bundle_root" -type f -name '*.AppImage' -print0)
mapfile -d '' -t appdir_paths < <(find "$bundle_root" -type d -name '*.AppDir' -print0)

if [[ ${#appimage_paths[@]} -ne 1 || ${#appdir_paths[@]} -ne 1 ]]; then
  echo "必须且只能找到一个 AppImage 和一个 AppDir" >&2
  exit 1
fi

appimage_path=${appimage_paths[0]}
appdir_path=${appdir_paths[0]}
library_directory="$appdir_path/usr/lib"
gstreamer_plugin_directory="$library_directory/gstreamer-1.0"
gstreamer_apprun_hook="$appdir_path/apprun-hooks/linuxdeploy-plugin-gstreamer.sh"

if [[ ! -d $gstreamer_plugin_directory || ! -f $gstreamer_apprun_hook ]]; then
  echo "AppImage 未包含预期的 GStreamer 插件和 AppRun hook" >&2
  exit 1
fi

mapfile -d '' -t gstreamer_plugins < <(find "$gstreamer_plugin_directory" -maxdepth 1 -type f -name 'libgst*.so' -print0)
if [[ ${#gstreamer_plugins[@]} -eq 0 ]]; then
  echo "AppImage 的 GStreamer 插件目录为空" >&2
  exit 1
fi

excluded_library_patterns=(
  'libwayland-*.so*'
  'libglib-2.0.so*'
  'libgio-2.0.so*'
  'libgobject-2.0.so*'
  'libgmodule-2.0.so*'
  'libmount.so*'
  'libblkid.so*'
  'libselinux.so*'
  'libpcre2-8.so*'
  'libzstd.so*'
  'libelf.so*'
  'libffi.so*'
  'libsystemd.so*'
)

# Tauri 2.11 的 linuxdeploy 路径会把基础设施库打入 AppImage，这些旧库会与
# 新发行版的 Mesa 冲突：https://github.com/tauri-apps/tauri/issues/15665
shopt -s nullglob
for library_pattern in "${excluded_library_patterns[@]}"; do
  library_matches=("$library_directory"/$library_pattern)
  if [[ ${#library_matches[@]} -eq 0 ]]; then
    echo "AppDir 缺少预期的待排除库：$library_pattern" >&2
    exit 1
  fi
  rm -- "${library_matches[@]}"
done

tauri_cache_directory="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
appimage_plugin="$tauri_cache_directory/linuxdeploy-plugin-appimage.AppImage"
if [[ ! -x $appimage_plugin ]]; then
  echo "找不到 Tauri 下载的 AppImage 输出插件：$appimage_plugin" >&2
  exit 1
fi

repacked_path="$appimage_path.repacked"
LDAI_OUTPUT="$repacked_path" \
ARCH="$appimage_architecture" \
APPIMAGE_EXTRACT_AND_RUN=1 \
  "$appimage_plugin" --appimage-extract-and-run --appdir="$appdir_path"
mv -- "$repacked_path" "$appimage_path"

echo "已重建可移植 AppImage：$appimage_path"
