import { execFile, spawn, type SpawnOptions } from 'node:child_process';

/** Windows command-line quoting compatible with CommandLineToArgvW. */
export function quoteWindowsArgument(value: string): string {
  let out = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

export function windowsNamedPipeClientAclCommand(path: string): readonly [string, string, string] {
  return [path, '/grant', '*S-1-5-11:F'];
}

/**
 * Let the authenticated interactive user connect to a service-owned pipe.
 * The pipe protocol still requires an unguessable hello secret before accepting
 * the connection; this ACL only crosses the session-0/session-user boundary.
 */
export function allowWindowsNamedPipeClients(
  path: string,
  run: typeof execFile = execFile,
): Promise<void> {
  return new Promise((resolve, reject) => {
    run('icacls', [...windowsNamedPipeClientAclCommand(path)], {
      windowsHide: true,
      windowsVerbatimArguments: false,
      timeout: 15_000,
    }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function powershellBase64(value: string): string {
  return Buffer.from(value, 'utf16le').toString('base64');
}

/**
 * Launch one immutable executable on the currently active interactive desktop.
 * No credential/token is inherited by the child; only the explicit command line
 * and the active user's environment are supplied.
 */
export function launchWindowsActiveUserCommand(
  executable: string,
  argsLine: string,
  spawnImpl: typeof spawn = spawn,
  preferLinkedElevatedToken = false,
  allowSecureDesktopFallback = false,
): void {
  const exe64 = Buffer.from(executable, 'utf8').toString('base64');
  const args64 = Buffer.from(argsLine, 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$exe = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__EXE64__'))
$argsLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__ARGS64__'))
$src = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class ImcodesUserProc {
  [StructLayout(LayoutKind.Sequential)] public struct WTS_SESSION_INFO { public int SessionID; public IntPtr pWinStationName; public int State; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct TOKEN_LINKED_TOKEN { public IntPtr LinkedToken; }
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSEnumerateSessions(IntPtr hServer, int reserved, int version, out IntPtr ppSessionInfo, out int count);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSQueryUserToken(int sessionId, out IntPtr token);
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr existing, uint desiredAccess, IntPtr attrs, int impersonationLevel, int tokenType, out IntPtr newToken);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int tokenInformationClass, ref int tokenInformation, int tokenInformationLength);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int tokenInformationClass, out TOKEN_LINKED_TOKEN tokenInformation, int tokenInformationLength, out int returnLength);
  [DllImport("advapi32.dll", SetLastError=true, EntryPoint="GetTokenInformation")] static extern bool GetTokenInformationInt(IntPtr token, int tokenInformationClass, out int tokenInformation, int tokenInformationLength, out int returnLength);
  [DllImport("userenv.dll", SetLastError=true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
  [DllImport("userenv.dll", SetLastError=true)] static extern bool DestroyEnvironmentBlock(IntPtr env);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr procAttrs, IntPtr threadAttrs, bool inheritHandles, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string app, string cmd, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  const int WTSActive = 0;
  const int WTSConnected = 1;
  const int WTSDisconnected = 4;
  const uint TOKEN_ALL_ACCESS = 0xF01FF;
  const int SecurityImpersonation = 2;
  const int TokenPrimary = 1;
  const int TokenElevationType = 18;
  const int TokenLinkedToken = 19;
  const int TokenElevationTypeLimited = 3;
  const int TokenSessionId = 12;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint LOGON_WITH_PROFILE = 0x00000001;
  const int ERROR_PRIVILEGE_NOT_HELD = 1314;
  static bool HasUserToken(int sessionId) {
    IntPtr token;
    if (!WTSQueryUserToken(sessionId, out token)) return false;
    CloseHandle(token);
    return true;
  }
  public static bool TryInteractiveSessionId(out int selectedSessionId) {
    selectedSessionId = -1;
    IntPtr p; int count;
    if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out p, out count)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
      int console = unchecked((int)WTSGetActiveConsoleSessionId());
      int consoleCandidate = -1;
      int activeCandidate = -1;
      for (int i = 0; i < count; i++) {
        WTS_SESSION_INFO s = (WTS_SESSION_INFO)Marshal.PtrToStructure(IntPtr.Add(p, i * size), typeof(WTS_SESSION_INFO));
        if (s.SessionID <= 0 || !HasUserToken(s.SessionID)) continue;
        if (s.SessionID == console && console > 0 && s.State == WTSActive) {
          selectedSessionId = s.SessionID;
          return true;
        }
        if (s.State == WTSActive) {
          if (activeCandidate >= 0 && activeCandidate != s.SessionID) {
            activeCandidate = -2;
          } else if (activeCandidate == -1) {
            activeCandidate = s.SessionID;
          }
        }
        if (s.SessionID == console && console > 0 &&
            (s.State == WTSConnected || s.State == WTSDisconnected)) {
          consoleCandidate = s.SessionID;
        }
      }
      if (activeCandidate >= 0) {
        selectedSessionId = activeCandidate;
        return true;
      }
      if (activeCandidate == -2) throw new Exception("ambiguous active user sessions");
      if (consoleCandidate >= 0) {
        selectedSessionId = consoleCandidate;
        return true;
      }
    } finally { WTSFreeMemory(p); }
    return false;
  }
  static void LaunchPrimary(IntPtr primary, string exe, string argsLine, string desktop, bool allowTokenFallback) {
    IntPtr env;
    if (!CreateEnvironmentBlock(out env, primary, false)) env = IntPtr.Zero;
    try {
      STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.lpDesktop = desktop;
      PROCESS_INFORMATION pi;
      string cmd = "\"" + exe + "\" " + argsLine;
      if (!CreateProcessAsUser(primary, exe, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT, env, null, ref si, out pi)) {
        int error = Marshal.GetLastWin32Error();
        if (!allowTokenFallback || error != ERROR_PRIVILEGE_NOT_HELD || !CreateProcessWithTokenW(primary, LOGON_WITH_PROFILE, exe, cmd, CREATE_UNICODE_ENVIRONMENT, env, null, ref si, out pi)) {
          if (allowTokenFallback && error == ERROR_PRIVILEGE_NOT_HELD) error = Marshal.GetLastWin32Error();
          throw new System.ComponentModel.Win32Exception(error);
        }
      }
      CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    } finally { if (env != IntPtr.Zero) DestroyEnvironmentBlock(env); }
  }
  static void StartSecureConsole(string exe, string argsLine) {
    if (WindowsIdentity.GetCurrent().User == null ||
        WindowsIdentity.GetCurrent().User.Value != "S-1-5-18") {
      throw new Exception("secure desktop fallback requires LocalSystem");
    }
    int sid = unchecked((int)WTSGetActiveConsoleSessionId());
    if (sid <= 0 || sid == -1) throw new Exception("no active console session");
    IntPtr token, primary;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      if (!DuplicateTokenEx(token, TOKEN_ALL_ACCESS, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primary)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try {
        if (!SetTokenInformation(primary, TokenSessionId, ref sid, sizeof(int))) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        LaunchPrimary(primary, exe, argsLine + " --secure-console", "winsta0\\Winlogon", false);
      } finally { CloseHandle(primary); }
    } finally { CloseHandle(token); }
  }
  static bool SecureConsoleDisplayed() {
    int sid = unchecked((int)WTSGetActiveConsoleSessionId());
    if (sid <= 0 || sid == -1) return false;
    foreach (Process process in Process.GetProcessesByName("LogonUI")) {
      try {
        if (process.SessionId == sid) return true;
      } catch { }
      finally { process.Dispose(); }
    }
    return false;
  }
  public static void Start(string exe, string argsLine, bool preferLinkedElevatedToken, bool allowSecureDesktopFallback) {
    IntPtr token, primary;
    IntPtr linkedToken = IntPtr.Zero;
    int sid;
    if (allowSecureDesktopFallback && SecureConsoleDisplayed()) {
      StartSecureConsole(exe, argsLine);
      return;
    }
    if (!TryInteractiveSessionId(out sid)) {
      if (!allowSecureDesktopFallback) throw new Exception("no interactive user session");
      StartSecureConsole(exe, argsLine);
      return;
    }
    if (!WTSQueryUserToken(sid, out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      IntPtr launchToken = token;
      if (preferLinkedElevatedToken) {
        int elevationType;
        int returnLength;
        if (GetTokenInformationInt(token, TokenElevationType, out elevationType, sizeof(int), out returnLength) &&
            elevationType == TokenElevationTypeLimited) {
          TOKEN_LINKED_TOKEN linked;
          if (GetTokenInformation(token, TokenLinkedToken, out linked, Marshal.SizeOf(typeof(TOKEN_LINKED_TOKEN)), out returnLength)) {
            linkedToken = linked.LinkedToken;
            launchToken = linkedToken;
          }
        }
      }
      if (!DuplicateTokenEx(launchToken, TOKEN_ALL_ACCESS, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primary)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try {
        LaunchPrimary(primary, exe, argsLine, "winsta0\\default", true);
      } finally { CloseHandle(primary); }
    } finally {
      if (linkedToken != IntPtr.Zero) CloseHandle(linkedToken);
      CloseHandle(token);
    }
  }
}
'@
Add-Type -TypeDefinition $src
[ImcodesUserProc]::Start($exe, $argsLine, __PREFER_LINKED_TOKEN__, __ALLOW_SECURE_DESKTOP__)
`.replace('__EXE64__', exe64).replace('__ARGS64__', args64);
  const linkedTokenScript = script
    .replace('__PREFER_LINKED_TOKEN__', preferLinkedElevatedToken ? '$true' : '$false')
    .replace('__ALLOW_SECURE_DESKTOP__', allowSecureDesktopFallback ? '$true' : '$false');
  const options: SpawnOptions = {
    stdio: 'ignore',
    windowsHide: true,
  };
  const child = spawnImpl(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', powershellBase64(linkedTokenScript)],
    options,
  );
  child.on('error', () => {});
  child.unref();
}

/**
 * Launch the already-verified immutable remote-desktop worker with the active
 * administrator's linked token when one exists. This keeps the same user and
 * profile while allowing SendInput to cross an elevated foreground window;
 * standard users and non-UAC accounts retain the normal WTS token.
 */
export function launchWindowsActiveUserElevatedCommand(
  executable: string,
  argsLine: string,
  spawnImpl: typeof spawn = spawn,
): void {
  launchWindowsActiveUserCommand(executable, argsLine, spawnImpl, true);
}

/**
 * Launch the verified remote-desktop worker on the active user's Default
 * desktop, or as a LOCAL_SYSTEM worker on the active console's Winlogon
 * desktop while LogonUI is displayed or no user token exists. Native secure
 * console mode keeps authorization/input-epoch checks but denies clipboard
 * access and exits when Windows switches back to the Default desktop.
 */
export function launchWindowsRemoteDesktopCommand(
  executable: string,
  argsLine: string,
  spawnImpl: typeof spawn = spawn,
  allowSecureDesktopFallback = true,
): void {
  launchWindowsActiveUserCommand(
    executable,
    argsLine,
    spawnImpl,
    true,
    allowSecureDesktopFallback,
  );
}
