#!/bin/bash
# Drive a TUI agent through a real PTY and record exactly what it renders, so
# omp and pi+this-extension can be compared cell by cell.
#
#   tools/compare/capture.sh <session> <out-prefix> <workdir> <launch-cmd> [prompt]
#
# Writes, next to wherever you run it:
#   <out>-idle.{ansi,txt}    the settled startup UI
#   <out>-anim-NN.ansi       40 samples taken 150 ms apart while the turn streams
#   <out>-final.{ansi,txt}   the settled UI once the turn is done
#
# The .ansi files keep the escape sequences, which is the whole point: it lets
# tools/compare/decode.mjs recover per-run colours and codepoints. A screenshot
# cannot tell you that a colour is one shade off or that a glyph is U+F115 rather
# than U+F014.
#
# Passing a prompt runs a real turn, so it costs API tokens and lets the agent
# execute tools — always point <workdir> at a throwaway directory.
set -u

if [ "$#" -lt 4 ]; then
  sed -n '2,18p' "$0" >&2
  exit 64
fi

SESSION="$1"; OUT="$2"; WORK="$(cd "$3" && pwd)"; CMD="$4"; PROMPT="${5:-}"
COLS="${COLS:-120}"; ROWS="${ROWS:-45}"

settle() { # $1 = max seconds, $2 = consecutive unchanged rounds required
  local prev="" cur stable=0 i
  for i in $(seq 1 "$1"); do
    sleep 1
    cur="$(tmux capture-pane -p -t "$SESSION" 2>/dev/null | md5)"
    if [ "$cur" = "$prev" ]; then stable=$((stable + 1)); else stable=0; fi
    [ "$stable" -ge "$2" ] && return 0
    prev="$cur"
  done
}

tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" -c "$WORK"
tmux send-keys -t "$SESSION" "clear; cd '$WORK' && $CMD" Enter
settle 40 3
tmux capture-pane -p -e -t "$SESSION" > "${OUT}-idle.ansi"
tmux capture-pane -p    -t "$SESSION" > "${OUT}-idle.txt"
echo "  idle captured"

if [ -n "$PROMPT" ]; then
  # Never type a prompt unless the TUI is actually up. If the agent failed to
  # launch, the keystrokes land in the shell and get run as a command.
  if ! grep -q '╭──' "${OUT}-idle.txt"; then
    echo "  ABORT: no prompt frame in the idle capture - the agent did not start" >&2
    tmux kill-session -t "$SESSION" 2>/dev/null
    exit 1
  fi
  tmux send-keys -t "$SESSION" -l "$PROMPT"
  sleep 0.4
  tmux send-keys -t "$SESSION" Enter
  for n in $(seq -w 1 40); do
    tmux capture-pane -p -e -t "$SESSION" > "${OUT}-anim-${n}.ansi"
    sleep 0.15
  done
  echo "  40 animation samples captured"
  settle 180 4
  tmux capture-pane -p -e -t "$SESSION" > "${OUT}-final.ansi"
  tmux capture-pane -p    -t "$SESSION" > "${OUT}-final.txt"
  echo "  final captured"
fi

tmux kill-session -t "$SESSION" 2>/dev/null
