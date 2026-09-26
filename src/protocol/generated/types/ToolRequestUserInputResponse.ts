// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

/**
 * EXPERIMENTAL. Response payload mapping question ids to answers.
 */
export interface ToolRequestUserInputResponse {
  answers: {
    [k: string]: ToolRequestUserInputAnswer | undefined;
  };
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL. Captures a user's answer to a request_user_input question.
 */
export interface ToolRequestUserInputAnswer {
  answers: string[];
  [k: string]: unknown | undefined;
}
