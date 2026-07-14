import { Channel, invoke } from "@tauri-apps/api/core";

export interface TauriEventChannel {
  readonly channel: unknown;
}

export interface TauriIpc {
  createEventChannel(onMessage: (event: unknown) => void): TauriEventChannel;
  invoke<T>(command: string, arguments_: Record<string, unknown>): Promise<T>;
}

export const tauriIpc: TauriIpc = {
  createEventChannel(onMessage) {
    return { channel: new Channel(onMessage) };
  },
  invoke<T>(command: string, arguments_: Record<string, unknown>) {
    return invoke<T>(command, arguments_);
  },
};
