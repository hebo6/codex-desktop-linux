// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

/**
 * Requested cyber treatment for a ChatGPT-authenticated Codex turn. Authorization and model-tier restrictions remain server-owned.
 */
export type CyberAccessProgram = "standard" | "daybreakBlue" | "daybreakRed";
/**
 * A non-empty reasoning effort value advertised by the model.
 */
export type ReasoningEffort = string;
/**
 * Canonical user-input modality tags advertised by a model.
 */
export type InputModality = "text" | "image" | "audio";
/**
 * Multi-agent runtime supported by a model.
 */
export type MultiAgentVersion = "disabled" | "v1" | "v2";

export interface ModelListResponse {
  data: Model[];
  /**
   * Opaque cursor to pass to the next call to continue after the last item. If None, there are no more items to return.
   */
  nextCursor?: string | null;
  [k: string]: unknown | undefined;
}
export interface Model {
  /**
   * Deprecated: use `serviceTiers` instead.
   */
  additionalSpeedTiers?: string[];
  availabilityNux?: ModelAvailabilityNux | null;
  /**
   * Null when the catalog does not provide access-program metadata.
   */
  availableAccessPrograms?: ModelAccessPrograms | null;
  defaultReasoningEffort: ReasoningEffort;
  /**
   * Catalog default service tier id for this model, when one is configured.
   */
  defaultServiceTier?: string | null;
  description: string;
  displayName: string;
  hidden: boolean;
  id: string;
  inputModalities?: InputModality[];
  isDefault: boolean;
  model: string;
  modelSpecialty?: string | null;
  /**
   * Multi-agent runtime declared by this model, when available.
   */
  multiAgentVersion?: MultiAgentVersion | null;
  serviceTiers?: ModelServiceTier[];
  supportedReasoningEfforts: ReasoningEffortOption[];
  /**
   * @deprecated Always false; models no longer support personality selection.
   */
  supportsPersonality?: boolean;
  upgrade?: string | null;
  upgradeInfo?: ModelUpgradeInfo | null;
  [k: string]: unknown | undefined;
}
export interface ModelAvailabilityNux {
  message: string;
  [k: string]: unknown | undefined;
}
/**
 * Caller-specific explicit access programs advertised by model discovery.
 */
export interface ModelAccessPrograms {
  /**
   * Accepted explicit selections.
   */
  cyber: CyberAccessProgram[];
  [k: string]: unknown | undefined;
}
export interface ModelServiceTier {
  description: string;
  id: string;
  name: string;
  [k: string]: unknown | undefined;
}
export interface ReasoningEffortOption {
  description: string;
  reasoningEffort: ReasoningEffort;
  [k: string]: unknown | undefined;
}
export interface ModelUpgradeInfo {
  migrationMarkdown?: string | null;
  model: string;
  modelLink?: string | null;
  /**
   * Informational Unix timestamp for this upgrade's scheduled retirement, if known.
   */
  retirementAt?: number | null;
  upgradeCopy?: string | null;
  [k: string]: unknown | undefined;
}
