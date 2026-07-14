#!/bin/sh

set -eu

readonly expected_commit="ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c"

project_dir=$(realpath "$(dirname "$0")/..")
schema_dir="$project_dir/protocol/schema"
codex_source_dir=${CODEX_SOURCE_DIR:-}
mode=${1:---check}

usage() {
    printf '%s\n' "用法: $0 [--check|--update]"
}

case "$mode" in
    --check | --update)
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac

if [ -z "$codex_source_dir" ]; then
    printf '%s\n' "请通过 CODEX_SOURCE_DIR 指定 Codex 源码仓库绝对路径" >&2
    exit 1
fi

if ! git -C "$codex_source_dir" rev-parse --git-dir >/dev/null 2>&1; then
    printf '%s\n' "Codex 源码目录不是 Git 仓库: $codex_source_dir" >&2
    exit 1
fi

actual_commit=$(git -C "$codex_source_dir" rev-parse HEAD)
if [ "$actual_commit" != "$expected_commit" ]; then
    printf '%s\n' "Codex 源码提交不匹配" >&2
    printf '%s\n' "期望: $expected_commit" >&2
    printf '%s\n' "实际: $actual_commit" >&2
    exit 1
fi

if [ -n "$(git -C "$codex_source_dir" status --porcelain --untracked-files=all)" ]; then
    printf '%s\n' "Codex 源码仓库存在未提交变更，无法生成可复现基线" >&2
    exit 1
fi

temporary_dir=$(mktemp -d /tmp/codex-app-server-schema.XXXXXX)
raw_generated_dir="$temporary_dir/raw"
generated_dir="$temporary_dir/schema"
readonly cargo_target_dir="$project_dir/.cache/protocol-schema-target"
readonly maximum_cache_size_kib=4194304

cleanup() {
    rm -rf "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

check_cache_size() {
    if [ ! -d "$cargo_target_dir" ]; then
        return
    fi

    cache_size_kib=$(du -sk "$cargo_target_dir" | awk '{print $1}')
    if [ "$cache_size_kib" -gt "$maximum_cache_size_kib" ]; then
        printf '%s\n' "协议 Schema 构建缓存超过 4 GiB，请先检查 $cargo_target_dir" >&2
        exit 1
    fi
}

check_cache_size

env CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$cargo_target_dir" \
    cargo run \
    --locked \
    --manifest-path "$codex_source_dir/codex-rs/Cargo.toml" \
    --package codex-app-server-protocol \
    --bin export \
    -- \
    --experimental \
    --out "$raw_generated_dir"

check_cache_size

mkdir -p "$generated_dir"
find "$raw_generated_dir" -type f -name '*.json' -printf '%P\n' \
    | LC_ALL=C sort \
    | while IFS= read -r relative_path; do
        destination_path="$generated_dir/$relative_path"
        mkdir -p "$(dirname "$destination_path")"
        cp "$raw_generated_dir/$relative_path" "$destination_path"
    done

printf '%s\n' "$expected_commit" >"$generated_dir/UPSTREAM_COMMIT"

find "$generated_dir" -type f -name '*.json' -printf '%P\n' \
    | LC_ALL=C sort \
    | while IFS= read -r relative_path; do
        checksum_output=$(sha256sum "$generated_dir/$relative_path")
        checksum=${checksum_output%% *}
        printf '%s  protocol/schema/%s\n' "$checksum" "$relative_path"
    done >"$generated_dir/SHA256SUMS"

if [ "$mode" = "--check" ]; then
    if [ ! -d "$schema_dir" ]; then
        printf '%s\n' "协议基线不存在，请先执行 $0 --update" >&2
        exit 1
    fi

    diff -ru "$schema_dir" "$generated_dir"
    printf '%s\n' "协议 Schema 与固定提交一致"
    exit 0
fi

mkdir -p "$schema_dir"
find "$schema_dir" -mindepth 1 -delete
cp -a "$generated_dir/." "$schema_dir/"
printf '%s\n' "协议 Schema 已更新到 $schema_dir"
