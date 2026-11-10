#!/usr/bin/env bash
# Provisions the macOS golden image (UTM, Apple Virtualization). Run INSIDE the guest as the admin user 'zide', over
# SSH (Remote Login must already be on, see README), with the guest password on stdin once:
#   bash provision.sh "<contents of guest_ed25519.pub>" <<< "<guest password>"
# Before this: Setup Assistant done (user zide, no Apple ID, FileVault off), Remote Login and Screen Sharing on, and
# "VNC viewers may control screen with password" set to guest-creds.json's vncPassword.
# Does NOT install Xcode tools, git, python or node: host-tools installs must look like a clean user machine.
set -euo pipefail
PUBKEY="${1:?usage: provision.sh <public key>  (guest password on stdin)}"
VSCODE_URL="${2:-https://update.code.visualstudio.com/latest/darwin-arm64/stable}"
IFS= read -r PASSWORD
USER_NAME="$(id -un)"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== unattended sudo for the rest of this script (removed at the end)"
printf '%s\n' "$PASSWORD" | sudo -S -p '' sh -c "echo '${USER_NAME} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/vmh-provision && chmod 440 /etc/sudoers.d/vmh-provision"
# vm_snapshot / vm_save_base shut the guest down with `sudo -n shutdown -h now`: keep that one allowed.
sudo sh -c "echo '${USER_NAME} ALL=(root) NOPASSWD:/sbin/shutdown' > /etc/sudoers.d/vmh-shutdown && chmod 440 /etc/sudoers.d/vmh-shutdown"

echo "== authorized key"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
grep -qxF "$PUBKEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$PUBKEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

echo "== autologin, no lock, no sleep"
sudo sysadminctl -autologin set -userName "$USER_NAME" -password "$PASSWORD"
sysadminctl -screenLock off -password "$PASSWORD" 2>/dev/null || true
sudo pmset -a sleep 0 displaysleep 0 disksleep 0 powernap 0
defaults -currentHost write com.apple.screensaver idleTime -int 0
defaults write com.apple.screensaver askForPassword -int 0

echo "== no background updates or nags"
sudo softwareupdate --schedule off 2>/dev/null || true
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
sudo defaults write /Library/Preferences/com.apple.commerce AutoUpdate -bool false
defaults write com.apple.notificationcenterui bannerTime 0 2>/dev/null || true

echo "== VS Code (universal zip)"
curl -fsSL -o /tmp/vscode.zip "$VSCODE_URL"
rm -rf "/Applications/Visual Studio Code.app"
ditto -x -k /tmp/vscode.zip /Applications
xattr -dr com.apple.quarantine "/Applications/Visual Studio Code.app" || true
mkdir -p ~/"Library/Application Support/Code/User" ~/.vscode
cp "$HERE/../common/vscode-settings.json" ~/"Library/Application Support/Code/User/settings.json"
echo '{ "enable-crash-reporter": false, "password-store": "basic" }' > ~/.vscode/argv.json

echo "== work dirs"
mkdir -p ~/zide-in ~/zide-run ~/zide-bin ~/zws
cp "$HERE/launch-vscode.sh" ~/zide-bin/launch-vscode.sh && chmod +x ~/zide-bin/launch-vscode.sh

echo "== end of unattended provisioning: sudo asks for the password again"
sudo rm -f /etc/sudoers.d/vmh-provision

echo "Provisioned. Reboot (autologin must bring the desktop up), run validate.sh, then 'images seal --os macos'."
