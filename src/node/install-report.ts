/**
 * First-run installer reporting for all three platforms.
 *
 * A downloaded controlled node is run once, interactively, by a human. That run
 * either registers the machine or it does not, and the human has no other way to
 * find out: there is no UI, and on Windows the console window disappears the
 * moment the process exits. Reporting the outcome is therefore not a nicety, it
 * is the only feedback channel the install has.
 *
 * Two rules follow:
 *
 * 1. Never exit silently. Every terminal outcome of an installer launch prints
 *    either a success block or a failure block naming the actual cause.
 * 2. A failure must say what to do next. "requires Administrator/root" is a
 *    diagnosis; "right-click and Run as administrator" is a fix.
 *
 * The background service reuses none of this: it is launched by the OS, has no
 * console, and reports through the journal instead.
 */

import { win32, posix } from 'node:path';

/** Machine-readable cause, so the hint and the tests do not match on prose. */
export const INSTALL_FAILURE_CAUSE = {
  NOT_ELEVATED: 'not_elevated',
  ENROLLMENT_MISSING: 'enrollment_missing',
  ENROLLMENT_REJECTED: 'enrollment_rejected',
  SERVER_UNREACHABLE: 'server_unreachable',
  JOURNAL_RECOVERY: 'journal_recovery',
  PUBLISHER_TRUST: 'publisher_trust',
  UNKNOWN: 'unknown',
} as const;

export type InstallFailureCause =
  (typeof INSTALL_FAILURE_CAUSE)[keyof typeof INSTALL_FAILURE_CAUSE];

export interface InstallSuccessFacts {
  displayName?: string;
  nodeId?: string;
  /** Deprecated compatibility alias. */
  refName?: string;
  serverUrl: string;
  /**
   * Set when the machine registered but the publisher certificate could not be
   * installed. Registration succeeded, so this is a warning inside a success
   * block rather than a failure — but it must be visible, because the native
   * features will refuse to start and the operator would otherwise chase that
   * as a second, unexplained fault.
   */
  publisherTrustError?: string;
}

function isChinese(locale: string): boolean {
  return /^zh(?:-|$)/i.test(locale);
}

/**
 * True only for the downloaded installer, never the background service.
 *
 * The staged executable is the trailer-free copy the service runs from, so a
 * source path that differs from it is by definition the copy the human just
 * downloaded and started. Path comparison is case-insensitive on Windows only;
 * macOS and Linux paths are compared exactly, because they are.
 */
export function isInstallerLaunch(
  platform: NodeJS.Platform,
  sourceExecutablePath: string,
  stagedExecutablePath: string,
): boolean {
  if (platform === 'win32') {
    return win32.normalize(sourceExecutablePath).toLowerCase()
      !== win32.normalize(stagedExecutablePath).toLowerCase();
  }
  if (platform !== 'darwin' && platform !== 'linux') return false;
  return posix.normalize(sourceExecutablePath) !== posix.normalize(stagedExecutablePath);
}

/** Keep the visible first-run console intentionally terse. */
export function controlledNodeInstallStatus(locale: string): string {
  return isChinese(locale)
    ? 'IM.codes 安装中，请稍候...'
    : 'Installing IM.codes, please wait...';
}

/**
 * Map a thrown error to an actionable cause.
 *
 * Matching is on the stable substrings the throwing sites actually produce, not
 * on localized text. An unrecognized error is reported verbatim rather than
 * flattened into a generic message: an unknown cause the human can read beats a
 * known-looking cause that is wrong.
 */
export function classifyInstallFailure(error: unknown): InstallFailureCause {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('requires administrator') || message.includes('elevated privileges')) {
    return INSTALL_FAILURE_CAUSE.NOT_ELEVATED;
  }
  if (message.includes('enrollment blob') || message.includes('enrollment trailer')
    || message.includes('missing enrollment')) {
    return INSTALL_FAILURE_CAUSE.ENROLLMENT_MISSING;
  }
  if (message.includes('redeem_failed') || message.includes('enrollment redeem')
    || message.includes('401') || message.includes('409')) {
    return INSTALL_FAILURE_CAUSE.ENROLLMENT_REJECTED;
  }
  if (message.includes('enotfound') || message.includes('econnrefused')
    || message.includes('etimedout') || message.includes('econnreset')
    || message.includes('fetch failed') || message.includes('getaddrinfo')) {
    return INSTALL_FAILURE_CAUSE.SERVER_UNREACHABLE;
  }
  if (message.includes('manual recovery required') || message.includes('journal is corrupt')) {
    return INSTALL_FAILURE_CAUSE.JOURNAL_RECOVERY;
  }
  if (message.includes('publisher trust')) return INSTALL_FAILURE_CAUSE.PUBLISHER_TRUST;
  return INSTALL_FAILURE_CAUSE.UNKNOWN;
}

function elevationHint(platform: NodeJS.Platform, zh: boolean): string {
  if (platform === 'win32') {
    return zh
      ? '请右键点击此程序，选择「以管理员身份运行」。'
      : 'Right-click this program and choose "Run as administrator".';
  }
  const command = platform === 'darwin' ? 'sudo ./imcodes-node-macos' : 'sudo ./imcodes-node-linux';
  return zh
    ? `请用 root 权限重新运行：${command}`
    : `Re-run with root privileges: ${command}`;
}

function hintFor(cause: InstallFailureCause, platform: NodeJS.Platform, zh: boolean): string {
  if (cause === INSTALL_FAILURE_CAUSE.NOT_ELEVATED) return elevationHint(platform, zh);
  if (cause === INSTALL_FAILURE_CAUSE.ENROLLMENT_MISSING) {
    return zh
      ? '这个文件缺少安装凭据，可能被杀毒软件改动或没有下载完整。请从 IM.codes 重新下载一份，不要复制别人的副本。'
      : 'This file carries no enrolment credential — antivirus may have altered it, or the download was incomplete. Download a fresh copy from IM.codes rather than copying someone else\'s.';
  }
  if (cause === INSTALL_FAILURE_CAUSE.ENROLLMENT_REJECTED) {
    return zh
      ? '服务器拒绝了这个安装凭据：它可能已过期、已被撤销，或这份安装包已经用完了次数。请回到 IM.codes 重新生成安装链接。'
      : 'The server rejected this enrolment credential: it may have expired, been revoked, or exhausted its uses. Generate a fresh install link from IM.codes.';
  }
  if (cause === INSTALL_FAILURE_CAUSE.SERVER_UNREACHABLE) {
    return zh
      ? '无法连接到 IM.codes 服务器。请检查这台机器的网络、代理和防火墙设置。'
      : 'Could not reach the IM.codes server. Check this machine\'s network, proxy and firewall settings.';
  }
  if (cause === INSTALL_FAILURE_CAUSE.PUBLISHER_TRUST) {
    // The reason above is PowerShell's, and it is the actionable part. This
    // only says where to look, because the causes range from a group policy
    // that locks the certificate stores to antivirus blocking PowerShell.
    return zh
      ? '这台机器拒绝安装 IM.codes 的发布者证书。常见原因是组策略锁定了证书存储、杀毒软件拦截了 PowerShell，或这份安装包不是官方签名版本。请把上面这行「原因」连同这台机器的杀毒/组策略情况发给管理员。'
      : 'This machine refused to install the IM.codes publisher certificate. Common causes are group policy locking the certificate stores, antivirus blocking PowerShell, or an installer that is not an officially signed release. Send the Reason line above, plus this machine\'s antivirus/group-policy situation, to your administrator.';
  }
  if (cause === INSTALL_FAILURE_CAUSE.JOURNAL_RECOVERY) {
    return zh
      ? '这台机器上有一次未完成的安装残留，需要先清理。请联系管理员，或删除安装状态目录后重试。'
      : 'A previous unfinished install is still on this machine and must be cleared first. Contact your administrator, or remove the install state directory and retry.';
  }
  return zh
    ? '请把上面这条错误信息完整发给 IM.codes 管理员。'
    : 'Send the exact error line above to your IM.codes administrator.';
}

const RULE = '────────────────────────────────────────────────────────';

/**
 * Success block. Names the node as it will appear in the web UI, so the human
 * can confirm the machine they are standing at is the entry they now see.
 */
export function formatInstallSuccess(locale: string, facts: InstallSuccessFacts): string {
  const zh = isChinese(locale);
  const name = facts.displayName || facts.nodeId || facts.refName || '';
  const lines = zh
    ? [
      RULE,
      '✅ IM.codes 注册成功',
      '',
      ...(name ? [`   设备名称：${name}`] : []),
      ...(facts.nodeId ? [`   节点 ID： ${facts.nodeId}`] : []),
      `   服务器：  ${facts.serverUrl}`,
      '',
      '   这台机器已经注册，后台服务已安装并会开机自启。',
      '   现在可以在 IM.codes 网页端看到它了。',
      ...(facts.publisherTrustError ? [
        '',
        '⚠️  发布者证书未能安装，远程桌面等原生功能暂不可用：',
        `   ${facts.publisherTrustError}`,
        '   基础功能（终端、命令、文件传输）不受影响，可以先远程连上来再修。',
      ] : []),
      RULE,
    ]
    : [
      RULE,
      '✅ IM.codes registered successfully',
      '',
      ...(name ? [`   Device:  ${name}`] : []),
      ...(facts.nodeId ? [`   Node ID: ${facts.nodeId}`] : []),
      `   Server:  ${facts.serverUrl}`,
      '',
      '   This machine is registered. The background service is installed',
      '   and will start automatically on boot.',
      '   You can now see it in the IM.codes web app.',
      ...(facts.publisherTrustError ? [
        '',
        '⚠️  The publisher certificate could not be installed, so native',
        '   features such as remote desktop stay unavailable:',
        `   ${facts.publisherTrustError}`,
        '   Terminal, commands and file transfer still work, so you can',
        '   connect remotely and fix this from there.',
      ] : []),
      RULE,
    ];
  return lines.join('\n');
}

/**
 * Failure block. The raw error is always shown verbatim above the hint, because
 * the hint is a guess and the error is evidence.
 */
export function formatInstallFailure(
  locale: string,
  platform: NodeJS.Platform,
  error: unknown,
  cause: InstallFailureCause = classifyInstallFailure(error),
): string {
  const zh = isChinese(locale);
  const raw = error instanceof Error ? error.message : String(error);
  const lines = zh
    ? [
      RULE,
      '❌ IM.codes 注册失败',
      '',
      `   原因：${raw}`,
      '',
      `   ${hintFor(cause, platform, zh)}`,
      RULE,
    ]
    : [
      RULE,
      '❌ IM.codes registration failed',
      '',
      `   Reason: ${raw}`,
      '',
      `   ${hintFor(cause, platform, zh)}`,
      RULE,
    ];
  return lines.join('\n');
}

/** Prompt shown while the installer console is held open so it can be read. */
export function consoleHoldPrompt(locale: string): string {
  return isChinese(locale)
    ? '按回车键关闭此窗口...'
    : 'Press Enter to close this window...';
}

/** Countdown prompt for a console we can write to but cannot read a key from. */
export function consoleHoldCountdown(locale: string, seconds: number): string {
  return isChinese(locale)
    ? `此窗口将在 ${seconds} 秒后关闭...`
    : `This window will close in ${seconds} seconds...`;
}

export const CONSOLE_HOLD = {
  /** Waiting on a human keypress; long, because they may have walked away. */
  KEYPRESS_TIMEOUT_MS: 600_000,
  /** No readable stdin: hold long enough to read a short block, then release. */
  COUNTDOWN_MS: 60_000,
} as const;

export type ConsoleHoldMode = 'keypress' | 'countdown' | 'none';

/**
 * Decide how to keep an install result on screen.
 *
 * The failure this prevents is specific: a double-clicked installer owns its
 * console window, so exiting destroys the only copy of the result. Waiting for a
 * keypress is the correct hold, but it requires readable stdin — and stdin is
 * not readable in every launch path that still owns a console. Where we can
 * write to a console but cannot read from it, a bounded countdown is the only
 * remaining way to be readable at all.
 *
 * When neither stream is a terminal the output is being captured by something
 * else (a pipe, a log file, CI), and blocking there would hang a script for no
 * reader's benefit.
 */
export function consoleHoldMode(streams: {
  installerLaunch: boolean;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}): ConsoleHoldMode {
  if (!streams.installerLaunch) return 'none';
  if (streams.stdinIsTty) return 'keypress';
  if (streams.stdoutIsTty) return 'countdown';
  return 'none';
}
