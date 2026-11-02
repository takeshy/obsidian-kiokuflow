import * as Diff from "diff";
import { t } from "src/i18n";

/**
 * Diff line types
 */
export type DiffLineType = "unchanged" | "added" | "removed";

/**
 * Represents a single line in the diff output
 */
export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

/**
 * Calculate line-based diff between two strings using LCS algorithm
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const lcs: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  // Backtrack to get diff
  let i = m;
  let j = n;
  const diffStack: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffStack.push({
        type: "unchanged",
        content: oldLines[i - 1],
        oldLineNum: i,
        newLineNum: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      diffStack.push({
        type: "added",
        content: newLines[j - 1],
        newLineNum: j,
      });
      j--;
    } else {
      diffStack.push({
        type: "removed",
        content: oldLines[i - 1],
        oldLineNum: i,
      });
      i--;
    }
  }

  // Reverse to get correct order
  while (diffStack.length > 0) {
    result.push(diffStack.pop()!);
  }

  return result;
}

/**
 * State object returned by renderDiffView for external interaction
 */
export interface DiffRendererState {
  container: HTMLElement;
  viewMode: "unified" | "split";
  setViewMode: (mode: "unified" | "split") => void;
  destroy: () => void;
}

/**
 * Paired row for split view: left (old) and right (new) sides
 */
interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
  leftIndex: number;
  rightIndex: number;
}

/**
 * Pair info for word-level diff: maps a line index to its paired counterpart
 */
interface LinePair {
  removedIndex: number;
  addedIndex: number;
  removedContent: string;
  addedContent: string;
}

/**
 * Build pairs of removed/added lines for word-level diff
 */
function buildLinePairs(diffLines: DiffLine[]): Map<number, LinePair> {
  const pairs = new Map<number, LinePair>();
  let i = 0;
  while (i < diffLines.length) {
    if (diffLines[i].type === "removed") {
      const removed: { index: number; line: DiffLine }[] = [];
      const added: { index: number; line: DiffLine }[] = [];
      while (i < diffLines.length && diffLines[i].type === "removed") {
        removed.push({ index: i, line: diffLines[i] });
        i++;
      }
      while (i < diffLines.length && diffLines[i].type === "added") {
        added.push({ index: i, line: diffLines[i] });
        i++;
      }
      const pairCount = Math.min(removed.length, added.length);
      for (let j = 0; j < pairCount; j++) {
        const pair: LinePair = {
          removedIndex: removed[j].index,
          addedIndex: added[j].index,
          removedContent: removed[j].line.content,
          addedContent: added[j].line.content,
        };
        pairs.set(removed[j].index, pair);
        pairs.set(added[j].index, pair);
      }
    } else {
      i++;
    }
  }
  return pairs;
}

/**
 * Render word-level diff highlights into a content element
 */
function renderWordDiff(
  contentEl: HTMLElement,
  oldContent: string,
  newContent: string,
  side: "old" | "new"
): void {
  const changes = Diff.diffWords(oldContent, newContent);
  for (const change of changes) {
    if (change.added) {
      if (side === "new") {
        const span = contentEl.createSpan({ cls: "kiokuflow-diff-word-added" });
        span.textContent = change.value;
      }
      // Skip added parts on old side
    } else if (change.removed) {
      if (side === "old") {
        const span = contentEl.createSpan({ cls: "kiokuflow-diff-word-removed" });
        span.textContent = change.value;
      }
      // Skip removed parts on new side
    } else {
      const span = contentEl.createSpan();
      span.textContent = change.value;
    }
  }
}

/**
 * Pair diff lines for split view
 */
function pairLinesForSplitView(diffLines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < diffLines.length) {
    if (diffLines[i].type === "unchanged") {
      rows.push({ left: diffLines[i], right: diffLines[i], leftIndex: i, rightIndex: i });
      i++;
    } else {
      const removed: { index: number; line: DiffLine }[] = [];
      const added: { index: number; line: DiffLine }[] = [];
      while (i < diffLines.length && diffLines[i].type === "removed") {
        removed.push({ index: i, line: diffLines[i] });
        i++;
      }
      while (i < diffLines.length && diffLines[i].type === "added") {
        added.push({ index: i, line: diffLines[i] });
        i++;
      }
      const maxLen = Math.max(removed.length, added.length);
      for (let j = 0; j < maxLen; j++) {
        rows.push({
          left: j < removed.length ? removed[j].line : null,
          right: j < added.length ? added[j].line : null,
          leftIndex: j < removed.length ? removed[j].index : -1,
          rightIndex: j < added.length ? added[j].index : -1,
        });
      }
    }
  }
  return rows;
}

/**
 * Render a unified diff view into the container
 */
function renderUnifiedView(
  container: HTMLElement,
  diffLines: DiffLine[],
  linePairs: Map<number, LinePair>,
): void {
  container.addClass("kiokuflow-diff-unified");
  container.removeClass("kiokuflow-diff-split");

  for (let idx = 0; idx < diffLines.length; idx++) {
    const line = diffLines[idx];
    const lineEl = container.createDiv({
      cls: `kiokuflow-diff-line kiokuflow-diff-${line.type}`,
    });

    // Old line number
    const oldNumEl = lineEl.createSpan({ cls: "kiokuflow-diff-linenum kiokuflow-diff-linenum-old" });
    oldNumEl.textContent = line.oldLineNum != null ? String(line.oldLineNum) : "";

    // New line number
    const newNumEl = lineEl.createSpan({ cls: "kiokuflow-diff-linenum kiokuflow-diff-linenum-new" });
    newNumEl.textContent = line.newLineNum != null ? String(line.newLineNum) : "";

    // Gutter (+/-/space)
    const gutterEl = lineEl.createSpan({ cls: "kiokuflow-diff-gutter" });
    if (line.type === "removed") {
      gutterEl.textContent = "-";
    } else if (line.type === "added") {
      gutterEl.textContent = "+";
    } else {
      gutterEl.textContent = " ";
    }

    // Content with optional word-level diff
    const contentEl = lineEl.createSpan({ cls: "kiokuflow-diff-content" });
    const pair = linePairs.get(idx);
    if (pair && line.type === "removed") {
      renderWordDiff(contentEl, pair.removedContent, pair.addedContent, "old");
    } else if (pair && line.type === "added") {
      renderWordDiff(contentEl, pair.removedContent, pair.addedContent, "new");
    } else {
      contentEl.textContent = line.content || " ";
    }
  }
}

/**
 * Render a split (side-by-side) diff view into the container
 */
function renderSplitView(
  container: HTMLElement,
  diffLines: DiffLine[],
  linePairs: Map<number, LinePair>,
): void {
  container.addClass("kiokuflow-diff-split");
  container.removeClass("kiokuflow-diff-unified");

  const rows = pairLinesForSplitView(diffLines);

  for (const row of rows) {
    const rowEl = container.createDiv({ cls: "kiokuflow-diff-split-row" });

    // Left side (old)
    const leftEl = rowEl.createDiv({
      cls: `kiokuflow-diff-split-cell kiokuflow-diff-split-left ${row.left ? `kiokuflow-diff-${row.left.type}` : "kiokuflow-diff-split-filler"}`,
    });
    if (row.left) {
      const lineNumEl = leftEl.createSpan({ cls: "kiokuflow-diff-linenum" });
      lineNumEl.textContent = row.left.oldLineNum != null ? String(row.left.oldLineNum) : "";

      const gutterEl = leftEl.createSpan({ cls: "kiokuflow-diff-gutter" });
      gutterEl.textContent = row.left.type === "removed" ? "-" : " ";

      const contentEl = leftEl.createSpan({ cls: "kiokuflow-diff-content" });
      const pair = linePairs.get(row.leftIndex);
      if (pair && row.left.type === "removed") {
        renderWordDiff(contentEl, pair.removedContent, pair.addedContent, "old");
      } else {
        contentEl.textContent = row.left.content || " ";
      }
    }

    // Right side (new)
    const rightEl = rowEl.createDiv({
      cls: `kiokuflow-diff-split-cell kiokuflow-diff-split-right ${row.right ? `kiokuflow-diff-${row.right.type}` : "kiokuflow-diff-split-filler"}`,
    });
    if (row.right) {
      const lineNumEl = rightEl.createSpan({ cls: "kiokuflow-diff-linenum" });
      lineNumEl.textContent = row.right.newLineNum != null ? String(row.right.newLineNum) : "";

      const gutterEl = rightEl.createSpan({ cls: "kiokuflow-diff-gutter" });
      gutterEl.textContent = row.right.type === "added" ? "+" : " ";

      const contentEl = rightEl.createSpan({ cls: "kiokuflow-diff-content" });
      const pair = linePairs.get(row.rightIndex);
      if (pair && row.right.type === "added") {
        renderWordDiff(contentEl, pair.removedContent, pair.addedContent, "new");
      } else {
        contentEl.textContent = row.right.content || " ";
      }
    }
  }
}

/**
 * Main entry point: render a diff view into a parent element
 */
export function renderDiffView(
  parentEl: HTMLElement,
  oldText: string,
  newText: string,
  viewMode?: "unified" | "split"
): DiffRendererState {
  const diffLines = computeLineDiff(oldText, newText);
  const linePairs = buildLinePairs(diffLines);

  const container = parentEl.createDiv({ cls: "kiokuflow-diff-view" });
  let currentMode = viewMode ?? "split";

  function rerender() {
    container.empty();
    container.className = "kiokuflow-diff-view";
    if (currentMode === "unified") {
      renderUnifiedView(container, diffLines, linePairs);
    } else {
      renderSplitView(container, diffLines, linePairs);
    }
  }

  rerender();

  const state: DiffRendererState = {
    container,
    viewMode: currentMode,
    setViewMode(mode: "unified" | "split") {
      currentMode = mode;
      state.viewMode = mode;
      rerender();
    },
    destroy() {
      container.remove();
    },
  };

  return state;
}

/**
 * Create a Unified/Split view toggle and attach it to a DiffRendererState
 */
export function createDiffViewToggle(
  parentEl: HTMLElement,
  state: DiffRendererState
): void {
  const toggle = parentEl.createDiv({ cls: "kiokuflow-diff-view-toggle" });
  const unifiedBtn = toggle.createEl("button", {
    text: t("diff.unifiedView"),
    cls: `kiokuflow-diff-view-toggle-btn${state.viewMode === "unified" ? " is-active" : ""}`,
  });
  const splitBtn = toggle.createEl("button", {
    text: t("diff.splitView"),
    cls: `kiokuflow-diff-view-toggle-btn${state.viewMode === "split" ? " is-active" : ""}`,
  });

  unifiedBtn.addEventListener("click", () => {
    if (state.viewMode !== "unified") {
      state.setViewMode("unified");
      unifiedBtn.addClass("is-active");
      splitBtn.removeClass("is-active");
    }
  });
  splitBtn.addEventListener("click", () => {
    if (state.viewMode !== "split") {
      state.setViewMode("split");
      splitBtn.addClass("is-active");
      unifiedBtn.removeClass("is-active");
    }
  });
}
