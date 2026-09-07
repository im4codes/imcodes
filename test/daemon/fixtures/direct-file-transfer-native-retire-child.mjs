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
  send() {},
  subscribe(handler) { dispatch = handler; },
  requestHardRecycle() { process.kill(process.pid, 'SIGKILL'); },
});
void dispatch;

const left = new rtc.PeerConnection('native-retire-left', { iceServers: [] });
const right = new rtc.PeerConnection('native-retire-right', { iceServers: [] });
const retained = [left, right];

let leftHasRemoteDescription = false;
let rightHasRemoteDescription = false;
const pendingForLeft = [];
const pendingForRight = [];

left.onLocalDescription((sdp, type) => {
  right.setRemoteDescription(sdp, type);
  rightHasRemoteDescription = true;
  for (const [candidate, mid] of pendingForRight.splice(0)) {
    right.addRemoteCandidate(candidate, mid);
  }
});
right.onLocalDescription((sdp, type) => {
  left.setRemoteDescription(sdp, type);
  leftHasRemoteDescription = true;
  for (const [candidate, mid] of pendingForLeft.splice(0)) {
    left.addRemoteCandidate(candidate, mid);
  }
});
left.onLocalCandidate((candidate, mid) => {
  if (rightHasRemoteDescription) right.addRemoteCandidate(candidate, mid);
  else pendingForRight.push([candidate, mid]);
});
right.onLocalCandidate((candidate, mid) => {
  if (leftHasRemoteDescription) left.addRemoteCandidate(candidate, mid);
  else pendingForLeft.push([candidate, mid]);
});

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
if (process.connected) process.send({ type: 'fixture.native-peer-negotiated', pid: process.pid });

// Real callbacks may still be queued here. Complete the operation while its
// renewed lease remains live: production must still retire the channel without
// native close and hard-recycle this OS child, rather than retaining wrappers
// forever behind a warm lease.
await direct.__retireNativeChannelUnderLiveLeaseForTests(left, channel);
setTimeout(() => process.exit(91), 5_000).unref();
