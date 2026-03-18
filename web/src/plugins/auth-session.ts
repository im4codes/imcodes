/**
 * Capacitor plugin for ASWebAuthenticationSession (iOS).
 * Shows a compact auth sheet that auto-closes on redirect — much better UX
 * than SFSafariViewController (@capacitor/browser) for authentication flows.
 */
import { registerPlugin } from '@capacitor/core';

interface AuthSessionPlugin {
  start(options: { url: string; callbackScheme: string }): Promise<{ url: string }>;
}

const AuthSession = registerPlugin<AuthSessionPlugin>('AuthSession');
export default AuthSession;
