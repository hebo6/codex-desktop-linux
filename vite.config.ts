import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import packageMetadata from "./package.json";

const host = process.env.TAURI_DEV_HOST;
const desktopVersion = process.env.CODEX_DESKTOP_VERSION ?? packageMetadata.version;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 浏览器导出用 template.innerHTML 解析 KaTeX，触发严格 CSP 的样式拦截
      // 选用同包的默认纯解析器，公式 HTML 全程作为数据处理
      "hast-util-from-html-isomorphic": fileURLToPath(import.meta.resolve("hast-util-from-html-isomorphic")),
    },
  },
  define: {
    CODEX_DESKTOP_VERSION: JSON.stringify(desktopVersion),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    restoreMocks: true,
  },
});
