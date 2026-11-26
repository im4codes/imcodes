import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_ENCODER_CLASS,
  REMOTE_DESKTOP_ENCODER_CODEC,
  REMOTE_DESKTOP_ENCODER_RAW_CODECS,
} from '@shared/remote-desktop.js';
import {
  describeRemoteDesktopEncoder,
  type RemoteDesktopEncoderSummary,
} from '../src/remote-desktop-encoder-label.js';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'] as const;

function locale(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(__dirname, '..', 'src', 'i18n', 'locales', `${name}.json`), 'utf8')) as Record<string, unknown>;
}

function lookup(tree: Record<string, unknown>, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** i18next-style translate over one locale's real strings. */
function translator(name: string) {
  const tree = locale(name);
  return (key: string, params: Record<string, string | number> = {}): string => {
    const template = lookup(tree, key);
    if (template === undefined) throw new Error(`missing ${name} key ${key}`);
    return template.replace(/\{\{(\w+)\}\}/g, (_m, p: string) => String(params[p] ?? `<${p}?>`));
  };
}

const software: RemoteDesktopEncoderSummary = {
  codec: REMOTE_DESKTOP_ENCODER_CODEC.VP9,
  implementation: REMOTE_DESKTOP_ENCODER_CLASS.SOFTWARE,
  name: 'libvpx',
  threads: 12,
  rawCodecs: REMOTE_DESKTOP_ENCODER_RAW_CODECS.ALLOWED,
};

describe('remote desktop HUD: the real encoder', () => {
  const t = translator('en');

  it('says VP9 (software, libvpx) for the raw path', () => {
    expect(describeRemoteDesktopEncoder(software, t)).toEqual({ text: 'Encoder: VP9 (software, libvpx)', codec: 'vp9' });
    expect(describeRemoteDesktopEncoder({ ...software, codec: REMOTE_DESKTOP_ENCODER_CODEC.VP8 }, t)?.text)
      .toBe('Encoder: VP8 (software, libvpx)');
  });

  it('says H.264 (hardware) and H.264 (software) without repeating the encoder name', () => {
    const h264 = { ...software, codec: REMOTE_DESKTOP_ENCODER_CODEC.H264, name: 'Apple H.264 (SW)', rawCodecs: REMOTE_DESKTOP_ENCODER_RAW_CODECS.HARDWARE_H264 };
    expect(describeRemoteDesktopEncoder({ ...h264, implementation: REMOTE_DESKTOP_ENCODER_CLASS.HARDWARE, name: 'VideoToolbox (hardware)' }, t))
      .toEqual({ text: 'Encoder: H.264 (hardware)', codec: 'h264' });
    expect(describeRemoteDesktopEncoder(h264, t)).toEqual({ text: 'Encoder: H.264 (software)', codec: 'h264' });
  });

  it('says so when the kill switch or the capture is why it is H.264', () => {
    const h264 = { ...software, codec: REMOTE_DESKTOP_ENCODER_CODEC.H264, name: 'Apple H.264 (SW)' };
    expect(describeRemoteDesktopEncoder({ ...h264, rawCodecs: REMOTE_DESKTOP_ENCODER_RAW_CODECS.DISABLED_BY_SETTING }, t))
      .toEqual({ text: 'Encoder: H.264 (software)', note: 'H.264 forced by the node setting', codec: 'h264' });
    expect(describeRemoteDesktopEncoder({ ...h264, rawCodecs: REMOTE_DESKTOP_ENCODER_RAW_CODECS.CAPTURE_CANNOT_SCALE }, t)?.note)
      .toBe('H.264: this capture cannot scale');
    // A VP9 route never carries the note, whatever the field says.
    expect(describeRemoteDesktopEncoder({ ...software, rawCodecs: REMOTE_DESKTOP_ENCODER_RAW_CODECS.DISABLED_BY_SETTING }, t)?.note).toBeUndefined();
    // Hardware Mac: no note, nothing was "forced".
    expect(describeRemoteDesktopEncoder({ ...h264, rawCodecs: REMOTE_DESKTOP_ENCODER_RAW_CODECS.HARDWARE_H264 }, t)?.note).toBeUndefined();
  });

  it('has nothing to say before a codec exists or from a node that does not send it', () => {
    expect(describeRemoteDesktopEncoder(undefined, t)).toBeUndefined();
    expect(describeRemoteDesktopEncoder({ ...software, codec: REMOTE_DESKTOP_ENCODER_CODEC.PENDING }, t)).toBeUndefined();
  });

  it.each(LOCALES)('renders every codec, implementation and note in %s with all placeholders filled', (name) => {
    const tr = translator(name);
    const seen = new Set<string>();
    for (const codec of [REMOTE_DESKTOP_ENCODER_CODEC.VP9, REMOTE_DESKTOP_ENCODER_CODEC.VP8, REMOTE_DESKTOP_ENCODER_CODEC.H264]) {
      for (const implementation of Object.values(REMOTE_DESKTOP_ENCODER_CLASS)) {
        for (const rawCodecs of Object.values(REMOTE_DESKTOP_ENCODER_RAW_CODECS)) {
          const label = describeRemoteDesktopEncoder({ ...software, codec, implementation, rawCodecs }, tr);
          expect(label, `${name} ${codec} ${implementation}`).toBeDefined();
          for (const text of [label!.text, label!.note ?? '']) {
            expect(text).not.toMatch(/\{\{|<\w+\?>/);
            seen.add(text);
          }
        }
      }
    }
    expect(seen.size).toBeGreaterThan(6);
    // The words are actually translated: not left as the English source.
    if (name !== 'en') {
      expect(lookup(locale(name), 'remote_desktop.encoder_actual')).not.toBe(lookup(locale('en'), 'remote_desktop.encoder_actual'));
      expect(lookup(locale(name), 'remote_desktop.encoder_note_setting')).not.toBe(lookup(locale('en'), 'remote_desktop.encoder_note_setting'));
    }
  });

  it('keeps the placeholders of every translation identical to English', () => {
    const placeholders = (text: string | undefined) => [...(text ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const key of ['encoder_actual', 'encoder_detail', 'encoder_detail_plain', 'encoder_note_setting', 'encoder_note_capture']) {
      const expected = placeholders(lookup(locale('en'), `remote_desktop.${key}`));
      for (const name of LOCALES) {
        expect(placeholders(lookup(locale(name), `remote_desktop.${key}`)), `${name} ${key}`).toEqual(expected);
      }
    }
  });
});
