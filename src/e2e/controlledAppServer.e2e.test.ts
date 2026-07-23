/// <reference types="node" />

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppServerAccountClient,
  AppServerConversationClient,
  AppServerFileClient,
  AppServerInteractionClient,
  AppServerSession,
  AppServerThreadClient,
} from "../appServer";
import type { JSONRPCMessage, ServerNotification } from "../protocol/generated";
import type {
  ProtocolTransport,
  ProtocolTransportConnector,
  ProtocolTransportEventHandlers,
} from "../transport";

const FIXTURE_PATH = resolve(
  process.cwd(),
  "tests/fixtures/controlled-app-server.mjs",
);
const activeTransports = new Set<ChildProcessTransport>();
const temporaryDirectories = new Set<string>();

class ChildProcessTransport implements ProtocolTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly outputLines: Interface;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private stderrBytes = 0;

  constructor(
    statePath: string,
    private readonly handlers: ProtocolTransportEventHandlers,
  ) {
    this.process = spawn(process.execPath, [FIXTURE_PATH], {
      env: {
        CONTROLLED_APP_SERVER_STATE: statePath,
        PATH: "/usr/bin:/bin",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.outputLines = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });
    this.outputLines.on("line", (line) => {
      if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
        this.handlers.onTransportFailure();
        return;
      }
      this.handlers.onProtocolMessage(line);
    });
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > 16 * 1024) this.handlers.onTransportFailure();
    });
    this.process.once("error", () => this.handlers.onTransportFailure());
    this.process.once("exit", (code) => {
      activeTransports.delete(this);
      if (!this.closing) {
        if (code === 0) this.handlers.onTransportClosed();
        else this.handlers.onTransportFailure();
      }
    });
    activeTransports.add(this);
  }

  async write(message: JSONRPCMessage): Promise<void> {
    if (this.closing || !this.process.stdin.writable) {
      throw new Error("controlled app-server stdin is closed");
    }
    await new Promise<void>((resolve, reject) => {
      this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    this.outputLines.close();
    if (this.process.exitCode !== null) {
      activeTransports.delete(this);
      return;
    }
    this.process.stdin.end();
    const exited = once(this.process, "exit").then(() => undefined);
    const timedOut = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("controlled app-server did not exit")), 2_000);
    });
    try {
      await Promise.race([exited, timedOut]);
    } catch (error) {
      this.process.kill("SIGKILL");
      await exited;
      throw error;
    } finally {
      activeTransports.delete(this);
    }
  }
}

function fixtureConnector(statePath: string): ProtocolTransportConnector {
  return async (handlers) => new ChildProcessTransport(statePath, handlers);
}

async function createFixtureStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-desktop-e2e-"));
  temporaryDirectories.add(directory);
  return join(directory, "state.json");
}

afterEach(async () => {
  await Promise.all([...activeTransports].map((transport) => transport.close()));
  await Promise.all(
    [...temporaryDirectories].map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
      temporaryDirectories.delete(directory);
    }),
  );
});

describe("受控 stdio app-server 端到端", () => {
  it(
    "贯通初始化、会话、双审批、回答、steer、中断、分叉、远程文件、限额和重连恢复",
    async () => {
      const statePath = await createFixtureStatePath();
      const session = new AppServerSession({
        connectTransport: fixtureConnector(statePath),
      });
      const conversation = new AppServerConversationClient(session);
      const threads = new AppServerThreadClient(session);
      const files = new AppServerFileClient(session);
      const account = new AppServerAccountClient(session);
      const interaction = new AppServerInteractionClient(session);
      const notifications: ServerNotification[] = [];
      const rateLimitUpdates: ServerNotification[] = [];
      const releaseNotifications = conversation.subscribeNotifications(
        (notification) => notifications.push(notification),
      );
      const releaseRateLimits = account.subscribeRateLimitUpdates((notification) =>
        rateLimitUpdates.push(notification),
      );

      await expect(session.start()).resolves.toMatchObject({
        platformFamily: "unix",
        platformOs: "linux",
      });
      const started = await conversation.startThread({ cwd: "/workspace" }).result;
      expect(started.thread.id).toBe("thread-controlled");

      const turn = await conversation
        .startTurn(started.thread.id, {
          clientUserMessageId: "message-controlled",
          input: [{ type: "text", text: "执行受控流程" }],
        })
        .result;
      expect(turn.turn.status).toBe("inProgress");

      await vi.waitFor(() =>
        expect(interaction.getSnapshot().pending[0]?.request.method).toBe(
          "item/commandExecution/requestApproval",
        ),
      );
      const commandApproval = interaction.getSnapshot().pending[0];
      expect(commandApproval).toBeDefined();
      expect(interaction.respond(commandApproval!.key, { decision: "accept" })).toBe(
        true,
      );

      await vi.waitFor(() =>
        expect(interaction.getSnapshot().pending[0]?.request.method).toBe(
          "item/fileChange/requestApproval",
        ),
      );
      const fileApproval = interaction.getSnapshot().pending[0];
      expect(fileApproval).toBeDefined();
      expect(interaction.respond(fileApproval!.key, { decision: "accept" })).toBe(
        true,
      );

      await vi.waitFor(() =>
        expect(
          notifications.some(({ method }) => method === "turn/completed"),
        ).toBe(true),
      );
      expect(
        notifications
          .filter(({ method }) => method === "item/completed")
          .map((notification) =>
            notification.method === "item/completed"
              ? notification.params.item.type
              : null,
          ),
      ).toEqual(["commandExecution", "fileChange", "agentMessage"]);
      expect(rateLimitUpdates).toHaveLength(1);

      await expect(
        conversation.steerTurn(started.thread.id, turn.turn.id, {
          clientUserMessageId: "steer-controlled",
          input: [{ type: "text", text: "追加受控指令" }],
        }).result,
      ).resolves.toEqual({ turnId: turn.turn.id });
      await expect(
        conversation.interruptTurn(started.thread.id, turn.turn.id).result,
      ).resolves.toEqual({});

      await expect(
        threads.resumeThread(started.thread.id).result,
      ).resolves.toMatchObject({
        thread: {
          turns: [{ id: turn.turn.id, status: "completed" }],
        },
      });
      const forked = await threads.forkThread(started.thread.id, turn.turn.id).result;
      expect(forked.thread).toMatchObject({
        forkedFromId: started.thread.id,
        id: "thread-forked",
      });

      await expect(files.getMetadata("/workspace/controlled.txt").result).resolves.toEqual({
        createdAtMs: 100,
        isDirectory: false,
        isFile: true,
        isSymlink: false,
        modifiedAtMs: 200,
      });
      await expect(files.readFile("/workspace/controlled.txt").result).resolves.toEqual({
        dataBase64: Buffer.from("controlled remote file\n", "utf8").toString(
          "base64",
        ),
      });
      await expect(account.readRateLimits().result).resolves.toMatchObject({
        rateLimits: { primary: { usedPercent: 80 } },
      });

      await threads.archiveThread(started.thread.id).result;
      await expect(threads.listRecentThreads({ archived: true }).result).resolves.toMatchObject({
        data: [{ id: started.thread.id }],
      });
      await threads.unarchiveThread(started.thread.id).result;

      releaseRateLimits();
      releaseNotifications();
      interaction.dispose();
      await session.close();

      const restoredSession = new AppServerSession({
        connectTransport: fixtureConnector(statePath),
      });
      await restoredSession.start();
      const restoredThreads = new AppServerThreadClient(restoredSession);
      await expect(restoredThreads.listRecentThreads().result).resolves.toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({ id: started.thread.id }),
          expect.objectContaining({ id: forked.thread.id }),
        ]),
      });
      await restoredThreads.deleteThread(started.thread.id).result;
      await restoredThreads.deleteThread(forked.thread.id).result;
      await expect(restoredThreads.listRecentThreads().result).resolves.toMatchObject({
        data: [],
      });
      await restoredSession.close();
    },
    20_000,
  );
});
