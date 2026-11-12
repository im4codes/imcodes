export const initReactI18next = { type: '3rdParty', init: () => {} };
export function useTranslation() {
  return {
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'en', changeLanguage: async () => {} },
  };
}
export function Trans({ children }: { children?: unknown }) {
  return children ?? null;
}
