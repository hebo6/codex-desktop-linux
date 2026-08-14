import { useThemePreference } from "../app/useThemePreference";
import { ProtocolDebugWindow } from "./ProtocolDebugWindow";

export function ProtocolDebugView() {
  useThemePreference();
  return <ProtocolDebugWindow />;
}
