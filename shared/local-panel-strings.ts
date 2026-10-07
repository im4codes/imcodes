import { UI_LOCALES, type UiLocale } from './ui-locale.js';

/**
 * Every string the controlled node's local management panel shows, in the
 * seven UI languages. The panel is one self-contained page served from the
 * node (no bundler, no external files), so its text lives here, authored once
 * and embedded into the page. `{{name}}` marks a value filled in at display.
 */
export const LOCAL_PANEL_STRING_KEYS = [
  'navHome', 'navSettings', 'navAbout', 'navLabel',
  'thisComputer', 'myId', 'copy', 'copied', 'copyId',
  'statusOnline', 'statusBusy', 'statusPaused', 'statusOffline',
  'allow', 'allowOn', 'allowOff', 'switchOn', 'switchOff',
  'share', 'manage',
  'pausedTitle', 'pausedText', 'resume',
  'connections', 'connectionsActive', 'stopAll', 'user', 'view', 'control', 'since', 'disconnect',
  'emptyTitle', 'emptySub', 'offlineTitle', 'offlineText',
  'permissions', 'permScreen', 'permAccessibility', 'permDisk', 'permGranted', 'permDenied', 'permUnknown',
  'permHelpScreen', 'permHelpAccessibility', 'permHelpDisk', 'openSettings',
  'cancel', 'confirm', 'disconnectTitle', 'disconnectText', 'stopTitle', 'stopText',
  'settingsTitle', 'language', 'languageSystem', 'languageHelp', 'appearanceNote',
  'aboutTitle', 'version', 'actionFailed',
] as const;
export type LocalPanelStringKey = (typeof LOCAL_PANEL_STRING_KEYS)[number];
export type LocalPanelStrings = Readonly<Record<LocalPanelStringKey, string>>;

/** Each language's name in that language, for the language picker (never translated). */
export const UI_LOCALE_AUTONYMS: Readonly<Record<UiLocale, string>> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  es: 'Español',
  ru: 'Русский',
  ja: '日本語',
  ko: '한국어',
};

const en: LocalPanelStrings = {
  navHome: 'This device', navSettings: 'Settings', navAbout: 'About', navLabel: 'Sections',
  thisComputer: 'This computer', myId: 'Your ID', copy: 'Copy', copied: 'Copied', copyId: 'Copy ID',
  statusOnline: 'Online', statusBusy: 'In use', statusPaused: 'Paused', statusOffline: 'Offline',
  allow: 'Allow remote access',
  allowOn: 'Others can view or control this computer with your ID.',
  allowOff: 'Nobody can connect until you turn this on.',
  switchOn: 'On', switchOff: 'Off',
  share: 'Share', manage: 'Web management',
  pausedTitle: 'Remote access is paused', pausedText: 'Everyone was disconnected and no one can connect.', resume: 'Resume',
  connections: 'Connections', connectionsActive: '{{n}} active connection(s)', stopAll: 'Disconnect all',
  user: 'User', view: 'Viewing', control: 'Controlling', since: 'Connected', disconnect: 'Disconnect',
  emptyTitle: 'No one is connected', emptySub: 'When someone views or controls this computer, they appear here.',
  offlineTitle: 'Cannot reach the service', offlineText: 'This page keeps trying. Restart the aiDesk.to service if it does not come back.',
  permissions: 'Permissions', permScreen: 'Screen recording', permAccessibility: 'Accessibility', permDisk: 'Full Disk Access',
  permGranted: 'Granted', permDenied: 'Not granted', permUnknown: 'Cannot tell',
  permHelpScreen: 'Turn on aiDesk.to in System Settings → Privacy & Security → Screen Recording.',
  permHelpAccessibility: 'Turn on aiDesk.to in System Settings → Privacy & Security → Accessibility.',
  permHelpDisk: 'Turn on aiDesk.to in System Settings → Privacy & Security → Full Disk Access (add it with + if it is not listed).',
  openSettings: 'Open settings',
  cancel: 'Cancel', confirm: 'Confirm',
  disconnectTitle: 'Disconnect this connection?', disconnectText: 'Only this connection will end.',
  stopTitle: 'Disconnect everyone?', stopText: 'Click confirm once more to disconnect every current viewer and controller. Remote access remains enabled for future connections.',
  settingsTitle: 'Settings', language: 'Language', languageSystem: 'Follow system',
  languageHelp: 'Follow system uses your computer’s language. A language you pick here is remembered on this computer.',
  appearanceNote: 'Light or dark appearance follows your system.',
  aboutTitle: 'About', version: 'Version', actionFailed: 'That did not work. Try again.',
};

const zhCN: LocalPanelStrings = {
  navHome: '本机', navSettings: '设置', navAbout: '关于', navLabel: '导航',
  thisComputer: '这台电脑', myId: '本机 ID', copy: '复制', copied: '已复制', copyId: '复制 ID',
  statusOnline: '在线', statusBusy: '使用中', statusPaused: '已暂停', statusOffline: '离线',
  allow: '允许远程访问',
  allowOn: '他人可凭你的 ID 查看或控制这台电脑。',
  allowOff: '打开之前，任何人都无法连接。',
  switchOn: '已开启', switchOff: '已关闭',
  share: '分享', manage: '网页管理',
  pausedTitle: '远程访问已暂停', pausedText: '所有连接已断开，任何人都无法连接。', resume: '恢复',
  connections: '当前连接', connectionsActive: '当前 {{n}} 个连接', stopAll: '断开全部',
  user: '用户', view: '查看', control: '控制中', since: '连接于', disconnect: '断开',
  emptyTitle: '当前无人连接', emptySub: '有人查看或控制这台电脑时，会显示在这里。',
  offlineTitle: '无法连接到服务', offlineText: '页面会持续重试。若长时间没有恢复，请重启 aiDesk.to 服务。',
  permissions: '权限', permScreen: '屏幕录制', permAccessibility: '辅助功能', permDisk: '完全磁盘访问',
  permGranted: '已授权', permDenied: '未授权', permUnknown: '无法判断',
  permHelpScreen: '请在“系统设置 → 隐私与安全性 → 屏幕录制”中打开 aiDesk.to。',
  permHelpAccessibility: '请在“系统设置 → 隐私与安全性 → 辅助功能”中打开 aiDesk.to。',
  permHelpDisk: '请在“系统设置 → 隐私与安全性 → 完全磁盘访问”中打开 aiDesk.to（若未列出，请用 + 添加）。',
  openSettings: '去设置',
  cancel: '取消', confirm: '确认',
  disconnectTitle: '断开此连接？', disconnectText: '仅会结束这一条连接。',
  stopTitle: '断开所有人？', stopText: '再次确认后将断开全部当前查看者和控制者；以后仍可重新连接。',
  settingsTitle: '设置', language: '语言', languageSystem: '跟随系统',
  languageHelp: '“跟随系统”使用电脑的语言。你在此选择的语言会记在这台电脑上。',
  appearanceNote: '浅色或深色外观跟随系统。',
  aboutTitle: '关于', version: '版本', actionFailed: '操作未成功，请重试。',
};

const zhTW: LocalPanelStrings = {
  navHome: '本機', navSettings: '設定', navAbout: '關於', navLabel: '導覽',
  thisComputer: '這台電腦', myId: '本機 ID', copy: '複製', copied: '已複製', copyId: '複製 ID',
  statusOnline: '上線', statusBusy: '使用中', statusPaused: '已暫停', statusOffline: '離線',
  allow: '允許遠端存取',
  allowOn: '他人可憑你的 ID 檢視或控制這台電腦。',
  allowOff: '開啟之前，任何人都無法連線。',
  switchOn: '已開啟', switchOff: '已關閉',
  share: '分享', manage: '網頁管理',
  pausedTitle: '遠端存取已暫停', pausedText: '所有連線已中斷，任何人都無法連線。', resume: '恢復',
  connections: '目前連線', connectionsActive: '目前 {{n}} 個連線', stopAll: '全部中斷',
  user: '使用者', view: '檢視', control: '控制中', since: '連線於', disconnect: '中斷',
  emptyTitle: '目前無人連線', emptySub: '有人檢視或控制這台電腦時，會顯示在這裡。',
  offlineTitle: '無法連線到服務', offlineText: '此頁面會持續重試。若長時間沒有恢復，請重新啟動 aiDesk.to 服務。',
  permissions: '權限', permScreen: '螢幕錄製', permAccessibility: '輔助使用', permDisk: '完整磁碟取用權',
  permGranted: '已授權', permDenied: '未授權', permUnknown: '無法判斷',
  permHelpScreen: '請在「系統設定 → 隱私權與安全性 → 螢幕錄製」中開啟 aiDesk.to。',
  permHelpAccessibility: '請在「系統設定 → 隱私權與安全性 → 輔助使用」中開啟 aiDesk.to。',
  permHelpDisk: '請在「系統設定 → 隱私權與安全性 → 完整磁碟取用權」中開啟 aiDesk.to（若未列出，請用 + 加入）。',
  openSettings: '前往設定',
  cancel: '取消', confirm: '確認',
  disconnectTitle: '中斷此連線？', disconnectText: '只會結束這一條連線。',
  stopTitle: '中斷所有人？', stopText: '再次確認後將中斷全部目前檢視者和控制者；之後仍可重新連線。',
  settingsTitle: '設定', language: '語言', languageSystem: '跟隨系統',
  languageHelp: '「跟隨系統」會使用電腦的語言。你在此選擇的語言會記在這台電腦上。',
  appearanceNote: '淺色或深色外觀跟隨系統。',
  aboutTitle: '關於', version: '版本', actionFailed: '操作未成功，請再試一次。',
};

const es: LocalPanelStrings = {
  navHome: 'Este equipo', navSettings: 'Ajustes', navAbout: 'Acerca de', navLabel: 'Secciones',
  thisComputer: 'Este equipo', myId: 'Tu ID', copy: 'Copiar', copied: 'Copiado', copyId: 'Copiar ID',
  statusOnline: 'En línea', statusBusy: 'En uso', statusPaused: 'En pausa', statusOffline: 'Sin conexión',
  allow: 'Permitir acceso remoto',
  allowOn: 'Otras personas pueden ver o controlar este equipo con tu ID.',
  allowOff: 'Nadie puede conectarse hasta que lo actives.',
  switchOn: 'Activado', switchOff: 'Desactivado',
  share: 'Compartir', manage: 'Administración web',
  pausedTitle: 'El acceso remoto está en pausa', pausedText: 'Se desconectó a todos y nadie puede conectarse.', resume: 'Reanudar',
  connections: 'Conexiones', connectionsActive: '{{n}} conexión(es) activa(s)', stopAll: 'Desconectar a todos',
  user: 'Usuario', view: 'Viendo', control: 'Controlando', since: 'Conectado', disconnect: 'Desconectar',
  emptyTitle: 'Nadie está conectado', emptySub: 'Cuando alguien vea o controle este equipo, aparecerá aquí.',
  offlineTitle: 'No se puede contactar con el servicio', offlineText: 'Esta página sigue reintentando. Si no se recupera, reinicia el servicio de aiDesk.to.',
  permissions: 'Permisos', permScreen: 'Grabación de pantalla', permAccessibility: 'Accesibilidad', permDisk: 'Acceso total al disco',
  permGranted: 'Concedido', permDenied: 'No concedido', permUnknown: 'No se puede saber',
  permHelpScreen: 'Activa aiDesk.to en Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla.',
  permHelpAccessibility: 'Activa aiDesk.to en Ajustes del Sistema → Privacidad y seguridad → Accesibilidad.',
  permHelpDisk: 'Activa aiDesk.to en Ajustes del Sistema → Privacidad y seguridad → Acceso total al disco (añádelo con + si no aparece).',
  openSettings: 'Abrir ajustes',
  cancel: 'Cancelar', confirm: 'Confirmar',
  disconnectTitle: '¿Desconectar esta conexión?', disconnectText: 'Solo finalizará esta conexión.',
  stopTitle: '¿Desconectar a todos?', stopText: 'Confirma de nuevo para desconectar a todos los que ven o controlan ahora. El acceso seguirá habilitado para futuras conexiones.',
  settingsTitle: 'Ajustes', language: 'Idioma', languageSystem: 'Seguir el sistema',
  languageHelp: '«Seguir el sistema» usa el idioma de tu equipo. El idioma que elijas aquí se recuerda en este equipo.',
  appearanceNote: 'La apariencia clara u oscura sigue al sistema.',
  aboutTitle: 'Acerca de', version: 'Versión', actionFailed: 'No funcionó. Inténtalo de nuevo.',
};

const ru: LocalPanelStrings = {
  navHome: 'Это устройство', navSettings: 'Настройки', navAbout: 'О программе', navLabel: 'Разделы',
  thisComputer: 'Этот компьютер', myId: 'Ваш ID', copy: 'Копировать', copied: 'Скопировано', copyId: 'Копировать ID',
  statusOnline: 'В сети', statusBusy: 'Используется', statusPaused: 'Пауза', statusOffline: 'Не в сети',
  allow: 'Разрешить удалённый доступ',
  allowOn: 'Другие могут просматривать и управлять этим компьютером по вашему ID.',
  allowOff: 'Никто не сможет подключиться, пока вы не включите.',
  switchOn: 'Вкл.', switchOff: 'Выкл.',
  share: 'Поделиться', manage: 'Веб-управление',
  pausedTitle: 'Удалённый доступ приостановлен', pausedText: 'Все отключены, подключиться никто не может.', resume: 'Возобновить',
  connections: 'Подключения', connectionsActive: 'Активных подключений: {{n}}', stopAll: 'Отключить всех',
  user: 'Пользователь', view: 'Просмотр', control: 'Управление', since: 'Подключён', disconnect: 'Отключить',
  emptyTitle: 'Никто не подключён', emptySub: 'Когда кто-то просматривает или управляет этим компьютером, он появится здесь.',
  offlineTitle: 'Нет связи со службой', offlineText: 'Страница продолжает попытки. Если связь не восстановится, перезапустите службу aiDesk.to.',
  permissions: 'Разрешения', permScreen: 'Запись экрана', permAccessibility: 'Универсальный доступ', permDisk: 'Полный доступ к диску',
  permGranted: 'Разрешено', permDenied: 'Не разрешено', permUnknown: 'Не удаётся определить',
  permHelpScreen: 'Включите aiDesk.to в «Системные настройки → Конфиденциальность и безопасность → Запись экрана».',
  permHelpAccessibility: 'Включите aiDesk.to в «Системные настройки → Конфиденциальность и безопасность → Универсальный доступ».',
  permHelpDisk: 'Включите aiDesk.to в «Системные настройки → Конфиденциальность и безопасность → Полный доступ к диску» (если его нет в списке, добавьте через +).',
  openSettings: 'Открыть настройки',
  cancel: 'Отмена', confirm: 'Подтвердить',
  disconnectTitle: 'Отключить это подключение?', disconnectText: 'Будет завершено только это подключение.',
  stopTitle: 'Отключить всех?', stopText: 'Подтвердите ещё раз, чтобы отключить всех, кто сейчас просматривает или управляет. Доступ останется включён для будущих подключений.',
  settingsTitle: 'Настройки', language: 'Язык', languageSystem: 'Как в системе',
  languageHelp: '«Как в системе» использует язык вашего компьютера. Выбранный здесь язык запоминается на этом компьютере.',
  appearanceNote: 'Светлое или тёмное оформление следует системе.',
  aboutTitle: 'О программе', version: 'Версия', actionFailed: 'Не получилось. Повторите попытку.',
};

const ja: LocalPanelStrings = {
  navHome: 'このデバイス', navSettings: '設定', navAbout: '情報', navLabel: 'セクション',
  thisComputer: 'このコンピュータ', myId: 'あなたの ID', copy: 'コピー', copied: 'コピー済み', copyId: 'ID をコピー',
  statusOnline: 'オンライン', statusBusy: '使用中', statusPaused: '一時停止中', statusOffline: 'オフライン',
  allow: 'リモートアクセスを許可',
  allowOn: 'あなたの ID で、他の人がこのコンピュータを閲覧・操作できます。',
  allowOff: 'オンにするまで、誰も接続できません。',
  switchOn: 'オン', switchOff: 'オフ',
  share: '共有', manage: 'Web 管理',
  pausedTitle: 'リモートアクセスは一時停止中です', pausedText: '全員の接続を切断しました。誰も接続できません。', resume: '再開',
  connections: '接続', connectionsActive: '接続中: {{n}}', stopAll: 'すべて切断',
  user: 'ユーザー', view: '閲覧', control: '操作中', since: '接続時刻', disconnect: '切断',
  emptyTitle: '接続している人はいません', emptySub: '誰かがこのコンピュータを閲覧・操作すると、ここに表示されます。',
  offlineTitle: 'サービスに接続できません', offlineText: 'このページは再試行を続けます。戻らない場合は aiDesk.to サービスを再起動してください。',
  permissions: '権限', permScreen: '画面収録', permAccessibility: 'アクセシビリティ', permDisk: 'フルディスクアクセス',
  permGranted: '許可済み', permDenied: '未許可', permUnknown: '判定できません',
  permHelpScreen: '「システム設定 → プライバシーとセキュリティ → 画面収録」で aiDesk.to をオンにしてください。',
  permHelpAccessibility: '「システム設定 → プライバシーとセキュリティ → アクセシビリティ」で aiDesk.to をオンにしてください。',
  permHelpDisk: '「システム設定 → プライバシーとセキュリティ → フルディスクアクセス」で aiDesk.to をオンにしてください（一覧にない場合は + で追加）。',
  openSettings: '設定を開く',
  cancel: 'キャンセル', confirm: '確認',
  disconnectTitle: 'この接続を切断しますか？', disconnectText: 'この接続だけを終了します。',
  stopTitle: '全員を切断しますか？', stopText: 'もう一度確認すると、現在の閲覧者と操作者をすべて切断します。今後の接続は引き続き許可されます。',
  settingsTitle: '設定', language: '言語', languageSystem: 'システムに従う',
  languageHelp: '「システムに従う」はコンピュータの言語を使います。ここで選んだ言語はこのコンピュータに記憶されます。',
  appearanceNote: 'ライト／ダークの外観はシステムに従います。',
  aboutTitle: '情報', version: 'バージョン', actionFailed: 'うまくいきませんでした。もう一度お試しください。',
};

const ko: LocalPanelStrings = {
  navHome: '이 기기', navSettings: '설정', navAbout: '정보', navLabel: '섹션',
  thisComputer: '이 컴퓨터', myId: '내 ID', copy: '복사', copied: '복사됨', copyId: 'ID 복사',
  statusOnline: '온라인', statusBusy: '사용 중', statusPaused: '일시 중지됨', statusOffline: '오프라인',
  allow: '원격 액세스 허용',
  allowOn: '다른 사람이 내 ID로 이 컴퓨터를 보거나 제어할 수 있습니다.',
  allowOff: '켜기 전에는 아무도 연결할 수 없습니다.',
  switchOn: '켜짐', switchOff: '꺼짐',
  share: '공유', manage: '웹 관리',
  pausedTitle: '원격 액세스가 일시 중지되었습니다', pausedText: '모든 연결을 끊었고 아무도 연결할 수 없습니다.', resume: '재개',
  connections: '연결', connectionsActive: '활성 연결 {{n}}개', stopAll: '모두 연결 끊기',
  user: '사용자', view: '보기', control: '제어 중', since: '연결 시간', disconnect: '연결 끊기',
  emptyTitle: '연결된 사람이 없습니다', emptySub: '누군가 이 컴퓨터를 보거나 제어하면 여기에 표시됩니다.',
  offlineTitle: '서비스에 연결할 수 없습니다', offlineText: '이 페이지는 계속 재시도합니다. 복구되지 않으면 aiDesk.to 서비스를 다시 시작하세요.',
  permissions: '권한', permScreen: '화면 기록', permAccessibility: '손쉬운 사용', permDisk: '전체 디스크 접근',
  permGranted: '허용됨', permDenied: '허용 안 됨', permUnknown: '확인할 수 없음',
  permHelpScreen: '“시스템 설정 → 개인정보 보호 및 보안 → 화면 기록”에서 aiDesk.to를 켜세요.',
  permHelpAccessibility: '“시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용”에서 aiDesk.to를 켜세요.',
  permHelpDisk: '“시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근”에서 aiDesk.to를 켜세요(목록에 없으면 +로 추가).',
  openSettings: '설정 열기',
  cancel: '취소', confirm: '확인',
  disconnectTitle: '이 연결을 끊을까요?', disconnectText: '이 연결만 종료합니다.',
  stopTitle: '모두 연결을 끊을까요?', stopText: '다시 확인하면 현재 보고 있거나 제어 중인 모두의 연결을 끊습니다. 이후 연결은 계속 허용됩니다.',
  settingsTitle: '설정', language: '언어', languageSystem: '시스템 따르기',
  languageHelp: '“시스템 따르기”는 컴퓨터의 언어를 사용합니다. 여기서 고른 언어는 이 컴퓨터에 기억됩니다.',
  appearanceNote: '밝은/어두운 모양은 시스템을 따릅니다.',
  aboutTitle: '정보', version: '버전', actionFailed: '실패했습니다. 다시 시도하세요.',
};

export const LOCAL_PANEL_STRINGS: Readonly<Record<UiLocale, LocalPanelStrings>> = {
  en, 'zh-CN': zhCN, 'zh-TW': zhTW, es, ru, ja, ko,
};

/** A panel string for `locale` with `{{name}}` placeholders filled in; a missing translation falls back to English. */
export function localPanelText(
  locale: UiLocale,
  key: LocalPanelStringKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  const template = LOCAL_PANEL_STRINGS[locale]?.[key] ?? LOCAL_PANEL_STRINGS.en[key];
  return params ? template.replace(/\{\{(\w+)\}\}/gu, (match, name: string) => (name in params ? String(params[name]) : match)) : template;
}

export const LOCAL_PANEL_LOCALES = UI_LOCALES;

/**
 * The strings table and its lookup as plain JavaScript source for the self-contained panel page (see uiLocaleEmbedSource): the
 * very same table and function, evaluated in the page, so the page cannot drift from this module.
 */
export function localPanelStringsEmbedSource(): string {
  return [
    `var LOCAL_PANEL_STRINGS=${JSON.stringify(LOCAL_PANEL_STRINGS)};`,
    `var UI_LOCALE_AUTONYMS=${JSON.stringify(UI_LOCALE_AUTONYMS)};`,
    localPanelText.toString(),
  ].join('\n');
}
