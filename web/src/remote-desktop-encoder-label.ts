import {
  REMOTE_DESKTOP_ENCODER_CODEC,
  REMOTE_DESKTOP_ENCODER_RAW_CODECS,
  type RemoteDesktopEncoderInfo,
} from '@shared/remote-desktop.js';

/** The encoder message as the snapshot carries it (envelope fields removed). */
export type RemoteDesktopEncoderSummary = Omit<
  RemoteDesktopEncoderInfo,
  'type' | 'protocolVersion' | 'sessionId' | 'sequence'
>;

type Translate = (key: string, params?: Record<string, string | number>) => string;

const CODEC_KEY: Record<string, string> = {
  [REMOTE_DESKTOP_ENCODER_CODEC.VP9]: 'remote_desktop.encoder_codec.vp9',
  [REMOTE_DESKTOP_ENCODER_CODEC.VP8]: 'remote_desktop.encoder_codec.vp8',
  [REMOTE_DESKTOP_ENCODER_CODEC.H264]: 'remote_desktop.encoder_codec.h264',
};

export interface RemoteDesktopEncoderLabel {
  /** "Encoder: VP9 (software, libvpx)" / "Encoder: H.264 (hardware)" ... */
  text: string;
  /** Why H.264 is in use when the node's setting or its capture decided it. */
  note?: string;
  codec: string;
}

/** What the status bar says about the REAL encoder, from the worker's encoder
 *  message; undefined when there is nothing to say yet (a node that does not send
 *  the message, or a codec not negotiated yet), so the caller keeps its fallback. */
export function describeRemoteDesktopEncoder(
  encoder: RemoteDesktopEncoderSummary | undefined,
  t: Translate,
): RemoteDesktopEncoderLabel | undefined {
  if (!encoder || encoder.codec === REMOTE_DESKTOP_ENCODER_CODEC.PENDING) return undefined;
  const codecKey = CODEC_KEY[encoder.codec];
  if (!codecKey) return undefined;
  const codec = t(codecKey);
  const implementation = t(`remote_desktop.encoder_impl.${encoder.implementation}`);
  // The encoder's own name adds something only for the codecs libwebrtc encodes
  // itself ("libvpx"); for H.264 the implementation word says it all.
  const withName = encoder.codec !== REMOTE_DESKTOP_ENCODER_CODEC.H264 && encoder.name.length > 0;
  const detail = withName
    ? t('remote_desktop.encoder_detail', { codec, implementation, name: encoder.name })
    : t('remote_desktop.encoder_detail_plain', { codec, implementation });
  let note: string | undefined;
  if (encoder.codec === REMOTE_DESKTOP_ENCODER_CODEC.H264) {
    if (encoder.rawCodecs === REMOTE_DESKTOP_ENCODER_RAW_CODECS.DISABLED_BY_SETTING) {
      note = t('remote_desktop.encoder_note_setting');
    } else if (encoder.rawCodecs === REMOTE_DESKTOP_ENCODER_RAW_CODECS.CAPTURE_CANNOT_SCALE) {
      note = t('remote_desktop.encoder_note_capture');
    }
  }
  return {
    text: t('remote_desktop.encoder_actual', { detail }),
    ...(note === undefined ? {} : { note }),
    codec: encoder.codec,
  };
}
