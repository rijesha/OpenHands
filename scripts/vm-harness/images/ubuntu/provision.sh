#!/usr/bin/env bash
# Provisions the Ubuntu 24.04 Desktop golden image. Run INSIDE the guest as user 'zide' (needs sudo):
#   bash provision.sh "<contents of guest_ed25519.pub>" [vscode-deb-url]
# Does NOT install git/python/node: host-tools installs must look like a clean user machine.
set -euo pipefail
PUBKEY="${1:?usage: provision.sh <public key> [vscode-deb-url]}"
DEB_URL="${2:-https://update.code.visualstudio.com/latest/linux-deb-x64/stable}"
USER_NAME="$(id -un)"
HERE="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive
# sudo strips env vars, so pass the frontend explicitly and preseed the VS Code repo question.
APT="sudo env DEBIAN_FRONTEND=noninteractive apt-get"

echo "== authorized key"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
grep -qxF "$PUBKEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$PUBKEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

echo "== packages (ssh server, Hyper-V KVP daemon)"
$APT update -y
$APT install -y openssh-server linux-cloud-tools-virtual wget ca-certificates
sudo systemctl enable --now ssh

echo "== no background apt: it would hold the dpkg lock during host-tools installs"
sudo systemctl disable --now apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
sudo systemctl mask apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
$APT remove -y unattended-upgrades update-notifier 2>/dev/null || true

echo "== GDM: Xorg session + autologin"
sudo mkdir -p /etc/gdm3
sudo tee /etc/gdm3/custom.conf >/dev/null <<EOF
[daemon]
WaylandEnable=false
AutomaticLoginEnable=true
AutomaticLogin=${USER_NAME}
EOF

echo "== no lock / blank / welcome tour"
gsettings set org.gnome.desktop.screensaver lock-enabled false || true
gsettings set org.gnome.desktop.session idle-delay 0 || true
gsettings set org.gnome.desktop.notifications show-banners false || true
mkdir -p ~/.config && echo "yes" > ~/.config/gnome-initial-setup-done

echo "== resolution 1280x800 (hyperv_drm)"
if ! grep -q 'video=hyperv_fb:1280x800' /etc/default/grub; then
  sudo sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT="\(.*\)"/GRUB_CMDLINE_LINUX_DEFAULT="\1 video=hyperv_fb:1280x800 video=Virtual-1:1280x800"/' /etc/default/grub
  sudo update-grub
fi

echo "== VS Code (.deb)"
echo "code code/add-microsoft-repo boolean false" | sudo debconf-set-selections
wget -qO /tmp/vscode.deb "$DEB_URL"
$APT install -y /tmp/vscode.deb
mkdir -p ~/.config/Code/User ~/.vscode
cp "$HERE/../common/vscode-settings.json" ~/.config/Code/User/settings.json
echo '{ "enable-crash-reporter": false, "password-store": "basic" }' > ~/.vscode/argv.json

echo "== work dirs"
mkdir -p ~/zide-in ~/zide-run ~/zide-bin ~/zws
cp "$HERE/launch-vscode.sh" ~/zide-bin/launch-vscode.sh && chmod +x ~/zide-bin/launch-vscode.sh

echo "Provisioned. Reboot, run validate.sh, shut down, then 'ai-qa images seal'."
