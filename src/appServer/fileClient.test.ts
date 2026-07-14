import { describe, expect, it } from "vitest";

import type { RequestHandle, SendRequestOptions } from "../protocol/rpc";
import { AppServerFileClient } from "./fileClient";

class RecordingSession {
  readonly requests: SendRequestOptions<unknown>[] = [];
  sendRequest<T>(options: SendRequestOptions<T>): RequestHandle<T> {
    this.requests.push(options as SendRequestOptions<unknown>);
    return { epoch: 1, id: this.requests.length, stage: "pending", result: new Promise<T>(() => undefined) };
  }
}

describe("AppServerFileClient", () => {
  it("通过服务器绝对路径读取元数据和内容", () => {
    const session = new RecordingSession();
    const client = new AppServerFileClient(session);
    client.getMetadata("/remote/project/README.md");
    client.readFile("/remote/project/README.md");
    expect(session.requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "fs/getMetadata", params: { path: "/remote/project/README.md" } },
      { method: "fs/readFile", params: { path: "/remote/project/README.md" } },
    ]);
    expect(session.requests.every(({ validateResult }) => !validateResult(null).ok)).toBe(true);
  });
});
