/**
 * The scripted machine around the generated POSIX upgrade script: stub `date`/`sleep` (a virtual clock), a fake
 * service manager that derives the node's pid and lease from how long it has been "running", and the node markers.
 * Plain `sh` text so the same files run under dash, busybox ash and the BSD-style shim farm used for the
 * portability checks (evidence-posix/bsd), not only under the shell vitest happens to spawn.
 */
export type NodeKind = 'healthy' | 'dead' | 'nolease' | 'badlease' | 'crashloop';
export const marker = (kind: NodeKind, leaseAt = 5): string => `NODE kind=${kind} lease_at=${leaseAt}\n`;

export const FAKE_STUBS = {
  date: '#!/bin/sh\ncat "$FAKE/clock"\n',
  sleep: [
    '#!/bin/sh',
    // The virtual clock advances by the requested time x FAKE_SLEEP_SCALE: a scenario that spans minutes of
    // script time costs a handful of poll iterations, never real elapsed time or runner speed.
    'now=$(cat "$FAKE/clock"); now=$((now + $1 * ${FAKE_SLEEP_SCALE:-1})); echo "$now" > "$FAKE/clock"',
    // Runaway guard: a script that never reaches a verdict is killed once two virtual hours have passed.
    'if [ $((now - 1800000000)) -gt 7200 ]; then echo runaway > "$FAKE/runaway"; kill -KILL "$PPID"; fi',
    // Scripted signal: deliver $SIG to the script (our parent) once the virtual clock passes $AT.
    'if [ -f "$FAKE/signal_at" ]; then at=$(cat "$FAKE/signal_at"); sig=$(cat "$FAKE/signal_name"); if [ "$now" -ge "$at" ]; then rm -f "$FAKE/signal_at"; kill -"$sig" "$PPID"; fi; fi',
    'exit 0',
    '',
  ].join('\n'),
};

/** The fake service manager: derives the node's pid/lease from how long it has been "running". */
export const FAKE_SERVICE_MANAGER = [
  'node_state() {',
  '  [ -f "$FAKE/started_at" ] || { PID=0; RESTARTS=0; return; }',
  '  started=$(cat "$FAKE/started_at"); now=$(cat "$FAKE/clock"); el=$((now - started))',
  '  kind=$(sed -n "s/.*kind=\\([a-z]*\\).*/\\1/p" "$DST" | head -n 1); lease_at=$(sed -n "s/.*lease_at=\\([0-9]*\\).*/\\1/p" "$DST" | head -n 1)',
  '  PID=$FAKE_PID_A; RESTARTS=0',
  '  case "$kind" in',
  '    dead) PID=0;;',
  '    crashloop) RESTARTS=$((el / 5)); if [ $((RESTARTS % 2)) = 1 ]; then PID=$FAKE_PID_B; fi;;',
  '    healthy) if [ "$el" -ge "$lease_at" ]; then printf \'{"version":1,"pid":%s,"updatedAt":%s}\\n\' "$PID" $(( (started + lease_at) * 1000 )) > "$LEASE"; fi;;',
  // a lease from a LIVE process that is not the service's pid (another process, a stale writer): only the pid-identity check rejects it
  '    badlease) if [ "$el" -ge "$lease_at" ]; then printf \'{"version":1,"pid":%s,"updatedAt":%s}\\n\' "$FAKE_PID_B" $(( (started + lease_at) * 1000 )) > "$LEASE"; fi;;',
  '  esac',
  '}',
  'do_start() { echo "$(cat "$FAKE/clock")" > "$FAKE/started_at"; echo start >> "$FAKE/calls"; [ -f "$FAKE/on_start" ] && sh "$FAKE/on_start"; return 0; }',
  'do_stop() { rm -f "$FAKE/started_at"; echo stop >> "$FAKE/calls"; }',
  '',
].join('\n');

export const SYSTEMCTL = `#!/bin/sh
${FAKE_SERVICE_MANAGER}
case "$1" in
  stop) do_stop;;
  start) do_start;;
  reset-failed) echo reset-failed >> "$FAKE/calls";;
  daemon-reload) echo daemon-reload >> "$FAKE/calls";;
  show)
    node_state
    case "$3" in MainPID) echo "MainPID=$PID";; NRestarts) echo "NRestarts=$RESTARTS";; esac;;
esac
exit 0
`;

export const LAUNCHCTL = `#!/bin/sh
${FAKE_SERVICE_MANAGER}
case "$1" in
  bootout) echo "bootout $2" >> "$FAKE/calls"; case "$2" in *watchdog) ;; *) rm -f "$FAKE/started_at";; esac;;
  bootstrap) echo "bootstrap $3" >> "$FAKE/calls";;
  kickstart) echo "kickstart $3" >> "$FAKE/calls"; do_start;;
  print) node_state; if [ "$PID" != "0" ]; then printf 'system/cc.imcodes.node = {\\n\\tpid = %s\\n}\\n' "$PID"; fi;;
esac
exit 0
`;
