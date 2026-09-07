try {
  const { register } = await import('tsx/esm/api');
  register();
} catch {
  // Production build tests import compiled JavaScript.
}

process.env.NODE_ENV = 'test';
const rtc = await import('node-datachannel');
const direct = await import('../../../src/daemon/direct-file-transfer-worker.js');
const { DIRECT_FILE_TRANSFER_WORKER_KIND } = await import('../../../shared/direct-file-transfer.js');

let dispatch = () => {};
await direct.startDirectFileTransferChildRuntime({
  kind: DIRECT_FILE_TRANSFER_WORKER_KIND,
  generation: Number.parseInt(process.env.IMCODES_DIRECT_FILE_TRANSFER_GENERATION ?? '1', 10),
  send(envelope) { if (process.connected) process.send(envelope); },
  subscribe(handler) { dispatch = handler; },
  requestHardRecycle() {
    const budget = direct.__nativeRetirementBudgetForTests();
    if (!process.connected) {
      process.kill(process.pid, 'SIGKILL');
      return;
    }
    process.send({
        type: 'fixture.native-retirement-budget',
        pid: process.pid,
        generation: Number.parseInt(process.env.IMCODES_DIRECT_FILE_TRANSFER_GENERATION ?? '1', 10),
        ...budget,
      }, () => process.kill(process.pid, 'SIGKILL'));
  },
});
void dispatch;

const left = new rtc.PeerConnection('native-retire-left', { iceServers: [] });
const right = new rtc.PeerConnection('native-retire-right', { iceServers: [] });
const retained = [left, right];

left.onLocalDescription((sdp, type) => right.setRemoteDescription(sdp, type));
right.onLocalDescription((sdp, type) => left.setRemoteDescription(sdp, type));
left.onLocalCandidate((candidate, mid) => right.addRemoteCandidate(candidate, mid));
right.onLocalCandidate((candidate, mid) => left.addRemoteCandidate(candidate, mid));

const received = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('native_peer_message_timeout')), 10_000);
  right.onDataChannel((channel) => {
    retained.push(channel);
    channel.onMessage((message) => {
      if (message !== 'retire-stress') return;
      clearTimeout(timer);
      resolve();
    });
  });
});
const channel = left.createDataChannel('native-retire-channel');
retained.push(channel);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('native_peer_open_timeout')), 10_000);
  channel.onOpen(() => {
    clearTimeout(timer);
    channel.sendMessage('retire-stress');
    resolve();
  });
});
await received;

// Keep this negotiated transfer live while repeatedly replacing a different
// real peer. The generation must hit its hard retirement budget and recycle
// even though global activeAttempts never reaches zero.
direct.__replaceNativePeersUnderConcurrentActiveTransferForTests(left, channel);
setTimeout(() => process.exit(91), 5_000).unref();
