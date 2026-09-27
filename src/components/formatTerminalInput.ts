const CONTROL_LABELS: Readonly<Record<string, string>> = {
  "\u0003": "Ctrl+C：请求中断",
  "\u0004": "Ctrl+D：结束输入",
  "\b": "Backspace：退格",
  "\t": "Tab：制表",
  "\n": "Enter：换行",
  "\r": "Enter：回车",
  "\r\n": "Enter：回车换行",
  "\u001a": "Ctrl+Z：请求挂起",
  "\u001b": "Esc",
  "\u007f": "Backspace：退格",
};

/** 仅格式化展示，保留存储中的原始 stdin，不推断进程执行结果 */
export function formatTerminalInput(input: string): string {
  return input.replace(/\r\n|[\u0000-\u001f\u007f-\u009f]/gu, (control) => {
    const label = CONTROL_LABELS[control] ?? `U+${control.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    return `⟦${label}⟧${control.endsWith("\n") ? "\n" : ""}`;
  });
}
