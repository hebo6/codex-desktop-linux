export class RpcConnectionError extends Error {
  constructor(message = "JSON-RPC connection is not available") {
    super(message);
    this.name = "RpcConnectionError";
  }
}

export class RpcConnectionClosedError extends Error {
  constructor() {
    super("JSON-RPC connection closed before the request completed");
    this.name = "RpcConnectionClosedError";
  }
}

export class RpcInitializationStateError extends Error {
  constructor(message = "JSON-RPC connection initialization is not allowed in the current state") {
    super(message);
    this.name = "RpcInitializationStateError";
  }
}

export class RpcInitializationFailedError extends Error {
  constructor() {
    super("JSON-RPC connection initialization failed");
    this.name = "RpcInitializationFailedError";
  }
}

export class RpcQueueCapacityError extends Error {
  constructor(capacity: number) {
    super(`JSON-RPC initialization queue capacity ${capacity} was reached`);
    this.name = "RpcQueueCapacityError";
  }
}

export class RpcWriteError extends Error {
  constructor() {
    super("JSON-RPC request could not be written to the transport");
    this.name = "RpcWriteError";
  }
}

export class RpcRemoteError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcRemoteError";
    this.code = code;
  }
}

export class RpcInvalidResultError extends Error {
  constructor(method: string) {
    super(`JSON-RPC response for ${method} failed result validation`);
    this.name = "RpcInvalidResultError";
  }
}
