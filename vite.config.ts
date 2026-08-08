import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import packageMetadata from "./package.json";

const host = process.env.TAURI_DEV_HOST;
const desktopVersion = process.env.CODEX_DESKTOP_VERSION ?? packageMetadata.version;

export default defineConfig({
  plugins: [react()],
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
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    restoreMocks: true,
  },
});
