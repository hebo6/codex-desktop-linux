// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：657bd889ae28edcbf5395c103b479bf8b328704e

export interface InitializeParams {
  capabilities?: InitializeCapabilities | null;
  clientInfo: ClientInfo;
  [k: string]: unknown | undefined;
}
/**
 * Client-declared capabilities negotiated during initialize.
 */
export interface InitializeCapabilities {
  /**
   * Opt into receiving experimental API methods and fields.
   */
  experimentalApi?: boolean;
  /**
   * MCP extension settings declared by the app-server client.
   */
  extensions?: {
    [k: string]: unknown | undefined;
  } | null;
  /**
   * Legacy opt-in for the `openai/form` MCP extension.
   *
   * New clients should declare `openai/form` in [`Self::extensions`].
   */
  mcpServerOpenaiFormElicitation?: boolean;
  /**
   * Exact notification method names that should be suppressed for this connection (for example `thread/started`).
   */
  optOutNotificationMethods?: string[] | null;
  /**
   * Opt into `attestation/generate` requests for upstream `x-oai-attestation`.
   */
  requestAttestation?: boolean;
  [k: string]: unknown | undefined;
}
export interface ClientInfo {
  name: string;
  title?: string | null;
  version: string;
  [k: string]: unknown | undefined;
}
