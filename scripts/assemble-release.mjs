import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const inputRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, "src-tauri/target"));
const outputRoot = path.resolve(process.argv[3] ?? path.join(projectRoot, "release-artifacts"));
const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const version = packageMetadata.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new TypeError("package.json 中的版本号无效");
}

const discovered = await collectPackages(inputRoot);
const expected = [
  ["x86_64", "AppImage"],
  ["x86_64", "deb"],
  ["x86_64", "rpm"],
  ["aarch64", "AppImage"],
  ["aarch64", "deb"],
  ["aarch64", "rpm"],
];
const selected = new Map();

for (const source of discovered) {
  const extension = packageExtension(source);
  const architecture = packageArchitecture(source);
  if (extension === null || architecture === null) continue;
  const key = `${architecture}:${extension}`;
  if (selected.has(key)) throw new Error(`发现重复发行包：${key}`);
  selected.set(key, source);
}

const missing = expected
  .map(([architecture, extension]) => `${architecture}:${extension}`)
  .filter((key) => !selected.has(key));
if (missing.length > 0) {
  throw new Error(`缺少发行包：${missing.join("、")}`);
}

await rm(outputRoot, { force: true, recursive: true });
await mkdir(outputRoot, { recursive: true });
const artifacts = [];
for (const [architecture, extension] of expected) {
  const source = selected.get(`${architecture}:${extension}`);
  const name = `codex-desktop-linux-${version}-${architecture}.${extension}`;
  const destination = path.join(outputRoot, name);
  await copyFile(source, destination);
  artifacts.push(destination);
}

const checksums = [];
for (const artifact of artifacts) {
  const contents = await readFile(artifact);
  checksums.push(`${createHash("sha256").update(contents).digest("hex")}  ${path.basename(artifact)}`);
}
await writeFile(path.join(outputRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`, "utf8");
console.log(`已整理 ${artifacts.length} 个发行包到 ${outputRoot}`);

async function collectPackages(root) {
  const packages = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) packages.push(...await collectPackages(entryPath));
    else if (packageExtension(entryPath) !== null) packages.push(entryPath);
  }
  return packages;
}

function packageExtension(filePath) {
  if (filePath.endsWith(".AppImage")) return "AppImage";
  if (filePath.endsWith(".deb")) return "deb";
  if (filePath.endsWith(".rpm")) return "rpm";
  return null;
}

function packageArchitecture(filePath) {
  const value = filePath.toLocaleLowerCase();
  if (/(?:x86_64|amd64)/u.test(value)) return "x86_64";
  if (/(?:aarch64|arm64)/u.test(value)) return "aarch64";
  return null;
}
