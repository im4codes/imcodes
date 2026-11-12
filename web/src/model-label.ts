import { bestModelLabel } from '../../src/shared/models/label.js';

export { shortModelLabel, bestModelLabel } from '../../src/shared/models/label.js';

/** Shared compact display helper: keep selection/version priority and raw model IDs separate. */
export function formatModelPresentation(...models: Array<string | null | undefined>): {
  label: string | null;
  title: string | undefined;
} {
  const label = bestModelLabel(...models);
  const fullModels = models.map((model) => model?.trim()).filter((model): model is string => Boolean(model));
  return {
    label: label?.split('-').slice(-2).join('-') ?? null,
    title: [...new Set(fullModels)].join(' · ') || undefined,
  };
}

export const subSessionModelPresentation = formatModelPresentation;
