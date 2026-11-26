export function formatTransferBytes(bytes: number): string {
  const safeBytes = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  const units: Array<{ size: number; unit: Intl.NumberFormatOptions['unit'] }> = [
    { size: 1024 ** 4, unit: 'terabyte' },
    { size: 1024 ** 3, unit: 'gigabyte' },
    { size: 1024 ** 2, unit: 'megabyte' },
    { size: 1024, unit: 'kilobyte' },
    { size: 1, unit: 'byte' },
  ];
  const selected = units.find((entry) => safeBytes >= entry.size) ?? units[units.length - 1];
  return new Intl.NumberFormat(undefined, {
    style: 'unit',
    unit: selected.unit,
    unitDisplay: 'short',
    maximumFractionDigits: selected.size === 1 ? 0 : 1,
  }).format(safeBytes / selected.size);
}

export function formatTransferDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}
