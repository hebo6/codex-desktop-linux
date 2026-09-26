// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

export type Account = ApiKeyAccount | ChatgptAccount | AmazonBedrockAccount;
export type ApiKeyAccountType = "apiKey";
export type PlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_prolite"
  | "self_serve_business_usage_based"
  | "business"
  | "ent26"
  | "enterprise_cbp_automation"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "edu_plus"
  | "edu_pro"
  | "unknown";
export type ChatgptAccountType = "chatgpt";
export type AmazonBedrockAccountType = "amazonBedrock";
/**
 * Backend routing policy. Wire values match the accounts/check contract.
 */
export type AccountRoutingOverride = "NO_CONSTRAINT" | "us" | "us_cr";

export interface GetAccountResponse {
  account?: Account | null;
  requiresOpenaiAuth: boolean;
  workspaceRouting?: WorkspaceRouting | null;
  [k: string]: unknown | undefined;
}
export interface ApiKeyAccount {
  type: ApiKeyAccountType;
  [k: string]: unknown | undefined;
}
export interface ChatgptAccount {
  email: string | null;
  planType: PlanType;
  type: ChatgptAccountType;
  [k: string]: unknown | undefined;
}
export interface AmazonBedrockAccount {
  type: AmazonBedrockAccountType;
  usesCodexManagedCredentials?: boolean;
  [k: string]: unknown | undefined;
}
export interface WorkspaceRouting {
  accountRoutingOverride: AccountRoutingOverride;
  backendOrigin: string;
  chatgptAccountId: string;
  [k: string]: unknown | undefined;
}
