process.send?.({ type: 'fixture.ready', pid: process.pid });
setImmediate(() => process.kill(process.pid, 'SIGSEGV'));
