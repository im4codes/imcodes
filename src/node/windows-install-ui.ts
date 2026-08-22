import { win32 } from 'node:path';

/** True only for the downloaded Windows installer, never the background service. */
export function isWindowsInstallerLaunch(
  platform: NodeJS.Platform,
  sourceExecutablePath: string,
  stagedExecutablePath: string,
): boolean {
  return platform === 'win32'
    && win32.normalize(sourceExecutablePath).toLowerCase()
      !== win32.normalize(stagedExecutablePath).toLowerCase();
}

/** Keep the visible first-run console intentionally terse. */
export function controlledNodeInstallStatus(locale: string): string {
  return /^zh(?:-|$)/i.test(locale)
    ? 'IM.codes 安装中，请稍候...'
    : 'Installing IM.codes, please wait...';
}
