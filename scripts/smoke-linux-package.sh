#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "用法：smoke-linux-package.sh <发行版> <x11|wayland> <产物目录>" >&2
  exit 2
fi

distro_id=$1
session_type=$2
artifact_root=$3

if [[ $session_type != "x11" && $session_type != "wayland" ]]; then
  echo "不支持的桌面会话：$session_type" >&2
  exit 2
fi

if [[ ! -d $artifact_root ]]; then
  echo "产物目录不存在：$artifact_root" >&2
  exit 2
fi

artifact_root=$(realpath "$artifact_root")

export HOME=/tmp/codex-desktop-release-smoke-home
export XDG_CACHE_HOME=$HOME/.cache
export XDG_CONFIG_HOME=$HOME/.config
export XDG_DATA_HOME=$HOME/.local/share
export XDG_RUNTIME_DIR=/tmp/codex-desktop-release-smoke-runtime
install -d -m 700 "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"

package_name=""
desktop_file=""
removal_kind="portable"
launch_argv=()

case $distro_id in
  ubuntu|debian)
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends cage dbus-x11 desktop-file-utils xauth xvfb xwayland
    mapfile -t package_paths < <(find "$artifact_root" -type f -name '*.deb' -print)
    if [[ ${#package_paths[@]} -ne 1 ]]; then
      echo "必须且只能找到一个 deb 产物" >&2
      exit 1
    fi
    package_path=${package_paths[0]}
    DEBIAN_FRONTEND=noninteractive apt-get install --yes "$package_path"
    package_name=$(dpkg-deb --field "$package_path" Package)
    launch_argv=(/usr/bin/codex-desktop-linux)
    removal_kind="deb"
    ;;
  fedora)
    dnf install --assumeyes cage dbus-daemon desktop-file-utils xorg-x11-server-Xvfb xorg-x11-xauth
    mapfile -t package_paths < <(find "$artifact_root" -type f -name '*.rpm' -print)
    if [[ ${#package_paths[@]} -ne 1 ]]; then
      echo "必须且只能找到一个 rpm 产物" >&2
      exit 1
    fi
    package_path=${package_paths[0]}
    dnf install --assumeyes "$package_path"
    package_name=$(rpm --query --package --queryformat '%{NAME}' "$package_path")
    launch_argv=(/usr/bin/codex-desktop-linux)
    removal_kind="rpm"
    ;;
  arch)
    pacman --sync --refresh --noconfirm cage dbus desktop-file-utils gtk3 webkit2gtk-4.1 xorg-server-xvfb xorg-xauth xorg-xwayland
    mapfile -t package_paths < <(find "$artifact_root" -type f -name '*.AppImage' -print)
    if [[ ${#package_paths[@]} -ne 1 ]]; then
      echo "必须且只能找到一个 AppImage 产物" >&2
      exit 1
    fi
    package_path=${package_paths[0]}
    chmod a+x "$package_path"
    launch_argv=("$package_path" --appimage-extract-and-run)
    ;;
  *)
    echo "不支持的发行版：$distro_id" >&2
    exit 2
    ;;
esac

if [[ $removal_kind != "portable" ]]; then
  if [[ ! -x /usr/bin/codex-desktop-linux ]]; then
    echo "安装包未提供预期可执行文件" >&2
    exit 1
  fi
  desktop_file=$(find /usr/share/applications -maxdepth 1 -type f -iname '*codex*.desktop' -print -quit)
  if [[ -z $desktop_file ]]; then
    echo "安装包未提供桌面条目" >&2
    exit 1
  fi
  desktop-file-validate "$desktop_file"
  grep --fixed-strings --line-regexp 'MimeType=x-scheme-handler/codex-desktop;' "$desktop_file"
  icon_file=$(find /usr/share/icons -type f -iname '*codex*' -print -quit)
  if [[ -z $icon_file ]]; then
    echo "安装包未提供应用图标" >&2
    exit 1
  fi
fi

if [[ $session_type == "x11" ]]; then
  timeout 45s xvfb-run --auto-servernum --server-args='-screen 0 1440x900x24' \
    dbus-run-session -- env \
    CODEX_DESKTOP_RELEASE_SMOKE=1 \
    GDK_BACKEND=x11 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    "${launch_argv[@]}"
else
  chown -R nobody "$HOME" "$XDG_RUNTIME_DIR"
  timeout 45s runuser --user nobody -- env \
    HOME="$HOME" \
    XDG_CACHE_HOME="$XDG_CACHE_HOME" \
    XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
    XDG_DATA_HOME="$XDG_DATA_HOME" \
    XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
    dbus-run-session -- env \
    CODEX_DESKTOP_RELEASE_SMOKE=1 \
    GDK_BACKEND=wayland \
    LIBGL_ALWAYS_SOFTWARE=1 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    WLR_BACKENDS=headless \
    WLR_LIBINPUT_NO_DEVICES=1 \
    WLR_RENDERER=pixman \
    cage -- "${launch_argv[@]}"
fi

case $removal_kind in
  deb)
    dpkg --remove "$package_name"
    ;;
  rpm)
    rpm --erase "$package_name"
    ;;
  portable)
    ;;
esac

if [[ $removal_kind != "portable" ]]; then
  if [[ -e /usr/bin/codex-desktop-linux || -e $desktop_file ]]; then
    echo "卸载后仍残留应用入口" >&2
    exit 1
  fi
fi
