import { describe, expect, it } from "vitest";

import { parseTurnDiff } from "./turnDiff";

describe("parseTurnDiff", () => {
  it("按文件解析新增、修改、删除和移动后的内容变化", () => {
    const added = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000000000000000000000000000000000000..323fae03f4606ea9991df8befbb2fca795e648fa
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+foo
+bar
`;
    const updated = `diff --git a/main.ts b/main.ts
index 1111111..2222222
--- a/main.ts
+++ b/main.ts
@@ -1,2 +1,2 @@
 unchanged
-old
+new
`;
    const deleted = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1111111..0000000000000000000000000000000000000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
`;
    const renamed = `diff --git a/src.txt b/dst.txt
index 1111111..2222222
--- a/src.txt
+++ b/dst.txt
@@ -1 +1 @@
-line
+line2
`;

    expect(parseTurnDiff(added + updated + deleted + renamed)).toEqual({
      files: [
        { path: "new.txt", previousPath: null, kind: "add", additions: 2, deletions: 0, diff: added },
        { path: "main.ts", previousPath: null, kind: "update", additions: 1, deletions: 1, diff: updated },
        { path: "old.txt", previousPath: null, kind: "delete", additions: 0, deletions: 1, diff: deleted },
        { path: "dst.txt", previousPath: "src.txt", kind: "rename", additions: 1, deletions: 1, diff: renamed },
      ],
      incomplete: false,
    });
  });

  it("保留带空格、中文和类似分隔符的路径", () => {
    const diff = `diff --git a/旧 文档 b/说明.md b/新 文档 b/指南.md
index 1111111..2222222
--- a/旧 文档 b/说明.md
+++ b/新 文档 b/指南.md
@@ -1 +1 @@
-旧内容
+新内容
`;

    expect(parseTurnDiff(diff)).toEqual({
      files: [{
        path: "新 文档 b/指南.md",
        previousPath: "旧 文档 b/说明.md",
        kind: "rename",
        additions: 1,
        deletions: 1,
        diff,
      }],
      incomplete: false,
    });
  });

  it("只统计 hunk 正文，并将正文中的 --- 和 +++ 视为实际变化", () => {
    const diff = `diff --git a/example.txt b/example.txt
index 1111111..2222222
--- a/example.txt
+++ b/example.txt
@@ -1,2 +1,3 @@
 context
--- removed
+++ added
+second
@@ -10 +11 @@
-last old
\\ No newline at end of file
+last new
\\ No newline at end of file
`;

    expect(parseTurnDiff(diff).files[0]).toMatchObject({ additions: 3, deletions: 2, diff });
  });

  it.each([
    ["new file mode", "add"],
    ["deleted file mode", "delete"],
  ])("解析只有元数据的空文件：%s", (mode, kind) => {
    const zero = "0000000000000000000000000000000000000000";
    const empty = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    const diff = `diff --git a/空 文件 b/说明.txt b/空 文件 b/说明.txt
${mode} 100644
index ${kind === "add" ? `${zero}..${empty}` : `${empty}..${zero}`}
`;

    expect(parseTurnDiff(diff)).toEqual({
      files: [{
        path: "空 文件 b/说明.txt",
        previousPath: null,
        kind,
        additions: 0,
        deletions: 0,
        diff,
      }],
      incomplete: false,
    });
  });

  it("跳过被截断的开头残片，继续展示后续完整文件", () => {
    const complete = `diff --git a/second.txt b/second.txt
index 1111111..2222222
--- a/second.txt
+++ b/second.txt
@@ -1 +1 @@
-before
+after
`;
    const fragment = `a/first.txt b/first.txt
index 1111111..2222222
--- a/first.txt
+++ b/first.txt
@@ -1 +1 @@
-before
+after
`;

    expect(parseTurnDiff(fragment + complete)).toEqual({
      files: [{
        path: "second.txt",
        previousPath: null,
        kind: "update",
        additions: 1,
        deletions: 1,
        diff: complete,
      }],
      incomplete: true,
    });
  });

  it.each([
    "无法识别的内容",
    "@@ -1 +1 @@\n-before\n+after\n",
    "diff --git a/missing.txt b/missing.txt\n",
    "diff --git a/wrong.txt b/wrong.txt\n--- a/actual.txt\n+++ b/actual.txt\n@@ -1 +1 @@\n-a\n+b\n",
  ])("无法确定文件路径时不编造文件记录：%s", (diff) => {
    expect(parseTurnDiff(diff)).toEqual({ files: [], incomplete: true });
  });

  it.each(["", "\n \t\n"])("空内容没有缺失信息", (diff) => {
    expect(parseTurnDiff(diff)).toEqual({ files: [], incomplete: false });
  });
});
