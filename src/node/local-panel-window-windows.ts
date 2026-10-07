/**
 * Windows adapter of the local-panel window. The node runs as SYSTEM in session 0, so everything that must appear on the user's
 * desktop (the window, focusing it, the default browser) is a PowerShell script started INSIDE the active user's session through the
 * proven launcher (WTSQueryUserToken + CreateProcessAsUser) and answered through a result file; the same scripts run directly when
 * the CLI is started by the user (a shortcut). Finding the window and its start time only reads the process table, so the service
 * does that itself. Decisions live in shared/local-panel-window.ts.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import {
  LOCAL_PANEL_APP_MODE_BROWSERS,
  LOCAL_PANEL_WINDOW_TITLE,
  buildLocalPanelAppModeArgs,
} from '../../shared/local-panel-window.js';
import { AIDESK_LOCAL_UI_EXECUTABLE_NAME } from '../../shared/aidesk-product.js';
import { resolveWindowsPowerShellExecutable, runWindowsUserSessionScript } from './aidesk-desktop-entry.js';
import { resolveVerifiedAideskLocalUi } from './aidesk-local-ui-artifact.js';
import { launchWindowsActiveUserCommand } from './windows-user-session.js';
import type { LocalPanelWindowPlatform, LocalPanelWindowProcess } from './local-panel-window.js';

/** The profile sentinel the script replaces with the user's own LOCALAPPDATA path (the service does not know it). */
const PROFILE_SENTINEL = '__LOCAL_PANEL_PROFILE__';
/** `LOCALAPPDATA\IM.codes\local-panel\browser-profile`: per user, outside every default daemon directory. */
const PROFILE_RELATIVE = 'IM.codes\\local-panel\\browser-profile';

export type WindowsPanelOp =
  | { kind: 'launch_app'; browser: string }
  | { kind: 'focus'; pid: number }
  | { kind: 'default_browser'; url: string };

const WINDOWS_PANEL_RESULTS = ['ok', 'not_found', 'failed'] as const;

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
 public static bool Focus(uint pid,string title){
  IntPtr found=IntPtr.Zero;
  EnumWindows((h,l)=>{
   if(!IsWindowVisible(h)) return true;
   uint owner;GetWindowThreadProcessId(h,out owner);
   var sb=new StringBuilder(256);GetWindowText(h,sb,256);
   if(owner==pid||sb.ToString()==title){found=h;return false;}
   return true;},IntPtr.Zero);
  if(found==IntPtr.Zero) return false;
  if(IsIconic(found)) ShowWindow(found,9);
  keybd_event(0x12,0,0,UIntPtr.Zero);keybd_event(0x12,0,2,UIntPtr.Zero);
  return SetForegroundWindow(found);
 }
}
'@
Add-Type -TypeDefinition $src
if([PanelWin]::Focus(${op.pid},(D '${b64(LOCAL_PANEL_WINDOW_TITLE)}'))){Report 'ok'}else{Report 'not_found'}`;
  } else {
    body = String.raw`Start-Process -FilePath (D '${b64(op.url)}')
Report 'ok'`;
  }
  const script = prelude + body;
  return `-NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

/** The PowerShell that lists the panel window process: the app-mode browser carrying our profile, or the native window. */
export function buildWindowsPanelProcessQuery(): string {
  return `$p=Get-CimInstance Win32_Process | Where-Object{($_.CommandLine -and $_.CommandLine -like '*local-panel*browser-profile*') -or $_.Name -eq '${AIDESK_LOCAL_UI_EXECUTABLE_NAME}.exe'} | Sort-Object ProcessId | Select-Object -First 1
if($p){'{0} {1}' -f $p.ProcessId,([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}`;
}

export interface WindowsPanelWindowDeps {
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  /** Runs PowerShell to completion and returns its stdout (read-only process queries). */
  powershell: (script: string) => Promise<string>;
  /** Run one operation in the active user's session (service) or directly (user): the script's result word. */
  runOp: (op: WindowsPanelOp) => Promise<string | undefined>;
  launchNative: (path: string) => Promise<boolean>;
  /** The verified native window (manifest, hash and Authenticode signer), or undefined. */
  nativeUiPath: () => Promise<string | undefined>;
}

function isServiceAccount(env: NodeJS.ProcessEnv): boolean {
  const user = (env.USERNAME ?? '').toUpperCase();
  return user === 'SYSTEM' || user.endsWith('$');
}

const realDeps = (): WindowsPanelWindowDeps => {
  const env = process.env;
  const powershell = (script: string): Promise<string> => new Promise((resolve) => {
    execFile(resolveWindowsPowerShellExecutable(env), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 10_000, encoding: 'utf8', windowsHide: true }, (_error, stdout) => resolve(String(stdout ?? '')));
  });
  return {
    env,
    exists: existsSync,
    powershell,
    runOp: async (op) => {
      if (isServiceAccount(env)) {
        return runWindowsUserSessionScript({
          buildCommand: (resultPath) => buildWindowsPanelWindowCommand(op, resultPath),
          accept: (value) => (WINDOWS_PANEL_RESULTS as readonly string[]).includes(value),
          resultPrefix: 'local-panel-window',
          timeoutMs: 12_000,
          windowsEnvironment: env,
        });
      }
      const out = await new Promise<string>((resolve) => {
        execFile(resolveWindowsPowerShellExecutable(env), buildWindowsPanelWindowCommand(op).split(' '),
          { timeout: 12_000, encoding: 'utf8', windowsHide: true }, (_error, stdout) => resolve(String(stdout ?? '')));
      });
      const word = out.trim().split(/\s+/u).pop() ?? '';
      return (WINDOWS_PANEL_RESULTS as readonly string[]).includes(word) ? word : undefined;
    },
    launchNative: (path) => new Promise((resolve) => {
      if (isServiceAccount(env)) {
        let failed = false;
        launchWindowsActiveUserCommand(path, '', undefined, false, false, false, () => { failed = true; });
        setTimeout(() => resolve(!failed), 1_500);
        return;
      }
      try {
        const child = spawn(path, [], { detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', () => resolve(false));
        child.once('spawn', () => { child.unref(); setTimeout(() => resolve(true), 600); });
      } catch { resolve(false); }
    }),
    nativeUiPath: () => resolveVerifiedAideskLocalUi(),
  };
};

export function createWindowsLocalPanelWindowPlatform(overrides: Partial<WindowsPanelWindowDeps> = {}): LocalPanelWindowPlatform {
  const deps = { ...realDeps(), ...overrides };
  const parseProcess = (text: string): LocalPanelWindowProcess | undefined => {
    const match = /^(\d+)\s+(\d+)$/mu.exec(text.trim());
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
      // The service sees an interactive desktop when a user session (>= 1) runs explorer.exe.
      const out = await deps.powershell("(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object{$_.SessionId -ge 1} | Select-Object -First 1).SessionId");
      return /^\d+$/mu.test(out.trim());
    },
    async nativeUiPath() {
      const path = await deps.nativeUiPath();
      return path !== undefined && win32.isAbsolute(path) ? path : undefined;
    },
    async findAppModeBrowsers() {
      // The user's own session resolves each (their App Paths, their LOCALAPPDATA); the script answers not_found per browser.
      return [...LOCAL_PANEL_APP_MODE_BROWSERS.win32];
    },
    async findWindowProcess() {
      return parseProcess(await deps.powershell(buildWindowsPanelProcessQuery()));
    },
    async probePid(pid) {
      const out = await deps.powershell(`$p=Get-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue
if($p){([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()}`);
      const startedAtMs = Number(out.trim());
      return Number.isFinite(startedAtMs) && startedAtMs > 0 ? { alive: true, startedAtMs } : { alive: false };
    },
    async focusWindow(window) {
      return (await deps.runOp({ kind: 'focus', pid: window.pid })) === 'ok';
    },
    launchNative: (path) => deps.launchNative(path),
    async launchAppMode(browser) {
      return (await deps.runOp({ kind: 'launch_app', browser })) === 'ok';
    },
    async openDefaultBrowser(url) {
      return (await deps.runOp({ kind: 'default_browser', url })) === 'ok';
    },
  };
}
