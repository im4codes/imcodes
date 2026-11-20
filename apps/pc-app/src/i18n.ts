import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PC_APP_LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'] as const;
export type PcAppLocale = (typeof PC_APP_LOCALES)[number];

/** Cookie mirrored by the IM.codes web app on active language init and switch. */
export const PC_APP_LOCALE_COOKIE = 'imcodes_lang';

const TRADITIONAL_ZH_REGIONS = new Set(['tw', 'hk', 'mo']);

/**
 * Normalize a BCP-47 language tag (or raw preference) to one of the 7 IM.codes locales.
 * Never throws; defaults to `'en'` for unknown, empty, or malformed values.
 */
export function normalizePcAppLocale(raw?: string | null): PcAppLocale {
  if (typeof raw !== 'string') return 'en';
  const parts = raw.trim().toLowerCase().replace(/_/gu, '-').split('-').filter(Boolean);
  const primary = parts[0];
  if (!primary) return 'en';
  switch (primary) {
    case 'en':
      return 'en';
    case 'es':
      return 'es';
    case 'ru':
      return 'ru';
    case 'ja':
      return 'ja';
    case 'ko':
      return 'ko';
    case 'zh': {
      const subtags = parts.slice(1);
      if (subtags.includes('hant')) return 'zh-TW';
      if (subtags.includes('hans')) return 'zh-CN';
      for (const sub of subtags) {
        if (TRADITIONAL_ZH_REGIONS.has(sub)) return 'zh-TW';
      }
      return 'zh-CN';
    }
    default:
      return 'en';
  }
}

/**
 * Safely decode and normalize a raw `imcodes_lang` cookie value.
 * Returns `null` when empty or URI-malformed so callers keep their active locale.
 */
export function parseLocaleCookieValue(raw?: string | null): PcAppLocale | null {
  if (typeof raw !== 'string') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  if (!decoded) return null;
  return normalizePcAppLocale(decoded);
}

/**
 * Atomic file-backed persistence for the PC App's active UI locale inside `userDataDir`.
 * Fails soft on corrupt files or read-only storage.
 */
export class PcAppLocaleStore {
  private readonly filePath: string;

  constructor(userDataDir: string, fileName = 'locale.json') {
    this.filePath = path.join(userDataDir, fileName);
  }

  load(): PcAppLocale | null {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown; locale?: unknown } | null;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
        return null;
      }
      if (typeof parsed.locale !== 'string') return null;
      return (PC_APP_LOCALES as readonly string[]).includes(parsed.locale)
        ? (parsed.locale as PcAppLocale)
        : null;
    } catch {
      return null;
    }
  }

  save(locale: PcAppLocale): void {
    const dir = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        tmpPath,
        JSON.stringify({ version: 1, locale }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      );
      renameSync(tmpPath, this.filePath);
    } catch {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Fail soft when userDataDir is unwritable.
      }
    }
  }
}

const EN_MESSAGES = {
  'menu.app.about': 'About {{appName}}',
  'menu.app.settings': 'Settings…',
  'menu.app.services': 'Services',
  'menu.app.hide': 'Hide {{appName}}',
  'menu.app.hideOthers': 'Hide Others',
  'menu.app.showAll': 'Show All',
  'menu.app.quit': 'Quit {{appName}}',
  'menu.edit.label': 'Edit',
  'menu.edit.undo': 'Undo',
  'menu.edit.redo': 'Redo',
  'menu.edit.cut': 'Cut',
  'menu.edit.copy': 'Copy',
  'menu.edit.paste': 'Paste',
  'menu.edit.selectAll': 'Select All',
  'menu.view.label': 'View',
  'menu.view.reload': 'Reload',
  'menu.view.forceReload': 'Force Reload',
  'menu.view.devTools': 'Toggle Developer Tools',
  'menu.view.resetZoom': 'Actual Size',
  'menu.view.zoomIn': 'Zoom In',
  'menu.view.zoomOut': 'Zoom Out',
  'menu.view.toggleFullScreen': 'Toggle Full Screen',
  'menu.server.label': 'Server',
  'menu.server.none': 'No servers saved',
  'menu.server.switch': 'Switch Server…',
  'menu.server.add': 'Add Server…',
  'menu.server.remove': 'Remove Server',
  'menu.server.rebind': 'Rebind Machine ({{serverName}} · {{workerUrl}})…',
  'menu.server.bind': 'Bind This Machine…',
  'menu.server.clearSession': 'Clear Current Server Session',
  'menu.window.label': 'Window',
  'menu.window.minimize': 'Minimize',
  'menu.window.zoom': 'Zoom',
  'menu.window.front': 'Bring All to Front',
  'menu.window.close': 'Close',
  'menu.help.label': 'Help',
  'menu.help.docs': 'IM.codes Documentation',

  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.remove': 'Remove',

  'dialog.removeServer.title': 'Remove Server',
  'dialog.removeServer.message': 'Remove {{origin}} from saved servers?',

  'bind.manual.noOrigin.title': 'Bind This Machine',
  'bind.manual.noOrigin.message': 'Select a saved server before binding this machine.',
  'bind.manual.noCookies.title': 'Bind This Machine',
  'bind.manual.noCookies.message': 'Browser session cookies are unavailable in this window.',
  'bind.manual.signIn.title': 'Sign In Required',
  'bind.manual.signIn.message': 'Sign in to {{origin}} first to bind this machine.',
  'bind.replace.title': 'Replace Existing Server Binding?',
  'bind.replace.message': 'This machine is already bound to an IM.codes server.',
  'bind.replace.detail':
    'Currently bound to:\n  {{serverName}} · {{workerUrl}}\n\nSigned in to:\n  {{targetOrigin}}\n\nKeep existing does nothing. Choose Replace to bind this machine to the current server.',
  'bind.replace.keep': 'Keep Existing',
  'bind.replace.replace': 'Replace',
  'bind.success.title': 'IM.codes Machine Bound',
  'bind.success.body': 'Bound to {{serverName}}. Background service installed and will auto-start on login.',
  'bind.failure.uncertainTitle': 'Machine Bind Status Uncertain',
  'bind.failure.mintUnknownMessage': 'Could not confirm whether a new API key was created on the server.',
  'bind.failure.mintUnknownCheck': 'Please check your API keys in the {{origin}} web dashboard before retrying.',
  'bind.failure.cliUncertainMessage': 'The bind command did not finish cleanly; the minted API key was kept for safety.',
  'bind.failure.cliUncertainCheck': 'Please check {{origin}} to verify whether this machine appears online or revoke unused keys.',
  'bind.failure.failedTitle': 'Machine Bind Failed',
  'bind.failure.mintRejectedMessage': 'Server refused to create a bind key ({{error}}).',
  'bind.failure.cliFailedMessage': 'Failed to bind this machine via imcodes CLI.',
  'bind.failure.manualCommand': 'Manual command:\n  {{command}}',
  'bind.failure.manualFallback': 'Retry via Server -> Bind This Machine or run:\n  imcodes bind {{origin}}/bind/<api-key> {{host}}',

  'launchAgent.unreadable.title': 'Daemon LaunchAgent Unreadable',
  'launchAgent.unreadable.message': 'Existing macOS LaunchAgent configuration could not be read.',
  'launchAgent.unreadable.detail': 'Inspect {{plistPath}} or choose Rebind Now from the Server menu to regenerate it.',
  'launchAgent.missing.title': 'Daemon Startup Configuration Needs Rebind',
  'launchAgent.missing.bothMessage':
    'Background daemon cannot start and cannot find bundled tmux because paths in the LaunchAgent no longer exist.',
  'launchAgent.missing.progMessage':
    'Background daemon cannot start because the ProgramArguments target in LaunchAgent no longer exists.',
  'launchAgent.missing.tmuxMessage':
    'Background daemon cannot find bundled tmux because the bundled PATH entry in LaunchAgent no longer exists.',
  'launchAgent.missing.programsDetail': 'Missing daemon program path(s):\n  {{paths}}',
  'launchAgent.missing.tmuxDetail': 'Missing bundled tmux PATH entry:\n  {{paths}}',
  'launchAgent.missing.footerDetail':
    'This typically happens after moving or uninstalling IM.codes.app. Choose Rebind Now to update the LaunchAgent safely.',
  'launchAgent.prompt.fallbackTitle': 'Daemon Startup Check',
  'launchAgent.prompt.fallbackMessage': 'LaunchAgent configuration needs attention.',
  'launchAgent.prompt.later': 'Later',
  'launchAgent.prompt.rebindNow': 'Rebind Now',

  'welcome.subtitle': 'Select or add an IM.codes server',
  'welcome.defaultBadge': 'Default',
  'welcome.detectedBadge': 'Detected locally',
  'welcome.addHeading': 'Add Server',
  'welcome.labelPlaceholder': 'Display name (optional)',
  'welcome.connect': 'Connect',
  'welcome.remove': 'Remove',

  'prompt.windowTitle': 'Add Server',
  'prompt.heading': 'Add IM.codes Server',
  'prompt.urlLabel': 'Server URL (https:// or http://localhost)',
  'prompt.labelLabel': 'Display Name (optional)',
  'prompt.labelPlaceholder': 'Production',
  'prompt.submit': 'Add Server',
} as const;

export type PcAppMessageKey = keyof typeof EN_MESSAGES;
export type PcAppMessageTable = Record<PcAppMessageKey, string>;

export const PC_APP_MESSAGES: Record<PcAppLocale, PcAppMessageTable> = {
  en: EN_MESSAGES,
  'zh-CN': {
    'menu.app.about': '关于 {{appName}}',
    'menu.app.settings': '设置…',
    'menu.app.services': '服务',
    'menu.app.hide': '隐藏 {{appName}}',
    'menu.app.hideOthers': '隐藏其他',
    'menu.app.showAll': '全部显示',
    'menu.app.quit': '退出 {{appName}}',
    'menu.edit.label': '编辑',
    'menu.edit.undo': '撤销',
    'menu.edit.redo': '重做',
    'menu.edit.cut': '剪切',
    'menu.edit.copy': '拷贝',
    'menu.edit.paste': '粘贴',
    'menu.edit.selectAll': '全选',
    'menu.view.label': '视图',
    'menu.view.reload': '重新加载',
    'menu.view.forceReload': '强制重新加载',
    'menu.view.devTools': '切换开发者工具',
    'menu.view.resetZoom': '实际大小',
    'menu.view.zoomIn': '放大',
    'menu.view.zoomOut': '缩小',
    'menu.view.toggleFullScreen': '进入全屏幕',
    'menu.server.label': '服务器',
    'menu.server.none': '未保存服务器',
    'menu.server.switch': '切换服务器…',
    'menu.server.add': '添加服务器…',
    'menu.server.remove': '移除服务器',
    'menu.server.rebind': '重新绑定本机 ({{serverName}} · {{workerUrl}})…',
    'menu.server.bind': '绑定本机…',
    'menu.server.clearSession': '清除当前服务器会话',
    'menu.window.label': '窗口',
    'menu.window.minimize': '最小化',
    'menu.window.zoom': '缩放',
    'menu.window.front': '前置全部窗口',
    'menu.window.close': '关闭',
    'menu.help.label': '帮助',
    'menu.help.docs': 'IM.codes 文档',

    'common.ok': '好',
    'common.cancel': '取消',
    'common.remove': '移除',

    'dialog.removeServer.title': '移除服务器',
    'dialog.removeServer.message': '确定从已保存服务器中移除 {{origin}} 吗？',

    'bind.manual.noOrigin.title': '绑定本机',
    'bind.manual.noOrigin.message': '请先选择一个已保存的服务器，然后再绑定本机。',
    'bind.manual.noCookies.title': '绑定本机',
    'bind.manual.noCookies.message': '当前窗口的浏览器会话 Cookie 不可用。',
    'bind.manual.signIn.title': '需要登录',
    'bind.manual.signIn.message': '请先登录 {{origin}}，然后再绑定本机。',
    'bind.replace.title': '替换现有服务器绑定？',
    'bind.replace.message': '此设备已绑定到一个 IM.codes 服务器。',
    'bind.replace.detail':
      '当前已绑定到：\n  {{serverName}} · {{workerUrl}}\n\n当前登录的服务器：\n  {{targetOrigin}}\n\n选择“保留现有”将不做更改；选择“替换”会将此设备绑定到当前服务器。',
    'bind.replace.keep': '保留现有',
    'bind.replace.replace': '替换',
    'bind.success.title': 'IM.codes 本机已绑定',
    'bind.success.body': '已绑定到 {{serverName}}。后台服务已安装，将在登录时自动启动。',
    'bind.failure.uncertainTitle': '本机绑定状态不确定',
    'bind.failure.mintUnknownMessage': '无法确认服务端是否已创建新的 API Key。',
    'bind.failure.mintUnknownCheck': '重试前请在 {{origin}} 网页控制台检查您的 API Key。',
    'bind.failure.cliUncertainMessage': '绑定命令未正常完成；为安全起见已保留刚创建的 API Key。',
    'bind.failure.cliUncertainCheck': '请在 {{origin}} 检查此设备是否已上线，或吊销未使用的 API Key。',
    'bind.failure.failedTitle': '本机绑定失败',
    'bind.failure.mintRejectedMessage': '服务器拒绝创建绑定密钥 ({{error}})。',
    'bind.failure.cliFailedMessage': '通过 imcodes CLI 绑定本机失败。',
    'bind.failure.manualCommand': '手动命令：\n  {{command}}',
    'bind.failure.manualFallback': '请通过“服务器 -> 绑定本机”重试，或运行：\n  imcodes bind {{origin}}/bind/<api-key> {{host}}',

    'launchAgent.unreadable.title': '守护进程 LaunchAgent 无法读取',
    'launchAgent.unreadable.message': '无法读取现有的 macOS LaunchAgent 配置。',
    'launchAgent.unreadable.detail': '请检查 {{plistPath}}，或在“服务器”菜单中选择“立即重新绑定”以重新生成。',
    'launchAgent.missing.title': '守护进程启动配置需要重新绑定',
    'launchAgent.missing.bothMessage': 'LaunchAgent 中的路径已失效，后台守护进程无法启动且找不到内置 tmux。',
    'launchAgent.missing.progMessage': 'LaunchAgent 中的 ProgramArguments 目标路径已失效，后台守护进程无法启动。',
    'launchAgent.missing.tmuxMessage': 'LaunchAgent 中的内置 PATH 路径已失效，后台守护进程找不到内置 tmux。',
    'launchAgent.missing.programsDetail': '缺失的守护进程路径：\n  {{paths}}',
    'launchAgent.missing.tmuxDetail': '缺失的内置 tmux PATH 目录：\n  {{paths}}',
    'launchAgent.missing.footerDetail': '这通常发生在移动或卸载 IM.codes.app 之后。选择“立即重新绑定”可安全更新 LaunchAgent。',
    'launchAgent.prompt.fallbackTitle': '守护进程启动检查',
    'launchAgent.prompt.fallbackMessage': 'LaunchAgent 配置需要处理。',
    'launchAgent.prompt.later': '稍后',
    'launchAgent.prompt.rebindNow': '立即重新绑定',

    'welcome.subtitle': '选择或添加 IM.codes 服务器',
    'welcome.defaultBadge': '官方默认',
    'welcome.detectedBadge': '本机已绑定',
    'welcome.addHeading': '添加服务器',
    'welcome.labelPlaceholder': '显示名称（可选）',
    'welcome.connect': '连接',
    'welcome.remove': '移除',

    'prompt.windowTitle': '添加服务器',
    'prompt.heading': '添加 IM.codes 服务器',
    'prompt.urlLabel': '服务器地址（https:// 或 http://localhost）',
    'prompt.labelLabel': '显示名称（可选）',
    'prompt.labelPlaceholder': '生产环境',
    'prompt.submit': '添加服务器',
  },
  'zh-TW': {
    'menu.app.about': '關於 {{appName}}',
    'menu.app.settings': '設定…',
    'menu.app.services': '服務',
    'menu.app.hide': '隱藏 {{appName}}',
    'menu.app.hideOthers': '隱藏其他',
    'menu.app.showAll': '顯示全部',
    'menu.app.quit': '結束 {{appName}}',
    'menu.edit.label': '編輯',
    'menu.edit.undo': '還原',
    'menu.edit.redo': '重做',
    'menu.edit.cut': '剪下',
    'menu.edit.copy': '拷貝',
    'menu.edit.paste': '貼上',
    'menu.edit.selectAll': '全選',
    'menu.view.label': '顯示方式',
    'menu.view.reload': '重新載入',
    'menu.view.forceReload': '強制重新載入',
    'menu.view.devTools': '切換開發者工具',
    'menu.view.resetZoom': '實際大小',
    'menu.view.zoomIn': '放大',
    'menu.view.zoomOut': '縮小',
    'menu.view.toggleFullScreen': '進入全螢幕',
    'menu.server.label': '伺服器',
    'menu.server.none': '未儲存伺服器',
    'menu.server.switch': '切換伺服器…',
    'menu.server.add': '新增伺服器…',
    'menu.server.remove': '移除伺服器',
    'menu.server.rebind': '重新綁定本機 ({{serverName}} · {{workerUrl}})…',
    'menu.server.bind': '綁定本機…',
    'menu.server.clearSession': '清除目前伺服器工作階段',
    'menu.window.label': '視窗',
    'menu.window.minimize': '縮到最小',
    'menu.window.zoom': '縮放',
    'menu.window.front': '將全部視窗移至最前',
    'menu.window.close': '關閉',
    'menu.help.label': '輔助說明',
    'menu.help.docs': 'IM.codes 文件',

    'common.ok': '好',
    'common.cancel': '取消',
    'common.remove': '移除',

    'dialog.removeServer.title': '移除伺服器',
    'dialog.removeServer.message': '確定要從已儲存的伺服器中移除 {{origin}} 嗎？',

    'bind.manual.noOrigin.title': '綁定本機',
    'bind.manual.noOrigin.message': '請先選擇一個已儲存的伺服器，再綁定本機。',
    'bind.manual.noCookies.title': '綁定本機',
    'bind.manual.noCookies.message': '目前視窗無法存取瀏覽器工作階段 Cookie。',
    'bind.manual.signIn.title': '需要登入',
    'bind.manual.signIn.message': '請先登入 {{origin}}，再綁定本機。',
    'bind.replace.title': '取代現有伺服器綁定？',
    'bind.replace.message': '此裝置已綁定到 IM.codes 伺服器。',
    'bind.replace.detail':
      '目前綁定於：\n  {{serverName}} · {{workerUrl}}\n\n目前登入的伺服器：\n  {{targetOrigin}}\n\n選擇「保留現有」將不作變更；選擇「取代」會將此裝置綁定至目前伺服器。',
    'bind.replace.keep': '保留現有',
    'bind.replace.replace': '取代',
    'bind.success.title': 'IM.codes 本機已綁定',
    'bind.success.body': '已綁定至 {{serverName}}。背景服務已安裝，將於登入時自動啟動。',
    'bind.failure.uncertainTitle': '本機綁定狀態不確定',
    'bind.failure.mintUnknownMessage': '無法確認伺服器是否已建立新的 API Key。',
    'bind.failure.mintUnknownCheck': '重試前請先至 {{origin}} 網頁主控台確認您的 API Key。',
    'bind.failure.cliUncertainMessage': '綁定命令未完整結束；為確保安全，已保留建立的 API Key。',
    'bind.failure.cliUncertainCheck': '請至 {{origin}} 確認此裝置是否已上線，或撤銷未使用的金鑰。',
    'bind.failure.failedTitle': '本機綁定失敗',
    'bind.failure.mintRejectedMessage': '伺服器拒絕建立綁定金鑰 ({{error}})。',
    'bind.failure.cliFailedMessage': '無法透過 imcodes CLI 綁定本機。',
    'bind.failure.manualCommand': '手動命令：\n  {{command}}',
    'bind.failure.manualFallback': '請透過「伺服器 -> 綁定本機」重試，或執行：\n  imcodes bind {{origin}}/bind/<api-key> {{host}}',

    'launchAgent.unreadable.title': '無法讀取背景服務 LaunchAgent',
    'launchAgent.unreadable.message': '無法讀取現有的 macOS LaunchAgent 設定。',
    'launchAgent.unreadable.detail': '請檢查 {{plistPath}}，或從「伺服器」選單選擇「立即重新綁定」以重新產生。',
    'launchAgent.missing.title': '背景服務啟動設定需要重新綁定',
    'launchAgent.missing.bothMessage': 'LaunchAgent 中的路徑已失效，背景服務無法啟動且找不到內建 tmux。',
    'launchAgent.missing.progMessage': 'LaunchAgent 中的 ProgramArguments 目標路徑已失效，背景服務無法啟動。',
    'launchAgent.missing.tmuxMessage': 'LaunchAgent 中的內建 PATH 路徑已失效，背景服務找不到內建 tmux。',
    'launchAgent.missing.programsDetail': '遺失的背景服務程式路徑：\n  {{paths}}',
    'launchAgent.missing.tmuxDetail': '遺失的內建 tmux PATH 目錄：\n  {{paths}}',
    'launchAgent.missing.footerDetail': '這通常發生在移動或解除安裝 IM.codes.app 後。選擇「立即重新綁定」可安全更新 LaunchAgent。',
    'launchAgent.prompt.fallbackTitle': '背景服務啟動檢查',
    'launchAgent.prompt.fallbackMessage': 'LaunchAgent 設定需要處理。',
    'launchAgent.prompt.later': '稍後',
    'launchAgent.prompt.rebindNow': '立即重新綁定',

    'welcome.subtitle': '選擇或新增 IM.codes 伺服器',
    'welcome.defaultBadge': '官方預設',
    'welcome.detectedBadge': '本機已綁定',
    'welcome.addHeading': '新增伺服器',
    'welcome.labelPlaceholder': '顯示名稱（選填）',
    'welcome.connect': '連接',
    'welcome.remove': '移除',

    'prompt.windowTitle': '新增伺服器',
    'prompt.heading': '新增 IM.codes 伺服器',
    'prompt.urlLabel': '伺服器網址（https:// 或 http://localhost）',
    'prompt.labelLabel': '顯示名稱（選填）',
    'prompt.labelPlaceholder': '正式環境',
    'prompt.submit': '新增伺服器',
  },
  es: {
    'menu.app.about': 'Acerca de {{appName}}',
    'menu.app.settings': 'Configuración…',
    'menu.app.services': 'Servicios',
    'menu.app.hide': 'Ocultar {{appName}}',
    'menu.app.hideOthers': 'Ocultar otros',
    'menu.app.showAll': 'Mostrar todo',
    'menu.app.quit': 'Salir de {{appName}}',
    'menu.edit.label': 'Editar',
    'menu.edit.undo': 'Deshacer',
    'menu.edit.redo': 'Rehacer',
    'menu.edit.cut': 'Cortar',
    'menu.edit.copy': 'Copiar',
    'menu.edit.paste': 'Pegar',
    'menu.edit.selectAll': 'Seleccionar todo',
    'menu.view.label': 'Ver',
    'menu.view.reload': 'Recargar',
    'menu.view.forceReload': 'Forzar recarga',
    'menu.view.devTools': 'Alternar herramientas de desarrollo',
    'menu.view.resetZoom': 'Tamaño real',
    'menu.view.zoomIn': 'Acercar',
    'menu.view.zoomOut': 'Alejar',
    'menu.view.toggleFullScreen': 'Pantalla completa',
    'menu.server.label': 'Servidor',
    'menu.server.none': 'No hay servidores guardados',
    'menu.server.switch': 'Cambiar servidor…',
    'menu.server.add': 'Agregar servidor…',
    'menu.server.remove': 'Eliminar servidor',
    'menu.server.rebind': 'Volver a vincular equipo ({{serverName}} · {{workerUrl}})…',
    'menu.server.bind': 'Vincular este equipo…',
    'menu.server.clearSession': 'Borrar sesión del servidor actual',
    'menu.window.label': 'Ventana',
    'menu.window.minimize': 'Minimizar',
    'menu.window.zoom': 'Zoom',
    'menu.window.front': 'Traer todo al frente',
    'menu.window.close': 'Cerrar',
    'menu.help.label': 'Ayuda',
    'menu.help.docs': 'Documentación de IM.codes',

    'common.ok': 'Aceptar',
    'common.cancel': 'Cancelar',
    'common.remove': 'Eliminar',

    'dialog.removeServer.title': 'Eliminar servidor',
    'dialog.removeServer.message': '¿Eliminar {{origin}} de los servidores guardados?',

    'bind.manual.noOrigin.title': 'Vincular este equipo',
    'bind.manual.noOrigin.message': 'Selecciona un servidor guardado antes de vincular este equipo.',
    'bind.manual.noCookies.title': 'Vincular este equipo',
    'bind.manual.noCookies.message': 'Las cookies de sesión del navegador no están disponibles en esta ventana.',
    'bind.manual.signIn.title': 'Inicio de sesión requerido',
    'bind.manual.signIn.message': 'Inicia sesión en {{origin}} primero para vincular este equipo.',
    'bind.replace.title': '¿Reemplazar la vinculación existente?',
    'bind.replace.message': 'Este equipo ya está vinculado a un servidor de IM.codes.',
    'bind.replace.detail':
      'Vinculado actualmente a:\n  {{serverName}} · {{workerUrl}}\n\nSesión iniciada en:\n  {{targetOrigin}}\n\nMantener actual no realiza cambios. Elige Reemplazar para vincular este equipo al servidor actual.',
    'bind.replace.keep': 'Mantener actual',
    'bind.replace.replace': 'Reemplazar',
    'bind.success.title': 'Equipo vinculado a IM.codes',
    'bind.success.body': 'Vinculado a {{serverName}}. El servicio en segundo plano se instaló y se iniciará al iniciar sesión.',
    'bind.failure.uncertainTitle': 'Estado de vinculación incierto',
    'bind.failure.mintUnknownMessage': 'No se pudo confirmar si se creó una nueva clave API en el servidor.',
    'bind.failure.mintUnknownCheck': 'Revisa tus claves API en el panel web de {{origin}} antes de volver a intentarlo.',
    'bind.failure.cliUncertainMessage': 'El comando de vinculación no finalizó limpiamente; la clave API creada se conservó por seguridad.',
    'bind.failure.cliUncertainCheck': 'Revisa {{origin}} para comprobar si este equipo aparece en línea o revoca claves sin usar.',
    'bind.failure.failedTitle': 'Error al vincular el equipo',
    'bind.failure.mintRejectedMessage': 'El servidor rechazó crear una clave de vinculación ({{error}}).',
    'bind.failure.cliFailedMessage': 'No se pudo vincular este equipo mediante imcodes CLI.',
    'bind.failure.manualCommand': 'Comando manual:\n  {{command}}',
    'bind.failure.manualFallback': 'Reintenta desde Servidor -> Vincular este equipo o ejecuta:\n  imcodes bind {{origin}}/bind/<api-key> {{host}}',

    'launchAgent.unreadable.title': 'LaunchAgent del demonio ilegible',
    'launchAgent.unreadable.message': 'No se pudo leer la configuración existente de LaunchAgent en macOS.',
    'launchAgent.unreadable.detail': 'Inspecciona {{plistPath}} o elige Volver a vincular ahora en el menú Servidor para regenerarla.',
    'launchAgent.missing.title': 'La configuración de inicio necesita revinculación',
    'launchAgent.missing.bothMessage':
      'El demonio en segundo plano no puede iniciarse ni encontrar tmux integrado porque las rutas de LaunchAgent ya no existen.',
    'launchAgent.missing.progMessage':
      'El demonio en segundo plano no puede iniciarse porque el destino de ProgramArguments en LaunchAgent ya no existe.',
    'launchAgent.missing.tmuxMessage':
      'El demonio en segundo plano no encuentra tmux integrado porque la ruta PATH integrada en LaunchAgent ya no existe.',
    'launchAgent.missing.programsDetail': 'Ruta(s) de programa faltante(s):\n  {{paths}}',
    'launchAgent.missing.tmuxDetail': 'Entrada PATH de tmux integrado faltante:\n  {{paths}}',
    'launchAgent.missing.footerDetail':
      'Esto suele ocurrir tras mover o desinstalar IM.codes.app. Elige Volver a vincular ahora para actualizar LaunchAgent de forma segura.',
    'launchAgent.prompt.fallbackTitle': 'Comprobación de inicio del demonio',
    'launchAgent.prompt.fallbackMessage': 'La configuración de LaunchAgent requiere atención.',
    'launchAgent.prompt.later': 'Más tarde',
    'launchAgent.prompt.rebindNow': 'Volver a vincular ahora',

    'welcome.subtitle': 'Selecciona o agrega un servidor IM.codes',
    'welcome.defaultBadge': 'Predeterminado',
    'welcome.detectedBadge': 'Detectado localmente',
    'welcome.addHeading': 'Agregar servidor',
    'welcome.labelPlaceholder': 'Nombre visible (opcional)',
    'welcome.connect': 'Conectar',
    'welcome.remove': 'Eliminar',

    'prompt.windowTitle': 'Agregar servidor',
    'prompt.heading': 'Agregar servidor IM.codes',
    'prompt.urlLabel': 'URL del servidor (https:// o http://localhost)',
    'prompt.labelLabel': 'Nombre visible (opcional)',
    'prompt.labelPlaceholder': 'Producción',
    'prompt.submit': 'Agregar servidor',
  },
  ru: {
    'menu.app.about': 'О программе {{appName}}',
    'menu.app.settings': 'Настройки…',
    'menu.app.services': 'Службы',
    'menu.app.hide': 'Скрыть {{appName}}',
    'menu.app.hideOthers': 'Скрыть остальные',
    'menu.app.showAll': 'Показать все',
    'menu.app.quit': 'Выйти из {{appName}}',
    'menu.edit.label': 'Правка',
    'menu.edit.undo': 'Отменить',
    'menu.edit.redo': 'Повторить',
    'menu.edit.cut': 'Вырезать',
    'menu.edit.copy': 'Копировать',
    'menu.edit.paste': 'Вставить',
    'menu.edit.selectAll': 'Выбрать всё',
    'menu.view.label': 'Вид',
    'menu.view.reload': 'Перезагрузить',
    'menu.view.forceReload': 'Принудительная перезагрузка',
    'menu.view.devTools': 'Инструменты разработчика',
    'menu.view.resetZoom': 'Фактический размер',
    'menu.view.zoomIn': 'Увеличить',
    'menu.view.zoomOut': 'Уменьшить',
    'menu.view.toggleFullScreen': 'Полноэкранный режим',
    'menu.server.label': 'Сервер',
    'menu.server.none': 'Нет сохранённых серверов',
    'menu.server.switch': 'Сменить сервер…',
    'menu.server.add': 'Добавить сервер…',
    'menu.server.remove': 'Удалить сервер',
    'menu.server.rebind': 'Перепривязать устройство ({{serverName}} · {{workerUrl}})…',
    'menu.server.bind': 'Привязать это устройство…',
    'menu.server.clearSession': 'Очистить текущую сессию сервера',
    'menu.window.label': 'Окно',
    'menu.window.minimize': 'Свернуть',
    'menu.window.zoom': 'Масштаб',
    'menu.window.front': 'Все окна на передний план',
    'menu.window.close': 'Закрыть',
    'menu.help.label': 'Справка',
    'menu.help.docs': 'Документация IM.codes',

    'common.ok': 'ОК',
    'common.cancel': 'Отмена',
    'common.remove': 'Удалить',

    'dialog.removeServer.title': 'Удалить сервер',
    'dialog.removeServer.message': 'Удалить {{origin}} из сохранённых серверов?',

    'bind.manual.noOrigin.title': 'Привязать это устройство',
    'bind.manual.noOrigin.message': 'Перед привязкой устройства выберите сохранённый сервер.',
    'bind.manual.noCookies.title': 'Привязать это устройство',
    'bind.manual.noCookies.message': 'Сессионные cookie браузера недоступны в этом окне.',
    'bind.manual.signIn.title': 'Требуется вход',
    'bind.manual.signIn.message': 'Сначала войдите в {{origin}}, чтобы привязать это устройство.',
    'bind.replace.title': 'Заменить существующую привязку сервера?',
    'bind.replace.message': 'Это устройство уже привязано к серверу IM.codes.',
    'bind.replace.detail':
      'Сейчас привязано к:\n  {{serverName}} · {{workerUrl}}\n\nВыполнен вход в:\n  {{targetOrigin}}\n\n«Оставить текущую» ничего не изменит. Выберите «Заменить», чтобы привязать устройство к текущему серверу.',
    'bind.replace.keep': 'Оставить текущую',
    'bind.replace.replace': 'Заменить',
    'bind.success.title': 'Устройство привязано к IM.codes',
    'bind.success.body': 'Привязано к {{serverName}}. Фоновая служба установлена и будет запускаться при входе.',
    'bind.failure.uncertainTitle': 'Статус привязки не определён',
    'bind.failure.mintUnknownMessage': 'Не удалось подтвердить, был ли создан новый API-ключ на сервере.',
    'bind.failure.mintUnknownCheck': 'Проверьте API-ключи в веб-панели {{origin}} перед повторной попыткой.',
    'bind.failure.cliUncertainMessage': 'Команда привязки завершилась некорректно; созданный API-ключ сохранён для безопасности.',
    'bind.failure.cliUncertainCheck': 'Проверьте {{origin}}, появилось ли устройство в сети, или отзовите неиспользуемые ключи.',
    'bind.failure.failedTitle': 'Ошибка привязки устройства',
    'bind.failure.mintRejectedMessage': 'Сервер отклонил создание ключа привязки ({{error}}).',
    'bind.failure.cliFailedMessage': 'Не удалось привязать устройство через imcodes CLI.',
    'bind.failure.manualCommand': 'Команда вручную:\n  {{command}}',
    'bind.failure.manualFallback': 'Повторите через «Сервер -> Привязать это устройство» или выполните:\n  imcodes bind {{origin}}/bind/<api-key> {{host}}',

    'launchAgent.unreadable.title': 'LaunchAgent демона нечитаем',
    'launchAgent.unreadable.message': 'Не удалось прочитать существующую конфигурацию macOS LaunchAgent.',
    'launchAgent.unreadable.detail': 'Проверьте {{plistPath}} или выберите «Перепривязать сейчас» в меню «Сервер» для пересоздания.',
    'launchAgent.missing.title': 'Конфигурация запуска демона требует перепривязки',
    'launchAgent.missing.bothMessage':
      'Фоновый демон не может запуститься и найти встроенный tmux, так как пути в LaunchAgent больше не существуют.',
    'launchAgent.missing.progMessage':
      'Фоновый демон не может запуститься, так как цель ProgramArguments в LaunchAgent больше не существует.',
    'launchAgent.missing.tmuxMessage':
      'Фоновый демон не может найти встроенный tmux, так как встроенный путь PATH в LaunchAgent больше не существует.',
    'launchAgent.missing.programsDetail': 'Отсутствующие пути программы демона:\n  {{paths}}',
    'launchAgent.missing.tmuxDetail': 'Отсутствующий встроенный путь PATH для tmux:\n  {{paths}}',
    'launchAgent.missing.footerDetail':
      'Обычно это происходит после перемещения или удаления IM.codes.app. Выберите «Перепривязать сейчас», чтобы безопасно обновить LaunchAgent.',
    'launchAgent.prompt.fallbackTitle': 'Проверка запуска демона',
    'launchAgent.prompt.fallbackMessage': 'Конфигурация LaunchAgent требует внимания.',
    'launchAgent.prompt.later': 'Позже',
    'launchAgent.prompt.rebindNow': 'Перепривязать сейчас',

    'welcome.subtitle': 'Выберите или добавьте сервер IM.codes',
    'welcome.defaultBadge': 'По умолчанию',
    'welcome.detectedBadge': 'Обнаружен локально',
    'welcome.addHeading': 'Добавить сервер',
    'welcome.labelPlaceholder': 'Отображаемое имя (необязательно)',
    'welcome.connect': 'Подключиться',
    'welcome.remove': 'Удалить',

    'prompt.windowTitle': 'Добавить сервер',
    'prompt.heading': 'Добавить сервер IM.codes',
    'prompt.urlLabel': 'URL сервера (https:// или http://localhost)',
    'prompt.labelLabel': 'Отображаемое имя (необязательно)',
    'prompt.labelPlaceholder': 'Продакшн',
    'prompt.submit': 'Добавить сервер',
  },
  ja: {
    'menu.app.about': '{{appName}} について',
    'menu.app.settings': '設定…',
    'menu.app.services': 'サービス',
    'menu.app.hide': '{{appName}} を隠す',
    'menu.app.hideOthers': 'ほかを隠す',
    'menu.app.showAll': 'すべてを表示',
    'menu.app.quit': '{{appName}} を終了',
    'menu.edit.label': '編集',
    'menu.edit.undo': '取り消す',
    'menu.edit.redo': 'やり直す',
    'menu.edit.cut': '切り取り',
    'menu.edit.copy': 'コピー',
    'menu.edit.paste': 'ペースト',
    'menu.edit.selectAll': 'すべてを選択',
    'menu.view.label': '表示',
    'menu.view.reload': '再読み込み',
    'menu.view.forceReload': '強制再読み込み',
    'menu.view.devTools': 'デベロッパーツールを切り替え',
    'menu.view.resetZoom': '実際のサイズ',
    'menu.view.zoomIn': '拡大',
    'menu.view.zoomOut': '縮小',
    'menu.view.toggleFullScreen': 'フルスクリーン切り替え',
    'menu.server.label': 'サーバー',
    'menu.server.none': '保存されたサーバーはありません',
    'menu.server.switch': 'サーバーを切り替え…',
    'menu.server.add': 'サーバーを追加…',
    'menu.server.remove': 'サーバーを削除',
    'menu.server.rebind': 'このマシンを再バインド ({{serverName}} · {{workerUrl}})…',
    'menu.server.bind': 'このマシンをバインド…',
    'menu.server.clearSession': '現在のサーバーセッションを消去',
    'menu.window.label': 'ウィンドウ',
    'menu.window.minimize': '最小化',
    'menu.window.zoom': '拡大／縮小',
    'menu.window.front': 'すべてを手前に移動',
    'menu.window.close': '閉じる',
    'menu.help.label': 'ヘルプ',
    'menu.help.docs': 'IM.codes ドキュメント',

    'common.ok': 'OK',
    'common.cancel': 'キャンセル',
    'common.remove': '削除',

    'dialog.removeServer.title': 'サーバーを削除',
    'dialog.removeServer.message': '保存されたサーバーから {{origin}} を削除しますか？',

    'bind.manual.noOrigin.title': 'このマシンをバインド',
    'bind.manual.noOrigin.message': 'このマシンをバインドする前に、保存されたサーバーを選択してください。',
    'bind.manual.noCookies.title': 'このマシンをバインド',
    'bind.manual.noCookies.message': 'このウィンドウではブラウザのセッション Cookie を利用できません。',
    'bind.manual.signIn.title': 'サインインが必要です',
    'bind.manual.signIn.message': 'このマシンをバインドするには、先に {{origin}} にサインインしてください。',
    'bind.replace.title': '既存のサーバーバインドを置き換えますか？',
    'bind.replace.message': 'このマシンはすでに別の IM.codes サーバーにバインドされています。',
    'bind.replace.detail':
      '現在のバインド先:\n  {{serverName}} · {{workerUrl}}\n\nサインイン中のサーバー:\n  {{targetOrigin}}\n\n「既存を維持」では変更されません。「置き換える」を選択すると現在のサーバーにバインドされます。',
    'bind.replace.keep': '既存を維持',
    'bind.replace.replace': '置き換える',
    'bind.success.title': 'IM.codes マシンをバインドしました',
    'bind.success.body': '{{serverName}} にバインドしました。バックグラウンドサービスがインストールされ、ログイン時に自動起動します。',
    'bind.failure.uncertainTitle': 'マシンバインドの状態が不明です',
    'bind.failure.mintUnknownMessage': 'サーバーで新しい API キーが作成されたか確認できませんでした。',
    'bind.failure.mintUnknownCheck': '再試行する前に {{origin}} の Web ダッシュボードで API キーを確認してください。',
    'bind.failure.cliUncertainMessage': 'バインドコマンドが正常に完了しませんでした。安全のため作成された API キーは保持されています。',
    'bind.failure.cliUncertainCheck': '{{origin}} でこのマシンがオンラインになっているか確認し、不要なキーがあれば取り消してください。',
    'bind.failure.failedTitle': 'マシンのバインドに失敗しました',
    'bind.failure.mintRejectedMessage': 'サーバーがバインドキーの作成を拒否しました ({{error}})。',
    'bind.failure.cliFailedMessage': 'imcodes CLI によるマシンのバインドに失敗しました。',
    'bind.failure.manualCommand': '手動コマンド:\n  {{command}}',
    'bind.failure.manualFallback': '「サーバー -> このマシンをバインド」から再試行するか、次を実行してください:\n  imcodes bind {{origin}}/bind/<api-key> {{host}}',

    'launchAgent.unreadable.title': 'Daemon LaunchAgent を読み取れません',
    'launchAgent.unreadable.message': '既存の macOS LaunchAgent 設定を読み取れませんでした。',
    'launchAgent.unreadable.detail': '{{plistPath}} を確認するか、「サーバー」メニューから「今すぐ再バインド」を選択して再生成してください。',
    'launchAgent.missing.title': 'Daemon 起動設定の再バインドが必要です',
    'launchAgent.missing.bothMessage':
      'LaunchAgent 内のパスが存在しないため、バックグラウンドデーモンを起動できず、同梱の tmux も見つかりません。',
    'launchAgent.missing.progMessage':
      'LaunchAgent の ProgramArguments のパスが存在しないため、バックグラウンドデーモンを起動できません。',
    'launchAgent.missing.tmuxMessage':
      'LaunchAgent の同梱 PATH エントリが存在しないため、バックグラウンドデーモンが同梱の tmux を見つけられません。',
    'launchAgent.missing.programsDetail': '見つからないデーモンプログラムのパス:\n  {{paths}}',
    'launchAgent.missing.tmuxDetail': '見つからない同梱 tmux の PATH エントリ:\n  {{paths}}',
    'launchAgent.missing.footerDetail':
      '通常は IM.codes.app を移動またはアンインストールした後に発生します。「今すぐ再バインド」を選択すると LaunchAgent を安全に更新できます。',
    'launchAgent.prompt.fallbackTitle': 'Daemon 起動チェック',
    'launchAgent.prompt.fallbackMessage': 'LaunchAgent 設定の確認が必要です。',
    'launchAgent.prompt.later': '後で',
    'launchAgent.prompt.rebindNow': '今すぐ再バインド',

    'welcome.subtitle': 'IM.codes サーバーを選択または追加',
    'welcome.defaultBadge': 'デフォルト',
    'welcome.detectedBadge': 'ローカルで検出',
    'welcome.addHeading': 'サーバーを追加',
    'welcome.labelPlaceholder': '表示名（任意）',
    'welcome.connect': '接続',
    'welcome.remove': '削除',

    'prompt.windowTitle': 'サーバーを追加',
    'prompt.heading': 'IM.codes サーバーを追加',
    'prompt.urlLabel': 'サーバー URL（https:// または http://localhost）',
    'prompt.labelLabel': '表示名（任意）',
    'prompt.labelPlaceholder': '本番環境',
    'prompt.submit': 'サーバーを追加',
  },
  ko: {
    'menu.app.about': '{{appName}} 정보',
    'menu.app.settings': '설정…',
    'menu.app.services': '서비스',
    'menu.app.hide': '{{appName}} 가리기',
    'menu.app.hideOthers': '기타 가리기',
    'menu.app.showAll': '모두 보기',
    'menu.app.quit': '{{appName}} 종료',
    'menu.edit.label': '편집',
    'menu.edit.undo': '실행 취소',
    'menu.edit.redo': '다시 실행',
    'menu.edit.cut': '오려두기',
    'menu.edit.copy': '복사하기',
    'menu.edit.paste': '붙여넣기',
    'menu.edit.selectAll': '모두 선택',
    'menu.view.label': '보기',
    'menu.view.reload': '새로 고침',
    'menu.view.forceReload': '강제 새로 고침',
    'menu.view.devTools': '개발자 도구 전환',
    'menu.view.resetZoom': '실제 크기',
    'menu.view.zoomIn': '확대',
    'menu.view.zoomOut': '축소',
    'menu.view.toggleFullScreen': '전체 화면 전환',
    'menu.server.label': '서버',
    'menu.server.none': '저장된 서버 없음',
    'menu.server.switch': '서버 전환…',
    'menu.server.add': '서버 추가…',
    'menu.server.remove': '서버 삭제',
    'menu.server.rebind': '기기 다시 바인딩 ({{serverName}} · {{workerUrl}})…',
    'menu.server.bind': '이 기기 바인딩…',
    'menu.server.clearSession': '현재 서버 세션 지우기',
    'menu.window.label': '창',
    'menu.window.minimize': '최소화',
    'menu.window.zoom': '확대/축소',
    'menu.window.front': '모두 앞으로 가져오기',
    'menu.window.close': '닫기',
    'menu.help.label': '도움말',
    'menu.help.docs': 'IM.codes 문서',

    'common.ok': '확인',
    'common.cancel': '취소',
    'common.remove': '삭제',

    'dialog.removeServer.title': '서버 삭제',
    'dialog.removeServer.message': '저장된 서버에서 {{origin}}을(를) 삭제하시겠습니까?',

    'bind.manual.noOrigin.title': '이 기기 바인딩',
    'bind.manual.noOrigin.message': '이 기기를 바인딩하기 전에 저장된 서버를 먼저 선택하세요.',
    'bind.manual.noCookies.title': '이 기기 바인딩',
    'bind.manual.noCookies.message': '이 창에서는 브라우저 세션 쿠키를 사용할 수 없습니다.',
    'bind.manual.signIn.title': '로그인 필요',
    'bind.manual.signIn.message': '이 기기를 바인딩하려면 먼저 {{origin}}에 로그인하세요.',
    'bind.replace.title': '기존 서버 바인딩을 교체하시겠습니까?',
    'bind.replace.message': '이 기기는 이미 다른 IM.codes 서버에 바인딩되어 있습니다.',
    'bind.replace.detail':
      '현재 바인딩 대상:\n  {{serverName}} · {{workerUrl}}\n\n로그인된 서버:\n  {{targetOrigin}}\n\n기존 유지를 선택하면 변경되지 않습니다. 현재 서버에 바인딩하려면 교체를 선택하세요.',
    'bind.replace.keep': '기존 유지',
    'bind.replace.replace': '교체',
    'bind.success.title': 'IM.codes 기기 바인딩 완료',
    'bind.success.body': '{{serverName}}에 바인딩되었습니다. 백그라운드 서비스가 설치되었으며 로그인 시 자동 시작됩니다.',
    'bind.failure.uncertainTitle': '기기 바인딩 상태 불확실',
    'bind.failure.mintUnknownMessage': '서버에서 새 API 키가 생성되었는지 확인할 수 없습니다.',
    'bind.failure.mintUnknownCheck': '다시 시도하기 전에 {{origin}} 웹 대시보드에서 API 키를 확인하세요.',
    'bind.failure.cliUncertainMessage': '바인딩 명령이 정상적으로 완료되지 않았습니다. 안전을 위해 생성된 API 키를 유지했습니다.',
    'bind.failure.cliUncertainCheck': '{{origin}}에서 이 기기가 온라인으로 표시되는지 확인하거나 사용하지 않는 키를 해지하세요.',
    'bind.failure.failedTitle': '기기 바인딩 실패',
    'bind.failure.mintRejectedMessage': '서버가 바인딩 키 생성을 거부했습니다 ({{error}}).',
    'bind.failure.cliFailedMessage': 'imcodes CLI를 통해 이 기기를 바인딩하지 못했습니다.',
    'bind.failure.manualCommand': '수동 명령어:\n  {{command}}',
    'bind.failure.manualFallback': '서버 -> 이 기기 바인딩으로 다시 시도하거나 다음을 실행하세요:\n  imcodes bind {{origin}}/bind/<api-key> {{host}}',

    'launchAgent.unreadable.title': 'Daemon LaunchAgent를 읽을 수 없음',
    'launchAgent.unreadable.message': '기존 macOS LaunchAgent 구성을 읽을 수 없습니다.',
    'launchAgent.unreadable.detail': '{{plistPath}}을(를) 확인하거나 서버 메뉴에서 지금 다시 바인딩을 선택하여 재생성하세요.',
    'launchAgent.missing.title': 'Daemon 시작 구성 다시 바인딩 필요',
    'launchAgent.missing.bothMessage':
      'LaunchAgent의 경로가 더 이상 존재하지 않아 백그라운드 데몬을 시작할 수 없고 내장 tmux도 찾을 수 없습니다.',
    'launchAgent.missing.progMessage':
      'LaunchAgent의 ProgramArguments 대상이 더 이상 존재하지 않아 백그라운드 데몬을 시작할 수 없습니다.',
    'launchAgent.missing.tmuxMessage':
      'LaunchAgent의 내장 PATH 항목이 더 이상 존재하지 않아 백그라운드 데몬이 내장 tmux를 찾을 수 없습니다.',
    'launchAgent.missing.programsDetail': '누락된 데몬 프로그램 경로:\n  {{paths}}',
    'launchAgent.missing.tmuxDetail': '누락된 내장 tmux PATH 항목:\n  {{paths}}',
    'launchAgent.missing.footerDetail':
      '이는 보통 IM.codes.app을 이동하거나 제거한 후에 발생합니다. LaunchAgent를 안전하게 업데이트하려면 지금 다시 바인딩을 선택하세요.',
    'launchAgent.prompt.fallbackTitle': 'Daemon 시작 확인',
    'launchAgent.prompt.fallbackMessage': 'LaunchAgent 구성 확인이 필요합니다.',
    'launchAgent.prompt.later': '나중에',
    'launchAgent.prompt.rebindNow': '지금 다시 바인딩',

    'welcome.subtitle': 'IM.codes 서버를 선택하거나 추가하세요',
    'welcome.defaultBadge': '기본값',
    'welcome.detectedBadge': '로컬에서 감지됨',
    'welcome.addHeading': '서버 추가',
    'welcome.labelPlaceholder': '표시 이름 (선택 사항)',
    'welcome.connect': '연결',
    'welcome.remove': '삭제',

    'prompt.windowTitle': '서버 추가',
    'prompt.heading': 'IM.codes 서버 추가',
    'prompt.urlLabel': '서버 URL (https:// 또는 http://localhost)',
    'prompt.labelLabel': '표시 이름 (선택 사항)',
    'prompt.labelPlaceholder': '프로덕션',
    'prompt.submit': '서버 추가',
  },
};

/** Translate a PC App UI key for the given locale with safe `{{var}}` substitution. */
export function tPcApp(
  locale: PcAppLocale | string | undefined,
  key: PcAppMessageKey,
  vars?: Record<string, string | number>,
): string {
  const normalized = normalizePcAppLocale(locale);
  const template = PC_APP_MESSAGES[normalized][key] ?? EN_MESSAGES[key];
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/gu, (full, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return String(vars[name]);
    }
    return full;
  });
}
