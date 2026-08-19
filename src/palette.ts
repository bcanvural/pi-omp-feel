// ═══════════════════════════════════════════════════════════════════════════
// omp palettes. pi's Theme cannot express omp's `statusLine*`/`link` colors, so
// the status bar, tool frames, shell lexer and shimmer carry those fields here
// and `syncThemePalette` swaps them when pi changes theme — otherwise the
// extension's own chrome stays Catppuccin while the rest of the UI turns Ember.
//
// Slot names are historical: they are Catppuccin var names, because Catppuccin
// was the only palette at first. That is a trap. Two omp keys that happen to
// share a var in Catppuccin can diverge in another theme, and a slot serving
// both then cannot be right in both — `toolTitle`/`statusLineSubagents` and
// `statusLineContext`/`thinkingHigh` were exactly that bug. Any slot serving one
// omp key semantically is named for the key, not the var.
//
// `OMP_SLOT_KEYS` below is the mapping these values were verified against, kept
// as data so `tests/palette-parity.test.ts` can re-check every slot against
// omp's installed theme JSON instead of trusting a one-time manual audit.
// A new theme goes in with a matching entry, and the test finds the collisions.
// ═══════════════════════════════════════════════════════════════════════════

export const CATPPUCCIN_HEX = {
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
  context: "#cba6f7",
  // omp's `toolTitle` and `statusLineSubagents`. Both are `lavender` nowhere:
  // Catppuccin gives the count `peach`, and dark-ember leaves the title at the
  // default text colour, so they cannot share one slot.
  toolTitle: "#b4befe",
  subagents: "#fab387",
  shellVariable: "#cdd6f4",
  shellString: "#a6e3a1",
  shellKeyword: "#cba6f7",
  shellComment: "#6c7086",
  shellNumber: "#fab387",
  shellFunction: "#89b4fa",
};

export type OmpPalette = typeof CATPPUCCIN_HEX;

export const DARK_EMBER_HEX: OmpPalette = {
  // dark-ember statusLineBg / statusLineSep / borderMuted / dim / muted
  crust: "#2c313a",
  surface1: "#5c6370",
  surface0: "#4b5263",
  overlay0: "#5c6370",
  overlay1: "#abb2bf",
  overlay2: "#5c6370",
  // pi's default text is terminal-dependent; the theme's gray is the closest
  // stable equivalent for the explicit text used by the extension.
  text: "#abb2bf",
  peach: "#ff6f61",
  pink: "#ff6f61",
  teal: "#5f8dd3",
  green: "#98c379",
  yellow: "#e5c07b",
  // omp's `statusLineUntracked`, xterm 256 colour 39.
  sky: "#00afff",
  // omp colours the 70-90% context band with `thinkingHigh`, which dark-ember
  // resolves to its accent. Catppuccin hides the distinction by giving
  // `thinkingHigh` and `statusLineContext` the same mauve.
  mauve: "#ff6f61",
  // xterm 256 colour 205, used by omp for statusLineCost/statusLineOutput.
  maroon: "#ff5faf",
  blue: "#5f8dd3",
  sapphire: "#56b6c2",
  lavender: "#ff6f61",
  red: "#e06c75",
  context: "#abb2bf",
  // dark-ember's `toolTitle` is empty, i.e. the default text colour — the same
  // approximation `text` above makes. `statusLineSubagents` is the accent.
  toolTitle: "#abb2bf",
  subagents: "#ff6f61",
  shellVariable: "#56b6c2",
  shellString: "#e06c75",
  shellKeyword: "#5f8dd3",
  shellComment: "#abb2bf",
  shellNumber: "#98c379",
  shellFunction: "#e5c07b",
};

/** Which omp theme key each slot stands in for, and what the renderer uses it
 * for. `key` is a key in omp's `theme/defaults/*.json` `colors` object. */
export const OMP_SLOT_KEYS: ReadonlyArray<{ slot: keyof OmpPalette; key: string; use: string }> = [
  { slot: "crust", key: "statusLineBg", use: "status bar background" },
  { slot: "text", key: "text", use: "status bar base text" },
  { slot: "surface1", key: "statusLineSep", use: "status bar separators" },
  { slot: "pink", key: "statusLineModel", use: "model badge" },
  { slot: "teal", key: "statusLinePath", use: "cwd segment" },
  { slot: "green", key: "statusLineGitClean", use: "git branch, diff added" },
  { slot: "yellow", key: "statusLineGitDirty", use: "warning context band" },
  { slot: "red", key: "error", use: "error state, diff removed, context >=90%" },
  { slot: "maroon", key: "statusLineCost", use: "cost segment" },
  { slot: "mauve", key: "thinkingHigh", use: "context 70-90% band" },
  { slot: "context", key: "statusLineContext", use: "context normal band" },
  { slot: "toolTitle", key: "toolTitle", use: "one-line tool label, Output section bar" },
  { slot: "subagents", key: "statusLineSubagents", use: "running-subagent count" },
  { slot: "peach", key: "accent", use: "tool frame accent, pi icon, working accent" },
  { slot: "overlay0", key: "dim", use: "settled tool border, shell `$` prefix" },
  { slot: "surface0", key: "borderMuted", use: "settled write/edit border" },
  { slot: "overlay1", key: "muted", use: "muted text, shimmer mid" },
  { slot: "overlay2", key: "syntaxPunctuation", use: "shell punctuation" },
  // omp fills the gap with `border`, not `link`; `link` is dead in omp (absent
  // from its ThemeColor union and from 47 of its 97 shipped themes), so mapping
  // to it would fail the parity test for any theme that omits it.
  { slot: "blue", key: "border", use: "status bar gap default" },
  // omp's hint shimmer peaks on `borderAccent` (`modes/theme/shimmer.ts`
  // HINT_SHIMMER_PALETTE), where the label peaks on `accent`. Under dark-ember
  // both resolve to #ff6f61, so the two crests coincide — that is omp's own
  // doing, not a mistake here.
  { slot: "lavender", key: "borderAccent", use: "shimmer hint crest" },
  { slot: "sapphire", key: "thinkingMedium", use: "unused, kept for palette completeness" },
  { slot: "sky", key: "statusLineUntracked", use: "unused, kept for palette completeness" },
  { slot: "shellFunction", key: "syntaxFunction", use: "shell command and arguments" },
  { slot: "shellKeyword", key: "syntaxKeyword", use: "shell operators, pipes, `=`" },
  { slot: "shellString", key: "syntaxString", use: "shell quoted text, assignment values" },
  { slot: "shellVariable", key: "syntaxVariable", use: "shell variable names" },
  { slot: "shellComment", key: "syntaxComment", use: "shell comment text" },
  { slot: "shellNumber", key: "syntaxNumber", use: "shell redirection file descriptors" },
];

/** Slots that deliberately do not equal their omp key, with the reason. omp
 * leaves these empty, meaning the terminal's default foreground, which the
 * extension cannot reproduce because it always emits an explicit colour. */
export const APPROXIMATED_SLOTS: ReadonlyArray<{ slot: keyof OmpPalette; theme: string; why: string }> = [
  { slot: "text", theme: "omp-dark-catppuccin", why: "omp `text` is empty (terminal default)" },
  { slot: "text", theme: "omp-dark-ember", why: "omp `text` is empty (terminal default)" },
  { slot: "toolTitle", theme: "omp-dark-ember", why: "dark-ember `toolTitle` is empty (terminal default)" },
];

/** Slots that mirror no single omp key, with what they are instead. Declared so
 * the parity test can assert the set exactly rather than hardcoding it, and so a
 * new slot cannot skip the mapping table unnoticed. */
export const UNMAPPED_SLOTS: ReadonlyArray<{ slot: keyof OmpPalette; why: string }> = [
  // Empty on purpose: every slot currently mirrors an omp key. The list stays so
  // a slot added without a mapping fails the parity test loudly instead of
  // slipping past it, which is how `lavender` went unguarded for a while.
];

/** The extension palette for a pi theme name, or undefined for a theme it has
 * no omp palette for. */
export const PALETTES: Readonly<Record<string, OmpPalette>> = {
  "omp-dark-catppuccin": CATPPUCCIN_HEX,
  "omp-dark-ember": DARK_EMBER_HEX,
};
