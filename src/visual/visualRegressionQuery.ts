export const VISUAL_REGRESSION_STATES = [
  "conversation",
  "slash",
  "model",
  "settings",
] as const;

export const VISUAL_REGRESSION_THEMES = ["light", "dark"] as const;

export type VisualRegressionState = (typeof VISUAL_REGRESSION_STATES)[number];
export type VisualRegressionTheme = (typeof VISUAL_REGRESSION_THEMES)[number];

export interface VisualRegressionQuery {
  readonly state: VisualRegressionState;
  readonly theme: VisualRegressionTheme;
}

export function parseVisualRegressionQuery(search: string): VisualRegressionQuery | null {
  const query = new URLSearchParams(search);
  const state = query.get("visualFixture");
  if (!isState(state)) return null;
  const theme = query.get("theme");
  if (!isTheme(theme)) return null;
  return { state, theme };
}

function isState(value: string | null): value is VisualRegressionState {
  return VISUAL_REGRESSION_STATES.some((state) => state === value);
}

function isTheme(value: string | null): value is VisualRegressionTheme {
  return VISUAL_REGRESSION_THEMES.some((theme) => theme === value);
}
