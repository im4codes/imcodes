/**
 * Windows adapter of the local-panel window. The node runs as SYSTEM in session 0, so everything that must appear on the user's
 * desktop (the window, focusing it, the default browser) is a PowerShell script started INSIDE the active user's session through the
 * proven launcher (WTSQueryUserToken + CreateProcessAsUser) and answered through a result file; the same scripts run directly when
 * the CLI is started by the user (a shortcut). Finding the window and its start time only reads the process table, so the service
 * does that itself. Decisions live in shared/local-panel-window.ts.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { win32 } from 'node:path';
import {
  LOCAL_PANEL_APP_MODE_BROWSERS,
  LOCAL_PANEL_WINDOWS_HOST,
  LOCAL_PANEL_WINDOW_REASON,
  LOCAL_PANEL_WINDOW_PROCESS_NAMES_WIN32,
  LOCAL_PANEL_WINDOW_TITLE,
  buildLocalPanelAppModeArgs,
} from '../../shared/local-panel-window.js';
import { AIDESK_LOCAL_UI_EXECUTABLE_NAME } from '../../shared/aidesk-product.js';
import { resolveWindowsPowerShellExecutable, runWindowsUserSessionScript } from './aidesk-desktop-entry.js';
import { resolveVerifiedAideskLocalUiDetailed, type VerifiedAideskLocalUi } from './aidesk-local-ui-artifact.js';
import type { LocalPanelWindowPlatform, LocalPanelWindowProcess } from './local-panel-window.js';

/** The profile sentinel the script replaces with the user's own LOCALAPPDATA path (the service does not know it). */
const PROFILE_SENTINEL = '__LOCAL_PANEL_PROFILE__';
/** `LOCALAPPDATA\IM.codes\local-panel\browser-profile`: per user, outside every default daemon directory. */
const PROFILE_RELATIVE = 'IM.codes\\local-panel\\browser-profile';

export type WindowsPanelOp =
  | { kind: 'launch_app'; browser: string }
  | { kind: 'focus'; pid: number }
  /** Look for the panel window in the user's session; answers `ok:<pid>:<startedAtMs>` or not_found. */
  | { kind: 'find' }
  | { kind: 'default_browser'; url: string }
  /**
   * Start the native window host in the user's session and wait up to 8 s: it is up (still running, or a second start that raised the
   * window and exited 0) -> `ok`; it exited with a failure -> `exited:<code>` (3 = the WebView2 runtime is missing); the file is no
   * longer the one that was verified (size or last write time differ) -> `failed`.
   */
  | { kind: 'launch_host'; path: string; size?: number; mtimeMs?: number };

/** What a script may answer: one of the words, or `ok:<pid>:<startedAtMs>` from the find operation. */
const WINDOWS_PANEL_RESULT_RE = /^(?:ok|not_found|failed|ok:\d+:\d+|exited:-?\d+)$/u;

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** The PowerShell arguments (an -EncodedCommand line) for one operation; `resultPath` empty = answer on stdout. Pure, so it is tested as text. */
export function buildWindowsPanelWindowCommand(op: WindowsPanelOp, resultPath = ''): string {
  const prelude = String.raw`$ErrorActionPreference='Stop'
$utf8=[Text.Encoding]::UTF8
function D([string]$v){$utf8.GetString([Convert]::FromBase64String($v))}
$resultPath=D '${b64(resultPath)}'
function Report([string]$value){if($resultPath){Set-Content -LiteralPath $resultPath -Value $value -NoNewline -Encoding UTF8}else{Write-Output $value}}
trap{Report 'failed';exit 0}
`;
  let body: string;
  if (op.kind === 'launch_app') {
    const args = buildLocalPanelAppModeArgs(PROFILE_SENTINEL);
    body = String.raw`$browser=D '${b64(op.browser)}'
$args=(D '${b64(JSON.stringify(args))}') | ConvertFrom-Json
$exe=$null
foreach($key in @("HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$browser","HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$browser","HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\$browser")){
  if(Test-Path -LiteralPath $key){$candidate=(Get-ItemProperty -LiteralPath $key).'(default)';if($candidate -and (Test-Path -LiteralPath $candidate)){$exe=$candidate;break}}
}
if(-not $exe){Report 'not_found';exit 0}
$profile=Join-Path $env:LOCALAPPDATA '${PROFILE_RELATIVE}'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profile) | Out-Null
$line=($args | ForEach-Object{$a=$_.Replace('${PROFILE_SENTINEL}',$profile);if($a -match '[\s"]'){'"'+$a.Replace('"','\"')+'"'}else{$a}}) -join ' '
Start-Process -FilePath $exe -ArgumentList $line
Report 'ok'`;
  } else if (op.kind === 'focus') {
    body = String.raw`$src=@'
using System;using System.Runtime.InteropServices;using System.Text;
public static class PanelWin{
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p,IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
 static bool Ours(uint pid,string[] images){
  try{var name=System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;foreach(var n in images){if(string.Equals(n,name,StringComparison.OrdinalIgnoreCase)) return true;}}catch{}
  return false;
 }
 public static bool Focus(uint pid,string title,string[] images){
  IntPtr found=IntPtr.Zero;
  EnumWindows((h,l)=>{
   if(!IsWindowVisible(h)) return true;
   uint owner;GetWindowThreadProcessId(h,out owner);
   var sb=new StringBuilder(256);GetWindowText(h,sb,256);
   // the recorded process, or a window with the panel's title that belongs to one of our own images (a same-titled window of anything else is not ours)
   if(owner==pid||(sb.ToString()==title&&Ours(owner,images))){found=h;return false;}
   return true;},IntPtr.Zero);
  if(found==IntPtr.Zero) return false;
  if(IsIconic(found)) ShowWindow(found,9);
  keybd_event(0x12,0,0,UIntPtr.Zero);keybd_event(0x12,0,2,UIntPtr.Zero);
  return SetForegroundWindow(found);
 }
}
'@
Add-Type -TypeDefinition $src
$images=(D '${b64(JSON.stringify(LOCAL_PANEL_WINDOW_PROCESS_NAMES_WIN32))}') | ConvertFrom-Json
if([PanelWin]::Focus(${op.pid},(D '${b64(LOCAL_PANEL_WINDOW_TITLE)}'),[string[]]@($images))){Report 'ok'}else{Report 'not_found'}`;
  } else if (op.kind === 'find') {
    body = String.raw`$title=D '${b64(LOCAL_PANEL_WINDOW_TITLE)}'
$images=(D '${b64(JSON.stringify(LOCAL_PANEL_WINDOW_PROCESS_NAMES_WIN32))}') | ConvertFrom-Json
$p=Get-Process | Where-Object{$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq $title -and ($images -contains $_.ProcessName.ToLowerInvariant())} | Sort-Object Id | Select-Object -First 1
if($p){Report ('ok:{0}:{1}' -f $p.Id,([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds())}else{Report 'not_found'}`;
  } else if (op.kind === 'launch_host') {
    // The verification happened in the node (and is remembered by size + last write time); here the file is only checked to still be
    // the very file that was verified, which costs a stat, not a hash.
    const identity = op.size !== undefined && op.mtimeMs !== undefined
      ? String.raw`
$item=Get-Item -LiteralPath $exe
if($item.Length -ne ${Math.trunc(op.size)} -or ([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeMilliseconds() -ne ${Math.trunc(op.mtimeMs)}){Report 'failed';exit 0}`
      : '';
    body = String.raw`$exe=D '${b64(op.path)}'
if(-not (Test-Path -LiteralPath $exe -PathType Leaf)){Report 'failed';exit 0}${identity}
$p=Start-Process -FilePath $exe -PassThru
if($p.WaitForExit(${LOCAL_PANEL_WINDOWS_HOST.launchWaitMilliseconds})){if($p.ExitCode -eq 0){Report 'ok'}else{Report ('exited:'+$p.ExitCode)}}else{Report 'ok'}`;
  } else {
    body = String.raw`Start-Process -FilePath (D '${b64(op.url)}')
Report 'ok'`;
  }
  const script = prelude + body;
  return `-NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

const TASKLIST_TIMEOUT_MS = 60_000;

export interface WindowsPanelWindowDeps {
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  /**
   * Runs a system tool (tasklist) to completion and returns its stdout: quick read-only process queries that never touch WMI.
   * Undefined when the tool did not run to completion (timeout, spawn error): "could not tell", which is not "nothing found".
   */
  tasklist: (args: readonly string[], timeoutMs?: number) => Promise<string | undefined>;
  /** Run one operation in the active user's session (service) or directly (user): the script's result word. */
  runOp: (op: WindowsPanelOp) => Promise<string | undefined>;
  /** The verified native window (manifest, hash and Authenticode signer -- or the record of an earlier full verification), or undefined. */
  nativeUi: () => Promise<VerifiedAideskLocalUi | undefined>;
  /** Size and whole-millisecond last write time of a file right now, or undefined. */
  statFile: (path: string) => { size: number; mtimeMs: number } | undefined;
  /**
   * A node running as the desktop user starts the host itself and watches it for an early exit (no PowerShell in between):
   * `ok` (still running, or a second start that raised the window and exited 0), `exited:<code>`, or `failed`.
   */
  spawnHost: (path: string, watchMs: number) => Promise<string>;
  now: () => number;
}

function isServiceAccount(env: NodeJS.ProcessEnv): boolean {
  const user = (env.USERNAME ?? '').toUpperCase();
  return user === 'SYSTEM' || user.endsWith('$');
}

const realDeps = (): WindowsPanelWindowDeps => {
  const env = process.env;
  const tasklist = (args: readonly string[], timeoutMs = TASKLIST_TIMEOUT_MS): Promise<string | undefined> => new Promise((resolve) => {
    const systemRoot = (env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows').replace(/"/gu, '');
    // A loaded or slow machine takes tens of seconds to list processes (measured on a Windows 10 node: well over 20 s).
    execFile(win32.join(systemRoot, 'System32', 'tasklist.exe'), [...args],
      { timeout: timeoutMs, encoding: 'utf8', windowsHide: true }, (error, stdout) => resolve(error ? undefined : String(stdout ?? '')));
  });
  return {
    env,
    exists: existsSync,
    tasklist,
    runOp: async (op) => {
      if (isServiceAccount(env)) {
        return runWindowsUserSessionScript({
          buildCommand: (resultPath) => buildWindowsPanelWindowCommand(op, resultPath),
          accept: (value) => WINDOWS_PANEL_RESULT_RE.test(value),
          resultPrefix: 'local-panel-window',
          // A user-session PowerShell cold start takes a minute on a slow machine; the node answers the click before then.
          timeoutMs: 90_000,
          windowsEnvironment: env,
        });
      }
      const out = await new Promise<string>((resolve) => {
        execFile(resolveWindowsPowerShellExecutable(env), buildWindowsPanelWindowCommand(op).split(' '),
          { timeout: 90_000, encoding: 'utf8', windowsHide: true }, (_error, stdout) => resolve(String(stdout ?? '')));
      });
      const word = out.trim().split(/\s+/u).pop() ?? '';
      return WINDOWS_PANEL_RESULT_RE.test(word) ? word : undefined;
    },
    nativeUi: () => resolveVerifiedAideskLocalUiDetailed(),
    statFile: (path) => { try { const stat = lstatSync(path); return stat.isFile() ? { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) } : undefined; } catch { return undefined; } },
    spawnHost: (path, watchMs) => new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const done = (answer: string): void => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(answer); };
      try {
        const child = spawn(path, [], { detached: true, stdio: 'ignore' });
        child.once('error', () => done('failed'));
        child.once('exit', (code) => done(code === 0 || code === null ? 'ok' : `exited:${code}`));
        timer = setTimeout(() => { child.unref(); done('ok'); }, watchMs);
        child.unref();
      } catch { done('failed'); }
    }),
    now: () => Date.now(),
  };
};

export function createWindowsLocalPanelWindowPlatform(overrides: Partial<WindowsPanelWindowDeps> = {}): LocalPanelWindowPlatform {
  const deps = { ...realDeps(), ...overrides };
  /** Until when clicks skip the host because it just said its WebView2 runtime is missing (the user may install it, so it is looked at again later). */
  let runtimeMissingUntil = 0;
  let runtimeMissing = false;
  /** The host `nativeUiPath()` last returned, with what it was verified against (the launch only starts that very file). */
  let verifiedHost: VerifiedAideskLocalUi | undefined;
  /** `ok:<pid>:<startedAtMs>` from the find operation. */
  const parseFound = (answer: string | undefined): LocalPanelWindowProcess | undefined => {
    const match = /^ok:(\d+):(\d+)$/u.exec(answer ?? '');
    if (!match) return undefined;
    const pid = Number(match[1]);
    const startedAtMs = Number(match[2]);
    return Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(startedAtMs) ? { pid, startedAtMs } : undefined;
  };
  return {
    platform: 'win32',
    canFocus: true,
    async hasDesktop() {
      if (!isServiceAccount(deps.env)) return true;
      // The service sees an interactive desktop when a user session (>= 1) runs explorer.exe: `"explorer.exe","<pid>","<session name>","<session #>",...`
      const out = await deps.tasklist(['/FI', 'IMAGENAME eq explorer.exe', '/FO', 'CSV', '/NH'], LOCAL_PANEL_WINDOWS_HOST.desktopCheckTimeoutMilliseconds);
      // The listing did not complete: not knowing is not "no desktop" -- try, and let the user-session launch report a missing desktop.
      if (out === undefined || out.trim() === '') return true;
      return out.split(/\r?\n/u).some((line) => Number(/^"[^"]*","\d+","[^"]*","(\d+)"/u.exec(line)?.[1] ?? -1) >= 1);
    },
    // The native host keeps its own single instance (a named mutex; a second start restores and raises the window), so the decision
    // layer simply starts it each time.
    nativeHostsOwnInstance: true,
    nativeUnavailableReason: () => runtimeMissing ? LOCAL_PANEL_WINDOW_REASON.NATIVE_RUNTIME_MISSING : undefined,
    nativeVerifySource: () => verifiedHost?.source,
    async nativeUiPath() {
      runtimeMissing = false;
      verifiedHost = undefined;
      // The host said its runtime is missing a moment ago: the browser window, without starting it again (and paying for a launch) first.
      if (deps.now() < runtimeMissingUntil) { runtimeMissing = true; return undefined; }
      // Whether the WebView2 runtime exists is the host's own answer (it checks before it shows anything and exits with a dedicated
      // code); there is no separate pre-check that would cost a whole user-session script.
      const host = await deps.nativeUi();
      if (host === undefined || !win32.isAbsolute(host.path)) return undefined;
      verifiedHost = host;
      return host.path;
    },
    async findAppModeBrowsers() {
      // The user's own session resolves each (their App Paths, their LOCALAPPDATA); the script answers not_found per browser.
      return [...LOCAL_PANEL_APP_MODE_BROWSERS.win32];
    },
    async findWindowProcess() {
      return parseFound(await deps.runOp({ kind: 'find' }));
    },
    async probePid(pid) {
      // Alive AND still one of the window's own images: a recycled pid belonging to anything else is not our window.
      // Not knowing counts as not alive: the record is dropped and the window is found again by its title (the authoritative look).
      const out = (await deps.tasklist(['/FI', `PID eq ${Math.trunc(pid)}`, '/FO', 'CSV', '/NH'])) ?? '';
      const alive = out.split(/\r?\n/u).some((line) => new RegExp(`^"(?:msedge|chrome|brave|${AIDESK_LOCAL_UI_EXECUTABLE_NAME})\\.exe","${Math.trunc(pid)}"`, 'iu').test(line));
      return alive ? { alive: true } : { alive: false };
    },
    async focusWindow(window) {
      return (await deps.runOp({ kind: 'focus', pid: window.pid })) === 'ok';
    },
    async launchNative(path) {
      // Only the file that was just verified is started, and only while it still is that file (size and last write time).
      const host = verifiedHost;
      if (!host || host.path !== path) return false;
      const now = deps.statFile(path);
      if (!now || now.size !== host.size || now.mtimeMs !== host.mtimeMs) return false;
      // A node on the user's own desktop starts the host directly. The service (session 0) has the user's session start it and report
      // how it went (see launch_host); either way a host that dies at once is a failed attempt, so the chain falls back to the browser
      // window instead of leaving the user with nothing.
      const answer = isServiceAccount(deps.env)
        ? await deps.runOp({ kind: 'launch_host', path, size: host.size, mtimeMs: host.mtimeMs })
        : await deps.spawnHost(path, LOCAL_PANEL_WINDOWS_HOST.directWatchMilliseconds);
      if (answer === 'exited:' + LOCAL_PANEL_WINDOWS_HOST.exitRuntimeMissing) {
        runtimeMissingUntil = deps.now() + LOCAL_PANEL_WINDOWS_HOST.runtimeMissingRememberMilliseconds;
        runtimeMissing = true;
      }
      return answer === 'ok';
    },
    async launchAppMode(browser) {
      return (await deps.runOp({ kind: 'launch_app', browser })) === 'ok';
    },
    async openDefaultBrowser(url) {
      return (await deps.runOp({ kind: 'default_browser', url })) === 'ok';
    },
  };
}
