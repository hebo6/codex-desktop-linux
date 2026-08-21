#!/bin/sh

set -eu

readonly expected_commit="657bd889ae28edcbf5395c103b479bf8b328704e"
readonly expected_codex_version="codex-cli 0.149.0"

project_dir=$(realpath "$(dirname "$0")/..")
schema_dir="$project_dir/protocol/schema"
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

actual_codex_version=$(codex --version)
if [ "$actual_codex_version" != "$expected_codex_version" ]; then
    printf '%s\n' "Codex CLI 版本不匹配" >&2
    printf '%s\n' "期望: $expected_codex_version" >&2
    printf '%s\n' "实际: $actual_codex_version" >&2
    exit 1
fi

temporary_dir=$(mktemp -d /tmp/codex-app-server-schema.XXXXXX)
raw_generated_dir="$temporary_dir/raw"
generated_dir="$temporary_dir/schema"

cleanup() {
    rm -rf "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

codex app-server generate-json-schema \
    --experimental \
    --out "$raw_generated_dir"

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
    printf '%s\n' "协议 Schema 与固定 Codex CLI 版本一致"
    exit 0
fi

mkdir -p "$schema_dir"
find "$schema_dir" -mindepth 1 -delete
cp -a "$generated_dir/." "$schema_dir/"
printf '%s\n' "协议 Schema 已更新到 $schema_dir"
