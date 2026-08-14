#!/usr/bin/env node

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const [archivePath, outputDirectory] = process.argv.slice(2);

if (archivePath === undefined || outputDirectory === undefined || process.argv.length !== 4) {
  throw new Error(
    "用法：node scripts/extract-precomputed-protocol-schema.mjs <archive> <output-directory>",
  );
}

const archive = await readFile(archivePath);
const precomputedExports = JSON.parse(zstdDecompressSync(archive).toString("utf8"));
const schemas = precomputedExports?.json_schema;

if (schemas === null || typeof schemas !== "object" || Array.isArray(schemas)) {
  throw new Error("上游预计算协议归档缺少 json_schema 对象");
}

const entries = Object.entries(schemas);
if (entries.length === 0) {
  throw new Error("上游预计算协议归档不包含 JSON Schema");
}

for (const [relativePath, contents] of entries) {
  if (
    !relativePath.endsWith(".json") ||
    relativePath.startsWith("/") ||
    relativePath
      .split("/")
      .some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`上游预计算协议归档包含不安全路径：${relativePath}`);
  }
  if (typeof contents !== "string") {
    throw new Error(`上游预计算协议归档包含非文本 Schema：${relativePath}`);
  }

  const outputPath = join(outputDirectory, relativePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents, "utf8");
}
