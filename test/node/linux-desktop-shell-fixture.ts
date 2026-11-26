import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Execute the real Bash control flow, relocating only filesystem/identity inputs.
 * No elevated privileges required. PATH contains NO host tools; every external
 * command is a shell function (including failed best-effort modprobe). Generated
 * units/session scripts are inspected, never launched. Unknown commands fail.
 */
export async function desktopShellFixture(dirs: string[], options: {
  apt?: boolean;
  pkgMgr?: 'apt' | 'dnf' | 'yum';
  aptFailTimes?: number;
  firefox?: boolean;
  firefoxEsr?: boolean;
  curlOk?: boolean;
  mozillaRepoDown?: boolean;
  failPackages?: readonly string[];
  pipewirePulse?: boolean;
  primaryGroup?: string;
  existingUsers?: readonly string[];
  fail?: string;
  readyAt?: number;
  euid?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-desktop-shell-'));
  dirs.push(root);
  if (!/^[\w/.-]+$/.test(root)) throw new Error('fixture root must be shell-safe');
  for (const path of ['home', 'bin', 'tmp', 'etc/modules-load.d', 'etc/systemd/system',
    'etc/apt/keyrings', 'etc/apt/sources.list.d', 'etc/apt/preferences.d',
    'usr/local/lib/imcodes', 'usr/share/xfce4/helpers']) {
    await mkdir(join(root, path), { recursive: true });
  }
  await chmod(join(root, 'tmp'), 0o755);
  await writeFile(join(root, 'etc/apt/sources.list'), 'deb http://archive.ubuntu.com/ubuntu noble main\n');
  if (options.mozillaRepoDown) {
    await writeFile(join(root, 'mozilla-down'), '1');
  }
  const initialUsers = (options.existingUsers ?? ['ai', 'ubuntu', 'debian']).join(' ');
  const pkgMgr = options.apt === false ? null : (options.pkgMgr ?? 'apt');
  const failPkgs = new Set(options.failPackages ?? []);
  const failPkgsPattern = [...failPkgs].join(' ');
  const statBin = existsSync('/usr/bin/stat') ? '/usr/bin/stat' : '/bin/stat';
  const mktempBin = existsSync('/usr/bin/mktemp') ? '/usr/bin/mktemp' : '/bin/mktemp';
  const shims = join(root, 'shims.bash');
  await writeFile(shims, `
record() { printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"; }
USERS=" ${initialUsers} "
if [[ -f "$FIXTURE_ROOT/users" ]]; then USERS=$(< "$FIXTURE_ROOT/users"); fi
id() {
  record "id $*"
  if [[ "$1" == "-gn" ]]; then
    printf '%s\\n' "${options.primaryGroup ?? '$2'}"
    return 0
  fi
  if [[ "$1" == "-u" ]]; then
    local target="\${2:-}"
    if [[ -f "$FIXTURE_ROOT/users" ]]; then USERS=$(< "$FIXTURE_ROOT/users"); fi
    [[ "$USERS" == *" $target "* ]] || return 1
    echo 1001
    return 0
  fi
  echo 1001
}
useradd() {
  record "useradd $*"
  local created="\${@: -1}"
  if [[ -f "$FIXTURE_ROOT/users" ]]; then USERS=$(< "$FIXTURE_ROOT/users"); fi
  USERS="$USERS $created "
  printf '%s' "$USERS" > "$FIXTURE_ROOT/users"
}
getent() { printf '%s:x:1001:1001::%s:/bin/bash\\n' "\${2:-ai}" "$HOME"; }
cut() { local line; IFS= read -r line; printf '%s\\n' "$HOME"; }
dpkg() {
  record "dpkg $*"
  if [[ "$1" == "-s" && "$2" == "pipewire-pulse" ]]; then
    return ${options.pipewirePulse ? 0 : 1}
  fi
  return 0
}
rpm() { record "rpm $*"; return 0; }
_apt_resolve_sources() {
  local src_list="$FIXTURE_ROOT/etc/apt/sources.list"
  local src_parts="$FIXTURE_ROOT/etc/apt/sources.list.d"
  local prev="" arg="" f=""
  for arg in "$@"; do
    if [[ "$prev" == "-o" ]]; then
      case "$arg" in
        Dir::Etc::sourcelist=*) src_list="\${arg#Dir::Etc::sourcelist=}" ;;
        Dir::Etc::sourceparts=*) src_parts="\${arg#Dir::Etc::sourceparts=}" ;;
      esac
      prev=""
      continue
    fi
    [[ "$arg" == "-o" ]] && prev="-o"
  done
  APT_ACTIVE_SOURCES=""
  if [[ "$src_list" != "/dev/null" && -f "$src_list" ]]; then
    APT_ACTIVE_SOURCES+="$(< "$src_list")"$'\n'
  fi
  if [[ -d "$src_parts" ]]; then
    for f in "$src_parts"/*.list "$src_parts"/*.sources; do
      [[ -f "$f" ]] || continue
      APT_ACTIVE_SOURCES+="$(< "$f")"$'\n'
    done
  fi
}
_fixture_octal_mode() {
  ${statBin} -c '%a' "$1" 2>/dev/null || ${statBin} -f '%Lp' "$1" 2>/dev/null
}
_apt_verify_key_readable_by_apt() {
  local key_path="$1"
  [[ -f "$key_path" ]] || return 1
  local key_mode=""
  key_mode="$(_fixture_octal_mode "$key_path")" || return 1
  local file_other="\${key_mode: -1}"
  [[ "$file_other" == [4567] ]] || return 1
  local dir="\${key_path%/*}"
  while [[ -n "$dir" && "$dir" == "$FIXTURE_ROOT/"* ]]; do
    local dmode=""
    dmode="$(_fixture_octal_mode "$dir")" || return 1
    local dother="\${dmode: -1}"
    [[ "$dother" == [1357] ]] || return 1
    dir="\${dir%/*}"
  done
  record "apt-key-readable $key_path mode=$key_mode"
  return 0
}
_apt_check_update_sources() {
  _apt_resolve_sources "$@"
  printf '=== UPDATE ===\n%s' "$APT_ACTIVE_SOURCES" >> "$FIXTURE_ROOT/apt-update-history"
  local line="" saw_mozilla=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="\${line%$'\\r'}"
    local trimmed="\${line#"\${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" || "$trimmed" == \\#* ]] && continue
    local active="\${trimmed%%#*}"
    if [[ "$active" == *"packages.mozilla.org"* ]]; then
      saw_mozilla=1
    fi
    local key_path=""
    if [[ "$active" =~ [Ss][Ii][Gg][Nn][Ee][Dd]-[Bb][Yy]=([^][:space:]]+) ]]; then
      key_path="\${BASH_REMATCH[1]}"
    elif [[ "$active" =~ ^[Ss][Ii][Gg][Nn][Ee][Dd]-[Bb][Yy]:[[:space:]]*([^[:space:]]+) ]]; then
      key_path="\${BASH_REMATCH[1]}"
    fi
    if [[ -n "$key_path" && "$key_path" == "$FIXTURE_ROOT/"* ]]; then
      if ! _apt_verify_key_readable_by_apt "$key_path"; then
        echo "E: _apt cannot read Signed-By key $key_path" >&2
        return 100
      fi
    fi
  done <<< "$APT_ACTIVE_SOURCES"
  if [[ "$saw_mozilla" -eq 1 && -f "$FIXTURE_ROOT/mozilla-down" ]]; then
    return 100
  fi
  return 0
}
_pkg_install_hook() {
  local mgr="$1"
  shift
  local fail_list=" ${failPkgsPattern} "
  local arg
  for arg in "$@"; do
    [[ "$arg" == -* || "$arg" == "install" || "$arg" == "DPkg::Lock::Timeout="* || "$arg" == Dir::* || "$arg" == APT::* ]] && continue
    if [[ "$fail_list" == *" $arg "* ]]; then
      return 100
    fi
  done
  for arg in "$@"; do
    if [[ "$arg" == "firefox" ]]; then
      printf '#!/bin/sh\\nexit 0\\n' > "$FIXTURE_ROOT/bin/firefox"
      /bin/chmod +x "$FIXTURE_ROOT/bin/firefox"
    elif [[ "$arg" == "firefox-esr" ]]; then
      printf '#!/bin/sh\\necho "launched firefox-esr $*" >> "$FIXTURE_ROOT/launched-browsers"\\nexit 0\\n' > "$FIXTURE_ROOT/bin/firefox-esr"
      /bin/chmod +x "$FIXTURE_ROOT/bin/firefox-esr"
    fi
  done
  return 0
}
${pkgMgr === 'apt' ? `apt-get() {
  record "apt-get $*"
  local count=0
  if [[ -f "$FIXTURE_ROOT/apt-count" ]]; then count=$(< "$FIXTURE_ROOT/apt-count"); fi
  count=$((count + 1))
  printf '%s' "$count" > "$FIXTURE_ROOT/apt-count"
  if [[ "$FIXTURE_FAIL" == "apt-get $1" ]]; then return 100; fi
  if [[ "$count" -le ${options.aptFailTimes ?? 0} ]]; then return 100; fi
  if [[ "$1" == "update" ]]; then
    _apt_check_update_sources "$@" || return $?
  fi
  if [[ "$1" == "install" ]]; then
    _pkg_install_hook apt-get "$@" || return $?
  fi
  return 0
}` : ''}
${pkgMgr === 'dnf' || pkgMgr === 'yum' ? `${pkgMgr}() {
  record "${pkgMgr} $*"
  if [[ "$1" == "install" ]]; then
    _pkg_install_hook ${pkgMgr} "$@" || return $?
  fi
  return 0
}` : ''}
${options.firefox ? 'firefox() { return 0; }' : ''}
${options.firefoxEsr ? 'firefox-esr() { return 0; }' : ''}
systemctl() { record "systemctl $*"; [[ "$FIXTURE_FAIL" != "systemctl $*" ]] || return 7; }
grep() { return 1; }
modprobe() { record "modprobe $*"; return 1; }
install() {
  record "install $*"
  local create_dir=0 skip_next=0 arg
  for arg in "$@"; do
    if [[ "$skip_next" -eq 1 ]]; then
      skip_next=0
      continue
    fi
    case "$arg" in
      -d) create_dir=1 ;;
      -m|-o|-g) skip_next=1 ;;
      -*) ;;
      *)
        if [[ "$create_dir" -eq 1 && "$arg" == "$FIXTURE_ROOT/"* ]]; then
          /bin/mkdir -p "$arg"
        fi
        ;;
    esac
  done
}
mkdir() {
  record "mkdir $*"
  local -a opts=()
  local skip_next=0 arg=""
  for arg in "$@"; do
    if [[ "$skip_next" -eq 1 ]]; then
      opts+=("$arg")
      skip_next=0
      continue
    fi
    case "$arg" in
      -m) opts+=("$arg"); skip_next=1 ;;
      -*) opts+=("$arg") ;;
      *)
        [[ "$arg" == "$FIXTURE_ROOT/"* ]] && /bin/mkdir "\${opts[@]}" "$arg"
        ;;
    esac
  done
}
mktemp() {
  local -a args=()
  local has_template=0 arg=""
  for arg in "$@"; do
    args+=("$arg")
    [[ "$arg" != -* ]] && has_template=1
  done
  if [[ "$has_template" -eq 0 ]]; then
    args+=("\${TMPDIR:-$FIXTURE_ROOT/tmp}/tmp.XXXXXX")
  fi
  ${mktempBin} "\${args[@]}"
}
cp() {
  local -a args=()
  local arg=""
  for arg in "$@"; do
    args+=("$arg")
  done
  local dest="\${args[\${#args[@]}-1]}"
  if [[ "$dest" == "$FIXTURE_ROOT/"* ]]; then
    /bin/cp "\${args[@]}"
  fi
}
mv() {
  local -a args=()
  local arg=""
  for arg in "$@"; do
    args+=("$arg")
  done
  local dest="\${args[\${#args[@]}-1]}"
  if [[ "$dest" == "$FIXTURE_ROOT/"* ]]; then
    /bin/mv "\${args[@]}"
  fi
}
chmod() {
  record "chmod(euid=$FIXTURE_EUID) $*"
  local mode="$1"
  shift
  local arg=""
  for arg in "$@"; do
    if [[ "$arg" == "$FIXTURE_ROOT/"* && -e "$arg" ]]; then
      /bin/chmod "$mode" "$arg"
    fi
  done
}
chown() { record "chown $*"; }
rm() {
  record "rm $*"
  local recursive=0 arg=""
  for arg in "$@"; do
    case "$arg" in
      -r|-R|-rf|-fr) recursive=1 ;;
      -*) ;;
      *)
        if [[ "$arg" == "$FIXTURE_ROOT/"* ]]; then
          if [[ "$recursive" -eq 1 ]]; then
            /bin/rm -rf "$arg"
          else
            /bin/rm -f "$arg"
          fi
        fi
        ;;
    esac
  done
}
env() {
  while [[ $# -gt 0 && "$1" == *=* ]]; do
    export "$1"
    shift
  done
  "$@"
}
bash() { /bin/bash "$@"; }
runuser() {
  record "runuser $*"
  local target_user="" target_group=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -u) target_user="$2"; shift 2 ;;
      -g) target_group="$2"; shift 2 ;;
      --) shift; break ;;
      *) shift ;;
    esac
  done
  (
    export FIXTURE_EUID=1001
    export FIXTURE_RUNUSER="\${target_user}:\${target_group}"
    record "runuser_exec uid=1001 user=$target_user group=$target_group"
    "$@"
  )
}
curl() {
  record "curl $*"
  if [[ "${options.curlOk ? '1' : '0'}" -eq 1 && ! -f "$FIXTURE_ROOT/mozilla-down" ]]; then
    local next_out=0 arg
    for arg in "$@"; do
      if [[ "$next_out" -eq 1 ]]; then
        if [[ "$arg" == "$FIXTURE_ROOT/"* ]]; then
          printf 'dummy-gpg-key\\n' > "$arg"
        fi
        break
      fi
      [[ "$arg" == "-o" ]] && next_out=1
    done
    return 0
  fi
  return 9
}
cat() { local line; while IFS= read -r line || [[ -n "$line" ]]; do printf '%s\\n' "$line"; done; }
seq() { local n; for ((n=$1; n<=$2; n++)); do echo "$n"; done; }
sleep() { record "sleep $*"; }
xdpyinfo() {
  local n=0
  if [[ -f "$FIXTURE_ROOT/probes" ]]; then n=$(< "$FIXTURE_ROOT/probes"); fi
  n=$((n + 1))
  printf '%s' "$n" > "$FIXTURE_ROOT/probes"
  record "xdpyinfo $DISPLAY"
  [[ "$n" -ge "$FIXTURE_READY_AT" ]]
}
`);
  return {
    root,
    async run(scriptPath: string, args: readonly string[]) {
      const source = await readFile(scriptPath, 'utf8');
      // Keep all conditions, command status, loops, heredocs and set -e intact.
      // The owned root is validated above; no host path is opened for writing.
      const relocated = source.replaceAll('/etc/', '${FIXTURE_ROOT}/etc/')
        .replaceAll('/usr/local/', '${FIXTURE_ROOT}/usr/local/')
        .replaceAll('/usr/share/', '${FIXTURE_ROOT}/usr/share/')
        .replaceAll('"$EUID"', '"$FIXTURE_EUID"')
        .replaceAll('[[ "${field_name,,}" == "uris" ]]', '[[ "$field_name" == [uU][rR][iI][sS] ]]');
      const copy = join(root, 'installer.bash');
      await writeFile(copy, relocated);
      const result = spawnSync('/bin/bash', [copy, ...args], {
        cwd: root, encoding: 'utf8', timeout: 5000,
        env: {
          PATH: join(root, 'bin'), HOME: join(root, 'home'),
          TMPDIR: join(root, 'tmp'),
          XDG_DATA_HOME: join(root, 'home/.local/share'),
          XDG_DATA_DIRS: `${join(root, 'usr/local/share')}:${join(root, 'usr/share')}`,
          IMCODES_HOME: join(root, 'home/.imcodes'), CODEX_HOME: join(root, 'home/.codex'),
          BASH_ENV: shims, FIXTURE_ROOT: root, SUDO_USER: 'ai',
          FIXTURE_FAIL: options.fail ?? '', FIXTURE_EUID: String(options.euid ?? 0),
          FIXTURE_READY_AT: String(options.readyAt ?? 1),
        },
      });
      if (result.error) throw result.error;
      return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
    },
    async calls() { return readFile(join(root, 'calls'), 'utf8').catch(() => ''); },
  };
}
