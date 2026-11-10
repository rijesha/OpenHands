#!/usr/bin/env bash
# Provisions the Ubuntu Desktop golden image. Run INSIDE the guest as user 'zide' (needs sudo):
#   bash provision.sh "<contents of guest_ed25519.pub>" [vscode-deb-url]
# Works on Hyper-V (x64) and UTM/QEMU (arm64) guests; hypervisor-specific steps are picked with systemd-detect-virt.
# Does NOT install git/python/node: host-tools installs must look like a clean user machine.
set -euo pipefail
PUBKEY="${1:?usage: provision.sh <public key> [vscode-deb-url]}"
case "$(uname -m)" in
  aarch64|arm64) DEB_ARCH=arm64 ;;
  *) DEB_ARCH=x64 ;;
esac
DEB_URL="${2:-https://update.code.visualstudio.com/latest/linux-deb-${DEB_ARCH}/stable}"
USER_NAME="$(id -un)"
HERE="$(cd "$(dirname "$0")" && pwd)"
VIRT="$(systemd-detect-virt 2>/dev/null || true)"
export DEBIAN_FRONTEND=noninteractive
# sudo strips env vars, so pass the frontend explicitly and preseed the VS Code repo question.
APT="sudo env DEBIAN_FRONTEND=noninteractive apt-get"

echo "== authorized key"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
grep -qxF "$PUBKEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$PUBKEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

echo "== packages (ssh server, guest integration for ${VIRT:-unknown})"
$APT update -y
if [ "$VIRT" = "microsoft" ]; then
  $APT install -y openssh-server linux-cloud-tools-virtual wget ca-certificates
else
  # QEMU guest agent: lets UTM report the guest's IP (`utmctl ip-address`).
  $APT install -y openssh-server qemu-guest-agent wget ca-certificates
  sudo systemctl enable --now qemu-guest-agent 2>/dev/null || true
fi
sudo systemctl enable --now ssh

echo "== no background apt: it would hold the dpkg lock during host-tools installs"
sudo systemctl disable --now apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
sudo systemctl mask apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
$APT remove -y unattended-upgrades update-notifier 2>/dev/null || true

echo "== GDM autologin"
sudo mkdir -p /etc/gdm3
if [ "$VIRT" = "microsoft" ]; then
  # Hyper-V images (ai-qa recipe) asked GDM for Xorg.
  sudo tee /etc/gdm3/custom.conf >/dev/null <<EOF
[daemon]
WaylandEnable=false
AutomaticLoginEnable=true
AutomaticLogin=${USER_NAME}
EOF
else
  # Ubuntu 25.10+ ships no Xorg session: keep Wayland.
  sudo tee /etc/gdm3/custom.conf >/dev/null <<EOF
[daemon]
AutomaticLoginEnable=true
AutomaticLogin=${USER_NAME}
EOF
fi

echo "== no lock / blank / welcome tour / update prompts"
# gsettings needs the session bus; over SSH borrow the autologin session's when it is up.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "/run/user/$(id -u)/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
fi
gsettings set org.gnome.desktop.screensaver lock-enabled false || true
gsettings set org.gnome.desktop.session idle-delay 0 || true
gsettings set org.gnome.desktop.notifications show-banners false || true
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' || true
mkdir -p ~/.config && echo "yes" > ~/.config/gnome-initial-setup-done

echo "== resolution 1280x800"
if [ "$VIRT" = "microsoft" ]; then
  MODE="video=hyperv_fb:1280x800 video=Virtual-1:1280x800"
else
  MODE="video=Virtual-1:1280x800"
fi
if ! grep -q 'video=Virtual-1:1280x800' /etc/default/grub; then
  sudo sed -i "s/^GRUB_CMDLINE_LINUX_DEFAULT=\"\(.*\)\"/GRUB_CMDLINE_LINUX_DEFAULT=\"\1 ${MODE}\"/" /etc/default/grub
  sudo update-grub
fi

echo "== VS Code (.deb, ${DEB_ARCH})"
echo "code code/add-microsoft-repo boolean false" | sudo debconf-set-selections
wget -qO /tmp/vscode.deb "$DEB_URL"
$APT install -y /tmp/vscode.deb
mkdir -p ~/.config/Code/User ~/.vscode
cp "$HERE/../common/vscode-settings.json" ~/.config/Code/User/settings.json
echo '{ "enable-crash-reporter": false, "password-store": "basic" }' > ~/.vscode/argv.json

echo "== work dirs"
mkdir -p ~/zide-in ~/zide-run ~/zide-bin ~/zws
cp "$HERE/launch-vscode.sh" ~/zide-bin/launch-vscode.sh && chmod +x ~/zide-bin/launch-vscode.sh

echo "== end of unattended provisioning: sudo asks for the password again"
sudo rm -f /etc/sudoers.d/vmh-provision

echo "Provisioned. Reboot, run validate.sh, shut down, then 'images seal'."
