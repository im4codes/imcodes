import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AIDESK_PRODUCT_NAME } from '../../shared/aidesk-product.js';
import { REMOTE_DESKTOP_LOCAL_WORKER_MSG } from '../../shared/remote-desktop-local-management.js';

describe('aiDesk persistent local affordance', () => {
  it('binds native surfaces to the shared product name', async () => {
    const header = await readFile('native/remote-desktop-common/aidesk_product_name.h', 'utf8');
    expect(header).toContain(`"${AIDESK_PRODUCT_NAME}"`);
  });

  it('binds the service-owned pause frame across TypeScript and native workers', async () => {
    const header = await readFile('native/remote-desktop-common/local_management_types.h', 'utf8');
    expect(header).toContain(`"${REMOTE_DESKTOP_LOCAL_WORKER_MSG.ACCESS_STATE}"`);
  });
  it('keeps Windows visible at zero viewers and distinguishes idle/view/control colors', async () => {
    const source = await readFile('native/windows-remote-desktop/local_indicator.cc', 'utf8');
    const refresh = source.slice(source.indexOf('void LocalIndicator::RefreshWindow()'), source.indexOf('void LocalIndicator::AnchorToCorner'));
    expect(refresh).not.toContain('SW_HIDE');
    expect(refresh).toContain('SW_SHOWNOACTIVATE');
    expect(source).toContain('controllers > 0 ? RGB(244, 80, 112)');
    expect(source).toContain('viewers > 0 ? RGB(242, 169, 59)');
    expect(source).toContain('UpdateAccessPaused');
    expect(source).toContain('paused ? RGB(129, 139, 151)');
    expect(source).toContain('LocalIndicatorBadgeText');
    expect(source).toContain('kAutoCollapseTimer');
    expect(source.match(/SetTimer\(window, kAutoCollapseTimer,/gu)).toHaveLength(2);
    expect(source).toContain('SetCollapsed(false, true)');
    expect(source).toContain('LocalIndicatorEdge::kRight');
  });

  it('starts Linux with an idle edge corner and returns to it after sessions', async () => {
    const main = await readFile('native/linux-remote-desktop/linux_remote_desktop_worker_main.cc', 'utf8');
    const source = await readFile('native/linux-remote-desktop/linux_x11_backend.cc', 'utf8');
    expect(main).toContain('adapters->disclosure().Show(0, 0)');
    expect(source).toContain('kIdleDisclosureWidth = 54');
    expect(source).toContain('(void)Show(0, 0)');
    expect(source).toContain('kDisclosureViewingBackground');
    expect(source).toContain('kDisclosureIdleBackground');
    expect(source).toContain('SetAccessPaused');
    expect(source).toContain('access_paused_.load()');
    expect(source).toContain('LocalIndicatorBadgeText(viewers)');
    expect(source).toContain('collapse_deadline_ms_');
    expect(source).toContain('collapsed_ = !collapsed');
    expect(source).toContain('LocalIndicatorEdge::kRight');
  });

  it('keeps the signed macOS app in Dock and uses background launch without opening the panel', async () => {
    const app = await readFile('native/macos-remote-desktop/aidesk_agent_main.mm', 'utf8');
    const build = await readFile('scripts/build-aidesk-app.mjs', 'utf8');
    expect(app).toContain('NSApplicationActivationPolicyRegular');
    expect(app).toContain('--aidesk-background');
    expect(app).toContain('applicationShouldHandleReopen');
    expect(app).toContain('initWithString:@"■"');
    expect(app).toContain('HTTPShouldSetCookies = YES');
    expect(app).toContain('dockTile].badgeLabel');
    expect(app).toContain('LocalIndicatorBadgeText(viewers)');
    expect(build).not.toContain("['LSUIElement'");
  });

  it('keeps compact badges, cap and edge-direction arrows shared across platforms', async () => {
    const shared = await readFile(
      'native/remote-desktop-common/local_indicator_visuals.h', 'utf8',
    );
    const mac = await readFile(
      'native/macos-remote-desktop/macos_local_disclosure.mm', 'utf8',
    );
    expect(shared).toContain('kLocalIndicatorBadgeLimit = 9;');
    expect(shared).toContain('if (connections == 0) return {}');
    expect(shared).toContain('return "9+"');
    expect(shared).toContain("case LocalIndicatorEdge::kRight:\n      return '<'");
    expect(shared).toContain("case LocalIndicatorEdge::kLeft:\n      return '>'");
    expect(shared).toContain("case LocalIndicatorEdge::kTop:\n      return 'v'");
    expect(shared).toContain("case LocalIndicatorEdge::kBottom:\n      return '^'");
    expect(mac).toContain('LocalIndicatorBadgeText(self.viewers)');
    expect(mac).toContain('scheduleAutoCollapse');
    expect(mac).toContain('[controller_ scheduleAutoCollapse]');
    expect(mac).toContain('[owner scheduleAutoCollapse]');
    expect(mac).toContain('[owner applyCollapsed:NO persist:YES]');
    // The compact view reserves disjoint x-ranges for the chevron and bubble.
    expect(mac).toContain('NSMakeRect(4.0, 7.0, 18.0, 24.0)');
    expect(mac).toContain('NSMakeRect(25.0, 7.0, 25.0, 24.0)');
  });
});
