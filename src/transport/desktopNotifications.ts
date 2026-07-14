import { getCurrentWindow } from "@tauri-apps/api/window";

export type DesktopNotificationPermission = NotificationPermission | "unsupported";

export interface DesktopNotificationInput {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

export interface DesktopNotificationService {
  readonly permission: () => DesktopNotificationPermission;
  readonly requestPermission: () => Promise<DesktopNotificationPermission>;
  readonly show: (input: DesktopNotificationInput) => boolean;
}

export function createDesktopNotificationService(
  focusWindow: () => Promise<void> = async () => getCurrentWindow().setFocus(),
): DesktopNotificationService {
  const permission = (): DesktopNotificationPermission =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  return {
    permission,
    async requestPermission() {
      if (typeof Notification === "undefined") return "unsupported";
      return Notification.requestPermission();
    },
    show(input) {
      if (
        typeof Notification === "undefined" ||
        Notification.permission !== "granted" ||
        (document.visibilityState === "visible" && document.hasFocus())
      ) {
        return false;
      }
      const notification = new Notification(boundedText(input.title, 96), {
        body: boundedText(input.body, 256),
        tag: boundedText(input.tag, 128),
      });
      notification.onclick = () => {
        notification.close();
        void focusWindow().catch(() => undefined);
      };
      return true;
    },
  };
}

export const desktopNotificationService = createDesktopNotificationService();

function boundedText(value: string, maxLength: number): string {
  const safe = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return safe.length <= maxLength ? safe : `${safe.slice(0, maxLength - 1)}…`;
}
