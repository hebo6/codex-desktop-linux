#!/usr/bin/env bash
set -euo pipefail

release_directory="${1:-release-artifacts}"

if [[ -z "${GPG_KEY_ID:-}" ]]; then
  echo "缺少 GPG_KEY_ID" >&2
  exit 1
fi

shopt -s nullglob
release_files=(
  "$release_directory"/*.AppImage
  "$release_directory"/*.deb
  "$release_directory"/*.rpm
  "$release_directory"/SHA256SUMS
)

if [[ "${#release_files[@]}" -ne 7 ]]; then
  echo "签名前必须存在六个安装包和 SHA256SUMS" >&2
  exit 1
fi

for release_file in "${release_files[@]}"; do
  gpg \
    --armor \
    --batch \
    --detach-sign \
    --local-user "$GPG_KEY_ID" \
    --output "$release_file.asc" \
    --passphrase "${GPG_PASSPHRASE:-}" \
    --pinentry-mode loopback \
    --yes \
    "$release_file"
done

echo "已生成 ${#release_files[@]} 个分离签名"
