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

- **Theme**: ships `omp-dark-catppuccin`, identical to omp's `dark-catppuccin` (Catppuccin Mocha, base `#1e1e2e`) except for the 16 `statusLine*`/`toolText`/`link` color keys that pi's theme schema cannot express — those are carried as hardcoded values in `src/index.ts` instead. The stock pi theme `catppuccin-mocha` is the same palette.
- **Status line**: a single-line editor top border replacing the built-in footer — model + thinking level, working directory, git branch, token/cost stats, context %, and session name — in an omp-style powerline-thin layout.
- **Prompt input**: the input box is reshaped into omp's rounded-corner `╭──╮`/`╰──╯` frame with padded side rails and a correctly positioned cursor (via the supported `setEditorComponent` hook; editing, keybindings, and autocomplete stay on the stock `CustomEditor` core). The full status line occupies the top border, mirroring omp.
- **Working indicator**: colored braille spinner (accent) while streaming.
- **Hidden thinking label**: shows `…` instead of the default hidden-thinking text.
- **Tool-call framing**: built-in tool calls (`bash`, `read`, `write`, `ssh`, `mcp`, …) render inside omp-style rounded blocks with state-colored borders over pi's usual state background tint. Bash follows omp's command-first layout with an `Output` divider; other default-rendered tools use status headers (`⏳`/`⟳`, `✘`, `❯`/`✎`/`⇄`/`🔌`) where applicable.

## Where this reaches past pi's public API

Two things omp does natively have no supported equivalent in pi, so they are done structurally:

**Tool-call framing.** pi's core `ToolExecutionComponent` frames built-in tools itself (a tinted Box, no borders) and exposes no hook to restyle it; `registerTool({ renderCall, renderResult, renderShell })` only applies to tools the extension itself registers. The pi extension loader aliases `@earendil-works/pi-coding-agent` to the very same module instance core imports, so this extension patches the shared `ToolExecutionComponent.prototype.render` to wrap the default path in an omp-style frame, reading private fields (`contentBox`, `callRendererComponent`, …) as it goes. Tools whose definitions supply their own renderer (`renderShell === "self"`, e.g. `edit`) are left untouched.

**Prompt framing.** omp's TUI has a first-class top-border provider (`packages/tui`, `editor-top-border-provider`); pi's does not. So `OmpEditor` post-processes the rows the stock editor returns, identifying its flat `─` border rows and reshaping them.

Both assumptions can break on a `pi` upgrade, and both run on every rendered frame — so each is wrapped to **fail once and degrade**: the first failure latches and hands rendering back to pi for the rest of the session. A pi internals change costs you the omp styling, not a usable TUI.

When that happens it writes `~/.pi/agent/pi-omp-feel-degraded.md` (appended, capped at 256 KB) and points at it from the footer. The entry carries the stack with `src/index.ts:<line>`, the installed pi version, which of the fields the patch depends on were actually present, and the list of assumptions that subsystem makes — enough to reconstruct the failure. Hand it straight to an agent:

```sh
pi @~/.pi/agent/pi-omp-feel-degraded.md "fix this"
```

The guards cost nothing measurable: the latch plus `try`/`catch` adds ~0.1 ns per render call, and reporting only runs on the single failure.

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
