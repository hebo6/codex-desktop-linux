# 视觉回归

视觉回归使用开发模式下的确定性场景入口，不读取本机配置、凭据或 app-server 数据

清单固定覆盖 1440 × 900、1280 × 800 和 960 × 640，分别生成浅色与深色主题下的会话主界面、斜杠菜单、模型菜单和设置页，共 24 张截图

## 环境

- `/usr/bin/chromium`

- `chrome-devtools` CLI

- 已有项目依赖

浏览器配置和当次截图只写入 `/tmp`，脚本不会停止浏览器守护或关闭验证页，便于继续人工检查

## 命令

列出全部截图文件名

```bash
pnpm visual:list
```

在确认界面变化符合预期后更新项目内基线

```bash
pnpm visual:update
```

对照项目内基线执行视觉回归

```bash
pnpm visual:regression
```

对照失败时，当次截图保留在 `/tmp/codex-desktop-visual-current`
