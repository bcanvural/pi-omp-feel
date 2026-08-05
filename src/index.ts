import { CustomEditor, getAgentDir, highlightCode, ToolExecutionComponent, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ═══════════════════════════════════════════════════════════════════════════
// omp dark-catppuccin palette (pi's Theme can't express status-line colors,
// so the bar carries its own hardcoded omp colors — faithful regardless of the
// active pi theme).
//
// Verified against omp's `theme/defaults/dark-catppuccin.json`: statusLineBg =
// crust, statusLineSep = surface1, statusLineModel = pink, statusLinePath =
// teal, statusLineGitClean = green, statusLineGitDirty = yellow,
// statusLineContext = mauve, statusLineCost = maroon. The palette is kept whole
// even where pi has no equivalent segment (`sky` is omp's statusLineUntracked).
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

const sessionAccentCache = new Map<string, string>();

/** Match omp's stable warm accent for a named session on a dark theme. */
function sessionAccentHex(name: string): string {
  const cached = sessionAccentCache.get(name);
  if (cached !== undefined) return cached;
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = (((hash << 5) + hash) ^ name.charCodeAt(i)) >>> 0;
  }
  const hex = hslToHex(hash % 120, 0.9, 0.72);
  sessionAccentCache.set(name, hex);
  return hex;
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
  // omp's status path uses this compact Nerd Font folder glyph rather than the
  // two-cell emoji folder, which keeps the segment geometry stable. Verified
  // against a capture of omp's own status line (U+F014, single cell).
  folder: "\uf014",
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

// omp status glyphs (unicode preset, `status.*`) for the pending/error tool header,
// plus its `format.bullet` for one-line tool rows (nerd preset renders it U+F111).
const STATUS_ICON = {
  pending: "⏳",
  running: "⟳",
  error: "✘",
  bullet: "•",
} as const;

// Tool-block frame colors (omp dark-catppuccin): accent border while running or
// pending, error while failing, dim when done; title always accent.
//
// `accent` is peach, not blue. omp resolves it to `peach` in its theme and a
// capture of omp's own frames confirms the header glyph and label render
// #fab387; #89b4fa is omp's `border` color, which its output blocks do not use.
const HEX_TOOL = {
  accent: HEX.peach,
  error: HEX.red,
  dim: HEX.overlay0,
  // omp's `borderMuted`. Captures of its own frames show write blocks drawn with
  // this rather than `dim`, which bash blocks use.
  muted: HEX.surface0,
} as const;

/** Tools omp draws with `borderMuted` instead of `dim` once they have settled. */
const TOOL_BORDER_MUTED = new Set(["write", "edit"]);

// omp unicode thinking-level glyphs (`theme.thinking`).
const THINKING_DISPLAY: Record<string, string> = {
  minimal: "○ min",
  low: "◔ low",
  medium: "◑ med",
  high: "◒ high",
  xhigh: "◕ xhigh",
  max: "◉ max",
};

// Border colors per thinking level when no session accent applies.
const THINKING_COLOR: Record<string, string> = {
  minimal: HEX.overlay0,
  low: HEX.blue,
  medium: HEX.sapphire,
  high: HEX.mauve,
  xhigh: HEX.pink,
  max: HEX.pink,
  off: HEX.surface0,
};


// ═══════════════════════════════════════════════════════════════════════════
// Small helpers
// ═══════════════════════════════════════════════════════════════════════════

// Escape sequences the rendered lines can carry. Matching only CSI left OSC
// hyperlinks and APC sequences behind — and pi's cursor marker is APC — so both
// "is this row blank" and the bash wall-time match failed on any line carrying
// one. pi-tui covers all three families in `extractAnsiCode` but does not
// export it, so mirror its coverage: CSI, then OSC/APC up to either terminator
// (BEL or ST).
const ANSI_SEQ =
  /[\u001b\u009b][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-nqry=><]|\u001b[\]_][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQ, "");
}

const FLAT_BORDER = /^─+$/;

/** True for the plain `─` rows the stock Editor draws as its top/bottom border. */
function isFlatBorderLine(line: string): boolean {
  return FLAT_BORDER.test(stripAnsi(line));
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

/** `<glyph> <model>[ · <thinking>]`, shared by the status segment and the
 * editor's top-border fallback so the two cannot drift apart. */
function modelBadgeText(ctx: ExtensionContext): string {
  const model = ctx.model as ({ id?: string; name?: string } | undefined);
  let modelName = model?.name || model?.id || "no-model";
  if (modelName.startsWith("Claude ")) {
    modelName = modelName.slice(7);
  }

  let text = `${ICON.model} ${modelName}`;
  if (ctx.model?.reasoning) {
    const level = ctx.thinkingLevel || "off";
    if (level !== "off") {
      text += `${ICON.dot}${THINKING_DISPLAY[level] ?? level}`;
    }
  }
  return text;
}

function modelSegment(ctx: ExtensionContext): Segment {
  return { content: `${fgAnsi(HEX.pink)}${modelBadgeText(ctx)}${FG_RESET}`, visible: true };
}

/** omp's default path clamp, and the floor it is never shrunk past. */
const PATH_MAX_LENGTH = 40;
const PATH_MIN_LENGTH = 12;

function pathSegment(ctx: ExtensionContext, maxLength: number): Segment {
  let pwd = stripDisplayRoot(ctx.cwd);
  pwd = shortenPath(pwd);
  pwd = clampPathLength(pwd, maxLength);
  return { content: `${fgAnsi(HEX.teal)}${ICON.folder} ${pwd}${FG_RESET}`, visible: true };
}

function gitSegment(footerData: ReadonlyFooterDataProvider): Segment {
  const branch = footerData.getGitBranch();
  if (!branch) return { content: "", visible: false };
  const color = branch === "detached" ? HEX.yellow : HEX.green;
  return { content: `${fgAnsi(color)}${ICON.branch} ${branch}${FG_RESET}`, visible: true };
}

// `contextUsage` is required rather than defaulted: `getContextUsage()` walks the
// session branch, so the caller must fetch it once and pass it in.
function contextPercentSegment(
  ctx: ExtensionContext,
  contextUsage: ReturnType<ExtensionContext["getContextUsage"]>,
): Segment {
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
  // omp hides this glyph when auto-compaction is off, but pi exposes no accessor
  // for that setting to extensions (only its RPC `set_auto_compaction` path
  // touches it), so assume pi's default of enabled. The probe stays so the glyph
  // starts tracking the real setting for free if pi ever surfaces it.
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

function costSegment(usageTotals: UsageTotals): Segment {
  if (!usageTotals.cost) return { content: "", visible: false };
  return { content: `${fgAnsi(HEX.maroon)}$${usageTotals.cost.toFixed(2)}${FG_RESET}`, visible: true };
}

function sessionNameSegment(name: string | undefined): Segment {
  if (!name) return { content: "", visible: false };
  return { content: `${fgAnsi(sessionAccentHex(name))}${sanitizeStatusText(name)}${FG_RESET}`, visible: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// omp status-line component (the extension footer only carries hook statuses;
// the main bar is rendered through the editor's top border).
// ═══════════════════════════════════════════════════════════════════════════

// `sessionManager.getSessionName()` builds a filtered copy of the whole session
// log on every call, so it must never run from a render path — the editor
// re-renders on every keystroke. Refresh it on the events that can change it
// and read the cached value while rendering.
let cachedSessionName: string | undefined;
let cachedSessionNameValid = false;

function refreshSessionName(ctx: ExtensionContext | undefined): void {
  if (!ctx) {
    // Drop the cache rather than marking an empty name valid: without a context
    // there is nothing to read, and a later read with a real context must scan
    // instead of trusting this.
    cachedSessionName = undefined;
    cachedSessionNameValid = false;
    return;
  }
  cachedSessionName = ctx.sessionManager.getSessionName();
  cachedSessionNameValid = true;
}

function currentSessionName(ctx: ExtensionContext): string | undefined {
  if (!cachedSessionNameValid) refreshSessionName(ctx);
  return cachedSessionName;
}

class OmpFooter {
  private footerData: ReadonlyFooterDataProvider;
  private getCtx: () => ExtensionContext | undefined;
  private cachedStatusBar?: { width: number; value: string };
  private unsubscribeBranchChange?: () => void;
  // Incremental usage totals: the session log is append-only, so totals only
  // need the entries added since the last refresh instead of a full rescan.
  private usageTotals = createUsageTotals();
  private entriesSeen = 0;

  constructor(footerData: ReadonlyFooterDataProvider, getCtx: () => ExtensionContext | undefined) {
    this.footerData = footerData;
    this.getCtx = getCtx;
    this.unsubscribeBranchChange = footerData.onBranchChange(() => this.invalidate());
  }

  invalidate(): void {
    // Deliberately does not refresh the session name: `getSessionName()` walks
    // the whole session log, and the name can only change through
    // `setSessionName` (which emits `session_info_changed`) or the `--name` flag
    // at startup — both of which refresh it directly.
    this.cachedStatusBar = undefined;
  }

  /** Fold entries appended since the last refresh into the running totals. */
  private refreshUsage(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
    for (let i = this.entriesSeen; i < entries.length; i++) {
      const entry = entries[i];
      if (isAssistantMessageEntry(entry)) {
        addUsageToTotals(this.usageTotals, entry.message.usage);
      } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
        addUsageToTotals(this.usageTotals, entry.message.usage as never);
      } else if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as { usage?: unknown }).usage) {
        addUsageToTotals(this.usageTotals, (entry as { usage: unknown }).usage as never);
      }
    }
    this.entriesSeen = entries.length;
  }

  dispose(): void {
    this.unsubscribeBranchChange?.();
    this.unsubscribeBranchChange = undefined;
  }

  renderStatusBar(width: number): string {
    const ctx = this.getCtx();
    if (!ctx) return "";
    if (this.cachedStatusBar?.width === width) return this.cachedStatusBar.value;

    const contextUsage = ctx.getContextUsage();
    const sessionName = currentSessionName(ctx);
    this.refreshUsage(ctx);
    const usageTotals = this.usageTotals;

    const bg = bgAnsi(HEX.crust);
    const fg = fgAnsi(HEX.text);
    const sepFg = fgAnsi(HEX.surface1);

    const groupWidth = (parts: string[]): number => {
      if (parts.length === 0) return 0;
      const partsWidth = parts.reduce((sum, part) => sum + visibleWidth(part), 0);
      // One space either side of every separator, plus a leading and trailing
      // pad cell, plus the one-cell powerline cap.
      const sepTotal = Math.max(0, parts.length - 1) * 3;
      return partsWidth + sepTotal + 2 + 1;
    };

    // Collect visible segments (omp default preset: pi, model, mode, collab,
    // path, git, pr, context_pct, cost on the left; session_name on the right.
    // mode/collab/pr have no pi equivalent, so they render invisible).
    const collect = (pathMaxLength: number) => {
      const left: string[] = [];
      for (const segment of [
        piSegment(),
        modelSegment(ctx),
        pathSegment(ctx, pathMaxLength),
        gitSegment(this.footerData),
        contextPercentSegment(ctx, contextUsage),
        costSegment(usageTotals),
      ]) {
        if (segment.visible && segment.content) left.push(segment.content);
      }
      const right: string[] = [];
      const sessionSegment = sessionNameSegment(sessionName);
      if (sessionSegment.visible && sessionSegment.content) right.push(sessionSegment.content);
      return { left, right, total: groupWidth(left) + groupWidth(right) };
    };

    // The path is the only elastic segment, so when the bar does not fit, give
    // back its excess rather than letting the whole line be clipped — clipping
    // silently drops whatever sits at the end (the auto-compaction glyph, the
    // cost, the closing cap). omp shortens the path the same way.
    let parts = collect(PATH_MAX_LENGTH);
    if (parts.total > width) {
      parts = collect(Math.max(PATH_MIN_LENGTH, PATH_MAX_LENGTH - (parts.total - width)));
    }
    const leftParts = parts.left;
    const rightParts = parts.right;

    if (leftParts.length === 0 && rightParts.length === 0) {
      this.cachedStatusBar = { width, value: "" };
      return "";
    }

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
      const gapColor = sessionName ? sessionAccentHex(sessionName) : HEX.blue;
      const gapFill = `${fgAnsi(gapColor)}${ICON.gap.repeat(gapWidth)}${FG_RESET}`;
      bar = leftGroup + gapFill + rightGroup;
    }

    this.cachedStatusBar = { width, value: bar };
    return bar;
  }

  private cachedStatusLines?: { width: number; key: string; lines: string[] };

  render(width: number): string[] {
    // Extension statuses render below the bar, like omp's hook status lines.
    // pi hands back its live Map, so this is called on every frame; the sort,
    // ANSI strip and width clamp cost 6-15 µs each time for content that only
    // changes when an extension calls setStatus. Key the result on the map
    // contents — building that key is far cheaper than redoing the work.
    const extensionStatuses = this.footerData.getExtensionStatuses();
    if (extensionStatuses.size === 0) {
      this.cachedStatusLines = undefined;
      return [];
    }

    let key = "";
    for (const [statusKey, text] of extensionStatuses) key += `${statusKey}\u0000${text}\u0001`;
    const cached = this.cachedStatusLines;
    if (cached && cached.width === width && cached.key === key) return cached.lines;

    const statusText = Array.from(extensionStatuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitizeStatusText(stripAnsi(text)))
      .filter(Boolean)
      .join(" ");
    const lines = statusText
      ? [truncateToWidth(`${fgAnsi(HEX.overlay1)}${statusText}${FG_RESET}`, width, `${fgAnsi(HEX.overlay1)}…${FG_RESET}`)]
      : [];
    this.cachedStatusLines = { width, key, lines };
    return lines;
  }
}

const OMP_WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const OMP_WORKING_TEXT = "Working…";
const OMP_WORKING_HINT = "⟨esc⟩";

// The band sweeps the label *and* the Esc hint as one strip, then rests. Measured
// off omp's own frames: the two cells either side of the peak carry the accent, a
// further two fade through overlay1, and the sweep is followed by a stretch where
// nothing is lit. Over the hint the peak is lavender rather than the accent.
const SHIMMER_PEAK_RADIUS = 2;
const SHIMMER_FADE_RADIUS = 4;
const SHIMMER_REST_FRAMES = 8;

/** Cells the band travels across: the label, the joining space, and the hint. */
const OMP_SHIMMER_CELLS = [...OMP_WORKING_TEXT].length + 1 + [...OMP_WORKING_HINT].length;

/** One full cycle: the band enters, crosses every cell, leaves, then rests. */
const OMP_SHIMMER_PERIOD = OMP_SHIMMER_CELLS + 2 * SHIMMER_FADE_RADIUS + SHIMMER_REST_FRAMES;

function leastCommonMultiple(a: number, b: number): number {
  const greatestCommonDivisor = (x: number, y: number): number => (y === 0 ? x : greatestCommonDivisor(y, x % y));
  return (a * b) / greatestCommonDivisor(a, b);
}

// Pi cycles the supplied frames verbatim, so the list has to span a whole number
// of both the spinner and the shimmer cycle. A shorter list wraps one of them
// mid-cycle: at 16 frames the 10-glyph spinner jumped five positions on every
// wrap, roughly once a second.
const OMP_WORKING_FRAME_COUNT = leastCommonMultiple(OMP_WORKING_FRAMES.length, OMP_SHIMMER_PERIOD);

function workingAccent(ctx: ExtensionContext): string {
  const sessionName = currentSessionName(ctx);
  return sessionName ? sessionAccentHex(sessionName) : HEX.peach;
}

function workingMessage(accent: string, frame: number): string {
  const labelCells = [...OMP_WORKING_TEXT];
  const cells = [...labelCells, " ", ...OMP_WORKING_HINT];
  const center = (frame % OMP_SHIMMER_PERIOD) - SHIMMER_FADE_RADIUS;

  return cells
    .map((character, index) => {
      const distance = Math.abs(index - center);
      // The hint peaks lavender; the label peaks in the session accent.
      const peak = index > labelCells.length ? HEX.lavender : accent;
      const color =
        distance <= SHIMMER_PEAK_RADIUS
          ? peak
          : distance <= SHIMMER_FADE_RADIUS
            ? HEX.overlay1
            : HEX.overlay0;
      const bold = distance === 0 ? "\x1b[1m" : "";
      const boldReset = distance === 0 ? "\x1b[22m" : "";
      return `${bold}${fgAnsi(color)}${character}${FG_RESET}${boldReset}`;
    })
    .join("");
}

// The frames depend on nothing but the accent, while `configureWorkingIndicator`
// runs on every `agent_start`. Rebuilding all 70 every turn threw away ~14 KB per
// turn for an identical result, so keep the last set.
let cachedWorkingFrames: { accent: string; frames: string[] } | undefined;

function workingFrames(accent: string): string[] {
  if (cachedWorkingFrames?.accent === accent) return cachedWorkingFrames.frames;
  // Pi treats supplied frames as verbatim. Include the message in each frame so
  // the Loader's own 80 ms animation advances the shimmer reliably rather than
  // relying on a second timer that can be replaced by core status events.
  const frames = Array.from({ length: OMP_WORKING_FRAME_COUNT }, (_, index) => {
    const spinner = OMP_WORKING_FRAMES[index % OMP_WORKING_FRAMES.length];
    return `${fgAnsi(accent)}${spinner}${FG_RESET} ${workingMessage(accent, index)}`;
  });
  cachedWorkingFrames = { accent, frames };
  return frames;
}

function configureWorkingIndicator(ctx: ExtensionContext): void {
  ctx.ui.setWorkingIndicator({
    frames: workingFrames(workingAccent(ctx)),
    intervalMs: 80,
  });
  // omp uses a Unicode ellipsis and an explicit Esc hint instead of pi's
  // default ASCII message. ANSI is nested deliberately so pi's muted wrapper
  // still leaves the main label and hint in their omp colors.
  // The frame itself carries the message; clear Pi's separate message slot so
  // it does not append the default static "Working..." text.
  ctx.ui.setWorkingMessage?.("");
}

// ═══════════════════════════════════════════════════════════════════════════
// Degrading instead of crashing
//
// The two sections below reach past pi's public surface: the editor depends on
// the shape of the stock Editor's rendered rows, and the tool-frame patch
// replaces a method on a shared prototype and reads its private fields. Neither
// has a supported alternative — pi's TUI has no top-border provider, and
// `renderShell`/`renderCall`/`renderResult` only apply to tools an extension
// registers itself. Both also run on every frame, so an internal change in pi
// would otherwise throw ~60 times a second and take the whole TUI down with it.
// Instead: fail once, say so in the footer, and hand rendering back to pi for
// the rest of the session.
// ═══════════════════════════════════════════════════════════════════════════

let toolFramingDisabled = false;
let editorReshapeDisabled = false;

type DegradedSubsystem = "tool-framing" | "prompt-framing";

const DEGRADED_LABEL: Record<DegradedSubsystem, string> = {
  "tool-framing": "tool-call framing",
  "prompt-framing": "prompt framing",
};

// What each subsystem assumes about pi's internals. A failure means one of these
// stopped holding, so listing them in the report turns "something threw" into a
// checklist someone (or an agent) can work through against the installed pi.
const DEGRADED_ASSUMPTIONS: Record<DegradedSubsystem, string[]> = {
  "tool-framing": [
    "`ToolExecutionComponent.prototype.render` can be patched, because the extension loader resolves `@earendil-works/pi-coding-agent` to the same module instance pi core imports.",
    "Instance members read: `hideComponent`, `hasRendererDefinition()`, `getRenderShell()`, `contentBox.render()`, `contentBox.bgFn()`, `contentText.render()`, `callRendererComponent`, `resultRendererComponent`, `args`, `imageComponents`, `imageSpacers`, `isPartial`, `executionStarted`, `result.isError`, `toolName`.",
    "`contentBox` is a pi-tui `Box` with paddingX 1, so it renders children at `width - 2`. The bash path therefore skips it entirely (rendering those same children only at `width - 4`) and takes the background tint from `contentBox.bgFn(\"\")` instead — rendering both would thrash the children's single-width caches.",
    "Rows from a background-tinted `Box` start with an SGR background sequence and end with `ESC[49m` (see `addSideBorders`).",
    "`theme.bg()` returns `<bg-ansi><text>ESC[49m`, so an empty probe yields the same background prefix as a rendered row.",
  ],
  "prompt-framing": [
    "The stock pi `Editor` draws its top and bottom border as rows containing only `─` (see `isFlatBorderLine`).",
    "A scrolled prompt replaces the top border with a `↑` scroll row, which must not match the flat-border test.",
    "With paddingX 2, every content row comes back padded to exactly `innerWidth` with two leading and two trailing spaces — the rail and bottom-corner fast paths skip truncation on that basis.",
    "Autocomplete rows are emitted after the bottom border row and keep the stock layout.",
    "`super.render()` returns a freshly allocated array that is safe to mutate in place.",
  ],
};

const DEGRADED_REPORT_NAME = "pi-omp-feel-degraded.md";
const DEGRADED_REPORT_MAX_BYTES = 256_000;

/** Capture a diagnostic value without ever throwing — these run inside `catch`
 * blocks, where a second throw would escape the guard entirely. */
function safeProbe(probe: () => string): string {
  try {
    return probe();
  } catch (error) {
    return `<probe failed: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

function extensionSourcePath(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "unknown (extension loaded from a virtual module)";
  }
}

/** Record a degraded subsystem in full, and point the footer at the report.
 *
 * The footer line is sanitized to one row and truncated to the terminal width,
 * so it can only ever carry a pointer. Everything a fix needs — stack trace, pi
 * version, the assumptions that broke — goes to a file that can be handed to an
 * agent verbatim (in pi: `@<path>`). */
function reportDegraded(subsystem: DegradedSubsystem, error: unknown, context: Record<string, unknown> = {}): void {
  const label = DEGRADED_LABEL[subsystem];
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const detail = error instanceof Error ? (error.stack ?? message) : message;
  const reportPath = join(getAgentDir(), DEGRADED_REPORT_NAME);

  let wrote = false;
  let writeFailure: string | undefined;
  try {
    const entry = [
      `## pi-omp-feel: ${label} disabled`,
      "",
      "This extension deliberately reaches past pi's public API (see the README).",
      "It disabled the subsystem below after one of the listed assumptions stopped",
      "holding, and handed rendering back to pi for the rest of the session.",
      "Paste this whole entry into an agent to get it fixed.",
      "",
      `- when: ${new Date().toISOString()}`,
      `- subsystem: \`${subsystem}\``,
      `- pi version: \`${PI_VERSION}\``,
      `- extension source: \`${extensionSourcePath()}\``,
      `- node: \`${process.version}\` on \`${process.platform}/${process.arch}\``,
      ...Object.entries(context).map(([key, value]) => `- ${key}: \`${String(value)}\``),
      "",
      "### Assumptions this subsystem depends on",
      "",
      ...DEGRADED_ASSUMPTIONS[subsystem].map(assumption => `- ${assumption}`),
      "",
      "### Error",
      "",
      "```",
      detail,
      "```",
      "",
      "---",
      "",
      "",
    ].join("\n");

    mkdirSync(getAgentDir(), { recursive: true });
    // Append, so repeated failures across sessions accumulate — but start over
    // once the log is large rather than reading it back to rewrite it.
    const oversized = existsSync(reportPath) && statSync(reportPath).size >= DEGRADED_REPORT_MAX_BYTES;
    if (oversized) writeFileSync(reportPath, entry);
    else appendFileSync(reportPath, entry);
    wrote = true;
  } catch (writeError) {
    // Reporting must never mask the failure it is reporting, and never write to
    // stdout/stderr — that corrupts the TUI. Fall back to the footer.
    writeFailure = writeError instanceof Error ? writeError.message : String(writeError);
  }

  const pointer = wrote
    ? `see ${shortenPath(reportPath)}`
    : `report unwritable (${sanitizeStatusText(writeFailure ?? "unknown")}) — ${sanitizeStatusText(message)}`;
  currentCtx?.ui.setStatus(`omp-feel-${subsystem}`, `omp-feel: ${label} disabled — ${pointer}`);
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

  override setPaddingX(_padding: number): void {
    // Pi copies the default editor's padding onto extension editors after the
    // factory returns. Keep omp's two-cell geometry instead of accepting the
    // default zero padding, which changes wrapping and breaks the side rails.
    super.setPaddingX(2);
  }

  private lastBorderColorState?: string;

  private updateBorderColor(): void {
    const ctx = this.getCtx();
    if (!ctx) {
      if (this.lastBorderColorState === "base") return;
      this.lastBorderColorState = "base";
      this.borderColor = this.baseBorderColor;
      return;
    }
    const sessionName = currentSessionName(ctx);
    const thinkingLevel = ctx.thinkingLevel || "off";
    const color = sessionName ? sessionAccentHex(sessionName) : (THINKING_COLOR[thinkingLevel] ?? HEX.surface0);
    if (this.lastBorderColorState === color) return;
    this.lastBorderColorState = color;
    this.borderColor = (text: string): string => `${fgAnsi(color)}${text}${FG_RESET}`;
  }

  private topBorderStatus(width: number): string | undefined {
    const statusLine = this.getStatusLine(width);
    if (statusLine) return statusLine;

    const ctx = this.getCtx();
    if (!ctx?.model) return undefined;
    return `${fgAnsi(HEX.pink)}${modelBadgeText(ctx)}${FG_RESET}`;
  }

  private topBorderMemo?: { width: number; status: string; borderState: string; line: string };

  private buildRoundedTop(width: number): string {
    const left = "╭──";
    const right = "──╮";
    const fillWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
    const status = this.topBorderStatus(fillWidth) ?? "";

    // The status line is dense with ANSI escapes, so clamping it takes
    // truncateToWidth's slow per-character path. It only changes when the footer
    // is invalidated, so memoize the finished row rather than rebuilding it on
    // every keystroke.
    const borderState = this.lastBorderColorState ?? "";
    const memo = this.topBorderMemo;
    if (memo && memo.width === width && memo.borderState === borderState && memo.status === status) {
      return memo.line;
    }

    let line: string;
    if (status) {
      const clamped = truncateToWidth(status, fillWidth, `${fgAnsi(HEX.pink)}…${FG_RESET}`);
      const fill = Math.max(0, fillWidth - visibleWidth(clamped));
      line = `${this.borderColor(left)}${clamped}${this.borderColor("─".repeat(fill))}${this.borderColor(right)}`;
    } else {
      line = `${this.borderColor(left)}${this.borderColor("─".repeat(fillWidth))}${this.borderColor(right)}`;
    }
    this.topBorderMemo = { width, status, borderState, line };
    return line;
  }

  override render(width: number): string[] {
    if (editorReshapeDisabled || width < 4) return super.render(width);
    try {
      return this.renderOmpFrame(width);
    } catch (error) {
      editorReshapeDisabled = true;
      reportDegraded("prompt-framing", error, {
        width,
        // What the stock editor actually returned, stripped of colour: the fastest
        // way to see which layout assumption no longer matches.
        "stock rows": safeProbe(() =>
          JSON.stringify(super.render(Math.max(2, width - 2)).map(line => stripAnsi(line)))),
      });
      return super.render(width);
    }
  }

  /** Reshape the stock editor's rows into omp's rounded frame. Assumes the stock
   * layout (flat `─` border rows, two-cell padding); `render` above catches the
   * fallout if that ever stops holding. */
  private renderOmpFrame(width: number): string[] {
    this.updateBorderColor();
    const innerWidth = Math.max(2, width - 2);
    const lines = super.render(innerWidth);

    // Border lines are the flat `─` rows the stock Editor draws. Detect them on
    // the pristine output first (our rounded replacements contain the status
    // text and no longer match), then reshape. The top border is only the plain
    // row when the editor is not scrolled (a scrolled prompt swaps it for a `↑`
    // scroll row, which never matches all-dashes); the bottom border is the last
    // all-dashes row. Autocomplete rows render below the bottom border untouched.
    // Scanning backwards with an early exit finds the same last flat row as a
    // forward scan, but with autocomplete closed the bottom border is the final
    // line — one strip-and-test instead of one per rendered line.
    const topIndex = isFlatBorderLine(lines[0]) ? 0 : -1;
    let bottomIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (isFlatBorderLine(lines[i])) {
        bottomIndex = i;
        break;
      }
    }

    if (topIndex >= 0) lines[topIndex] = this.buildRoundedTop(width);

    // The upstream pi editor has no vertical rails. Add them around only the
    // editable rows; autocomplete rows follow the bottom border and must keep
    // their stock layout.
    const firstContent = topIndex >= 0 ? topIndex + 1 : 0;
    const lastContent = bottomIndex >= 0 ? bottomIndex : lines.length;
    // The stock Editor already pads every row to exactly `innerWidth`, so the
    // common case needs neither a truncate nor a pad — skipping them avoids
    // truncateToWidth's per-character ANSI walk on the cursor row, which changes
    // (and so never caches) on every keystroke.
    const railEdge = this.borderColor("│");
    const rail = (text: string): string => {
      const textWidth = visibleWidth(text);
      if (textWidth === innerWidth) return `${railEdge}${text}${railEdge}`;
      const content = textWidth > innerWidth ? truncateToWidth(text, innerWidth) : text;
      const contentWidth = textWidth > innerWidth ? visibleWidth(content) : textWidth;
      return `${railEdge}${content}${" ".repeat(Math.max(0, innerWidth - contentWidth))}${railEdge}`;
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
      const rawWidth = visibleWidth(lines[i]);
      const raw = rawWidth > innerWidth ? truncateToWidth(lines[i], innerWidth) : lines[i];
      let middle = raw.startsWith("  ") ? raw.slice(2) : raw;
      if (middle.endsWith("  ")) middle = middle.slice(0, -2);
      const middleWidth = Math.max(0, width - 6);
      let middleCurrentWidth = visibleWidth(middle);
      if (middleCurrentWidth > middleWidth) {
        middle = truncateToWidth(middle, middleWidth);
        middleCurrentWidth = visibleWidth(middle);
      }
      if (middleCurrentWidth < middleWidth) {
        middle = `${middle}${" ".repeat(middleWidth - middleCurrentWidth)}`;
      }
      // `╰─ ` and ` ─╯` are three cells each, so once `middle` is exactly
      // `middleWidth` the row is exactly `width` wide by construction. Only the
      // degenerate narrow case, where the corners alone overflow, needs a clamp.
      const cornered = `${this.borderColor("╰─ ")}${middle}${this.borderColor(" ─╯")}`;
      lines[i] = width >= 6 ? cornered : truncateToWidth(cornered, width);
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
function addSideBorders(line: string, borderColor: string): string {
  const m = line.startsWith("\x1b[48;2;")
    ? line.match(/^(\x1b\[48;2;\d+;\d+;\d+m)([\s\S]*?)(\x1b\[49m)$/)
    : line.startsWith("\x1b[48;5;")
      ? line.match(/^(\x1b\[48;5;\d+m)([\s\S]*?)(\x1b\[49m)$/)
      : null;
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

/** Split pi's `<tool> <target>` call row into its two halves, so both the
 * one-line rows and the framed headers can name what the tool acted on without
 * per-tool knowledge of where the target lives in `args`. Returns no target
 * unless the row really does lead with this tool's name. */
function splitToolCallRow(contentLine: string, toolName: string): { title: string; target: string } {
  const plain = sanitizeStatusText(stripAnsi(contentLine));
  const split = plain.indexOf(" ");
  const label = split === -1 ? plain : plain.slice(0, split);
  const title = `${toolName.charAt(0).toUpperCase()}${toolName.slice(1)}`;
  if (label.toLowerCase() !== toolName.toLowerCase()) return { title, target: "" };
  return { title, target: split === -1 ? "" : plain.slice(split + 1) };
}

/** omp renders tools it gives no identity glyph to — `read` and friends — as a
 * single row instead of a block: an uncoloured bullet, the label in `toolTitle`,
 * then the target in `accent`. Neither of omp's glyph presets defines a
 * `tool.read`/`tool.grep`/`tool.ls` entry, which is how it marks them out. */
function renderToolOneLine(contentLine: string, toolName: string): string {
  const { title, target } = splitToolCallRow(contentLine, toolName);
  const head = ` ${STATUS_ICON.bullet} ${fgAnsi(HEX.lavender)}${title}${FG_RESET}`;
  return target ? `${head} ${fgAnsi(HEX_TOOL.accent)}${target}${FG_RESET}` : head;
}

interface RenderableToolPart {
  render(width: number): string[];
}

interface ToolPartMemo {
  width: number;
  childLines: readonly string[][];
  lines: string[];
}

// Keyed weakly on the renderer component, so entries die with the transcript.
const toolPartMemo = new WeakMap<RenderableToolPart, ToolPartMemo>();

/** Render child components separately so pi's bash renderer's padding does not
 * become visible blank rows between omp's command/output sections.
 *
 * This runs for every framed bash block on every rendered frame — that is, on
 * every keystroke — so the trimming and the concatenation are memoized. The
 * children cannot be compared by array identity: pi's collapsed bash-output
 * renderer rebuilds `["", ...cachedLines]` on each call even when it hits its
 * own cache. Their *contents* are stable, so compare element-wise and reuse the
 * previous output, which also lets the caller's `sameLines` take its `a === b`
 * fast path. */
function renderToolPart(part: RenderableToolPart | undefined, width: number): string[] {
  if (!part) return [];
  const children = (part as RenderableToolPart & { children?: RenderableToolPart[] }).children;
  if (!Array.isArray(children)) return part.render(width);

  const childLines = children.map(child => child.render(width));
  const memo = toolPartMemo.get(part);
  if (memo && memo.width === width && memo.childLines.length === childLines.length) {
    let unchanged = true;
    for (let i = 0; i < childLines.length; i++) {
      if (!sameLines(memo.childLines[i], childLines[i])) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return memo.lines;
  }

  const lines: string[] = [];
  for (const rendered of childLines) {
    let first = 0;
    while (first < rendered.length && isBlankRenderedLine(rendered[first])) first++;
    let last = rendered.length;
    while (last > first && isBlankRenderedLine(rendered[last - 1])) last--;
    for (let i = first; i < last; i++) lines.push(rendered[i]);
  }
  toolPartMemo.set(part, { width, childLines, lines });
  return lines;
}

// The command string of a given tool call never changes, but the block
// re-renders (and re-highlights) on every state change — including each
// streaming chunk. Cache the tokenized output, bounded by command count.
const bashHighlightCache = new Map<string, string[]>();
const BASH_HIGHLIGHT_CACHE_MAX = 64;

function highlightBashCommand(command: string): string[] {
  const cached = bashHighlightCache.get(command);
  if (cached !== undefined) return cached;
  if (bashHighlightCache.size >= BASH_HIGHLIGHT_CACHE_MAX) bashHighlightCache.clear();
  const highlighted = highlightCode(command, "bash");
  bashHighlightCache.set(command, highlighted);
  return highlighted;
}

/** Re-render pi's bold bash call in omp's dim-prefix/syntax-highlighted style. */
function renderBashCallLines(rawLines: readonly string[], args: unknown): string[] {
  const command =
    args && typeof args === "object" && typeof (args as { command?: unknown }).command === "string"
      ? (args as { command: string }).command.replace(/\t/g, "   ")
      : "";
  if (!command) return [...rawLines];

  const highlighted = highlightBashCommand(command);
  if (highlighted.length === 0) return [...rawLines];
  const prefix = `${fgAnsi(HEX.overlay0)}$ ${FG_RESET}`;
  return highlighted.map((line, index) => (index === 0 ? `${prefix}${line}` : line));
}

const BASH_TOOK_PATTERN = /^Took\s+(.+)$/;
const BASH_EXIT_PATTERN = /^Command exited with code (\d+)$/;

/** Match omp's wall-time badge without fabricating a timeout when pi did not
 * supply one in the tool arguments.
 *
 * omp also folds a non-zero exit status into that badge — `⟨Wall: 0.01s |
 * Exit: 2⟩` — where pi devotes a whole row to it, preceded by blank rows. Fold
 * it the same way, but only when there is a badge to fold it into, so the status
 * can never be dropped if pi changes how it reports one. */
function renderBashResultLines(rawLines: readonly string[], args: unknown): string[] {
  const timeout =
    args && typeof args === "object" && typeof (args as { timeout?: unknown }).timeout === "number"
      ? (args as { timeout: number }).timeout
      : undefined;
  const timeoutText = timeout !== undefined && Number.isFinite(timeout) ? ` | Timeout: ${timeout}s` : "";

  // Strip each row once: this walks the rows three times, and stripping is the
  // only expensive step in it.
  const rows = rawLines.map(line => ({ line, plain: stripAnsi(line).trim() }));
  const canFoldExit = rows.some(row => BASH_TOOK_PATTERN.test(row.plain));

  let exitCode: string | undefined;
  const kept: typeof rows = [];
  for (const row of rows) {
    const exit = canFoldExit ? BASH_EXIT_PATTERN.exec(row.plain) : null;
    if (exit) {
      exitCode = exit[1];
      // pi separates the status row from the output with blank rows; they only
      // existed to set it apart, so they go with it.
      while (kept.length > 0 && kept[kept.length - 1].plain.length === 0) kept.pop();
      continue;
    }
    kept.push(row);
  }

  return kept.map(({ line, plain }) => {
    const took = BASH_TOOK_PATTERN.exec(plain);
    if (!took) return line;
    const exitText = exitCode === undefined ? "" : ` | Exit: ${exitCode}`;
    return `${fgAnsi(HEX.overlay0)}⟨Wall: ${took[1]}${timeoutText}${exitText}⟩${FG_RESET}`;
  });
}

/** Structural view of the patched component (the compiled class fields are public). */
interface FramedToolComponent {
  render: (width: number) => string[];
  hideComponent: boolean;
  hasRendererDefinition(): boolean;
  getRenderShell(): string;
  // `bgFn` is declared private in Box's .d.ts but is a plain public field at
  // runtime; Box itself samples it to validate its own cache.
  contentBox: { render(width: number): string[]; bgFn?: (text: string) => string };
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

/** Memo entry for the patched tool-frame renderer. Comparing the raw lines a
 * block was last framed from detects "nothing changed" without re-doing any
 * framing work — and because pi's Box/Text/Markdown caches hand back the same
 * line arrays while content is unchanged, the comparison usually settles on
 * identical references. Returning the memoized array on a hit also keeps the
 * output reference-stable for the transcript's own Box caches, which would
 * otherwise re-background and re-pad every visible line on every keystroke. */
interface FramedToolMemo {
  width: number;
  stateKey: string;
  rawCall: readonly string[];
  rawResult: readonly string[];
  imageKey: readonly { render(width: number): string[] }[];
  lines: string[];
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function patchToolCallFraming(): void {
  const proto = ToolExecutionComponent.prototype as unknown as PatchableTool & { render(width: number): string[] };
  if (proto.__ompFramed) return;
  proto.__ompFramed = true;

  const originalRender = proto.render;
  const frameMemo = new WeakMap<FramedToolComponent, FramedToolMemo>();
  const framedRender = function (this: FramedToolComponent, width: number): string[] {
    if (this.hideComponent) return [];
    if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
      return originalRender.call(this, width);
    }

    const isBash = this.toolName === "bash" && this.callRendererComponent !== undefined;

    // Raw, reference-stable inputs. When nothing changed, pi's component
    // caches hand back identical line arrays, so the memo below skips all
    // framing work and returns the previous output array.
    //
    // The bash branch deliberately does not render `contentBox`. Its children
    // are the very same call/result components framed below at `width - 4`, and
    // their caches key on a single width — rendering the box at `width` too
    // makes the two calls invalidate each other, so every frame re-wraps the
    // whole command output twice. Only the background tint is needed from the
    // box, and probing `bgFn` yields it in constant time.
    let boxLines: string[] | undefined;
    let rawCall: readonly string[];
    let rawResult: readonly string[];
    if (isBash) {
      const innerWidth = Math.max(1, width - 4);
      rawCall = renderToolPart(this.callRendererComponent, innerWidth);
      rawResult = this.resultRendererComponent
        ? renderToolPart(this.resultRendererComponent, innerWidth)
        : [];
    } else {
      boxLines = this.hasRendererDefinition()
        ? this.contentBox.render(width)
        : this.contentText.render(width);
      rawCall = boxLines;
      rawResult = [];
    }
    if (rawCall.length === 0 && rawResult.length === 0 && this.imageComponents.length === 0) return [];

    // `args` is not part of the key: the bash branch reads `args.command` and
    // `args.timeout`, and pi's call renderer derives its text from both, so any
    // change to either already shows up as changed `rawCall` lines. The one
    // exception is a falsy-but-present `timeout`, which the call renderer omits.
    const stateKey = `${this.isPartial ? "p" : "d"}${this.executionStarted ? "r" : ""}${this.result?.isError ? "e" : ""}|${this.toolName}`;
    const memo = frameMemo.get(this);
    if (
      memo &&
      memo.width === width &&
      memo.stateKey === stateKey &&
      memo.imageKey === this.imageComponents &&
      sameLines(memo.rawCall, rawCall) &&
      sameLines(memo.rawResult, rawResult)
    ) {
      return memo.lines;
    }

    const borderColor = this.isPartial
      ? HEX_TOOL.accent
      : this.result?.isError
        ? HEX_TOOL.error
        : TOOL_BORDER_MUTED.has(this.toolName)
          ? HEX_TOOL.muted
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
    // `theme.bg()` returns `<bg-ansi><text>\x1b[49m`, so an empty probe carries
    // the same background prefix a rendered box row would.
    const barBg = boxLines
      ? extractBgAnsi(boxLines[0] ?? "")
      : extractBgAnsi(this.contentBox.bgFn?.("") ?? "");

    const lines: string[] = [];
    let framed = true;
    if (isBash) {
      // omp's bash renderer intentionally has no tool-title header. Its command
      // is the first section, followed by a labeled Output divider once a
      // result exists. Render pi's call/result components independently to
      // remove the Box's vertical padding and preserve that structure.
      const callLines = renderBashCallLines(rawCall, this.args);
      const resultLines = renderBashResultLines(rawResult, this.args);
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
      // pi's Box pads its children with a blank row above and below (paddingY 1).
      // Inside a frame those read as empty rails, which omp's blocks do not have,
      // so skip them. The rows are still needed for the background probe above, so
      // they are dropped here rather than at the source.
      let first = 0;
      while (first < rawCall.length && isBlankRenderedLine(rawCall[first])) first++;
      let last = rawCall.length;
      while (last > first && isBlankRenderedLine(rawCall[last - 1])) last--;

      // A tool omp gives no identity glyph to, whose whole block is a single row,
      // is one of its one-line tools. Requiring that single row is what keeps this
      // safe for the rest: a `grep` with matches still gets its frame, so no output
      // can be hidden. Failures stay framed too, so the error text has a home.
      framed =
        last - first !== 1 ||
        TOOL_ICON[this.toolName] !== undefined ||
        this.result?.isError === true ||
        this.imageComponents.length > 0;

      if (framed) {
        // omp names the target in the header — `Write: note.txt` — rather than
        // repeating it as the first row of the body. Hoist pi's leading call row
        // when there is one, but only if real content is left behind: an empty
        // frame is worse than a repeated target.
        const { title, target } = splitToolCallRow(rawCall[first], this.toolName);
        let bodyStart = first;
        let framedHeader = header;
        if (target) {
          let rest = first + 1;
          while (rest < last && isBlankRenderedLine(rawCall[rest])) rest++;
          if (rest < last) {
            bodyStart = rest;
            framedHeader = `${fgAnsi(iconColor)}${icon}${FG_RESET} ${fgAnsi(HEX_TOOL.accent)}${title}:${FG_RESET} ${fgAnsi(HEX_TOOL.accent)}${target}${FG_RESET}`;
          }
        }

        lines.push(buildFrameBar(width, "top", framedHeader, borderColor, barBg));
        for (let i = bodyStart; i < last; i++) {
          lines.push(addSideBorders(rawCall[i], borderColor));
        }
      } else {
        lines.push(renderToolOneLine(rawCall[first], this.toolName));
      }
    }
    for (let i = 0; i < this.imageComponents.length; i++) {
      const spacer = this.imageSpacers[i];
      if (spacer) lines.push(...spacer.render(width));
      const imageComponent = this.imageComponents[i];
      if (imageComponent) lines.push(...imageComponent.render(width));
    }
    if (framed) lines.push(buildFrameBar(width, "bottom", "", borderColor, barBg));
    // pi's core component owns one leading Spacer; keep it so consecutive
    // tool blocks have the same single blank separator as omp's transcript.
    lines.unshift("");
    frameMemo.set(this, { width, stateKey, rawCall, rawResult, imageKey: this.imageComponents, lines });
    return lines;
  };

  proto.render = function (this: FramedToolComponent, width: number): string[] {
    if (toolFramingDisabled) return originalRender.call(this, width);
    try {
      return framedRender.call(this, width);
    } catch (error) {
      toolFramingDisabled = true;
      reportDegraded("tool-framing", error, {
        width,
        toolName: safeProbe(() => String(this.toolName)),
        renderShell: safeProbe(() => `${this.hasRendererDefinition()}/${this.getRenderShell()}`),
        state: safeProbe(() => `partial=${this.isPartial} started=${this.executionStarted} error=${this.result?.isError}`),
        // Which of the fields the patch depends on are actually present.
        "members present": safeProbe(() =>
          (["contentBox", "contentText", "callRendererComponent", "resultRendererComponent", "imageComponents", "imageSpacers", "args"] as const)
            .map(name => `${name}=${this[name] === undefined ? "missing" : "ok"}`)
            .join(" ")),
      });
      return originalRender.call(this, width);
    }
  } as typeof proto.render;
}

export default function ompFeelExtension(pi: ExtensionAPI) {
  patchToolCallFraming();

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    activeFooter = undefined;
    refreshSessionName(ctx);
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    configureWorkingIndicator(ctx);

    ctx.ui.setHiddenThinkingLabel("…");

    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new OmpEditor(
        tui,
        theme,
        keybindings,
        () => currentCtx,
        (width) => activeFooter?.renderStatusBar(width) ?? "",
      ));

    ctx.ui.setFooter((tui, _theme, footerData) => {
      activeTui = tui;
      activeFooter = new OmpFooter(footerData, () => currentCtx);
      return activeFooter;
    });
  });

  pi.on("message_end", () => {
    activeFooter?.invalidate();
    activeTui?.requestRender();
  });
  pi.on("tool_execution_end", () => {
    activeFooter?.invalidate();
    activeTui?.requestRender();
  });
  pi.on("turn_end", () => {
    activeFooter?.invalidate();
    activeTui?.requestRender();
  });
  // The editor needs no explicit invalidation: its border colour and top-border
  // memo are both keyed on the values that change here, so the next render
  // recomputes them on its own. (pi's `Editor.invalidate()` is a no-op anyway.)
  pi.on("model_select", () => {
    activeFooter?.invalidate();
    activeTui?.requestRender();
  });
  pi.on("thinking_level_select", () => {
    activeFooter?.invalidate();
    activeTui?.requestRender();
  });
  pi.on("agent_start", () => {
    if (currentCtx?.mode === "tui" && currentCtx.hasUI) configureWorkingIndicator(currentCtx);
    activeTui?.requestRender();
  });
  pi.on("agent_end", () => {
    activeTui?.requestRender();
  });
  pi.on("agent_settled", () => {
    activeTui?.requestRender();
  });
  pi.on("session_info_changed", () => {
    refreshSessionName(currentCtx);
    activeFooter?.invalidate();
    if (currentCtx?.mode === "tui" && currentCtx.hasUI) configureWorkingIndicator(currentCtx);
    activeTui?.requestRender();
  });

  pi.on("session_shutdown", () => {
    activeFooter?.dispose();
    activeTui = undefined;
    activeFooter = undefined;
    currentCtx = undefined;
    cachedSessionName = undefined;
    cachedSessionNameValid = false;
    // Release the caches whose entries can be large: the frame set is ~14 KB and
    // a highlighted command can be far bigger. `sessionAccentCache` is kept — its
    // entries are tiny and a name must always hash to the same accent.
    cachedWorkingFrames = undefined;
    bashHighlightCache.clear();
  });
}

// Module-level because the tool-frame patch runs on a shared prototype with no
// access to a session context, and `reportDegraded` needs one to reach the
// footer. The extension already assumes a single session per process.
let currentCtx: ExtensionContext | undefined;
let activeTui: TUI | undefined;
let activeFooter: OmpFooter | undefined;
