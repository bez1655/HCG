#!/usr/bin/env bash
# Снять GUI/VNC/звук — не нужны HCG/ACG в Telegram.
# Запуск от root:  bash purge-desktop.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get purge -y \
  xfce4 xfce4-goodies xfce4-session xfce4-panel xfce4-terminal \
  xfce4-settings xfce4-notifyd xfdesktop4 xfwm4 xfconf \
  thunar thunar-data thunar-volman thunar-archive-plugin thunar-media-tags-plugin \
  tumbler tumbler-common mousepad ristretto xarchiver xfburn \
  lightdm lightdm-gtk-greeter light-locker \
  nemo nemo-data nemo-fileroller muffin muffin-common \
  mate-polkit mate-polkit-common mate-icon-theme \
  xorg xserver-xorg xserver-xorg-core xserver-xorg-legacy \
  xserver-xorg-input-all xserver-xorg-video-all \
  x11-apps x11-utils x11-session-utils x11-xserver-utils x11-xkb-utils \
  xvfb xinit xrdp xorgxrdp \
  tigervnc-standalone-server tigervnc-common tigervnc-tools \
  pulseaudio pulseaudio-utils pulseaudio-module-bluetooth \
  pipewire pipewire-bin pipewire-pulse wireplumber pavucontrol \
  modemmanager rustdesk \
  podman netavark \
  mkdocs mkdocs-get-deps \
  postfix mailutils mailutils-common \
  ruby ruby3.3 rake \
  sane-utils sane-airscan \
  yelp zenity zutty \
  2>/dev/null || true

apt-get autoremove -y --purge
apt-get clean
echo "готово"
