const pending = [];
let dispatch = null;
let stopRequested = false;
let bootstrapStopTimer = null;
let requestStop = () => {
  stopRequested = true;
  // The parent may disappear while a dynamic import is still pending. The
  // runtime cannot drain before it exists, so bound this bootstrap-only gap and
  // guarantee the OS child cannot become an orphan.
  if (!bootstrapStopTimer) {
    bootstrapStopTimer = setTimeout(() => process.exit(0), 1_000);
    bootstrapStopTimer.unref?.();
  }
};
process.on('message', (message) => {
  if (dispatch) dispatch(message);
  else pending.push(message);
});
// Installed before any dynamic import so a parent that dies during bootstrap
// cannot strand this process before the runtime's cleanup hook exists.
process.once('disconnect', () => { void requestStop(); });
process.once('SIGTERM', () => { void requestStop(); });

try {
  const { register } = await import('tsx/esm/api');
  register();
} catch {
  // Production build: child files are already compiled JavaScript.
}

const runtime = await import('./direct-file-transfer-worker.js');
if (stopRequested) process.exit(0);
const generation = Number.parseInt(process.env.IMCODES_DIRECT_FILE_TRANSFER_GENERATION ?? '', 10);
await runtime.startDirectFileTransferChildRuntime({
  kind: process.env.IMCODES_DIRECT_FILE_TRANSFER_CHILD,
  generation,
  send(message) {
    if (process.connected) process.send(message);
  },
  subscribe(handler) {
    dispatch = handler;
    for (const message of pending.splice(0)) handler(message);
  },
  requestHardRecycle() {
    // Never enter node-datachannel teardown for an idle retired generation.
    // A hard process boundary is the callback-drain acknowledgement: the OS
    // destroys the native address space and the parent starts a fresh child.
    process.kill(process.pid, 'SIGKILL');
  },
});
if (bootstrapStopTimer && !stopRequested) clearTimeout(bootstrapStopTimer);

let stopping = null;
requestStop = function stopChild() {
  if (stopping) return stopping;
  stopping = runtime.shutdownDirectFileTransfers()
    .catch(() => undefined)
    .finally(() => process.exit(0));
  return stopping;
};
if (stopRequested) void requestStop();
