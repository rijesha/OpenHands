#!/usr/bin/env bash
# Run over SSH. Starts VS Code in the autologin user's GUI session with Chrome DevTools Protocol on <cdpPort>.
#   launch-vscode.sh <workspace> <cdpPort> [extra args...]
# `open` hands the launch to LaunchServices in the logged-in session, so the window appears on the desktop even though
# this script runs from SSH. -n starts a new instance so the CDP flag is honoured.
set -euo pipefail
WS="${1:?workspace}"; PORT="${2:?cdp port}"; shift 2 || true
pgrep -u "$(id -u)" -x Finder >/dev/null || { echo "no graphical session yet (desktop not ready)" >&2; exit 2; }
mkdir -p ~/zide-run
open -n -a "/Applications/Visual Studio Code.app" --args \
  --remote-debugging-port="$PORT" "$@" "$WS" >>~/zide-run/vscode.log 2>&1
echo launched
