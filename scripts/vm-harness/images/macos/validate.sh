#!/usr/bin/env bash
# Run INSIDE the macOS guest (after a reboot) before sealing. Exit 0 only if all checks pass.
fails=0
check() { if eval "$2" >/dev/null 2>&1; then echo "PASS  $1"; else echo "FAIL  $1"; fails=$((fails+1)); fi; }
check "Remote Login (sshd) on"           "nc -z 127.0.0.1 22"
check "authorized key present"           "test -s ~/.ssh/authorized_keys"
check "Screen Sharing listening on 5900" "nc -z 127.0.0.1 5900"
check "VS Code installed"                "test -d '/Applications/Visual Studio Code.app'"
check "VS Code settings"                 "test -s ~/'Library/Application Support/Code/User/settings.json'"
check "autologin desktop (Finder)"       "pgrep -u \$(id -u) -x Finder"
check "autologin configured"             "defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser"
check "no sleep"                         "pmset -g | grep -E '^ sleep +0'"
check "provisioning sudo rule removed"   "! test -e /etc/sudoers.d/vmh-provision"
check "clean shutdown allowed"           "sudo -n -l /sbin/shutdown"
for t in git node uv west; do
  # /usr/bin/git is a stub that offers to install the Command Line Tools: only count a real install.
  check "$t absent (clean user machine)" "! (command -v $t && $t --version)"
done
check "launcher present"                 "test -x ~/zide-bin/launch-vscode.sh"
echo "INFO  screen: $(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Resolution/{print $2; exit}')"
[ "$fails" -eq 0 ] && echo "All checks passed" || { echo "$fails check(s) failed"; exit 1; }
