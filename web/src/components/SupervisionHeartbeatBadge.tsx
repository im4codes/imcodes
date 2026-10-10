import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { SUPERVISION_MODE, type SupervisionMode } from '@shared/supervision-config.js';
import {
  SUPERVISION_HEARTBEAT_GLYPH,
  SUPERVISION_HEARTBEAT_KIND,
  SUPERVISION_HEARTBEAT_STATE,
  type SupervisionHeartbeatKind,
  type SupervisionHeartbeatSnapshot,
} from '@shared/supervision-heartbeat.js';

export function formatSupervisionHeartbeatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function heartbeatKindKey(kind: SupervisionHeartbeatKind | undefined): string {
  if (kind === SUPERVISION_HEARTBEAT_KIND.AUDIT) return 'audit';
  if (kind === SUPERVISION_HEARTBEAT_KIND.IMPLEMENTATION) return 'implementation';
  if (kind === SUPERVISION_HEARTBEAT_KIND.PAIR) return 'pair';
  return 'waiting';
}

export function SupervisionHeartbeatBadge({
  mode,
  heartbeat,
  inline = false,
}: {
  mode: SupervisionMode;
  heartbeat?: SupervisionHeartbeatSnapshot | null;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  // A task-pair heartbeat belongs to the `pairs` engine, not to the session's
  // supervision mode, so it is shown whatever that mode is.
  if ((mode === SUPERVISION_MODE.OFF && heartbeat?.kind !== SUPERVISION_HEARTBEAT_KIND.PAIR)
    || !heartbeat
    || heartbeat.state === SUPERVISION_HEARTBEAT_STATE.OFF) return null;

  const state = heartbeat.state;
  if (state === SUPERVISION_HEARTBEAT_STATE.PAUSED_NEEDS_INPUT) {
    const label = t('session.supervision.heartbeat.needsInput');
    return <span class={`supervision-heartbeat-badge is-needs-input${inline ? ' is-inline' : ''}`} role="status" aria-label={label} title={label}>{SUPERVISION_HEARTBEAT_GLYPH.NEEDS_INPUT}</span>;
  }
  if (state === SUPERVISION_HEARTBEAT_STATE.IDLE) {
    const label = t('session.supervision.heartbeat.idle');
    return <span class={`supervision-heartbeat-badge is-idle${inline ? ' is-inline' : ''}`} role="status" aria-label={label} title={label}><span class="supervision-heartbeat-glyph is-idle" aria-hidden="true">{SUPERVISION_HEARTBEAT_GLYPH.IDLE}</span></span>;
  }
  if (state !== SUPERVISION_HEARTBEAT_STATE.ARMED
    || heartbeat.nextHeartbeatAt === undefined) return null;

  return (
    <ArmedSupervisionHeartbeatBadge
      heartbeat={heartbeat}
      nextHeartbeatAt={heartbeat.nextHeartbeatAt}
      inline={inline}
    />
  );
}

function ArmedSupervisionHeartbeatBadge({ heartbeat, nextHeartbeatAt, inline }: {
  heartbeat: SupervisionHeartbeatSnapshot;
  nextHeartbeatAt: number;
  inline: boolean;
}) {
  const { t } = useTranslation();
  const schedule = useMemo(() => {
    // Translate the daemon's duration into the browser clock domain. This
    // stays correct even when the two wall clocks are skewed.
    const receivedAt = Date.now();
    const durationAtProjection = Math.max(0, nextHeartbeatAt - heartbeat.updatedAt);
    return { clientDeadline: receivedAt + durationAtProjection };
  }, [heartbeat.kind, heartbeat.updatedAt, nextHeartbeatAt]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const sync = () => setNow(Date.now());
    let timer: ReturnType<typeof setInterval> | null = null;
    const arm = () => {
      if (timer) clearInterval(timer);
      timer = null;
      sync();
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        timer = setInterval(sync, 1_000);
      }
    };
    const onVisibility = () => arm();
    arm();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer) clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [schedule]);

  const remaining = Math.max(0, schedule.clientDeadline - now);
  const kind = t(`session.supervision.heartbeat.kind.${heartbeatKindKey(heartbeat.kind)}`);
  const exactTime = new Date(nextHeartbeatAt).toLocaleTimeString();
  const sending = remaining === 0;
  const countdown = formatSupervisionHeartbeatCountdown(remaining);
  const label = sending
    ? t('session.supervision.heartbeat.sendingLabel', { kind, time: exactTime })
    : t('session.supervision.heartbeat.armedLabel', { kind, countdown, time: exactTime });
  return (
    <span
      class={`supervision-heartbeat-badge is-armed${sending ? ' is-sending' : ''}${inline ? ' is-inline' : ''}`}
      role={sending ? 'status' : 'timer'}
      aria-label={label}
      title={label}
    >
      <span class="supervision-heartbeat-glyph" aria-hidden="true">{SUPERVISION_HEARTBEAT_GLYPH.ARMED}</span>
      <span>{sending ? t('session.supervision.heartbeat.sending') : countdown}</span>
    </span>
  );
}
