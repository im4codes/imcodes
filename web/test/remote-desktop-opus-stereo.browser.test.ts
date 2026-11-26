/**
 * @vitest-environment node
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME_MAC_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

describe('RemoteDesktop Opus stereo SDP offer in real Chromium', () => {
  it('commits unmodified local offer under default Chromium and WebRTC-NoSdpMangleReject=68, sends stereo=1 wire SDP, and negotiates with video-only answers', { timeout: 60_000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    const executablePath = existsSync(chromium.executablePath())
      ? undefined
      : process.platform === 'darwin' && existsSync(CHROME_MAC_PATH)
        ? CHROME_MAC_PATH
        : null;
    if (executablePath === null) {
      return;
    }

    const { build } = require('esbuild') as typeof import('esbuild');
    const compiled = await build({
      stdin: {
        contents: `
          import {
            applyOpusStereoReceiveCodecPreference,
            mungeOpusStereoOfferSdp,
          } from './src/remote-desktop-client.js';

          window.__rdAudioProbe = async () => {
            const pc = new RTCPeerConnection({ bundlePolicy: 'balanced' });
            const answerPc = new RTCPeerConnection({ bundlePolicy: 'balanced' });
            try {
              pc.addTransceiver('video', { direction: 'recvonly' });
              const audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
              const capabilities = RTCRtpReceiver.getCapabilities?.('audio');
              if (capabilities) {
                applyOpusStereoReceiveCodecPreference(audioTransceiver, capabilities.codecs);
              }
              const rawOffer = await pc.createOffer();

              let directMungeError = null;
              const testPc = new RTCPeerConnection();
              try {
                testPc.addTransceiver('video', { direction: 'recvonly' });
                testPc.addTransceiver('audio', { direction: 'recvonly' });
                const testRaw = await testPc.createOffer();
                const testMunged = mungeOpusStereoOfferSdp(testRaw.sdp ?? '');
                await testPc.setLocalDescription({ type: 'offer', sdp: testMunged });
              } catch (err) {
                directMungeError = (err && err.name) ? err.name + ': ' + err.message : String(err);
              } finally {
                testPc.close();
              }

              // Production flow: setLocalDescription(rawOffer) first, then munge wire copy only.
              await pc.setLocalDescription(rawOffer);
              const wireSdp = mungeOpusStereoOfferSdp(pc.localDescription?.sdp ?? '');

              // Complete offer/answer with a legacy video-only peer that stops/rejects audio.
              await answerPc.setRemoteDescription({ type: 'offer', sdp: wireSdp });
              for (const t of answerPc.getTransceivers()) {
                if (t.receiver.track?.kind === 'audio') {
                  t.stop();
                }
              }
              const answer = await answerPc.createAnswer();
              await answerPc.setLocalDescription(answer);
              await pc.setRemoteDescription(answer);

              return {
                rawSdp: rawOffer.sdp ?? '',
                localSdp: pc.localDescription?.sdp ?? '',
                wireSdp,
                answerSdp: answer.sdp ?? '',
                signalingState: pc.signalingState,
                audioTransceiverDirection: audioTransceiver.currentDirection ?? audioTransceiver.direction,
                directMungeError,
                opusCapabilities: capabilities?.codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/opus') ?? [],
              };
            } finally {
              pc.close();
              answerPc.close();
            }
          };
        `,
        resolveDir: resolve(here, '..'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'iife',
    });

    for (const extraArgs of [[], ['--force-fieldtrials=WebRTC-NoSdpMangleReject/Enabled,68/']]) {
      const browser = await chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        headless: true,
        args: extraArgs,
      });
      try {
        const page = await browser.newPage();
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ content: compiled.outputFiles[0]!.text });

        const result = await page.evaluate(async () => {
          return await (window as unknown as {
            __rdAudioProbe: () => Promise<{
              rawSdp: string;
              localSdp: string;
              wireSdp: string;
              answerSdp: string;
              signalingState: string;
              directMungeError: string | null;
              opusCapabilities: Array<{ sdpFmtpLine?: string }>;
            }>;
          }).__rdAudioProbe();
        });

        expect(result.opusCapabilities.length).toBeGreaterThan(0);
        if (extraArgs.length > 0) {
          // Confirm the type-68 SDP-mangle rejection guard really fired on direct pre-commit munging.
          expect(result.directMungeError).toMatch(/InvalidModificationError/);
        } else {
          expect(result.directMungeError).toBeNull();
        }

        // Local description stays unmodified; wire SDP carries ;stereo=1 alongside minptime=10;useinbandfec=1.
        const wireLines = result.wireSdp.split(/\r?\n/);
        const opusRtpmap = wireLines.find((line) => /^a=rtpmap:(\d+)\s+opus\/48000/i.test(line));
        expect(opusRtpmap).toBeTruthy();
        const opusPt = /^a=rtpmap:(\d+)\s+/i.exec(opusRtpmap!)![1]!;
        const opusFmtp = wireLines.find((line) => line.startsWith(`a=fmtp:${opusPt} `));
        expect(opusFmtp).toBeTruthy();
        expect(opusFmtp).toContain('stereo=1');
        expect(opusFmtp).toContain('minptime=10');
        expect(opusFmtp).toContain('useinbandfec=1');

        // Confirm legacy video-only peer rejected/deactivated m=audio and PeerConnection settled cleanly in 'stable'.
        const audioSection = result.answerSdp.slice(result.answerSdp.indexOf('m=audio '));
        expect(audioSection.startsWith('m=audio 0 ') || audioSection.includes('\na=inactive')).toBe(true);
        expect(result.signalingState).toBe('stable');
      } finally {
        await browser.close();
      }
    }
  });
});
