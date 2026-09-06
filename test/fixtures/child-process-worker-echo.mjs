process.once('disconnect', () => process.exit(0));
process.on('message', (message) => {
  process.send?.({
    pid: process.pid,
    message,
    typedArray: new Float32Array([1.25, 2.5]),
  });
});
