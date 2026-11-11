export const ONLYOFFICE_SERVICE_ENV = {
  ENABLED: 'ONLYOFFICE_ENABLED',
  JWT_SECRET: 'ONLYOFFICE_JWT_SECRET',
  PUBLIC_URL: 'ONLYOFFICE_PUBLIC_URL',
  INTERNAL_URL: 'ONLYOFFICE_INTERNAL_URL',
} as const;

export const ONLYOFFICE_SERVICE_DEFAULTS = {
  IMAGE: 'onlyoffice/documentserver:latest',
  INTERNAL_URL: 'http://onlyoffice:80',
  SUBPATH: '/onlyoffice',
  JWT_SECRET_BYTES: 32,
} as const;

export const ONLYOFFICE_VOLUME_NAMES = {
  DATA: 'onlyoffice_data',
  LOGS: 'onlyoffice_logs',
} as const;

export function defaultOnlyOfficePublicUrl(domain: string): string {
  const normalized = domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  return `https://${normalized}${ONLYOFFICE_SERVICE_DEFAULTS.SUBPATH}`;
}

export function isOnlyOfficeEnabledValue(value: string | boolean | undefined | null): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return normalized !== 'false' && normalized !== '0' && normalized !== 'no' && normalized !== 'off';
}
