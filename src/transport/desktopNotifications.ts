import { tauriIpc, type TauriIpc } from "./tauriIpc";

export type DesktopNotificationPermission = "default" | "granted" | "unsupported";

export interface DesktopNotificationInput {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

export interface DesktopNotificationService {
  readonly permission: () => Promise<DesktopNotificationPermission>;
  readonly requestPermission: () => Promise<DesktopNotificationPermission>;
  readonly show: (input: DesktopNotificationInput) => Promise<boolean>;
}

export function createDesktopNotificationService(
  ipc: Pick<TauriIpc, "invoke"> = tauriIpc,
): DesktopNotificationService {
  const permission = async (): Promise<DesktopNotificationPermission> => {
    try {
      const available = await ipc.invoke<boolean>("desktop_notification_availability", {});
      return available ? "granted" : "unsupported";
    } catch {
      return "unsupported";
    }
  };
  return {
    permission,
    requestPermission: permission,
    async show(input) {
      try {
        return await ipc.invoke<boolean>("show_desktop_notification", {
          request: {
            title: boundedText(input.title, 96),
            body: boundedText(input.body, 256),
            tag: input.tag,
          },
        });
      } catch {
        return false;
      }
    },
  };
}

export const desktopNotificationService = createDesktopNotificationService();

function boundedText(value: string, maxLength: number): string {
  const safe = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return safe.length <= maxLength ? safe : `${safe.slice(0, maxLength - 1)}…`;
}
