// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

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
   * Allow downstream MCP servers to request OpenAI extended form elicitations.
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
