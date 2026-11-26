import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const IOS_ROOT = join(REPO_ROOT, 'web/ios/App');
const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'ru'] as const;
const REQUIRED_UTIS = [
  'public.item',
  'public.content',
  'public.data',
  'public.url',
  'public.text',
  'public.plain-text',
  'public.image',
  'public.movie',
  'public.audio',
  'public.file-url',
] as const;

describe('iOS share extensions configuration', () => {
  it.each([
    {
      dir: 'ShareActionExtension',
      point: 'com.apple.ui-services',
      entitlements: 'ShareActionExtension.entitlements',
      displayName: 'Send to IM.codes',
    },
    {
      dir: 'ShareExtension',
      point: 'com.apple.share-services',
      entitlements: 'ShareExtension.entitlements',
      displayName: 'IM.codes',
    },
  ])('$dir uses App-Store-compliant SUBQUERY predicate covering all content types and 7 locales', ({ dir, point, entitlements, displayName }) => {
    const extRoot = join(IOS_ROOT, dir);
    const plist = readFileSync(join(extRoot, 'Info.plist'), 'utf8');
    expect(plist).toContain(`<string>${point}</string>`);
    expect(plist).toContain('<string>$(PRODUCT_MODULE_NAME).ShareActionViewController</string>');
    expect(plist).toContain(`<string>${displayName}</string>`);
    expect(plist).not.toContain('TRUEPREDICATE');
    expect(plist).toContain('SUBQUERY (');
    for (const uti of REQUIRED_UTIS) {
      expect(plist).toContain(`UTI-CONFORMS-TO "${uti}"`);
    }
    for (const locale of LOCALES) {
      expect(plist).toContain(`<string>${locale}</string>`);
      const stringsPath = join(extRoot, `${locale}.lproj/InfoPlist.strings`);
      expect(existsSync(stringsPath), stringsPath).toBe(true);
      const stringsContent = readFileSync(stringsPath, 'utf8');
      expect(stringsContent).toContain('"CFBundleDisplayName"');
      expect(stringsContent).toContain('"share.notificationBody"');
      expect(stringsContent).toContain('"share.notificationBodyText"');
      expect(stringsContent).toContain('"share.openApp"');
      expect(stringsContent).toContain('"share.openAppText"');
      expect(stringsContent).toContain('"share.done"');
      expect(stringsContent).toContain('"share.error"');
    }

    const ent = readFileSync(join(extRoot, entitlements), 'utf8');
    expect(ent).toContain('group.com.im.codes');
  });

  it('registers and embeds both ShareActionExtension.appex and ShareExtension.appex in App.xcodeproj', () => {
    const pbxproj = readFileSync(join(IOS_ROOT, 'App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbxproj).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.im.codes.ShareAction;');
    expect(pbxproj).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.im.codes.ShareExtension;');
    expect(pbxproj).toContain('ShareActionExtension.appex');
    expect(pbxproj).toContain('ShareExtension.appex');
    expect(pbxproj).toContain('ShareActionExtension/ShareActionExtension.entitlements');
    expect(pbxproj).toContain('ShareExtension/ShareExtension.entitlements');
    expect(pbxproj).toContain('/* ShareActionViewController.swift in Sources */');
  });

  it('writes atomic manifest.json in ShareActionViewController and parses safe batch manifests in ShareReceiverPlugin', () => {
    const extensionSwift = readFileSync(join(IOS_ROOT, 'ShareActionExtension/ShareActionViewController.swift'), 'utf8');
    expect(extensionSwift).toContain('manifest.json');
    expect(extensionSwift).toContain('.plainText');
    expect(extensionSwift).toContain('UTType.url');
    expect(extensionSwift).toContain('UTType.image');
    expect(extensionSwift).toContain('UIImage');
    expect(extensionSwift).toContain('attributedTitle');
    expect(extensionSwift).toContain('attributedContentText');
    expect(extensionSwift).toContain('share.notificationBodyText');

    const pluginSwift = readFileSync(join(IOS_ROOT, 'App/AuthSessionPlugin.swift'), 'utf8');
    expect(pluginSwift).toContain('handleIncomingBatchDirectory');
    expect(pluginSwift).toContain('resolveSafeBatchFile');
    expect(pluginSwift).toContain('manifest.json');
    expect(pluginSwift).toContain('file_too_large');
  });
});
