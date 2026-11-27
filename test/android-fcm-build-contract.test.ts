import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), 'utf8');

describe('Android FCM package split contract', () => {
  it('declares only withFcm and withoutFcm flavors with shared application id and excludes push SDKs from withoutFcm', () => {
    const gradle = read('web/android/app/build.gradle');
    expect(gradle).toContain('withFcm {');
    expect(gradle).toContain('withoutFcm {');
    expect(gradle).toContain('applicationId appPackageName');
    expect(gradle).toContain('withFcmImplementation project(\':capacitor-push-notifications\')');
    expect(gradle).toContain("exclude group: 'com.google.android.gms'");
    expect(gradle).toContain("exclude group: 'com.google.firebase'");
    expect(gradle).toContain("exclude group: 'cn.jiguang.sdk'");
    expect(gradle).toContain("task.name.toLowerCase().contains('withoutfcm')");
    expect(gradle).not.toMatch(/\b(china|global)Implementation\b|cn\.jiguang\.sdk:(?:jpush|plugin)|JPush/);
  });

  it('defines dedicated with-fcm and without-fcm build scripts in web/package.json', () => {
    const pkg = JSON.parse(read('web/package.json')) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
    expect(pkg.scripts?.['build:with-fcm']).toContain('VITE_PUSH_VARIANT=with-fcm');
    expect(pkg.scripts?.['build:without-fcm']).toContain('VITE_PUSH_VARIANT=without-fcm');
    expect(pkg.dependencies?.['@capacitor/push-notifications']).toBeTruthy();
  });

  it('keeps push plugin metadata only in withFcm assets', () => {
    const withFcm = JSON.parse(read('web/android/app/src/withFcm/assets/capacitor.plugins.json')) as Array<{ pkg?: string; classpath?: string }>;
    const withoutFcm = JSON.parse(read('web/android/app/src/withoutFcm/assets/capacitor.plugins.json')) as Array<{ pkg?: string; classpath?: string }>;
    expect(withFcm.some((plugin) => plugin.pkg === '@capacitor/push-notifications')).toBe(true);
    expect(withoutFcm.some((plugin) => plugin.pkg === '@capacitor/push-notifications' || plugin.classpath?.includes('PushNotificationsPlugin'))).toBe(false);
  });

  it('publishes four independently named Android artifacts', () => {
    const workflow = read('.github/workflows/ci.yml');
    for (const artifact of [
      'imcodes-android-with-fcm-apk',
      'imcodes-android-without-fcm-apk',
      'imcodes-android-with-fcm-aab',
      'imcodes-android-without-fcm-aab',
    ]) {
      expect(workflow).toContain(artifact);
    }
    expect(workflow).toContain('assembleWithFcmRelease bundleWithFcmRelease');
    expect(workflow).toContain('assembleWithoutFcmRelease bundleWithoutFcmRelease');
    expect(workflow).toContain('imcodes-with-fcm-${{ steps.version.outputs.tag }}.apk');
    expect(workflow).toContain('imcodes-without-fcm-${{ steps.version.outputs.tag }}.apk');
    expect(workflow).toContain('imcodes-with-fcm-${{ steps.version.outputs.tag }}.aab');
    expect(workflow).toContain('imcodes-without-fcm-${{ steps.version.outputs.tag }}.aab');
    expect(workflow).not.toContain('JPUSH_APP_KEY');
    expect(workflow).not.toContain('assembleGlobalRelease');
    expect(workflow).not.toContain('assembleChinaRelease');
  });

  it('scopes R8 -dontwarn rules for stripped GMS classes exclusively to withoutFcm', () => {
    const appBuildGradle = read('web/android/app/build.gradle');
    const withoutFcmPro = read('web/android/app/proguard-without-fcm.pro');
    expect(appBuildGradle).toContain("proguardFile 'proguard-without-fcm.pro'");
    expect(withoutFcmPro).toContain('-dontwarn com.google.android.gms.tasks.**');
    expect(withoutFcmPro).toContain('-dontwarn com.google.android.gms.common.api.ApiException');
    expect(withoutFcmPro).toContain('-dontwarn com.google.android.gms.common.api.Status');
  });

  it('isolates BackgroundPushService and sensitive permissions strictly to withoutFcm manifest', () => {
    const mainManifest = read('web/android/app/src/main/AndroidManifest.xml');
    const withFcmManifest = read('web/android/app/src/withFcm/AndroidManifest.xml');
    const withoutFcmManifest = read('web/android/app/src/withoutFcm/AndroidManifest.xml');
    for (const token of [
      'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      'FOREGROUND_SERVICE_REMOTE_MESSAGING',
      'BackgroundPushService',
      'BackgroundPushBootReceiver',
      'without_fcm_backup_rules',
      'without_fcm_data_extraction_rules',
    ]) {
      expect(mainManifest).not.toContain(token);
      expect(withFcmManifest).not.toContain(token);
      expect(withoutFcmManifest).toContain(token);
    }
    const backupRules = read('web/android/app/src/withoutFcm/res/xml/without_fcm_backup_rules.xml');
    const dataExtractionRules = read('web/android/app/src/withoutFcm/res/xml/without_fcm_data_extraction_rules.xml');
    expect(backupRules).toContain('imcodes_bg_push_prefs.xml');
    expect(dataExtractionRules).toContain('<cloud-backup>');
    expect(dataExtractionRules).toContain('<device-transfer>');
    expect(dataExtractionRules).toContain('imcodes_bg_push_prefs.xml');
  });
});
