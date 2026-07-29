#!/usr/bin/env bash
set -euo pipefail

rust_target=$(rustc -vV | sed -n 's/^host: //p')

case $rust_target in
  x86_64-unknown-linux-gnu | aarch64-unknown-linux-gnu)
    ;;
  *)
    echo "不支持的 AppImage 目标：$rust_target" >&2
    exit 1
    ;;
esac

bundle_root="src-tauri/target/$rust_target/release/bundle"

env NO_STRIP=true pnpm tauri build --ci --target "$rust_target" --bundles appimage
bash scripts/finalize-appimage.sh "$bundle_root" "$rust_target"
