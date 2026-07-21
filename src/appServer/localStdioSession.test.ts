import { describe, expect, it } from "vitest";

import packageMetadata from "../../package.json";
import type { LocalStdioIpc } from "../transport/localStdio";
import { createLocalStdioAppServerSession } from "./localStdioSession";

interface InvokeCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class HandshakeIpc implements LocalStdioIpc {
  readonly calls: InvokeCall[] = [];
  private eventHandler: ((event: unknown) => void) | undefined;

  createEventChannel(onMessage: (event: unknown) => void): { channel: unknown } {
    this.eventHandler = onMessage;
    return { channel: { kind: "test-channel" } };
  }

  async invoke<T>(command: string, arguments_: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    if (command === "connect_local_stdio") {
      this.emit({
        kind: "status",
        connectionId: "local",
        status: "connected",
        stderrBytes: 0,
        forced: false,
      });
      return { connectionId: "local" } as T;
    }
    if (command === "send_local_stdio_message") {
      const request = asRecord(arguments_.request);
      const message = asRecord(JSON.parse(String(request.json)) as unknown);
      if (message.method === "initialize") {
        this.emit({
          kind: "protocolMessage",
          connectionId: "local",
          json: JSON.stringify({
            id: message.id,
            result: {
              codexHome: "/home/user/.codex",
              platformFamily: "unix",
              platformOs: "linux",
              userAgent: "codex-test",
            },
          }),
        });
      }
      return undefined as T;
    }
    if (command === "disconnect_local_stdio") {
      this.emit({
        kind: "status",
        connectionId: "local",
        status: "disconnected",
        reason: "requested",
        stderrBytes: 0,
        forced: false,
      });
      return undefined as T;
    }
    throw new Error(`unexpected command: ${command}`);
  }

  private emit(event: unknown): void {
    if (this.eventHandler === undefined) {
      throw new Error("event channel was not created");
    }
    this.eventHandler(event);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("expected a record");
  }
  return value as Record<string, unknown>;
}

describe("createLocalStdioAppServerSession", () => {
  it("贯通 Tauri Channel、本地 writer 和 app-server 初始化状态机", async () => {
    const ipc = new HandshakeIpc();
    const phases: string[] = [];
    const session = createLocalStdioAppServerSession({
      request: {
        connectionId: "local",
        executablePath: "/usr/bin/codex",
        arguments: ["app-server"],
        workingDirectory: "/workspace",
      },
      ipc,
      onStateChange: ({ phase }) => phases.push(phase),
    });

    await expect(session.start()).resolves.toMatchObject({
      platformOs: "linux",
      userAgent: "codex-test",
    });

    expect(ipc.calls.map(({ command }) => command)).toEqual([
      "connect_local_stdio",
      "send_local_stdio_message",
      "send_local_stdio_message",
    ]);
    const outboundMessages = ipc.calls
      .filter(({ command }) => command === "send_local_stdio_message")
      .map(({ arguments: arguments_ }) => {
        const request = asRecord(arguments_.request);
        return JSON.parse(String(request.json)) as unknown;
      });
    expect(outboundMessages).toEqual([
      {
        id: expect.any(String),
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-desktop-linux",
            title: "Codex Desktop Linux",
            version: packageMetadata.version,
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method: "initialized" },
    ]);
    expect(phases).toEqual(["connecting", "initializing", "ready"]);

    await session.close();
    expect(ipc.calls.at(-1)?.command).toBe("disconnect_local_stdio");
    expect(session.state.phase).toBe("closed");
  });
});
