#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const statePath = process.env.CONTROLLED_APP_SERVER_STATE;
if (
  typeof statePath !== "string" ||
  !statePath.startsWith("/tmp/") ||
  statePath.includes("\0")
) {
  process.exitCode = 2;
  throw new Error("CONTROLLED_APP_SERVER_STATE must be an absolute /tmp path");
}

const state = loadState();
let pendingApproval = null;

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exitCode = 3;
    input.close();
    return;
  }
  handleMessage(message);
});

function handleMessage(message) {
  if (isResponse(message)) {
    handleApprovalResponse(message);
    return;
  }
  if (!isRequest(message)) return;
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      respond(id, {
        codexHome: "/tmp/controlled-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "controlled-app-server/1",
      });
      break;
    case "thread/list":
      respond(id, {
        data: Object.values(state.threads)
          .filter((entry) => entry.archived === Boolean(params.archived))
          .map((entry) => entry.thread),
        nextCursor: null,
      });
      break;
    case "thread/start": {
      const thread = makeThread("thread-controlled");
      state.threads[thread.id] = { archived: false, thread };
      persist();
      respond(id, threadContext(thread));
      notify("thread/started", { thread });
      break;
    }
    case "thread/read": {
      const thread = requireThread(params.threadId);
      respond(id, { thread });
      break;
    }
    case "thread/resume": {
      const thread = requireThread(params.threadId);
      respond(id, threadContext(thread));
      break;
    }
    case "thread/unsubscribe":
      respond(id, {});
      break;
    case "turn/start":
      startControlledTurn(id, params.threadId);
      break;
    case "turn/steer":
      respond(id, { turnId: params.expectedTurnId });
      break;
    case "turn/interrupt":
      respond(id, {});
      break;
    case "thread/fork": {
      const source = requireThread(params.threadId);
      const thread = {
        ...makeThread("thread-forked"),
        forkedFromId: source.id,
        turns: [],
      };
      state.threads[thread.id] = { archived: false, thread };
      persist();
      respond(id, threadContext(thread));
      notify("thread/started", { thread });
      break;
    }
    case "thread/archive":
      setArchived(params.threadId, true);
      respond(id, {});
      notify("thread/archived", { threadId: params.threadId });
      break;
    case "thread/unarchive":
      setArchived(params.threadId, false);
      respond(id, { thread: requireThread(params.threadId) });
      notify("thread/unarchived", { threadId: params.threadId });
      break;
    case "thread/delete":
      requireThread(params.threadId);
      delete state.threads[params.threadId];
      persist();
      respond(id, {});
      notify("thread/deleted", { threadId: params.threadId });
      break;
    case "fs/getMetadata":
      respond(id, {
        createdAtMs: 100,
        isDirectory: false,
        isFile: true,
        isSymlink: false,
        modifiedAtMs: 200,
      });
      break;
    case "fs/readFile":
      respond(id, {
        dataBase64: Buffer.from("controlled remote file\n", "utf8").toString(
          "base64",
        ),
      });
      break;
    case "account/rateLimits/read":
      respond(id, rateLimitSnapshot());
      break;
    default:
      error(id, -32601, "Method not found");
  }
}

function startControlledTurn(requestId, threadId) {
  const thread = requireThread(threadId);
  const turn = {
    id: "turn-controlled",
    items: [],
    itemsView: "full",
    status: "inProgress",
  };
  thread.status = { activeFlags: ["waitingOnApproval"], type: "active" };
  respond(requestId, { turn });
  notify("turn/started", { threadId, turn });
  pendingApproval = { stage: "command", threadId, turn };
  request("approval-command", "item/commandExecution/requestApproval", {
    command: "printf controlled",
    cwd: "/workspace",
    itemId: "command-controlled",
    startedAtMs: 100,
    threadId,
    turnId: turn.id,
  });
}

function handleApprovalResponse(message) {
  if (pendingApproval === null) return;
  const { threadId, turn } = pendingApproval;
  if (pendingApproval.stage === "command" && message.id === "approval-command") {
    notify("serverRequest/resolved", {
      requestId: message.id,
      threadId,
    });
    const command = {
      aggregatedOutput: "controlled\n",
      command: "printf controlled",
      commandActions: [],
      cwd: "/workspace",
      exitCode: 0,
      id: "command-controlled",
      status: responseAccepted(message) ? "completed" : "declined",
      type: "commandExecution",
    };
    turn.items.push(command);
    notify("item/completed", {
      completedAtMs: 150,
      item: command,
      threadId,
      turnId: turn.id,
    });
    pendingApproval = { stage: "file", threadId, turn };
    request("approval-file", "item/fileChange/requestApproval", {
      itemId: "file-controlled",
      startedAtMs: 151,
      threadId,
      turnId: turn.id,
    });
    return;
  }
  if (pendingApproval.stage === "file" && message.id === "approval-file") {
    notify("serverRequest/resolved", {
      requestId: message.id,
      threadId,
    });
    const file = {
      changes: [
        {
          diff: "+controlled\n",
          kind: { type: "add" },
          path: "/workspace/controlled.txt",
        },
      ],
      id: "file-controlled",
      status: responseAccepted(message) ? "completed" : "declined",
      type: "fileChange",
    };
    const answer = {
      id: "answer-controlled",
      phase: "final_answer",
      text: "受控回答完成",
      type: "agentMessage",
    };
    turn.items.push(file, answer);
    turn.status = "completed";
    turn.completedAt = 200;
    const thread = requireThread(threadId);
    thread.turns = [turn];
    thread.status = { type: "idle" };
    thread.updatedAt = 200;
    persist();
    notify("item/completed", {
      completedAtMs: 180,
      item: file,
      threadId,
      turnId: turn.id,
    });
    notify("item/completed", {
      completedAtMs: 190,
      item: answer,
      threadId,
      turnId: turn.id,
    });
    notify("account/rateLimits/updated", rateLimitSnapshot());
    notify("turn/completed", { threadId, turn });
    pendingApproval = null;
  }
}

function makeThread(id) {
  return {
    cliVersion: "0.1.0",
    createdAt: 100,
    cwd: "/workspace",
    ephemeral: false,
    id,
    modelProvider: "openai",
    preview: "受控端到端会话",
    sessionId: `session-${id}`,
    source: "appServer",
    status: { type: "idle" },
    turns: [],
    updatedAt: 100,
  };
}

function threadContext(thread) {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: "/workspace",
    model: "gpt-5",
    modelProvider: "openai",
    sandbox: { type: "readOnly" },
    thread,
  };
}

function rateLimitSnapshot() {
  return {
    rateLimits: {
      limitId: "codex",
      primary: {
        resetsAt: 2000000000,
        usedPercent: 80,
        windowDurationMins: 300,
      },
    },
  };
}

function setArchived(threadId, archived) {
  const thread = requireThread(threadId);
  state.threads[threadId] = { archived, thread };
  persist();
}

function requireThread(threadId) {
  const entry = state.threads[threadId];
  if (entry === undefined) throw new Error("controlled thread not found");
  return entry.thread;
}

function responseAccepted(message) {
  return message?.result?.decision === "accept";
}

function respond(id, result) {
  send({ id, result });
}

function error(id, code, message) {
  send({ error: { code, message }, id });
}

function notify(method, params) {
  send({ method, params });
}

function request(id, method, params) {
  send({ id, method, params });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isRequest(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    typeof message.method === "string"
  );
}

function isResponse(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
  );
}

function loadState() {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    if (typeof value === "object" && value !== null && value.version === 1) {
      return value;
    }
  } catch {
    // 首次启动没有状态文件
  }
  return { version: 1, threads: {} };
}

function persist() {
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}
