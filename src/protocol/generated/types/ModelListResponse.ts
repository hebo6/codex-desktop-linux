// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * A non-empty reasoning effort value advertised by the model.
 */
export type ReasoningEffort = string;
/**
 * Canonical user-input modality tags advertised by a model.
 */
export type InputModality = "text" | "image";

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
  serviceTiers?: ModelServiceTier[];
  supportedReasoningEfforts: ReasoningEffortOption[];
  supportsPersonality?: boolean;
  upgrade?: string | null;
  upgradeInfo?: ModelUpgradeInfo | null;
  [k: string]: unknown | undefined;
}
export interface ModelAvailabilityNux {
  message: string;
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
  upgradeCopy?: string | null;
  [k: string]: unknown | undefined;
}
