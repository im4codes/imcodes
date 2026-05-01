export async function resetWebSharedCachesForTests(): Promise<void> {
  try {
    const { __resetPrefCacheForTests } = await import('../src/hooks/usePref.js');
    __resetPrefCacheForTests();
  } catch { /* tests may mock dependencies during module loading */ }
  try {
    const { __resetSharedResourcesForTests } = await import('../src/stores/shared-resource.js');
    __resetSharedResourcesForTests();
  } catch { /* optional */ }
  try {
    const quickDataModule = await import('../src/components/QuickInputPanel.js');
    if (typeof quickDataModule.__resetQuickDataForTests === 'function') {
      quickDataModule.__resetQuickDataForTests();
    }
  } catch { /* optional; some suites mock QuickInputPanel or api.ts narrowly */ }
}
