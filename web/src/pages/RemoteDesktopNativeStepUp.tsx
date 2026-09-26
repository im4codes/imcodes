import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { apiFetch, fetchMe } from '../api.js';
import {
  credentialToJson,
  normalizeCredentialOptions,
} from '../api/remote-desktop-access.js';

export const REMOTE_DESKTOP_NATIVE_STEP_UP_PATH = '/remote-desktop/native-step-up';

const CHALLENGE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export interface RemoteDesktopNativeStepUpClient {
  requireBrowserAccountSession(): Promise<void>;
  loadOptions(challengeId: string): Promise<unknown>;
  complete(challengeId: string, response: unknown): Promise<void>;
}

export const remoteDesktopNativeStepUpClient: RemoteDesktopNativeStepUpClient = {
  async requireBrowserAccountSession() {
    await fetchMe();
  },
  loadOptions(challengeId) {
    return apiFetch(`/api/auth/remote-desktop/step-up/${encodeURIComponent(challengeId)}/options`);
  },
  async complete(challengeId, response) {
    // The native completion route retains the grant for the initiating shell.
    // This page intentionally discards the response body and exposes no grant
    // through component state, DOM, URL, history, storage, or a native callback.
    await apiFetch('/api/auth/remote-desktop/step-up/complete-native', {
      method: 'POST',
      body: JSON.stringify({ challengeId, response }),
    });
  },
};

export function readRemoteDesktopNativeStepUpChallenge(
  location: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location,
): string | null {
  if (location.pathname !== REMOTE_DESKTOP_NATIVE_STEP_UP_PATH || location.hash !== '') return null;
  const params = new URLSearchParams(location.search);
  const challengeIds = params.getAll('challengeId');
  if (challengeIds.length !== 1 || Array.from(params.keys()).some((key) => key !== 'challengeId')) return null;
  const challengeId = challengeIds[0] ?? '';
  return CHALLENGE_ID_RE.test(challengeId) ? challengeId : null;
}

export interface RemoteDesktopNativeStepUpProps {
  client?: RemoteDesktopNativeStepUpClient;
  challengeId?: string | null;
}

type CompletionState = 'pending' | 'verified' | 'failed';

export function RemoteDesktopNativeStepUp({
  client = remoteDesktopNativeStepUpClient,
  challengeId = readRemoteDesktopNativeStepUpChallenge(),
}: RemoteDesktopNativeStepUpProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<CompletionState>('pending');

  useEffect(() => {
    let active = true;
    const complete = async () => {
      if (!challengeId) throw new Error('invalid_native_step_up_request');
      await client.requireBrowserAccountSession();
      const rawOptions = await client.loadOptions(challengeId);
      const options = normalizeCredentialOptions(rawOptions);
      if (options.challengeId !== challengeId) throw new Error('invalid_native_step_up_request');
      delete options.challengeId;
      options.userVerification = 'required';
      if (typeof navigator.credentials?.get !== 'function') throw new Error('passkey_unavailable');
      const credential = await navigator.credentials.get({ publicKey: options });
      if (!credential) throw new Error('verification_failed');
      await client.complete(challengeId, credentialToJson(credential));
      if (active) setState('verified');
    };
    void complete().catch(() => {
      if (active) setState('failed');
    });
    return () => { active = false; };
  }, [challengeId, client]);

  return (
    <main class="login-page remote-desktop-native-step-up">
      <section class="login-card" aria-live="polite" aria-busy={state === 'pending'}>
        <h1>{t('remote_desktop.native_step_up_title')}</h1>
        {state === 'pending' && (
          <p role="status">{t('remote_desktop.native_step_up_pending')}</p>
        )}
        {state === 'verified' && (
          <p role="status">{t('remote_desktop.native_step_up_verified')}</p>
        )}
        {state === 'failed' && (
          <p role="alert">{t('remote_desktop.native_step_up_failed')}</p>
        )}
      </section>
    </main>
  );
}
