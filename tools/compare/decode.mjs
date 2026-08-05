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

function runs(line) {
  const out = [];
  let fg = "-";
  let bg = "-";
  let last = 0;
  let match;
  SGR.lastIndex = 0;
  const push = (text) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev.fg === fg && prev.bg === bg) prev.text += text;
    else out.push({ text, fg, bg });
  };
  const hex = (r, g, b) => `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
  while ((match = SGR.exec(line)) !== null) {
    push(line.slice(last, match.index));
    last = match.index + match[0].length;
    for (const part of match[1].split(";")) {
      if (part === "39") fg = "-";
      else if (part === "49") bg = "-";
      else if (part === "0" || part === "") { fg = "-"; bg = "-"; }
    }
    const rgbFg = match[1].match(/^38;2;(\d+);(\d+);(\d+)$/);
    const rgbBg = match[1].match(/^48;2;(\d+);(\d+);(\d+)$/);
    if (rgbFg) fg = hex(rgbFg[1], rgbFg[2], rgbFg[3]);
    if (rgbBg) bg = hex(rgbBg[1], rgbBg[2], rgbBg[3]);
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
for (const run of runs(line)) {
  if (!run.text.trim() && run.fg === "-" && run.bg === "-") continue;
  console.log(`fg=${run.fg.padEnd(8)} bg=${run.bg.padEnd(8)} ${spell(run.text)}`);
}
