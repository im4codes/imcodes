#!/usr/bin/env bash
# One-shot bootstrap for a headless Debian/Ubuntu or RHEL/CentOS box with no
# desktop at all: installs a real, full-featured GUI session (Xvfb virtual
# display, XFCE, Firefox, text editor, and lightweight desktop tools) and wires
# it up as a persistent systemd service, so the box becomes something IM.codes'
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
ENSURE_USER=0
DISPLAY_NUM=":99"
RESOLUTION="1920x1080x24"
WITH_VNC=0
VNC_PORT="5900"
WITH_FIREFOX=1

usage() {
  cat >&2 <<'USAGE'
usage: install-linux-desktop-environment.sh [--user NAME] [--ensure-user]
         [--display :NN] [--resolution WxHxD] [--with-vnc] [--vnc-port N]
         [--no-firefox]

  --user        Unix account the desktop session and its apps run as.
                Defaults to $SUDO_USER (the account that invoked sudo).
  --ensure-user Create --user as a regular unprivileged user if it does not exist.
  --display     X display number the virtual framebuffer listens on.
                Default: :99
  --resolution  Virtual screen size for Xvfb. Default: 1920x1080x24
  --with-vnc    Also install and start x11vnc against this display, so the
                box is reachable over VNC in addition to direct X11 capture.
  --vnc-port    RFB port for x11vnc. Default: 5900
  --no-firefox  Skip installing Firefox (useful on a box that already has it,
                or where you only want the desktop environment itself).
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) TARGET_USER="${2:?}"; shift 2 ;;
    --ensure-user) ENSURE_USER=1; shift ;;
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
if [[ "$TARGET_USER" == "root" ]]; then
  TARGET_USER="imcodes-desktop"
  ENSURE_USER=1
fi
if ! id -u "$TARGET_USER" >/dev/null 2>&1; then
  if [[ "$ENSURE_USER" -eq 1 ]]; then
    if command -v useradd >/dev/null 2>&1; then
      useradd -m -s /bin/bash "$TARGET_USER"
    elif command -v adduser >/dev/null 2>&1; then
      adduser --disabled-password --gecos "" --shell /bin/bash "$TARGET_USER"
    else
      echo "cannot create user $TARGET_USER: neither useradd nor adduser available" >&2
      exit 1
    fi
  else
    echo "no such user: $TARGET_USER" >&2
    exit 1
  fi
fi
PKG_MGR=""
if command -v apt-get >/dev/null 2>&1; then
  PKG_MGR="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG_MGR="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG_MGR="yum"
else
  echo 'this script is apt-based (Debian/Ubuntu) or dnf/yum-based (CentOS/RHEL)' >&2
  exit 1
fi

TARGET_GROUP="$(id -gn "$TARGET_USER" 2>/dev/null || echo "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
if [[ -z "$TARGET_HOME" || ! -d "$TARGET_HOME" ]]; then
  if [[ "$ENSURE_USER" -eq 1 && -n "$TARGET_HOME" ]]; then
    install -d -m 0755 -o "$TARGET_USER" -g "$TARGET_GROUP" "$TARGET_HOME"
  else
    echo "no home directory for $TARGET_USER" >&2
    exit 1
  fi
fi

apt_run() {
  local attempt=1
  local max_attempts=3
  local rc=0
  while [[ "$attempt" -le "$max_attempts" ]]; do
    if apt-get "$@" -o DPkg::Lock::Timeout=180 -o Acquire::Retries=3; then
      return 0
    else
      rc=$?
    fi
    if [[ "$attempt" -lt "$max_attempts" ]]; then
      dpkg --configure -a 2>/dev/null || true
      sleep 5
    fi
    attempt=$((attempt + 1))
  done
  return "$rc"
}

line_is_active_mozilla() {
  local line="$1"
  local trimmed="${line#"${line%%[![:space:]]*}"}"
  [[ -z "$trimmed" || "$trimmed" == \#* ]] && return 1
  local active="${trimmed%%#*}"
  [[ "$active" == *"packages.mozilla.org"* ]]
}

# Filter a single APT .list or Deb822 .sources file by record/stanza.
# mode="exclude_mozilla" keeps non-Mozilla records; mode="only_mozilla" keeps
# only Mozilla records. Returns 0 if at least one active record was written.
filter_apt_source_file() {
  local src_file="$1"
  local dst_file="$2"
  local mode="$3"
  local wrote_active=0

  if [[ "$src_file" == *.sources ]]; then
    local line="" stanza="" stanza_has_mozilla=0 stanza_has_active=0 first_stanza=1
    : > "$dst_file"
    deb822_is_uris_field() {
      local line="$1"
      [[ "$line" != [[:space:]]* && "$line" == *:* ]] || return 1
      local field_name="${line%%:*}"
      field_name="${field_name%"${field_name##*[![:space:]]}"}"
      [[ "${field_name,,}" == "uris" ]]
    }

    flush_stanza() {
      [[ "$stanza_has_active" -eq 1 ]] || return 0
      local out_stanza="" sline=""
      local in_uris=0 saw_uris=0 stanza_has_mozilla=0
      local uri_tokens_all=""
      local -a stanza_lines=()

      while IFS= read -r sline; do
        [[ -n "${sline//[[:space:]]/}" ]] || continue
        stanza_lines+=("$sline")
        local strimmed="${sline#"${sline%%[![:space:]]*}"}"
        [[ "$strimmed" == \#* ]] && continue
        if [[ "$sline" != [[:space:]]* ]]; then
          if deb822_is_uris_field "$sline"; then
            saw_uris=1
            in_uris=1
            local first_val="${sline#*:}"
            uri_tokens_all+=" ${first_val%%#*}"
          else
            in_uris=0
            if line_is_active_mozilla "$sline"; then
              stanza_has_mozilla=1
            fi
          fi
        elif [[ "$in_uris" -eq 1 ]]; then
          uri_tokens_all+=" ${sline%%#*}"
        elif line_is_active_mozilla "$sline"; then
          stanza_has_mozilla=1
        fi
      done <<< "${stanza%$'\n'}"

      if [[ "$saw_uris" -eq 1 ]]; then
        local -a kept_uris=()
        local tok=""
        for tok in $uri_tokens_all; do
          if [[ "$tok" == *"packages.mozilla.org"* ]]; then
            stanza_has_mozilla=1
            [[ "$mode" == "only_mozilla" ]] && kept_uris+=("$tok")
          else
            [[ "$mode" == "exclude_mozilla" ]] && kept_uris+=("$tok")
          fi
        done
        if [[ ${#kept_uris[@]} -eq 0 ]]; then
          return 0
        fi
        in_uris=0
        local emitted_uris=0
        for sline in "${stanza_lines[@]}"; do
          local strimmed="${sline#"${sline%%[![:space:]]*}"}"
          if [[ "$sline" != [[:space:]]* && "$strimmed" != \#* ]]; then
            if deb822_is_uris_field "$sline"; then
              in_uris=1
              if [[ "$emitted_uris" -eq 0 ]]; then
                out_stanza+="URIs: ${kept_uris[*]}"$'\n'
                emitted_uris=1
              fi
              continue
            else
              in_uris=0
            fi
          elif [[ "$in_uris" -eq 1 ]]; then
            continue
          fi
          out_stanza+="$sline"$'\n'
        done
      else
        if [[ ( "$mode" == "exclude_mozilla" && "$stanza_has_mozilla" -eq 1 ) \
           || ( "$mode" == "only_mozilla" && "$stanza_has_mozilla" -eq 0 ) ]]; then
          return 0
        fi
        out_stanza="$stanza"
      fi

      if [[ "$first_stanza" -eq 0 ]]; then
        printf '\n' >> "$dst_file"
      fi
      printf '%s' "$out_stanza" >> "$dst_file"
      first_stanza=0
      wrote_active=1
    }
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      if [[ -z "${line//[[:space:]]/}" ]]; then
        flush_stanza
        stanza=""
        stanza_has_mozilla=0
        stanza_has_active=0
        continue
      fi
      stanza+="$line"$'\n'
      local trimmed="${line#"${line%%[![:space:]]*}"}"
      if [[ -n "$trimmed" && "$trimmed" != \#* ]]; then
        stanza_has_active=1
        if line_is_active_mozilla "$line"; then
          stanza_has_mozilla=1
        fi
      fi
    done < "$src_file"
    flush_stanza
  else
    local line=""
    : > "$dst_file"
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      local trimmed="${line#"${line%%[![:space:]]*}"}"
      if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
        [[ "$mode" == "exclude_mozilla" ]] && printf '%s\n' "$line" >> "$dst_file"
        continue
      fi
      if line_is_active_mozilla "$line"; then
        if [[ "$mode" == "only_mozilla" ]]; then
          printf '%s\n' "$line" >> "$dst_file"
          wrote_active=1
        fi
      else
        if [[ "$mode" == "exclude_mozilla" ]]; then
          printf '%s\n' "$line" >> "$dst_file"
          wrote_active=1
        fi
      fi
    done < "$src_file"
  fi

  if [[ "$wrote_active" -eq 1 ]]; then
    return 0
  fi
  rm -f "$dst_file"
  return 1
}

# Build a filtered temporary APT view (main sources.list + sources.list.d parts)
# for either "exclude_mozilla" or "only_mozilla". Returns 0 if any Mozilla record
# was encountered in the host sources, 1 otherwise.
build_filtered_apt_sources() {
  local mode="$1"
  local out_main="$2"
  local out_parts="$3"
  local saw_mozilla=0
  local f=""

  mkdir -p "$out_parts"
  : > "$out_main"

  if [[ -f /etc/apt/sources.list ]]; then
    local probe_tmp="$out_parts/.main-probe.list"
    if filter_apt_source_file /etc/apt/sources.list "$probe_tmp" "only_mozilla"; then
      saw_mozilla=1
      rm -f "$probe_tmp"
    fi
    if [[ "$mode" == "only_mozilla" ]]; then
      filter_apt_source_file /etc/apt/sources.list "$out_main" "only_mozilla" || : > "$out_main"
    else
      filter_apt_source_file /etc/apt/sources.list "$out_main" "exclude_mozilla" || : > "$out_main"
    fi
  fi

  for f in /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [[ -f "$f" ]] || continue
    local base="${f##*/}"
    local probe_part="$out_parts/.probe-$base"
    if filter_apt_source_file "$f" "$probe_part" "only_mozilla"; then
      saw_mozilla=1
      rm -f "$probe_part"
    fi
    filter_apt_source_file "$f" "$out_parts/$base" "$mode" || true
  done

  [[ "$saw_mozilla" -eq 1 ]]
}

# Isolate base Debian/Ubuntu source updates from any third-party Mozilla APT
# records so a transiently unreachable packages.mozilla.org never aborts
# required desktop package installation while keeping strict Error-Mode=any
# on every distribution repository record (even inside mixed .list/.sources files).
apt_update_base() {
  local tmp_apt=""
  tmp_apt="$(mktemp -d)"
  chmod 0711 "$tmp_apt"
  local tmp_parts="$tmp_apt/sources.list.d"
  local tmp_main="$tmp_apt/sources.list"
  mkdir -p "$tmp_parts"
  chmod 0755 "$tmp_parts"

  local rc=0
  if ! build_filtered_apt_sources "exclude_mozilla" "$tmp_main" "$tmp_parts"; then
    rm -rf "$tmp_apt"
    apt_run update -qq -o APT::Update::Error-Mode=any
    return $?
  fi

  chmod 0644 "$tmp_main"
  local pf=""
  for pf in "$tmp_parts"/*; do
    [[ -f "$pf" ]] && chmod 0644 "$pf"
  done
  apt_run update -qq -o APT::Update::Error-Mode=any -o APT::List-Cleanup=0 \
    -o Dir::Etc::sourcelist="$tmp_main" -o Dir::Etc::sourceparts="$tmp_parts" || rc=$?
  rm -rf "$tmp_apt"
  return "$rc"
}

echo "== installing desktop packages for $TARGET_USER on display $DISPLAY_NUM using $PKG_MGR =="

if [[ "$PKG_MGR" == "apt" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt_update_base

  BASE_PACKAGES=(
    xvfb
    x11-utils
    x11-xserver-utils
    xauth
    dbus-x11
    libx11-6
    libxext6
    libxtst6
    libxfixes3
    libxrandr2
    # A real, full desktop environment, not a bare window manager + dock --
    # xfce4 pulls in xfwm4, the panel, the desktop manager, and xfce4-terminal;
    # xfce4-goodies is deliberately skipped (adds a large app set this
    # remote-desktop test target does not need).
    xfce4
  )
  [[ "$WITH_VNC" -eq 1 ]] && BASE_PACKAGES+=(x11vnc)
  apt_run install -y -qq "${BASE_PACKAGES[@]}"

  OPTIONAL_PACKAGES=(
    mousepad
    ristretto
    xarchiver
    xfce4-taskmanager
    xfce4-screenshooter
    unzip
    zip
    curl
    wget
    ca-certificates
    xfce4-whiskermenu-plugin
    fonts-noto-core
    fonts-noto-color-emoji
  )
  if ! apt-get install -y -qq "${OPTIONAL_PACKAGES[@]}" -o DPkg::Lock::Timeout=180; then
    for opt_pkg in "${OPTIONAL_PACKAGES[@]}"; do
      apt-get install -y -qq "$opt_pkg" -o DPkg::Lock::Timeout=180 || true
    done
  fi
  # PipeWire-based desktops (Ubuntu 24.04/26.04, Debian 13) conflict with pulseaudio;
  # our Linux worker already uses SilentAudioDeviceModule, so only install pulseaudio
  # best-effort when pipewire-pulse is absent.
  if ! dpkg -s pipewire-pulse >/dev/null 2>&1; then
    apt-get install -y -qq pulseaudio -o DPkg::Lock::Timeout=180 || true
  fi
elif [[ "$PKG_MGR" == "dnf" || "$PKG_MGR" == "yum" ]]; then
  # On CentOS/RHEL/Fedora, ensure EPEL repository is present for XFCE packages
  if ! rpm -q epel-release >/dev/null 2>&1; then
    "$PKG_MGR" install -y -q epel-release || true
  fi
  BASE_PACKAGES=(
    xorg-x11-server-Xvfb
    xorg-x11-xauth
    xorg-x11-utils
    dbus-x11
    xfce4-session
    xfwm4
    xfce4-panel
    xfdesktop
    xfce4-terminal
    thunar
  )
  [[ "$WITH_VNC" -eq 1 ]] && BASE_PACKAGES+=(x11vnc)
  "$PKG_MGR" install -y -q "${BASE_PACKAGES[@]}"
  OPTIONAL_PACKAGES=(
    mousepad
    ristretto
    xarchiver
    xfce4-taskmanager
    xfce4-screenshooter
    unzip
    zip
    curl
    wget
  )
  if ! "$PKG_MGR" install -y -q "${OPTIONAL_PACKAGES[@]}"; then
    for opt_pkg in "${OPTIONAL_PACKAGES[@]}"; do
      "$PKG_MGR" install -y -q "$opt_pkg" || true
    done
  fi
  "$PKG_MGR" install -y -q pulseaudio || true
fi

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
# Probe/install Mozilla in an isolated temporary APT config first, promote
# only newly created files after success (never overwriting or deleting
# pre-existing admin configs), and fall back best-effort to firefox-esr.
install_firefox_apt() {
  local key_file="/etc/apt/keyrings/packages.mozilla.org.asc"
  local list_file="/etc/apt/sources.list.d/mozilla.list"
  local pin_file="/etc/apt/preferences.d/mozilla"
  local mozilla_ok=1
  local has_existing_mozilla=0
  local f=""

  if ! command -v curl >/dev/null 2>&1; then
    apt-get install -y -qq curl ca-certificates -o DPkg::Lock::Timeout=180 || true
  fi

  local tmp_apt=""
  tmp_apt="$(mktemp -d)"
  # _apt drops root privileges during GPG key reads; keep the temp root only
  # traversable by others (0711) and readable configs/keys 0644 (root-writable only).
  chmod 0711 "$tmp_apt"
  local tmp_sources="$tmp_apt/sources.list.d"
  local tmp_main="$tmp_apt/sources.list"
  local tmp_combined_sources="$tmp_apt/combined.list.d"
  local tmp_prefs="$tmp_apt/preferences.d"
  local tmp_key="$tmp_apt/packages.mozilla.org.asc"
  mkdir -p "$tmp_sources" "$tmp_combined_sources" "$tmp_prefs"
  chmod 0755 "$tmp_sources" "$tmp_combined_sources" "$tmp_prefs"

  for f in /etc/apt/preferences.d/*; do
    [[ -f "$f" ]] || continue
    cp -f "$f" "$tmp_prefs/${f##*/}"
  done
  if [[ ! -e "$pin_file" ]]; then
    cat > "$tmp_prefs/mozilla" <<'PIN'
Package: firefox*
Pin: origin packages.mozilla.org
Pin-Priority: 1001
PIN
  fi

  if build_filtered_apt_sources "only_mozilla" "$tmp_main" "$tmp_sources"; then
    has_existing_mozilla=1
  else
    local effective_key="$key_file"
    if [[ ! -f "$key_file" ]]; then
      if ! command -v curl >/dev/null 2>&1 || ! curl -fsSL --connect-timeout 15 --max-time 60 \
        https://packages.mozilla.org/apt/repo-signing-key.gpg \
        -o "$tmp_key"; then
        mozilla_ok=0
      else
        chmod 0644 "$tmp_key"
        effective_key="$tmp_key"
      fi
    fi
    if [[ "$mozilla_ok" -eq 1 ]]; then
      printf 'deb [signed-by=%s] https://packages.mozilla.org/apt mozilla main\n' "$effective_key" \
        > "$tmp_sources/mozilla.list"
      chmod 0644 "$tmp_sources/mozilla.list"
    fi
  fi

  if [[ "$mozilla_ok" -eq 1 ]]; then
    chmod 0644 "$tmp_main"
    for f in "$tmp_sources"/*; do
      [[ -f "$f" ]] && chmod 0644 "$f"
    done
    for f in /etc/apt/sources.list.d/*; do
      [[ -f "$f" ]] || continue
      cp -f "$f" "$tmp_combined_sources/${f##*/}"
    done
    if [[ "$has_existing_mozilla" -eq 0 && -f "$tmp_sources/mozilla.list" ]]; then
      cp -f "$tmp_sources/mozilla.list" "$tmp_combined_sources/mozilla.list"
    fi

    if ! apt_run update -qq -o APT::Update::Error-Mode=any -o APT::List-Cleanup=0 \
      -o Dir::Etc::sourcelist="$tmp_main" -o Dir::Etc::sourceparts="$tmp_sources"; then
      mozilla_ok=0
    elif ! apt_run install -y -qq firefox \
      -o Dir::Etc::sourceparts="$tmp_combined_sources" \
      -o Dir::Etc::preferencesparts="$tmp_prefs"; then
      mozilla_ok=0
    fi
  fi

  if [[ "$mozilla_ok" -eq 1 ]]; then
    if [[ "$has_existing_mozilla" -eq 0 && ! -e "$list_file" ]]; then
      if [[ ! -e "$key_file" && -f "$tmp_key" ]]; then
        install -d -m 0755 /etc/apt/keyrings
        cp -f "$tmp_key" "$key_file"
        chmod 0644 "$key_file"
      fi
      printf 'deb [signed-by=%s] https://packages.mozilla.org/apt mozilla main\n' "$key_file" \
        > "$list_file"
      chmod 0644 "$list_file"
    fi
    if [[ ! -e "$pin_file" ]]; then
      cp -f "$tmp_prefs/mozilla" "$pin_file"
      chmod 0644 "$pin_file"
    fi
    rm -rf "$tmp_apt"
    return 0
  fi

  rm -rf "$tmp_apt"
  echo "WARN: Mozilla APT Firefox install failed; attempting firefox-esr fallback" >&2
  apt-get install -y -qq firefox-esr -o DPkg::Lock::Timeout=180 || \
    echo "WARN: firefox-esr fallback unavailable; continuing desktop setup without Firefox" >&2
}

if [[ "$WITH_FIREFOX" -eq 1 ]] && ! command -v firefox >/dev/null 2>&1 && ! command -v firefox-esr >/dev/null 2>&1; then
  if [[ "$PKG_MGR" == "apt" ]]; then
    install_firefox_apt
  elif [[ "$PKG_MGR" == "dnf" || "$PKG_MGR" == "yum" ]]; then
    "$PKG_MGR" install -y -q firefox || true
  fi
elif [[ "$WITH_FIREFOX" -eq 1 ]]; then
  echo "firefox already installed, skipping Mozilla repo setup"
fi

# Wire XFCE default WebBrowser helper inside the target user's privilege
# boundary (via runuser/su) so root never opens or chowns paths inside
# $TARGET_HOME, and register a user-level .desktop helper when only an
# unregistered binary (e.g. firefox-esr without a firefox alias) exists.
run_as_target_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$TARGET_USER" -g "$TARGET_GROUP" -- "$@"
  elif command -v su >/dev/null 2>&1; then
    local cmd_str=""
    printf -v cmd_str '%q ' "$@"
    su -s /bin/bash "$TARGET_USER" -c "$cmd_str"
  else
    echo "WARN: neither runuser nor su available; skipping user XFCE helper setup" >&2
    return 1
  fi
}

if command -v firefox >/dev/null 2>&1 || command -v firefox-esr >/dev/null 2>&1; then
  run_as_target_user env HOME="$TARGET_HOME" PATH="$PATH" \
    XDG_DATA_HOME="${XDG_DATA_HOME:-$TARGET_HOME/.local/share}" \
    XDG_DATA_DIRS="${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" \
    bash -s -- "$TARGET_HOME" <<'XFCE_HELPER_SETUP' || true
set -euo pipefail
TARGET_HOME="$1"
XDG_DATA_HOME="${XDG_DATA_HOME:-$TARGET_HOME/.local/share}"
XDG_DATA_DIRS="${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"

safe_ensure_dir_under() {
  local root="$1"
  shift
  local cur="$root" comp=""
  [[ -d "$cur" ]] || return 1
  for comp in "$@"; do
    cur="$cur/$comp"
    if [[ -L "$cur" ]]; then
      echo "WARN: refusing to traverse symlink $cur" >&2
      return 1
    elif [[ -e "$cur" ]]; then
      if [[ ! -d "$cur" ]]; then
        echo "WARN: unexpected non-directory at $cur" >&2
        return 1
      fi
    else
      mkdir -m 0700 "$cur" || return 1
    fi
  done
  return 0
}

safe_write_regular_file() {
  local target_file="$1"
  local content="$2"
  local parent_dir="${target_file%/*}"
  if [[ -L "$target_file" ]]; then
    echo "WARN: refusing to modify symlink $target_file" >&2
    return 1
  fi
  if [[ -e "$target_file" && ! -f "$target_file" ]]; then
    echo "WARN: refusing to overwrite non-regular file $target_file" >&2
    return 1
  fi
  local tmp_file=""
  tmp_file="$(mktemp "$parent_dir/.imcodes-tmp.XXXXXX")" || return 1
  if ! printf '%s' "$content" > "$tmp_file" || ! chmod 0644 "$tmp_file" || ! mv -f "$tmp_file" "$target_file"; then
    rm -f "$tmp_file"
    return 1
  fi
  return 0
}

find_helper_desktop() {
  local id="$1"
  local candidate="$XDG_DATA_HOME/xfce4/helpers/$id.desktop"
  if [[ -e "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  local old_ifs="$IFS" dir=""
  IFS=':'
  for dir in $XDG_DATA_DIRS; do
    [[ -n "$dir" ]] || continue
    candidate="$dir/xfce4/helpers/$id.desktop"
    if [[ -e "$candidate" ]]; then
      IFS="$old_ifs"
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

helper_valid_for_web() {
  local desktop_file="$1"
  [[ -f "$desktop_file" ]] || return 1
  local line="" is_helper=0 is_web=0 binaries=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    case "$line" in
      Type=X-XFCE-Helper) is_helper=1 ;;
      X-XFCE-Category=WebBrowser) is_web=1 ;;
      X-XFCE-Binaries=*) binaries="${line#X-XFCE-Binaries=}" ;;
    esac
  done < "$desktop_file"
  [[ "$is_helper" -eq 1 && "$is_web" -eq 1 && -n "$binaries" ]] || return 1
  local old_ifs="$IFS" bin=""
  IFS=';'
  for bin in $binaries; do
    if [[ -n "$bin" ]] && command -v "$bin" >/dev/null 2>&1; then
      IFS="$old_ifs"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

HELPERS_DIR="$TARGET_HOME/.config/xfce4"
HELPERS_FILE="$HELPERS_DIR/helpers.rc"
if [[ -L "$HELPERS_FILE" ]]; then
  echo "WARN: refusing to touch symlinked $HELPERS_FILE" >&2
  exit 0
fi
if [[ -e "$HELPERS_FILE" && ! -f "$HELPERS_FILE" ]]; then
  echo "WARN: unexpected non-regular file at $HELPERS_FILE" >&2
  exit 0
fi

HAS_WEB_BROWSER=0
if [[ -f "$HELPERS_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*WebBrowser[[:space:]]*= ]]; then
      HAS_WEB_BROWSER=1
      break
    fi
  done < "$HELPERS_FILE"
fi
[[ "$HAS_WEB_BROWSER" -eq 0 ]] || exit 0

SELECTED_ID=""
if FOUND_HELPER="$(find_helper_desktop firefox)" && helper_valid_for_web "$FOUND_HELPER"; then
  SELECTED_ID="firefox"
elif command -v firefox >/dev/null 2>&1; then
  USER_HELPERS_DIR="$TARGET_HOME/.local/share/xfce4/helpers"
  if safe_ensure_dir_under "$TARGET_HOME" .local share xfce4 helpers; then
    FIREFOX_DESKTOP=$'[Desktop Entry]\nVersion=1.0\nEncoding=UTF-8\nType=X-XFCE-Helper\nIcon=firefox\nName=Mozilla Firefox\nStartupNotify=true\nX-XFCE-Category=WebBrowser\nX-XFCE-Binaries=firefox;\nX-XFCE-Commands=%B;\nX-XFCE-CommandsWithParameter=%B "%s";\n'
    if safe_write_regular_file "$USER_HELPERS_DIR/firefox.desktop" "$FIREFOX_DESKTOP" && helper_valid_for_web "$USER_HELPERS_DIR/firefox.desktop"; then
      SELECTED_ID="firefox"
    fi
  fi
elif FOUND_HELPER="$(find_helper_desktop firefox-esr)" && helper_valid_for_web "$FOUND_HELPER"; then
  SELECTED_ID="firefox-esr"
elif command -v firefox-esr >/dev/null 2>&1; then
  USER_HELPERS_DIR="$TARGET_HOME/.local/share/xfce4/helpers"
  if safe_ensure_dir_under "$TARGET_HOME" .local share xfce4 helpers; then
    ESR_DESKTOP=$'[Desktop Entry]\nVersion=1.0\nEncoding=UTF-8\nType=X-XFCE-Helper\nIcon=firefox-esr\nName=Mozilla Firefox ESR\nStartupNotify=true\nX-XFCE-Category=WebBrowser\nX-XFCE-Binaries=firefox-esr;\nX-XFCE-Commands=%B;\nX-XFCE-CommandsWithParameter=%B "%s";\n'
    if safe_write_regular_file "$USER_HELPERS_DIR/firefox-esr.desktop" "$ESR_DESKTOP" && helper_valid_for_web "$USER_HELPERS_DIR/firefox-esr.desktop"; then
      SELECTED_ID="firefox-esr"
    fi
  fi
fi

[[ -n "$SELECTED_ID" ]] || exit 0
safe_ensure_dir_under "$TARGET_HOME" .config xfce4 || exit 0

NEW_HELPERS=""
if [[ -f "$HELPERS_FILE" && -s "$HELPERS_FILE" ]]; then
  EXISTING_HELPERS="$(< "$HELPERS_FILE")"
  if [[ -n "$EXISTING_HELPERS" ]]; then
    NEW_HELPERS="${EXISTING_HELPERS}"$'\n'"WebBrowser=${SELECTED_ID}"$'\n'
  else
    NEW_HELPERS="WebBrowser=${SELECTED_ID}"$'\n'
  fi
else
  NEW_HELPERS="WebBrowser=${SELECTED_ID}"$'\n'
fi
safe_write_regular_file "$HELPERS_FILE" "$NEW_HELPERS" || true
XFCE_HELPER_SETUP
fi

# --- persistent virtual display + session ----------------------------------
RUNTIME_DIR_NAME="imcodes-desktop"
DISPLAY_NUM_BARE="${DISPLAY_NUM#:}"

install -d -m 0755 /usr/local/lib/imcodes
cat > /usr/local/lib/imcodes/imcodes-desktop-session.sh <<SESSION
#!/usr/bin/env bash
# Launched by imcodes-desktop-session.service, as \$TARGET_USER, once Xvfb on
# \$DISPLAY_NUM is already up (After=imcodes-desktop-xvfb.service). Starts a
# dbus session bus (Firefox and XFCE both expect one), a per-session
# pulseaudio (so a real remote-desktop session's AudioDeviceModule has a real
# device to open even on a box with no sound card at all -- see the package
# install step's own comment), and the full XFCE session (window manager,
# panel, desktop manager).
set -euo pipefail
export DISPLAY="$DISPLAY_NUM"
export HOME="$TARGET_HOME"
export XDG_SESSION_TYPE="x11"
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/$RUNTIME_DIR_NAME}"

exec dbus-launch --exit-with-session bash -c '
  pulseaudio --start --exit-idle-time=-1 2>/dev/null || true
  exec startxfce4
'
SESSION
chmod 0755 /usr/local/lib/imcodes/imcodes-desktop-session.sh
printf '%s\n' "$DISPLAY_NUM" > /usr/local/lib/imcodes/desktop-display
chmod 0644 /usr/local/lib/imcodes/desktop-display

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
Description=IM.codes desktop session (XFCE) on $DISPLAY_NUM
After=imcodes-desktop-xvfb.service
Requires=imcodes-desktop-xvfb.service

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
Environment=XDG_SESSION_TYPE=x11
RuntimeDirectory=$RUNTIME_DIR_NAME
RuntimeDirectoryMode=0700
ExecStart=/usr/local/lib/imcodes/imcodes-desktop-session.sh
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable imcodes-desktop-xvfb.service
systemctl restart imcodes-desktop-xvfb.service
# Xvfb needs a moment to actually start accepting connections before the
# session tries to attach to it.
DISPLAY_READY=0
for _ in $(seq 1 20); do
  if DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; then
    DISPLAY_READY=1
    break
  fi
  sleep 0.5
done
if [[ "$DISPLAY_READY" -ne 1 ]]; then
  echo "Xvfb did not become ready on display $DISPLAY_NUM" >&2
  exit 1
fi
systemctl enable imcodes-desktop-session.service
systemctl restart imcodes-desktop-session.service
sleep 1
SESSION_READY=0
for _ in $(seq 1 10); do
  if systemctl is-active --quiet imcodes-desktop-session.service; then
    SESSION_READY=1
    break
  fi
  sleep 0.5
done
if [[ "$SESSION_READY" -ne 1 ]]; then
  echo "imcodes-desktop-session.service did not stay active" >&2
  systemctl status imcodes-desktop-session.service --no-pager -l >&2 || true
  exit 1
fi

if [[ "$WITH_VNC" -eq 1 ]]; then
  cat > /etc/systemd/system/imcodes-desktop-vnc.service <<UNIT
[Unit]
Description=IM.codes x11vnc server for $DISPLAY_NUM
After=imcodes-desktop-session.service
Requires=imcodes-desktop-xvfb.service

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
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
  systemctl enable imcodes-desktop-vnc.service
  systemctl restart imcodes-desktop-vnc.service
fi

echo "== done =="
echo "DISPLAY=$DISPLAY_NUM as user $TARGET_USER (systemctl status imcodes-desktop-session)"
if [[ "$WITH_VNC" -eq 1 ]]; then
  echo "x11vnc listening on 127.0.0.1:$VNC_PORT (no auth -- see the unit's own comment)"
fi
