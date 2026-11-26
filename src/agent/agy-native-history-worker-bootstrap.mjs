// Same dev/compiled bootstrap contract as exec-helper-worker-bootstrap.mjs.
try {
  const { register } = await import('tsx/esm/api');
  register();
} catch { /* production uses compiled JS */ }
const { runAgyHistoryWorker } = await import('./agy-native-history.js');
runAgyHistoryWorker();
