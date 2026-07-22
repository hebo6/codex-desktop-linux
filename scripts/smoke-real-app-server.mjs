#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

import {
  validateConfigReadResponse,
  validateConfigRequirementsReadResponse,
  validateInitializeResponse,
  validateJSONRPCMessage,
  validateThreadListResponse,
} from "../src/protocol/generated/validators.js";

const executable = process.env.CODEX_E2E_EXECUTABLE ?? "/usr/bin/codex";
if (!isAbsolute(executable) || executable.includes("\0")) {
  throw new Error("CODEX_E2E_EXECUTABLE 必须是绝对路径");
}
await access(executable, constants.X_OK);

const temporaryHome = await mkdtemp("/tmp/codex-desktop-real-app-server-");
await chmod(temporaryHome, 0o700);

let child;
let outputLines;
let stderrBytes = 0;
const pending = new Map();
let protocolFailure;

try {
  child = spawn(executable, ["app-server"], {
    cwd: process.cwd(),
    env: {
      CODEX_HOME: temporaryHome,
      HOME: temporaryHome,
      LANG: "C.UTF-8",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
      XDG_CACHE_HOME: join(temporaryHome, "cache"),
      XDG_CONFIG_HOME: join(temporaryHome, "config"),
      XDG_DATA_HOME: join(temporaryHome, "data"),
      XDG_STATE_HOME: join(temporaryHome, "state"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  outputLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  outputLines.on("line", (line) => {
    if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
      failProtocol(new Error("真实 app-server 返回超长协议行"));
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failProtocol(new Error("真实 app-server 返回无效 JSON"));
      return;
    }
    if (!validateJSONRPCMessage(message)) {
      failProtocol(new Error("真实 app-server 返回无效 JSON-RPC envelope"));
      return;
    }
    if (typeof message.id !== "string") return;
    const waiter = pending.get(message.id);
    if (waiter !== undefined) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 64 * 1024) {
      failProtocol(new Error("真实 app-server stderr 超过安全上限"));
    }
  });
  child.once("error", (error) => failProtocol(error));
  child.once("exit", (code, signal) => {
    if (pending.size === 0) return;
    failProtocol(
      new Error(
        `真实 app-server 提前退出（code=${String(code)} signal=${String(signal)}）`,
      ),
    );
  });

  const initialize = await request("real-initialize", "initialize", {
    capabilities: { experimentalApi: true },
    clientInfo: {
      name: "codex-desktop-linux",
      title: "Codex Desktop Linux",
      version: "0.1.0",
    },
  });
  if ("error" in initialize) {
    throw new Error(`真实 app-server 拒绝初始化（code=${initialize.error.code}）`);
  }
  if (!validateInitializeResponse(initialize.result)) {
    throw new Error("真实 app-server 初始化响应不符合固定 Schema");
  }
  send({ method: "initialized" });

  const configRead = await request("real-config-read", "config/read", {
    includeLayers: false,
  });
  if ("error" in configRead) {
    throw new Error(`真实 app-server 拒绝 config/read（code=${configRead.error.code}）`);
  }
  if (!validateConfigReadResponse(configRead.result)) {
    throw new Error("真实 app-server config/read 响应不符合固定 Schema");
  }

  const configRequirementsRead = await request(
    "real-config-requirements-read",
    "configRequirements/read",
    undefined,
  );
  if ("error" in configRequirementsRead) {
    throw new Error(
      `真实 app-server 拒绝 configRequirements/read（code=${configRequirementsRead.error.code}）`,
    );
  }
  if (!validateConfigRequirementsReadResponse(configRequirementsRead.result)) {
    throw new Error("真实 app-server configRequirements/read 响应不符合固定 Schema");
  }

  const threadList = await request("real-thread-list", "thread/list", {
    archived: false,
    limit: 1,
    sortDirection: "desc",
    sortKey: "updated_at",
  });
  if ("error" in threadList) {
    throw new Error(`真实 app-server 拒绝 thread/list（code=${threadList.error.code}）`);
  }
  if (!validateThreadListResponse(threadList.result)) {
    throw new Error("真实 app-server thread/list 响应不符合固定 Schema");
  }

  process.stdout.write(
    `真实 app-server 冒烟通过：${initialize.result.platformOs} ${initialize.result.platformFamily}，返回 ${threadList.result.data.length} 个隔离测试会话\n`,
  );
} finally {
  outputLines?.close();
  if (child !== undefined && child.exitCode === null) {
    child.stdin.end();
    const exited = once(child, "exit").then(() => undefined);
    try {
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  }
  await rm(temporaryHome, { force: true, recursive: true });
}

function request(id, method, params) {
  if (protocolFailure !== undefined) return Promise.reject(protocolFailure);
  const response = new Promise((resolve, reject) => {
    pending.set(id, { reject, resolve });
  });
  send({ id, method, params });
  return withTimeout(response, 10_000, method);
}

function send(message) {
  if (child === undefined || !child.stdin.writable) {
    throw new Error("真实 app-server stdin 不可写");
  }
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function failProtocol(error) {
  if (protocolFailure !== undefined) return;
  protocolFailure = error;
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

async function withTimeout(promise, timeoutMs, method) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`真实 app-server ${method} 超时`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
