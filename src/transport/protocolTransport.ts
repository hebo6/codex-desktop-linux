import type { RpcWriter } from "../protocol/rpc";

/**
 * app-server 会话只依赖逐条 JSON 消息与可关闭写端，具体传输负责消息分帧
 */
export interface ProtocolTransport extends RpcWriter {
  close(): Promise<void>;
}

export type TransportConnectionStage =
  | "resolvingTarget"
  | "connectingProxy"
  | "proxyAuthentication"
  | "establishingTunnel"
  | "targetTls"
  | "webSocketHandshake";

export interface LocalProcessTermination {
  readonly kind: "localProcess";
  readonly status: "disconnected" | "exited" | "error";
  readonly reason:
    | "requested"
    | "processExited"
    | "invalidUtf8"
    | "invalidJson"
    | "lineTooLong"
    | "stdoutReadFailed"
    | "eventDeliveryFailed"
    | "childWaitFailed";
  readonly exitCode?: number;
  readonly signal?: number;
  readonly stderrBytes: number;
  readonly forced: boolean;
}

export type ProtocolTransportTermination = LocalProcessTermination;

export interface ProtocolTransportEventHandlers {
  readonly onProtocolMessage: (json: string) => void;
  readonly onConnectionProgress?: (stage: TransportConnectionStage) => void;
  readonly onTransportClosed: (termination?: ProtocolTransportTermination) => void;
  readonly onTransportFailure: () => void;
}

export type ProtocolTransportConnector = (
  handlers: ProtocolTransportEventHandlers,
) => Promise<ProtocolTransport>;
