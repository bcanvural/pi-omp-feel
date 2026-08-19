// Re-checks every extension palette slot against omp's own theme JSON, so the
// manual audit that produced these values cannot silently rot — and so a third
// theme cannot repeat the slot-collision bug that `toolTitle`/`statusLineSubagents`
// and `statusLineContext`/`thinkingHigh` were.
//
//   npm test
//
// Needs omp installed. Point OMP_THEME_DIR at `.../src/modes/theme/defaults` to
// override the search. Without omp the parity checks skip rather than fail — they
// cannot be evaluated, and a false pass is worse than an honest skip.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APPROXIMATED_SLOTS, CATPPUCCIN_HEX, DARK_EMBER_HEX, OMP_SLOT_KEYS, type OmpPalette, PALETTES, UNMAPPED_SLOTS } from "../src/palette.ts";

const OMP_THEME_DIRS = [
  process.env.OMP_THEME_DIR,
  join(homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/theme/defaults"),
  join(homedir(), ".npm-global/lib/node_modules/@oh-my-pi/pi-coding-agent/src/modes/theme/defaults"),
  "/opt/homebrew/lib/node_modules/@oh-my-pi/pi-coding-agent/src/modes/theme/defaults",
].filter((dir): dir is string => typeof dir === "string" && dir.length > 0);

/** Each extension theme and the omp default it mirrors. */
const THEMES = [
  { palette: "omp-dark-catppuccin", hex: CATPPUCCIN_HEX, omp: "dark-catppuccin.json", ours: "omp-dark-catppuccin.json" },
  { palette: "omp-dark-ember", hex: DARK_EMBER_HEX, omp: "dark-ember.json", ours: "omp-dark-ember.json" },
];

const XTERM_LEVELS = [0, 95, 135, 175, 215, 255];

/** omp writes some colors as bare xterm-256 indices. Only the 6x6x6 cube and the
 * grayscale ramp are handled: omp's `ansi256ToHex` also maps the low 16, but no
 * shipped omp theme uses an index below 28, and guessing a terminal's basic
 * palette would be worse than refusing. */
function xtermHex(index: number): string {
  if (index < 16) throw new Error(`xterm index ${index} is a basic colour, whose hex is terminal-defined`);
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return `#${[gray, gray, gray].map(c => c.toString(16).padStart(2, "0")).join("")}`;
  }
  const n = index - 16;
  const channels = [XTERM_LEVELS[Math.floor(n / 36)], XTERM_LEVELS[Math.floor((n % 36) / 6)], XTERM_LEVELS[n % 6]];
  return `#${channels.map(c => c.toString(16).padStart(2, "0")).join("")}`;
}

type ThemeJson = { vars?: Record<string, string>; colors: Record<string, string | number> };

/** Resolve a theme's `colors` through its `vars`, to lowercase hex. An empty
 * string means omp defers to the terminal's foreground; it has no hex. */
function resolveColors(theme: ThemeJson): Record<string, string> {
  const vars = theme.vars ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    if (typeof value === "number") out[key] = xtermHex(value);
    else if (value === "") out[key] = "";
    else out[key] = (vars[value] ?? value).toLowerCase();
  }
  return out;
}

function findOmpThemeDir(): string | undefined {
  return OMP_THEME_DIRS.find(dir => existsSync(join(dir, "dark-ember.json")));
}

function readJson(path: string): ThemeJson {
  return JSON.parse(readFileSync(path, "utf-8")) as ThemeJson;
}

const approximated = new Set(APPROXIMATED_SLOTS.map(entry => `${entry.theme}/${entry.slot}`));

test("both palettes define exactly the same slots", () => {
  assert.deepEqual(Object.keys(DARK_EMBER_HEX).sort(), Object.keys(CATPPUCCIN_HEX).sort());
});

test("every palette slot is either mapped to an omp key or declared unmapped", () => {
  const mapped = new Set(OMP_SLOT_KEYS.map(entry => entry.slot));
  const unmapped = Object.keys(CATPPUCCIN_HEX).filter(slot => !mapped.has(slot as keyof OmpPalette));
  // Compared against the declaration rather than a literal, so adding a slot
  // without mapping it fails here instead of silently escaping the parity loop.
  assert.deepEqual(unmapped.sort(), UNMAPPED_SLOTS.map(entry => entry.slot).sort());
});

test("no approximation is declared for a slot the parity loop never visits", () => {
  const mapped = new Set(OMP_SLOT_KEYS.map(entry => entry.slot));
  const themes = new Set(THEMES.map(theme => theme.palette));
  for (const { slot, theme } of APPROXIMATED_SLOTS) {
    assert.ok(mapped.has(slot), `${slot} is approximated but unmapped, so the approximation is dead data`);
    assert.ok(themes.has(theme), `${theme} is not a known palette name`);
  }
});

test("every slot mapping is unique", () => {
  const seen = new Map<string, string>();
  for (const { slot, key } of OMP_SLOT_KEYS) {
    const clash = seen.get(slot);
    assert.equal(clash, undefined, `slot ${slot} is mapped to both ${clash} and ${key} — split it into two slots`);
    seen.set(slot, key);
  }
});

test("every palette name resolves to a palette", () => {
  for (const { palette } of THEMES) assert.ok(PALETTES[palette], `${palette} missing from PALETTES`);
});

for (const { palette, hex, omp, ours } of THEMES) {
  test(`${palette}: slots match omp's ${omp}`, t => {
    const dir = findOmpThemeDir();
    if (!dir) return t.skip("omp is not installed; set OMP_THEME_DIR to check parity");
    const reference = resolveColors(readJson(join(dir, omp)));

    for (const { slot, key, use } of OMP_SLOT_KEYS) {
      const expected = reference[key];
      assert.ok(expected !== undefined, `omp ${omp} has no key ${key} (mapped from ${slot})`);
      if (approximated.has(`${palette}/${slot}`)) {
        assert.equal(expected, "", `${slot} is listed as approximated but omp ${key} is ${expected}, not empty`);
        continue;
      }
      assert.notEqual(expected, "", `omp ${key} is empty; add ${palette}/${slot} to APPROXIMATED_SLOTS`);
      assert.equal(hex[slot], expected, `${slot} (${use}) should be omp ${key} ${expected}, got ${hex[slot]}`);
    }
  });

  test(`${palette}: shipped theme matches omp's ${omp} key for key`, t => {
    const dir = findOmpThemeDir();
    if (!dir) return t.skip("omp is not installed; set OMP_THEME_DIR to check parity");
    const reference = resolveColors(readJson(join(dir, omp)));
    const shipped = resolveColors(readJson(join(import.meta.dirname, "..", "themes", ours)));

    for (const [key, value] of Object.entries(shipped)) {
      assert.ok(key in reference, `${ours} has key ${key}, which omp ${omp} does not`);
      assert.equal(value, reference[key], `${ours} ${key} is ${value}, omp has ${reference[key]}`);
    }
    // omp's status-line and `link` keys are the ones pi's schema cannot express;
    // they are carried in the palette instead, so only those may be absent here.
    const missing = Object.keys(reference).filter(key => !(key in shipped));
    const unexpected = missing.filter(key => !key.startsWith("statusLine") && key !== "link" && key !== "toolText");
    assert.deepEqual(unexpected, [], `${ours} is missing non-status-line keys omp defines`);
  });
}
