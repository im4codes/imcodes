/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import i18next from 'i18next';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ALL_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'ru'] as const;

const realI18n = i18next.createInstance();

const i18nHolder = vi.hoisted(() => ({
  t: (key: string, opts?: Record<string, unknown> | string): string => key,
  instance: null as any,
}));

const apiMocks = vi.hoisted(() => ({
  listSharesForTarget: vi.fn(),
  createShare: vi.fn(),
  updateShare: vi.fn(),
  revokeShare: vi.fn(),
  getMyServerPrivateDevicePolicy: vi.fn(),
  updateMyServerPrivateDevicePolicy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => i18nHolder.t(key, opts),
    i18n: i18nHolder.instance,
  }),
}));

vi.mock('../../src/components/RemoteDesktopOwnerAccess.js', () => ({
  RemoteDesktopOwnerAccess: () => <div data-testid="remote-desktop-owner-access">Remote Desktop Content</div>,
}));

vi.mock('../../src/api.js', () => ({
  listSharesForTarget: apiMocks.listSharesForTarget,
  createShare: apiMocks.createShare,
  updateShare: apiMocks.updateShare,
  revokeShare: apiMocks.revokeShare,
  getMyServerPrivateDevicePolicy: apiMocks.getMyServerPrivateDevicePolicy,
  updateMyServerPrivateDevicePolicy: apiMocks.updateMyServerPrivateDevicePolicy,
  ApiError: class ApiError extends Error {
    body?: string;
    constructor(body?: string) {
      super(body);
      this.body = body;
    }
  },
}));

import { ShareSessionDialog } from '../../src/components/ShareSessionDialog.js';
import { MachineGroupTabs } from '../../src/components/MachineGroupTabs.js';
import type { MachineListItem } from '../../src/api/machines.js';

i18nHolder.instance = realI18n;
i18nHolder.t = (key: string, opts?: Record<string, unknown> | string) =>
  typeof opts === 'string'
    ? realI18n.t(key, { defaultValue: opts })
    : realI18n.t(key, opts);

const loadLocale = (locale: string) =>
  JSON.parse(readFileSync(resolve(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, unknown>;

describe('ShareSessionDialog machine collaboration real-locale verification', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    apiMocks.listSharesForTarget.mockResolvedValue([]);
    apiMocks.getMyServerPrivateDevicePolicy.mockResolvedValue({ ok: true, serverId: 'srv-1', blockPrivateDevices: false });
    if (!realI18n.isInitialized) {
      await realI18n.init({
        resources: Object.fromEntries(ALL_LOCALES.map((loc) => [loc, { translation: loadLocale(loc) }])),
        lng: 'en',
        fallbackLng: 'en',
        interpolation: { escapeValue: false },
      });
    }
  });

  afterEach(async () => {
    cleanup();
    await realI18n.changeLanguage('en');
  });

  it.each([
    {
      lng: 'en',
      title: 'Device collaboration',
      subtitle: 'Invite collaborators to work together on Dev Machine Alpha.',
      sectionsLabel: 'Collaboration method',
      accountTab: 'Invite collaborators',
      remoteDesktopTab: 'Remote desktop invites',
      groupDirect: 'My devices & invitations',
      forbidden: ['Share controlled node', 'Sharing method', 'Account sharing'],
    },
    {
      lng: 'zh-CN',
      title: '设备协作',
      subtitle: '邀请协作者在 Dev Machine Alpha 上一起工作。',
      sectionsLabel: '协作方式',
      accountTab: '邀请协作者',
      remoteDesktopTab: '远程桌面邀请',
      groupDirect: '我的设备与受邀协作',
      forbidden: ['共享被控节点', '共享方式', '账号共享'],
    },
  ])(
    'renders device collaboration copy with real $lng locale in variant="machine" across tab switches and MachineGroupTabs',
    async ({ lng, title, subtitle, sectionsLabel, accountTab, remoteDesktopTab, groupDirect, forbidden }) => {
      await realI18n.changeLanguage(lng);

      const machineWithGroup = [{
        id: 'm-1',
        teamIds: ['team-1'],
        teamNames: ['Team Alpha'],
      }] as unknown as MachineListItem[];

      render(
        <div>
          <ShareSessionDialog
            variant="machine"
            fixedTarget={{ kind: 'server', serverId: 'srv-1' }}
            target={{
              serverId: 'srv-1',
              serverLabel: 'Dev Machine Alpha',
              sessionName: 'main-session',
              tabLabel: 'Dev Machine Alpha',
            }}
            remoteDesktopAccess={{ hostId: 'host-123', endpointLabel: 'Dev Machine Alpha' }}
            initialMachineSection="account"
            onClose={vi.fn()}
          />
          <MachineGroupTabs
            machines={machineWithGroup}
            group="direct"
            onSelect={vi.fn()}
            testIdPrefix="machine-group"
          />
        </div>,
      );

      const dialog = await screen.findByRole('dialog', { name: title });
      await waitFor(() => {
        expect(dialog.querySelector('.share-dialog-title')?.textContent).toBe(title);
      });
      expect(dialog.querySelector('.share-dialog-subtitle')?.textContent).toBe(subtitle);

      const tablist = screen.getByRole('tablist', { name: sectionsLabel });
      expect(tablist).toBeTruthy();

      const collabTabEl = screen.getByRole('tab', { name: accountTab });
      const rdpTabEl = screen.getByRole('tab', { name: remoteDesktopTab });
      expect(collabTabEl).toBeTruthy();
      expect(rdpTabEl).toBeTruthy();

      const groupTab = screen.getByTestId('machine-group-direct');
      expect(groupTab.textContent).toContain(groupDirect);

      const assertClean = () => {
        const fullText = `${dialog.textContent ?? ''}\n${tablist.getAttribute('aria-label') ?? ''}\n${groupTab.textContent ?? ''}`;
        for (const bad of forbidden) {
          expect(fullText).not.toContain(bad);
        }
      };

      assertClean();

      // Switch to Remote Desktop tab and back: title, tabs, and subtitle remain clean collaboration copy.
      fireEvent.click(rdpTabEl);
      expect(screen.getByTestId('remote-desktop-owner-access')).toBeTruthy();
      expect(dialog.querySelector('.share-dialog-title')?.textContent).toBe(title);
      assertClean();

      fireEvent.click(collabTabEl);
      expect(dialog.querySelector('.share-dialog-subtitle')?.textContent).toBe(subtitle);
      assertClean();
    },
  );

  it('keeps controlled_nodes collaboration keys, {{target}} placeholder, and non-account-sharing copy across all 7 locales', () => {
    const forbiddenAccountSharing = [
      'Account sharing',
      '账号共享',
      '帳號共享',
      'アカウント共有',
      '계정 공유',
      'Compartir con cuentas',
    ];

    for (const locale of ALL_LOCALES) {
      const json = loadLocale(locale) as {
        controlled_nodes?: {
          share?: {
            title?: unknown;
            subtitle?: unknown;
            sections_label?: unknown;
            account_tab?: unknown;
            remote_desktop_tab?: unknown;
          };
          group_direct?: unknown;
          team_section_hint?: unknown;
        };
      };

      const cn = json.controlled_nodes;
      expect(typeof cn?.share?.title, locale).toBe('string');
      expect(String(cn?.share?.title).trim(), locale).not.toBe('');
      expect(typeof cn?.share?.subtitle, locale).toBe('string');
      expect(String(cn?.share?.subtitle), locale).toContain('{{target}}');
      expect(typeof cn?.share?.sections_label, locale).toBe('string');
      expect(String(cn?.share?.sections_label).trim(), locale).not.toBe('');
      expect(typeof cn?.share?.account_tab, locale).toBe('string');
      expect(String(cn?.share?.account_tab).trim(), locale).not.toBe('');
      expect(typeof cn?.share?.remote_desktop_tab, locale).toBe('string');
      expect(String(cn?.share?.remote_desktop_tab).trim(), locale).not.toBe('');
      expect(typeof cn?.group_direct, locale).toBe('string');
      expect(String(cn?.group_direct).trim(), locale).not.toBe('');
      expect(typeof cn?.team_section_hint, locale).toBe('string');
      expect(String(cn?.team_section_hint).trim(), locale).not.toBe('');

      const values = [
        cn?.share?.title,
        cn?.share?.subtitle,
        cn?.share?.sections_label,
        cn?.share?.account_tab,
        cn?.group_direct,
        cn?.team_section_hint,
      ].map(String);

      for (const value of values) {
        for (const bad of forbiddenAccountSharing) {
          expect(value, `${locale}: ${value}`).not.toContain(bad);
        }
      }
    }
  });
});
