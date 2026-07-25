import { useEffect, useMemo, useRef, useState } from "react";

import type { ConversationClient } from "../appServer";
import type { ServerNotification } from "../protocol/generated";
import type { TurnPlanStep } from "../protocol/generated/types/ServerNotification";

export interface ActiveTurnPlan {
  readonly explanation: string | null;
  readonly steps: readonly TurnPlanStep[];
  readonly turnId: string;
}

type TurnPlans = ReadonlyMap<string, ActiveTurnPlan>;

const EMPTY_PLANS: TurnPlans = new Map();

export function useTurnPlan(
  client: ConversationClient | null,
  currentThreadId: string | null,
  subscribedThreadIds: readonly string[] = [],
) {
  const [plans, setPlans] = useState<TurnPlans>(EMPTY_PLANS);
  const clientRef = useRef(client);

  useEffect(() => {
    if (clientRef.current !== client) {
      clientRef.current = client;
      setPlans(EMPTY_PLANS);
    }
    if (client === null) {
      return;
    }
    return client.subscribeNotifications((notification) => {
      setPlans((current) => reduceTurnPlans(current, notification));
    });
  }, [client]);

  const retainedThreadIds = useMemo(
    () => new Set(subscribedThreadIds),
    [subscribedThreadIds],
  );
  useEffect(() => {
    setPlans((current) => retainTurnPlans(current, retainedThreadIds));
  }, [retainedThreadIds]);

  return currentThreadId === null
    ? null
    : plans.get(currentThreadId) ?? null;
}

function reduceTurnPlans(
  plans: TurnPlans,
  notification: ServerNotification,
): TurnPlans {
  switch (notification.method) {
    case "turn/plan/updated": {
      const next = new Map(plans);
      if (notification.params.plan.length === 0) {
        next.delete(notification.params.threadId);
      } else {
        next.set(notification.params.threadId, Object.freeze({
          explanation: notification.params.explanation ?? null,
          steps: Object.freeze([...notification.params.plan]),
          turnId: notification.params.turnId,
        }));
      }
      return next;
    }
    case "turn/started":
      return removeThreadPlan(plans, notification.params.threadId);
    case "turn/completed": {
      const current = plans.get(notification.params.threadId);
      return current?.turnId === notification.params.turn.id
        ? removeThreadPlan(plans, notification.params.threadId)
        : plans;
    }
    case "thread/deleted":
    case "thread/closed":
      return removeThreadPlan(plans, notification.params.threadId);
    default:
      return plans;
  }
}

function removeThreadPlan(plans: TurnPlans, threadId: string): TurnPlans {
  if (!plans.has(threadId)) {
    return plans;
  }
  const next = new Map(plans);
  next.delete(threadId);
  return next;
}

function retainTurnPlans(
  plans: TurnPlans,
  retainedThreadIds: ReadonlySet<string>,
): TurnPlans {
  if (
    plans.size === 0 ||
    [...plans.keys()].every((threadId) => retainedThreadIds.has(threadId))
  ) {
    return plans;
  }
  return new Map(
    [...plans].filter(([threadId]) => retainedThreadIds.has(threadId)),
  );
}
