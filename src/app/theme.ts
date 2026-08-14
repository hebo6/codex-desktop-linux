import type { ThemePreference } from "../transport/preferences";

export function applyThemePreference(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}
