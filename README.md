# pi-omp-feel

Ports the oh-my-pi (`omp`) "feel" to the pi coding agent via a pi extension.

## Which omp?

**omp is [github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)** — a coding agent in its own right, installed via `scripts/install.sh` from that repo. Its TUI is what this extension reproduces, so the source references in the code point into its tree:

| reference in `src/index.ts` | file in omp |
| --- | --- |
| status-line segments and presets | `packages/coding-agent/src/modes/components/status-line/` |
| context-usage thresholds and colors | `.../status-line/context-thresholds.ts` |
| tool-call block framing | `packages/coding-agent/src/tui/output-block.ts` |
| editor top-border provider | `packages/tui/src/components/editor.ts` |
| theme values | `packages/coding-agent/src/modes/theme/defaults/dark-catppuccin.json` |

Do **not** confuse it with two unrelated things that answer to the same names:

- **`oh-my-pi` on npm** (`acidsugarx/oh-my-pi`) — a multi-agent orchestration framework for pi. Different project, no TUI, no status line.
- **`omp` / oh-my-posh** — the Go shell-prompt themer. Shares the powerline vocabulary (segments, `` separators, catppuccin) but is otherwise unrelated.

- **Theme**: ships `omp-dark-catppuccin`, identical to omp's `dark-catppuccin` (Catppuccin Mocha, base `#1e1e2e`) except for the 16 `statusLine*`/`toolText`/`link` color keys that pi's theme schema cannot express — those are carried as hardcoded values in `src/index.ts` instead. The stock pi theme `catppuccin-mocha` draws on the same palette but **is not a substitute** — it assigns some keys differently, `accent` most visibly (blue `#89b4fa` where omp uses peach `#fab387`). Anything theme-driven, including other extensions' dialogs, follows that assignment; this extension's own colors are hardcoded and look right either way, which makes running the wrong theme easy to miss. If the omp feel looks half-applied, check `/theme` first.
- **Status line**: a single-line editor top border replacing the built-in footer — model + thinking level, working directory, git branch, token/cost stats, context %, and session name — in an omp-style powerline-thin layout.
- **Prompt input**: the input box is reshaped into omp's rounded-corner `╭──╮`/`╰──╯` frame with padded side rails and a correctly positioned cursor (via the supported `setEditorComponent` hook; editing, keybindings, and autocomplete stay on the stock `CustomEditor` core). The full status line occupies the top border, mirroring omp.
- **Working indicator**: colored braille spinner (accent) while streaming, with omp's shimmer sweeping the label and the `⟨esc⟩` hint.
- **Hidden thinking label**: shows `…` instead of the default hidden-thinking text.
- **Tool-call framing**: tool calls (`bash`, `read`, `write`, `ssh`, `mcp`, …) render inside omp-style rounded blocks with state-colored borders over pi's usual state background tint. Bash follows omp's command-first layout with an `Output` divider; other default-rendered tools use status headers (`⏳`/`⟳`, `✘`, `❯`/`✎`/`⇄`/`🔌`) where applicable. `write` and `edit` close their header the way omp does, with `· 4 lines` and `⟨+1/-1⟩`. Tools registered by other extensions are framed too — see below.
- **Collapsed windows, omp-sized**: collapsed blocks show what omp shows. Bash keeps a viewport-capped ten-line output tail (pi keeps five) and caps long commands to a viewport tail; `write` previews stream as a live 12-line tail and settle to the first 6 behind a dim line-number gutter (pi: a frozen, ungutted head of 10); a collapsed `read` hangs the first three highlighted lines of the file under its row (pi shows nothing). Diffs cap at omp's 8 hunks / 40 lines — thinning the context between hunks before hiding any hunk, and keeping a single over-budget hunk whole, exactly as omp's truncation does — mark indentation with dim `·`s, and syntax-highlight their context lines. All structural, so any tool rendering pi diff rows qualifies. `ctrl+o` lifts every one of these, exactly as before.

## Where this reaches past pi's public API

Two things omp does natively have no supported equivalent in pi, so they are done structurally:

**Tool-call framing.** pi's core `ToolExecutionComponent` frames built-in tools itself (a tinted Box, no borders) and exposes no hook to restyle it; `registerTool({ renderCall, renderResult, renderShell })` only applies to tools the extension itself registers. The pi extension loader aliases `@earendil-works/pi-coding-agent` to the very same module instance core imports, so this extension patches the shared `ToolExecutionComponent.prototype.render` to wrap the default path in an omp-style frame, reading private fields (`contentBox`, `callRendererComponent`, …) as it goes. Tools whose definitions supply their own renderer (`renderShell === "self"`) are left untouched unless their profile opts in with `frameSelfRendered`, which only `edit` does: what pi calls a shell there is a background-tinted `Box` holding a diff, the same shape every other block is built from, so it can be framed without touching the diff itself.

**Prompt framing.** omp's TUI has a first-class top-border provider (`packages/tui`, `editor-top-border-provider`); pi's does not. So `OmpEditor` post-processes the rows the stock editor returns, identifying its flat `─` border rows and reshaping them.

Both assumptions can break on a `pi` upgrade, and both run on every rendered frame — so each is wrapped to **fail once and degrade**: the first failure latches and hands rendering back to pi for the rest of the session. A pi internals change costs you the omp styling, not a usable TUI.

When that happens it writes `~/.pi/agent/pi-omp-feel-degraded.md` (appended, capped at 256 KB) and points at it from the footer. The entry carries the stack with `src/index.ts:<line>`, the installed pi version, which of the fields the patch depends on were actually present, and the list of assumptions that subsystem makes — enough to reconstruct the failure. Hand it straight to an agent:

```sh
pi @~/.pi/agent/pi-omp-feel-degraded.md "fix this"
```

The guards cost nothing measurable: the latch plus `try`/`catch` adds ~0.1 ns per render call, and reporting only runs on the single failure.

## Tools from other extensions

A tool that arrives from another extension is framed like any other. Without being told anything about it, it gets a titled block — or a single row, when a single row is all it draws — and its name is read as a label rather than an identifier, so `exec_command` heads its block as `Exec command`.

Some tools deserve better than that default, and `TOOL_PROFILES` in `src/index.ts` is where one says so:

| field | effect |
| --- | --- |
| `headerless` | lead with the command instead of a header, as omp's bash block does |
| `sections` | draw call and result as omp's two sections, divided by `├─── Output ───┤` |
| `command` | where the shell command lives in `args`, so the row can be re-rendered dim-`$` and syntax-highlighted (and viewport-capped when collapsed) |
| `detail` | the dim `(cwd: … · tty)` suffix that follows a command, built from `args` |
| `wall` | fold the tool's timing row into omp's `⟨Wall: … \| Exit: …⟩` badge |
| `summary` | close the header the way omp does — `· 4 lines` on a write, `⟨+1/-1⟩` on an edit |
| `frameSelfRendered` | frame this tool even though it declares `renderShell: "self"` |
| `contentPath` | where the file this tool touches lives in `args`, so its rows (and a diff's context lines) highlight in that language |
| `content` | where written content lives in `args`, so the body rebuilds as omp's write cell — dim gutter, tail-12 streaming, head-6 settled |
| `resultText` | readable output in the tool result, so a one-line tool grows omp's three-line collapsed cell (`read` sets it) |
| `startLine` | first line number of that output, for the cell's gutter (`read`'s `offset`) |
| `output` | command output in the tool result, so a collapsed sections block re-tails it at omp's ten lines. A tool that windows its own output — runbg does, deliberately — must not set this |

`pi-runbg` ships profiled: `exec_command` is a shell command that outlives the call, so it gets exactly what omp gives bash, and `write_stdin` keeps its header because keystrokes are not a command. What omp has no vocabulary for — the session id, the log path — stays beside the badge rather than being folded into it. Its collapsed output window is runbg's own to draw and defaults to the same ten lines bash gets here, so the two block kinds match out of the box; `PI_RUNBG_PREVIEW_LINES` changes runbg's depth (pi's stock bash shows five), and neither package needs the other installed.

The extensions being described do not know this file exists and do not need to. Everything comes from `args`, which is structured, or from matching rows they already draw — and a match that fails leaves their own output showing rather than breaking the block. A profile is also ignored for a tool whose renderers are absent, which is what a transcript replayed after uninstalling that extension looks like.

## Naming what pi is waiting on

omp does not always say "Working…" — it names the activity, and the shimmer sweeps whatever that says. pi renders its working row as `frames + message`, and this extension puts the whole animated label in the frames, so an extension calling `setWorkingMessage` would have its text appended *after* "Working… ⟨esc⟩" rather than replacing it.

So there is a channel instead. Emit on `ui:activity` and the label is taken over — rebuilt into the shimmering frames, with pi's message slot cleared so nothing renders twice:

```ts
pi.events.emit("ui:activity", { label: "Asking a question" });
// …
pi.events.emit("ui:activity", { label: undefined });   // back to "Working…"
```

Senders should set `setWorkingMessage` as well, so they still read correctly when this extension is not installed; it is cleared here when the label is taken over. `pi-ask` does exactly this.

## Glyph presets

omp ships `nerd`, `unicode` and `ascii` symbol presets. Its own default is `unicode`; **this extension defaults to `nerd`**, because that is what omp is configured with on the machine it was ported from, and because the status-line glyphs were always Nerd Font — so the two families used to disagree with each other.

Everything the extension exposes lives under one command named after it:

```sh
/omp-feel                     # pick from a list
/omp-feel glyphs unicode      # set directly (tab-completes at every position)
/omp-feel unicode             # shorthand, the subcommand is optional
pi --omp-feel-glyphs unicode  # this run only, not remembered
```

The choice is remembered in `~/.pi/agent/pi-omp-feel.json`. Pick `unicode` if your terminal font has no Nerd Font glyphs — `✎ Write` instead of ` Write`, `◒ high` instead of `󰪣 high`.

The preset covers the three families omp defines twice over: tool identity (`tool.*`), status (`status.*`, `format.bullet`) and thinking levels (`thinking.*`). The status-line segment glyphs (`` `` `` `` ``) are not preset-dependent in omp, so both presets share them — a font without Nerd Font coverage will still show boxes there.

## Comparing against omp

Fidelity claims here are checked against omp's actual output, not against memory. `tools/compare/` drives both agents through a real PTY (tmux at a fixed size) and records the rendered cells **with** their escape sequences, so the two can be diffed by colour and codepoint. That catches what eyes cannot: a colour one shade off, `U+F115` where omp uses `U+F014`, a clamp that silently drops the last segment.

```sh
# a throwaway workspace, so tool calls cannot touch anything real
W=$(mktemp -d) && (cd "$W" && git init -q && echo hi > README.md &&
  git add -A && git -c user.email=x@y -c user.name=x commit -qm init)

P="Do these steps using tools, no commentary: 1 run bash echo hello 2 write a file note.txt containing alpha"
tools/compare/capture.sh cmp-pi  pi  "$W" "pi"  "$P"
tools/compare/capture.sh cmp-omp omp "$W" "omp" "$P"

# structure first, from the plain-text captures
grep -n '╭──\|├───' pi-final.txt omp-final.txt

# then exact colours and glyphs, per run (line numbers match the .txt files)
node tools/compare/decode.mjs omp-final.ansi 'GPT'
node tools/compare/decode.mjs pi-final.ansi 33
```

Animations come out of the `-anim-NN.ansi` samples, taken 150 ms apart. Note that a shimmering label puts ANSI *between* letters, so a substring needle will not match it — address those lines by number:

```sh
for n in 03 05 07 09; do
  printf '%s: ' "$n"
  node tools/compare/decode.mjs pi-anim-$n.ansi \
    "$(grep -n Working pi-anim-$n.ansi | head -1 | cut -d: -f1)" |
    sed 1d | awk '{printf "[%s]%s ", substr($1,4), $3}'
  echo
done
```

Two cautions. Passing a prompt runs a real turn: it spends tokens and lets the agent execute tools, which is why the workspace must be disposable — `capture.sh` also refuses to type a prompt unless it can see the prompt frame, because otherwise the keystrokes reach the shell and get executed. It waits up to 90 s for that frame before settling, since a blank startup pane is perfectly stable and settling alone would capture it. And omp is far ahead of pi in version, so a difference is not automatically a porting bug; it may be something pi has no equivalent for.

## Development

```sh
npm run typecheck
```

The extension imports only from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, which the pi loader provides as virtual modules at runtime; no build step is required. For local typechecking those two are expected as symlinks into your global pi install:

```sh
mkdir -p node_modules/@earendil-works && cd node_modules/@earendil-works \
  && ln -sfn "$(npm root -g)/@earendil-works/pi-coding-agent" pi-coding-agent \
  && ln -sfn "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui" pi-tui
```

`npm install` prunes those symlinks (they are not real dependencies), so re-run the above afterwards. `package-lock.json` is git-ignored for the same reason: it records paths specific to one machine.

## Install

Add to `~/.pi/agent/settings.json` under `packages`:

```json
{
  "packages": [
    "../../Developer/pi-omp-feel"
  ]
}
```

Optionally set the theme:

```json
{
  "theme": "omp-dark-catppuccin"
}
```

Reload pi or restart it. The extension activates on `session_start` in TUI mode.
