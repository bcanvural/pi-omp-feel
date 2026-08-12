import { CustomEditor, getAgentDir, getLanguageFromPath, highlightCode, InteractiveMode, ToolExecutionComponent, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SPINNER_CATEGORIES } from "./spinner-words.ts";

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
  overlay2: "#9399b2",
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
  // omp's `icon.folder` in the nerd preset; its unicode preset uses a two-cell
  // emoji folder, and this single-cell glyph keeps the segment geometry stable.
  // Careful: omp swaps in `icon.scratchFolder` (U+F014) when the cwd is a scratch
  // directory, and that one looks like a trash can. A capture taken under /tmp
  // shows it and is not evidence about the folder icon.
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

// ═══════════════════════════════════════════════════════════════════════════
// Glyph presets
//
// omp ships `nerd`, `unicode` and `ascii` presets and defaults to `unicode`.
// This defaults to `nerd`: it is what omp is actually configured with on the
// machine this was ported from, and what the status-line glyphs above already
// use, so the two families were previously inconsistent. Change it with
// `/omp-glyphs`, or `--omp-glyphs <preset>` for a single run.
//
// Values are omp's own `tool.*`, `status.*`, `format.bullet` and `thinking.*`
// entries. Its status-line segment glyphs are not preset-dependent, so the ICON
// table above is shared by both.
// ═══════════════════════════════════════════════════════════════════════════

export type GlyphPreset = "nerd" | "unicode";

interface GlyphSet {
  /** omp `tool.*`. A tool with no entry here is one omp renders as a single row
   * rather than a block, which is what `framed` keys off.
   *
   * Tools from other extensions are named here too when they earn an identity —
   * `write_stdin` borrows the `ssh` glyph because both are the same idea, a
   * stream written to something already running, and the two never appear in
   * one transcript. */
  tool: Record<string, string>;
  status: { pending: string; running: string; error: string; bullet: string };
  /** omp `icon.folder`/`icon.package`/`icon.file` — the node markers of its
   * JSON document tree (objects, arrays, scalars). */
  node: { object: string; array: string; scalar: string };
  thinking: Record<string, string>;
}

const GLYPH_PRESETS: Record<GlyphPreset, GlyphSet> = {
  nerd: {
    tool: { bash: "\uebca", write: "\uea7f", edit: "\uea73", ssh: "\ueb3a", mcp: "\ueb2d", write_stdin: "\ueb3a" },
    // The bullet is a filled circle in the nerd preset, not the typographic
    // one \u2014 captured from omp's own `\u25cf Read` rows.
    status: { pending: "\uf254", running: "\uf110", error: "\uf00d", bullet: "\uf111" },
    node: { object: "\uf115", array: "\uf487", scalar: "\uf15b" },
    thinking: {
      minimal: "\u{f0a9e} min",
      low: "\u{f0a9f} low",
      medium: "\u{f0aa1} med",
      high: "\u{f0aa3} high",
      xhigh: "\u{f0aa5} xhi",
      max: "\u{f06d} max",
    },
  },
  unicode: {
    tool: { bash: "\u276f", write: "\u270e", edit: "\u270e", ssh: "\u21c4", mcp: "\u{1f50c}", write_stdin: "\u21c4" },
    status: { pending: "\u23f3", running: "\u27f3", error: "\u2718", bullet: "\u2022" },
    node: { object: "\u{1f4c1}", array: "\u{1f4e6}", scalar: "\u{1f4c4}" },
    thinking: {
      minimal: "\u25cb min",
      low: "\u25d4 low",
      medium: "\u25d1 med",
      high: "\u25d2 high",
      xhigh: "\u25d5 xhigh",
      max: "\u25c9 max",
    },
  },
};

const DEFAULT_GLYPH_PRESET: GlyphPreset = "nerd";
let glyphPreset: GlyphPreset = DEFAULT_GLYPH_PRESET;

function glyphs(): GlyphSet {
  return GLYPH_PRESETS[glyphPreset];
}

function isGlyphPreset(value: unknown): value is GlyphPreset {
  return value === "nerd" || value === "unicode";
}

const SETTINGS_FILE_NAME = "pi-omp-feel.json";

/** omp hangs a few lines of the file under a read only when its own
 * `read.toolResultPreview` is turned on, and that setting ships off — a read
 * is a summary row by default. Same here, same default; set `readPreview` in
 * the settings file beside the glyph preset to turn it on. */
let readPreviewEnabled = false;

/** Whether the working line says something other than "Working…". Off by
 * default: the words are a joke, and a joke belongs to whoever asked for it.
 * `/omp-feel words on`. */
let spinnerWordsEnabled = false;

/** How the next word is chosen. `category` keeps to one theme and works
 * through it, so a session reads as a run of jokes rather than a shuffle;
 * `random` takes any word from any theme. `/omp-feel cycle …`. */
type SpinnerCycle = "category" | "random";
let spinnerCycle: SpinnerCycle = "category";

/** Whatever else the settings file held. Rewriting only the keys this version
 * knows would drop a key a later one added, or one written by hand. */
let storedSettings: Record<string, unknown> = {};

function isSpinnerCycle(value: unknown): value is SpinnerCycle {
  return value === "category" || value === "random";
}

/** Remember the chosen settings across sessions. pi has no per-extension
 * store, so keep a small file of our own beside the degrade report. */
function loadSettings(): void {
  try {
    const path = join(getAgentDir(), SETTINGS_FILE_NAME);
    if (!existsSync(path)) return;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      storedSettings = {};
      return;
    }
    storedSettings = parsed as Record<string, unknown>;
    const stored = storedSettings as {
      glyphs?: unknown;
      readPreview?: unknown;
      spinnerWords?: unknown;
      spinnerCycle?: unknown;
    };
    if (isGlyphPreset(stored.glyphs)) glyphPreset = stored.glyphs;
    if (typeof stored.readPreview === "boolean") readPreviewEnabled = stored.readPreview;
    if (typeof stored.spinnerWords === "boolean") spinnerWordsEnabled = stored.spinnerWords;
    if (isSpinnerCycle(stored.spinnerCycle)) spinnerCycle = stored.spinnerCycle;
  } catch {
    // An unreadable or malformed settings file must not stop the extension
    // loading; the default preset applies instead.
  }
}

function saveSettings(): void {
  try {
    mkdirSync(getAgentDir(), { recursive: true });
    writeFileSync(
      join(getAgentDir(), SETTINGS_FILE_NAME),
      `${JSON.stringify(
        {
          ...storedSettings,
          glyphs: glyphPreset,
          readPreview: readPreviewEnabled,
          spinnerWords: spinnerWordsEnabled,
          spinnerCycle,
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // Persisting is best effort — the choice still holds for this session.
  }
}

function applyGlyphPreset(preset: GlyphPreset): void {
  if (glyphPreset === preset) return;
  glyphPreset = preset;
  saveSettings();
  // Framed tool blocks fold the preset into their memo key, so they refresh
  // themselves. The status bar and the editor's top border need telling.
  activeFooter?.invalidate();
  activeTui?.requestRender();
}



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

/** Text split the way a terminal groups it, rather than by code point. A flag,
 * a skin tone and a ZWJ family are each several code points that draw as one
 * cell group, and opening a colour between two of them makes the terminal draw
 * the parts instead: two regional indicators where there was one flag, twice
 * the cells. `visibleWidth` segments the same way, which is why measuring the
 * result cannot detect the damage — the only defence is not to split them. */
const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

function graphemeCells(text: string): string[] {
  if (!graphemeSegmenter) return [...text];
  return [...graphemeSegmenter.segment(text)].map(part => part.segment);
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
      text += `${ICON.dot}${glyphs().thinking[level] ?? level}`;
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

/** omp's `subagentsSegment`: an icon and a count, hidden when nothing is
 * running. */
function agentsSegment(): Segment {
  const count = activeAgentCount();
  if (count <= 0) return { content: "", visible: false };
  return { content: `${fgAnsi(HEX.lavender)}${glyphs().status.bullet} ${count}${FG_RESET}`, visible: true };
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
        agentsSegment(),
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

// The band sweeps the label *and* the Esc hint as one strip. omp drives it by
// time rather than by frame — `SHIMMER_SPEED_CELLS_PER_S` in its `shimmer.ts`,
// redrawn at 30fps, with the spinner glyph on its own 80 ms clock — so its band
// crosses a cell in 33 ms where a frame-per-cell list at pi's 80 ms cadence
// took 80. That was the whole of the difference in feel: the colours and the
// band's shape already matched (verified against omp's own animation frames —
// dim outside, overlay1 approaching, accent at the crest, lavender over the
// hint).
//
// pi's Loader cycles a fixed list at a fixed interval, so the time-driven
// sweep is baked instead: the list runs at `WORKING_FRAME_MS`, the band
// advances by a fraction of a cell per frame to hold omp's speed, and the
// spinner advances every other frame to hold its own.
const SHIMMER_SPEED_CELLS_PER_S = 30;
const WORKING_FRAME_MS = 40;
// The band's step as an exact fraction of a cell, reduced from the constants
// above rather than assumed. The frame count below divides by the denominator,
// so a step that is not a whole fraction would close the loop mid-sweep — and
// a rounded one would hide that rather than show it.
const SHIMMER_STEP_DIVISOR = greatestCommonDivisor(SHIMMER_SPEED_CELLS_PER_S * WORKING_FRAME_MS, 1000);
const SHIMMER_STEP_NUMERATOR = (SHIMMER_SPEED_CELLS_PER_S * WORKING_FRAME_MS) / SHIMMER_STEP_DIVISOR;
const SHIMMER_STEP_DENOMINATOR = 1000 / SHIMMER_STEP_DIVISOR;
const SHIMMER_CELLS_PER_FRAME = SHIMMER_STEP_NUMERATOR / SHIMMER_STEP_DENOMINATOR;
// Whole frames per glyph by construction, so the spinner cannot fall between
// two of them; omp's 80 ms is what this pair comes to.
const SPINNER_FRAMES_PER_GLYPH = 2;
const SPINNER_ADVANCE_MS = WORKING_FRAME_MS * SPINNER_FRAMES_PER_GLYPH;
/** omp's `CLASSIC_PADDING`: cells of dark either side of the strip, which is
 * the pause between sweeps. omp animates by clock and can hold this at ten;
 * a baked list has to close on a whole number of both cycles, and the period
 * decides how many frames that takes — 82 cells needs 820 frames where 96
 * needs 80. So the gap is chosen per label from a range either side of omp's
 * ten, which is imperceptible to look at and the difference between a list of
 * a few hundred kilobytes and one of several megabytes. */
const SHIMMER_PADDING_PREFERRED = 10;
const SHIMMER_PADDING_MIN = 8;
const SHIMMER_PADDING_MAX = 20;
/** omp's `CLASSIC_BAND_HALF_WIDTH` and its two intensity thresholds. */
const SHIMMER_BAND_HALF_WIDTH = 6;
const SHIMMER_TIER_HIGH = 0.65;
const SHIMMER_TIER_MID = 0.22;

/** omp does not always say "Working…" — it names what it is waiting on, and the
 * shimmer sweeps whatever that says. pi keeps its label in a slot the frames
 * cannot see (`Loader` renders `frames + message`), so an extension that sets a
 * working message here would have it appended after ours rather than replacing
 * it. `ACTIVITY_CHANNEL` is how another extension hands its label over instead;
 * see the README. Empty or absent restores "Working…". */
export const ACTIVITY_CHANNEL = "ui:activity";
let activityLabel: string | undefined;

function workingLabel(): string {
  return activityLabel ?? spinnerWord ?? OMP_WORKING_TEXT;
}

// ───────────────────────────────────────────────────────────────────────────
// Spinner words
//
// omp says "Working…" and means it. These say something sillier, one word per
// turn, and the shimmer sweeps whatever they say. Off unless asked for.
// ───────────────────────────────────────────────────────────────────────────

/** The word this turn is working under, if any. */
let spinnerWord: string | undefined;
/** The theme `category` cycling is working through, and what is left of it. */
let spinnerQueue: string[] = [];
let spinnerQueueCategory: string | undefined;

const SPINNER_CATEGORY_NAMES = Object.keys(SPINNER_CATEGORIES);
/** Every word once, so `random` is uniform over words rather than over themes
 * — themes run from seven words to forty-five, which made a chemistry word six
 * times likelier than a spacefaring one. */
const SPINNER_ALL_WORDS = SPINNER_CATEGORY_NAMES.flatMap(name => [...(SPINNER_CATEGORIES[name] ?? [])]);
/** The word showing, so the next draw can avoid repeating it. */
let spinnerLastWord: string | undefined;

/** How wide a word the working line will carry. The Loader wraps rather than
 * overflows, and a wrapped line pushes the editor down a row, so the longer
 * phrases are elided to fit beside the spinner and the hint. */
function workingLabelMaxWidth(): number {
  const columns = process.stdout.columns || 80;
  return Math.max(12, Math.min(56, columns - (2 + 1 + visibleWidth(OMP_WORKING_HINT) + 4)));
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The next word, by whichever rule is set. A theme is worked through in a
 * shuffled order and only swapped once exhausted, so consecutive turns stay in
 * the same joke without repeating inside it. */
function nextSpinnerWord(): string | undefined {
  if (SPINNER_CATEGORY_NAMES.length === 0) return undefined;
  if (spinnerCycle === "random") {
    if (SPINNER_ALL_WORDS.length === 0) return undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const word = SPINNER_ALL_WORDS[Math.floor(Math.random() * SPINNER_ALL_WORDS.length)];
      if (word !== spinnerLastWord || SPINNER_ALL_WORDS.length === 1) return word;
    }
    return SPINNER_ALL_WORDS[Math.floor(Math.random() * SPINNER_ALL_WORDS.length)];
  }
  if (spinnerQueue.length === 0) {
    const candidates =
      SPINNER_CATEGORY_NAMES.length > 1
        ? SPINNER_CATEGORY_NAMES.filter(name => name !== spinnerQueueCategory)
        : SPINNER_CATEGORY_NAMES;
    spinnerQueueCategory = candidates[Math.floor(Math.random() * candidates.length)];
    spinnerQueue = shuffled(SPINNER_CATEGORIES[spinnerQueueCategory] ?? []);
  }
  return spinnerQueue.pop();
}

/** Dress a word the way "Working…" is dressed — an ellipsis, unless the word
 * already ends in punctuation, which today means only one the clip shortened
 * and finished with an ellipsis of its own. */
function decorateSpinnerWord(word: string): string {
  const clipped = clipPlain(sanitizeStatusText(word), workingLabelMaxWidth());
  return /[.!?…:]$/.test(clipped) ? clipped : `${clipped}…`;
}

/** Choose the next word. */
function refreshSpinnerWord(): void {
  if (!spinnerWordsEnabled) {
    spinnerWord = undefined;
    return;
  }
  const word = nextSpinnerWord();
  spinnerLastWord = word;
  spinnerWord = word === undefined ? undefined : decorateSpinnerWord(word);
}

/** How long a word stays up while the agent works. */
const SPINNER_WORD_INTERVAL_MS = 5000;
let spinnerRotation: ReturnType<typeof setInterval> | undefined;
/** Whether there is work to watch. Nothing rotates against an idle prompt. */
let agentWorking = false;

function stopSpinnerRotation(): void {
  if (spinnerRotation === undefined) return;
  clearInterval(spinnerRotation);
  spinnerRotation = undefined;
}

/** Change the word every few seconds for as long as there is work to watch.
 *
 * Handing pi a new indicator restarts its loader — the spinner glyph returns
 * to the first braille frame and the band re-enters from the left — which is
 * why this is not faster: at a few seconds the reset reads as a new label
 * arriving, and the word beside it has changed to say so. */
function startSpinnerRotation(): void {
  stopSpinnerRotation();
  if (!spinnerWordsEnabled || !agentWorking) return;
  if (currentCtx?.mode !== "tui" || !currentCtx.hasUI) return;
  spinnerRotation = setInterval(() => {
    if (!spinnerWordsEnabled || !agentWorking || currentCtx?.mode !== "tui" || !currentCtx.hasUI) {
      stopSpinnerRotation();
      return;
    }
    refreshSpinnerWord();
    configureWorkingIndicator(currentCtx);
    activeTui?.requestRender();
  }, SPINNER_WORD_INTERVAL_MS);
  // A pending word must never be the reason a process stays up.
  spinnerRotation.unref?.();
}

/** Cells the band travels across: the label, the joining space, and the hint —
 * rounded up to an even count. The gap either side is always even, so an odd
 * strip forces an odd period, and odd periods are exactly the ones whose lists
 * run long (a 31-cell strip needs 340 frames where 32 needs 40). The extra
 * cell is never drawn; it only lets the band travel over an even period. */
function shimmerCells(label: string): number {
  // Columns, not clusters: the period the band travels has to match the width
  // the strip actually occupies, or a wide cluster would leave the band short of
  // the end. Identical for one-column clusters, which is every label today.
  const strip = visibleWidth(label) + 1 + visibleWidth(OMP_WORKING_HINT);
  return strip % 2 === 0 ? strip : strip + 1;
}

/** Frames a list must hold for a band of this period to close cleanly. */
function shimmerFrameCountFor(period: number): number {
  const periodUnits = period * SHIMMER_STEP_DENOMINATOR;
  const bandFrames = periodUnits / greatestCommonDivisor(SHIMMER_STEP_NUMERATOR, periodUnits);
  return leastCommonMultiple(OMP_WORKING_FRAMES.length * SPINNER_FRAMES_PER_GLYPH, bandFrames);
}

// The padding depends only on the label's width, and every frame of every
// build asks for it.
const shimmerPaddingCache = new Map<number, number>();

/** Frames a label may cost before its gap is allowed to drift from omp's. */
const SHIMMER_FRAME_BUDGET = 200;

/** The gap nearest omp's ten whose list fits the budget — not the shortest
 * list going. Minimising outright put the default label on seventeen, which
 * is a 1.6-second sweep where omp's ten gives 1.13: a fifth of a second is
 * nothing to store and everything to look at, on the one label every session
 * shows. Within the budget the gap holds omp's ten for every word in the list
 * and for `Working…`; a label of some other length can pull it two. */
function shimmerPadding(cells: number): number {
  const cached = shimmerPaddingCache.get(cells);
  if (cached !== undefined) return cached;
  let best: number | undefined;
  let smallest = SHIMMER_PADDING_PREFERRED;
  let smallestFrames = Number.POSITIVE_INFINITY;
  for (let padding = SHIMMER_PADDING_MIN; padding <= SHIMMER_PADDING_MAX; padding++) {
    const frames = shimmerFrameCountFor(cells + 2 * padding);
    if (frames < smallestFrames) {
      smallest = padding;
      smallestFrames = frames;
    }
    if (frames > SHIMMER_FRAME_BUDGET) continue;
    const closer =
      best === undefined ||
      Math.abs(padding - SHIMMER_PADDING_PREFERRED) < Math.abs(best - SHIMMER_PADDING_PREFERRED);
    if (closer) best = padding;
  }
  // Nothing within budget: take the shortest list there is.
  const chosen = best ?? smallest;
  shimmerPaddingCache.set(cells, chosen);
  return chosen;
}

/** One full cycle in cells: the strip plus the dark padding either side. */
function shimmerPeriod(label: string): number {
  const cells = shimmerCells(label);
  return cells + 2 * shimmerPadding(cells);
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

function leastCommonMultiple(a: number, b: number): number {
  return (a * b) / greatestCommonDivisor(a, b);
}

// Pi cycles the supplied frames verbatim, so the list has to span a whole number
// of both the spinner and the shimmer cycle. A shorter list wraps one of them
// mid-cycle: at 16 frames the 10-glyph spinner jumped five positions on every
// wrap, roughly once a second.
//
// The band no longer moves a whole cell per frame, so its cycle is counted in
// fifths of a cell (`SHIMMER_CELLS_PER_FRAME` is 6/5 at these constants): the
// list closes on the first frame where a whole number of periods has passed.
function workingFrameCount(label: string): number {
  return shimmerFrameCountFor(shimmerPeriod(label));
}

function workingAccent(ctx: ExtensionContext): string {
  const sessionName = currentSessionName(ctx);
  return sessionName ? sessionAccentHex(sessionName) : HEX.peach;
}

/** omp's `classicIntensity`: a cosine bump, zero outside the band's half-width. */
function shimmerIntensity(distance: number): number {
  if (distance >= SHIMMER_BAND_HALF_WIDTH) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * distance) / SHIMMER_BAND_HALF_WIDTH));
}

function workingMessage(label: string, accent: string, frame: number): string {
  // Split the way a terminal groups cells, not by code point: colouring the
  // halves of one cluster separately makes the terminal draw them separately.
  // Our own labels are plain words today, so this changes nothing about the
  // frames — it keeps the path honest if one ever is not.
  const labelCells = graphemeCells(label);
  const cells = [...labelCells, " ", ...graphemeCells(OMP_WORKING_HINT)];
  // The band's own position, un-floored as omp leaves it, so a fractional step
  // reads as smooth movement rather than a stutter every few frames.
  // Sized on the even count the period uses, though only the real cells are
  // drawn — a trailing pad cell is one column wide and wraps the line.
  const padding = shimmerPadding(shimmerCells(label));
  const position = (frame * SHIMMER_CELLS_PER_FRAME) % shimmerPeriod(label);

  // Stepped by the columns a cluster occupies, not by how many clusters have
  // gone by, so the band sits where it is drawn rather than where it was
  // counted. The two agree for anything one column wide, which is every label
  // in the list today; `shimmerRun` positions its band the same way.
  let cell = 0;
  return cells
    .map((character, index) => {
      const distance = Math.abs(cell + padding - position);
      cell += visibleWidth(character);
      const intensity = shimmerIntensity(distance);
      // The hint peaks lavender; the label peaks in the session accent.
      const peak = index > labelCells.length ? HEX.lavender : accent;
      const color =
        intensity >= SHIMMER_TIER_HIGH ? peak : intensity >= SHIMMER_TIER_MID ? HEX.overlay1 : HEX.overlay0;
      // omp bolds the whole crest, not just its centre cell.
      const bold = intensity >= SHIMMER_TIER_HIGH ? "\x1b[1m" : "";
      const boldReset = intensity >= SHIMMER_TIER_HIGH ? "\x1b[22m" : "";
      return `${bold}${fgAnsi(color)}${character}${FG_RESET}${boldReset}`;
    })
    .join("");
}

// The frames depend on nothing but the accent, while `configureWorkingIndicator`
// runs on every `agent_start`. Rebuilding all 70 every turn threw away ~14 KB per
// turn for an identical result, so keep the last set.
let cachedWorkingFrames: { label: string; accent: string; frames: string[] } | undefined;

function workingFrames(label: string, accent: string): string[] {
  if (cachedWorkingFrames?.accent === accent && cachedWorkingFrames.label === label) {
    return cachedWorkingFrames.frames;
  }
  // Pi treats supplied frames as verbatim. Include the message in each frame so
  // the Loader's own 80 ms animation advances the shimmer reliably rather than
  // relying on a second timer that can be replaced by core status events.
  const frames = Array.from({ length: workingFrameCount(label) }, (_, index) => {
    const spinner = OMP_WORKING_FRAMES[Math.floor(index / SPINNER_FRAMES_PER_GLYPH) % OMP_WORKING_FRAMES.length];
    return `${fgAnsi(accent)}${spinner}${FG_RESET} ${workingMessage(label, accent, index)}`;
  });
  cachedWorkingFrames = { label, accent, frames };
  return frames;
}

function configureWorkingIndicator(ctx: ExtensionContext): void {
  ctx.ui.setWorkingIndicator({
    frames: workingFrames(workingLabel(), workingAccent(ctx)),
    intervalMs: WORKING_FRAME_MS,
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

type DegradedSubsystem = "tool-framing" | "prompt-framing" | "widget-animation";

const DEGRADED_LABEL: Record<DegradedSubsystem, string> = {
  "tool-framing": "tool-call framing",
  "prompt-framing": "prompt framing",
  "widget-animation": "widget animation",
};

// What each subsystem assumes about pi's internals. A failure means one of these
// stopped holding, so listing them in the report turns "something threw" into a
// checklist someone (or an agent) can work through against the installed pi.
const DEGRADED_ASSUMPTIONS: Record<DegradedSubsystem, string[]> = {
  "tool-framing": [
    "`ToolExecutionComponent.prototype.render` can be patched, because the extension loader resolves `@earendil-works/pi-coding-agent` to the same module instance pi core imports.",
    "Instance members read: `hideComponent`, `hasRendererDefinition()`, `getCallRenderer()`, `getResultRenderer()`, `getRenderShell()`, `contentBox.render()`, `contentBox.bgFn()`, `contentText.render()`, `selfRenderContainer.render()`, `callRendererComponent`, `resultRendererComponent`, `args`, `imageComponents`, `imageSpacers`, `isPartial`, `executionStarted`, `expanded`, `result.isError`, `result.content`, `toolName`.",
    "`hasRendererDefinition()` is definition presence; `getCallRenderer()`/`getResultRenderer()` returning undefined despite a definition is what a registered tool without renderers looks like — the population that gets the document view. `toolDefinition.label` is that tool's self-declared name, used as its header.",
    "`expanded` is the component's Ctrl+O toggle, `false` while collapsed; `result.content` is the tool result's block list, whose `text` blocks carry the output the collapsed previews rebuild from; `result.details.fullOutputPath` names bash's persisted-output file, mirrored when stripping its footer.",
    "pi's diff rows parse as `([+-\\s])(\\s*\\d+) content` (see `parseDiffLine` in pi's `diff.ts`), each wrapped whole in one `toolDiff*` foreground; hunk gaps render as digitless `...` rows. Tabs are flattened to spaces before rendering, so indentation glyphs can only ever be `·`.",
    "pi's collapsed bash output is a visual-line tail whose window row (`... (N earlier lines, … to expand)`) renders first, with every output row — wrapped continuations included — opening with the same `toolOutput` foreground, and the warning/timing rows that follow opening with their own (see `rebuildBashResultRenderComponent`; `fullOutputPath` in `result.details` names the footer to strip).",
    "`edit` declares `renderShell: \"self\"` and builds its own shell as a background-tinted `Box`, so `selfRenderContainer` yields rows this can frame (see `frameSelfRendered`). Its diff rows are `+123 `/`-123 `/` 123 `-prefixed, which is what the `⟨+N/-M⟩` badge counts.",
    "`contentBox` is a pi-tui `Box` with paddingX 1, so it renders children at `width - 2`. The section path (see `TOOL_PROFILES`) therefore skips it entirely (rendering those same children only at `width - 4`) and takes the background tint from `contentBox.bgFn(\"\")` instead — rendering both would thrash the children's single-width caches.",
    "A `Box` emits its `paddingY` blank rows above and below its children as a group, never between them. A tool whose result renderer opens straight onto content therefore leaves no blank row marking where its call row ended, so the call is found by matching the text a profile's `contentPath`/`target` predicts rather than by looking for the gap — and a tool with no profile keeps its call row in the body instead of being cut in the wrong place.",
    "Rows from a background-tinted `Box` start with an SGR background sequence and end with `ESC[49m` (see `addSideBorders`).",
    "`theme.bg()` returns `<bg-ansi><text>ESC[49m`, so an empty probe yields the same background prefix as a rendered row.",
  ],
  "widget-animation": [
    "`InteractiveMode.prototype.setExtensionWidget` can be patched, on the same module-instance aliasing the tool-frame patch relies on. A widget passed as a string array is left to pi; only the component-factory form is wrapped.",
    "That factory is called `(tui, theme)` with pi's own `TUI` as the first argument, so `requestRender()` is reachable through it. The component it returns is rendered by pi on every frame, and its `render` can be replaced in place — the object itself is handed back untouched, since the owning extension may have put anything else on it.",
    "Only widgets whose key is in `ANIMATED_WIDGET_KEYS` are touched at all — the shape of a live row cannot be told from a braille chart by any rule about its characters, so recognition is by key. Within one of those, a live row is indentation or tree drawing, then one of `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, then a space, then its label, then ` · ` before the statistics. A row shaped any other way is returned exactly as it arrived.",
    "Widget rows arrive padded to the width they were rendered at, so a decoration must preserve a row's visible width exactly; any replacement that would not is declined rather than emitted. `visibleWidth` cannot see a grapheme cluster split between two colours — it segments the same way — so the band moves a cluster at a time instead of relying on that check.",
    "pi renders every mounted widget within a single frame, and `clearExtensionWidgets` empties its widget maps without going through `setExtensionWidget`. The animation clock is therefore driven by when a live row was last drawn rather than by the last render's outcome, so neither a quiet widget beside a live one nor an unannounced unmount can leave it stuck on or off. For the same reason the agent count is cleared at both session boundaries, where that unannounced clearing lands.",
    "At most one widget row says how many agents are running, and it says it in prose (`WIDGET_AGENT_COUNT`). Only a match writes the count, so rows that stop carrying the wording — an expanded roster, or wording that changed — hold the last number rather than clearing it. The number can therefore lag the truth in either direction for as long as the widget goes without saying it, and the segment disappears entirely whenever the widget does; what it can never do is invent a count from row shapes. The scan runs over every animated widget, so were a second one to carry the same wording, the count would be whatever rendered last, and two disagreeing widgets would each write and invalidate every frame — pi coalesces the duplicate render requests, but the frame it schedules re-arms the next one, so that is a sustained loop rather than cache churn. Telling them apart would need name-keyed knowledge of a foreign widget's text beyond the key allowlist, which costs more than the case is worth.",
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
    // omp leaves the frame dim until it has a session accent to colour it with,
    // rather than tinting it by thinking level — the level is already spelled out
    // in the status bar a few cells away.
    const color = sessionName ? sessionAccentHex(sessionName) : HEX.overlay0;
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

/** Border one body row. `addSideBorders` needs a background-tinted row and
 * hands anything else back unchanged; a self-rendered tool can produce a bare
 * `Text` row alongside its tinted ones — pi's `edit` does exactly that for an
 * error — and an unbordered row in the middle of a frame reads as a hole. Those
 * have no tint to preserve, so pad and border them directly. */
function frameBodyRow(line: string, width: number, borderColor: string, barBg: string): string {
  const bordered = addSideBorders(line, borderColor);
  return bordered === line ? renderFrameContentRow(line, width, borderColor, barBg) : bordered;
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

// ───────────────────────────────────────────────────────────────────────────
// Tool profiles
//
// omp's transcript has three shapes: a headerless block that leads with the
// command (bash), a block with a `glyph Title` header, and a single row. pi's
// own tools map onto them by name, but so must tools that arrive from another
// extension — `pi-runbg`'s `exec_command` is a shell command in every respect
// except that nothing in pi says so.
//
// A profile is where a tool declares which shape it takes. Tools without one
// still land somewhere sensible (a titled block, or a single row when there is
// only one), so this table is for tools that deserve better than the default,
// not a registry every tool has to appear in. The extensions being described do
// not know this file exists, and should not have to.
// ───────────────────────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

/** A rendered row beside its stripped text, so profiles can match on the text
 * without every one of them re-stripping the same rows. */
interface StrippedRow {
  line: string;
  plain: string;
}

interface ToolProfile {
  /** Lead with the command instead of a header, as omp's bash block does. */
  headerless?: boolean;
  /** Header label, when the derived one is wrong. */
  title?: string;
  /** omp gives this tool no identity glyph, so do not fall back to the generic
   * one — that invents an identity omp withholds. Only affects the settled
   * header; a pending or failed block still shows its status glyph. */
  iconless?: boolean;
  /** Frame this tool even though it declares `renderShell: "self"`.
   *
   * Opt-in per tool, never blanket: a tool that draws its own shell may already
   * be drawing a frame, and wrapping that in a second one is worse than leaving
   * it alone. pi's `edit` is the one built-in that qualifies — what it calls a
   * shell is a background-tinted `Box`, the same shape every other block here
   * is built from. */
  frameSelfRendered?: boolean;
  /** Suffix for the framed header — omp's `· 4 lines` on a write, `⟨+1/-1⟩` on
   * an edit. Returns its own colouring, because omp does not use one colour for
   * all of it. `body` is the block's own rows, stripped, and is only computed if
   * a profile actually asks for it. */
  summary?(args: ToolArgs, body: () => readonly StrippedRow[]): string | undefined;
  /** Draw the call and the result as omp's two sections divided by `Output`,
   * rather than one padded box. Needs both renderer components, so it is
   * ignored for a tool that has none (see `sections` in the patch). */
  sections?: boolean;
  /** The shell command behind this call, so the call row can be re-rendered in
   * omp's dim-`$`, syntax-highlighted style instead of however the tool wrote
   * it. */
  command?(args: ToolArgs): string | undefined;
  /** Where the file this tool touches lives in `args`, so rows showing that
   * file can be highlighted in its language the way omp does, and so the
   * header can name it even when pi wrapped its call row. */
  contentPath?(args: ToolArgs): string | undefined;
  /** What this call names, when the thing it names is not a file — the agent a
   * delegating tool is about to run, say. Hoisted into the header exactly as a
   * path is, but it carries no file glyph and says nothing about a language.
   *
   * Spelling it out matters most for a tool whose renderer writes its content
   * straight under its call row: pi's `Box` puts no blank row between a call
   * component and a result one, so without a target to match, the walk below
   * reads the whole block as one unbroken call, declines to hoist, and leaves
   * the call repeating itself as the body's first row. Ignored when
   * `contentPath` already answers. */
  target?(args: ToolArgs): string | undefined;
  /** What pi writes after that path on the call row — a line range — kept
   * beside the target when the header is rebuilt from `args`. */
  targetSuffix?(args: ToolArgs): string | undefined;
  /** Where the content this tool writes lives in `args`. A tool that says so
   * has its body rebuilt as omp's write preview — dim line-number gutter, a
   * live tail while streaming, the first lines once settled — instead of
   * keeping pi's head-10 window. */
  content?(args: ToolArgs): string | undefined;
  /** Readable output in this tool's result. A one-line tool that says so gets
   * omp's collapsed content cell under its row — the first lines, gutted and
   * highlighted, closed with `… N more lines` — where pi shows nothing. */
  resultText?(result: unknown): string | undefined;
  /** The command output in this tool's result, so a collapsed sections block
   * can re-tail it at omp's depth (10 lines) instead of pi's five. A tool
   * that draws its own collapsed output window must not set this — the
   * window's depth is that tool's setting. */
  output?(result: unknown): string | undefined;
  /** First line number of that output, for the preview gutter (read's `offset`). */
  startLine?(args: ToolArgs): number;
  /** Call-side detail for the dim `(a · b)` suffix that follows a command.
   * Built from `args` rather than parsed back out of the row being replaced, so
   * rewriting the row cannot silently drop something the tool wanted shown. */
  detail?(args: ToolArgs): (string | false | undefined)[];
  /** Rewrite whichever result rows carry timing into omp's `⟨Wall: …⟩` badge.
   * Only consulted on the section layout, where call and result rows are kept
   * apart and a result row can be identified as one. */
  wall?(rows: readonly StrippedRow[], args: ToolArgs): readonly string[];
}

/** A `Map`, not an object literal: tool names come from whatever extensions are
 * installed, and `TOOL_PROFILES["constructor"]` would otherwise find something. */
const TOOL_PROFILES = new Map<string, ToolProfile>([
  [
    "bash",
    {
      headerless: true,
      sections: true,
      command: args => (typeof args.command === "string" ? args.command : undefined),
      wall: bashWall,
      output: toolResultText,
    },
  ],
  // pi-runbg. `exec_command` is a shell command that happens to survive the
  // call, so it gets exactly what omp gives bash — no header, the command
  // first, output below a divider. What omp has no vocabulary for (the session
  // it leaves behind, the log it writes) stays in runbg's own status row.
  [
    "exec_command",
    {
      headerless: true,
      sections: true,
      command: args => (typeof args.cmd === "string" ? args.cmd : undefined),
      detail: args => [
        // The session cwd is already in the status bar and omp does not repeat
        // it on a bash block, so name a directory only when this call overrode it.
        typeof args.workdir === "string" && args.workdir.length > 0 && `cwd: ${shortenPath(args.workdir)}`,
        args.tty === true && "tty",
        args.on_exit === "wake" && "wake",
      ],
      wall: runbgWall,
    },
  ],
  // Keystrokes into a live session are not a command, so this one keeps a
  // header — but its output is still output, and belongs under a divider.
  ["write_stdin", { sections: true, wall: runbgWall }],
  [
    "write",
    {
      summary: writeLineSummary,
      contentPath: pathFromArgs,
      content: args => (typeof args.content === "string" ? args.content : undefined),
    },
  ],
  [
    "edit",
    {
      frameSelfRendered: true,
      summary: editDiffSummary,
      contentPath: pathFromArgs,
    },
  ],
  // pi renders a collapsed read as its call row alone; omp's read entries hang
  // a three-line cell of the file under the summary row.
  [
    "read",
    {
      contentPath: pathFromArgs,
      // pi's `formatReadLineRange`: `:12`, or `:12-40` when a limit is set.
      targetSuffix: args => {
        const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.floor(args.offset) : undefined;
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined;
        if (offset === undefined && limit === undefined) return undefined;
        const start = offset ?? 1;
        return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
      },
      resultText: result => toolResultText(result)?.replace(READ_NOTICE_TAIL, ""),
      startLine: args => {
        const offset = args.offset;
        return typeof offset === "number" && Number.isFinite(offset) && offset >= 1 ? Math.floor(offset) : 1;
      },
    },
  ],
  // pi-ask. One question puts itself in the header via the usual target hoist;
  // several need saying, since only the first would otherwise be visible.
  ["ask", { iconless: true, summary: askQuestionSummary }],
  // pi-subagents. A delegated agent, whose renderer writes its status rows
  // directly under its call row with no blank line between them — so the walk
  // is told what the call says, or the header names nothing and the body opens
  // by repeating the call it was hoisted from.
  ["subagent", { target: delegatedAgentTarget, targetSuffix: delegatedAgentSuffix }],
]);

/** An `args` field worth reading: present, a string, and not blank — flattened
 * the same way a target read off a rendered row is. An agent name is chosen by
 * whoever wrote the agent, and a newline in one would otherwise reach a header
 * bar that measures it as one row and draws it as two. */
function argText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const flattened = sanitizeStatusText(escapeControlChars(stripAnsi(value)));
  return flattened.length > 0 ? flattened : undefined;
}

/** How that tool spells its own call row: a management call as `<action>
 * <target>`, a plain launch as `<agent>`. A workflow launch it spells from a
 * manifest that cannot be rebuilt from `args` alone, so that one is left
 * unclaimed and keeps pi's row — an unhoisted call is a repeated word, while a
 * wrong claim would cut the block in the wrong place. */
function delegatedAgentTarget(args: ToolArgs): string | undefined {
  const action = argText(args.action);
  // `chainName` names the target of a management call only. A launch is spelled
  // from `agent` alone, so consulting it there would predict a name the row
  // never carries — declining for the wrong reason rather than the right one.
  if (action) {
    const target = argText(args.agent) ?? argText(args.chainName);
    return target ? `${action} ${target}` : action;
  }
  if (argText(args.workflowScript)) return undefined;
  return argText(args.agent);
}

/** It marks a background launch `[async]` after the agent, and only there —
 * the same branch its own renderer adds it in. */
function delegatedAgentSuffix(args: ToolArgs): string {
  if (argText(args.action) || argText(args.workflowScript)) return "";
  return args.async === true ? " [async]" : "";
}

function askQuestionSummary(args: ToolArgs): string | undefined {
  const questions = args.questions;
  if (!Array.isArray(questions) || questions.length < 2) return undefined;
  return `${fgAnsi(HEX_TOOL.dim)}· ${questions.length} questions${FG_RESET}`;
}

/** omp closes a write header with `· 4 lines`, counting the file it wrote — the
 * trailing newline included, which is why a three-line file reads as four and
 * renders an empty fourth row. Splitting the content gives exactly that. */
function writeLineSummary(args: ToolArgs): string | undefined {
  if (typeof args.content !== "string") return undefined;
  const lines = args.content.split("\n").length;
  return `${fgAnsi(HEX_TOOL.dim)}· ${lines} ${lines === 1 ? "line" : "lines"}${FG_RESET}`;
}

/** pi's diff rows are `+123 content` / `-123 content` / ` 123 content`, so the
 * counts omp puts in its `⟨+1/-1⟩` badge can be read off the rows themselves.
 *
 * Counting the rendered rows rather than `result.details.diff` is deliberate:
 * pi renders a live preview of the diff before any result exists, and omp
 * badges that preview too. The cost is that a wrapped continuation row could in
 * principle start like a diff marker and be miscounted — a wrong number in a
 * badge, which is the cheapest thing here to be wrong about. */
const DIFF_ROW_PATTERN = /^([+-])\s*\d*\s/;

function editDiffSummary(_args: ToolArgs, body: () => readonly StrippedRow[]): string | undefined {
  let added = 0;
  let removed = 0;
  for (const row of body()) {
    const marker = DIFF_ROW_PATTERN.exec(row.plain);
    if (marker) {
      if (marker[1] === "+") added++;
      else removed++;
    }
  }
  if (added + removed === 0) return undefined;
  // Captured from omp: the brackets and the slash are dim, the counts carry the
  // colour of what they are.
  const dim = fgAnsi(HEX_TOOL.dim);
  return `${dim}⟨${fgAnsi(HEX.green)}+${added}${dim}/${fgAnsi(HEX.red)}-${removed}${dim}⟩${FG_RESET}`;
}

/** `exec_command` → `Exec command`. A tool from another extension is under no
 * obligation to have a one-word name, and omp titles its blocks in prose. */
function toolTitle(toolName: string): string {
  const override = TOOL_PROFILES.get(toolName)?.title;
  if (override !== undefined) return override;
  const spaced = toolName.replace(/[_-]+/g, " ");
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function asToolArgs(args: unknown): ToolArgs {
  return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as ToolArgs) : {};
}

/** pi's read appends a model-facing notice into the result text itself —
 * `[Showing lines X-Y of Z. Use offset=N to continue.]` or `[N more lines in
 * file. …]` (its read.js) — which is not file content and must be neither
 * counted nor previewed. Wording-matched to those two shapes; a mismatch
 * merely counts the notice as content again, which is cosmetic. */
const READ_NOTICE_TAIL = /\n\n\[(?:Showing lines \d|\d+ more lines in file)[^\n]*\]$/;

/** pi's file tools accept both spellings (`file_path ?? path`, see its
 * read/write/edit renderers); the same tool never sends both. */
function pathFromArgs(args: ToolArgs): string | undefined {
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.path === "string") return args.path;
  return undefined;
}

/** The language omp would highlight this tool's file rows in. */
function profileLanguage(profile: ToolProfile | undefined, args: unknown): string | undefined {
  const path = profile?.contentPath?.(asToolArgs(args));
  return path ? getLanguageFromPath(path) : undefined;
}

/** What pi's `<tool> <target>` call row says the tool acted on, so both the
 * one-line rows and the framed headers can name it without per-tool knowledge
 * of where the target lives in `args`. Empty unless the row really does lead
 * with this tool's name. */
function toolCallRowTarget(contentLine: string, toolName: string): string {
  const plain = sanitizeStatusText(stripAnsi(contentLine));
  const split = plain.indexOf(" ");
  const label = split === -1 ? plain : plain.slice(0, split);
  if (label.toLowerCase() !== toolName.toLowerCase()) return "";
  return split === -1 ? "" : plain.slice(split + 1);
}

/** omp renders tools it gives no identity glyph to — `read` and friends — as a
 * single row instead of a block: an uncoloured bullet, the label in `toolTitle`,
 * then the target in `accent`. Neither of omp's glyph presets defines a
 * `tool.read`/`tool.grep`/`tool.ls` entry, which is how it marks them out. */
function renderToolOneLine(target: string, title: string, width: number): string {
  // The head is not fixed-size: a tool's declared label can be as long as the
  // tool likes, so a budget that floors the target at one cell still emits a
  // row wider than the terminal — and pi kills the TUI over exactly that. The
  // whole row is fitted here, head included; nothing downstream truncates it.
  const lead = ` ${glyphs().status.bullet} `;
  const room = Math.max(0, width - visibleWidth(lead));
  const shownTitle = clipPlain(title, room);
  const head = `${lead}${fgAnsi(HEX.lavender)}${shownTitle}${FG_RESET}`;
  if (!target) return head;
  // One cell for the space that separates them.
  const left = room - visibleWidth(shownTitle) - 1;
  if (left <= 0) return head;
  // Elided from the middle, because the file name is the half worth keeping.
  return `${head} ${fgAnsi(HEX_TOOL.accent)}${clipMiddle(target, left)}${FG_RESET}`;
}

/** Where the call line ends, read off the rows rather than guessed from a
 * width. pi spells a call as `<tool> <shortened path>`, so the rows are
 * consumed until exactly that much text has been seen — which ends the call
 * on the row that completes the path, however the wrap fell. A run whose
 * text is not that call (a renderer that puts content straight under it, an
 * unrecognized shape) yields the single row pi's layout gave before wrapped
 * calls were understood at all, leaving everything else in the body where it
 * cannot be swallowed. What pi appends past the path is part of that text
 * too, so a line range that lands on its own row is still the call. */
function callRunEnd(
  rows: readonly string[],
  first: number,
  runEnd: number,
  toolName: string,
  path: string | undefined,
  suffix: string,
  exact = false,
): { end: number; matched: boolean } {
  // `matched` is the whole point of the walk: a call the code could not read
  // must not be renamed from `args`, or the header spells a target the rows
  // beneath it still spell too. Ending on the first row is not that signal —
  // a call that fits one row ends there having matched.
  //
  // `exact` is for text predicted from a profile's `target`. A prefix match is
  // safe for a path, where pi writes the row and the profile only has to spell
  // what pi spelled; it is not safe for a guess about another extension's
  // renderer, because whatever the guess failed to predict is trailing text on
  // a row about to be consumed — and consuming it deletes it from the display.
  // Requiring the whole row turns every wrong guess into a declined hoist.
  const gaveUp = { end: Math.min(runEnd, first + 1), matched: false };
  if (path === undefined) return gaveUp;
  // A path is folded the way pi spells one on a row. A target that is not a
  // path is whatever it is: folding a home prefix into it could only stop it
  // matching text that never had one.
  const want = `${toolName}${exact ? path : shortenPath(path)}${suffix}`.replace(/\s+/g, "");
  let seen = "";
  for (let i = first; i < runEnd; i++) {
    seen += stripAnsi(rows[i]).replace(/\s+/g, "");
    if (seen.length >= want.length) {
      const hit = exact ? seen === want : seen.startsWith(want);
      return hit ? { end: i + 1, matched: true } : gaveUp;
    }
    if (!want.startsWith(seen)) return gaveUp;
  }
  // The rows ran out with the prediction unfinished. For a path that is the
  // call ending exactly where it was expected to; for a guess it means the
  // guess was longer than the row, which is not a match.
  return exact ? gaveUp : { end: runEnd, matched: true };
}

/** A path the way omp shows one: relative to the directory the session is in,
 * or with the home prefix folded, rather than pi's absolute spelling. */
function displayToolPath(path: string): string {
  const cwd = currentCtx?.cwd;
  if (cwd && path.startsWith(`${cwd}${sep}`)) return path.slice(cwd.length + 1);
  return shortenPath(path);
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

// ───────────────────────────────────────────────────────────────────────────
// Shell command colouring
//
// omp tokenizes a command with syntect's shell grammar and colours nearly
// every word: the command and its bare arguments in `syntaxFunction`, flag
// dashes in `syntaxPunctuation` with their letters in `syntaxVariable`,
// pipes and separators in `syntaxKeyword`, quoted text in `syntaxString`.
// pi highlights with highlight.js, whose shell grammar marks only strings,
// comments and a handful of builtins, so a captured command row came back
// almost entirely uncoloured beside omp's. Nothing in a theme closes that —
// it is what the two tokenizers see — so the command row gets this instead:
// a small shell lexer that reproduces omp's assignment of colour to token,
// and nothing else. It runs on one line of text that the tool already told
// us is a shell command; anything it cannot classify stays a plain argument.
// ───────────────────────────────────────────────────────────────────────────

const SHELL_KEYWORDS = new Set([
  "for", "in", "do", "done", "if", "then", "else", "elif", "fi", "while", "until",
  "case", "esac", "select", "function", "return", "break", "continue", "local", "export",
]);

/** `|`, `||`, `&&`, `;`, `&`, and the redirection family. */
const SHELL_OPERATOR_LEAD = /[|;&<>]/;
/** Substitution and grouping brackets, which omp paints as punctuation and
 * which start a fresh command word inside. */
const SHELL_BRACKET = /[()]/;
const SHELL_SPACE = /\s/;
/** Anything that ends a word. */
const SHELL_WORD_BREAK = /[\s|;&<>()'"]/;
/** `NAME=value` — an assignment, not a command. */
const SHELL_ASSIGNMENT = /^([A-Za-z_]\w*)=/;

function highlightShellCommand(command: string): string {
  const fn = fgAnsi(HEX.blue);
  const punct = fgAnsi(HEX.overlay2);
  const variable = fgAnsi(HEX.text);
  const string = fgAnsi(HEX.green);
  const keyword = fgAnsi(HEX.mauve);
  const comment = fgAnsi(HEX.overlay0);
  const number = fgAnsi(HEX.peach);
  const paint = (color: string, text: string): string => (text ? `${color}${text}${FG_RESET}` : "");

  let out = "";
  let index = 0;

  while (index < command.length) {
    const char = command[index];

    if (SHELL_SPACE.test(char)) {
      out += char;
      index++;
      continue;
    }

    if (char === "#") {
      const end = command.indexOf("\n", index);
      const stop = end === -1 ? command.length : end;
      out += paint(comment, command.slice(index, stop));
      index = stop;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let end = index + 1;
      while (end < command.length && command[end] !== quote) {
        if (command[end] === "\\" && quote === '"') end++;
        end++;
      }
      const closed = end < command.length;
      const body = command.slice(index + 1, closed ? end : command.length);
      out += paint(punct, quote);
      // omp lets an expansion break the string colour, `$` punctuation and the
      // name beside it a variable, and leaves single quotes literal.
      if (quote === '"') {
        let rest = body;
        while (rest.length > 0) {
          const at = rest.search(/\$\{?\w/);
          if (at === -1) break;
          out += paint(string, rest.slice(0, at));
          const name = /^\$\{?\w+\}?/.exec(rest.slice(at))?.[0] ?? "$";
          out += paint(punct, name.slice(0, name.startsWith("${") ? 2 : 1));
          out += paint(variable, name.slice(name.startsWith("${") ? 2 : 1));
          rest = rest.slice(at + name.length);
        }
        out += paint(string, rest);
      } else {
        out += paint(string, body);
      }
      if (closed) out += paint(punct, quote);
      index = closed ? end + 1 : command.length;
      continue;
    }

    if (SHELL_BRACKET.test(char)) {
      let end = index;
      while (end < command.length && SHELL_BRACKET.test(command[end])) end++;
      out += paint(punct, command.slice(index, end));
      index = end;
      continue;
    }

    if (SHELL_OPERATOR_LEAD.test(char)) {
      let end = index;
      while (end < command.length && SHELL_OPERATOR_LEAD.test(command[end])) end++;
      out += paint(keyword, command.slice(index, end));
      index = end;
      continue;
    }

    let end = index;
    while (end < command.length && !SHELL_WORD_BREAK.test(command[end])) end++;
    const word = command.slice(index, end);
    index = end;

    const assignment = SHELL_ASSIGNMENT.exec(word);
    if (assignment) {
      // `NODE_ENV=production npm start` — the name is a variable, not a command.
      out += paint(variable, assignment[1]) + paint(punct, "=") + paint(fn, word.slice(assignment[0].length));
    } else if (SHELL_KEYWORDS.has(word)) {
      out += paint(keyword, word);
    } else if (word.startsWith("-")) {
      // A flag reads as its dashes and its name, coloured apart; `--flag=value`
      // keeps its value in the argument colour.
      const dashes = /^-+/.exec(word)?.[0] ?? "-";
      const rest = word.slice(dashes.length);
      const eq = rest.indexOf("=");
      out += paint(punct, dashes);
      out += eq === -1
        ? paint(variable, rest)
        : paint(variable, rest.slice(0, eq)) + paint(punct, "=") + paint(fn, rest.slice(eq + 1));
    } else if (/^\d+$/.test(word)) {
      out += paint(number, word);
    } else if (word.startsWith("$")) {
      out += paint(punct, word.slice(0, word.startsWith("${") ? 2 : 1)) + paint(variable, word.slice(word.startsWith("${") ? 2 : 1));
    } else {
      out += paint(fn, word);
    }
  }
  return out;
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
  const highlighted = highlightShellCommand(command).split("\n");
  bashHighlightCache.set(command, highlighted);
  return highlighted;
}

/** Re-render a bold, plainly-printed command call in omp's dim-prefix,
 * syntax-highlighted style. A tool that does not say where its command lives
 * keeps whatever rows it drew. */
function renderCommandLines(
  rawLines: readonly string[],
  profile: ToolProfile | undefined,
  args: unknown,
  expanded: boolean,
): readonly string[] {
  const toolArgs = asToolArgs(args);
  const command = profile?.command?.(toolArgs)?.replace(/\t/g, "   ") ?? "";
  if (!command) return rawLines;

  const highlighted = highlightBashCommand(command);
  if (highlighted.length === 0) return rawLines;
  const prefix = `${fgAnsi(HEX.overlay0)}$ ${FG_RESET}`;
  const lines = highlighted.map((line, index) => (index === 0 ? `${prefix}${line}` : line));

  const detail = (profile?.detail?.(toolArgs) ?? []).filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  if (detail.length > 0) {
    lines[lines.length - 1] += `${fgAnsi(HEX.overlay0)} (${detail.join(" · ")})${FG_RESET}`;
  }

  // omp caps a collapsed command to a viewport-sized tail (`capPreviewLines`),
  // trading the marker row for one visible line — the `$` prefix scrolls away
  // with the head there too. A heredoc no longer swallows the whole screen.
  const max = previewWindowRows();
  if (expanded || lines.length <= max) return lines;
  const visible = lines.slice(lines.length - (max - 1));
  return [earlierLinesMarker(lines.length - visible.length), ...visible];
}

/** Strip each row once. Profiles walk the rows more than once, and stripping is
 * the only expensive step in doing so. */
function stripRows(rawLines: readonly string[]): StrippedRow[] {
  return rawLines.map(line => ({ line, plain: stripAnsi(line).trim() }));
}

function wallBadge(text: string, tail = ""): string {
  return `${fgAnsi(HEX.overlay0)}⟨${text}⟩${tail}${FG_RESET}`;
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
function bashWall(rows: readonly StrippedRow[], args: ToolArgs): readonly string[] {
  const timeout = typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : undefined;
  const timeoutText = timeout === undefined ? "" : ` | Timeout: ${timeout}s`;
  const canFoldExit = rows.some(row => BASH_TOOK_PATTERN.test(row.plain));

  let exitCode: string | undefined;
  const kept: StrippedRow[] = [];
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
    return wallBadge(`Wall: ${took[1]}${timeoutText}${exitText}`);
  });
}

const RUNBG_TIMING_PATTERN = /^(?:took|yielded|elapsed)\s+(\S+)$/;
const RUNBG_EXIT_PATTERN = /^exit_code=(-?\d+)$/;

/** pi-runbg closes a block with one dim `took 0.2s · exit_code=0 ·
 * session_id=3 · log: …` row. Lift the two parts omp has a name for into its
 * badge and leave the rest alongside it: a session id and a log path have no
 * omp equivalent, and on a backgrounded command they are the point.
 *
 * Only the last non-blank row is considered, so a line of program output that
 * happens to begin `took …` is never mistaken for the status row. If runbg ever
 * rewords it the match simply fails and its own row shows through. */
function runbgWall(rows: readonly StrippedRow[], args: ToolArgs): readonly string[] {
  let last = rows.length - 1;
  while (last >= 0 && rows[last].plain.length === 0) last--;
  if (last < 0) return rows.map(row => row.line);

  const bits = rows[last].plain.split(" · ");
  const timing = RUNBG_TIMING_PATTERN.exec(bits[0] ?? "");
  if (!timing) return rows.map(row => row.line);

  // omp puts the ceiling on a run beside its wall time; runbg's ceiling is the
  // window this call stayed attached for.
  const badge = [`Wall: ${timing[1]}`];
  const yieldMs = args.yield_time_ms;
  if (typeof yieldMs === "number" && Number.isFinite(yieldMs)) badge.push(`Yield: ${yieldMs / 1000}s`);

  const rest: string[] = [];
  for (const bit of bits.slice(1)) {
    const exit = RUNBG_EXIT_PATTERN.exec(bit);
    if (exit) badge.push(`Exit: ${exit[1]}`);
    else rest.push(bit);
  }

  const tail = rest.length > 0 ? ` ${rest.join(" · ")}` : "";
  const replaced = wallBadge(badge.join(" | "), tail);
  return rows.map((row, index) => (index === last ? replaced : row.line));
}

// ═══════════════════════════════════════════════════════════════════════════
// Collapsed previews
//
// omp sizes its collapsed tool previews from the live viewport and closes them
// with dim `… N … lines ⟨Ctrl+O: Expand⟩` markers (`tools/render-utils.ts`:
// `previewWindowRows`, `capPreviewLines`, `formatMoreItems`, `formatExpandHint`).
// pi's renderers use fixed budgets and their own marker wording; the helpers
// here carry omp's shapes for the rebuilds below.
// ═══════════════════════════════════════════════════════════════════════════

const PREVIEW_WINDOW_RESERVED_ROWS = 20;
const PREVIEW_WINDOW_MIN_LINES = 6;
const PREVIEW_WINDOW_FALLBACK_ROWS = 30;

/** The window height rides in the frame memo key in 10 bits, and the depth
 * the previews actually use must never outrun what the memo can see — a
 * taller terminal would stop invalidating on vertical resize. omp's helper is
 * unbounded; a 1043-row terminal is where this one stops caring. */
const PREVIEW_WINDOW_MAX_LINES = 1023;

/** omp's `previewWindowRows`: terminal rows minus a reserve for the rest of the
 * block and the editor below it, floored so a tiny terminal still shows some. */
function previewWindowRows(): number {
  const rows = process.stdout.rows || PREVIEW_WINDOW_FALLBACK_ROWS;
  return Math.min(PREVIEW_WINDOW_MAX_LINES, Math.max(PREVIEW_WINDOW_MIN_LINES, rows - PREVIEW_WINDOW_RESERVED_ROWS));
}
function dimRow(text: string): string {
  return `${fgAnsi(HEX_TOOL.dim)}${text}${FG_RESET}`;
}

/** omp resolves this hint from its live keybindings; pi offers extensions no
 * accessor for the expand binding, so this carries pi's default, spelled the
 * way omp's own `formatExpandHint` spells it (captured from its transcript). */
const EXPAND_HINT = "⟨Ctrl+O: Expand⟩";

/** omp's `capPreviewLines` marker: a tail window hides its head. */
function earlierLinesMarker(hidden: number): string {
  return dimRow(`… ${hidden} earlier line${hidden === 1 ? "" : "s"} ${EXPAND_HINT}`);
}

/** omp's `formatMoreItems` + expand hint: a head window hides its tail. */
function moreLinesMarker(hidden: number): string {
  return dimRow(`… ${hidden} more line${hidden === 1 ? "" : "s"} ${EXPAND_HINT}`);
}

// pi renders tool output through `getTextOutput`, which sanitizes every text
// block before it can reach a row. Result *content* is raw — bash appends
// child output verbatim, read stores file bytes — so anything rebuilt from it
// must apply the same chain, or a `grep --color=always` bleeds over the frame
// and a control byte throws inside render and burns the fail-once latch on
// ordinary data. Both patterns mirror pi's exactly (`utils/ansi.js`
// `ansiRegex` — broader than `ANSI_SEQ` above: colon params, `~` finals, the
// 0x9C terminator — and `utils/shell.js` `sanitizeBinaryOutput`).
const OUTPUT_ANSI_SEQ = new RegExp(
  "(?:\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\u005C|\\u009C))" +
    "|[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]",
  "g",
);

/** pi's per-block chain: strip ANSI whole, drop the control bytes that crash
 * string-width (keeping `\t` `\n` `\r`, like pi), then drop `\r` separately. */
function sanitizeOutputBlock(text: string): string {
  const stripped =
    text.includes("\u001b") || text.includes("\u009b") ? text.replace(OUTPUT_ANSI_SEQ, "") : text;
  return Array.from(stripped)
    .filter(char => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("")
    .replace(/\r/g, "");
}

/** The text blocks of a tool result, joined and sanitized — where pi keeps
 * what a tool printed, in the shape pi would render it. Nothing for
 * image-only or absent results, so callers fall back to the rows pi drew. */
function toolResultText(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    const candidate = block as { type?: unknown; text?: unknown } | null;
    if (candidate?.type === "text" && typeof candidate.text === "string") texts.push(sanitizeOutputBlock(candidate.text));
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Diff rows
//
// pi renders a diff as one row per line — `+123 content` in `toolDiffAdded`,
// `-123 content` in `toolDiffRemoved`, ` 123 content` in `toolDiffContext`,
// and a digitless `...` row where context was skipped (pi `components/diff.ts`
// + `generateDiffString`). omp draws the same rows with structural refinements
// (indentation glyphs — omp `diff.ts` `visualizeIndent`), reproduced here for
// any block whose body carries pi diff rows, whichever tool drew them.
// ═══════════════════════════════════════════════════════════════════════════

type DiffRowKind = "added" | "removed" | "context" | "gap" | "other";

/** `+123 `/`-123 ` on the stripped, trimmed row. The digits are required: pi
 * always numbers its diff rows, and raw `git diff` text (bare `+`/`-` markers)
 * quoted in some tool's output must never qualify. */
const DIFF_CHANGE_ROW = /^[+-]\s*\d+ /;
/** ` 123 content` context rows — the marker space is gone from trimmed text. */
const DIFF_CONTEXT_ROW = /^\d+ /;

function classifyDiffRow(plain: string): DiffRowKind {
  if (DIFF_CHANGE_ROW.test(plain)) return plain.startsWith("+") ? "added" : "removed";
  if (plain === "...") return "gap";
  if (DIFF_CONTEXT_ROW.test(plain)) return "context";
  return "other";
}

// The raw-row anatomy both targets share: an optional background prefix and box
// padding cell, the row's single foreground wrap, the marker+gutter, then the
// content whose leading spaces are the indent. The lookahead accepts a visible
// character or pi's inverse-on (a 1:1 replacement row starts its content with
// `ESC[7m`), but not the closing escapes of an empty row — otherwise the
// row's trailing padding would be glyphed.
const DIFF_INDENT_AFTER_CHANGE = /^((?:\x1b\[[0-9;]*m)* ?(?:\x1b\[[0-9;]*m)*[+-]\s*\d+ )( +)(?=\x1b\[7m|[^\s\x1b])/;
const DIFF_INDENT_AFTER_CONTEXT = /^((?:\x1b\[[0-9;]*m)* ?(?:\x1b\[[0-9;]*m)*\s*\d+ )( +)(?=\x1b\[7m|[^\s\x1b])/;

/** omp's `visualizeIndent`, applied to a row pi already rendered: the indent
 * run after the diff gutter becomes dim `·`s. Dim is a modifier (`ESC[2m`), so
 * the row's diff colour runs through the glyphs untouched. pi flattens tabs to
 * spaces before rendering, so omp's `→` tab marker is unreachable — a tab
 * indents as `···`. */
function glyphDiffIndent(row: string, target: RegExp): string {
  return row.replace(target, (_, head: string, indent: string) => `${head}\x1b[2m${"·".repeat(indent.length)}\x1b[22m`);
}

/** True when a framed body is a pi diff — at least one numbered `+`/`-` row. */
function bodyLooksLikeDiff(stripped: readonly StrippedRow[]): boolean {
  return stripped.some(row => DIFF_CHANGE_ROW.test(row.plain));
}

/** omp's collapsed-diff budget (`PREVIEW_LIMITS.DIFF_COLLAPSED_*`). */
const DIFF_COLLAPSED_HUNKS = 8;
const DIFF_COLLAPSED_LINES = 40;
/** omp's streaming-diff window (`EDIT_STREAMING_PREVIEW_LINES`). */
const DIFF_STREAMING_PREVIEW_LINES = 12;

interface DiffBodyRow {
  line: string;
  plain: string;
  kind: DiffRowKind;
}

/** Maximal runs of `+`/`-` rows. A wrapped continuation row splits its run in
 * two, so this can overcount — the cap then bites a little early, which is the
 * cheap side to be wrong on. */
function countDiffHunks(rows: readonly DiffBodyRow[]): number {
  let hunks = 0;
  let inHunk = false;
  for (const row of rows) {
    const isChange = row.kind === "added" || row.kind === "removed";
    if (isChange && !inHunk) hunks++;
    inHunk = isChange;
  }
  return hunks;
}

interface DiffSegment {
  kind: "change" | "context" | "ellipsis" | "other";
  rows: DiffBodyRow[];
}

/** omp's `parseDiffSegments`: maximal runs of change and context rows, with
 * gap markers and blank rows flushed into singleton "ellipsis" segments.
 * "other" rows (error text, wrapped continuations) have no omp equivalent —
 * they run together and are never thinned below. */
function segmentDiffRows(rows: readonly DiffBodyRow[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  for (const row of rows) {
    const kind: DiffSegment["kind"] =
      row.kind === "added" || row.kind === "removed"
        ? "change"
        : row.kind === "gap" || row.plain.length === 0
          ? "ellipsis"
          : row.kind === "context"
            ? "context"
            : "other";
    const current = segments[segments.length - 1];
    if (current && current.kind === kind && kind !== "ellipsis") current.rows.push(row);
    else segments.push({ kind, rows: [row] });
  }
  return segments;
}

/** The gap row inserted where a sandwiched context run was thinned — omp
 * pushes a bare blank line there; inside a frame that reads as a hole, so
 * this renders as pi's dim gap idiom instead. */
const DIFF_THINNED_GAP_ROW: DiffBodyRow = { line: `${fgAnsi(HEX_TOOL.dim)}…${FG_RESET}`, plain: "…", kind: "gap" };

/** omp's `truncateDiffByHunk` (its render-utils), both regimes, for the
 * settled collapsed view. When the change lines alone bust the line budget,
 * whole segments are kept until a budget trips — overshooting by up to a
 * segment, as omp does. Otherwise every hunk up to the cap stays visible and
 * the context BETWEEN hunks is thinned proportionally: the lines nearest a
 * hunk survive, and a run sandwiched between two hunks splits around a gap
 * row. Like omp, the thinning regime only ever stops early on the hunk cap;
 * the line budget is approximated by the ratio. */
function capDiffRows(rows: DiffBodyRow[]): { kept: DiffBodyRow[]; hiddenLines: number; hiddenHunks: number } {
  const totalHunks = countDiffHunks(rows);
  if (rows.length <= DIFF_COLLAPSED_LINES && totalHunks <= DIFF_COLLAPSED_HUNKS) {
    return { kept: rows, hiddenLines: 0, hiddenHunks: 0 };
  }
  const segments = segmentDiffRows(rows);
  const changeLineCount = segments.reduce((sum, s) => (s.kind === "change" ? sum + s.rows.length : sum), 0);
  const kept: DiffBodyRow[] = [];
  let keptHunks = 0;

  if (changeLineCount > DIFF_COLLAPSED_LINES) {
    for (const segment of segments) {
      if (segment.kind === "change") {
        keptHunks++;
        if (keptHunks > DIFF_COLLAPSED_HUNKS) break;
      }
      kept.push(...segment.rows);
      if (kept.length >= DIFF_COLLAPSED_LINES) break;
    }
  } else {
    const totalContextLines = segments.reduce((sum, s) => (s.kind === "context" ? sum + s.rows.length : sum), 0);
    const contextBudget = DIFF_COLLAPSED_LINES - changeLineCount;
    const thinning = totalContextLines > contextBudget;
    const contextRatio = totalContextLines > 0 ? contextBudget / totalContextLines : 0;
    walk: for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      switch (segment.kind) {
        case "change":
          keptHunks++;
          if (keptHunks > DIFF_COLLAPSED_HUNKS) break walk;
          kept.push(...segment.rows);
          break;
        case "context": {
          if (!thinning) {
            kept.push(...segment.rows);
            break;
          }
          const allowed = Math.max(1, Math.floor(segment.rows.length * contextRatio));
          // omp keys the direction off the immediate neighbours — an ellipsis
          // in between deliberately breaks the adjacency, exactly as there.
          const beforeChange = segments[i + 1]?.kind === "change";
          const afterChange = segments[i - 1]?.kind === "change";
          if (beforeChange && afterChange) {
            if (segment.rows.length > allowed) {
              const half = Math.ceil(allowed / 2);
              kept.push(...segment.rows.slice(0, half), DIFF_THINNED_GAP_ROW, ...segment.rows.slice(-half));
            } else {
              kept.push(...segment.rows);
            }
          } else if (beforeChange) {
            kept.push(...segment.rows.slice(-allowed));
          } else if (afterChange) {
            kept.push(...segment.rows.slice(0, allowed));
          } else {
            kept.push(...segment.rows.slice(0, Math.min(allowed, 2)));
          }
          break;
        }
        default:
          kept.push(...segment.rows);
          break;
      }
    }
  }
  return {
    kept,
    hiddenLines: Math.max(0, rows.length - kept.length),
    hiddenHunks: Math.max(0, totalHunks - countDiffHunks(kept)),
  };
}

// Splits a raw context row into (background escapes)(pad)(context fg)(gutter),
// so the rebuild keeps the gutter in the row's own colour and the box padding
// behind. The fg run must be present — a row without one is left alone.
const CONTEXT_ROW_PARTS = /^(?:\x1b\[[0-9;]*m)* ?((?:\x1b\[[0-9;]*m)+)(\s*\d+ )/;

// The content of a context run never changes once rendered, but the block
// re-renders on every state change — same bargain as `bashHighlightCache`.
const contextHighlightCache = new Map<string, string[]>();
const CONTEXT_HIGHLIGHT_CACHE_MAX = 64;

function highlightContextCached(code: string, lang: string): string[] {
  const key = `${lang} ${code}`;
  const cached = contextHighlightCache.get(key);
  if (cached !== undefined) return cached;
  if (contextHighlightCache.size >= CONTEXT_HIGHLIGHT_CACHE_MAX) contextHighlightCache.clear();
  const highlighted = highlightCode(code, lang);
  contextHighlightCache.set(key, highlighted);
  return highlighted;
}

/** omp syntax-highlights a diff's context lines (its changed lines stay flat
 * red/green), batching each run of consecutive context rows into one highlight
 * call so the tokenizer sees multi-line constructs whole — see omp `diff.ts`
 * `highlightContextLines`. Gutters keep the context colour; a row that fails
 * to split, or a run the highlighter miscounts, falls back to the glyphed
 * original — content already showing is never put at risk. */
function highlightContextRun(rows: readonly DiffBodyRow[], lang: string): string[] {
  const contents = rows.map(row => row.plain.replace(DIFF_CONTEXT_ROW, ""));
  const highlighted = highlightContextCached(contents.join("\n"), lang);
  if (highlighted.length !== rows.length) {
    return rows.map(row => glyphDiffIndent(row.line, DIFF_INDENT_AFTER_CONTEXT));
  }
  return rows.map((row, index) => {
    const parts = CONTEXT_ROW_PARTS.exec(row.line);
    if (!parts) return glyphDiffIndent(row.line, DIFF_INDENT_AFTER_CONTEXT);
    return `${parts[1]}${parts[2]}${FG_RESET}${highlighted[index]}`;
  });
}

/** Give a diff body the omp treatment: the collapsed cap, indent glyphs, and
 * per-language context lines when the profile says which file this is. */
function renderDiffBody(
  stripped: readonly StrippedRow[],
  expanded: boolean,
  streaming: boolean,
  lang: string | undefined,
): readonly string[] {
  const classified = stripped.map(({ line, plain }) => ({ line, plain, kind: classifyDiffRow(plain) }));
  let kept = classified;
  let hiddenLines = 0;
  let hiddenHunks = 0;
  if (streaming) {
    // omp streams a "cursor" tail window of visual rows — `formatStreamingDiff`
    // in its edit renderer — with no hunk cap, 12 rows collapsed and the
    // viewport expanded; the hunk budget only applies once the diff settles.
    // The settle therefore jumps the window from tail to head, as omp's does.
    const budget = expanded ? previewWindowRows() : Math.min(DIFF_STREAMING_PREVIEW_LINES, previewWindowRows());
    if (classified.length > budget) {
      kept = classified.slice(-budget);
      hiddenLines = classified.length - kept.length;
      // Counted over the hidden prefix, as omp does — a hunk the window cuts
      // in half is reported hidden, not shown.
      hiddenHunks = countDiffHunks(classified.slice(0, hiddenLines));
    }
  } else if (!expanded) {
    ({ kept, hiddenLines, hiddenHunks } = capDiffRows(classified));
  }

  const out: string[] = [];
  // omp's markers, byte for byte, unconditional plural included: streaming, a
  // dim `… (2 more hunks, 13 more lines above)` leads the tail; settled, the
  // same remainder trails the head in `toolOutput` with the expand hint.
  const remainder: string[] = [];
  if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more hunks`);
  if (hiddenLines > 0) remainder.push(`${hiddenLines} more lines`);
  if (remainder.length > 0 && streaming) {
    out.push(dimRow(`… (${remainder.join(", ")} above)`));
  }
  let index = 0;
  while (index < kept.length) {
    const row = kept[index];
    if (row.kind === "context" && lang !== undefined) {
      let end = index;
      while (end < kept.length && kept[end].kind === "context") end++;
      out.push(...highlightContextRun(kept.slice(index, end), lang));
      index = end;
      continue;
    }
    if (row.kind === "added" || row.kind === "removed") out.push(glyphDiffIndent(row.line, DIFF_INDENT_AFTER_CHANGE));
    else if (row.kind === "context") out.push(glyphDiffIndent(row.line, DIFF_INDENT_AFTER_CONTEXT));
    else out.push(row.line);
    index++;
  }
  if (remainder.length > 0 && !streaming) {
    out.push(`${fgAnsi(HEX.overlay1)}… (${remainder.join(", ")})${FG_RESET} ${dimRow(EXPAND_HINT)}`);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Content previews (omp's write cell)
//
// omp previews written content behind a dim line-number gutter, tokenized in
// the file's language, windowed by state: a live tail of the last 12 lines
// while streaming, the first 6 once settled and collapsed, everything when
// expanded (omp `write.ts` `formatStreamingContent`/`renderContentPreview`).
// pi shows a frozen head of 10 with no gutter; a profile that names its
// `content` gets the omp shape rebuilt from `args` instead.
// ═══════════════════════════════════════════════════════════════════════════

const CONTENT_STREAMING_TAIL_LINES = 12;
const CONTENT_COLLAPSED_HEAD_LINES = 6;
const CONTENT_GUTTER_MIN_WIDTH = 3;

// Keys embed the whole content, so this stays small: entries are only hit
// while their block is visible and mutating, and a session's writes would
// otherwise pin every past file in memory.
const contentPreviewCache = new Map<string, string[]>();
const CONTENT_PREVIEW_CACHE_MAX = 16;

/** Rebuild a content-bearing body in omp's write-cell shape. Only the visible
 * slice is tokenized, exactly as omp does, so a long file costs its window,
 * not its length. Returns nothing when the tool has no said content or failed
 * — pi's own rows stay, and nothing can be hidden by mistake. */
function renderContentBody(
  profile: ToolProfile | undefined,
  component: FramedToolComponent,
  width: number,
): readonly string[] | undefined {
  const content = profile?.content?.(asToolArgs(component.args));
  if (!content || component.result?.isError) return undefined;

  const streaming = component.isPartial;
  const expanded = component.expanded;
  const lang = profileLanguage(profile, component.args);
  const innerWidth = Math.max(1, width - 4);
  const key = `${lang} ${innerWidth} ${(streaming ? 1 : 0) | (expanded ? 2 : 0)} ${content}`;
  const cached = contentPreviewCache.get(key);
  if (cached !== undefined) return cached;
  if (contentPreviewCache.size >= CONTENT_PREVIEW_CACHE_MAX) contentPreviewCache.clear();

  // No trailing-empty trim: omp renders the row a trailing newline creates,
  // which is also what the `· 4 lines` badge counts.
  const lines = content.replace(/\t/g, "   ").split("\n");
  const totalLines = lines.length;
  const start = streaming && !expanded ? Math.max(0, totalLines - CONTENT_STREAMING_TAIL_LINES) : 0;
  const end = !streaming && !expanded ? Math.min(totalLines, CONTENT_COLLAPSED_HEAD_LINES) : totalLines;
  const visible = lines.slice(start, end);

  let highlighted = lang ? highlightCode(visible.join("\n"), lang) : visible;
  if (highlighted.length !== visible.length) highlighted = visible;
  const gutterWidth = Math.max(CONTENT_GUTTER_MIN_WIDTH, String(totalLines).length);
  const gutted = highlighted.map(
    (line, index) => `${fgAnsi(HEX_TOOL.dim)}${String(start + index + 1).padStart(gutterWidth)} ${FG_RESET}${line}`,
  );

  const rows: string[] = [];
  if (start > 0) rows.push(dimRow(`… (${start} earlier line${start === 1 ? "" : "s"})`));
  // Pre-wrapped at the frame's inner width because the frame renderer
  // truncates; pi's own preview wraps, and content must not be lost to that.
  rows.push(...new Text(gutted.join("\n"), 0, 0).render(innerWidth));
  if (end < totalLines) rows.push(moreLinesMarker(totalLines - end));
  if (streaming) rows.push(dimRow("… (streaming)"));

  contentPreviewCache.set(key, rows);
  return rows;
}

/** omp's collapsed bash-output budget (`BASH_DEFAULT_PREVIEW_LINES`). */
const OUTPUT_TAIL_LINES = 10;

const outputTailCache = new Map<string, string[]>();
const OUTPUT_TAIL_CACHE_MAX = 16;

const OUTPUT_HINT_ROW = /^\.\.\. \(\d+ earlier lines?,/;
const OUTPUT_ROW_FG = /^\x1b\[38;(?:2|5);[0-9;]*m/;

/** Rebuild pi's collapsed output window at omp's depth. pi keeps 5 visual
 * lines behind a muted `... (N earlier lines, …)` row; omp keeps a
 * viewport-capped 10. The full output still lives in the result, so the
 * deeper tail is re-derived from it and swapped in over pi's window.
 *
 * The replaced span is delimited by COLOR, not shape: pi wraps every output
 * line — and, via pi-tui's SGR tracking, every wrapped continuation row — in
 * the same `toolOutput` foreground, while the truncation warning and timing
 * rows that follow carry their own. Walking rows while they open with the
 * output foreground therefore survives what a shape walk could not: the
 * warning row wrapping into fragments that individually look like nothing.
 * Output that merely *prints* warning- or timing-shaped text is output-
 * colored, stays inside the span, and is replaced by the rebuilt tail — so
 * it renders exactly once. (A theme whose warning or timing color equals
 * `toolOutput` would fold that row into the span; degenerate, and the cost
 * is a missing row behind an accurate marker.)
 *
 * Everything here fails toward pi's rows: no window row at index 0, no
 * extractable foreground, no result text — untouched, pi's 5-line look. */
function retailOutputRows(
  rawResult: readonly string[],
  profile: ToolProfile,
  component: FramedToolComponent,
  width: number,
): readonly string[] {
  // pi's preview child is the result container's first child and
  // `renderToolPart` trims its leading blank, so a real window row is always
  // row 0 — the same text anywhere else is output that happens to look like
  // one, and rebuilding there would duplicate the rows before it. pi also
  // only draws the row when lines are hidden; without it the whole output is
  // already visible and there is nothing to deepen.
  if (rawResult.length < 2 || !OUTPUT_HINT_ROW.test(stripAnsi(rawResult[0]).trim())) return rawResult;

  // The output's own foreground, read off the first row pi drew with it. A
  // theme that leaves `toolOutput` colorless makes the span undetectable —
  // bail to pi's rows rather than guess.
  const outFg = OUTPUT_ROW_FG.exec(rawResult[1])?.[0];
  if (!outFg) return rawResult;
  let end = 2;
  while (end < rawResult.length && rawResult[end].startsWith(outFg)) end++;

  const text = profile.output?.(component.result);
  if (!text) return rawResult;

  // pi strips the persisted-output footer from settled renders; the raw
  // result text still carries it, so mirror that strip (see pi's
  // `rebuildBashResultRenderComponent`).
  let output = text.trim();
  const details = (component.result as { details?: { fullOutputPath?: unknown } } | undefined)?.details;
  const fullOutputPath = details?.fullOutputPath;
  if (!component.isPartial && typeof fullOutputPath === "string" && output.endsWith("]")) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
      output = output.slice(0, footerStart).trimEnd();
    }
  }
  if (!output) return rawResult;

  const innerWidth = Math.max(1, width - 4);
  const budget = Math.min(OUTPUT_TAIL_LINES, previewWindowRows());
  const key = `${outFg} ${innerWidth} ${budget} ${output}`;
  let tail = outputTailCache.get(key);
  if (tail === undefined) {
    if (outputTailCache.size >= OUTPUT_TAIL_CACHE_MAX) outputTailCache.clear();
    const styled = output
      .split("\n")
      .map(line => `${outFg}${line.replace(/\t/g, "   ")}${FG_RESET}`)
      .join("\n");
    const visual = new Text(styled, 0, 0).render(innerWidth);
    const kept = visual.slice(-budget);
    // omp's bash window marker, byte for byte — counts are visual rows and
    // the plural is unconditional, exactly as its bash.ts writes them. The
    // parenthesized lowercase hint is omp's own inconsistency with its
    // `⟨Ctrl+O: Expand⟩` style elsewhere, kept for capture parity.
    tail =
      kept.length < visual.length
        ? [
            dimRow(
              `… (${visual.length - kept.length} earlier lines, showing ${kept.length} of ${visual.length}) (ctrl+o to expand)`,
            ),
            ...kept,
          ]
        : kept;
    outputTailCache.set(key, tail);
  }
  return [...tail, ...rawResult.slice(end)];
}

/** omp's collapsed content-cell height (`PREVIEW_LIMITS.OUTPUT_COLLAPSED`). */
const RESULT_PREVIEW_LINES = 3;

const resultPreviewCache = new Map<string, string[]>();
const RESULT_PREVIEW_CACHE_MAX = 16;

/** omp's read entries stay one line but carry a small cell of the file under
 * the summary — the first three lines, gutted and highlighted, closed with
 * `… N more lines` (omp `read-tool-group.ts` `#addContentPreview`). Rebuilt
 * from the tool result; a result that is absent, an error, or image-only
 * leaves the plain one-liner. */
function renderResultPreview(
  profile: ToolProfile | undefined,
  component: FramedToolComponent,
  width: number,
): readonly string[] | undefined {
  if (!readPreviewEnabled) return undefined;
  if (profile?.resultText === undefined || component.expanded || component.result?.isError) return undefined;
  const text = profile.resultText(component.result);
  if (!text) return undefined;

  const lang = profileLanguage(profile, component.args);
  const startLine = profile.startLine?.(asToolArgs(component.args)) ?? 1;
  // Three cells of indent tuck the cell under the one-liner's bullet label.
  const innerWidth = Math.max(1, width - 3);
  const key = `${lang} ${startLine} ${innerWidth} ${text}`;
  const cached = resultPreviewCache.get(key);
  if (cached !== undefined) return cached;
  if (resultPreviewCache.size >= RESULT_PREVIEW_CACHE_MAX) resultPreviewCache.clear();

  const lines = text.replace(/\t/g, "   ").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return undefined;
  const total = lines.length;
  const visible = lines.slice(0, RESULT_PREVIEW_LINES);
  let highlighted = lang ? highlightCode(visible.join("\n"), lang) : visible;
  if (highlighted.length !== visible.length) highlighted = visible;
  // omp's code cell sizes its gutter to the largest VISIBLE number, floor 2
  // (`code-cell.ts`) — narrower than the write cell's floor of 3.
  const gutterWidth = Math.max(2, String(startLine + visible.length - 1).length);
  const gutted = highlighted.map(
    (line, index) => `${fgAnsi(HEX_TOOL.dim)}${String(startLine + index).padStart(gutterWidth)} ${FG_RESET}${line}`,
  );
  const rows = new Text(gutted.join("\n"), 0, 0).render(innerWidth).map(row => `   ${row}`);
  // omp tucks the more-marker under the numbers with a gutter-width pad.
  if (total > RESULT_PREVIEW_LINES) {
    rows.push(`   ${" ".repeat(gutterWidth + 1)}${moreLinesMarker(total - RESULT_PREVIEW_LINES)}`);
  }

  resultPreviewCache.set(key, rows);
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON document trees (omp's default-renderer view)
//
// A tool that ships no renderer gets a structured default in omp: its args as
// a dim inline preview under the title, and a result that parses as JSON as a
// guide-line document tree — muted keys, dim values, node icons, windowed by
// state (omp `tools/json-tree.ts`, `tools/default-renderer.ts`,
// `mcp/render.ts`). pi's fallback for the same class is the tool name over
// pretty-printed JSON. MCP tools are the population this matters for, but the
// gate is the renderer's absence, never a name.
//
// One deliberate deviation: omp hides its wire-protocol keys (`i`,
// `__partialJson`) from every tree and inline preview; pi has no such
// convention, so every key renders.
// ═══════════════════════════════════════════════════════════════════════════

const JSON_TREE_MAX_DEPTH_COLLAPSED = 2;
const JSON_TREE_MAX_DEPTH_EXPANDED = 6;
const JSON_TREE_MAX_LINES_COLLAPSED = 6;
const JSON_TREE_MAX_LINES_EXPANDED = 200;
const JSON_TREE_SCALAR_LEN_COLLAPSED = 60;
const JSON_TREE_SCALAR_LEN_EXPANDED = 2000;

// omp's `tree.*` symbols, identical in its nerd and unicode presets.
const TREE_BRANCH = "├─";
const TREE_LAST = "└─";
const TREE_VERTICAL = "│";

/** JSON strings can smuggle control bytes past the sanitized result text —
 * `JSON.parse` re-materializes `\u001b` and friends from their escapes, and a
 * raw CR or CSI in a rendered row repaints the frame. Spell them back the way
 * the source JSON did. */
function escapeControlChars(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, char => {
    if (char === "\n") return "\\n";
    if (char === "\t") return "\\t";
    if (char === "\r") return "\\r";
    return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0")}`;
  });
}

/** Truncate PLAIN text to a width. Not pi-tui's `truncateToWidth`: that
 * injects a style reset around its appended ellipsis — killing the dim wrap
 * these rows sit inside — and defaults to the 3-cell `...` where omp's
 * default is `…`. */
function clipPlain(text: string, maxWidth: number): string {
  // No room is no room. Returning an ellipsis anyway is the same mistake as
  // flooring a width budget at one cell — see `clipMiddle`, which guards it.
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  let out = "";
  let used = 0;
  // Per code point, so a ZWJ emoji cluster can split and under-fill where omp
  // keeps it whole — never overflowing, which is the side that matters. The
  // trailing strip keeps a severed joiner from fusing with the ellipsis.
  for (const char of text) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > maxWidth - 1) break;
    out += char;
    used += charWidth;
  }
  return `${out.replace(/[\u200d\ufe0f]+$/, "")}…`;
}

/** omp's `formatScalar`: one JSON value, inline. */
function formatJsonScalar(value: unknown, maxLen: number): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return `"${clipPlain(escapeControlChars(value), maxLen)}"`;
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return `{${Object.keys(value).length} keys}`;
  return String(value);
}

/** omp's `formatArgsInline`: `key=value, key2=…` within a width budget, each
 * pending key reserving a minimal footprint so one long value cannot starve
 * the keys behind it. */
function formatArgsInline(args: ToolArgs, maxWidth: number): string {
  const keys = Object.keys(args);
  let result = "";
  let width = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const sep = width > 0 ? ", " : "";
    const current = width + visibleWidth(sep);
    const cap = maxWidth - current - 1;
    if (cap <= 0) return `${result}…`;
    let tailReserve = 0;
    for (let j = i + 1; j < keys.length; j++) {
      tailReserve += 2 + visibleWidth(keys[j]) + 1 + 4;
    }
    const pieceBudget = Math.min(cap, maxWidth - current - tailReserve);
    const valueMaxLen = Math.max(1, pieceBudget - visibleWidth(key) - 3);
    const piece = `${escapeControlChars(key)}=${formatJsonScalar(args[key], valueMaxLen)}`;
    const pieceWidth = visibleWidth(piece);
    if (pieceWidth > pieceBudget) return `${result}${sep}${clipPlain(piece, cap)}`;
    result += sep + piece;
    width = current + pieceWidth;
  }
  return result;
}

/** omp's `renderJsonTreeLines`: a JSON value as guide-line tree rows — muted
 * keys, dim values and connectors, node icons per type, depth- and line-capped.
 * Ported quirks kept: every root key of an object draws with the `└─`
 * connector, and multiline strings render their first lines indented under
 * the key with the closing quote on the last shown line. */
function renderJsonTreeLines(
  value: unknown,
  maxDepth: number,
  maxLines: number,
  maxScalarLen: number,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  const muted = (text: string): string => `${fgAnsi(HEX.overlay1)}${text}${FG_RESET}`;
  const dim = (text: string): string => `${fgAnsi(HEX_TOOL.dim)}${text}${FG_RESET}`;
  const icons = glyphs().node;

  const pushLine = (line: string): boolean => {
    if (lines.length >= maxLines) {
      truncated = true;
      return false;
    }
    lines.push(line);
    return true;
  };

  const treePrefix = (ancestors: readonly boolean[]): string =>
    ancestors.map(hasNext => (hasNext ? `${TREE_VERTICAL}  ` : "   ")).join("");

  const renderNode = (
    val: unknown,
    key: string | undefined,
    ancestors: boolean[],
    isLast: boolean,
    depth: number,
  ): void => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    const prefix = `${treePrefix(ancestors)}${dim(isLast ? TREE_LAST : TREE_BRANCH)} `;
    ancestors.push(!isLast);
    try {
      if (val === null || val === undefined || typeof val !== "object") {
        // Keys are attacker-controlled text too — a CR or ESC smuggled into a
        // key name must render as its escape, exactly like one in a value.
        const label = muted(escapeControlChars(key ?? "value"));
        if (typeof val === "string" && val.includes("\n")) {
          const strLines = val.split("\n");
          const maxStrLines = Math.min(strLines.length, Math.max(1, maxLines - lines.length - 1));
          const continuePrefix = treePrefix(ancestors);
          pushLine(
            `${prefix}${muted(icons.scalar)} ${label}: ${dim(`"${clipPlain(escapeControlChars(strLines[0]), maxScalarLen)}`)}`,
          );
          for (let i = 1; i < maxStrLines; i++) {
            if (lines.length >= maxLines) {
              truncated = true;
              break;
            }
            pushLine(`${continuePrefix}   ${dim(` ${clipPlain(escapeControlChars(strLines[i]), maxScalarLen)}`)}`);
          }
          if (strLines.length > maxStrLines) {
            truncated = true;
            pushLine(`${continuePrefix}   ${dim(` …(${strLines.length - maxStrLines} more lines)"`)}`);
          } else if (lines.length > 0) {
            lines[lines.length - 1] += dim('"');
          }
          return;
        }
        pushLine(`${prefix}${muted(icons.scalar)} ${label}: ${dim(formatJsonScalar(val, maxScalarLen))}`);
        return;
      }
      if (Array.isArray(val)) {
        pushLine(`${prefix}${muted(icons.array)} ${muted(escapeControlChars(key ?? "array"))}`);
        if (val.length === 0) {
          pushLine(`${treePrefix(ancestors)}${dim(TREE_LAST)} ${dim("[]")}`);
          return;
        }
        if (depth >= maxDepth) {
          pushLine(`${treePrefix(ancestors)}${dim(TREE_LAST)} ${dim("…")}`);
          return;
        }
        for (let i = 0; i < val.length; i++) {
          renderNode(val[i], `[${i}]`, ancestors, i === val.length - 1, depth + 1);
          if (lines.length >= maxLines) {
            truncated = true;
            return;
          }
        }
        return;
      }
      const record = val as Record<string, unknown>;
      pushLine(`${prefix}${muted(icons.object)} ${muted(escapeControlChars(key ?? "object"))}`);
      if (depth >= maxDepth) {
        pushLine(`${treePrefix(ancestors)}${dim(TREE_LAST)} ${dim("…")}`);
        return;
      }
      const childKeys = Object.keys(record);
      if (childKeys.length === 0) {
        pushLine(`${treePrefix(ancestors)}${dim(TREE_LAST)} ${dim("{}")}`);
        return;
      }
      for (let i = 0; i < childKeys.length; i++) {
        renderNode(record[childKeys[i]], childKeys[i], ancestors, i === childKeys.length - 1, depth + 1);
        if (lines.length >= maxLines) {
          truncated = true;
          return;
        }
      }
    } finally {
      ancestors.pop();
    }
  };

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      renderNode((value as Record<string, unknown>)[key], key, [], true, 1);
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      renderNode(value[i], `[${i}]`, [], i === value.length - 1, 1);
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
  } else {
    renderNode(value, undefined, [], true, 0);
  }
  return { lines, truncated };
}

/** omp's raw-output window for the same population (`default-renderer.ts`):
 * a result that is not a JSON document shows its first lines and says how
 * many it kept back. */
const TEXT_WINDOW_LINES_COLLAPSED = 4;
const TEXT_WINDOW_LINES_EXPANDED = 12;

/** pi's convention for a machine-facing footnote a tool appends to its own
 * output — a whole line in brackets, `[Output truncated: … saved to: /tmp/x]`.
 * omp keeps its equivalent out of the window because its truncation arrives on
 * a separate channel; pi has none, so the shape is what holds this back. A
 * line of real output that happens to be bracketed is mistaken for one, which
 * costs it a colour and a place at the end — never its visibility. */
const TRAILING_NOTICE_LINE = /^\[.*\]$/;
/** A result worth trying to parse. Leading space is skipped here and by
 * `JSON.parse` alike, so the window below keeps the text's own indentation. */
const JSON_DOCUMENT_LEAD = /^\s*[{[]/;

/** Rows the notice may occupy, however long it is. */
const NOTICE_MAX_ROWS = 4;

/** Clip from the middle, keeping both ends. A truncation notice earns this
 * over `clipPlain`: what it exists to carry — the path to the rest of the
 * output — sits at its end, so trimming the tail throws away the point of
 * keeping the line at all. */
function clipMiddle(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 0) return "";
  if (maxWidth === 1) return "…";
  const chars = [...text];
  const budget = maxWidth - 1;
  const headBudget = Math.ceil(budget / 2);
  let head = "";
  let headWidth = 0;
  for (const char of chars) {
    const charWidth = visibleWidth(char);
    if (headWidth + charWidth > headBudget) break;
    head += char;
    headWidth += charWidth;
  }
  let tail = "";
  let tailWidth = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const charWidth = visibleWidth(chars[i]);
    if (tailWidth + charWidth > budget - headWidth) break;
    tail = chars[i] + tail;
    tailWidth += charWidth;
  }
  return `${head}…${tail}`;
}

/** Wrap by cells rather than by words. A notice is one long machine string —
 * a path, a byte count — and prose wrapping strands its short tokens on rows
 * of their own, which is how a bounded row count silently loses the tail. */
function hardWrap(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const char of text) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > width && row !== "") {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += char;
    used += charWidth;
  }
  if (row !== "") rows.push(row);
  return rows;
}

/** omp's raw-output window. Lines are clipped rather than wrapped, as omp
 * clips them, so the count in the marker is the count of real lines. */
function buildTextWindowRows(text: string, expanded: boolean, innerWidth: number): string[] {
  const lines = text.replace(/\t/g, "   ").split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;

  // Where a truncated result says where the whole of it went, that line
  // outlives the window — the path is the one thing a collapsed block must
  // not swallow. The blank line it was appended after leaves with it, or the
  // marker would count an empty line as output held back.
  let notice: string | undefined;
  let hasBodyBefore = false;
  for (let i = 0; i < end - 1; i++) {
    if (lines[i].trim() !== "") {
      hasBodyBefore = true;
      break;
    }
  }
  if (hasBodyBefore && TRAILING_NOTICE_LINE.test(lines[end - 1])) {
    notice = lines[end - 1];
    end--;
    while (end > 0 && lines[end - 1].trim() === "") end--;
  }

  const max = expanded ? TEXT_WINDOW_LINES_EXPANDED : TEXT_WINDOW_LINES_COLLAPSED;
  const shown = lines.slice(0, Math.min(end, max));
  const rows = shown.map(line => `${fgAnsi(HEX.overlay1)}${clipPlain(line, innerWidth)}${FG_RESET}`);
  const hidden = end - shown.length;
  if (hidden > 0) rows.push(moreLinesMarker(hidden));
  else if (!expanded) rows.push(dimRow(EXPAND_HINT));
  if (notice !== undefined) {
    // Wrapped, not clipped like the output above it: this line exists to
    // carry the path to the rest of the output, and a clipped path is no
    // path. Bounded all the same — a notice is only ever a notice by shape,
    // and a bracketed line of any size must not outgrow the window it sits
    // beneath.
    // Budgeted a cell per row short of the width, so the bound survives even
    // where every character is two cells wide, and elided in the middle so
    // both the head and the path at the end come through.
    const bounded = clipMiddle(notice, Math.max(1, innerWidth - 1) * NOTICE_MAX_ROWS);
    for (const row of hardWrap(bounded, innerWidth)) {
      rows.push(`${fgAnsi(HEX.yellow)}${row}${FG_RESET}`);
    }
  }
  return rows;
}

// Tree rows depend only on the parsed text, the window, and the glyph preset
// (node icons are baked into the rows), so the cache skips the parse + walk
// on every repaint of a settled block.
const jsonTreeCache = new Map<string, string[]>();
const JSON_TREE_CACHE_MAX = 16;


/** Drop the oldest entry rather than the whole map, so the documents still on
 * screen survive a miss by one. */
function evictOldest(cache: Map<string, string[]>, max: number): void {
  if (cache.size < max) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

/** Parse and walk one result text into finished tree rows; empty when the
 * text is not a renderable document. */
function buildJsonTreeRows(text: string, expanded: boolean): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const tree = renderJsonTreeLines(
    parsed,
    expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED,
    expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED,
    expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED,
  );
  if (tree.lines.length === 0) return [];
  const rows = tree.lines;
  // omp closes a collapsed tree with the expand hint and an expanded,
  // still-deeper one with a dim ellipsis.
  if (!expanded) rows.push(dimRow(EXPAND_HINT));
  else if (tree.truncated) rows.push(dimRow("…"));
  return rows;
}

/** pi's `hasRendererDefinition` is definition presence, not renderer
 * presence: a registered tool with no `renderCall`/`renderResult` — the MCP
 * bridge shape — still reports true and falls back to a bare name over raw
 * output. omp's "default renderer" population is both of those, plus the
 * definition-less (replayed transcripts of uninstalled extensions). */
function toolIsRendererless(component: FramedToolComponent): boolean {
  if (!component.hasRendererDefinition()) return true;
  return component.getCallRenderer() === undefined && component.getResultRenderer() === undefined;
}

/** However much of a self-declared label a header will carry. */
const TOOL_LABEL_MAX_LENGTH = 200;

/** The name a block wears. A tool that draws nothing itself gets the label it
 * declared, verbatim — its own words beat a title derived from an identifier,
 * which for a bridged `mcp__opensearch__opensearch_indices_query` reads
 * `Mcp opensearch opensearch indices query`. omp titles that population from
 * the same field. Tools that render themselves keep the derived title, since
 * a label there is usually the bare identifier pi already shows. */
function toolHeaderTitle(component: FramedToolComponent): string {
  const override = TOOL_PROFILES.get(component.toolName)?.title;
  if (override !== undefined) return override;
  const label = component.toolDefinition?.label;
  if (typeof label === "string" && label.trim().length > 0 && toolIsRendererless(component)) {
    // A label is foreign text like any other: a bridged tool's comes from
    // whatever a remote server answered `tools/list` with, and pi validates
    // none of it. Strip whole escape sequences, spell out the control bytes
    // that survive them, and bound the length before it reaches a bar that
    // measures what it is given.
    const flattened = sanitizeStatusText(escapeControlChars(stripAnsi(label)));
    return [...flattened].slice(0, TOOL_LABEL_MAX_LENGTH).join("");
  }
  return toolTitle(component.toolName);
}

/** The omp default-renderer body for a tool without renderers: a dim inline
 * args row, then the result — as a document tree when it parses as JSON, as
 * omp's windowed raw output when it does not. Pending calls get the args row
 * alone, omp's call view, instead of pi's pretty-printed args block. Errors
 * and tools with renderers keep pi's rows. The result text is the JOINED text
 * blocks; omp trees only the first — joined either parses whole or falls
 * through to the window, which can only widen the fallback. */
function renderDefaultToolBody(component: FramedToolComponent, width: number): readonly string[] | undefined {
  if (!toolIsRendererless(component) || component.result?.isError) return undefined;

  const innerWidth = Math.max(1, width - 4);
  const args = asToolArgs(component.args);
  // omp leads this row with one alignment space (`default-renderer.ts`).
  const argsRow =
    Object.keys(args).length > 0
      ? dimRow(` ${TREE_LAST} ${formatArgsInline(args, Math.max(20, innerWidth - visibleWidth(TREE_LAST) - 2))}`)
      : undefined;
  // omp's default renderer shows this same inline row on settled collapsed
  // blocks; expanded, it switches to a labeled args tree. The one-line row
  // serves both states here — a deliberate simplification.
  const lead = argsRow ? [argsRow] : [];

  const text = component.isPartial ? undefined : toolResultText(component.result)?.trimEnd();
  if (!text) {
    // omp names the silence rather than drawing an empty block — but not when
    // images are the result, where there is nothing silent about it.
    const settledEmpty = !component.isPartial && component.result !== undefined && component.imageComponents.length === 0;
    if (settledEmpty) return [...lead, dimRow("(no output)")];
    return argsRow ? lead : undefined;
  }

  const expanded = component.expanded;
  if (JSON_DOCUMENT_LEAD.test(text)) {
    // The cached rows embed preset glyphs, so the preset is part of the key;
    // a hit also skips re-parsing the (possibly large) result on every repaint.
    const key = `${glyphPreset} ${expanded ? 1 : 0} ${text}`;
    let treeRows = jsonTreeCache.get(key);
    if (treeRows === undefined) {
      treeRows = buildJsonTreeRows(text, expanded);
      evictOldest(jsonTreeCache, JSON_TREE_CACHE_MAX);
      jsonTreeCache.set(key, treeRows);
    }
    // An empty entry is the cached "not a document" verdict — unparseable
    // text (JSON cut by truncation) or an empty document — and falls through
    // to the raw window exactly as omp's renderer does.
    if (treeRows.length > 0) {
      // omp's cells wrap overlong rows; this frame's renderer truncates, so
      // wrap here — after the cache, which stays width-independent — or an
      // expanded 2000-char scalar would be unviewable in the one state meant
      // to show it.
      return new Text([...lead, ...treeRows].join("\n"), 0, 0).render(innerWidth);
    }
  }

  // Uncached: the window itself is a slice of a few lines, and the sanitize
  // that feeds it already dominates the call whether or not this is memoized.
  return [...lead, ...buildTextWindowRows(text, expanded, innerWidth)];
}

/** Structural view of the patched component (the compiled class fields are public). */
interface FramedToolComponent {
  render: (width: number) => string[];
  hideComponent: boolean;
  hasRendererDefinition(): boolean;
  getCallRenderer(): unknown;
  getResultRenderer(): unknown;
  getRenderShell(): string;
  // `bgFn` is declared private in Box's .d.ts but is a plain public field at
  // runtime; Box itself samples it to validate its own cache.
  contentBox: { render(width: number): string[]; bgFn?: (text: string) => string };
  contentText: { render(width: number): string[] };
  /** Where pi puts the tool's own component when `renderShell` is `"self"`. */
  selfRenderContainer: { render(width: number): string[] };
  args?: unknown;
  /** The tool's own definition, when pi has one — its `label` is the name the
   * tool chose for itself. */
  toolDefinition?: { label?: unknown };
  callRendererComponent?: RenderableToolPart;
  resultRendererComponent?: RenderableToolPart;
  imageComponents: { render(width: number): string[] }[];
  imageSpacers: { render(width: number): string[] }[];
  isPartial: boolean;
  executionStarted: boolean;
  /** `expanded` is pi's Ctrl+O toggle; the collapsed previews below key off it. */
  expanded: boolean;
  result?: { isError?: boolean; content?: unknown; details?: unknown };
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
  /** Bitmask of the render-affecting flags; see `framedRender`. */
  flags: number;
  glyphPreset: GlyphPreset;
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

    const profile = TOOL_PROFILES.get(this.toolName);
    // A tool that draws its own shell keeps it, unless its profile says the
    // shell is one we can frame.
    const selfRendered = this.hasRendererDefinition() && this.getRenderShell() === "self";
    if (selfRendered && profile?.frameSelfRendered !== true) {
      return originalRender.call(this, width);
    }

    // The call renderer is what the section layout draws; a transcript replayed
    // after its extension was uninstalled has none, and falls back to the box.
    const sections = profile?.sections === true && this.callRendererComponent !== undefined;

    // Raw, reference-stable inputs. When nothing changed, pi's component
    // caches hand back identical line arrays, so the memo below skips all
    // framing work and returns the previous output array.
    //
    // The section branch deliberately does not render `contentBox`. Its children
    // are the very same call/result components framed below at `width - 4`, and
    // their caches key on a single width — rendering the box at `width` too
    // makes the two calls invalidate each other, so every frame re-wraps the
    // whole command output twice. Only the background tint is needed from the
    // box, and probing `bgFn` yields it in constant time.
    let boxLines: string[] | undefined;
    let rawCall: readonly string[];
    let rawResult: readonly string[];
    if (sections) {
      const innerWidth = Math.max(1, width - 4);
      rawCall = renderToolPart(this.callRendererComponent, innerWidth);
      rawResult = this.resultRendererComponent
        ? renderToolPart(this.resultRendererComponent, innerWidth)
        : [];
    } else {
      boxLines = selfRendered
        ? this.selfRenderContainer.render(width)
        : this.hasRendererDefinition()
          ? this.contentBox.render(width)
          : this.contentText.render(width);
      rawCall = boxLines;
      rawResult = [];
    }
    if (rawCall.length === 0 && rawResult.length === 0 && this.imageComponents.length === 0) return [];

    // `args` is not part of the memo key: the bash branch reads `args.command` and
    // `args.timeout`, and pi's call renderer derives its text from both, so any
    // change to either already shows up as changed `rawCall` lines. The one
    // exception is a falsy-but-present `timeout`, which the call renderer omits.
    //
    // A bitmask rather than a string: this is built for every tool block on every
    // frame, before the memo can short-circuit, and the template literal it
    // replaces cost ~24us per frame across 500 blocks. `toolName` needs no
    // comparing — the memo is keyed on the component, which never changes tool.
    const flags =
      (this.isPartial ? 1 : 0) |
      (this.executionStarted ? 2 : 0) |
      (this.result?.isError ? 4 : 0) |
      (this.expanded ? 8 : 0) |
      // Collapsed previews are sized from the terminal height, and a
      // vertical-only resize changes no other memo key, so the window rides
      // along in the high bits — already clamped to 10 bits at the source, so
      // the memoed value and the used depth cannot diverge.
      (previewWindowRows() << 4);
    const memo = frameMemo.get(this);
    if (
      memo &&
      memo.width === width &&
      memo.flags === flags &&
      memo.glyphPreset === glyphPreset &&
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
      icon = this.executionStarted ? glyphs().status.running : glyphs().status.pending;
      iconColor = this.executionStarted ? HEX_TOOL.accent : HEX_TOOL.dim;
    } else if (this.result?.isError) {
      icon = glyphs().status.error;
      iconColor = HEX_TOOL.error;
    } else {
      icon = profile?.iconless ? "" : (glyphs().tool[this.toolName] ?? ICON.model);
      iconColor = HEX_TOOL.accent;
    }

    const iconPrefix = icon ? `${fgAnsi(iconColor)}${icon}${FG_RESET} ` : "";
    const header = `${iconPrefix}${fgAnsi(HEX_TOOL.accent)}${toolHeaderTitle(this)}${FG_RESET}`;
    // `theme.bg()` returns `<bg-ansi><text>\x1b[49m`, so an empty probe carries
    // the same background prefix a rendered box row would.
    const barBg = boxLines
      ? extractBgAnsi(boxLines[0] ?? "")
      : extractBgAnsi(this.contentBox.bgFn?.("") ?? "");

    const lines: string[] = [];
    let framed = true;
    if (sections) {
      // omp's bash renderer intentionally has no tool-title header. Its command
      // is the first section, followed by a labeled Output divider once a
      // result exists. Render pi's call/result components independently to
      // remove the Box's vertical padding and preserve that structure. A tool
      // that leads with something other than a command keeps its header.
      const callLines = renderCommandLines(rawCall, profile, this.args, this.expanded);
      const retailed = !this.expanded && profile?.output
        ? retailOutputRows(rawResult, profile, this, width)
        : rawResult;
      const resultLines = profile?.wall
        ? profile.wall(stripRows(retailed), asToolArgs(this.args))
        : retailed;
      lines.push(buildFrameBar(width, "top", profile?.headerless ? "" : header, borderColor, barBg));
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
      //
      // A renderer-less tool with a document body earns its frame even when pi
      // drew a single row: its pending fallback is one bare name row, and the
      // one-line bullet would hide the args line omp's call view shows.
      const defaultBody = renderDefaultToolBody(this, width);

      // pi writes a tool's call as one logical line and its content after a
      // blank one, so the call is the leading run of non-blank rows — however
      // many rows pi-tui wrapped it across. A long path routinely takes three,
      // and reading only the first row used to leave the target unfound: no
      // name in the header, the path spelled across the body, and every
      // rebuild below skipped because the call row was never claimed.
      //
      // The run is cut where the call's own text ends, so a renderer that puts
      // content straight under its call without pi's blank line leaves those
      // rows behind rather than having them swallowed — what is left short of
      // the end is what forbids the single-row collapse below.
      const profilePath = profile?.contentPath?.(asToolArgs(this.args));
      const profileName = profilePath === undefined ? profile?.target?.(asToolArgs(this.args)) : undefined;
      const profileTarget = profilePath ?? profileName;
      const profileSuffix = profileTarget ? (profile?.targetSuffix?.(asToolArgs(this.args)) ?? "") : "";
      let runEnd = first;
      while (runEnd < last && !isBlankRenderedLine(rawCall[runEnd])) runEnd++;
      const call = callRunEnd(rawCall, first, runEnd, this.toolName, profileTarget, profileSuffix, profileName !== undefined);
      const callEnd = call.end;
      let bodyStart = callEnd;
      while (bodyStart < last && isBlankRenderedLine(rawCall[bodyStart])) bodyStart++;

      // A call the walk recognized is named from `args`, so the header reads
      // the same whether or not the row wrapped — and reads it omp's way,
      // relative to the directory the session is in, where pi spells it from
      // home. Everything else falls back to the row, and a row that wrapped
      // holds only half its target, so hoisting is declined rather than
      // tearing the call across the header and the body. pi spells some reads
      // its own way (`read resource …`, `[skill] …`), which is exactly the
      // case that lands here.
      // A call the walk did not recognize can still be named when it occupies
      // exactly one row: there is no second row of it to leave behind, so
      // nothing can be torn. That is what gives pi's own spellings — a
      // `[skill] …` read among them — their file name back.
      // A body of nothing but blank rows leaves `first` past the end, and
      // reading that row threw — which the guard turned into a session with no
      // framing at all rather than a crash, but neither is the intent.
      const callRow = first < last ? rawCall[first] : "";
      // A predicted name is trusted only as far as the walk confirmed it.
      // `contentPath` keeps the older allowance — a single-row call the walk
      // could not parse is still named from `args`, because pi writes those
      // rows itself and a one-row call leaves nothing behind to contradict the
      // header. A `target` gets no such allowance: it predicts a foreign
      // renderer's spelling, so an unconfirmed one falls back to the row, which
      // cannot be wrong about what the row said.
      const named = profilePath
        ? call.matched || runEnd === first + 1
          ? `${displayToolPath(profilePath)}${profileSuffix}`
          : undefined
        : call.matched && profileName !== undefined
          ? `${profileName}${profileSuffix}`
          : undefined;
      const target = named ?? (runEnd > first + 1 ? "" : toolCallRowTarget(callRow, this.toolName));
      // omp marks a path target with a glyph in `muted`, one per filetype;
      // this carries the one file glyph rather than a devicon table.
      const targetGlyph = profilePath && target ? `${fgAnsi(HEX.overlay1)}${glyphs().node.scalar}${FG_RESET} ` : "";
      const title = toolHeaderTitle(this);
      // Nothing but the call line: omp draws that as a single row, whatever
      // number of rows pi needed for it.
      const callOnly = bodyStart >= last && target !== "";

      framed =
        defaultBody !== undefined ||
        (!callOnly && last - first !== 1) ||
        glyphs().tool[this.toolName] !== undefined ||
        this.result?.isError === true ||
        this.imageComponents.length > 0;

      if (framed) {
        // omp names the target in the header — `Write: note.txt` — rather than
        // repeating it as the first row of the body. Hoist pi's call rows when
        // there is a target, but only if real content is left behind: an empty
        // frame is worse than a repeated target.
        let framedHeader = header;
        // A renderer-less tool's body is rebuilt as omp's document view, args
        // included — hoisting pi's call row would put the raw args JSON in the
        // header the rebuild just cleaned up.
        if (target && !defaultBody && bodyStart < last) {
          // omp leaves the colon on the default foreground, not the label's.
          // The bar clips its label from the end, so a long path would lose the
          // file name; give it a target that already fits, elided in the middle.
          const headerRoom = width - 10 - visibleWidth(stripAnsi(`${iconPrefix}${title}`)) - (targetGlyph ? 2 : 0);
          const headerTarget = clipMiddle(target, Math.max(1, headerRoom));
          framedHeader = `${iconPrefix}${fgAnsi(HEX_TOOL.accent)}${title}${FG_RESET}: ${targetGlyph}${fgAnsi(HEX_TOOL.accent)}${headerTarget}${FG_RESET}`;
        } else {
          bodyStart = first;
        }

        // The body is stripped once and shared by the summary badge and the
        // diff detection below; both only run on a memo miss.
        let strippedBody: readonly StrippedRow[] | undefined;
        const body = (): readonly StrippedRow[] => {
          strippedBody ??= stripRows(rawCall.slice(bodyStart, last));
          return strippedBody;
        };
        // omp closes the header with a dim count of what the tool touched.
        const summary = profile?.summary?.(asToolArgs(this.args), body);
        if (summary) framedHeader += ` ${summary}`;

        lines.push(buildFrameBar(width, "top", framedHeader, borderColor, barBg));
        // A profiled content body is rebuilt as omp's write cell — but only
        // once the header hoist has claimed the call row, so the rebuild can
        // never swallow it. A body carrying pi diff rows gets omp's row
        // treatment instead. The badge above counts the untreated rows, so it
        // always reports the full diff. Diff qualification needs one numbered
        // change row, which file content shown by other tools can in principle
        // contain — the cost there is a stray indent glyph, the same
        // cheap-to-be-wrong trade the badge makes.
        // A failed edit appends its error text after the diff rows; the cap
        // must not push that text behind the marker, so failure renders uncapped.
        const diffUncapped = this.expanded || this.result?.isError === true;
        const treatedBody =
          defaultBody ??
          (bodyStart !== first ? renderContentBody(profile, this, width) : undefined) ??
          (bodyLooksLikeDiff(body())
            ? renderDiffBody(body(), diffUncapped, this.isPartial, profileLanguage(profile, this.args))
            : undefined);
        if (treatedBody) {
          for (const row of treatedBody) lines.push(frameBodyRow(row, width, borderColor, barBg));
        } else {
          for (let i = bodyStart; i < last; i++) {
            lines.push(frameBodyRow(rawCall[i], width, borderColor, barBg));
          }
        }
      } else {
        lines.push(renderToolOneLine(target, title, width));
        const preview = renderResultPreview(profile, this, width);
        if (preview) lines.push(...preview);
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
    frameMemo.set(this, { width, flags, glyphPreset, rawCall, rawResult, imageKey: this.imageComponents, lines });
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
        state: safeProbe(() => `partial=${this.isPartial} started=${this.executionStarted} error=${this.result?.isError} expanded=${this.expanded}`),
        // Which of the fields the patch depends on are actually present.
        "members present": safeProbe(() =>
          (["contentBox", "contentText", "callRendererComponent", "resultRendererComponent", "imageComponents", "imageSpacers", "args", "expanded", "result"] as const)
            .map(name => `${name}=${this[name] === undefined ? "missing" : "ok"}`)
            .join(" ")),
      });
      return originalRender.call(this, width);
    }
  } as typeof proto.render;
}

// ═══════════════════════════════════════════════════════════════════════════
// Widgets other extensions mount
//
// pi lets an extension mount a component above or below the editor, and one
// showing background work uses that to say what is still running. Those rows
// carry a spinner, but not a moving one: the glyph is picked by hashing the
// work's own counters, so it holds still while a child thinks and then jumps
// several frames at once when a burst of activity lands. omp animates on a
// clock, and a clock is the only thing that can fix this — repainting more
// often cannot move a glyph that is a function of counters rather than time.
//
// So the rows are decorated on their way out: the spinner is re-picked from
// elapsed time, and the label beside it carries omp's band. Everything past
// the label keeps whatever colours its own extension chose — the status word,
// the model, the counts. A row that does not open with one of those spinner
// glyphs comes back untouched, which is what leaves every other widget, and
// every settled row of this one, exactly as it was.

/** The glyphs a live row opens with. omp's own braille cycle, which is why
 * substituting our frame changes nothing but the timing. */
const WIDGET_SPINNER_GLYPHS = new Set(OMP_WORKING_FRAMES);

/** Widgets whose rows this knows the shape of, by the key pi mounts them under.
 *
 * An allowlist rather than a shape test, because no shape test can do this job:
 * those spinner glyphs are ordinary braille dot patterns, so `⠇ queue · 3
 * pending` and `⠙ ⣀⣤⣶⣿ · mem` are indistinguishable from a status row by any
 * rule written about their characters — one is a spinner and one is a chart,
 * and both would be rewritten on every frame by a rule loose enough to catch
 * the first. The key is exact, and a widget this does not recognize is left
 * entirely alone, which is the right default for someone else's drawing. */
const ANIMATED_WIDGET_KEYS = new Set(["subagent-async", "subagent-fleet-status"]);

/** What may precede the glyph on a row this animates: indentation and the tree
 * drawing a widget uses to nest its children. Several agents at once put every
 * per-agent row behind a `├─`, and those are the rows most worth animating. */
const WIDGET_LEAD_CHARS = new Set([" ", "├", "└", "│", "┃", "─", "╭", "╰", "┌", "┘", "∟", "⎿"]);

/** What ends a widget label and begins its statistics. */
const WIDGET_LABEL_END = " · ";

/** Past this a label is a sentence rather than a name, and omp does not sweep
 * sentences. Such a row keeps its own colours. */
const WIDGET_LABEL_MAX_CELLS = 48;

/** omp's band over a run of text, positioned in cells rather than picked from a
 * precomputed list. The working line can precompute — its label holds still for
 * a whole turn — but a widget's label changes with the work it names, so this
 * takes the position from the clock and colours one pass.
 *
 * There is no seamlessness to arrange here either, which is why the gap is
 * omp's plain ten rather than the searched one: a continuous position modulo
 * the period re-enters smoothly whatever the period is. */
function shimmerRun(text: string, accent: string, position: number): string {
  let cell = 0;
  return graphemeCells(text)
    .map(cluster => {
      const intensity = shimmerIntensity(Math.abs(cell + SHIMMER_PADDING_PREFERRED - position));
      cell += visibleWidth(cluster);
      const color =
        intensity >= SHIMMER_TIER_HIGH ? accent : intensity >= SHIMMER_TIER_MID ? HEX.overlay1 : HEX.overlay0;
      const bold = intensity >= SHIMMER_TIER_HIGH ? "\x1b[1m" : "";
      const boldReset = intensity >= SHIMMER_TIER_HIGH ? "\x1b[22m" : "";
      return `${bold}${fgAnsi(color)}${cluster}${FG_RESET}${boldReset}`;
    })
    .join("");
}

/** The same sequences `stripAnsi` knows, matched at a position. The two must
 * agree: one counts the plain characters, the other finds the byte they start
 * at, and a sequence only one of them recognizes puts the cut in the wrong
 * place. A CSI-only pattern here used to miss an OSC hyperlink. */
const ANSI_SEQUENCE_AT = new RegExp(ANSI_SEQ.source, "y");

/** A hyperlink or a terminal marker, which a rebuilt head would drop the
 * opening half of. Cheaper to leave such a row undecorated than to carry it. */
const OSC_OR_APC = /\x1b[\]_]/;

/** How many agents another extension last said were running, and when it said
 * so. omp carries this on its status line (`subagentsSegment`), and pi has no
 * equivalent — but the widget already spells it out in prose, and we are
 * reading those rows anyway. Reading its own words back is self-verifying: if
 * it stops saying this, or says it differently, the segment simply stops
 * appearing rather than showing a number invented from row shapes. */
let observedAgentCount = 0;

/** The wording, from the row a subagent widget closes with. */
const WIDGET_AGENT_COUNT = /(\d+)\s+active\s+agents?\b/;

function noteAgentCount(rows: readonly string[]): void {
  for (const row of rows) {
    const seen = WIDGET_AGENT_COUNT.exec(stripAnsi(row));
    if (!seen) continue;
    const count = Number(seen[1]);
    if (count === observedAgentCount) return;
    observedAgentCount = count;
    // The bar caches on width alone, so a segment whose value changed without
    // saying so would never be drawn again. Only on a real change: this runs
    // for every widget frame, and invalidating 25 times a second would throw
    // away the cache the bar exists to keep.
    activeFooter?.invalidate();
    // The bar is the editor's top border, and the widget saying this can be
    // mounted on either side of the editor — below it, pi has already drawn the
    // bar by the time these rows arrive, so the new count would sit unpainted
    // until something unrelated asked for a frame. Which side a foreign widget
    // picks is not ours to know, so ask for the frame either way.
    activeTui?.requestRender();
    return;
  }
}

function activeAgentCount(): number {
  return observedAgentCount;
}

/** The widget going away is the end of the work it was counting. That is an
 * event this can see, where time passing is not — and the bar caches, so a
 * count that expired on a clock would sit there until something else redrew. */
function forgetAgentCount(): void {
  if (observedAgentCount === 0) return;
  observedAgentCount = 0;
  activeFooter?.invalidate();
}

/** Any control character but ESC. A row carrying one does not occupy the single
 * terminal line pi accounted for — a newline or a tab in a tool preview is the
 * usual way that happens — so the rows below it are already displaced. Nothing
 * here can repair that, but repainting over it stacks another copy every frame,
 * which turns one displaced row into a trail of them. */
const CONTROL_IN_ROW = /[\u0000-\u001a\u001c-\u001f\u007f]/;

/** Where the `index`-th plain character starts, in bytes. */
function ansiOffsetOf(row: string, index: number): number {
  let plain = 0;
  let cursor = 0;
  while (cursor < row.length && plain < index) {
    ANSI_SEQUENCE_AT.lastIndex = cursor;
    if (ANSI_SEQUENCE_AT.exec(row)) {
      cursor = ANSI_SEQUENCE_AT.lastIndex;
      continue;
    }
    cursor += (row.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1;
    plain++;
  }
  return cursor;
}

/** The row up to `index` plain characters, kept as it was drawn — the tree a
 * widget nests its children with is that widget's, not ours, so it keeps its
 * own colour. Closed with a reset so the spinner after it carries ours. */
function ansiHeadTo(row: string, index: number): string {
  const head = row.slice(0, ansiOffsetOf(row, index));
  return head.includes("\x1b") ? `${head}${FG_RESET}` : head;
}

/** The row from `index` plain characters in, raw. The head it replaces is
 * rebuilt and closed with a reset, and these rows open and close every colour
 * in place, so the tail needs no state carried into it. */
function ansiTailFrom(row: string, index: number): string {
  return row.slice(ansiOffsetOf(row, index));
}

/** One widget row with omp's clock over it, or `undefined` when this is not a
 * row that says work is happening. */
function decorateWidgetRow(row: string, accent: string, elapsedMs: number): string | undefined {
  // A hyperlink or a terminal marker in the label would be rebuilt without its
  // opening sequence — the text and the width survive, but the link does not.
  // Leaving such a row alone costs an animation; rewriting it costs a feature
  // of somebody else's widget.
  if (OSC_OR_APC.test(row)) return undefined;
  const chars = [...stripAnsi(row)];
  let glyph = 0;
  while (glyph < chars.length && WIDGET_LEAD_CHARS.has(chars[glyph]!)) glyph++;
  if (glyph >= chars.length || !WIDGET_SPINNER_GLYPHS.has(chars[glyph]!)) return undefined;

  // Two more things have to hold before this counts as a status row. These
  // glyphs are ordinary braille dot patterns — the usual medium for a terminal
  // sparkline — so a chart drawn with them would otherwise have its first cell
  // overwritten by a spinner frame on every repaint, and would hold the clock
  // on forever besides. A spinner is followed by a space, and the row carries
  // the tool's own ` · ` before its statistics; a drawing does neither.
  if (chars[glyph + 1] !== " ") return undefined;
  let start = glyph + 1;
  while (start < chars.length && chars[start] === " ") start++;
  const rest = chars.slice(start).join("");
  const cut = rest.indexOf(WIDGET_LABEL_END);
  if (cut === -1) return undefined;
  const label = rest.slice(0, cut).trimEnd();
  if (label.length === 0 || visibleWidth(label) > WIDGET_LABEL_MAX_CELLS) return undefined;

  const spinner = OMP_WORKING_FRAMES[Math.floor(elapsedMs / SPINNER_ADVANCE_MS) % OMP_WORKING_FRAMES.length]!;
  const period = visibleWidth(label) + 2 * SHIMMER_PADDING_PREFERRED;
  const position = ((elapsedMs / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
  const head =
    `${ansiHeadTo(row, glyph)}${fgAnsi(accent)}${spinner}${FG_RESET}` +
    `${" ".repeat(start - glyph - 1)}${shimmerRun(label, accent, position)}${FG_RESET}`;
  const decorated = `${head}${ansiTailFrom(row, start + [...label].length)}`;
  // These rows are padded to the width pi rendered them at, and pi kills the
  // TUI over a row wider than the terminal. A replacement that is not the same
  // width as what it replaced is declined rather than reasoned about.
  return visibleWidth(decorated) === visibleWidth(row) ? decorated : undefined;
}

interface WidgetHost {
  requestRender?(force?: boolean): void;
}

type PatchableInteractive = { __ompWidgetAnimated?: boolean };

/** Components already carrying the decorated `render`, so a factory that hands
 * back a cached object is not wrapped again on every remount. */
const wrappedWidgets = new WeakSet<object>();

let widgetAnimationDisabled = false;
let widgetTicker: ReturnType<typeof setInterval> | undefined;
/** One epoch for every widget, so two live rows sweep in step rather than each
 * from whenever its own component happened to be built. */
const widgetEpoch = Date.now();

/** When a live row was last drawn. The clock is driven by this stamp rather
 * than by the outcome of whichever render happened last, because neither of the
 * two obvious signals is reliable:
 *
 * pi renders every mounted widget within a single frame, so a widget with
 * nothing running would otherwise stop the clock that the live widget beside it
 * had just started — one extension mounting a second component widget was
 * enough to freeze the animation entirely.
 *
 * And a widget can leave without its owner saying so: `clearExtensionWidgets`
 * empties pi's maps directly, so the last thing this sees is a live row, and a
 * clock stopped only by a later render would run forever over an empty screen.
 * A stamp going stale covers both, and covers whatever third path exists. */
let widgetLiveAt = 0;

/** How long after the last live row the clock keeps running. Two frames of
 * slack, so a repaint that happens to land between widget renders does not
 * chop the animation. */
const WIDGET_LIVE_GRACE_MS = WORKING_FRAME_MS * 3;

function startWidgetTicker(host: WidgetHost): void {
  if (widgetTicker !== undefined) return;
  // The rows are only redrawn when something asks pi to render, and the
  // extension that owns them asks twice a second. omp's band moves at 30 cells
  // a second, so it has to be asked for on omp's clock instead.
  widgetTicker = setInterval(() => {
    if (Date.now() - widgetLiveAt > WIDGET_LIVE_GRACE_MS) {
      // Ask for one more frame on the way out. The stamp also goes stale when
      // the event loop was simply blocked for longer than the grace — a large
      // read, a long highlight — and stopping silently there would leave live
      // work unanimated until something else happened to render. A render
      // re-stamps if anything is still live, and costs one frame if not.
      host.requestRender?.();
      stopWidgetTicker();
      return;
    }
    host.requestRender?.();
  }, WORKING_FRAME_MS);
  widgetTicker.unref?.();
}

function stopWidgetTicker(): void {
  if (widgetTicker === undefined) return;
  clearInterval(widgetTicker);
  widgetTicker = undefined;
}

/** Decorate a widget's rows, and stamp the clock if any of them was live. */
function animateWidgetRows(rows: string[], host: WidgetHost): string[] {
  noteAgentCount(rows);
  // One malformed row disqualifies the whole widget, not just itself: the
  // damage is to the rows below it, and those are the ones a repaint would
  // duplicate. Leaving the widget alone lets its own extension settle it.
  if (rows.some(row => CONTROL_IN_ROW.test(row))) {
    stopWidgetTicker();
    return rows;
  }
  const elapsed = Date.now() - widgetEpoch;
  const accent = currentCtx ? workingAccent(currentCtx) : HEX.peach;
  let live = 0;
  const decorated = rows.map(row => {
    const swept = decorateWidgetRow(row, accent, elapsed);
    if (swept === undefined) return row;
    live++;
    return swept;
  });
  if (live > 0) {
    widgetLiveAt = Date.now();
    startWidgetTicker(host);
  }
  return decorated;
}

function patchWidgetAnimation(): void {
  const proto = InteractiveMode.prototype as unknown as PatchableInteractive & {
    setExtensionWidget(key: string, content: unknown, options?: unknown): void;
  };
  if (proto.__ompWidgetAnimated) return;
  proto.__ompWidgetAnimated = true;

  const original = proto.setExtensionWidget;
  proto.setExtensionWidget = function (this: unknown, key: string, content: unknown, options?: unknown): void {
    // A widget given as plain rows is a fixed list pi wraps itself; there is no
    // render of ours to sit in front of, and nothing there animates anyway.
    if (widgetAnimationDisabled || typeof content !== "function" || !ANIMATED_WIDGET_KEYS.has(key)) {
      if (content === undefined) {
        stopWidgetTicker();
        if (ANIMATED_WIDGET_KEYS.has(key)) forgetAgentCount();
      }
      return original.call(this, key, content, options);
    }
    const factory = content as (host: WidgetHost, theme: unknown) => { render(width: number): string[] };
    const wrapped = (host: WidgetHost, theme: unknown): { render(width: number): string[] } => {
      const component = factory(host, theme);
      // A factory is free to hand back the same object every time — an
      // extension keeping widget state across remounts does exactly that — and
      // wrapping an already-wrapped component would bind the previous wrapper
      // and add a layer per remount, until the call depth or the frame budget
      // gave out. The existing wrapper already animates it, so leave it be.
      if (wrappedWidgets.has(component)) return component;
      // The component is handed back as it was built, with only its `render`
      // replaced: pi may call anything else the owning extension put on it.
      const innerRender = component.render.bind(component);
      const animated = (width: number): string[] => {
        const rows = innerRender(width);
        if (widgetAnimationDisabled) return rows;
        try {
          return animateWidgetRows(rows, host);
        } catch (error) {
          widgetAnimationDisabled = true;
          stopWidgetTicker();
          reportDegraded("widget-animation", error, {
            width,
            key,
            rows: rows.length,
            "first row": safeProbe(() => JSON.stringify(stripAnsi(rows[0] ?? "").slice(0, 80))),
          });
          return rows;
        }
      };
      // A component whose `render` cannot be written to — frozen, or defined as
      // a getter — mounts perfectly well without this, so failing to decorate it
      // must cost nothing. Throwing here would take away a widget pi was going
      // to draw, which is a worse outcome than an unanimated one.
      try {
        component.render = animated;
        wrappedWidgets.add(component);
      } catch {
        return component;
      }
      return component;
    };
    return original.call(this, key, wrapped, options);
  };
}

const GLYPH_PRESET_NAMES: readonly GlyphPreset[] = ["nerd", "unicode"];

// One command named after the extension, with the setting as a subcommand, so
// everything it exposes stays under a single discoverable prefix rather than
// claiming a top-level name per feature. Flags are flat, so that one carries the
// setting in its name — matching how pi's bundled extensions namespace theirs.
const COMMAND_NAME = "omp-feel";
const GLYPH_SUBCOMMAND = "glyphs";
const WORDS_SUBCOMMAND = "words";
const CYCLE_SUBCOMMAND = "cycle";
const WORDS_VALUES = ["on", "off"] as const;
const CYCLE_VALUES: readonly SpinnerCycle[] = ["category", "random"];
const GLYPH_FLAG = "omp-feel-glyphs";
const GLYPH_STATUS_KEY = "omp-feel-glyphs";

export default function ompFeelExtension(pi: ExtensionAPI) {
  patchToolCallFraming();
  patchWidgetAnimation();
  loadSettings();

  pi.registerFlag(GLYPH_FLAG, {
    type: "string",
    description: `Glyph preset for omp styling: ${GLYPH_PRESET_NAMES.join(" or ")}`,
  });

  pi.registerCommand(COMMAND_NAME, {
    description:
      `omp styling settings — ${GLYPH_SUBCOMMAND} <${GLYPH_PRESET_NAMES.join("|")}>` +
      ` · ${WORDS_SUBCOMMAND} <${WORDS_VALUES.join("|")}> · ${CYCLE_SUBCOMMAND} <${CYCLE_VALUES.join("|")}>`,
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trimStart();
      const value = (name: string, current: boolean): AutocompleteItem => ({
        value: name,
        label: name,
        description: current ? "current" : "",
      });
      // Once a subcommand is typed, only its own values remain.
      const sub = (name: string, values: readonly string[], current: string): AutocompleteItem[] | undefined => {
        if (!prefix.startsWith(`${name} `)) return undefined;
        const rest = prefix.slice(name.length + 1).trimStart();
        return values.filter(v => v.startsWith(rest)).map(v => value(v, v === current));
      };
      const wordsState = spinnerWordsEnabled ? "on" : "off";
      return (
        sub(GLYPH_SUBCOMMAND, GLYPH_PRESET_NAMES, glyphPreset) ??
        sub(WORDS_SUBCOMMAND, WORDS_VALUES, wordsState) ??
        sub(CYCLE_SUBCOMMAND, CYCLE_VALUES, spinnerCycle) ?? [
          // Before that, the subcommands, plus the presets on their own so
          // `/omp-feel nerd` keeps working as the shorthand it always was.
          ...[
            [GLYPH_SUBCOMMAND, glyphPreset],
            [WORDS_SUBCOMMAND, wordsState],
            [CYCLE_SUBCOMMAND, spinnerCycle],
          ]
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, state]) => ({ value: `${name} `, label: name, description: `currently ${state}` })),
          ...GLYPH_PRESET_NAMES.filter(name => name.startsWith(prefix)).map(name => value(name, name === glyphPreset)),
        ]
      );
    },
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = words[0]?.toLowerCase();

      if (subcommand === WORDS_SUBCOMMAND) {
        const choice = words[1]?.toLowerCase() ?? (spinnerWordsEnabled ? "off" : "on");
        if (choice !== "on" && choice !== "off") {
          ctx.ui.setStatus(GLYPH_STATUS_KEY, `omp-feel: say \`${WORDS_SUBCOMMAND} on\` or \`${WORDS_SUBCOMMAND} off\``);
          return;
        }
        spinnerWordsEnabled = choice === "on";
        spinnerQueue = [];
        // Felt at once, either way: turning it off mid-turn should quiet the
        // line rather than leave the last joke sitting there. Turning it on at
        // an idle prompt spends nothing — the next turn draws its own.
        if (agentWorking || !spinnerWordsEnabled) refreshSpinnerWord();
        if (currentCtx?.mode === "tui" && currentCtx.hasUI) configureWorkingIndicator(currentCtx);
        if (spinnerWordsEnabled) startSpinnerRotation();
        else stopSpinnerRotation();
        activeTui?.requestRender();
        saveSettings();
        ctx.ui.setStatus(
          GLYPH_STATUS_KEY,
          spinnerWordsEnabled
            ? `omp-feel: spinner words on — ${SPINNER_CATEGORY_NAMES.length} themes, cycling by ${spinnerCycle}`
            : "omp-feel: spinner words off — back to Working…",
        );
        return;
      }

      if (subcommand === CYCLE_SUBCOMMAND) {
        const choice = words[1]?.toLowerCase();
        if (!isSpinnerCycle(choice)) {
          ctx.ui.setStatus(GLYPH_STATUS_KEY, `omp-feel: cycle is ${CYCLE_VALUES.join(" or ")}`);
          return;
        }
        spinnerCycle = choice;
        spinnerQueue = [];
        saveSettings();
        ctx.ui.setStatus(
          GLYPH_STATUS_KEY,
          choice === "category"
            ? "omp-feel: cycling one theme at a time"
            : "omp-feel: picking from every theme at random",
        );
        return;
      }

      if (subcommand === GLYPH_SUBCOMMAND) words.shift();

      // Nothing left to act on opens pi's own picker, so the setting is reachable
      // without having to remember the preset names.
      const chosen = words.length > 0
        ? words[0]
        : await ctx.ui.select("omp glyph preset", [...GLYPH_PRESET_NAMES]);
      if (chosen === undefined) return;
      if (!isGlyphPreset(chosen)) {
        ctx.ui.setStatus(
          GLYPH_STATUS_KEY,
          `omp-feel: unknown glyph preset "${sanitizeStatusText(chosen)}" — try ${GLYPH_PRESET_NAMES.join(" or ")}`,
        );
        return;
      }
      ctx.ui.setStatus(GLYPH_STATUS_KEY, undefined);
      applyGlyphPreset(chosen);
    },
  });

  // Another extension naming what it is waiting on — see ACTIVITY_CHANNEL.
  pi.events?.on?.(ACTIVITY_CHANNEL, (data: unknown) => {
    const raw = (data as { label?: unknown } | undefined)?.label;
    const next =
      typeof raw === "string" && raw.trim().length > 0
        ? clipPlain(sanitizeStatusText(raw), workingLabelMaxWidth())
        : undefined;
    if (next === activityLabel) return;
    activityLabel = next;
    if (currentCtx && currentCtx.mode === "tui" && currentCtx.hasUI) {
      // Also re-clears pi's own message slot, so a sender that set both does not
      // get its label rendered twice.
      configureWorkingIndicator(currentCtx);
    }
  });

  pi.on("session_start", (_event, ctx) => {
    // A flag applies to this run only, so it is not written back to the file.
    const flag = pi.getFlag(GLYPH_FLAG);
    if (isGlyphPreset(flag)) glyphPreset = flag;
    currentCtx = ctx;
    // A session starting is not a turn, whatever the last one left running.
    agentWorking = false;
    stopSpinnerRotation();
    activeFooter = undefined;
    // Nor is it the session those agents were counted in. pi clears extension
    // widgets by emptying its own maps rather than by removing each one, so the
    // removal this would otherwise learn from never arrives and the count would
    // be carried into a session where nothing is running. Costs nothing if work
    // really is still live: the widget says so again on its next frame. Set
    // rather than forgotten — the bar it would invalidate is gone a line above.
    observedAgentCount = 0;
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
    // A word to start on, then a new one every few seconds until the work ends.
    agentWorking = true;
    refreshSpinnerWord();
    if (currentCtx?.mode === "tui" && currentCtx.hasUI) configureWorkingIndicator(currentCtx);
    startSpinnerRotation();
    activeTui?.requestRender();
  });
  pi.on("agent_end", () => {
    // Nothing to watch between turns.
    agentWorking = false;
    stopSpinnerRotation();
    activeTui?.requestRender();
  });
  pi.on("agent_settled", () => {
    // A run can settle without ending; either way there is nothing to watch.
    agentWorking = false;
    stopSpinnerRotation();
    activeTui?.requestRender();
  });
  pi.on("session_info_changed", () => {
    refreshSessionName(currentCtx);
    activeFooter?.invalidate();
    if (currentCtx?.mode === "tui" && currentCtx.hasUI) configureWorkingIndicator(currentCtx);
    activeTui?.requestRender();
  });

  pi.on("session_shutdown", () => {
    agentWorking = false;
    stopSpinnerRotation();
    stopWidgetTicker();
    observedAgentCount = 0;
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
    contextHighlightCache.clear();
    contentPreviewCache.clear();
    resultPreviewCache.clear();
    outputTailCache.clear();
    jsonTreeCache.clear();
  });
}

// Module-level because the tool-frame patch runs on a shared prototype with no
// access to a session context, and `reportDegraded` needs one to reach the
// footer. The extension already assumes a single session per process.
let currentCtx: ExtensionContext | undefined;
let activeTui: TUI | undefined;
let activeFooter: OmpFooter | undefined;
