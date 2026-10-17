// Canonical Python transport, embedded in both SEA and the tsc/npm distribution.
// Keep it as source data, not a bundler-only ?raw import.
export const SYSTEMD_WATCHDOG_NOTIFY_SCRIPT = String.raw`# Python 2.7/3 standard-library transport for legacy systemd/SELinux.
# No SCM_CREDENTIALS spoofing, parent PID impersonation, timer, or autonomous
# renewal. Stay in the unit cgroup until stdin EOF so PID attribution cannot
# race a short-lived sender's exit. Only the node's liveness decision feeds it.
import os
import socket
import sys

address = os.environ['NOTIFY_SOCKET']
if address.startswith('@'):
    address = '\0' + address[1:]
transport = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
sys.stdout.write('READY\n')
sys.stdout.flush()
while True:
    # Python 2's file iterator reads ahead on pipes; readline delivers one pulse now.
    line = sys.stdin.readline()
    if not line:
        break
    if line != 'WATCHDOG\n':
        raise RuntimeError('invalid watchdog pulse')
    transport.sendto(b'WATCHDOG=1', address)
    sys.stdout.write('SENT\n')
    sys.stdout.flush()
`;
