export interface SharedContextCutoverFlags {
  identityShadow: boolean;
  localStaging: boolean;
  materialization: boolean;
  remoteReplication: boolean;
  controlPlane: boolean;
  runtimeSend: boolean;
  legacyInjectionDisabled: boolean;
  shadowDiagnostics: boolean;
}

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return defaultValue;
}

export function getSharedContextCutoverFlags(env: NodeJS.ProcessEnv = process.env): SharedContextCutoverFlags {
  return {
    identityShadow: parseBooleanFlag(env.IMCODES_SHARED_CONTEXT_IDENTITY_SHADOW, true),
    localStaging: parseBooleanFlag(env.IMCODES_SHARED_CONTEXT_LOCAL_STAGING, true),
    materialization: parseBooleanFlag(env.IMCODES_SHARED_CONTEXT_MATERIALIZATION, true),
    remoteReplication: parseBooleanFlag(env.IMCODES_SHARED_CONTEXT_REMOTE_REPLICATION, true),
    controlPlane: parseBooleanFlag(env.IMCODES_SHARED_CONTEXT_CONTROL_PLANE, true),
    runtimeSend: parseBooleanFlag(env.IMCODES_SHARED_CONTEXT_RUNTIME_SEND, true),
    legacyInjectionDisabled: parseBooleanFlag(env.IMCODES_SHARED_CONTEXT_LEGACY_INJECTION_DISABLED, false),
    shadowDiagnostics: parseBooleanFlag(env.IMCODES_SHARED_CONTEXT_SHADOW_DIAGNOSTICS, false),
  };
}

export function legacyInjectionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getSharedContextCutoverFlags(env).legacyInjectionDisabled;
}
