// Diffs this extension's shell lexer against omp's own highlighter, per
// character, for a corpus of commands.
//
// This is the only check that can falsify a claim about "what omp does here".
// The palette test verifies colour *values*; this verifies *classification*,
// which is where a hand-written lexer silently drifts.
//
//   npm test
//
// omp's highlighter ships as a native addon in `@oh-my-pi/pi-natives`, whose
// loader uses `import.meta.dir` — a Bun property — so the reference side runs in
// a Bun subprocess. Without Bun or omp the comparison skips: it cannot be
// evaluated, and a false pass is worse than an honest skip.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { highlightShellCommand, type ShellColors } from "../src/shell-lexer.ts";

// Sentinels stand in for colours, so a run reads back as one class per
// character. U+0001 prefixes each marker because a bare letter would be
// indistinguishable from the command's own text — `F` and `P` occur in plenty of
// real commands. Built with fromCharCode so no invisible byte lands in this file.
const SENTINEL = String.fromCharCode(1);
const mark = (cls: string): string => `${SENTINEL}${cls}`;

const MARK: ShellColors = {
  fn: mark("F"),
  punct: mark("P"),
  variable: mark("V"),
  string: mark("S"),
  keyword: mark("K"),
  comment: mark("C"),
  number: mark("N"),
};

/** omp's `HighlightColors` names its fields differently. `type`/`operator` are
 * classes this lexer never emits — given distinct markers so they surface as a
 * mismatch instead of silently reading as one of ours. */
const OMP_MARK = {
  function: MARK.fn,
  punctuation: MARK.punct,
  variable: MARK.variable,
  string: MARK.string,
  keyword: MARK.keyword,
  comment: MARK.comment,
  number: MARK.number,
  type: mark("T"),
  operator: mark("O"),
  inserted: mark("+"),
  deleted: mark("-"),
};

const BUN = [join(homedir(), ".bun/bin/bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].find(existsSync);
const NATIVES = join(homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives/native/index.js");

/** Commands this lexer is meant to reproduce exactly. */
const CORPUS = [
  'VAR=alpha; echo "$VAR beta" | tr a-z A-Z | head -1 # sample',
  "FOO=bar",
  "BAZ=$FOO",
  "PATH=$HOME/bin",
  "PREFIX=$X:$Y",
  "BAZ=${FOO}",
  'echo "${FOO}"',
  "echo $HOME/bin",
  "echo $i",
  "export FOO=bar",
  "declare -x V=1",
  "ls -la # note",
  "ls 2> err",
  "ls >&2",
  "ls 2>&1",
  "echo 1 > f",
  "sleep 30",
  "npm run build --verbose --width=3",
  "git log --oneline -5",
  "head -1",
  "cat a.txt | grep -n 'x y' | wc -l",
  "if true; then echo a; fi",
  "A+=b",
];

/** Commands where this lexer knowingly differs, and why. Asserted to *still*
 * differ, so if omp changes shape the exemption is revisited instead of quietly
 * protecting nothing. */
const KNOWN_DIVERGENT: ReadonlyArray<{ command: string; why: string }> = [
  { command: "echo --verbose --width=3", why: "omp recognises options per command; echo declares none, so omp leaves these plain arguments" },
  { command: "kill -9 123", why: "same: kill does not declare -9, so omp leaves it plain" },
  { command: "for i in 1 2 3; do echo $i; done", why: "omp emits no colour for loop variables and list words, and returns `done` as function" },
  { command: "FOO=a'b'c", why: "string context does not survive a nested quote here: the tail reverts to a bare word. Needs a value-context flag, not a colour change" },
  { command: "FOO=~/x", why: "omp paints the tilde alone as a variable" },
  { command: "FOO=`cmd`", why: "backticks are not a word break here, so the substitution stays string-coloured" },
  { command: "A[0]=x", why: "the assignment pattern cannot see past a subscript" },
];

/** Run omp's highlighter under Bun and return its marked output, or undefined
 * when the tooling simply is not installed.
 *
 * Anything else throws. A broken harness must not read as a skip — swallowing
 * the error here is how a test that verifies nothing comes to look green, and it
 * did exactly that once already (the input arrived over `process.argv`, whose
 * index differs under `bun -e`, so every run failed and every run "skipped"). */
function ompHighlight(commands: readonly string[]): string[] | undefined {
  if (!BUN || !existsSync(NATIVES)) return undefined;
  const script = `
    import { highlightCode } from ${JSON.stringify(NATIVES)};
    const colors = ${JSON.stringify(OMP_MARK)};
    const input = JSON.parse(process.env.OMP_LEXER_INPUT);
    console.log(JSON.stringify(input.map(c => highlightCode(c, "bash", colors))));
  `;
  const run = spawnSync(BUN, ["-e", script], {
    encoding: "utf-8",
    env: { ...process.env, OMP_LEXER_INPUT: JSON.stringify(commands) },
  });
  assert.equal(run.status, 0, `omp's highlighter failed to run: ${run.stderr || run.error?.message}`);
  const parsed = JSON.parse(run.stdout) as string[];
  assert.equal(parsed.length, commands.length, "omp's highlighter returned the wrong number of results");
  return parsed;
}

/** Collapse a marked string into one class per character, dropping any real ANSI
 * omp emits alongside the sentinels. */
function classify(marked: string): { text: string; cls: (string | undefined)[] } {
  const clean = marked.replace(/\x1b\[[0-9;]*m/g, "");
  let current: string | undefined;
  let text = "";
  const cls: (string | undefined)[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === SENTINEL) {
      current = clean[i + 1];
      i++;
      continue;
    }
    text += clean[i];
    cls.push(current);
  }
  return { text, cls };
}

type Mismatch = { at: number; char: string; omp?: string; ours?: string };

/** Mismatching characters, ignoring whitespace: a blank cell shows no colour, so
 * omp carrying a class across a separating space is not a visible difference. */
function mismatches(command: string, ompOut: string): Mismatch[] {
  const reference = classify(ompOut);
  const ours = classify(highlightShellCommand(command, MARK));
  assert.equal(ours.text, reference.text, `lexer altered the text of ${JSON.stringify(command)}`);
  const out: Mismatch[] = [];
  for (let i = 0; i < reference.cls.length; i++) {
    if (reference.text[i].trim() === "") continue;
    if (reference.cls[i] !== ours.cls[i]) {
      out.push({ at: i, char: reference.text[i], omp: reference.cls[i], ours: ours.cls[i] });
    }
  }
  return out;
}

function describe(diff: Mismatch[]): string {
  return diff.map(d => `col ${d.at} ${JSON.stringify(d.char)} omp=${d.omp ?? "none"} ours=${d.ours ?? "none"}`).join("; ");
}

test("the sentinel harness can tell classes apart", () => {
  const { text, cls } = classify(highlightShellCommand("echo hi", MARK));
  assert.equal(text, "echo hi");
  assert.equal(cls[0], "F", "expected `echo` to classify as a command word");
});

test("lexer classification matches omp's highlighter", t => {
  const reference = ompHighlight(CORPUS);
  if (!reference) return t.skip("needs Bun and omp's @oh-my-pi/pi-natives to compare against");

  const failures: string[] = [];
  for (const [index, command] of CORPUS.entries()) {
    const diff = mismatches(command, reference[index]);
    if (diff.length > 0) failures.push(`${JSON.stringify(command)}\n    ${describe(diff)}`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}\n`);
});

test("known divergences still diverge", t => {
  const commands = KNOWN_DIVERGENT.map(entry => entry.command);
  const reference = ompHighlight(commands);
  if (!reference) return t.skip("needs Bun and omp's @oh-my-pi/pi-natives to compare against");

  for (const [index, { command, why }] of KNOWN_DIVERGENT.entries()) {
    assert.ok(
      mismatches(command, reference[index]).length > 0,
      `${JSON.stringify(command)} now matches omp — drop it from KNOWN_DIVERGENT (${why})`,
    );
  }
});
