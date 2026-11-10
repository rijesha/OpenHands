#!/usr/bin/env bash
# Run over SSH. Starts VS Code on the autologin GNOME session (Wayland on Ubuntu 26.04, with XWayland available).
#   launch-vscode.sh <workspace> <cdpPort> [extra args...]
# The display variables come from the systemd *user manager*: gnome-shell's own environment does not contain them.
set -euo pipefail
WS="${1:?workspace}"; PORT="${2:?cdp port}"; shift 2 || true
UENV="$(systemctl --user show-environment)"
getenv() { printf '%s\n' "$UENV" | sed -n "s/^$1=//p" | head -n1; }
WD="$(getenv WAYLAND_DISPLAY)"; DP="$(getenv DISPLAY)"
[ -n "$WD$DP" ] || { echo "no graphical session yet (desktop not ready)" >&2; exit 2; }
UNIT="zide-vscode-$(date +%s)"
# Plain `code` is a wrapper that exits at once; run the real binary in the foreground so the unit stays alive.
systemd-run --user --unit "$UNIT" \
  --setenv=DISPLAY="$DP" --setenv=XAUTHORITY="$(getenv XAUTHORITY)" --setenv=WAYLAND_DISPLAY="$WD" \
  --setenv=XDG_RUNTIME_DIR="$(getenv XDG_RUNTIME_DIR)" --setenv=DBUS_SESSION_BUS_ADDRESS="$(getenv DBUS_SESSION_BUS_ADDRESS)" \
  /usr/share/code/code --ozone-platform-hint=auto --remote-debugging-port="$PORT" "$@" "$WS" >/dev/null
echo "$UNIT"
