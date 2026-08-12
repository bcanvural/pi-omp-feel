// Split one captured line into (text, fg, bg) runs and spell out its codepoints,
// so a line from omp and the same line from pi+this-extension can be compared
// exactly: colour per run, glyph per cell.
//
//   node tools/compare/decode.mjs <file.ansi> <needle-or-line-number>
//
// Prefer a line number for anything whose text is broken up by escapes — a
// syntax-highlighted command or an active shimmer has ANSI *between* letters, so
// a substring needle will not match it. Line numbers agree with the sibling .txt
// capture, so `grep -n` that file first.
import { readFileSync } from "node:fs";

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

// One SGR carries a whole parameter list, and a colour can sit anywhere in it —
// `1;38;2;250;179;135` is one escape that turns on bold and sets a foreground.
// Matching the colour forms against the list as a whole misses those, and
// reading the list as loose parts mistakes a colour's own `0` channel for a
// reset. Both mistakes report the run as uncoloured, which is indistinguishable
// from a theme that never applied — the one answer this tool must never give by
// accident. So the list is consumed in order, with 38/48 taking their operands
// with them.
const byte = (value) => Number.isInteger(value) && value >= 0 && value <= 255;

function applySgr(params, state, hex) {
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    // 1, 2 and 22 are three states of one intensity attribute, not two flags:
    // 22 is the shared reset. A boolean would report bold text as dim.
    if (code === 0) { state.fg = "-"; state.bg = "-"; state.intensity = ""; }
    else if (code === 1) state.intensity = "bold";
    else if (code === 2) state.intensity = "dim";
    else if (code === 22) state.intensity = "";
    else if (code === 39) state.fg = "-";
    else if (code === 49) state.bg = "-";
    else if (code === 38 || code === 48) {
      const channel = code === 38 ? "fg" : "bg";
      const form = params[i + 1];
      // Palette indices are reported as indices, never converted: a capture
      // taken where truecolor was not detected must not come back looking like
      // hexes that happened to match. Operands are checked before use — a
      // capture truncated mid-escape would otherwise produce `#ffNaNNaN`, which
      // is a colour-shaped lie rather than a visible failure.
      if (form === 2 && [2, 3, 4].every((n) => byte(params[i + n]))) {
        state[channel] = hex(params[i + 2], params[i + 3], params[i + 4]);
        i += 4;
      } else if (form === 5 && byte(params[i + 2])) {
        state[channel] = `256:${params[i + 2]}`;
        i += 2;
      } else {
        // An unrecognised form has an unknown operand count, so there is no safe
        // place to resume: reading on would parse a colour's own channels as
        // attribute codes, which is the mistake this function exists to avoid.
        // A known form with a bad operand could be stepped over precisely, but
        // it takes the same exit — the cost is discarding whatever followed in
        // the same escape, next to a `?` that says not to trust the row anyway.
        //
        // `?` rather than leaving the previous colour: `-` is itself a claim
        // ("no colour set"), and a malformed escape must not be reportable as
        // either a colour or the absence of one.
        state[channel] = "?";
        return;
      }
    }
    // The 8/16-colour forms. omp reaches for these where pi always uses the
    // 24-bit form, so a comparison that ignored them would show one side blank.
    else if (code >= 30 && code <= 37) state.fg = `ansi:${code - 30}`;
    else if (code >= 90 && code <= 97) state.fg = `ansi:${code - 90 + 8}`;
    else if (code >= 40 && code <= 47) state.bg = `ansi:${code - 40}`;
    else if (code >= 100 && code <= 107) state.bg = `ansi:${code - 100 + 8}`;
  }
}

function runs(line) {
  const out = [];
  const state = { fg: "-", bg: "-", intensity: "" };
  let last = 0;
  let match;
  SGR.lastIndex = 0;
  const push = (text) => {
    if (!text) return;
    // Intensity is carried because it changes what a cell looks like without
    // changing its colour: omp draws some glyphs as default-coloured-but-dim,
    // which would otherwise read as identical to undecorated text. It is part
    // of the run identity too, so a stretch that only changes weight is
    // reported as two runs rather than merged into one.
    const fg = state.intensity ? `${state.fg}(${state.intensity})` : state.fg;
    const prev = out[out.length - 1];
    if (prev && prev.fg === fg && prev.bg === state.bg) prev.text += text;
    else out.push({ text, fg, bg: state.bg });
  };
  const hex = (r, g, b) => `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
  while ((match = SGR.exec(line)) !== null) {
    push(line.slice(last, match.index));
    last = match.index + match[0].length;
    // An empty parameter list is `ESC[m`, which means reset.
    applySgr(match[1] === "" ? [0] : match[1].split(";").map(Number), state, hex);
  }
  push(line.slice(last));
  return out;
}

const spell = (text) =>
  [...text]
    .map((character) => {
      const code = character.codePointAt(0);
      if (code === 32) return "␠";
      if (code < 32) return `<${code.toString(16)}>`;
      return code > 0x2000 ? `${character}(U+${code.toString(16).toUpperCase()})` : character;
    })
    .join("");

const [file, target] = process.argv.slice(2);
if (!file || !target) {
  console.error("usage: node tools/compare/decode.mjs <file.ansi> <needle-or-line-number>");
  process.exit(64);
}
const lines = readFileSync(file, "utf8").split("\n");
const line = /^\d+$/.test(target) ? lines[Number(target) - 1] : lines.find((l) => l.includes(target));
if (line === undefined) {
  console.error(`no line matching ${target} (if its text is split by escapes, pass a line number)`);
  process.exit(1);
}
// Blank padding carrying no colour is layout, not a run worth reporting.
// Weight on whitespace is the same thing — neither is visible on a space.
const reported = runs(line).filter((run) => run.text.trim() || !run.fg.startsWith("-") || run.bg !== "-");
// Sized to the widest value present, so a weight suffix or a `256:` index does
// not push the text column out of line partway down the report.
const fgWidth = Math.max(2, ...reported.map((run) => run.fg.length));
const bgWidth = Math.max(2, ...reported.map((run) => run.bg.length));
for (const run of reported) {
  console.log(`fg=${run.fg.padEnd(fgWidth)} bg=${run.bg.padEnd(bgWidth)} ${spell(run.text)}`);
}
