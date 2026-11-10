#!/usr/bin/env bash
# Run INSIDE the Ubuntu guest (after a reboot) before sealing. Exit 0 only if all checks pass.
fails=0
check() { if eval "$2" >/dev/null 2>&1; then echo "PASS  $1"; else echo "FAIL  $1"; fails=$((fails+1)); fi; }
check "sshd active"                      "systemctl is-active ssh"
check "authorized key present"           "test -s ~/.ssh/authorized_keys"
check "VS Code installed"                "command -v code"
check "VS Code settings"                 "test -s ~/.config/Code/User/settings.json"
check "gnome-shell running (autologin)"  "pgrep -u \$(id -u) -x gnome-shell"
echo "INFO  Ubuntu 26.04 is Wayland-only: input/screenshots go through Hyper-V and CDP through VS Code, so no Xorg is needed"
check "Wayland session running"          "pgrep -u \$(id -u) -f gdm-wayland-session"
check "KVP daemon"                       "pgrep -f hv_kvp_daemon || systemctl is-active hv-kvp-daemon"
check "apt-daily timers disabled"        "! systemctl is-enabled apt-daily.timer"
check "no apt/dpkg lock held"            "! sudo fuser /var/lib/dpkg/lock-frontend"
for t in git node uv west; do
  check "$t absent (clean user machine)" "! command -v $t"
done
check "launcher present"                 "test -x ~/zide-bin/launch-vscode.sh"
echo "INFO  resolution: $(DISPLAY=:0 xrandr 2>/dev/null | awk '/\*/{print $1; exit}')"
[ "$fails" -eq 0 ] && echo "All checks passed" || { echo "$fails check(s) failed"; exit 1; }
