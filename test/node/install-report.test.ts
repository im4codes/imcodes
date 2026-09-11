import { describe, expect, it } from 'vitest';
import {
  CONSOLE_HOLD,
  INSTALL_FAILURE_CAUSE,
  consoleHoldCountdown,
  consoleHoldMode,
  classifyInstallFailure,
  consoleHoldPrompt,
  CONTROLLED_NODE_INSTALL_WARNING_SECONDS,
  controlledNodeInstallCountdown,
  controlledNodeInstallDeclined,
  controlledNodeInstallWarning,
  controlledNodeInstallStatus,
  formatInstallFailure,
  formatInstallSuccess,
  isInstallerLaunch,
} from '../../src/node/install-report.js';
import { CONTROLLED_NODE_ID_MIN } from '../../shared/controlled-node-identity.js';
import { MACHINE_ACCESS_ROLES, type MachineAccessRole } from '../../shared/remote-exec.js';

describe('controlled-node install reporting', () => {
  it('treats a source outside the staged path as an installer launch on all three platforms', () => {
    expect(isInstallerLaunch(
      'win32',
      'C:\\Users\\test\\Downloads\\imcodes-node.exe',
      'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
    )).toBe(true);
    expect(isInstallerLaunch(
      'darwin',
      '/Users/test/Downloads/imcodes-node-macos',
      '/Library/Application Support/imcodes-node/imcodes-node-macos',
    )).toBe(true);
    expect(isInstallerLaunch(
      'linux',
      '/tmp/imcodes-node',
      '/var/lib/imcodes-node/imcodes-node-linux',
    )).toBe(true);
  });

  it('never treats the staged background service as an installer launch', () => {
    // Windows compares case-insensitively; POSIX must not, because POSIX paths
    // are case-sensitive and two differently-cased paths are two files.
    expect(isInstallerLaunch(
      'win32',
      'c:\\programdata\\imcodes-node\\IMCODES-NODE.EXE',
      'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
    )).toBe(false);
    expect(isInstallerLaunch(
      'linux',
      '/var/lib/imcodes-node/./imcodes-node-linux',
      '/var/lib/imcodes-node/imcodes-node-linux',
    )).toBe(false);
    expect(isInstallerLaunch(
      'darwin',
      '/Library/Application Support/imcodes-node/IMCODES-NODE-MACOS',
      '/Library/Application Support/imcodes-node/imcodes-node-macos',
    )).toBe(true);
  });

  it('names the capability, the scam pretexts and the checkable origin per locale', () => {
    const zh = controlledNodeInstallWarning('zh-CN', { serverUrl: 'https://im.example.com' });
    // The capability must be named, not hinted at: remote control is the thing
    // the victim of a phone scam is never told they are agreeing to.
    expect(zh).toContain('远程控制这台电脑');
    expect(zh).toContain('诈骗');
    expect(zh).toContain('解冻资金');
    expect(zh).toContain('验证码');
    // An instruction, not a caution. "Be careful" leaves a person on a phone
    // call doing nothing, which is exactly what the caller wants.
    expect(zh).toContain('立即关闭当前窗口，并删除刚才下载的软件！');
    expect(zh).toContain('真正的公检法不会让你装远程控制软件');
    // The origin is the one fact the person can independently verify.
    expect(zh).toContain('https://im.example.com');

    const en = controlledNodeInstallWarning('en-US', { serverUrl: 'https://im.example.com' });
    expect(en).toContain('scam');
    expect(en).toContain('remotely');
    expect(en).toContain('verification code');
    expect(en).toContain('Close this window now and delete the file you just downloaded!');
    expect(en).toContain('https://im.example.com');

    // An unreadable trailer must not invent an origin the human cannot check.
    expect(controlledNodeInstallWarning('en-US')).not.toContain('administrator of:');
    expect(controlledNodeInstallDeclined('zh-CN')).toContain('没有任何改动');
    expect(controlledNodeInstallDeclined('en-US')).toContain('Nothing on this computer was changed');
  });

  it('repeats the escape on every countdown tick, not just the first', () => {
    // Someone who only looks up halfway through still has to learn they can
    // stop it, so the way out is on the line that is actually on screen.
    for (const seconds of [CONTROLLED_NODE_INSTALL_WARNING_SECONDS, 7, 0]) {
      expect(controlledNodeInstallCountdown('zh-CN', seconds)).toContain('按任意键立即取消');
      expect(controlledNodeInstallCountdown('zh-CN', seconds)).toContain(String(seconds));
      expect(controlledNodeInstallCountdown('en-US', seconds)).toContain('press any key to cancel');
      expect(controlledNodeInstallCountdown('en-US', seconds)).toContain(String(seconds));
    }
  });

  it('holds the warning long enough to be read and acted on', () => {
    // Long enough to read the block and hang up; short enough that provisioning
    // a fleet does not become a reason to strip the warning out.
    expect(CONTROLLED_NODE_INSTALL_WARNING_SECONDS).toBeGreaterThanOrEqual(30);
    expect(CONTROLLED_NODE_INSTALL_WARNING_SECONDS).toBeLessThanOrEqual(60);
  });

  it('uses a concise localized status without exposing implementation details', () => {
    expect(controlledNodeInstallStatus('zh-CN')).toBe('IM.codes 安装中，请稍候...');
    expect(controlledNodeInstallStatus('en-US')).toBe('Installing IM.codes, please wait...');
    expect(consoleHoldPrompt('zh-CN')).toContain('回车');
    expect(consoleHoldPrompt('en-US')).toContain('Enter');
  });

  it('classifies the failures a human can actually act on', () => {
    expect(classifyInstallFailure(new Error(
      'controlled node installation requires Administrator/root; rerun this executable with elevated privileges',
    ))).toBe(INSTALL_FAILURE_CAUSE.NOT_ELEVATED);
    expect(classifyInstallFailure(new Error('missing enrollment blob in executable')))
      .toBe(INSTALL_FAILURE_CAUSE.ENROLLMENT_MISSING);
    expect(classifyInstallFailure(new Error('enrollment redeem failed: redeem_failed')))
      .toBe(INSTALL_FAILURE_CAUSE.ENROLLMENT_REJECTED);
    expect(classifyInstallFailure(new Error('getaddrinfo ENOTFOUND im.zhinet.work')))
      .toBe(INSTALL_FAILURE_CAUSE.SERVER_UNREACHABLE);
    expect(classifyInstallFailure(new Error('controlled node install journal is corrupt; manual recovery required')))
      .toBe(INSTALL_FAILURE_CAUSE.JOURNAL_RECOVERY);
    expect(classifyInstallFailure(new Error('something nobody predicted')))
      .toBe(INSTALL_FAILURE_CAUSE.UNKNOWN);
  });

  it('gives each platform its own elevation instruction', () => {
    const win = formatInstallFailure('zh-CN', 'win32', new Error('requires Administrator/root'));
    const mac = formatInstallFailure('en-US', 'darwin', new Error('requires Administrator/root'));
    const linux = formatInstallFailure('en-US', 'linux', new Error('requires Administrator/root'));
    expect(win).toContain('以管理员身份运行');
    expect(mac).toContain('sudo ./imcodes-node-macos');
    expect(linux).toContain('sudo ./imcodes-node-linux');
    // A POSIX user must never be told to right-click.
    expect(mac).not.toMatch(/administrator"/i);
  });

  it('always shows the raw error verbatim, because the hint is only a guess', () => {
    const raw = 'totally unrecognized failure 0x8007000E';
    for (const locale of ['zh-CN', 'en-US']) {
      const block = formatInstallFailure(locale, 'win32', new Error(raw));
      expect(block).toContain(raw);
      expect(block).toMatch(/❌/);
    }
  });

  it('holds the console so the result is readable, and never for the service', () => {
    // The whole point: a double-clicked installer destroys its console on exit.
    expect(consoleHoldMode({ installerLaunch: true, stdinIsTty: true, stdoutIsTty: true }))
      .toBe('keypress');
    // Console exists but stdin is not readable — there is no key to wait for,
    // yet exiting immediately would still destroy the only copy of the result.
    expect(consoleHoldMode({ installerLaunch: true, stdinIsTty: false, stdoutIsTty: true }))
      .toBe('countdown');
    // Output is being captured elsewhere; blocking would hang a script.
    expect(consoleHoldMode({ installerLaunch: true, stdinIsTty: false, stdoutIsTty: false }))
      .toBe('none');
    // The background service must never block on a console it does not own.
    for (const stdinIsTty of [true, false]) {
      for (const stdoutIsTty of [true, false]) {
        expect(consoleHoldMode({ installerLaunch: false, stdinIsTty, stdoutIsTty })).toBe('none');
      }
    }
  });

  it('bounds every hold so an unattended install still terminates', () => {
    expect(CONSOLE_HOLD.KEYPRESS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CONSOLE_HOLD.COUNTDOWN_MS).toBeGreaterThan(0);
    // A keypress hold may be generous; an unreadable console must not be.
    expect(CONSOLE_HOLD.COUNTDOWN_MS).toBeLessThan(CONSOLE_HOLD.KEYPRESS_TIMEOUT_MS);
    expect(consoleHoldCountdown('zh-CN', 60)).toContain('60');
    expect(consoleHoldCountdown('en-US', 60)).toContain('60');
  });

  it('reports success with the name the machine will show in the web app', () => {
    const zh = formatInstallSuccess('zh-CN', {
      displayName: 'MRBIG-PC', nodeId: CONTROLLED_NODE_ID_MIN, refName: 'mrbig_pc', serverUrl: 'https://im.zhinet.work',
    });
    expect(zh).toContain('注册成功');
    expect(zh).toContain('MRBIG-PC');
    expect(zh).toContain(CONTROLLED_NODE_ID_MIN);
    expect(zh).toContain('https://im.zhinet.work');

    const en = formatInstallSuccess('en-US', { serverUrl: 'https://im.zhinet.work' });
    expect(en).toContain('registered successfully');
    // No name available must not print an empty labelled row.
    expect(en).not.toMatch(/Device:\s*$/m);
  });

  it('states exactly the access model the backend implements', () => {
    // R1 REWORK P0/P1: there is no Desk/tenant entity. controlled-node-identity
    // inserts only servers.user_id, and machine-access admits a machine on
    // `s.user_id = $1 OR sh.id IS NOT NULL`, so the copy must claim the owner
    // plus people authorized ON THIS MACHINE, never Desk membership.
    //
    // R2 REWORK P1: "authorized" is not "can control". shared/remote-exec.ts is
    // the entire role vocabulary; the control gate is canOperateControlledMachine
    // (server/src/share/machine-access.ts), true for exactly 'owner' and
    // 'participant', and every control surface routes through it -- machine-exec,
    // file-transfer, machine-computer-use, remote-desktop-router. A 'viewer'
    // share is admitted by the access query and still denied control. Copy that
    // promises control to everyone authorized is therefore false for viewers.
    const CONTROL_CAPABLE: readonly MachineAccessRole[] = ['owner', 'participant'];

    // Direction 1 -- VIEWER: authorized on the machine, denied control. Its
    // existence is why the copy may not promise control to everyone authorized.
    expect(MACHINE_ACCESS_ROLES, 'viewer must still be a grantable role').toContain('viewer');
    expect(CONTROL_CAPABLE, 'viewer must not be control-capable').not.toContain('viewer');
    const authorizedWithoutControl = MACHINE_ACCESS_ROLES.filter((role) => !CONTROL_CAPABLE.includes(role));
    expect(
      authorizedWithoutControl,
      'a role that is authorized on the machine yet cannot control it must exist, or this copy is over-specified',
    ).toEqual(['viewer']);

    // Direction 2 -- PARTICIPANT: a non-owner who CAN control. Its existence is
    // why the copy may not narrow control to the owner alone. Both directions
    // must hold at once, which is what forces "access by permission granted,
    // control only with the control permission" instead of either extreme.
    expect(MACHINE_ACCESS_ROLES, 'participant must still be a grantable role').toContain('participant');
    expect(CONTROL_CAPABLE, 'participant must be control-capable').toContain('participant');
    const nonOwnerControllers = CONTROL_CAPABLE.filter((role) => role !== 'owner');
    expect(nonOwnerControllers, 'a non-owner controlling role must exist').toEqual(['participant']);

    const zh = controlledNodeInstallWarning('zh-CN', { serverUrl: 'https://im.zhinet.work' });
    expect(zh).toContain('把这台电脑绑定到我的 IM.codes 账号');
    expect(zh, 'only the account holder').toContain('只有这个账号的主人能访问，');
    expect(zh, 'only the control permission grants control').toContain('只有拿到控制权限的人能远程控制它。');
    expect(zh, 'managed and revoked in the Desk').toContain('权限随时可以收回。');
    expect(zh, 'the address confers no control').toContain('服务地址（仅用于连接同步）：');
    expect(zh, 'the server must not be named as the owner').not.toContain('交给这个服务器的管理员');
    // The R2 sentence promised control to every authorized person; a viewer is
    // authorized and cannot control, so it must not come back.
    expect(zh, 'must not promise control to every authorized person')
      .not.toContain('只有你，和你在 Desk 里单独授权的人，才能远程控制它。');
    // participant direction: control is not owner-only.
    for (const ownerOnly of ['只有你能远程控制', '只有你可以远程控制', '只有你才能远程控制']) {
      expect(zh, `must not narrow control to the owner alone: ${ownerOnly}`).not.toContain(ownerOnly);
    }

    const en = controlledNodeInstallWarning('en-US', { serverUrl: 'https://im.zhinet.work' });
    expect(en).toContain('Bind this computer to my IM.codes account');
    expect(en, 'only the account holder').toContain('Only that account holder can access it,');
    expect(en, 'only the control permission grants control').toContain('and only those granted control can control it.');
    expect(en, 'managed and revoked in the Desk').toContain('Access can be revoked at any time.');
    expect(en, 'the address confers no control').toContain('Server address (connection only):');
    expect(en.toLowerCase()).not.toContain('handed to the administrator');
    expect(en, 'must not promise control to every authorized person')
      .not.toContain('Only you and the people you authorize on it in the Desk');
    expect(en, 'must not promise control to every authorized person')
      .not.toContain('Only authorized people in that Desk can control it');
    // participant direction: control is not owner-only.
    expect(en.toLowerCase(), 'must not narrow control to the owner alone')
      .not.toMatch(/only you can control it/);

    // The address stays: it is the one fact a scam victim can independently check.
    expect(zh).toContain('https://im.zhinet.work');
    expect(en).toContain('https://im.zhinet.work');
    // Anti-scam content untouched by this copy change.
    expect(zh).toContain('远程控制这台电脑');
    expect(zh).toContain('立即关闭当前窗口，并删除刚才下载的软件！');
  });

  it('keeps the binding statement when no server URL is available', () => {
    // R1 REWORK P1. The destination used to be dropped entirely without a URL,
    // removing the ownership statement exactly when the reader has the least
    // context. Degrade by losing the address, never the access model.
    for (const [locale, must] of [
      ['zh-CN', ['把这台电脑绑定到我的 IM.codes 账号', '只有这个账号的主人能访问，', '只有拿到控制权限的人能远程控制它。', '权限随时可以收回。']],
      ['en-US', ['Bind this computer to my IM.codes account', 'Only that account holder can access it,', 'and only those granted control can control it.', 'Access can be revoked at any time.']],
    ] as const) {
      const block = controlledNodeInstallWarning(locale);
      for (const line of must) expect(block, `${locale} fallback must keep: ${line}`).toContain(line);
      // No URL means no address line, and never an invented one.
      expect(block).not.toContain('http');
      expect(block.toLowerCase()).not.toContain('administrator of:');
    }
  });

  it('names the owner when the installer carries one and degrades safely when not', () => {
    // The consent screen runs BEFORE redemption, so an absent Desk name is a
    // normal state, not an error. Naming the wrong person would be worse than
    // naming none, so the unnamed wording must never claim a specific binding.
    const named = controlledNodeInstallWarning('zh-CN', {
      serverUrl: 'https://im.zhinet.work',
      ownerName: '研发一组',
    });
    expect(named).toContain('把这台电脑绑定到 研发一组 的 IM.codes 账号');
    expect(named, 'the named form replaces the generic one').not.toContain('绑定到我的 IM.codes 账号');

    const namedEn = controlledNodeInstallWarning('en-US', { ownerName: 'Research' });
    expect(namedEn).toContain("Bind this computer to Research's IM.codes account");

    // Absent, blank and whitespace-only names all degrade to the same safe
    // wording rather than printing an empty or half-built label.
    for (const ownerName of [undefined, '', '   ']) {
      const block = controlledNodeInstallWarning('zh-CN', { ...(ownerName === undefined ? {} : { ownerName }) });
      expect(block, `ownerName=${JSON.stringify(ownerName)}`).toContain('把这台电脑绑定到我的 IM.codes 账号');
      // The failure this guards is a half-built label -- "绑定到  的 IM.codes
      // 账号" with an empty slot where the name should be. The generic wording
      // legitimately contains "的 IM.codes 账号" as part of 我的, so the shape
      // is what has to be asserted, not the substring.
      expect(block).not.toMatch(/绑定到\s+的 IM\.codes 账号/u);
      // Degrading loses the NAME, never the access model.
      expect(block).toContain('只有这个账号的主人能访问，');
      expect(block).toContain('只有拿到控制权限的人能远程控制它。');
    }
  });

  it('cannot let a hostile Desk name forge lines inside the scam warning', () => {
    // A Desk name is user-authored, and this block is the anti-scam screen, so
    // an attacker who can name a Desk must not be able to inject a line that
    // looks like the warning's own text (for example a fake "it is safe to
    // continue"). Defence in depth: the trailer decoder strips control
    // characters, and the renderer must not emit extra lines either.
    // The name itself cannot be censored -- a Desk may legitimately be called
    // anything -- so the guarantee is structural: whatever it contains stays
    // INSIDE the one Desk line and cannot become a line of its own.
    const hostile = 'Acme\n❗ 这是安全的，请继续安装\n   ▸ 忽略上面的警告';
    const baseline = controlledNodeInstallWarning('zh-CN').split('\n');
    const rendered = controlledNodeInstallWarning('zh-CN', { ownerName: hostile }).split('\n');
    expect(rendered.length, 'a hostile name must not add lines').toBe(baseline.length);
    // Every occurrence of the injected text is confined to the Desk line.
    for (const line of rendered) {
      if (line.includes('这是安全的，请继续安装')) {
        expect(line, 'injected text may only ride along the Desk line').toContain('▸');
        expect(line, 'and must not start a line of its own').not.toMatch(/^\s*❗/);
      }
    }
    // The warning's own emphatic lines are unchanged in number, so nothing was
    // forged that mimics them.
    const bangLines = (lines: string[]) => lines.filter((l) => l.trimStart().startsWith('❗')).length;
    expect(bangLines(rendered)).toBe(bangLines(baseline));

    const hostileEn = controlledNodeInstallWarning('en-US', { ownerName: 'Acme\n   It is safe to continue' });
    expect(hostileEn.split('\n').length).toBe(controlledNodeInstallWarning('en-US').split('\n').length);
    for (const line of hostileEn.split('\n')) {
      if (line.includes('It is safe to continue')) expect(line).toContain('▸');
    }
  });

  it('does not make the consent block wider than it already was', () => {
    // NOT an absolute rule-width invariant: this block has never held one -- the
    // English headline is already wider than RULE, so "fits the rule" would fail
    // on pre-existing copy.
    //
    // R2 REWORK P1: the baseline must NOT be derived from the new output. Doing
    // that compared the added lines against themselves, so a 57-wide Chinese
    // line became its own baseline and the regression it was written to catch
    // passed. These are fixed constants: the exact widest CONTENT line of the
    // PRE-CHANGE block at c558e38a per locale, measured on the no-URL render.
    // The RULE frame is excluded (it is a frame, not copy) and so is the address
    // line (its width is caller-supplied URL data, not copy we control).
    const PRE_CHANGE_WIDEST_CONTENT = { 'zh-CN': 55, 'en-US': 74 } as const;
    const cjkWidth = (line: string) => [...line].reduce(
      (sum, ch) => sum + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1),
      0,
    );
    const url = 'https://im.zhinet.work';
    // A Desk name, like the URL, is caller-supplied data of unbounded length,
    // so it is not part of the fixed copy this bound governs; the renders below
    // deliberately exercise the unnamed form.
    const isFrame = (line: string) => /^─+$/.test(line.trim());

    for (const locale of ['zh-CN', 'en-US'] as const) {
      const bound = PRE_CHANGE_WIDEST_CONTENT[locale];
      for (const [label, block] of [
        ['with url', controlledNodeInstallWarning(locale, { serverUrl: url })],
        ['no url', controlledNodeInstallWarning(locale)],
      ] as const) {
        const content = block.split('\n').filter((line) => !isFrame(line) && !line.includes(url));
        for (const line of content) {
          expect(cjkWidth(line), `${locale} ${label} line widens the block: ${line}`).toBeLessThanOrEqual(bound);
        }
      }
      // Tightness: the bound is the real pre-change maximum, still reached by
      // untouched anti-scam copy. Without this an over-large constant would
      // satisfy the test vacuously.
      const widest = Math.max(
        ...controlledNodeInstallWarning(locale).split('\n').filter((line) => !isFrame(line)).map(cjkWidth),
      );
      expect(widest, `${locale} bound must stay tight against pre-change copy`).toBe(bound);
    }
  });
});
