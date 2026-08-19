// omp's shell-command colouring, as a standalone lexer.
//
// pi highlights bash with highlight.js, which marks roughly one token in six of
// what omp marks, so this is a small hand-written lexer rather than a theme
// setting. It lives apart from `index.ts` so `tests/shell-lexer-parity.test.ts`
// can drive it with sentinel colours and diff it against omp's own highlighter
// (`@oh-my-pi/pi-natives`) token class by token class — the only way to keep it
// honest, since every claim about "what omp does here" is otherwise a guess.
//
// Colours arrive as ANSI strings rather than being read from a palette, so a
// test can pass markers instead and read the classification directly.

/** One ANSI foreground sequence per token class the lexer can emit. */
export interface ShellColors {
  fn: string;
  punct: string;
  variable: string;
  string: string;
  keyword: string;
  comment: string;
  number: string;
}

const FG_RESET = "\x1b[39m";

const SHELL_KEYWORDS = new Set([
  // Verified against omp's own highlighter, which returns `fi` and `done` as
  // `function` rather than keyword — they are absent here on purpose.
  "for", "in", "do", "if", "then", "else", "elif", "while", "until",
  "case", "esac", "select", "function", "return", "break", "continue", "local", "export",
  "declare",
]);

/** `$name`, `${name}`, and the `{`/`}` around it. omp paints the sigil and both
 * braces as punctuation and only the name as a variable — verified by driving
 * omp's own highlighter (`@oh-my-pi/pi-natives`): `${FOO}` comes back
 * `‹punct›$ ‹punct›{ ‹variable›FOO ‹punct›}`. */
const SHELL_EXPANSION = /^\$(\{)?(\w+)(\})?/;

/** A string-ish run with expansions breaking through it, the way omp renders a
 * double-quoted body *and* an unquoted assignment value — both come back with a
 * string base and the same expansion colouring (`PATH=$HOME/bin` →
 * `‹punct›$ ‹variable›HOME ‹string›/bin`). */
function paintExpansions(body: string, colors: ShellColors, base: string = colors.string): string {
  const string = base;
  const punct = colors.punct;
  const variable = colors.variable;
  const paint = (color: string, text: string): string => (text ? `${color}${text}${FG_RESET}` : "");
  let out = "";
  let rest = body;
  while (rest.length > 0) {
    const at = rest.search(/\$\{?\w/);
    if (at === -1) break;
    out += paint(string, rest.slice(0, at));
    const match = SHELL_EXPANSION.exec(rest.slice(at));
    if (!match) break;
    const [whole, open, name, close] = match;
    out += paint(punct, `$${open ?? ""}`) + paint(variable, name) + paint(punct, close ?? "");
    rest = rest.slice(at + whole.length);
  }
  return out + paint(string, rest);
}

/** Whether a numeric word is a redirection file descriptor rather than an
 * argument — true only when it touches a redirection operator with no space
 * between, as in `2> err` or `>&2`. */
function isRedirectFd(command: string, start: number, end: number): boolean {
  const after = command[end];
  if (after === ">" || after === "<") return true;
  const prev = command[start - 1];
  if (prev === ">" || prev === "<") return true;
  // `>&2` / `<&0`: the digit sits behind the `&` of the operator, not a bare `&`.
  return prev === "&" && (command[start - 2] === ">" || command[start - 2] === "<");
}

/** `|`, `||`, `&&`, `;`, `&`, and the redirection family. */
const SHELL_OPERATOR_LEAD = /[|;&<>]/;
/** Substitution and grouping brackets, which omp paints as punctuation and
 * which start a fresh command word inside. */
const SHELL_BRACKET = /[()]/;
const SHELL_SPACE = /\s/;
/** Anything that ends a word. */
const SHELL_WORD_BREAK = /[\s|;&<>()'"]/;
/** `NAME=value` or `NAME+=value` — an assignment, not a command. omp returns
 * `A+=b` as `‹variable›A ‹keyword›+= ‹string›b`. */
const SHELL_ASSIGNMENT = /^([A-Za-z_]\w*)(\+?=)/;

export function highlightShellCommand(command: string, colors: ShellColors): string {
  const fn = colors.fn;
  const punct = colors.punct;
  const variable = colors.variable;
  const string = colors.string;
  const keyword = colors.keyword;
  const comment = colors.comment;
  const number = colors.number;
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
      // omp paints the sigil as punctuation and only the text that follows in the
      // comment colour, so the `#` sits dimmer than its comment under dark-ember.
      out += paint(punct, "#") + paint(comment, command.slice(index + 1, stop));
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
      // Single quotes are literal in shell, so omp leaves the body one string.
      out += quote === '"' ? paintExpansions(body, colors) : paint(string, body);
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
    // Keep the word's start: `index` moves to `end` here, and the redirection
    // check below needs the character *before* the word, not before the cursor.
    const start = index;
    index = end;

    const assignment = SHELL_ASSIGNMENT.exec(word);
    if (assignment) {
      // `NODE_ENV=production npm start` — the name is a variable, not a command.
      // omp puts the `=` in the keyword colour and the value in the string
      // colour, with expansions breaking through exactly as inside double
      // quotes — `FOO=bar` → `‹variable›FOO ‹keyword›= ‹string›bar`, and
      // `PATH=$HOME/bin` → `‹punct›$ ‹variable›HOME ‹string›/bin`.
      out += paint(variable, assignment[1]) + paint(keyword, assignment[2]) + paintExpansions(word.slice(assignment[0].length), colors);
    } else if (SHELL_KEYWORDS.has(word)) {
      out += paint(keyword, word);
    } else if (word.startsWith("-")) {
      // A flag reads as its dashes and its name, coloured apart, with `--k=v`
      // splitting further into a keyword `=` and a value in the argument
      // colour: `npm run build --width=3` comes back from omp's highlighter as
      // `‹punct› -- ‹variable›width ‹keyword›= ‹function›3`.
      //
      // Deliberate approximation. omp recognises options *per command* from
      // syntect's bash grammar, so it splits `npm --verbose`, `git --oneline`
      // and `head -1`, but leaves `echo --verbose` and `kill -9` as plain
      // arguments. Reproducing that needs the grammar's per-command option
      // tables; always splitting matches the commands a transcript is mostly
      // made of (git, npm, cargo, rg) and mismatches the rest.
      const dashes = /^-+/.exec(word)?.[0] ?? "-";
      const rest = word.slice(dashes.length);
      const eq = rest.indexOf("=");
      out += paint(punct, dashes);
      out += eq === -1
        ? paint(variable, rest)
        : paint(variable, rest.slice(0, eq)) + paint(keyword, "=") + paint(fn, rest.slice(eq + 1));
    } else if (/^\d+$/.test(word) && isRedirectFd(command, start, end)) {
      // omp reserves the number colour for redirection file descriptors. A bare
      // numeric argument is an argument: `sleep 30` and `echo 1 > f` come back
      // `‹function›`, while `ls 2> err` and `ls >&2` come back `‹number›`.
      out += paint(number, word);
    } else if (word.startsWith("$")) {
      // A bare expansion keeps the argument colour for whatever trails it, where
      // an assignment value or quoted body would keep the string colour:
      // `echo $HOME/bin` → `‹punct›$ ‹variable›HOME ‹function›/bin`.
      out += paintExpansions(word, colors, fn);
    } else {
      out += paint(fn, word);
    }
  }
  return out;
}
