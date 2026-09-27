export interface TurnDiffFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly kind: "add" | "update" | "delete" | "rename";
  readonly additions: number;
  readonly deletions: number;
  readonly diff: string;
}

export function parseTurnDiff(diff: string): {
  files: readonly TurnDiffFile[];
  incomplete: boolean;
} {
  if (!diff.trim()) {
    return { files: [], incomplete: false };
  }

  const boundaries = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  const files: TurnDiffFile[] = [];
  let incomplete = boundaries.length === 0 || diff.slice(0, boundaries[0]).trim().length > 0;

  for (const [index, start] of boundaries.entries()) {
    const file = parseFileDiff(diff.slice(start, boundaries[index + 1]));
    if (file) {
      files.push(file);
    } else {
      incomplete = true;
    }
  }

  return { files, incomplete };
}

function parseFileDiff(diff: string): TurnDiffFile | null {
  const lines = diff.split("\n");
  const firstHunk = lines.findIndex((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line));
  const headers = firstHunk < 0 ? lines : lines.slice(0, firstHunk);
  const oldHeader = headers.find((line) => line.startsWith("--- "))?.slice(4);
  const newHeader = headers.find((line) => line.startsWith("+++ "))?.slice(4);
  let oldPath: string | null;
  let newPath: string | null;

  if (oldHeader !== undefined && newHeader !== undefined && firstHunk >= 0) {
    if (
      (oldHeader !== "/dev/null" && !oldHeader.startsWith("a/")) ||
      (newHeader !== "/dev/null" && !newHeader.startsWith("b/"))
    ) {
      return null;
    }
    oldPath = oldHeader === "/dev/null" ? null : oldHeader.slice(2);
    newPath = newHeader === "/dev/null" ? null : newHeader.slice(2);
  } else if (oldHeader === undefined && newHeader === undefined && firstHunk < 0) {
    // Empty additions/deletions have no unified hunks. Their two paths are equal,
    // so a backreference preserves spaces (including " b/") without splitting.
    const path = /^diff --git a\/(.+) b\/\1$/.exec(lines[0] ?? "")?.[1];
    const added = headers.some((line) => line.startsWith("new file mode "));
    const deleted = headers.some((line) => line.startsWith("deleted file mode "));
    if (!path || added === deleted || !headers.some((line) => line.startsWith("index "))) {
      return null;
    }
    oldPath = added ? null : path;
    newPath = deleted ? null : path;
  } else {
    return null;
  }

  const path = newPath ?? oldPath;
  if (
    !path || oldPath === "" || newPath === "" ||
    lines[0] !== `diff --git a/${oldPath ?? newPath} b/${newPath ?? oldPath}`
  ) {
    return null;
  }

  let additions = 0;
  let deletions = 0;
  if (firstHunk >= 0) {
    for (const line of lines.slice(firstHunk)) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }

  const renamed = oldPath !== null && newPath !== null && oldPath !== newPath;
  return {
    path,
    previousPath: renamed ? oldPath : null,
    kind: oldPath === null ? "add" : newPath === null ? "delete" : renamed ? "rename" : "update",
    additions,
    deletions,
    diff,
  };
}
