#!/usr/bin/env bash
# One-shot bootstrap for a headless Debian/Ubuntu box with no desktop at all:
# installs a minimal-but-real GUI session (Xvfb virtual display, openbox
# window manager, plank dock, lxterminal, Firefox) and wires it up as a
# persistent systemd service, so the box becomes something IM.codes'
# remote-desktop native adapters (X11 direct capture, or the VNC backend --
# see --with-vnc below) can actually connect to and show a working desktop
# on, not just an empty root window.
#
# Idempotent: safe to re-run. Does not touch any existing X server, GitLab/
# Docker services, or non-IM.codes systemd units on the host.
#
# Usage: sudo ./install-linux-desktop-environment.sh [--user NAME]
#          [--display :NN] [--resolution WxHxD] [--with-vnc] [--vnc-port N]
#          [--no-firefox]
set -euo pipefail

TARGET_USER="${SUDO_USER:-$(id -un)}"
DISPLAY_NUM=":99"
RESOLUTION="1920x1080x24"
WITH_VNC=0
VNC_PORT="5900"
WITH_FIREFOX=1

usage() {
  cat >&2 <<'USAGE'
usage: install-linux-desktop-environment.sh [--user NAME] [--display :NN]
         [--resolution WxHxD] [--with-vnc] [--vnc-port N] [--no-firefox]

  --user        Unix account the desktop session and its apps run as.
                Defaults to $SUDO_USER (the account that invoked sudo).
  --display     X display number the virtual framebuffer listens on.
                Default: :99
  --resolution  Virtual screen size for Xvfb. Default: 1920x1080x24
  --with-vnc    Also install and start x11vnc against this display, so the
                box is reachable over VNC in addition to direct X11 capture.
  --vnc-port    RFB port for x11vnc. Default: 5900
  --no-firefox  Skip installing Firefox (useful on a box that already has it,
                or where you only want the WM + dock + terminal).
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) TARGET_USER="${2:?}"; shift 2 ;;
    --display) DISPLAY_NUM="${2:?}"; shift 2 ;;
    --resolution) RESOLUTION="${2:?}"; shift 2 ;;
    --with-vnc) WITH_VNC=1; shift ;;
    --vnc-port) VNC_PORT="${2:?}"; shift 2 ;;
    --no-firefox) WITH_FIREFOX=0; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[[ "$EUID" -eq 0 ]] || { echo 'must run as root (sudo)' >&2; exit 1; }
[[ "$DISPLAY_NUM" == :* ]] || { echo '--display must look like :99' >&2; exit 1; }
id -u "$TARGET_USER" >/dev/null 2>&1 || { echo "no such user: $TARGET_USER" >&2; exit 1; }
command -v apt-get >/dev/null || { echo 'this script is apt-based (Debian/Ubuntu only)' >&2; exit 1; }

TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[[ -n "$TARGET_HOME" && -d "$TARGET_HOME" ]] || { echo "no home directory for $TARGET_USER" >&2; exit 1; }

echo "== installing desktop packages for $TARGET_USER on display $DISPLAY_NUM =="

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

BASE_PACKAGES=(
  xvfb
  x11-xserver-utils
  dbus-x11
  openbox
  plank
  lxterminal
  fonts-noto-core
  fonts-noto-color-emoji
  # A fully headless box (no sound card at all -- true of most VMs/CI
  # runners, this one included) has no /proc/asound/cards entry, which
  # makes WebRTC's AudioDeviceModule::Init() hard-fail at session start
  # ("Check failed: 0 == adm->Init()") even though the session never asked
  # for audio to be silent -- it just had nothing to open. pulseaudio gives
  # it a real, if silent, device to open.
  pulseaudio
)
[[ "$WITH_VNC" -eq 1 ]] && BASE_PACKAGES+=(x11vnc)
apt-get install -y -qq "${BASE_PACKAGES[@]}"

# snd-dummy: a real (if fake) ALSA card, independent of pulseaudio -- some
# ADM backends probe ALSA devices directly rather than going through
# pulseaudio's own client library, so both are wired up rather than assuming
# one covers the other. Best-effort: a kernel without the module built in,
# or a container without CAP_SYS_MODULE, just leaves the box relying on
# pulseaudio alone, which the isolated deb install above still provides.
if ! grep -q Dummy /proc/asound/cards 2>/dev/null; then
  modprobe snd-dummy 2>/dev/null || true
  echo snd-dummy > /etc/modules-load.d/imcodes-snd-dummy.conf
fi

# --- Firefox: a REAL .deb, not Ubuntu's transitional snap wrapper ----------
# `apt install firefox` on Ubuntu 22.04+ pulls in a package that just
# installs the snap on first run -- slow to start, and an extra confinement
# layer with no benefit on a purpose-built headless box. Mozilla's own APT
# repo ships a real .deb; a pin makes it win over the Ubuntu transitional
# package of the same name without removing anything the box already has.
if [[ "$WITH_FIREFOX" -eq 1 ]] && ! command -v firefox >/dev/null; then
  install -d -m 0755 /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/packages.mozilla.org.asc ]]; then
    curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg \
      -o /etc/apt/keyrings/packages.mozilla.org.asc
  fi
  echo 'deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main' \
    > /etc/apt/sources.list.d/mozilla.list
  cat > /etc/apt/preferences.d/mozilla <<'PIN'
Package: firefox*
Pin: origin packages.mozilla.org
Pin-Priority: 1001
PIN
  apt-get update -qq
  apt-get install -y -qq firefox
elif [[ "$WITH_FIREFOX" -eq 1 ]]; then
  echo "firefox already installed, skipping Mozilla repo setup"
fi

# --- persistent virtual display + session ----------------------------------
RUNTIME_DIR_NAME="imcodes-desktop"
DISPLAY_NUM_BARE="${DISPLAY_NUM#:}"

install -d -m 0755 /usr/local/lib/imcodes
cat > /usr/local/lib/imcodes/imcodes-desktop-session.sh <<SESSION
#!/usr/bin/env bash
# Launched by imcodes-desktop-session.service, as \$TARGET_USER, once Xvfb on
# \$DISPLAY_NUM is already up (After=imcodes-desktop-xvfb.service). Starts a
# dbus session bus (Firefox and plank both expect one), a per-session
# pulseaudio (so a real remote-desktop session's AudioDeviceModule has a real
# device to open even on a box with no sound card at all -- see the package
# install step's own comment), the openbox window manager, the plank dock,
# one lxterminal window, and Firefox -- so the display isn't just a running X
# server with nothing on it.
set -euo pipefail
export DISPLAY="$DISPLAY_NUM"
export HOME="$TARGET_HOME"
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/$RUNTIME_DIR_NAME}"

exec dbus-launch --exit-with-session bash -c '
  pulseaudio --start --exit-idle-time=-1 || true
  openbox-session &
  # plank and the app launches race the window manager coming up; a fixed
  # settle delay is simpler and just as reliable here as a poll loop, since
  # this is a one-shot session start, not a latency-sensitive path.
  sleep 2
  plank &
  lxterminal &
  $([[ "$WITH_FIREFOX" -eq 1 ]] && echo 'firefox &')
  wait
'
SESSION
chmod 0755 /usr/local/lib/imcodes/imcodes-desktop-session.sh

cat > /etc/systemd/system/imcodes-desktop-xvfb.service <<UNIT
[Unit]
Description=IM.codes virtual X display for remote-desktop testing ($DISPLAY_NUM)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb $DISPLAY_NUM -screen 0 $RESOLUTION -nolisten tcp -ac
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/imcodes-desktop-session.service <<UNIT
[Unit]
Description=IM.codes desktop session (openbox + plank + terminal + firefox) on $DISPLAY_NUM
After=imcodes-desktop-xvfb.service
Requires=imcodes-desktop-xvfb.service

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_USER
RuntimeDirectory=$RUNTIME_DIR_NAME
RuntimeDirectoryMode=0700
ExecStart=/usr/local/lib/imcodes/imcodes-desktop-session.sh
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now imcodes-desktop-xvfb.service
# Xvfb needs a moment to actually start accepting connections before the
# session tries to attach to it.
for _ in $(seq 1 20); do
  DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 && break
  sleep 0.5
done
systemctl enable --now imcodes-desktop-session.service

if [[ "$WITH_VNC" -eq 1 ]]; then
  cat > /etc/systemd/system/imcodes-desktop-vnc.service <<UNIT
[Unit]
Description=IM.codes x11vnc server for $DISPLAY_NUM
After=imcodes-desktop-session.service
Requires=imcodes-desktop-xvfb.service

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_USER
Environment=DISPLAY=$DISPLAY_NUM
# -nopw: this box is a disposable/isolated remote-desktop test target, not a
# credential boundary -- IM.codes' own session/route-authority layer is what
# actually gates who can drive it. A box exposed on a hostile network needs
# -rfbauth with a real password file instead; this script does not attempt
# to guess which situation the caller is in.
ExecStart=/usr/bin/x11vnc -display $DISPLAY_NUM -rfbport $VNC_PORT -forever -shared -nopw -quiet
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now imcodes-desktop-vnc.service
fi

echo "== done =="
echo "DISPLAY=$DISPLAY_NUM as user $TARGET_USER (systemctl status imcodes-desktop-session)"
[[ "$WITH_VNC" -eq 1 ]] && echo "x11vnc listening on 127.0.0.1:$VNC_PORT (no auth -- see the unit's own comment)"
