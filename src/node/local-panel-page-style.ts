/**
 * The local panel's stylesheet. One self-contained document: no @import, no url() other than inline data, no web fonts.
 *
 * It has to render in WKWebView (macOS 12 = Safari 15.0), WebView2 and Chromium, so it uses none of: :has(), container queries,
 * subgrid, color-mix(), <dialog>, aspect-ratio, dvh/svh, nesting, @layer. `local-panel-page.test.ts` scans this text for them.
 */
export const LOCAL_PANEL_PAGE_CSS = `
:root{color-scheme:light dark;
--bg:#f4f6fa;--rail:#ffffff;--surface:#ffffff;--surface-2:#f1f4f9;--line:#dfe4ec;--text:#0f1a2b;--muted:#566377;
--brand:#1d5fd6;--brand-hover:#174db0;--on-brand:#ffffff;--brand-soft:#e6efff;
--ok:#0f7b45;--ok-soft:#e1f5e9;--ok-solid:#0f7b45;--on-ok:#ffffff;--knob:#ffffff;
--warn:#8a4b00;--warn-soft:#fff1d6;--warn-line:#f1c777;--danger:#b4232c;--danger-soft:#fde8ea;--focus:#1d5fd6;--scrim:rgba(15,26,43,.45);
--shadow:0 1px 2px rgba(15,26,43,.06),0 4px 14px rgba(15,26,43,.05)}
@media (prefers-color-scheme:dark){:root{
--bg:#0e141d;--rail:#121a25;--surface:#161f2c;--surface-2:#1b2635;--line:#26344a;--text:#e8eef8;--muted:#9aa9bf;
--brand:#5b9bff;--brand-hover:#7db0ff;--on-brand:#06172f;--brand-soft:#16294a;
--ok:#4fd18b;--ok-soft:#123324;--ok-solid:#4fd18b;--on-ok:#052b1a;--knob:#e8eef8;
--warn:#f6c26b;--warn-soft:#33260c;--warn-line:#6b4d12;--danger:#ff8a93;--danger-soft:#3a181c;--focus:#7db0ff;--scrim:rgba(0,0,0,.6);
--shadow:0 1px 2px rgba(0,0,0,.4)}}
[hidden]{display:none!important}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC","PingFang TC","Hiragino Sans","Apple SD Gothic Neo","Segoe UI","Microsoft YaHei UI","Yu Gothic UI","Malgun Gothic",system-ui,"Noto Sans","Noto Sans CJK SC",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
button,select{font:inherit;color:inherit}
:focus{outline:2px solid var(--focus);outline-offset:2px}
:focus:not(:focus-visible){outline:none}
.app{display:grid;grid-template-columns:84px minmax(0,1fr);height:100%;min-height:0}
.rail{background:var(--rail);border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:stretch;padding:12px 6px;gap:4px}
.logo{width:36px;height:36px;border-radius:10px;background:var(--brand);color:var(--on-brand);display:flex;align-items:center;justify-content:center;margin:2px auto 12px;font-weight:800;font-size:15px}
.nav{display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 2px;border-radius:8px;color:var(--muted);background:none;border:0;font-size:11px;text-align:center;line-height:1.2;overflow-wrap:anywhere;cursor:pointer;position:relative}
.nav svg{width:20px;height:20px;flex:none}
.nav:hover{background:var(--surface-2);color:var(--text)}
.nav[aria-current=page]{background:var(--brand-soft);color:var(--brand);font-weight:600}
.badge{position:absolute;top:2px;right:10px;min-width:16px;height:16px;border-radius:8px;background:var(--brand);color:var(--on-brand);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px}
.badge.ctl{background:var(--warn);color:var(--surface)}
main{min-width:0;min-height:0;display:flex;flex-direction:column}
.page{padding:18px 22px 10px;display:flex;flex-direction:column;gap:14px;min-height:0;flex:1;overflow:auto}
.footer{padding:6px 22px 10px;color:var(--muted);font-size:11px;display:flex;justify-content:space-between;gap:12px}
h1,h2,h3{margin:0}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px 3px 8px;font-size:12px;font-weight:600;background:var(--surface-2);color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}
.pill.online{background:var(--ok-soft);color:var(--ok)}
.pill.busy{background:var(--brand-soft);color:var(--brand)}
.pill.paused{background:var(--warn-soft);color:var(--warn)}
.banner{display:flex;align-items:center;gap:12px;background:var(--warn-soft);border:1px solid var(--warn-line);color:var(--warn);border-radius:8px;padding:9px 12px}
.banner.offline{background:var(--danger-soft);border-color:var(--danger);color:var(--danger)}
.banner svg{width:18px;height:18px;flex:none}
.banner .grow{flex:1;min-width:0}
.banner b{color:var(--text);display:block}
.banner p{margin:0;color:var(--muted)}
.top{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;flex:none;align-items:stretch}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:16px 18px}
.hero{display:grid;grid-template-columns:minmax(0,1fr);gap:16px 28px;align-items:center;align-content:center}
.eyebrow{font-size:12px;color:var(--muted);margin:0 0 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.devname{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.id-row{display:flex;align-items:center;gap:8px;min-width:0}
.id{white-space:nowrap;font:600 32px/1.15 ui-monospace,"SF Mono",Menlo,"Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;letter-spacing:.04em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;min-width:0}
.icon-btn{width:34px;height:34px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--muted);display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.icon-btn:hover{color:var(--text);border-color:var(--muted)}
.icon-btn svg{width:16px;height:16px}
.icon-btn.done{color:var(--ok);border-color:var(--ok)}
.controls{display:flex;flex-direction:column;gap:12px;align-items:stretch;min-width:0}
.switch-row{display:flex;align-items:center;gap:12px;justify-content:space-between}
.switch-row .txt{min-width:0}
.switch-row .txt b{display:block;font-size:13px}
.switch-row .txt span{color:var(--muted);font-size:12px;display:block}
.switch{position:relative;display:inline-grid;align-items:center;min-width:76px;height:32px;border-radius:16px;border:1px solid var(--line);background:var(--surface-2);color:var(--muted);cursor:pointer;flex:none;padding:0;font-weight:700;font-size:12px;white-space:nowrap;transition:background .15s,border-color .15s}
.sw-text{grid-area:1/1;display:flex;align-items:center;gap:4px;transition:opacity .15s}
.sw-on{padding:0 36px 0 12px;opacity:0;color:var(--on-ok);justify-content:flex-start}
.sw-off{padding:0 12px 0 36px;opacity:1;justify-content:flex-end}
.sw-on svg{width:12px;height:12px}
.switch::after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:var(--knob);box-shadow:0 1px 2px rgba(0,0,0,.35);transition:left .15s}
.switch[aria-checked=true]{background:var(--ok-solid);border-color:var(--ok-solid);color:var(--on-ok)}
.switch[aria-checked=true]::after{left:calc(100% - 27px)}
.switch[aria-checked=true] .sw-on{opacity:1}
.switch[aria-checked=true] .sw-off{opacity:0}
.switch[disabled]{opacity:.6;cursor:progress}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--text);padding:6px 12px;font-weight:600;cursor:pointer;min-height:32px}
.btn svg{width:15px;height:15px;flex:none}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--brand);border-color:var(--brand);color:var(--on-brand)}
.btn.primary:hover{background:var(--brand-hover);border-color:var(--brand-hover)}
.btn.danger{color:var(--danger)}
.btn.danger:hover{background:var(--danger-soft);border-color:var(--danger)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.btn.small{min-height:26px;padding:2px 9px;font-size:12px}
.perms h2{font-size:14px;margin-bottom:8px}
.perm{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}
.perm:first-of-type{border-top:0}
.perm>svg{width:18px;height:18px;flex:none;grid-row:1/3;color:var(--muted)}
.perm .t{font-weight:600;overflow-wrap:anywhere}
.perm .s{font-size:12px;color:var(--muted);grid-column:2}
.perm .help{grid-column:2;font-size:12px;color:var(--muted);margin-top:2px}
.perm .btn{grid-column:2;grid-row:auto;justify-self:start;margin-top:6px}
.perm.ok>svg,.perm.ok .s{color:var(--ok)}
.perm.bad>svg,.perm.bad .s{color:var(--warn)}
.perm.bad .s{font-weight:600}
.section{display:flex;flex-direction:column;min-height:0;flex:1}
.section-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.section-head h2{font-size:14px}
.section-head .grow{flex:1}
.count{font-size:12px;font-weight:700;border-radius:999px;background:var(--surface-2);color:var(--muted);padding:1px 8px}
.count.live{background:var(--brand-soft);color:var(--brand)}
.list{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:auto;min-height:96px;flex:1}
.conn{display:flex;align-items:center;gap:12px;padding:10px 14px;border-top:1px solid var(--line)}
.conn:first-child{border-top:0}
.conn.ctl{background:linear-gradient(90deg,var(--warn-soft),transparent 55%)}
.avatar{width:34px;height:34px;border-radius:50%;background:var(--surface-2);color:var(--muted);display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}
.conn.ctl .avatar{background:var(--warn-soft);color:var(--warn);box-shadow:0 0 0 2px var(--warn-line)}
.conn .main{flex:1;min-width:0}
.conn .name{font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.conn .meta{color:var(--muted);font-size:12px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.chip{font-size:11px;font-weight:700;border-radius:6px;padding:1px 7px;background:var(--surface-2);color:var(--muted)}
.chip.ctl{background:var(--warn-soft);color:var(--warn)}
.empty{height:100%;min-height:96px;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:var(--muted)}
.empty svg{width:56px;height:56px;color:var(--line);margin:0 auto 8px;display:block}
.empty b{display:block;color:var(--text);font-size:14px;margin-bottom:2px}
.form{display:flex;flex-direction:column;gap:14px;max-width:560px}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-weight:600}
.field .hint{color:var(--muted);font-size:12px}
select{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 10px;min-height:34px;max-width:100%}
select:hover{border-color:var(--muted)}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 18px;max-width:560px}
.kv dt{color:var(--muted)}
.kv dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.about-brand{font-size:20px;font-weight:700;margin-bottom:12px}
.modal{position:fixed;left:0;top:0;right:0;bottom:0;background:var(--scrim);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10}
.dialog{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:18px;max-width:440px;width:100%}
.dialog h2{font-size:15px;margin-bottom:6px}
.dialog p{margin:0 0 14px;color:var(--muted)}
.dialog .actions{justify-content:flex-end}
.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:var(--text);color:var(--bg);border-radius:8px;padding:8px 14px;font-weight:600;z-index:20;max-width:90%}
@media (min-width:860px){
.top.has-perms{grid-template-columns:minmax(0,1fr) minmax(270px,330px)}
.top:not(.has-perms) .hero{grid-template-columns:auto minmax(250px,1fr)}
}
@media (min-width:1240px){
.top.has-perms .hero{grid-template-columns:auto minmax(250px,1fr)}
}
@media (max-width:620px){
.app{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
.rail{flex-direction:row;border-right:0;border-bottom:1px solid var(--line);padding:6px 8px;align-items:center;gap:2px;overflow-x:auto}
.logo{margin:0 8px 0 0}
.nav{flex-direction:row;padding:6px 10px;font-size:12px;gap:6px}
.badge{position:static;margin-left:2px}
.page{padding:14px 14px 8px}
.id{font-size:24px}
.footer{padding:6px 14px 10px}
}
@media (max-height:520px){
.page{padding-top:12px;gap:10px}
.empty svg{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media (forced-colors:active){
.switch{border:2px solid ButtonText;forced-color-adjust:none;background:Canvas;color:ButtonText}
.switch::after{background:ButtonText}
.switch[aria-checked=true]{background:Highlight;color:HighlightText;border-color:Highlight}
.switch[aria-checked=true]::after{background:HighlightText}
.pill,.chip,.count,.badge{border:1px solid ButtonText}
.card,.list,.btn,.icon-btn{border-color:ButtonText}
}
`;
