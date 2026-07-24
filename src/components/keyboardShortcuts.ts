export interface KeyboardShortcut {
  readonly label: string;
  readonly keys: readonly string[];
}

export interface KeyboardShortcutGroup {
  readonly title: string;
  readonly shortcuts: readonly KeyboardShortcut[];
}

export const KEYBOARD_SHORTCUT_GROUPS: readonly KeyboardShortcutGroup[] = [
  {
    title: "会话",
    shortcuts: [
      { label: "新建会话", keys: ["Ctrl+N"] },
      { label: "在新窗口新建会话", keys: ["Ctrl+Shift+N"] },
      { label: "快速切换会话", keys: ["Ctrl+K"] },
      { label: "切换到上一个会话", keys: ["Ctrl+PageUp"] },
      { label: "切换到下一个会话", keys: ["Ctrl+PageDown"] },
      { label: "停止正在进行中的会话", keys: ["Esc"] },
    ],
  },
  {
    title: "编辑器",
    shortcuts: [
      { label: "聚焦输入框", keys: ["Ctrl+L"] },
      { label: "发送", keys: ["Ctrl+Enter"] },
      { label: "复制当前 AI 回答 Markdown", keys: ["Ctrl+Shift+C"] },
    ],
  },
  {
    title: "项目",
    shortcuts: [
      { label: "打开项目选择器（仅新会话）", keys: ["Ctrl+O"] },
    ],
  },
  {
    title: "面板",
    shortcuts: [
      { label: "显示或隐藏侧边栏", keys: ["Ctrl+B"] },
    ],
  },
  {
    title: "应用",
    shortcuts: [
      { label: "打开设置", keys: ["Ctrl+,"] },
      { label: "显示键盘快捷键", keys: ["Ctrl+/"] },
      { label: "关闭最上层浮层", keys: ["Esc"] },
    ],
  },
];
