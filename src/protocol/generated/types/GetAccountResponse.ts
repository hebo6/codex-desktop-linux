// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：a4535884169be8da2f81b8a4debecbd4dc11aa97

export type Account = ApiKeyAccount | ChatgptAccount | AmazonBedrockAccount;
export type ApiKeyAccountType = "apiKey";
export type PlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "ent26"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";
export type ChatgptAccountType = "chatgpt";
export type AmazonBedrockAccountType = "amazonBedrock";

export interface GetAccountResponse {
  account?: Account | null;
  requiresOpenaiAuth: boolean;
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
