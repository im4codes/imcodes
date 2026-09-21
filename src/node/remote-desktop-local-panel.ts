import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_LOCAL_ACTION,
  REMOTE_DESKTOP_LOCAL_MANAGEMENT,
  REMOTE_DESKTOP_LOCAL_WEB_ACTION,
  type RemoteDesktopLocalAction,
  type RemoteDesktopLocalStatus,
} from '../../shared/remote-desktop-local-management.js';

const MAX_BODY_BYTES = 4096;
const MAX_PANEL_SESSIONS = 8;
const PANEL_SESSION_TTL_MS = 8 * 60 * 60_000;

export interface RemoteDesktopLocalPanelOptions {
  publicNodeId: string;
  serverUrl: string;
  status(): Omit<RemoteDesktopLocalStatus, 'publicNodeId'>;
  setPaused(paused: boolean): Promise<void>;
  stopAll(): Promise<void>;
  disconnect(publicId: string): Promise<boolean>;
  host?: string;
  port?: number;
}

export interface RemoteDesktopLocalPanel {
  readonly url: string;
  close(): Promise<void>;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').flatMap((part) => {
    const at = part.indexOf('=');
    return at > 0 ? [[part.slice(0, at).trim(), part.slice(at + 1).trim()]] : [];
  }));
}

function reply(response: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function managementUrl(serverUrl: string, publicNodeId: string, action: 'manage' | 'share'): string {
  const url = new URL(serverUrl);
  url.searchParams.set(REMOTE_DESKTOP_LOCAL_MANAGEMENT.WEB_NODE_QUERY, publicNodeId);
  url.searchParams.set(REMOTE_DESKTOP_LOCAL_MANAGEMENT.WEB_ACTION_QUERY, action);
  return url.toString();
}

function panelHtml(input: { publicNodeId: string; manageUrl: string; shareUrl: string; csrf: string }): string {
  const bootstrap = JSON.stringify({
    ...input,
    statePath: REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH,
    actionPath: REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH,
    csrfHeader: REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER,
    actions: REMOTE_DESKTOP_LOCAL_ACTION,
    modes: REMOTE_DESKTOP_ACCESS_MODE,
  }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>aiDesk.to</title><style>
:root{color-scheme:dark;--bg:#07111e;--card:#0d1d2d;--line:#24445d;--muted:#91a9ba;--accent:#38bdf8;--danger:#fb7185;--ok:#34d399}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#12304b,var(--bg) 45%);color:#edf8ff;font:14px system-ui,sans-serif}main{max-width:920px;margin:auto;padding:24px}.top,.card{background:color-mix(in srgb,var(--card) 94%,transparent);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:14px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center}.brand{font-size:20px;font-weight:750}.muted{color:var(--muted)}.id{font:600 18px ui-monospace,monospace;word-break:break-all}.row,.actions,.connection{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.connection{justify-content:space-between;border-top:1px solid var(--line);padding:12px 0}.connection:first-child{border-top:0}button,a.button{border:1px solid var(--line);border-radius:10px;background:#132b40;color:#eff9ff;padding:9px 12px;text-decoration:none;cursor:pointer}button:hover,a.button:hover{border-color:var(--accent)}button.danger{border-color:#743346;color:#ffdbe2}button.primary{border-color:#237ca3}.paused{color:#ffd166}.live{color:var(--ok)}dialog{background:var(--card);color:inherit;border:1px solid var(--line);border-radius:14px;max-width:440px}dialog::backdrop{background:#0009}@media(max-width:600px){main{padding:12px}.top{align-items:flex-start;flex-direction:column}.actions>*{flex:1;text-align:center}}
</style></head><body><main><section class="top"><div><div class="brand">aiDesk.to <span class="muted">by IM.codes</span></div><div id="status"></div></div><div class="actions"><a id="manage" class="button" target="_blank" rel="noreferrer"></a><a id="share" class="button" target="_blank" rel="noreferrer"></a></div></section><section class="card"><div class="muted" id="idLabel"></div><div class="row"><div class="id" id="nodeId"></div><button id="copy"></button></div></section><section class="card"><div class="row"><button id="pause" class="primary"></button><button id="stop" class="danger"></button></div><p class="muted" id="pauseHelp"></p></section><section class="card"><h2 id="connectionsTitle"></h2><div id="connections"></div></section></main><dialog id="confirm"><h3 id="confirmTitle"></h3><p id="confirmText"></p><div class="actions"><button id="cancel"></button><button id="confirmAction" class="danger"></button></div></dialog><script>
const B=${bootstrap};
const T={en:{manage:'Web management',share:'Share',id:'Public ID',copy:'Copy',copied:'Copied',paused:'Remote access paused',idle:'No active connections',active:'{{n}} active connection(s)',pause:'Pause remote access',resume:'Resume remote access',pauseHelp:'Pausing disconnects every current connection and blocks all new viewing and control until you resume.',stop:'Stop all current connections',connections:'Connections',anonymous:'User',view:'Viewing',control:'Controlling',since:'Connected',duration:'Duration',disconnect:'Disconnect',cancel:'Cancel',confirm:'Confirm',disconnectTitle:'Disconnect this connection?',disconnectText:'Only this connection will end.',stopTitle:'Stop all current connections?',stopText:'Click confirm once more to disconnect every current viewer and controller. Remote access remains enabled for future connections.'},'zh-CN':{manage:'网页管理',share:'分享',id:'本机公共 ID',copy:'复制',copied:'已复制',paused:'远程访问已暂停',idle:'当前无人连接',active:'当前 {{n}} 个连接',pause:'暂停远程访问',resume:'恢复远程访问',pauseHelp:'暂停会立即断开全部现有连接，并拒绝所有新的查看和控制，直到恢复。',stop:'停止所有当前连接',connections:'连接列表',anonymous:'用户',view:'查看',control:'控制',since:'连接时间',duration:'时长',disconnect:'断开',cancel:'取消',confirm:'再次确认',disconnectTitle:'断开此连接？',disconnectText:'仅会结束这一条连接。',stopTitle:'停止所有当前连接？',stopText:'再次确认后将断开全部当前查看者和控制者；以后仍可重新连接。'},'zh-TW':{manage:'網頁管理',share:'分享',id:'本機公開 ID',copy:'複製',copied:'已複製',paused:'遠端存取已暫停',idle:'目前無人連線',active:'目前 {{n}} 個連線',pause:'暫停遠端存取',resume:'恢復遠端存取',pauseHelp:'暫停會立即中斷全部現有連線，並拒絕新的檢視和控制，直到恢復。',stop:'停止所有目前連線',connections:'連線清單',anonymous:'使用者',view:'檢視',control:'控制',since:'連線時間',duration:'時間',disconnect:'中斷',cancel:'取消',confirm:'再次確認',disconnectTitle:'中斷此連線？',disconnectText:'只會結束這一條連線。',stopTitle:'停止所有目前連線？',stopText:'再次確認後將中斷全部目前檢視者和控制者；之後仍可重新連線。'},es:{manage:'Administración web',share:'Compartir',id:'ID público',copy:'Copiar',copied:'Copiado',paused:'Acceso remoto en pausa',idle:'Sin conexiones activas',active:'{{n}} conexión(es) activa(s)',pause:'Pausar acceso remoto',resume:'Reanudar acceso remoto',pauseHelp:'La pausa desconecta todo y bloquea nuevas conexiones hasta reanudar.',stop:'Detener conexiones actuales',connections:'Conexiones',anonymous:'Usuario',view:'Vista',control:'Control',since:'Conectado',duration:'Duración',disconnect:'Desconectar',cancel:'Cancelar',confirm:'Confirmar de nuevo',disconnectTitle:'¿Desconectar esta conexión?',disconnectText:'Solo finalizará esta conexión.',stopTitle:'¿Detener todas las conexiones?',stopText:'Confirma de nuevo para desconectar a todos. El acceso seguirá habilitado.'},ru:{manage:'Веб-управление',share:'Поделиться',id:'Публичный ID',copy:'Копировать',copied:'Скопировано',paused:'Удалённый доступ приостановлен',idle:'Нет активных подключений',active:'Активных подключений: {{n}}',pause:'Приостановить доступ',resume:'Возобновить доступ',pauseHelp:'Пауза отключает всех и блокирует новые подключения до возобновления.',stop:'Остановить текущие подключения',connections:'Подключения',anonymous:'Пользователь',view:'Просмотр',control:'Управление',since:'Подключён',duration:'Длительность',disconnect:'Отключить',cancel:'Отмена',confirm:'Подтвердить ещё раз',disconnectTitle:'Отключить это подключение?',disconnectText:'Будет завершено только это подключение.',stopTitle:'Остановить все подключения?',stopText:'Подтвердите ещё раз, чтобы отключить всех. Доступ останется включён.'},ja:{manage:'Web 管理',share:'共有',id:'公開 ID',copy:'コピー',copied:'コピー済み',paused:'リモートアクセス一時停止中',idle:'接続なし',active:'接続中: {{n}}',pause:'リモートアクセスを一時停止',resume:'リモートアクセスを再開',pauseHelp:'一時停止すると全接続を切断し、再開まで新しい閲覧・操作を拒否します。',stop:'現在の全接続を停止',connections:'接続一覧',anonymous:'ユーザー',view:'閲覧',control:'操作',since:'接続時刻',duration:'経過時間',disconnect:'切断',cancel:'キャンセル',confirm:'もう一度確認',disconnectTitle:'この接続を切断しますか？',disconnectText:'この接続だけを終了します。',stopTitle:'現在の全接続を停止しますか？',stopText:'もう一度確認すると全員を切断します。以後のアクセスは有効なままです。'},ko:{manage:'웹 관리',share:'공유',id:'공개 ID',copy:'복사',copied:'복사됨',paused:'원격 액세스 일시 중지됨',idle:'활성 연결 없음',active:'활성 연결 {{n}}개',pause:'원격 액세스 일시 중지',resume:'원격 액세스 재개',pauseHelp:'일시 중지하면 모든 연결을 끊고 재개할 때까지 새 보기와 제어를 거부합니다.',stop:'현재 모든 연결 중지',connections:'연결 목록',anonymous:'사용자',view:'보기',control:'제어',since:'연결 시간',duration:'기간',disconnect:'연결 끊기',cancel:'취소',confirm:'다시 확인',disconnectTitle:'이 연결을 끊을까요?',disconnectText:'이 연결만 종료합니다.',stopTitle:'현재 모든 연결을 중지할까요?',stopText:'다시 확인하면 모두 연결 해제됩니다. 이후 원격 액세스는 계속 허용됩니다.'}};
const lang=(navigator.language||'en').toLowerCase();const key=lang.startsWith('zh-tw')||lang.startsWith('zh-hk')?'zh-TW':lang.startsWith('zh')?'zh-CN':lang.startsWith('es')?'es':lang.startsWith('ru')?'ru':lang.startsWith('ja')?'ja':lang.startsWith('ko')?'ko':'en';const t=(k,n)=>T[key][k].replace('{{n}}',String(n??''));const E=Object.fromEntries(['status','manage','share','idLabel','nodeId','copy','pause','stop','pauseHelp','connectionsTitle','connections','confirm','confirmTitle','confirmText','cancel','confirmAction'].map(id=>[id,document.getElementById(id)]));document.documentElement.lang=key;E.nodeId.textContent=B.publicNodeId;E.idLabel.textContent=t('id');E.copy.textContent=t('copy');E.manage.textContent=t('manage');E.manage.href=B.manageUrl;E.share.textContent=t('share');E.share.href=B.shareUrl;E.connectionsTitle.textContent=t('connections');E.pauseHelp.textContent=t('pauseHelp');E.cancel.textContent=t('cancel');
let state=null,pending=null;const fmt=(ms)=>{const s=Math.max(0,Math.floor(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0'):String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};function draw(){if(!state)return;E.status.className=state.paused?'paused':state.connections.length?'live':'muted';E.status.textContent=state.paused?t('paused'):state.connections.length?t('active',state.connections.length):t('idle');E.pause.textContent=state.paused?t('resume'):t('pause');E.connections.replaceChildren(...state.connections.map(c=>{const row=document.createElement('div');row.className='connection';const text=document.createElement('div');const name=document.createElement('strong');name.textContent=t('anonymous')+' '+c.label;const detail=document.createElement('div');detail.className='muted';detail.append((c.mode===B.modes.CONTROL?t('control'):t('view'))+' · '+t('since')+' '+new Date(c.connectedAt).toLocaleString()+' · '+t('duration')+' ');const duration=document.createElement('span');duration.dataset.since=String(c.connectedAt);detail.append(duration);text.append(name,detail);const b=document.createElement('button');b.className='danger';b.textContent=t('disconnect');b.onclick=()=>ask(B.actions.DISCONNECT,c.id);row.append(text,b);return row}));tick()}function tick(){document.querySelectorAll('[data-since]').forEach(e=>e.textContent=fmt(Date.now()-Number(e.dataset.since)))}async function load(){const r=await fetch(B.statePath,{cache:'no-store'});if(r.ok){state=await r.json();draw()}}async function act(action,id){const r=await fetch(B.actionPath,{method:'POST',headers:{'content-type':'application/json',[B.csrfHeader]:B.csrf},body:JSON.stringify({action,id})});if(r.ok)await load()}function ask(action,id){pending={action,id};E.confirmTitle.textContent=t(action===B.actions.DISCONNECT?'disconnectTitle':'stopTitle');E.confirmText.textContent=t(action===B.actions.DISCONNECT?'disconnectText':'stopText');E.confirmAction.textContent=t('confirm');E.confirm.showModal()}E.copy.onclick=async()=>{await navigator.clipboard.writeText(B.publicNodeId);E.copy.textContent=t('copied');setTimeout(()=>E.copy.textContent=t('copy'),1200)};E.pause.onclick=()=>act(state.paused?B.actions.RESUME:B.actions.PAUSE);E.stop.onclick=()=>ask(B.actions.STOP_ALL);E.cancel.onclick=()=>{pending=null;E.confirm.close()};E.confirmAction.onclick=()=>{const p=pending;pending=null;E.confirm.close();if(p)act(p.action,p.id)};setInterval(tick,1000);setInterval(load,2000);load();
</script></body></html>`;
}

export async function startRemoteDesktopLocalPanel(
  options: RemoteDesktopLocalPanelOptions,
): Promise<RemoteDesktopLocalPanel> {
  const host = options.host ?? REMOTE_DESKTOP_LOCAL_MANAGEMENT.HOST;
  const port = options.port ?? REMOTE_DESKTOP_LOCAL_MANAGEMENT.PORT;
  const sessions = new Map<string, { csrf: string; expiresAt: number }>();
  let expectedHost = `${host}:${port}`;
  let origin = `http://${expectedHost}`;
  let mutation: Promise<void> = Promise.resolve();
  const mutate = async (action: () => Promise<void>): Promise<void> => {
    const current = mutation.then(action, action);
    mutation = current.catch(() => {});
    await current;
  };
  const server: Server = createServer(async (request, response) => {
    if (request.headers.host !== expectedHost) return reply(response, 421, 'misdirected');
    const url = new URL(request.url ?? '/', origin);
    const cookie = cookies(request)[REMOTE_DESKTOP_LOCAL_MANAGEMENT.COOKIE_NAME];
    if (request.method === 'GET' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.ROOT_PATH) {
      const now = Date.now();
      for (const [key, value] of sessions) {
        if (value.expiresAt <= now) sessions.delete(key);
      }
      while (sessions.size >= MAX_PANEL_SESSIONS) {
        const oldest = sessions.keys().next().value as string | undefined;
        if (!oldest) break;
        sessions.delete(oldest);
      }
      const session = randomBytes(32).toString('base64url');
      const csrf = randomBytes(32).toString('base64url');
      sessions.set(session, { csrf, expiresAt: now + PANEL_SESSION_TTL_MS });
      response.setHeader('set-cookie', `${REMOTE_DESKTOP_LOCAL_MANAGEMENT.COOKIE_NAME}=${session}; HttpOnly; SameSite=Strict; Path=/`);
      return reply(response, 200, panelHtml({
        publicNodeId: options.publicNodeId,
        manageUrl: managementUrl(options.serverUrl, options.publicNodeId, REMOTE_DESKTOP_LOCAL_WEB_ACTION.MANAGE),
        shareUrl: managementUrl(options.serverUrl, options.publicNodeId, REMOTE_DESKTOP_LOCAL_WEB_ACTION.SHARE),
        csrf,
      }), 'text/html; charset=utf-8');
    }
    const session = typeof cookie === 'string' ? sessions.get(cookie) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (typeof cookie === 'string') sessions.delete(cookie);
      return reply(response, 401, 'unauthorized');
    }
    if (request.method === 'GET' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.STATE_PATH) {
      return reply(response, 200, JSON.stringify({ publicNodeId: options.publicNodeId, ...options.status() }), 'application/json; charset=utf-8');
    }
    if (request.method === 'POST' && url.pathname === REMOTE_DESKTOP_LOCAL_MANAGEMENT.ACTION_PATH) {
      const csrfHeader = request.headers[REMOTE_DESKTOP_LOCAL_MANAGEMENT.CSRF_HEADER];
      if (request.headers.origin !== origin
        || typeof csrfHeader !== 'string'
        || !secureEqual(csrfHeader, session.csrf)) {
        return reply(response, 403, 'forbidden');
      }
      const body = await readJson(request);
      const action = body?.action as RemoteDesktopLocalAction | undefined;
      let found = true;
      try {
        if (action === REMOTE_DESKTOP_LOCAL_ACTION.PAUSE) {
          await mutate(() => options.setPaused(true));
        } else if (action === REMOTE_DESKTOP_LOCAL_ACTION.RESUME) {
          await mutate(() => options.setPaused(false));
        } else if (action === REMOTE_DESKTOP_LOCAL_ACTION.STOP_ALL) {
          await mutate(options.stopAll);
        } else if (action === REMOTE_DESKTOP_LOCAL_ACTION.DISCONNECT && typeof body?.id === 'string') {
          await mutate(async () => { found = await options.disconnect(body.id as string); });
          if (!found) return reply(response, 404, 'not_found');
        } else return reply(response, 400, 'invalid_action');
      } catch {
        return reply(response, 500, 'action_failed');
      }
      return reply(response, 200, '{"ok":true}', 'application/json; charset=utf-8');
    }
    return reply(response, 404, 'not_found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('remote_desktop_local_panel_address_unavailable');
  }
  expectedHost = `${host}:${address.port}`;
  origin = `http://${expectedHost}`;
  return {
    url: `${origin}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
