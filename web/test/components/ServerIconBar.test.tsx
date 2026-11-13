/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';

vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key);
  const translation = { t };
  return { useTranslation: () => translation };
});

import { ServerIconBar } from '../../src/components/ServerIconBar.js';

afterEach(cleanup);

const NOW = Date.now();
const server = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, status: 'online', lastHeartbeatAt: NOW, createdAt: NOW, ...extra });
const NAMES = ['vm-124', 'vm-125', 'vm-126', 'mini-2', 'pro.koca.win', '山东老孙', '投屏电视', 'mac-studio-pro', 'mac-mini-pro', 'Prod'];

const labelOf = (button: Element) => [...button.querySelectorAll('.server-icon-line')].map((line) => line.textContent).join('/');

describe('ServerIconBar labels', () => {
  it('shows every server with its own readable label, not a single letter', () => {
    const { container } = render(
      <ServerIconBar servers={NAMES.map((name, i) => server(`s${i}`, name))} activeServerId="s1" onSelectServer={() => {}} />,
    );
    const buttons = NAMES.map((name) => container.querySelector(`button[aria-label="${name}"]`)!);
    const labels = buttons.map(labelOf);
    expect(labels).toEqual(['VM/124', 'VM/125', 'VM/126', 'MINI/2', 'PRO/WIN', '山东/老孙', '投屏/电视', 'MAC/STUDI', 'MAC/MINI', 'PROD']);
    expect(new Set(labels).size).toBe(NAMES.length);
  });

  it('keeps the name as tooltip and aria-label, and the label itself is not read out twice', () => {
    const { container } = render(<ServerIconBar servers={[server('a', 'vm-124')]} activeServerId="a" onSelectServer={() => {}} />);
    const button = container.querySelector('button[aria-label="vm-124"]') as HTMLButtonElement;
    expect(button.getAttribute('title')).toBe('vm-124');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.querySelector('.server-icon-letter')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks only canonical pinned servers with a compact pin', () => {
    const { container } = render(
      <ServerIconBar
        servers={[server('a', 'vm-124'), server('b', 'vm-125')]}
        activeServerId={null}
        pinnedServerIds={new Set(['a'])}
        onSelectServer={() => {}}
      />,
    );
    expect(container.querySelector('button[aria-label=\"vm-124\"] .server-icon-pin')?.textContent).toBe('📌');
    expect(container.querySelector('button[aria-label=\"vm-125\"] .server-icon-pin')).toBeNull();
  });

  it('keeps the status dot, the upgrade arrow, selection and the context menu working', () => {
    const onSelect = vi.fn();
    const onMenu = vi.fn();
    const { container } = render(
      <ServerIconBar
        servers={[
          server('a', 'vm-124', { daemonVersion: '1.0.0', latestDaemonVersion: '2.0.0' }),
          server('b', 'vm-125', { status: 'offline', lastHeartbeatAt: null }),
        ]}
        activeServerId={null}
        onSelectServer={onSelect}
        onServerContextMenu={onMenu}
      />,
    );
    const a = container.querySelector('button[aria-label="vm-124"]') as HTMLButtonElement;
    const b = container.querySelector('button[aria-label="vm-125"]') as HTMLButtonElement;
    expect(a.querySelector('.server-icon-upgrade')).not.toBeNull();
    expect(b.querySelector('.server-icon-upgrade')).toBeNull();
    expect((a.querySelector('.server-icon-dot') as HTMLElement).style.background).toContain('74, 222, 128');
    expect((b.querySelector('.server-icon-dot') as HTMLElement).style.background).not.toContain('74, 222, 128');
    fireEvent.click(b);
    expect(onSelect).toHaveBeenCalledWith('b', 'vm-125');
    fireEvent.contextMenu(a, { clientX: 5, clientY: 6 });
    expect(onMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 5, 6);
  });

  it('follows a rename and a new server: only the labels that must change do', () => {
    const view = render(<ServerIconBar servers={[server('a', 'vm-124'), server('b', 'dev')]} activeServerId="a" onSelectServer={() => {}} />);
    const labels = () => [...view.container.querySelectorAll('.server-icon-server')].map(labelOf);
    expect(labels()).toEqual(['VM/124', 'DEV']);
    view.rerender(<ServerIconBar servers={[server('a', 'vm-124'), server('b', 'dev-box')]} activeServerId="a" onSelectServer={() => {}} />);
    expect(labels()).toEqual(['VM/124', 'DEV/BOX']);
    // A same-named server appears: the two are told apart by an index.
    view.rerender(<ServerIconBar servers={[server('a', 'vm-124'), server('b', 'dev-box'), server('c', 'dev-box')]} activeServerId="a" onSelectServer={() => {}} />);
    const out = labels();
    expect(new Set(out).size).toBe(3);
    expect(out[1]).toContain('#');
    expect(out[2]).toContain('#');
  });

  it('copes with a server without a name', () => {
    const { container } = render(<ServerIconBar servers={[server('a', '')]} activeServerId={null} onSelectServer={() => {}} />);
    expect(labelOf(container.querySelector('.server-icon-server')!)).toBe('?');
  });

  it('renders enabled speaker badge vs muted ban badge and excludes shared-in servers', () => {
    const onMenu = vi.fn();
    const { container } = render(
      <ServerIconBar
        servers={[
          server('a', 'vm-enabled'),
          server('b', 'vm-muted'),
          server('c', 'vm-shared', { isSharedIn: true }),
        ]}
        activeServerId="a"
        pushEnabledServerIds={new Set(['a', 'c'])}
        onSelectServer={() => {}}
        onServerContextMenu={onMenu}
      />,
    );
    const btnA = container.querySelector('button[aria-label="vm-enabled"]') as HTMLButtonElement;
    const btnB = container.querySelector('button[aria-label="vm-muted"]') as HTMLButtonElement;
    const btnC = container.querySelector('button[aria-label="vm-shared"]') as HTMLButtonElement;

    const badgeA = btnA.querySelector('.server-icon-push-badge');
    const badgeB = btnB.querySelector('.server-icon-push-badge');
    const badgeC = btnC.querySelector('.server-icon-push-badge');

    expect(badgeA?.classList.contains('is-enabled')).toBe(true);
    expect(badgeA?.getAttribute('data-push-state')).toBe('enabled');
    expect(badgeB?.classList.contains('is-muted')).toBe(true);
    expect(badgeB?.getAttribute('data-push-state')).toBe('muted');
    expect(badgeC).toBeNull();

    // Right-click on shared-in server must not invoke context menu
    fireEvent.contextMenu(btnC, { clientX: 10, clientY: 20 });
    expect(onMenu).not.toHaveBeenCalled();
  });
});
