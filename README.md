# pi-omp-feel

Ports the oh-my-pi (`omp`) "feel" to the pi coding agent via a pi extension.

- **Theme**: ships `omp-dark-catppuccin`, byte-for-byte identical to omp's `dark-catppuccin` (Catppuccin Mocha, base `#1e1e2e`). The stock pi theme `catppuccin-mocha` is the same palette.
- **Status line**: a single-line editor top border replacing the built-in footer — model + thinking level, working directory, git branch, token/cost stats, context %, and session name — in an omp-style powerline-thin layout.
- **Prompt input**: the input box is reshaped into omp's rounded-corner `╭──╮`/`╰──╯` frame with padded side rails and a correctly positioned cursor (via the supported `setEditorComponent` hook; editing, keybindings, and autocomplete stay on the stock `CustomEditor` core). The full status line occupies the top border, mirroring omp.
- **Working indicator**: colored braille spinner (accent) while streaming.
- **Hidden thinking label**: shows `…` instead of the default hidden-thinking text.
- **Tool-call framing**: built-in tool calls (`bash`, `read`, `write`, `ssh`, `mcp`, …) render inside omp-style rounded blocks with state-colored borders over pi's usual state background tint. Bash follows omp's command-first layout with an `Output` divider; other default-rendered tools use status headers (`⏳`/`⟳`, `✘`, `❯`/`✎`/`⇄`/`🔌`) where applicable.

## Notes on the tool-call framing

pi's core `ToolExecutionComponent` frames built-in tools itself (a tinted Box, no borders) and exposes no hook to restyle it; `registerTool({ renderCall, renderResult })` only applies to tools the extension itself registers. The pi extension loader aliases `@earendil-works/pi-coding-agent` to the very same module instance core imports, so this extension patches the shared `ToolExecutionComponent.prototype.render` to wrap the default path in an omp-style frame. Tools whose definitions supply their own renderer (`renderShell === "self"`, e.g. `edit`) are left untouched. This relies on the loader's module-identity sharing, so it may break if pi changes how extensions resolve core packages.

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

## Development

```sh
npm run typecheck
```

The extension imports only from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, which the pi loader provides as virtual modules; no build step is required.
