import { CustomEditor, highlightCode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join, sep } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// omp dark-catppuccin palette (pi's Theme can't express status-line colors,
// so the bar carries its own hardcoded omp colors — faithful regardless of the
// active pi theme).
// ═══════════════════════════════════════════════════════════════════════════

const HEX = {
  crust: "#11111b",
  surface1: "#45475a",
  surface0: "#313244",
  overlay0: "#6c7086",
  overlay1: "#7f849c",
  text: "#cdd6f4",
  peach: "#fab387",
  pink: "#f5c2e7",
  teal: "#94e2d5",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  sky: "#89dceb",
  mauve: "#cba6f7",
  maroon: "#eba0ac",
  blue: "#89b4fa",
  sapphire: "#74c7ec",
  lavender: "#b4befe",
  red: "#f38ba8",
} as const;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360 / 360;
  const hueToRgb = (p: number, q: number, t: number): number => {
    const normalized = (t + 1) % 1;
    if (normalized < 1 / 6) return p + (q - p) * 6 * normalized;
    if (normalized < 1 / 2) return q;
    if (normalized < 2 / 3) return p + (q - p) * (2 / 3 - normalized) * 6;
    return p;
  };

  if (saturation === 0) {
    const channel = Math.round(lightness * 255).toString(16).padStart(2, "0");
    return `#${channel}${channel}${channel}`;
  }

  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return `#${[hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)]
    .map(channel => Math.round(channel * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Match omp's stable warm accent for a named session on a dark theme. */
function sessionAccentHex(name: string): string {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = (((hash << 5) + hash) ^ name.charCodeAt(i)) >>> 0;
  }
  return hslToHex(hash % 120, 0.9, 0.72);
}

function fgAnsi(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bgAnsi(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m";
const FG_RESET = "\x1b[39m";

// omp Nerd Font symbol preset used by the reference UI. These compact glyphs
// avoid emoji-width drift in the status bar and match its powerline separators.
const ICON = {
  pi: "\ue22c",
  model: "\uec19",
  // omp's status path uses the compact Nerd Font folder glyph rather than the
  // two-cell emoji folder, which keeps the segment geometry stable.
  folder: "\uf115",
  branch: "\uf126",
  context: "\ue70f",
  dot: " · ",
  sepLeft: "\ue0b1",
  sepRight: "\ue0b3",
  capLeft: "\ue0b0",
  capRight: "\ue0b2",
  gap: "─",
  auto: "\u{f0068}",
} as const;

// omp tool-identity glyphs (unicode preset, `tool.*`), used on the success header
// of a framed tool-call block. Tools without an entry fall back to the model badge.
const TOOL_ICON: Record<string, string> = {
  bash: "❯",
  write: "✎",
  edit: "✎",
  ssh: "⇄",
  mcp: "🔌",
};

// omp status glyphs (unicode preset, `status.*`) for the pending/error tool header.
const STATUS_ICON = {
  pending: "⏳",
  running: "⟳",
  error: "✘",
} as const;

// Tool-block frame colors (omp dark-catppuccin): accent border while running or
// pending, error while failing, dim when done; title always accent.
const HEX_TOOL = {
  accent: "#89b4fa",
  error: "#f38ba8",
  dim: "#6c7086",
} as const;

// omp unicode thinking-level glyphs (`theme.thinking`).
const THINKING_DISPLAY: Record<string, string> = {
  minimal: "○ min",
  low: "◔ low",
  medium: "◑ med",
  high: "◒ high",
  xhigh: "◕ xhigh",
  max: "◉ max",
};

// ═══════════════════════════════════════════════════════════════════════════
// Small helpers
// ═══════════════════════════════════════════════════════════════════════════

const RESET_SEQ = /[\u001b\u009b][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-nqry=><]/g;

function stripAnsi(text: string): string {
  return text.replace(RESET_SEQ, "");
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function formatNumber(n: number): string {
  const trim1 = (v: number): string => {
    const s = v.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (n < 1_000) return n.toString();
  if (n < 10_000) return `${trim1(n / 1_000)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
  if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
  if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
  return `${Math.round(n / 1_000_000_000)}B`;
}

/** Left-truncate a path/label to `maxLen`, prefixing an ellipsis when clipped. */
function clampPathLength(pwd: string, maxLen: number): string {
  if (pwd.length <= maxLen) return pwd;
  const ellipsis = "…";
  return `${ellipsis}${pwd.slice(-Math.max(0, maxLen - ellipsis.length))}`;
}

/** omp's `stripDisplayRoot`: strip `~/Projects` and `/work` display roots. */
function stripDisplayRoot(pwd: string): string {
  for (const root of [join(homedir(), "Projects"), "/work"]) {
    const relative = pwd.startsWith(root + sep) ? pwd.slice(root.length + 1) : pwd === root ? "" : null;
    if (relative !== null) return relative;
  }
  return pwd;
}

/** omp's `shortenPath`: replace the home prefix with `~`. */
function shortenPath(pwd: string): string {
  const home = homedir();
  if (home && pwd.startsWith(home)) {
    const suffix = pwd.slice(home.length);
    if (suffix === "" || suffix.startsWith("/") || suffix.startsWith("\\")) {
      return `~${suffix.replaceAll("\\", "/")}`;
    }
  }
  return pwd;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function createUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsageToTotals(totals: UsageTotals, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } }): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

function isAssistantMessageEntry(entry: {
  type: string;
  message?: { role?: string; usage?: unknown };
}): entry is {
  type: "message";
  message: { role: "assistant"; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } };
} {
  return entry.type === "message" && entry.message?.role === "assistant" && !!entry.message.usage;
}

// ═══════════════════════════════════════════════════════════════════════════
// omp status-line segment rendering (ported from omp's status-line/segments.ts
// + component.ts `#buildStatusLine`, unicode preset / powerline-thin).
// ═══════════════════════════════════════════════════════════════════════════

type Segment = { content: string; visible: boolean };

function piSegment(): Segment {
  return { content: `${fgAnsi(HEX.peach)}${ICON.pi} ${FG_RESET}`, visible: true };
}

function modelSegment(ctx: ExtensionContext): Segment {
  const model = ctx.model as ({ id?: string; name?: string } | undefined);
  let modelName = model?.name || model?.id || "no-model";
  if (modelName.startsWith("Claude ")) {
    modelName = modelName.slice(7);
  }

  let thinkingDisplay = "";
  if (ctx.model?.reasoning) {
    const level = ctx.thinkingLevel || "off";
    if (level !== "off") {
      thinkingDisplay = THINKING_DISPLAY[level] ?? level;
    }
  }

  let content = `${ICON.model} ${modelName}`;
  if (thinkingDisplay) {
    content += `${ICON.dot}${thinkingDisplay}`;
  }
  return { content: `${fgAnsi(HEX.pink)}${content}${FG_RESET}`, visible: true };
}

function pathSegment(ctx: ExtensionContext): Segment {
  let pwd = stripDisplayRoot(ctx.cwd);
  pwd = shortenPath(pwd);
  pwd = clampPathLength(pwd, 40);
  return { content: `${fgAnsi(HEX.teal)}${ICON.folder} ${pwd}${FG_RESET}`, visible: true };
}

function gitSegment(footerData: ReadonlyFooterDataProvider): Segment {
  const branch = footerData.getGitBranch();
  if (!branch) return { content: "", visible: false };
  const color = branch === "detached" ? HEX.yellow : HEX.green;
  return { content: `${fgAnsi(color)}${ICON.branch} ${branch}${FG_RESET}`, visible: true };
}

function contextPercentSegment(ctx: ExtensionContext): Segment {
  const contextUsage = ctx.getContextUsage();
  const window = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const pct = contextUsage?.percent;
  const tokens = contextUsage?.tokens ?? 0;

  const reachesThreshold = (percentThreshold: number, tokenThreshold: number): boolean => {
    if (pct === null || pct === undefined || !Number.isFinite(pct) || pct <= 0) return false;
    if (!Number.isFinite(window) || window <= 0) return pct >= percentThreshold;
    const tokenPercentThreshold = (tokenThreshold / window) * 100;
    return pct >= Math.min(percentThreshold, tokenPercentThreshold);
  };

  const level = reachesThreshold(90, 500_000)
    ? "error"
    : reachesThreshold(70, 270_000)
      ? "purple"
      : reachesThreshold(50, 150_000)
        ? "warning"
        : "normal";
  const color =
    level === "error" ? HEX.red : level === "warning" ? HEX.yellow : HEX.mauve;
  const autoCompactEnabled = (ctx as ExtensionContext & { autoCompactionEnabled?: boolean }).autoCompactionEnabled ?? true;
  const autoIcon = autoCompactEnabled ? ` ${ICON.auto}` : "";

  let text: string;
  if (!Number.isFinite(window) || window <= 0) {
    text = `${formatNumber(tokens)}/?`;
  } else if (pct === null || pct === undefined) {
    text = `?/${formatNumber(window)}`;
  } else {
    text = `${pct.toFixed(1)}%/${formatNumber(window)}`;
  }

  return { content: `${ICON.context} ${fgAnsi(color)}${text}${autoIcon}${FG_RESET}`, visible: true };
}

function costSegment(ctx: ExtensionContext, usageTotals: UsageTotals): Segment {
  if (!usageTotals.cost) return { content: "", visible: false };
  return { content: `${fgAnsi(HEX.maroon)}$${usageTotals.cost.toFixed(2)}${FG_RESET}`, visible: true };
}

function sessionNameSegment(ctx: ExtensionContext): Segment {
  const name = ctx.sessionManager.getSessionName();
  if (!name) return { content: "", visible: false };
  return { content: `${fgAnsi(sessionAccentHex(name))}${sanitizeStatusText(name)}${FG_RESET}`, visible: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// omp status-line component (the extension footer only carries hook statuses;
// the main bar is rendered through the editor's top border).
// ═══════════════════════════════════════════════════════════════════════════

class OmpFooter {
  private footerData: ReadonlyFooterDataProvider;
  private getCtx: () => ExtensionContext | undefined;

  constructor(footerData: ReadonlyFooterDataProvider, getCtx: () => ExtensionContext | undefined) {
    this.footerData = footerData;
    this.getCtx = getCtx;
  }

  invalidate(): void {
    // Data is read lazily from live ctx; nothing to cache.
  }

  dispose(): void {
    // No owned resources.
  }

  renderStatusBar(width: number): string {
    const ctx = this.getCtx();
    if (!ctx) return "";

    const usageTotals = createUsageTotals();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (isAssistantMessageEntry(entry)) {
        addUsageToTotals(usageTotals, entry.message.usage);
      } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
        addUsageToTotals(usageTotals, entry.message.usage as never);
      } else if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as { usage?: unknown }).usage) {
        addUsageToTotals(usageTotals, (entry as { usage: unknown }).usage as never);
      }
    }

    // Collect visible segments (omp default preset: pi, model, mode, collab,
    // path, git, pr, context_pct, cost on the left; session_name on the right.
    // mode/collab/pr have no pi equivalent, so they render invisible).
    const leftParts: string[] = [];
    for (const segment of [
      piSegment(),
      modelSegment(ctx),
      pathSegment(ctx),
      gitSegment(this.footerData),
      contextPercentSegment(ctx),
      costSegment(ctx, usageTotals),
    ]) {
      if (segment.visible && segment.content) leftParts.push(segment.content);
    }

    const rightParts: string[] = [];
    const sessionSegment = sessionNameSegment(ctx);
    if (sessionSegment.visible && sessionSegment.content) rightParts.push(sessionSegment.content);

    if (leftParts.length === 0 && rightParts.length === 0) return "";

    const bg = bgAnsi(HEX.crust);
    const fg = fgAnsi(HEX.text);
    const sepFg = fgAnsi(HEX.surface1);

    const groupWidth = (parts: string[]): number => {
      if (parts.length === 0) return 0;
      const partsWidth = parts.reduce((sum, part) => sum + visibleWidth(part), 0);
      const sepTotal = Math.max(0, parts.length - 1) * 3;
      return partsWidth + sepTotal + 2 + 1;
    };

    const renderGroup = (parts: string[], direction: "left" | "right"): string => {
      if (parts.length === 0) return "";
      const sep = direction === "left" ? ICON.sepLeft : ICON.sepRight;
      const cap = direction === "left" ? ICON.capLeft : ICON.capRight;
      const capText = `${fgAnsi(HEX.crust)}${cap}${RESET}`;
      const content = `${bg}${fg} ${parts.join(` ${sepFg}${sep}${fg} `)} ${RESET}`;
      return direction === "right" ? capText + content : content + capText;
    };

    const leftGroup = renderGroup(leftParts, "left");
    const rightGroup = renderGroup(rightParts, "right");
    const leftWidth = groupWidth(leftParts);
    const rightWidth = groupWidth(rightParts);

    let bar: string;
    if (leftParts.length === 0) {
      // omp leaves the unused editor-border area to the editor; only the
      // status group itself receives the status-line background.
      bar = rightGroup;
    } else if (rightParts.length === 0) {
      bar = leftGroup;
    } else {
      // omp: bridge the two groups with a border-colored `─` gap.
      const gapWidth = Math.max(1, width - leftWidth - rightWidth);
      const sessionName = ctx.sessionManager.getSessionName();
      const gapColor = sessionName ? sessionAccentHex(sessionName) : HEX.blue;
      const gapFill = `${fgAnsi(gapColor)}${ICON.gap.repeat(gapWidth)}${FG_RESET}`;
      bar = leftGroup + gapFill + rightGroup;
    }

    return bar;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Extension statuses render below the bar, like omp's hook status lines.
    const extensionStatuses = this.footerData.getExtensionStatuses();
    if (extensionStatuses.size > 0) {
      const statusText = Array.from(extensionStatuses.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatusText(stripAnsi(text)))
        .filter(Boolean)
        .join(" ");
      if (statusText) {
        lines.push(truncateToWidth(`${fgAnsi(HEX.overlay1)}${statusText}${FG_RESET}`, width, `${fgAnsi(HEX.overlay1)}…${FG_RESET}`));
      }
    }

    return lines;
  }
}

const OMP_WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function workingAccent(ctx: ExtensionContext): string {
  const sessionName = ctx.sessionManager.getSessionName();
  return sessionName ? sessionAccentHex(sessionName) : HEX.peach;
}

function workingMessage(ctx: ExtensionContext, frame: number): string {
  const accent = workingAccent(ctx);
  const text = "Working…";
  const center = (frame % (text.length + 6)) - 3;
  const shimmer = [...text]
    .map((character, index) => {
      const distance = Math.abs(index - center);
      const color = distance === 0 ? HEX.text : distance <= 2 ? accent : HEX.overlay0;
      const bold = distance === 0 ? "\x1b[1m" : "";
      const boldReset = distance === 0 ? "\x1b[22m" : "";
      return `${bold}${fgAnsi(color)}${character}${FG_RESET}${boldReset}`;
    })
    .join("");
  return `${shimmer} ${fgAnsi(HEX.overlay0)}⟨esc⟩${FG_RESET}`;
}

function configureWorkingIndicator(ctx: ExtensionContext): void {
  const accent = workingAccent(ctx);
  ctx.ui.setWorkingIndicator({
    frames: OMP_WORKING_FRAMES.map(frame => `${fgAnsi(accent)}${frame}${FG_RESET}`),
    intervalMs: 80,
  });
  // omp uses a Unicode ellipsis and an explicit Esc hint instead of pi's
  // default ASCII message. ANSI is nested deliberately so pi's muted wrapper
  // still leaves the main label and hint in their omp colors.
  ctx.ui.setWorkingMessage?.(workingMessage(ctx, 0));
}

function stopWorkingShimmer(): void {
  if (!workingShimmerTimer) return;
  clearInterval(workingShimmerTimer);
  workingShimmerTimer = undefined;
}

function startWorkingShimmer(ctx: ExtensionContext): void {
  stopWorkingShimmer();
  configureWorkingIndicator(ctx);
  let frame = 1;
  workingShimmerTimer = setInterval(() => {
    if (ctx.isIdle()) {
      stopWorkingShimmer();
      return;
    }
    ctx.ui.setWorkingMessage?.(workingMessage(ctx, frame++));
  }, 80);
  workingShimmerTimer.unref?.();
}

// ═══════════════════════════════════════════════════════════════════════════
// omp prompt-input (editor) component
//
// omp's input is a rounded-corner box whose top border carries the status line
// (see omp `components/editor.ts` + `interactive-mode.ts: setTopBorderProvider`).
// pi's Editor only draws flat borders, so we extend CustomEditor and reshape the
// rendered box: rounded `╭──╮`/`╰──╯` corners, side rails, and the omp status
// line in the top border. All editing, keybindings, and autocomplete stay on
// the stock CustomEditor/Editor core.
// ═══════════════════════════════════════════════════════════════════════════

class OmpEditor extends CustomEditor {
  private getCtx: () => ExtensionContext | undefined;
  private getStatusLine: (width: number) => string;
  private baseBorderColor: (text: string) => string;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    getCtx: () => ExtensionContext | undefined,
    getStatusLine: (width: number) => string,
  ) {
    super(tui, theme, keybindings);
    this.baseBorderColor = this.borderColor;
    // omp's editor reserves two cells between each vertical rail and the text.
    // The installed pi editor defaults to zero, which puts an empty-input
    // reverse-video cursor directly on the outer edge of the frame.
    this.setPaddingX(2);
    this.getCtx = getCtx;
    this.getStatusLine = getStatusLine;
  }

  private updateBorderColor(): void {
    const ctx = this.getCtx();
    if (!ctx) {
      this.borderColor = this.baseBorderColor;
      return;
    }
    const sessionName = ctx.sessionManager.getSessionName();
    const thinkingLevel = ctx.thinkingLevel || "off";
    const thinkingColor: Record<string, string> = {
      minimal: HEX.overlay0,
      low: HEX.blue,
      medium: HEX.sapphire,
      high: HEX.mauve,
      xhigh: HEX.pink,
      max: HEX.pink,
      off: HEX.surface0,
    };
    const color = sessionName ? sessionAccentHex(sessionName) : thinkingColor[thinkingLevel] ?? HEX.surface0;
    this.borderColor = (text: string): string => `${fgAnsi(color)}${text}${FG_RESET}`;
  }

  private topBorderStatus(width: number): string | undefined {
    const statusLine = this.getStatusLine(width);
    if (statusLine) return statusLine;

    const ctx = this.getCtx();
    if (!ctx?.model) return undefined;
    const model = ctx.model as { id?: string; name?: string };
    let name = model.name || model.id || "no-model";
    if (name.startsWith("Claude ")) name = name.slice(7);
    let text = `${ICON.model} ${name}`;
    if (ctx.model.reasoning) {
      const level = ctx.thinkingLevel || "off";
      if (level !== "off") text += ` · ${THINKING_DISPLAY[level] ?? level}`;
    }
    return `${fgAnsi(HEX.pink)}${text}${FG_RESET}`;
  }

  private buildRoundedTop(width: number): string {
    const left = "╭──";
    const right = "──╮";
    const fillWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
    const maxStatus = fillWidth;
    const status = this.topBorderStatus(maxStatus);
    if (status) {
      const clamped = truncateToWidth(status, maxStatus, `${fgAnsi(HEX.pink)}…${FG_RESET}`);
      const clampedWidth = visibleWidth(clamped);
      const fill = Math.max(0, fillWidth - clampedWidth);
      return `${this.borderColor(left)}${clamped}${this.borderColor("─".repeat(fill))}${this.borderColor(right)}`;
    }
    return `${this.borderColor(left)}${this.borderColor("─".repeat(fillWidth))}${this.borderColor(right)}`;
  }

  override render(width: number): string[] {
    if (width < 4) return super.render(width);
    this.updateBorderColor();
    const innerWidth = Math.max(2, width - 2);
    const lines = super.render(innerWidth);

    // Border lines are the flat `─` rows the stock Editor draws. Detect them on
    // the pristine output first (our rounded replacements contain the status
    // text and no longer match), then reshape. The top border is only the plain
    // row when the editor is not scrolled (a scrolled prompt swaps it for a `↑`
    // scroll row, which never matches all-dashes); the bottom border is the last
    // all-dashes row. Autocomplete rows render below the bottom border untouched.
    const isFlatBorder = (line: string): boolean => /^─+$/.test(stripAnsi(line));
    const topIndex = isFlatBorder(lines[0]) ? 0 : -1;
    let bottomIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (isFlatBorder(lines[i])) bottomIndex = i;
    }

    if (topIndex >= 0) lines[topIndex] = this.buildRoundedTop(width);

    // The upstream pi editor has no vertical rails. Add them around only the
    // editable rows; autocomplete rows follow the bottom border and must keep
    // their stock layout.
    const firstContent = topIndex >= 0 ? topIndex + 1 : 0;
    const lastContent = bottomIndex >= 0 ? bottomIndex : lines.length;
    const rail = (text: string): string => {
      const content = truncateToWidth(text, innerWidth);
      const padded = `${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))}`;
      return `${this.borderColor("│")}${padded}${this.borderColor("│")}`;
    };
    for (let i = firstContent; i < lastContent; i++) {
      const isLastContent = i === lastContent - 1;
      if (!isLastContent) {
        lines[i] = rail(lines[i]);
        continue;
      }

      // omp folds the bottom corners into the final editable row instead of
      // drawing a separate bottom border. This leaves an empty prompt as a
      // two-row open frame rather than a full rectangle.
      const raw = truncateToWidth(lines[i], innerWidth);
      let middle = raw.startsWith("  ") ? raw.slice(2) : raw;
      if (middle.endsWith("  ")) middle = middle.slice(0, -2);
      const middleWidth = Math.max(0, width - 6);
      middle = truncateToWidth(middle, middleWidth);
      middle = `${middle}${" ".repeat(Math.max(0, middleWidth - visibleWidth(middle)))}`;
      lines[i] = truncateToWidth(`${this.borderColor("╰─ ")}${middle}${this.borderColor(" ─╯")}`, width);
    }
    if (bottomIndex >= 0 && bottomIndex !== topIndex) {
      lines.splice(bottomIndex, 1);
    }

    const autocompleteStart = bottomIndex >= 0 ? bottomIndex : lines.length;
    for (let i = autocompleteStart; i < lines.length; i++) {
      lines[i] = `${lines[i]}${" ".repeat(Math.max(0, width - visibleWidth(lines[i])))}`;
    }
    return lines;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// omp tool-call framing
//
// omp renders tool calls inside rounded, state-colored blocks — most have a
// status header, while bash intentionally uses a plain frame with the command
// as its first section and an `Output` divider — see omp `tui/output-block.ts`.
// pi's built-in tool components are framed by core (a tinted Box, no borders),
// and core offers no hook to restyle them. The extension loader aliases
// `@earendil-works/pi-coding-agent` to the very same module instance core
// imports, so we patch the shared `ToolExecutionComponent.prototype.render` to
// wrap the default (non-"self") path in an omp-style frame.
// `renderShell === "self"` tools (custom renderers that draw their own framing)
// are left untouched.
// ═══════════════════════════════════════════════════════════════════════════

/** Reuse the state background of the first box row so the bars tint like the content. */
function extractBgAnsi(line: string): string {
  const rgb = line.match(/^\x1b\[48;2;\d+;\d+;\d+m/);
  if (rgb) return rgb[0];
  const pal = line.match(/^\x1b\[48;5;\d+m/);
  return pal ? pal[0] : "";
}

/** Wrap a bg-tinted box row with `│` side borders (bg preserved, border-colored). */
function addSideBorders(line: string, width: number, borderColor: string): string {
  const m = line.match(/^(\x1b\[48;2;\d+;\d+;\d+m)([\s\S]*?)(\x1b\[49m)$/) ?? line.match(/^(\x1b\[48;5;\d+m)([\s\S]*?)(\x1b\[49m)$/);
  if (!m) return line;
  const [, bgPrefix, body, bgReset] = m;
  const border = `${fgAnsi(borderColor)}│${FG_RESET}`;
  // Drop 2 trailing cells to make room for the borders. Rows are padded to
  // `width` with fill, so normally we remove trailing spaces; if the content
  // filled the row to the last cell we sacrifice the leading pad instead.
  const inner = body.endsWith("  ") ? body.slice(0, -2) : body.slice(1, -1);
  return `${bgPrefix}${border}${inner}${border}${bgReset}`;
}

/** omp-style `╭─── <header> ────╮` / `╰────────╯` bar, tinted with the block bg. */
function buildFrameBar(width: number, kind: "top" | "bottom", header: string, borderColor: string, barBg: string): string {
  const border = (text: string): string => `${fgAnsi(borderColor)}${text}${FG_RESET}`;
  const reset = barBg ? "\x1b[49m" : "";
  if (kind === "bottom") {
    const inner = Math.max(0, width - 2);
    return `${barBg}${border(`╰${"─".repeat(inner)}╯`)}${reset}`;
  }
  if (!header) {
    const inner = Math.max(0, width - 2);
    return `${barBg}${border(`╭${"─".repeat(inner)}╮`)}${reset}`;
  }
  const leftWidth = 4; // ╭───
  const rightWidth = 1; // ╮
  const maxLabel = Math.max(0, width - leftWidth - rightWidth);
  const label = truncateToWidth(` ${header} `, maxLabel, "…");
  const labelWidth = visibleWidth(label);
  const fill = Math.max(0, width - leftWidth - labelWidth - rightWidth);
  return `${barBg}${border("╭───")}${label}${border("─".repeat(fill))}${border("╮")}${reset}`;
}

/** Add a rounded-box tee divider for a labeled output section. */
function buildSectionBar(width: number, label: string, borderColor: string, barBg: string): string {
  const border = (text: string): string => `${fgAnsi(borderColor)}${text}${FG_RESET}`;
  const reset = barBg ? "\x1b[49m" : "";
  const left = "├───";
  const right = "┤";
  const rawLabel = ` ${label} `;
  const maxLabel = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
  const clippedLabel = truncateToWidth(rawLabel, maxLabel, "…");
  const fill = Math.max(0, width - visibleWidth(left) - visibleWidth(clippedLabel) - visibleWidth(right));
  return `${barBg}${border(left)}${clippedLabel}${border("─".repeat(fill))}${border(right)}${reset}`;
}

function applyFrameBackground(line: string, width: number, barBg: string): string {
  const padded = `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
  if (!barBg) return padded;
  const stabilized = padded
    .replace(/\x1b\[(?:0)?m/g, match => `${match}${barBg}`)
    .replace(/\x1b\[49m/g, match => `${match}${barBg}`);
  return `${barBg}${stabilized}\x1b[49m`;
}

/** Render one omp output-block content row with one cell of inner padding. */
function renderFrameContentRow(line: string, width: number, borderColor: string, barBg: string): string {
  const contentWidth = Math.max(0, width - 4);
  const content = truncateToWidth(line, contentWidth);
  const paddedContent = `${content}${" ".repeat(Math.max(0, contentWidth - visibleWidth(content)))}`;
  const border = `${fgAnsi(borderColor)}│${FG_RESET}`;
  return applyFrameBackground(`${border} ${paddedContent} ${border}`, width, barBg);
}

function isBlankRenderedLine(line: string): boolean {
  return stripAnsi(line).trim().length === 0;
}

interface RenderableToolPart {
  render(width: number): string[];
}

/** Render child components separately so pi's bash renderer's padding does not
 * become visible blank rows between omp's command/output sections. */
function renderToolPart(part: RenderableToolPart | undefined, width: number): string[] {
  if (!part) return [];
  const children = (part as RenderableToolPart & { children?: RenderableToolPart[] }).children;
  if (!Array.isArray(children)) return part.render(width);

  const lines: string[] = [];
  for (const child of children) {
    const childLines = child.render(width);
    let first = 0;
    while (first < childLines.length && isBlankRenderedLine(childLines[first])) first++;
    let last = childLines.length;
    while (last > first && isBlankRenderedLine(childLines[last - 1])) last--;
    lines.push(...childLines.slice(first, last));
  }
  return lines;
}

/** Re-render pi's bold bash call in omp's dim-prefix/syntax-highlighted style. */
function renderBashCall(part: RenderableToolPart | undefined, width: number, args: unknown): string[] {
  const command =
    args && typeof args === "object" && typeof (args as { command?: unknown }).command === "string"
      ? (args as { command: string }).command.replace(/\t/g, "   ")
      : "";
  if (!command) return renderToolPart(part, width);

  const highlighted = highlightCode(command, "bash");
  if (highlighted.length === 0) return renderToolPart(part, width);
  const prefix = `${fgAnsi(HEX.overlay0)}$ ${FG_RESET}`;
  return highlighted.map((line, index) => (index === 0 ? `${prefix}${line}` : line));
}

/** Match omp's wall-time badge without fabricating a timeout when pi did not
 * supply one in the tool arguments. */
function renderBashResult(part: RenderableToolPart | undefined, width: number, args: unknown): string[] {
  const timeout =
    args && typeof args === "object" && typeof (args as { timeout?: unknown }).timeout === "number"
      ? (args as { timeout: number }).timeout
      : undefined;
  const timeoutText = timeout !== undefined && Number.isFinite(timeout) ? ` | Timeout: ${timeout}s` : "";

  return renderToolPart(part, width).map(line => {
    const plain = stripAnsi(line).trim();
    const match = plain.match(/^Took\s+(.+)$/);
    if (!match) return line;
    return `${fgAnsi(HEX.overlay0)}⟨Wall: ${match[1]}${timeoutText}⟩${FG_RESET}`;
  });
}

/** Structural view of the patched component (the compiled class fields are public). */
interface FramedToolComponent {
  render: (width: number) => string[];
  hideComponent: boolean;
  hasRendererDefinition(): boolean;
  getRenderShell(): string;
  contentBox: { render(width: number): string[] };
  contentText: { render(width: number): string[] };
  args?: unknown;
  callRendererComponent?: RenderableToolPart;
  resultRendererComponent?: RenderableToolPart;
  imageComponents: { render(width: number): string[] }[];
  imageSpacers: { render(width: number): string[] }[];
  isPartial: boolean;
  executionStarted: boolean;
  result?: { isError?: boolean };
  toolName: string;
}

type PatchableTool = { __ompFramed?: boolean };

function patchToolCallFraming(): void {
  const proto = ToolExecutionComponent.prototype as unknown as PatchableTool & { render(width: number): string[] };
  if (proto.__ompFramed) return;
  proto.__ompFramed = true;

  const originalRender = proto.render;
  proto.render = function (this: FramedToolComponent, width: number): string[] {
    if (this.hideComponent) return [];
    if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
      return originalRender.call(this, width);
    }

    const boxLines = this.hasRendererDefinition()
      ? this.contentBox.render(width)
      : this.contentText.render(width);
    if (boxLines.length === 0 && this.imageComponents.length === 0) return [];

    const borderColor = this.isPartial
      ? HEX_TOOL.accent
      : this.result?.isError
        ? HEX_TOOL.error
        : HEX_TOOL.dim;

    let icon: string;
    let iconColor: string;
    if (this.isPartial) {
      icon = this.executionStarted ? STATUS_ICON.running : STATUS_ICON.pending;
      iconColor = this.executionStarted ? HEX_TOOL.accent : HEX_TOOL.dim;
    } else if (this.result?.isError) {
      icon = STATUS_ICON.error;
      iconColor = HEX_TOOL.error;
    } else {
      icon = TOOL_ICON[this.toolName] ?? ICON.model;
      iconColor = HEX_TOOL.accent;
    }

    const header = `${fgAnsi(iconColor)}${icon}${FG_RESET} ${fgAnsi(HEX_TOOL.accent)}${this.toolName}${FG_RESET}`;
    const barBg = extractBgAnsi(boxLines[0] ?? "");

    const lines: string[] = [];
    if (this.toolName === "bash" && this.callRendererComponent) {
      // omp's bash renderer intentionally has no tool-title header. Its command
      // is the first section, followed by a labeled Output divider once a
      // result exists. Render pi's call/result components independently to
      // remove the Box's vertical padding and preserve that structure.
      const innerWidth = Math.max(1, width - 4);
      const callLines = renderBashCall(this.callRendererComponent, innerWidth, this.args);
      const resultLines = renderBashResult(this.resultRendererComponent, innerWidth, this.args);
      lines.push(buildFrameBar(width, "top", "", borderColor, barBg));
      for (const line of callLines) {
        lines.push(renderFrameContentRow(line, width, borderColor, barBg));
      }
      if (this.resultRendererComponent) {
        lines.push(buildSectionBar(width, `${fgAnsi(HEX.lavender)}Output${FG_RESET}`, borderColor, barBg));
        for (const line of resultLines) {
          lines.push(renderFrameContentRow(line, width, borderColor, barBg));
        }
      }
    } else {
      lines.push(buildFrameBar(width, "top", header, borderColor, barBg));
      for (const line of boxLines) {
        lines.push(addSideBorders(line, width, borderColor));
      }
    }
    for (let i = 0; i < this.imageComponents.length; i++) {
      const spacer = this.imageSpacers[i];
      if (spacer) lines.push(...spacer.render(width));
      const imageComponent = this.imageComponents[i];
      if (imageComponent) lines.push(...imageComponent.render(width));
    }
    lines.push(buildFrameBar(width, "bottom", "", borderColor, barBg));
    // pi's core component owns one leading Spacer; keep it so consecutive
    // tool blocks have the same single blank separator as omp's transcript.
    lines.unshift("");
    return lines;
  } as typeof proto.render;
}

export default function ompFeelExtension(pi: ExtensionAPI) {
  patchToolCallFraming();
  let currentCtx: ExtensionContext | undefined;

  pi.on("session_start", (_event, ctx) => {
    stopWorkingShimmer();
    currentCtx = ctx;
    activeFooter = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    configureWorkingIndicator(ctx);

    ctx.ui.setHiddenThinkingLabel("…");

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new OmpEditor(
        tui,
        theme,
        keybindings,
        () => currentCtx,
        (width) => activeFooter?.renderStatusBar(width) ?? "",
      );
      activeEditor = editor;
      return editor;
    });

    ctx.ui.setFooter((tui, _theme, footerData) => {
      activeTui = tui;
      activeFooter = new OmpFooter(footerData, () => currentCtx);
      return activeFooter;
    });
  });

  pi.on("message_end", () => {
    activeTui?.requestRender();
  });
  pi.on("tool_execution_end", () => {
    activeTui?.requestRender();
  });
  pi.on("turn_end", () => {
    stopWorkingShimmer();
    activeTui?.requestRender();
  });
  pi.on("model_select", () => {
    activeEditor?.invalidate();
    activeTui?.requestRender();
  });
  pi.on("thinking_level_select", () => {
    activeEditor?.invalidate();
    activeTui?.requestRender();
  });
  pi.on("agent_start", () => {
    if (currentCtx?.mode === "tui" && currentCtx.hasUI) startWorkingShimmer(currentCtx);
    activeTui?.requestRender();
  });
  pi.on("agent_end", () => {
    stopWorkingShimmer();
    activeTui?.requestRender();
  });
  pi.on("agent_settled", () => {
    stopWorkingShimmer();
    activeTui?.requestRender();
  });
  pi.on("session_info_changed", () => {
    if (currentCtx?.mode === "tui" && currentCtx.hasUI) configureWorkingIndicator(currentCtx);
    activeTui?.requestRender();
  });

  pi.on("session_shutdown", () => {
    stopWorkingShimmer();
    activeTui = undefined;
    activeEditor = undefined;
    activeFooter = undefined;
    currentCtx = undefined;
  });
}

let activeTui: TUI | undefined;
let activeEditor: OmpEditor | undefined;
let activeFooter: OmpFooter | undefined;
let workingShimmerTimer: ReturnType<typeof setInterval> | undefined;
