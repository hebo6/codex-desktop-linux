import { useCallback, useEffect, useRef } from "react";

import type { PendingInteraction } from "../appServer/interactionClient";
import type { DesktopNotificationService } from "../transport/desktopNotifications";
import { isAsyncQuestionMessage } from "./asyncQuestions";
import type { ServerThreadsClient } from "./useServerThreads";

export function useUserInputNotifications({
  client,
  enabled,
  notificationService,
  pending,
  subscribedThreadIds,
  windowId,
}: {
  readonly client: Pick<ServerThreadsClient, "subscribeNotifications"> | null;
  readonly enabled: boolean;
  readonly notificationService: DesktopNotificationService;
  readonly pending: readonly PendingInteraction[];
  readonly subscribedThreadIds: readonly string[];
  readonly windowId: string | null;
}) {
  const observedItemsRef = useRef(new Set<string>());
  const observedRequestsRef = useRef(new Set<string>());
  const notify = useCallback((threadId: string) => {
    if (!enabled) return;
    void notificationService.show({
      title: "Codex 需要你的回答",
      body: "返回对应窗口查看并回答问题",
      tag: `question:${windowId ?? "main"}:${threadId}`,
    });
  }, [enabled, notificationService, windowId]);

  useEffect(() => {
    observedItemsRef.current.clear();
    observedRequestsRef.current.clear();
  }, [client]);

  useEffect(() => {
    const questions = pending.filter(
      ({ request }) => request.method === "item/tool/requestUserInput",
    );
    for (const question of questions) {
      if (!question.responding && !observedRequestsRef.current.has(question.key)) {
        notify(question.threadId);
      }
    }
    observedRequestsRef.current = new Set(questions.map(({ key }) => key));
  }, [client, notify, pending]);

  useEffect(() => {
    if (client === null) return;
    return client.subscribeNotifications((notification) => {
      // 只消费实时完成事件，避免开始事件、历史恢复和切换标签重复提醒
      if (notification.method !== "item/completed") return;
      const { threadId, turnId, item } = notification.params;
      if (!subscribedThreadIds.includes(threadId) || !isAsyncQuestionMessage(item)) return;
      const key = JSON.stringify([threadId, turnId, item.id]);
      if (observedItemsRef.current.has(key)) return;
      observedItemsRef.current.add(key);
      notify(threadId);
    });
  }, [client, notify, subscribedThreadIds]);
}
