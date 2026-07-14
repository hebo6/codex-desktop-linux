import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createServer } from "vite";

const execute = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(projectRoot, "tests/visual/visual-regression.json");
const baselineRoot = path.join(projectRoot, "tests/visual/baselines");
const currentRoot = "/tmp/codex-desktop-visual-current";
const chromeProfile = "/tmp/codex-desktop-visual-chrome";
const mode = process.argv[2] ?? "verify";

if (!new Set(["verify", "update", "list"]).has(mode)) {
  throw new Error("用法：node scripts/visual-regression.mjs [verify|update|list]");
}

const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
const cases = manifest.sizes.flatMap((size) =>
  manifest.themes.flatMap((theme) =>
    manifest.states.map((state) => ({ ...size, state, theme })),
  ),
);

if (mode === "list") {
  for (const visualCase of cases) console.log(fileName(visualCase));
  process.exit(0);
}

await requireExecutable("chrome-devtools");
await access("/usr/bin/chromium", constants.X_OK);
await rm(currentRoot, { force: true, recursive: true });
await mkdir(currentRoot, { recursive: true });
if (mode === "update") await mkdir(baselineRoot, { recursive: true });

const server = await createServer({
  configFile: path.join(projectRoot, "vite.config.ts"),
  logLevel: "error",
  root: projectRoot,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
});

try {
  await server.listen();
  await runChrome("start", [
    "--executablePath", "/usr/bin/chromium",
    "--headless=false",
    "--userDataDir", chromeProfile,
  ]);
  const mismatches = [];
  for (const visualCase of cases) {
    const name = fileName(visualCase);
    const currentPath = path.join(currentRoot, name);
    const baselinePath = path.join(baselineRoot, name);
    const url = `http://127.0.0.1:1420/?visualFixture=${visualCase.state}&theme=${visualCase.theme}`;
    await runChrome("navigate_page", ["--type", "url", "--url", url]);
    await runChrome("resize_page", [String(visualCase.width), String(visualCase.height)]);
    await runChrome("evaluate_script", [waitUntilReadyScript()]);
    await runChrome("take_screenshot", ["--filePath", currentPath]);
    await assertScreenshotDimensions(currentPath, visualCase.width, visualCase.height);
    if (mode === "update") {
      await copyFile(currentPath, baselinePath);
      console.log(`已更新 ${name}`);
      continue;
    }
    try {
      const [current, baseline] = await Promise.all([
        readFile(currentPath),
        readFile(baselinePath),
      ]);
      if (!current.equals(baseline)) mismatches.push(name);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        mismatches.push(`${name}（缺少基线）`);
      } else {
        throw error;
      }
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`视觉回归不一致：\n${mismatches.map((name) => `- ${name}`).join("\n")}\n当前截图保留在 ${currentRoot}`);
  }
  console.log(`视觉回归通过，共 ${cases.length} 个场景`);
} finally {
  await server.close();
}

async function requireExecutable(command) {
  try {
    await execute("sh", ["-c", `command -v ${command}`]);
  } catch {
    throw new Error(`缺少 ${command}，请在预装视觉测试环境中执行`);
  }
}

async function runChrome(command, arguments_) {
  const { stdout } = await execute("chrome-devtools", [command, ...arguments_], {
    cwd: projectRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (stdout.trim().length > 0) console.log(stdout.trim());
}

async function assertScreenshotDimensions(filePath, expectedWidth, expectedHeight) {
  const screenshot = await readFile(filePath);
  const pngSignature = "89504e470d0a1a0a";
  if (
    screenshot.length < 24 ||
    screenshot.subarray(0, 8).toString("hex") !== pngSignature
  ) {
    throw new Error(`视觉回归截图不是有效的 PNG：${filePath}`);
  }
  const width = screenshot.readUInt32BE(16);
  const height = screenshot.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(
      `视觉回归截图尺寸错误：期望 ${expectedWidth}x${expectedHeight}，实际 ${width}x${height}`,
    );
  }
}

function fileName(visualCase) {
  return `${visualCase.width}x${visualCase.height}-${visualCase.theme}-${visualCase.state}.png`;
}

function waitUntilReadyScript() {
  return `() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      const fixture = document.querySelector('[data-visual-ready="true"]');
      if (fixture !== null) {
        document.fonts.ready.then(
          () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
          reject,
        );
      } else if (Date.now() >= deadline) {
        reject(new Error('视觉场景未就绪'));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  })`;
}

function validateManifest(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("视觉回归清单格式无效");
  }
  const sizes = value.sizes;
  const themes = value.themes;
  const states = value.states;
  if (!Array.isArray(sizes) || !Array.isArray(themes) || !Array.isArray(states)) {
    throw new TypeError("视觉回归清单缺少尺寸、主题或场景");
  }
  const expectedSizes = ["1440x900", "1280x800", "960x640"];
  const actualSizes = sizes.map((size) => `${size.width}x${size.height}`);
  if (JSON.stringify(actualSizes) !== JSON.stringify(expectedSizes)) {
    throw new TypeError("视觉回归尺寸必须为 1440x900、1280x800 和 960x640");
  }
  if (JSON.stringify(themes) !== JSON.stringify(["light", "dark"])) {
    throw new TypeError("视觉回归主题必须覆盖浅色和深色");
  }
  if (JSON.stringify(states) !== JSON.stringify(["conversation", "slash", "model", "settings"])) {
    throw new TypeError("视觉回归场景不完整");
  }
  return { sizes, themes, states };
}
