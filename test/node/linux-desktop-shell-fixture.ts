import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Execute the real Bash control flow, relocating only filesystem/identity inputs.
 * No elevated privileges required. PATH contains NO host tools; every external
 * command is a shell function (including failed best-effort modprobe). Generated
 * units/session scripts are inspected, never launched. Unknown commands fail.
 */
export async function desktopShellFixture(dirs: string[], options: {
  apt?: boolean;
  firefox?: boolean;
  fail?: string;
  readyAt?: number;
  euid?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-desktop-shell-'));
  dirs.push(root);
  if (!/^[\w/.-]+$/.test(root)) throw new Error('fixture root must be shell-safe');
  for (const path of ['home', 'bin', 'etc/modules-load.d', 'etc/systemd/system',
    'etc/apt/keyrings', 'etc/apt/sources.list.d', 'etc/apt/preferences.d', 'usr/local/lib/imcodes']) {
    await mkdir(join(root, path), { recursive: true });
  }
  const shims = join(root, 'shims.bash');
  await writeFile(shims, `
record() { printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"; }
id() { record "id $*"; [[ "$*" != '-u missing' ]] || return 1; echo 1001; }
getent() { printf 'ai:x:1001:1001::%s:/bin/bash\\n' "$HOME"; }
cut() { local line; IFS= read -r line; printf '%s\\n' "$HOME"; }
${options.apt === false ? '' : 'apt-get() { record "apt-get $*"; [[ "$FIXTURE_FAIL" != "apt-get $1" ]] || return 100; };'}
${options.firefox ? 'firefox() { return 0; }' : ''}
systemctl() { record "systemctl $*"; [[ "$FIXTURE_FAIL" != "systemctl $*" ]] || return 7; }
grep() { return 1; }
modprobe() { record "modprobe $*"; return 1; }
install() { record "install $*"; }
chmod() { record "chmod $*"; }
curl() { record "curl $*"; return 9; }
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
        .replaceAll('"$EUID"', '"$FIXTURE_EUID"');
      const copy = join(root, 'installer.bash');
      await writeFile(copy, relocated);
      const result = spawnSync('/bin/bash', [copy, ...args], {
        cwd: root, encoding: 'utf8', timeout: 5000,
        env: {
          PATH: join(root, 'bin'), HOME: join(root, 'home'),
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
