import { useEffect, useState } from "react";

import type { ActiveTurnPlan } from "../app/useTurnPlan";
import { ComposerAccessoryDisclosure } from "./ComposerAccessoryPanel";
import styles from "./TaskPlanPanel.module.css";

export function TaskPlanPanel({
  plan,
}: {
  readonly plan: ActiveTurnPlan | null;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [plan?.turnId]);

  if (plan === null || plan.steps.length === 0) {
    return null;
  }

  const remaining = plan.steps.filter(
    ({ status }) => status !== "completed",
  ).length;
  const current = plan.steps.find(({ status }) => status === "inProgress");
  const summary = remaining === 0
    ? "任务计划 · 已完成"
    : current === undefined
      ? `任务计划 · 剩余 ${remaining} 项`
      : `任务计划 · 剩余 ${remaining} 项 · ${current.step}`;

  return (
    <ComposerAccessoryDisclosure
      expanded={expanded}
      icon={<PlanIcon />}
      label="任务计划"
      onExpandedChange={setExpanded}
      summary={summary}
    >
      <div className={styles.content}>
        {plan.explanation === null ? null : (
          <p className={styles.explanation}>{plan.explanation}</p>
        )}
        <ol className={styles.steps}>
          {plan.steps.map((step, index) => (
            <li data-status={step.status} key={`${index}:${step.step}`}>
              <span aria-hidden="true" className={styles.statusIcon}>
                {step.status === "completed" ? "✓" : ""}
              </span>
              <span className={styles.statusLabel}>
                {step.status === "completed"
                  ? "已完成"
                  : step.status === "inProgress"
                    ? "进行中"
                    : "待处理"}
              </span>
              <span>{step.step}</span>
            </li>
          ))}
        </ol>
      </div>
    </ComposerAccessoryDisclosure>
  );
}

function PlanIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m5 7 1.5 1.5L9 6" />
      <path d="M12 7h7" />
      <path d="m5 13 1.5 1.5L9 12" />
      <path d="M12 13h7" />
      <path d="M5 19h4" />
      <path d="M12 19h7" />
    </svg>
  );
}
