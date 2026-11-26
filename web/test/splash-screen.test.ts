import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('startup splash screen contract', () => {
  const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  const appSource = readFileSync(resolve(__dirname, '../src/app.tsx'), 'utf8');

  it('keeps the logo centered while the codes text reveals', () => {
    expect(indexHtml).toContain('--splash-avatar-size');
    expect(indexHtml).toContain('--splash-avatar-size: clamp(96px, 18vw, 156px)');
    expect(indexHtml).toContain('class="splash-avatar" src="/imcodes-robot-avatar.png"');
    expect(indexHtml).toMatch(/\.splash-avatar\s*\{[^}]*width:\s*var\(--splash-avatar-size\)/);
    expect(indexHtml).toMatch(/\.splash-avatar\s*\{[^}]*object-fit:\s*contain/);
    expect(indexHtml).toMatch(/\.splash-avatar\s*\{[^}]*drop-shadow\(/);
    const splashAvatarRule = indexHtml.match(/\.splash-avatar\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(splashAvatarRule).not.toContain('border-radius: 22.37%');
    expect(splashAvatarRule).not.toMatch(/\bborder:/);
    expect(splashAvatarRule).not.toMatch(/\bbackground:/);
    expect(indexHtml).toMatch(/--splash-bg:\s*#0a0e1a/);
    expect(indexHtml).toContain('--splash-logo-width');
    expect(indexHtml).toMatch(/\.splash-logo\s*\{[^}]*width:\s*var\(--splash-logo-width\)/);
    expect(indexHtml).toMatch(/\.splash-top\s*\{[^}]*justify-content:\s*center/);
    expect(indexHtml).toMatch(/\.splash-codes\s*\{[^}]*width:\s*3\.08em/);
    expect(indexHtml).toMatch(/\.splash-codes\s*\{[^}]*clip-path:\s*inset\(0 100% 0 0\)/);
    expect(indexHtml).toContain('@keyframes revealCodes');
    expect(indexHtml).not.toContain('@keyframes typeOut');
  });

  it('runs the splash animation cleanly for cold startup and preserves exit transitions', () => {
    expect(indexHtml).toMatch(/animation:\s*avatarBoot 0\.34s/);
    expect(indexHtml).toMatch(/animation:\s*glitchIn 0\.45s/);
    expect(indexHtml).toMatch(/animation:\s*revealCodes 0\.32s/);
    expect(indexHtml).toMatch(/animation:\s*fadeUp 0\.34s/);
    expect(indexHtml).toMatch(/animation:\s*beamSweep 0\.9s/);
    expect(indexHtml).toMatch(/animation:\s*scanDown 1\.7s/);
    expect(indexHtml).toMatch(/transition:\s*opacity 0\.12s ease,\s*visibility 0\.12s ease/);
    expect(appSource).toContain('const minMs = 1100;');
    expect(appSource).toContain('const exitMs = 120;');
  });

  it('switches owned servers in-app without page reloads or splash flags', () => {
    expect(appSource).not.toContain('imcodes:fast-server-switch-splash');
    expect(appSource).not.toContain('markFastServerSwitchSplash');
    const handleSelectServerMatch = appSource.match(/const handleSelectServer = useCallback\([\s\S]*?\n\s*\}, \[/);
    expect(handleSelectServerMatch?.[0]).toBeTruthy();
    expect(handleSelectServerMatch?.[0]).not.toContain('window.location.reload()');
  });

  it('waits for startup readiness before beginning the splash exit', () => {
    expect(appSource).toContain('The HTML splash masks JS/native startup work');
    expect(appSource).toMatch(/if \(!nativeReady && !nativeCallback\) return/);
    expect(appSource).toMatch(/const timer = setTimeout\(startExit,\s*minMs\)/);
  });

  it('binds Android 12+ SplashScreen theme attributes and native splash colors to match HTML --splash-bg', () => {
    const htmlBg = indexHtml.match(/--splash-bg:\s*(#[0-9a-fA-F]{6})/)?.[1]?.toLowerCase();
    expect(htmlBg).toBe('#0a0e1a');

    const manifestPath = resolve(__dirname, '../android/app/src/main/AndroidManifest.xml');
    const manifest = readFileSync(manifestPath, 'utf8');
    expect(manifest).toMatch(
      /<activity[^>]*android:name="\.MainActivity"[^>]*android:theme="@style\/AppTheme\.NoActionBarLaunch"/s,
    );

    const stylesPath = resolve(__dirname, '../android/app/src/main/res/values/styles.xml');
    const stylesXml = readFileSync(stylesPath, 'utf8');
    const launchTheme = stylesXml.match(
      /<style\s+name="AppTheme\.NoActionBarLaunch"\s+parent="Theme\.SplashScreen">([\s\S]*?)<\/style>/,
    )?.[1];
    expect(launchTheme).toBeTruthy();
    expect(launchTheme).toMatch(/<item\s+name="android:background">@drawable\/splash<\/item>/);

    const splashBgRef = launchTheme?.match(
      /<item\s+name="windowSplashScreenBackground">([^<]+)<\/item>/,
    )?.[1]?.trim();
    expect(splashBgRef).toBeTruthy();

    let resolvedAndroidBg = splashBgRef?.toLowerCase();
    if (splashBgRef?.startsWith('@color/')) {
      const colorName = splashBgRef.slice('@color/'.length);
      const colorsXml = readFileSync(
        resolve(__dirname, '../android/app/src/main/res/values/colors.xml'),
        'utf8',
      );
      const colorHex = colorsXml.match(
        new RegExp(`<color\\s+name="${colorName}">([^<]+)</color>`),
      )?.[1]?.trim().toLowerCase();
      resolvedAndroidBg = colorHex;
    }
    expect(resolvedAndroidBg).toBe(htmlBg);

    const iconRef = launchTheme?.match(
      /<item\s+name="windowSplashScreenAnimatedIcon">([^<]+)<\/item>/,
    )?.[1]?.trim();
    expect(iconRef).toBeTruthy();
    const resRoot = resolve(__dirname, '../android/app/src/main/res');
    if (iconRef?.startsWith('@mipmap/')) {
      const name = iconRef.slice('@mipmap/'.length);
      // API 26-30 AndroidX SplashScreen applies a 2/3 circular mask on top of
      // AdaptiveIconDrawable's 1.5x crop (double-masking). Base theme must not point at an adaptive-icon XML.
      const adaptiveAnyDpiPath = resolve(resRoot, `mipmap-anydpi-v26/${name}.xml`);
      expect(existsSync(adaptiveAnyDpiPath)).toBe(false);
      for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
        expect(existsSync(resolve(resRoot, `mipmap-${density}/${name}.png`))).toBe(true);
      }
    } else if (iconRef?.startsWith('@drawable/')) {
      const name = iconRef.slice('@drawable/'.length);
      const drawableXmlPath = resolve(resRoot, `drawable/${name}.xml`);
      if (existsSync(drawableXmlPath)) {
        const drawableXml = readFileSync(drawableXmlPath, 'utf8');
        expect(drawableXml).not.toContain('<adaptive-icon');
      } else {
        expect(
          existsSync(resolve(resRoot, `drawable-nodpi/${name}.png`))
          || existsSync(resolve(resRoot, `drawable/${name}.png`)),
        ).toBe(true);
      }
    } else {
      throw new Error(`Unexpected windowSplashScreenAnimatedIcon reference: ${iconRef}`);
    }

    const capacitorConfig = readFileSync(resolve(__dirname, '../capacitor.config.ts'), 'utf8');
    expect(capacitorConfig).toMatch(/SplashScreen:\s*\{[^}]*backgroundColor:\s*'#0a0e1a'/s);
    expect(capacitorConfig).toMatch(/ios:\s*\{[^}]*backgroundColor:\s*'#0a0e1a'/s);
  });
});
