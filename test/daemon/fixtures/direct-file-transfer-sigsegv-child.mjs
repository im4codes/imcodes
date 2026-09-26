process.send?.({ type: 'fixture.ready', pid: process.pid, phase: 0 });

// Do not crash until the parent has observed readiness. A fast SIGSEGV can
// otherwise overtake the IPC frame on a loaded runner, turning this containment
// test into a child-process message-delivery race.
process.once('message', () => {
  process.send?.({ type: 'fixture.ready', pid: process.pid, phase: 1 });
  process.once('message', () => process.kill(process.pid, 'SIGSEGV'));
});
