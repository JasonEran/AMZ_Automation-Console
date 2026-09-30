import { OPERATOR_LESSONS, ONBOARDING_STYLES, ONBOARDING_ENTRY, ONBOARDING_MARKUP, installOperatorTour, normalizeTourRecord } from './onboarding.js';
import { STORE_SETTINGS_STYLES, STORE_SETTINGS_MARKUP, installStoreSettings } from './store-settings.js';
import { UI_DEFAULTS } from '../lib/ui-config.js';
import fs from 'node:fs';

// Trusted local assets are bundled with the shell, with no extra document
// navigation or stylesheet/script requests when the intelligence view opens.
const intelligenceAsset = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const INTELLIGENCE_MARKUP = intelligenceAsset('intelligence.html');
const INTELLIGENCE_STYLES = intelligenceAsset('intelligence.css');
const INTELLIGENCE_CLIENT = intelligenceAsset('intelligence-client.js');

/** Short place label for one page-evidence business matter, plus its existing feature page. */
export function businessItemPlace(issue, checks) {
  const pages = {
    'store-health': 'store-risk',
    performance: 'store-risk',
    feedback: 'customer-voice',
    inbox: 'customer-voice',
    reviews: 'customer-voice',
    voc: 'customer-voice',
    'asin-health': 'product-status',
    outlet: 'product-status',
    'ads-status': 'ads-watch',
  };
  const source = issue && typeof issue === 'object' ? issue : {};
  const list = Array.isArray(checks) ? checks : [];
  const check = list.find((item) => item && item.id === source.checkId);
  const area = (check && check.short) || source.checkTitle || source.checkId || '检查项';
  const storeName = source.storeName || source.storeKey || '店铺';
  const view = Object.prototype.hasOwnProperty.call(pages, source.checkId) ? pages[source.checkId] : null;
  return { label: storeName + ' · ' + area, view };
}

/**
 * Single-file operations dashboard. It intentionally has no build step or
 * third-party assets, so the collector can serve it anywhere Node runs.
 */
export function renderDashboard({ crmReadOnly = false } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>店铺自动化工作台</title>
<style>
  :root{
    --bg:#f2f4f1;--panel:#ffffff;--panel-soft:#f8f9f6;--ink:#14201c;--muted:#66736d;
    --line:#dfe5e0;--side:#14221d;--side-muted:#95a59e;--accent:#c9f36a;--accent-ink:#193014;
    --ok:#23875a;--ok-soft:#e7f5ed;--warn:#b87813;--warn-soft:#fff3d7;
    --bad:#d9534f;--bad-soft:#fce9e7;--error:#7651a8;--error-soft:#f1eafa;--idle:#7c8983;--idle-soft:#edf0ee;
    --shadow:0 12px 35px rgba(19,34,28,.07);--radius:16px;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;overflow-x:hidden}
  button,input,select{font:inherit}
  button{color:inherit}
  a{color:inherit;text-decoration:none}
  .app{min-height:100vh;width:100%;display:grid;grid-template-columns:224px minmax(0,1fr)}
  .sidebar{position:sticky;top:0;height:100vh;background:var(--side);color:#fff;padding:24px 16px;display:flex;flex-direction:column;z-index:20}
  .brand{display:flex;align-items:center;gap:11px;padding:0 8px 26px}
  .brandmark{width:34px;height:34px;border-radius:10px;background:var(--accent);display:grid;place-items:center;color:var(--accent-ink);font-weight:900;font-size:12px;letter-spacing:-1px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
  .brand b{display:block;font-size:15px;letter-spacing:.2px}
  .brand small{display:block;color:var(--side-muted);font-size:11px;margin-top:1px}
  .navlabel{padding:0 10px;margin:7px 0 8px;color:#70827a;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase}
  .nav{display:grid;gap:4px}
  .nav a{display:flex;align-items:center;gap:10px;padding:10px 11px;border-radius:9px;color:var(--side-muted);font-size:13px;font-weight:550}
  .nav a:hover,.nav a.active{background:#24372f;color:#fff}
  .navicon{width:18px;height:18px;border:1px solid currentColor;border-radius:5px;display:grid;place-items:center;font-size:9px}
  .sidefoot{margin-top:auto;border-top:1px solid #2c3d36;padding:17px 8px 0}
  .live{display:flex;align-items:center;gap:8px;font-size:12px}
  .pulse{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px rgba(201,243,106,.12)}
  .sidefoot p{color:var(--side-muted);font-size:11px;margin:8px 0 0;line-height:1.5}
  .main{min-width:0}
  .topbar{height:72px;padding:0 30px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;background:rgba(242,244,241,.94);position:sticky;top:0;z-index:15;backdrop-filter:blur(10px)}
  .topbar h1{font-size:16px;margin:0;font-weight:700}
  .topbar .crumb{color:var(--muted);font-size:12px;margin-top:1px}
  .spacer{flex:1}
  .sync{color:var(--muted);font-size:12px;text-align:right}
  .sync b{display:block;color:var(--ink);font-weight:600}
  .refresh{border:1px solid var(--line);background:var(--panel);width:36px;height:36px;border-radius:10px;cursor:pointer;font-size:18px;line-height:1}
  .refresh:hover{border-color:#aab5af;background:var(--panel-soft)}
  .logout-form{margin:0}.logout{border:1px solid var(--line);background:transparent;height:36px;border-radius:10px;padding:0 12px;cursor:pointer;color:var(--muted);font-size:12px}.logout:hover{border-color:#aab5af;background:var(--panel);color:var(--ink)}
  .content{padding:26px 30px 54px;max-width:1680px;min-width:0;margin:0 auto;overflow:hidden}
  .view{display:none}.view.active{display:block}
  .page-intro{display:flex;align-items:flex-end;gap:20px;margin-bottom:14px}.page-intro h2{font-size:22px;line-height:1.2;margin:0}.page-intro p{margin:5px 0 0;color:var(--muted);font-size:12px}
  .error{display:none;background:var(--bad-soft);color:#9f302c;border:1px solid #f0c6c2;padding:12px 15px;border-radius:10px;margin-bottom:18px}
  .hero{background:var(--side);color:#fff;border-radius:var(--radius);padding:25px 28px;display:flex;align-items:center;gap:28px;box-shadow:var(--shadow);overflow:hidden;position:relative}
  .hero:after{content:"";position:absolute;right:32px;top:-36px;width:170px;height:170px;border:1px solid #385046;border-radius:50%;box-shadow:0 0 0 28px #1a2b24,0 0 0 29px #33483f;opacity:.75}
  .hero-copy{position:relative;z-index:1;flex:1}
  .eyebrow{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent);font-weight:750;margin-bottom:7px}
  .hero h2{font-size:25px;line-height:1.25;margin:0 0 7px;letter-spacing:-.4px}
  .hero p{margin:0;color:#aebbb5;font-size:13px}
  .overall{position:relative;z-index:1;min-width:172px;border:1px solid #40544b;background:#1c3028;border-radius:13px;padding:15px 17px}
  .overall small{color:#9cada5;font-size:11px;display:block;margin-bottom:7px}
  .overall .state{font-size:18px;font-weight:750;display:flex;align-items:center;gap:8px}
  .overall .state:before{content:"";width:9px;height:9px;border-radius:50%;background:currentColor}
  .overall .state.a-NORMAL{color:var(--accent)}.overall .state.a-BUSINESS{color:#ff837a}.overall .state.a-COLLECTION{color:#c7a7ef}.overall .state.a-PENDING{color:#b8c2bd}
  .overall .sub{color:#93a49c;font-size:11px;margin-top:5px}
  .kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:13px;margin:15px 0;align-items:start}
  .kpi{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:16px 17px;min-height:108px;display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 3px 12px rgba(20,32,28,.025)}
  .kpi-top{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:12px}
  .kpi-icon{width:28px;height:28px;border-radius:8px;background:var(--idle-soft);display:grid;place-items:center;color:var(--ink);font-size:11px;font-weight:800}
  .kpi-value{font-size:27px;line-height:1;font-weight:760;letter-spacing:-.8px;margin-top:9px}
  .kpi-value small{font-size:12px;color:var(--muted);font-weight:500;letter-spacing:0;margin-left:4px}
  .kpi-note{font-size:11px;color:var(--muted);margin-top:5px}
  .kpi-places{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:4px;max-height:220px;overflow:auto}
  .kpi-place{display:block;font-size:11px;line-height:1.35;color:var(--ink);background:var(--bad-soft);border-radius:7px;padding:4px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  a.kpi-place:hover{text-decoration:underline;text-underline-offset:2px}
  .progress{height:4px;background:var(--idle-soft);border-radius:99px;margin-top:9px;overflow:hidden}
  .progress span{display:block;height:100%;background:var(--ok);border-radius:99px}
  .readybar{margin-top:15px;background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:14px 16px;display:flex;align-items:center;gap:15px;box-shadow:0 3px 12px rgba(20,32,28,.025)}
  .ready-title{min-width:150px}.ready-title b{display:block;font-size:12px}.ready-title small{display:block;color:var(--muted);font-size:10px;margin-top:2px}
  .ready-items{display:flex;flex:1;gap:7px;overflow:auto;padding:2px 0}
  .ready-item{min-width:112px;background:var(--panel-soft);border:1px solid var(--line);border-radius:8px;padding:7px 9px;white-space:nowrap}
  .ready-item b{display:flex;align-items:center;gap:5px;font-size:10px}.ready-item b:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--bad)}
  .ready-item.ok b:before{background:var(--ok)}.ready-item.optional b:before{background:var(--warn)}
  .ready-item small{display:block;color:var(--muted);font-size:9px;margin-top:2px;overflow:hidden;text-overflow:ellipsis}
  .runbar{margin-top:15px;background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:14px 16px;display:grid;grid-template-columns:minmax(140px,.7fr) minmax(190px,2fr) auto;align-items:center;gap:16px}
  .run-title b{display:block;font-size:12px}.run-title small{display:block;color:var(--muted);font-size:10px;margin-top:2px}.run-track{height:7px;background:var(--idle-soft);border-radius:99px;overflow:hidden}.run-track span{display:block;height:100%;width:0;background:var(--ok);border-radius:99px;transition:width .25s}.run-value{font-size:11px;color:var(--muted);white-space:nowrap;text-align:right}.runbar.active{border-color:#b9d7c6}.runbar.failed{border-color:#d6c5ea;background:#fbf8ff}.runbar.failed .run-track span{background:var(--error)}
  .execution-panel{margin:18px 0;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}.execution-panel .runbar{margin:0 20px 18px;border:0;background:var(--panel-soft);grid-template-columns:minmax(200px,1.25fr) minmax(140px,1fr) auto}.execution-panel .run-title b{font-size:14px}.execution-panel .run-title small{font-size:11px;line-height:1.7}.execution-panel .run-track{height:10px}.execution-panel .run-value{font-size:15px;font-weight:700;color:var(--ink)}
  .run-connection{font-size:11px;color:var(--muted);white-space:nowrap}.run-connection.live{color:var(--ok)}.run-connection.delayed{color:var(--warn)}
  .runbar.active .run-title b:before{content:"";display:inline-block;width:12px;height:12px;border:2px solid #c4ddcf;border-top-color:var(--ok);border-radius:50%;margin-right:7px;vertical-align:-2px;animation:run-spin .9s linear infinite}.runbar.delayed .run-title b:before{border-top-color:var(--warn);animation:none}.runbar.delayed .run-track span{background:var(--warn)}
  .run-stores{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;padding:0 20px 18px}.run-store{display:flex;align-items:center;gap:12px;border:1px solid var(--line);border-radius:11px;padding:12px;min-width:0}.run-store.running{border-color:#a8c7e4;background:#f5faff}.run-store-copy{min-width:0}.run-store-copy b{display:block;font-size:12px}.run-store-copy small{display:block;font-size:10px;color:var(--muted);line-height:1.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.run-store-copy .execution-state{color:#316896;font-size:11px}
  .run-orbit{position:relative;display:inline-flex;width:48px;height:48px;flex:none;align-items:center;justify-content:center;color:var(--ok)}.run-orbit svg{position:absolute;inset:3px;width:42px;height:42px;transform:rotate(-90deg)}.run-orbit b{font-size:10px;font-variant-numeric:tabular-nums}.run-orbit circle{fill:none;stroke-width:3;stroke-linecap:round}.run-orbit .orbit-base{stroke:var(--line)}.run-orbit .orbit-value{stroke:currentColor;transition:stroke-dashoffset .3s}.run-orbit.e-QUEUED,.run-orbit.e-SKIPPED{color:var(--idle)}.run-orbit.e-RUNNING{color:#316896}.run-orbit.e-ERROR,.run-orbit.e-INTERRUPTED{color:var(--error)}.run-orbit.e-RUNNING:after{content:"";position:absolute;inset:0;border:1px solid transparent;border-top-color:currentColor;border-radius:50%;animation:run-spin 1.3s linear infinite}
  .run-spinner{width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;flex:none;border:2px solid currentColor;border-radius:50%;font-size:9px;line-height:1}.run-spinner.e-RUNNING{border-right-color:transparent;animation:run-spin .9s linear infinite}.run-spinner.e-QUEUED{opacity:.45;border-style:dotted}.run-spinner.e-COMPLETED,.run-spinner.e-ERROR,.run-spinner.e-INTERRUPTED{border-width:1px}.run-spinner.e-SKIPPED{border-width:1px;opacity:.6}
  @keyframes run-spin{to{transform:rotate(360deg)}}
  @media(prefers-reduced-motion:reduce){.run-spinner,.run-orbit.e-RUNNING:after,.runbar.active .run-title b:before{animation:none!important}.run-track span,.orbit-value{transition:none!important}}
  .section{scroll-margin-top:90px;margin-top:17px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 3px 15px rgba(20,32,28,.03)}
  .section-head{padding:18px 20px 15px;display:flex;align-items:flex-start;gap:14px;border-bottom:1px solid var(--line)}
  .section-head h3{margin:0;font-size:15px}
  .section-head p{margin:3px 0 0;color:var(--muted);font-size:12px}
  .controls{margin-left:auto;display:flex;gap:8px;align-items:center}
  .control{height:34px;border:1px solid var(--line);background:var(--panel-soft);border-radius:8px;padding:0 10px;color:var(--ink);outline:none}
  input.control{width:190px}
  .control:focus{border-color:#7c9187;box-shadow:0 0 0 3px rgba(35,135,90,.09)}
  .schedule{display:grid;grid-template-columns:repeat(4,1fr);padding:18px 20px;gap:0}
  .slot{position:relative;padding:2px 19px 2px 25px;min-height:58px;border-right:1px solid var(--line)}
  .slot:last-child{border-right:0}
  .slot:before{content:"";position:absolute;left:5px;top:7px;width:9px;height:9px;border:2px solid var(--idle);background:#fff;border-radius:50%}
  .slot.current:before{background:var(--accent);border-color:var(--side);box-shadow:0 0 0 4px var(--ok-soft)}
  .slot-time{font-size:17px;font-weight:740;font-variant-numeric:tabular-nums;line-height:1.2}
  .slot-name{font-size:12px;margin-top:4px}
  .slot-meta{font-size:10px;color:var(--muted);margin-top:2px}
  .matrix-wrap{overflow:auto;max-height:620px}
  table{width:100%;border-collapse:separate;border-spacing:0;min-width:1000px}
  th,td{border-bottom:1px solid var(--line);padding:11px 8px;text-align:center}
  thead th{position:sticky;top:0;background:#f8f9f7;z-index:4;color:var(--muted);font-size:10px;font-weight:650;white-space:nowrap}
  thead th:first-child{left:0;z-index:6;text-align:left;padding-left:20px;min-width:170px}
  tbody th{position:sticky;left:0;background:var(--panel);z-index:3;text-align:left;padding-left:20px;min-width:170px}
  tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
  tbody tr:hover td,tbody tr:hover th{background:#fbfcfa}
  .store-name{font-size:13px;font-weight:680;color:var(--ink)}
  .store-meta{font-size:10px;color:var(--muted);margin-top:2px;font-weight:500}
  .check-no{display:block;color:var(--ink);font-size:11px;margin-bottom:2px}
  .cell{width:70px;height:38px;border:1px solid transparent;border-radius:8px;cursor:pointer;font-size:10px;font-weight:680;display:inline-flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap}
  .cell:before,.status-dot{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
  .cell:hover{filter:brightness(.97);border-color:currentColor}
  .cell.s-OK{background:var(--ok-soft);color:var(--ok)}
  .cell.s-WARN{background:var(--warn-soft);color:var(--warn)}
  .cell.s-CRITICAL{background:var(--bad-soft);color:var(--bad)}
  .cell.s-ERROR{background:var(--error-soft);color:var(--error)}
  .cell.s-NOT_CONFIGURED,.cell.s-NOT_COVERED,.cell.s-NEVER_RUN,.cell.s-SKIPPED{background:var(--idle-soft);color:var(--idle)}
  .cell.has-execution{width:100px;min-height:46px;height:auto;padding:6px;gap:7px}.cell.has-execution:before{display:none}.cell.execution-running{background:#edf5fc;color:#316896;border-color:#bed6eb}.cell.execution-queued{background:#f5f6f4;color:var(--muted)}.cell.execution-interrupted{background:var(--error-soft);color:var(--error)}.cell-copy{display:block;text-align:left;min-width:0}.cell-copy b{display:block;font-size:10px}.cell-copy small{display:block;font-size:9px;font-weight:400;line-height:1.7;max-width:72px;overflow:hidden;text-overflow:ellipsis}.cell.execution-delayed .run-spinner{animation:none;border-style:dotted}.cell.execution-delayed{color:var(--warn)}
  .row-score{font-size:11px;color:var(--muted);white-space:nowrap}
  .legend{padding:12px 20px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:17px;color:var(--muted);font-size:11px}
  .legend span{display:flex;align-items:center;gap:6px}
  .legend .status-dot.ok{color:var(--ok)}.legend .status-dot.warn{color:var(--warn)}.legend .status-dot.bad{color:var(--bad)}.legend .status-dot.error{color:var(--error)}.legend .status-dot.idle{color:var(--idle)}
  .pager{min-height:48px;padding:10px 20px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:flex-end;gap:8px;color:var(--muted);font-size:11px}.pager button{height:29px;min-width:62px;padding:0 9px;border:1px solid var(--line);border-radius:7px;background:var(--panel);cursor:pointer}.pager button:hover:not(:disabled){border-color:#92a199}.pager button:disabled{opacity:.42;cursor:not-allowed}.pager b{color:var(--ink);font-weight:650;min-width:70px;text-align:center}
  .session-list{padding:6px 20px 10px}.session-row{display:grid;grid-template-columns:minmax(140px,.65fr) minmax(120px,.5fr) minmax(150px,.7fr) minmax(220px,1.2fr);gap:14px;align-items:center;padding:13px 2px;border-bottom:1px solid var(--line)}.session-row:last-child{border-bottom:0}.session-row b{font-size:12px}.session-row small{display:block;color:var(--muted);font-size:10px;margin-top:2px}.session-action{font-size:11px;color:var(--muted)}
  .two-col{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(340px,.85fr);gap:15px;margin-top:15px}
  .two-col .section{margin-top:0}
  .issue-list{padding:5px 20px 10px}
  .queue-title{display:flex;align-items:center;gap:8px;padding:13px 2px 5px;color:var(--muted);font-size:10px;font-weight:750;letter-spacing:.8px;text-transform:uppercase}.queue-title:after{content:"";height:1px;background:var(--line);flex:1}
  .issue{width:100%;display:grid;grid-template-columns:10px minmax(90px,.7fr) minmax(0,1.2fr) auto;gap:12px;align-items:center;padding:13px 2px;border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left;cursor:pointer}
  .issue:last-child{border-bottom:0}
  .issue:hover .issue-title{text-decoration:underline;text-decoration-color:#b7c3bd;text-underline-offset:3px}
  .issue-sev{width:8px;height:8px;border-radius:50%;background:var(--bad)}
  .issue-sev.WARN{background:var(--warn)}.issue-sev.ERROR{background:var(--error)}
  .issue-store{font-weight:680;font-size:12px}.issue-store small{display:block;color:var(--muted);font-weight:500}
  .issue-title{font-size:12px;font-weight:620}.issue-reason{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;max-width:420px}
  .badge{display:inline-flex;align-items:center;border-radius:99px;padding:3px 8px;font-size:10px;font-weight:700}
  .badge.s-OK{background:var(--ok-soft);color:var(--ok)}.badge.s-WARN{background:var(--warn-soft);color:var(--warn)}.badge.s-CRITICAL{background:var(--bad-soft);color:var(--bad)}.badge.s-ERROR{background:var(--error-soft);color:var(--error)}.badge.s-NOT_COVERED,.badge.s-NEVER_RUN,.badge.s-NOT_CONFIGURED,.badge.s-SKIPPED{background:var(--idle-soft);color:var(--idle)}
  .empty{padding:32px 20px;text-align:center;color:var(--muted);font-size:12px}
  .check-list{padding:8px 20px 14px}
  .check-item{display:grid;grid-template-columns:29px minmax(0,1fr) auto;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}
  .check-item:last-child{border-bottom:0}
  .number{width:27px;height:27px;border-radius:8px;background:var(--side);color:var(--accent);display:grid;place-items:center;font-size:10px;font-weight:800}
  .check-item b{font-size:12px;display:block}.check-item small{font-size:10px;color:var(--muted);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .coverage{font-size:10px;color:var(--muted);text-align:right}.coverage b{font-size:12px;color:var(--ink)}
  .asin-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:16px 20px 8px}.asin-stat{border:1px solid var(--line);background:var(--panel-soft);border-radius:10px;padding:11px 12px}.asin-stat small{display:block;color:var(--muted);font-size:10px}.asin-stat b{display:block;font-size:20px;margin-top:2px}.asin-list{padding:4px 20px 15px}.asin-row{display:grid;grid-template-columns:minmax(110px,.5fr) minmax(90px,.45fr) minmax(0,1.6fr) auto;gap:12px;align-items:center;border-top:1px solid var(--line);padding:11px 2px}.asin-row code{font-size:11px;font-weight:700}.asin-row small{display:block;color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.asin-row .next{font-size:10px;color:var(--muted);white-space:nowrap}
  .recommendation-list,.evidence-gap-list{padding:4px 20px 15px}.recommendation-row,.evidence-gap-row{display:grid;grid-template-columns:minmax(120px,.55fr) minmax(120px,.65fr) minmax(0,1.6fr) auto;gap:12px;align-items:center;border-top:1px solid var(--line);padding:11px 2px}.recommendation-row code{font-size:11px;font-weight:700}.recommendation-row small,.evidence-gap-row small{display:block;color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recommendation-row .reason,.evidence-gap-row .reason{white-space:normal;line-height:1.45}.evidence-summary,.upload-result-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:16px 20px 8px}.evidence-stat,.upload-result-stat{border:1px solid var(--line);background:var(--panel-soft);border-radius:10px;padding:11px 12px}.evidence-stat small,.upload-result-stat small{display:block;color:var(--muted);font-size:10px}.evidence-stat b,.upload-result-stat b{display:block;font-size:20px;margin-top:2px}.evidence-stat.bad b,.upload-result-stat.bad b{color:var(--bad)}
  .drawer-backdrop{display:none;position:fixed;inset:0;background:rgba(10,18,15,.35);z-index:40;backdrop-filter:blur(2px)}
  .drawer-backdrop.open{display:block}
  .drawer{position:absolute;right:0;top:0;width:min(500px,94vw);height:100%;background:var(--panel);box-shadow:-18px 0 45px rgba(10,20,15,.15);display:flex;flex-direction:column}
  .drawer-head{padding:23px 24px 18px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;gap:12px}
  .drawer-head h3{margin:0;font-size:17px}.drawer-head p{margin:3px 0 0;color:var(--muted);font-size:11px}
  .close{margin-left:auto;width:32px;height:32px;border-radius:8px;border:1px solid var(--line);background:#fff;cursor:pointer;font-size:18px}
  .drawer-body{padding:20px 24px 40px;overflow:auto}
  .detail-state{padding:14px 15px;border-radius:11px;background:var(--idle-soft);margin-bottom:17px;display:flex;justify-content:space-between;gap:12px;align-items:center}
  .detail-state.s-OK{background:var(--ok-soft);color:var(--ok)}.detail-state.s-WARN{background:var(--warn-soft);color:var(--warn)}.detail-state.s-CRITICAL{background:var(--bad-soft);color:var(--bad)}.detail-state.s-ERROR{background:var(--error-soft);color:var(--error)}
  .detail-state b{font-size:14px}.detail-state small{font-size:10px;display:block;opacity:.78}
  .detail-block{margin:20px 0}.detail-block h4{font-size:11px;color:var(--muted);letter-spacing:.8px;text-transform:uppercase;margin:0 0 9px}
  .detail-block ul{margin:0;padding-left:19px}.detail-block li{margin:5px 0;font-size:12px}
  .result{border:1px solid var(--line);border-radius:11px;padding:13px 14px;margin-bottom:9px}
  .result-head{display:flex;align-items:center;gap:8px}.result-head b{font-size:12px}.result-head .badge{margin-left:auto}
  .metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:11px}
  .metric{background:var(--panel-soft);border-radius:7px;padding:7px 9px;min-width:0}.metric small{color:var(--muted);display:block;font-size:9px;overflow:hidden;text-overflow:ellipsis}.metric b{font-size:11px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
  .shot{display:inline-block;margin-top:10px;color:var(--ok);font-size:11px;font-weight:650}
  .evidence{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.evidence span{font-size:10px;padding:4px 7px;border-radius:7px;background:var(--idle-soft);color:var(--muted)}.evidence span.ok{background:var(--ok-soft);color:var(--ok)}
  .item-list{display:grid;gap:8px}.item-card{border:1px solid var(--line);background:#fbfcfb;border-radius:9px;padding:10px}.item-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px}.item-field{min-width:0}.item-field.wide{grid-column:1/-1}.item-field small{display:block;color:var(--muted);font-size:9px;letter-spacing:.5px;margin-bottom:2px}.item-field b{display:block;font-size:11px;line-height:1.45;overflow-wrap:anywhere}.item-field b.unbound{color:var(--bad)}.brand-note{border-left:3px solid var(--warn);background:var(--warn-soft);padding:9px 11px;border-radius:7px;font-size:11px;line-height:1.55;margin:10px 0}
  .channel-list,.alert-list{padding:8px 20px 14px}.channel{display:grid;grid-template-columns:minmax(80px,1fr) auto;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}.channel:last-child{border-bottom:0}.channel b{font-size:12px}.channel small{display:block;color:var(--muted);font-size:10px}.alert-row{padding:11px 0;border-bottom:1px solid var(--line)}.alert-row:last-child{border-bottom:0}.alert-row-head{display:flex;gap:8px;align-items:center}.alert-row b{font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.alert-row time{margin-left:auto;color:var(--muted);font-size:9px;white-space:nowrap}.alert-row p{margin:4px 0 0;color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stale-note{color:var(--warn);font-weight:650}.history-trend{display:flex;gap:6px;overflow-x:auto;padding:8px 0}.history-day{flex:0 0 54px;border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:6px 3px;cursor:pointer;color:inherit;font:inherit;font-size:11px}.history-day i{display:block;height:25px;border-radius:4px;margin-bottom:5px;background:#c6ceca}.history-day i.OK{background:#6dab83}.history-day i.WARN{background:#ddba60}.history-day i.CRITICAL{background:#d68480}.history-day i.ERROR{background:#919bae}.history-day[aria-pressed="true"]{outline:2px solid var(--accent);outline-offset:-2px}.history-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0}.history-controls input,.history-controls select{font:inherit;padding:6px;border:1px solid var(--line);border-radius:6px;max-width:100%;background:var(--panel);color:inherit}.history-records{margin-top:12px}.history-records .result{margin:10px 0}.history-link{border:0;background:none;color:var(--ok);text-decoration:underline;cursor:pointer;padding:4px 0;font:inherit}.trend{display:flex;align-items:end;gap:4px;min-height:50px;padding:8px;background:var(--panel-soft);border-radius:8px}.trend i{display:block;flex:1;min-width:8px;border-radius:3px 3px 0 0;background:var(--ok);height:18px}.trend i.CRITICAL{background:var(--bad);height:42px}.trend i.ERROR{background:var(--error);height:46px}.trend i.WARN{background:var(--warn);height:31px}.trend i.NEVER_RUN,.trend i.NOT_CONFIGURED,.trend i.SKIPPED{background:var(--idle);height:10px}
  .write-warning{background:#fff8ed;border:1px solid #e8c990;border-radius:12px;padding:14px 16px;color:#70490c;font-size:12px;margin-bottom:15px}.write-warning b{display:block;color:#523506;margin-bottom:3px}
  .upload-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,.75fr);gap:15px}.upload-card{padding:20px}.upload-fields{display:grid;grid-template-columns:minmax(160px,.45fr) minmax(220px,1fr);gap:13px}.upload-field label{display:block;font-size:11px;font-weight:680;margin-bottom:6px}.upload-field select,.upload-field input[type=file],.upload-field input[type=text],.upload-field input[type=password]{width:100%;min-height:42px;border:1px solid var(--line);background:var(--panel-soft);border-radius:9px;padding:8px 10px;color:var(--ink)}.upload-field input:focus,.upload-field select:focus{outline:none;border-color:#7c9187;box-shadow:0 0 0 3px rgba(35,135,90,.09)}.upload-actions{display:flex;gap:9px;align-items:center;margin-top:15px}.primary,.secondary{height:38px;border-radius:8px;padding:0 14px;font-weight:680;font-size:12px;cursor:pointer}.primary{border:1px solid var(--side);background:var(--side);color:#fff}.primary:hover{background:#21372e}.primary:disabled,.secondary:disabled{opacity:.45;cursor:not-allowed}.secondary{border:1px solid var(--line);background:#fff;color:var(--ink)}.upload-note{color:var(--muted);font-size:10px;margin:9px 0 0}.upload-message{display:none;margin-top:13px;padding:10px 12px;border-radius:8px;font-size:11px}.upload-message.ok{display:block;background:var(--ok-soft);color:var(--ok)}.upload-message.bad{display:block;background:var(--bad-soft);color:var(--bad)}.upload-message.neutral{display:block;background:var(--idle-soft);color:var(--idle)}.confirm-card{display:none;border-top:1px solid var(--line);margin-top:18px;padding-top:18px}.confirm-card.open{display:block}.confirm-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-bottom:14px}.confirm-summary div{background:var(--panel-soft);padding:9px;border-radius:8px}.confirm-summary small{display:block;color:var(--muted);font-size:9px}.confirm-summary b{font-size:11px;display:block;margin-top:2px;overflow-wrap:anywhere}.ack{display:flex;gap:8px;align-items:flex-start;font-size:11px;margin:12px 0}.upload-history{padding:7px 20px 10px}.upload-row{display:grid;grid-template-columns:minmax(120px,.65fr) minmax(110px,.55fr) minmax(120px,.6fr) minmax(190px,1fr) auto;gap:12px;align-items:center;padding:12px 2px;border-bottom:1px solid var(--line)}.upload-row>div{min-width:0}.upload-row small{overflow-wrap:anywhere}.upload-row:last-child{border-bottom:0}.upload-row b{font-size:11px}.upload-row small{display:block;color:var(--muted);font-size:9px;margin-top:2px}.upload-result-line{white-space:normal!important;line-height:1.4}.upload-hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.upload-details{grid-column:1/-1;min-width:0;font-size:11px}.upload-details summary{cursor:pointer;font-weight:650}.upload-details pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;padding:12px;background:var(--panel-soft);border:1px solid var(--line);border-radius:8px;font:11px/1.6 ui-monospace,monospace}.upload-details p{overflow-wrap:anywhere;margin:7px 0}.upload-disabled{padding:20px;color:var(--muted)}
  .settings-card{padding:18px 20px}.settings-form{display:grid;grid-template-columns:repeat(3,minmax(140px,1fr)) auto;gap:10px;align-items:end}.settings-field label{display:block;font-size:10px;font-weight:700;margin-bottom:5px}.settings-field input,.settings-field select{width:100%;height:38px;border:1px solid var(--line);border-radius:8px;background:var(--panel-soft);padding:0 10px}.settings-message{display:none;margin-top:12px;padding:9px 11px;border-radius:8px;font-size:11px}.settings-message.ok,.settings-message.bad,.settings-message.neutral{display:block}.settings-message.ok{background:var(--ok-soft);color:var(--ok)}.settings-message.bad{background:var(--bad-soft);color:var(--bad)}.settings-message.neutral{background:var(--idle-soft);color:var(--idle)}.rule-list,.user-list{padding:5px 20px 12px}.rule-row{display:grid;grid-template-columns:minmax(120px,.7fr) minmax(170px,1fr) auto;gap:12px;align-items:end;padding:11px 2px;border-bottom:1px solid var(--line)}.rule-row:last-child,.user-row:last-child{border-bottom:0}.rule-row b,.user-row b{font-size:12px}.rule-row small,.user-row small{display:block;color:var(--muted);font-size:10px}.rule-row input{width:100%;height:36px;border:1px solid var(--line);border-radius:8px;background:var(--panel-soft);padding:0 10px}.user-row{display:grid;grid-template-columns:minmax(110px,.7fr) minmax(95px,.45fr) minmax(95px,.45fr) minmax(170px,.8fr) auto;gap:10px;align-items:center;padding:11px 2px;border-bottom:1px solid var(--line)}.user-row select,.user-row input[type=password]{width:100%;height:34px;border:1px solid var(--line);border-radius:8px;background:var(--panel-soft);padding:0 9px}.row-actions{display:flex;gap:6px;justify-content:flex-end}.row-actions button{height:33px;padding:0 9px;border:1px solid var(--line);border-radius:7px;background:#fff;cursor:pointer;font-size:10px}.row-actions button.danger{color:var(--bad)}
  .noscript{padding:20px;background:var(--bad-soft);color:var(--bad)}
  @media(max-width:1200px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
  @media(max-width:1100px){.app{grid-template-columns:72px minmax(0,1fr)}.sidebar{padding:20px 10px}.brand{padding:0 9px 24px}.brand>div:last-child,.navlabel,.nav a span:not(.navicon),.sidefoot p{display:none}.nav a{justify-content:center;padding:10px}.sidefoot{padding:16px 0}.live{justify-content:center}.two-col,.upload-grid{grid-template-columns:1fr}.check-list{display:grid;grid-template-columns:repeat(2,1fr);column-gap:24px}}
  @media(max-width:760px){.kpi-business{grid-column:1/-1}}
  @media(max-width:760px){.app{display:block}.sidebar{position:static;height:auto;padding:10px 15px;display:block;max-width:100%;overflow:hidden}.brand{padding:0 0 9px}.brand>div:last-child{display:block}.navlabel,.sidefoot{display:none}.nav{display:flex;min-width:0;overflow-x:auto;padding-bottom:2px}.nav a{padding:8px 10px;flex:none}.topbar{height:62px;padding:0 16px;min-width:0}.topbar>div:first-child{min-width:0}.topbar h1,.crumb{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.content{padding:16px 14px 40px;width:100%;max-width:100%}.hero{padding:20px;display:block}.hero:after{right:-60px}.overall{margin-top:18px;width:210px;max-width:100%}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.readybar{display:block}.ready-items{margin-top:10px}.runbar{grid-template-columns:1fr}.run-value{text-align:left}.schedule{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.slot:nth-child(2){border-right:0}.controls{width:100%;margin:10px 0 0;min-width:0}.section-head{flex-wrap:wrap;min-width:0}.control{min-width:0}input.control{flex:1;width:auto}.check-list{display:block}.sync{display:none}.issue{grid-template-columns:8px minmax(72px,90px) minmax(0,1fr)}.issue .badge{display:none}.issue-list{padding-left:14px;padding-right:14px}.session-row{grid-template-columns:1fr auto}.session-row .session-time,.session-row .session-action{grid-column:1/-1}.section,.hero,.readybar,.runbar,.two-col{min-width:0;max-width:100%}}
  @media(max-width:760px){.asin-summary,.evidence-summary,.upload-result-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.asin-row,.recommendation-row,.evidence-gap-row{grid-template-columns:1fr auto}.asin-row .reason,.recommendation-row .reason,.evidence-gap-row .reason{grid-column:1/-1}.asin-row .next{grid-column:1/-1}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.upload-fields,.settings-form{grid-template-columns:1fr}.upload-row,.rule-row,.user-row{grid-template-columns:1fr auto}.upload-row>*:nth-child(3),.upload-row>*:nth-child(4),.rule-row>*:nth-child(2),.user-row>*:nth-child(n+3){grid-column:1/-1}}
  @media(max-width:430px){.brand small{display:none}.hero h2{font-size:21px}.kpi{min-height:100px;padding:14px}.kpi-value{font-size:23px}.schedule{grid-template-columns:1fr}.slot{border-right:0;border-bottom:1px solid var(--line);padding-bottom:13px}.slot:last-child{border-bottom:0}.controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.controls input{grid-column:1/-1}.metrics{grid-template-columns:1fr}.pager{justify-content:center;padding-left:8px;padding-right:8px}.drawer{width:100vw}.drawer-body,.drawer-head{padding-left:16px;padding-right:16px}}
  @media(max-width:900px){.run-stores{grid-template-columns:repeat(2,minmax(0,1fr))}.execution-panel .runbar{grid-template-columns:1fr auto}.execution-panel .run-track{grid-row:2;grid-column:1/-1}.execution-panel .run-value{grid-column:2;grid-row:1}}
  @media(max-width:540px){.run-stores{grid-template-columns:1fr;padding:0 14px 14px}.execution-panel .runbar{margin:0 14px 14px;padding:12px;gap:12px}.execution-panel .section-head{align-items:flex-start;gap:8px}.run-connection{white-space:normal;text-align:right}.execution-panel .run-title b{font-size:12px}.execution-panel .run-value{font-size:13px}}
${ONBOARDING_STYLES}
${STORE_SETTINGS_STYLES}
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="brandmark">AMZ</div><div><b>店铺巡检</b><small>Automation Console</small></div></div>
    <div class="navlabel">工作台</div>
    <nav class="nav" aria-label="页面导航">
      <a href="#overview" data-view="overview" class="active"><span class="navicon">01</span><span>巡检总览</span></a>
      <a href="#store-risk" data-view="store-risk"><span class="navicon">店</span><span>店铺风险</span></a>
      <a href="#customer-voice" data-view="customer-voice"><span class="navicon">声</span><span>客户声音</span></a>
      <a href="#product-status" data-view="product-status"><span class="navicon">A</span><span>商品状态</span></a>
      <a href="#intelligence" data-view="intelligence"><span class="navicon">竞</span><span>竞品情报</span></a>
      <a href="#ads-watch" data-view="ads-watch"><span class="navicon">广</span><span>广告值守</span></a>
      <a href="#upload" data-view="upload"><span class="navicon">UP</span><span>上传中心</span></a>
      <a href="#system" data-view="system"><span class="navicon">运</span><span>系统保障</span></a>
      <a href="#stores" data-view="stores"><span class="navicon">配</span><span>店铺配置</span></a>
      <a href="#users" data-view="users"><span class="navicon">人</span><span>用户管理</span></a>
    </nav>
    <div class="sidefoot">${ONBOARDING_ENTRY}<div class="live"><i class="pulse"></i><span>本地服务在线</span></div><p id="refreshCadence" style="white-space:pre-line">正在读取显示配置…</p></div>
  </aside>
  <div class="main">
    <header class="topbar">
      <div><h1 id="pageTitle">巡检总览</h1><div class="crumb" id="pageCrumb">所有店铺 · Amazon · 紫鸟 WebDriver</div></div>
      <div class="spacer"></div>
      <div class="sync"><b id="syncTime">正在读取数据</b><span>最近同步</span></div>
      <button class="refresh" id="refresh" type="button" title="立即刷新" aria-label="立即刷新">↻</button>
      <form class="logout-form" action="/logout" method="post"><button class="logout" type="submit">退出</button></form>
    </header>
    <main class="content">
      <div class="error" id="error"></div>
      <div class="view active" data-view-panel="overview">
      <section class="hero">
        <div class="hero-copy"><div class="eyebrow">今日巡检与处置</div><h2 id="heroTitle">正在汇总所有店铺</h2><p id="heroSub">加载 9 项自动巡检的最新执行结果…</p></div>
        <div class="overall"><small>老板现在要做什么</small><div class="state" id="overallState">加载中</div><div class="sub" id="overallSub">—</div></div>
      </section>
      <section class="execution-panel" aria-label="巡检执行进度">
        <div class="section-head"><div><h3>巡检执行进度</h3><p>按店铺与检查项实时更新，执行进度与业务结果分别显示</p></div><span class="run-connection" id="runConnection" role="status">正在连接</span></div>
        <div class="runbar" id="runProgress"><div class="run-title"><b id="runTitle">正在读取运行状态</b><small id="runSub">等待任务状态同步</small></div><div class="run-track" role="progressbar" aria-label="本轮巡检完成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="runTrack"></span></div><div class="run-value" id="runValue">—</div></div>
        <div class="run-stores" id="runStores"></div>
      </section>
      <div class="kpis" id="kpis"></div>
      <section class="readybar" id="readiness"><div class="ready-title"><b id="readyTitle">生产就绪检查</b><small id="readySub">正在检查运行依赖…</small></div><div class="ready-items" id="readyItems"></div></section>

      <section class="section" id="schedule">
        <div class="section-head"><div><h3>今日自动化时段</h3><p>按北京时间执行；时间窗状态不等于任务已成功，实际结果以店铺矩阵为准</p></div></div>
        <div class="schedule" id="scheduleList"></div>
      </section>
      </div>

      <div class="view" data-view-panel="store-risk">
      <div class="page-intro"><div><h2>店铺风险</h2><p>第 1、2 项：账户健康与绩效。只要 Amazon 页面仍显示违规或风险，就持续提示，不做自动归档。</p></div></div>
      <section class="section" id="riskMatrix">
        <div class="section-head">
          <div><h3>账户健康与绩效</h3><p id="riskMatrixSub">每格均保留 DOM、页面文本和截图证据；点击可查看判定依据</p></div>
          <div class="controls"><input class="control" id="riskSearch" data-matrix-filter="risk" type="search" placeholder="搜索店铺…" aria-label="搜索店铺风险"><select class="control" id="riskStateFilter" data-matrix-filter="risk" aria-label="店铺风险状态筛选"><option value="ALL">全部状态</option><option value="BUSINESS">运营要处理</option><option value="COLLECTION">技术要修复</option><option value="PROBLEM">全部行动项</option><option value="PENDING">未完成</option><option value="NORMAL">全部正常</option></select><select class="control" id="riskSortBy" data-matrix-filter="risk" aria-label="店铺风险排序"><option value="SEVERITY">行动优先级</option><option value="NAME">店铺名称</option><option value="LATEST">最近运行</option></select></div>
        </div>
        <div class="matrix-wrap"><table><thead id="riskMatrixHead"></thead><tbody id="riskMatrixBody"></tbody></table></div>
        <div class="pager" id="riskMatrixPager" aria-label="店铺风险分页"></div>
        <div class="legend"><span><i class="status-dot ok"></i>正常 · 无需处理</span><span><i class="status-dot warn"></i>业务关注 · 运营</span><span><i class="status-dot bad"></i>业务异常 · 运营</span><span><i class="status-dot error"></i>采集异常 · 技术</span><span><i class="status-dot idle"></i>未完成 · 排程</span></div>
      </section>
      <section class="section"><div class="section-head"><div><h3>风险行动队列</h3><p>业务风险与采集故障分开归口；无有效证据不会显示为正常</p></div><span class="badge s-CRITICAL" id="riskIssueCount">0 项</span></div><div class="issue-list" id="riskIssueList"></div><div class="pager" id="riskIssuePager" aria-label="店铺风险行动分页"></div></section>
      </div>

      <div class="view" data-view-panel="customer-voice">
      <div class="page-intro"><div><h2>客户声音</h2><p>第 3、9、4、7 项：Feedback、Inbox 买家消息、Customer Reviews 与 VOC。低分、未读消息、退货问题和归属待核验均独立呈现。</p></div></div>
      <section class="section"><div class="section-head"><div><h3>客户声音监测</h3><p id="voiceMatrixSub">按店铺查看低星、客户问题和只读登记结果；点击查看结构化明细与截图</p></div><div class="controls"><input class="control" id="voiceSearch" data-matrix-filter="voice" type="search" placeholder="搜索店铺…" aria-label="搜索客户声音店铺"><select class="control" id="voiceStateFilter" data-matrix-filter="voice" aria-label="客户声音状态筛选"><option value="ALL">全部状态</option><option value="BUSINESS">运营要处理</option><option value="COLLECTION">技术要修复</option><option value="PROBLEM">全部行动项</option><option value="PENDING">未完成</option><option value="NORMAL">全部正常</option></select><select class="control" id="voiceSortBy" data-matrix-filter="voice" aria-label="客户声音店铺排序"><option value="SEVERITY">行动优先级</option><option value="NAME">店铺名称</option><option value="LATEST">最近运行</option></select></div></div><div class="matrix-wrap"><table><thead id="voiceMatrixHead"></thead><tbody id="voiceMatrixBody"></tbody></table></div><div class="pager" id="voiceMatrixPager" aria-label="客户声音分页"></div><div class="legend"><span><i class="status-dot ok"></i>正常</span><span><i class="status-dot warn"></i>业务关注</span><span><i class="status-dot bad"></i>业务异常</span><span><i class="status-dot error"></i>采集异常</span><span><i class="status-dot idle"></i>未运行</span></div></section>
      <section class="section"><div class="section-head"><div><h3>客户声音行动队列</h3><p>仅展示本页四项的事件；Review 无法可靠归属店铺时会保留为技术待核验</p></div><span class="badge s-CRITICAL" id="voiceIssueCount">0 项</span></div><div class="issue-list" id="voiceIssueList"></div><div class="pager" id="voiceIssuePager" aria-label="客户声音行动分页"></div></section>
      </div>

      <div class="view" data-view-panel="product-status">
      <div class="page-intro"><div><h2>商品状态</h2><p>第 5、6 项：只读确认商品可售性、评分变化和 Outlet 新活动；不承担商品主数据维护。</p></div></div>
      <section class="section"><div class="section-head"><div><h3>ASIN 与 Outlet 状态</h3><p id="productMatrixSub">商品不存在、不可售、无购物车和程序采集失败分别显示，避免错误处理方向</p></div><div class="controls"><input class="control" id="productSearch" data-matrix-filter="product" type="search" placeholder="搜索店铺…" aria-label="搜索商品状态店铺"><select class="control" id="productStateFilter" data-matrix-filter="product" aria-label="商品状态筛选"><option value="ALL">全部状态</option><option value="BUSINESS">运营要处理</option><option value="COLLECTION">技术要修复</option><option value="PROBLEM">全部行动项</option><option value="PENDING">未完成</option><option value="NORMAL">全部正常</option></select><select class="control" id="productSortBy" data-matrix-filter="product" aria-label="商品状态店铺排序"><option value="SEVERITY">行动优先级</option><option value="NAME">店铺名称</option><option value="LATEST">最近运行</option></select></div></div><div class="matrix-wrap"><table><thead id="productMatrixHead"></thead><tbody id="productMatrixBody"></tbody></table></div><div class="pager" id="productMatrixPager" aria-label="商品状态分页"></div><div class="legend"><span><i class="status-dot ok"></i>正常</span><span><i class="status-dot warn"></i>业务关注</span><span><i class="status-dot bad"></i>业务异常</span><span><i class="status-dot error"></i>采集异常</span><span><i class="status-dot idle"></i>未运行</span></div></section>
      <section class="section" id="asinInventory">
        <div class="section-head"><div><h3>ASIN 监测清单</h3><p>持续监测、低频复核和人工停检分开管理；低频复核不会被算成正常或永久删除</p></div><span class="badge s-WARN" id="asinReviewCount">0 个待复核</span></div>
        <div class="asin-summary" id="asinSummary"></div><div class="asin-list" id="asinList"></div><div class="pager" id="asinPager" aria-label="ASIN 清单分页"></div>
      </section>
      <section class="section" id="monitoringRecommendations">
        <div class="section-head"><div><h3>只读监测建议</h3><p>根据不可售历史提出核验或低频建议；系统绝不自动停检，也不会修改商品或监测配置</p></div><span class="badge s-WARN" id="monitoringRecommendationCount">0 项建议</span></div>
        <div class="recommendation-list" id="monitoringRecommendationList"><div class="empty">正在读取历史建议…</div></div><div class="pager" id="monitoringRecommendationPager" aria-label="监测建议分页"></div>
      </section>
      <section class="section"><div class="section-head"><div><h3>商品状态行动队列</h3><p>先区分真实商品异常与采集异常，再决定继续监测、低频复核或人工停检</p></div><span class="badge s-CRITICAL" id="productIssueCount">0 项</span></div><div class="issue-list" id="productIssueList"></div><div class="pager" id="productIssuePager" aria-label="商品状态行动分页"></div></section>
      </div>

      <div class="view" data-view-panel="intelligence"><div id="intelligenceView"></div></div>

      <div class="view" data-view-panel="ads-watch">
      <div class="page-intro"><div><h2>广告值守</h2><p>第 8 项：11:20 核对多数关闭，18:30 核对多数开启。每店超过 50% 符合预期即正常，少数例外留档；系统只读检查。</p></div></div>
      <section class="section"><div class="section-head"><div><h3>广告开关合规</h3><p id="adsMatrixSub">必须确认已进入 advertising.amazon.com；筛选结果为 0 在不同时间窗的业务含义不同</p></div><div class="controls"><input class="control" id="adsSearch" data-matrix-filter="ads" type="search" placeholder="搜索店铺…" aria-label="搜索广告值守店铺"><select class="control" id="adsStateFilter" data-matrix-filter="ads" aria-label="广告状态筛选"><option value="ALL">全部状态</option><option value="BUSINESS">运营要处理</option><option value="COLLECTION">技术要修复</option><option value="PROBLEM">全部行动项</option><option value="PENDING">未完成</option><option value="NORMAL">全部正常</option></select><select class="control" id="adsSortBy" data-matrix-filter="ads" aria-label="广告店铺排序"><option value="SEVERITY">行动优先级</option><option value="NAME">店铺名称</option><option value="LATEST">最近运行</option></select></div></div><div class="matrix-wrap"><table><thead id="adsMatrixHead"></thead><tbody id="adsMatrixBody"></tbody></table></div><div class="pager" id="adsMatrixPager" aria-label="广告值守分页"></div><div class="legend"><span><i class="status-dot ok"></i>符合当前时间窗</span><span><i class="status-dot warn"></i>业务关注</span><span><i class="status-dot bad"></i>业务异常</span><span><i class="status-dot error"></i>采集异常</span><span><i class="status-dot idle"></i>未运行</span></div></section>
      <section class="section"><div class="section-head"><div><h3>广告检查时段</h3><p id="adsMonitoringNotice">只展示广告相关排程；时间到达不代表检查结果成功</p></div></div><div class="schedule" id="adsScheduleList"></div></section>
      <section class="section"><div class="section-head"><div><h3>店铺广告组合范围</h3><p>按组合名称特征限定范围，再核对组合及其全部活动；范围缺失或数据未读全时停止判定</p></div><span class="badge s-NOT_CONFIGURED" id="adsRulesState">正在读取</span></div><form id="adsRulesForm"><div class="rule-list" id="adsRuleList"><div class="empty">正在读取广告规则…</div></div><div class="settings-card"><button class="primary" id="saveAdsRules" type="submit">保存全部规则</button><div class="settings-message" id="adsRulesMessage" role="status"></div></div></form></section>
      <section class="section"><div class="section-head"><div><h3>广告异常队列</h3><p>多数活动不符合时段预期时告警；各半时关注，少数例外在店铺详情留档</p></div><span class="badge s-CRITICAL" id="adsIssueCount">0 项</span></div><div class="issue-list" id="adsIssueList"></div><div class="pager" id="adsIssuePager" aria-label="广告异常分页"></div></section>
      </div>

      <div class="view" data-view-panel="upload">
      <div class="page-intro"><div><h2>上传中心</h2><p>受控转交 Amazon 批量模板，不在本系统建立第二套商品主数据。</p></div></div>
      <div class="write-warning"><b>这是控制台唯一允许改变 Amazon 状态的功能</b>已登录且具备上传权限的用户，在本页完成文件预检、店铺核对和精确短语确认后可以执行上传。广告、库存、价格、Outlet Deal 与其他 Listing 操作仍严格只读。Amazon 接收文件不代表商品已经成功创建，最终结果仍以处理报告为准。</div>
      <div class="upload-grid">
        <section class="section" style="margin-top:0"><div class="section-head"><div><h3>新建上传任务</h3><p>选择店铺与文件，确认后转交 Amazon 核验</p></div><span class="badge s-NOT_CONFIGURED" id="uploadFeatureState">读取中</span></div>
          <div class="upload-card" id="uploadCard">
            <form id="uploadForm">
              <div class="upload-field" style="margin-bottom:14px"><label for="uploadMode">上传模式</label><select id="uploadMode" aria-describedby="uploadModeHelp"><option value="SIMPLE">简易模式 · 原样转交 Amazon</option><option value="STANDARD">标准模式 · 本地格式预检</option></select><p class="upload-note" id="uploadModeHelp">原样转发文件，模板、编码、SKU 与商品内容由 Amazon 核验；展示 Amazon 返回内容。保留文件安全检查与提交授权。</p></div>
              <div class="upload-fields"><div class="upload-field"><label for="uploadStore">目标店铺</label><select id="uploadStore" required></select></div><div class="upload-field"><label for="uploadFile">Amazon 批量文件</label><input id="uploadFile" type="file" accept=".xlsx,.csv,.tsv,.txt" required></div></div>
              <div class="upload-actions"><button class="primary" id="stageUpload" type="submit">暂存文件，继续确认</button></div>
              <p class="upload-note" id="uploadLimits">支持 .xlsx / .csv / .tsv / .txt；文件不会在 Dashboard 进程中打开或执行。</p>
            </form>
            <div class="upload-message" id="uploadMessage" role="status" aria-live="polite"></div>
            <div class="confirm-card" id="confirmCard" role="region" aria-labelledby="confirmTitle" aria-describedby="confirmDescription">
              <h3 id="confirmTitle" style="font-size:13px;margin:0 0 5px">提交前最终确认</h3><p class="upload-note" id="confirmDescription" style="margin-top:0">以下信息已与任务绑定。确认后独立工作者将通过对应店铺紫鸟访问固定上传页；进入提交边界后不会自动重试。</p>
              <div class="confirm-summary" id="confirmSummary"></div>
              <form id="confirmForm"><div class="upload-fields"><div class="upload-field"><label for="confirmPhrase">输入页面显示的确认短语</label><input id="confirmPhrase" type="text" autocomplete="off" required></div></div><label class="ack"><input id="confirmAck" type="checkbox" required><span>我已核对店铺与文件摘要，并理解 Amazon 接收文件后可能创建或更新商品数据。</span></label><div class="upload-actions"><button class="primary" id="confirmUpload" type="submit">确认并授权向 Amazon 提交</button><button class="secondary" id="cancelConfirm" type="button">暂不提交</button></div></form>
            </div>
          </div>
        </section>
        <section class="section" style="margin-top:0"><div class="section-head"><div><h3>上传后会发生什么</h3><p>原样转交文件，查看 Amazon 实际返回</p></div></div><div class="upload-card"><div class="detail-block" style="margin-top:0"><h4>1 · 转发文件</h4><p>系统通过目标店铺的紫鸟会话转交原文件，不改写商品字段。</p></div><div class="detail-block"><h4>2 · Amazon 核验</h4><p>模板、SKU、必填字段与商品规则由 Amazon 判定。文件已接收不代表商品已处理成功。</p></div><div class="detail-block"><h4>3 · 查看返回</h4><p>在上传中心查看商品处理状态和数量，展开“查看处理详情”下载 Amazon 原报告。系统执行失败会显示具体原因；需要更新结果时，点击“获取最新处理结果”。</p></div><p class="upload-note">两种模式均保留文件安全检查和逐任务授权；结果未知时先核对 Amazon 记录，避免重复上传。</p></div></section>
      </div>
      <section class="section"><div class="section-head"><div><h3>处理结果概览</h3><p>“Amazon 已接收文件”与“SKU 已处理完成”分别统计；处理状态与数量由系统通过对应店铺紫鸟读取，未取得结果时不显示商品处理成功</p></div></div><div class="upload-result-summary" id="uploadResultSummary"><div class="empty">正在读取处理结果…</div></div></section>
      <section class="section"><div class="section-head"><div><h3>上传任务记录</h3><p>仅展示脱敏元数据；原文件名、服务器路径和 Amazon 认证参数不会显示</p></div><div class="controls"><select class="control" id="uploadStoreFilter" aria-label="上传店铺筛选"><option value="">全部店铺</option></select><select class="control" id="uploadStateFilter" aria-label="上传状态筛选"><option value="">全部状态</option><option value="STAGED">待确认</option><option value="QUEUED">排队</option><option value="SUBMITTING">提交中</option><option value="COMPLETED">Amazon 已接收</option><option value="REJECTED">Amazon 已拒绝</option><option value="FAILED_BEFORE_SUBMIT">提交前失败</option><option value="UNKNOWN">结果未知</option><option value="EXPIRED">已过期</option></select><label class="control"><input id="includeResetUploads" type="checkbox"> 显示已重置记录 <span id="uploadResetCount"></span></label><span class="badge s-ERROR" id="uploadCorrupt" style="display:none">账本异常</span></div></div><p class="upload-note" style="padding:0 20px">点击重置会解除该条旧任务的重复拦截，原记录保留；再次上传可能重复处理。重置不会自动提交文件。</p><div class="upload-history" id="uploadHistory"><div class="empty">正在读取上传任务…</div></div><div class="pager" id="uploadPager" aria-label="上传任务分页"></div></section>
      </div>

      <div class="view" data-view-panel="system">
      <div class="page-intro"><div><h2>系统保障</h2><p>紫鸟会话、采集链路、证据完整性和通知通道。仅显示运行状态，不显示密码、验证码、Cookie、端点或凭据。</p></div></div>
      <section class="runbar" id="systemRunProgress" aria-live="polite"><div class="run-title"><b id="systemRunTitle">正在读取运行状态</b><small id="systemRunSub">—</small></div><div class="run-track" aria-hidden="true"><span id="systemRunTrack"></span></div><div class="run-value" id="systemRunValue">—</div></section>
      <div class="two-col">
        <section class="section" id="sessions"><div class="section-head"><div><h3>紫鸟会话中心</h3><p>登录阻断、渲染器或证据故障均单独归为技术问题</p></div><span class="badge s-ERROR" id="sessionBlockCount">0 家受阻</span></div><div class="session-list" id="sessionList"></div><div class="pager" id="sessionPager" aria-label="会话列表分页"></div></section>
        <section class="section"><div class="section-head"><div><h3>外部通道状态</h3><p>只展示配置状态与最近真实投递结果，不显示端点或凭据</p></div></div><div class="channel-list" id="channelList"></div></section>
      </div>
      <div class="two-col">
        <section class="section"><div class="section-head"><div><h3>采集故障队列</h3><p>只列出技术待修复项；业务异常继续留在所属业务页面</p></div><span class="badge s-ERROR" id="systemIssueCount">0 项</span></div><div class="issue-list" id="systemIssueList"></div><div class="pager" id="systemIssuePager" aria-label="系统故障分页"></div></section>
        <section class="section"><div class="section-head"><div><h3>九项巡检覆盖</h3><p>每项按可靠正常、业务问题和采集问题分别统计</p></div></div><div class="check-list" id="checkList"></div></section>
      </div>
      <section class="section"><div class="section-head"><div><h3>双路证据完整度</h3><p>正常必须同时具备可靠 DOM 与页面文本；缺失或单路证据按技术问题展示</p></div><span class="badge s-ERROR" id="evidenceCompletenessState">正在读取</span></div><div class="evidence-summary" id="evidenceSummary"></div><div class="evidence-gap-list" id="evidenceGapList"></div><div class="pager" id="evidenceGapPager" aria-label="证据缺口分页"></div></section>
      <section class="section"><div class="section-head"><div><h3>告警历史</h3><p>最近通知记录；测试消息会单独标注</p></div></div><div class="alert-list" id="alertList"></div><div class="pager" id="alertPager" aria-label="告警历史分页"></div></section>
      </div>

${STORE_SETTINGS_MARKUP}
      <div class="view" data-view-panel="users">
      <div class="page-intro"><div><h2>用户管理</h2><p>创建、停用和维护 Dashboard 账户；每位用户都可以修改自己的密码。</p></div></div>
      <div class="two-col">
        <section class="section"><div class="section-head"><div><h3>修改我的密码</h3><p>修改成功后全部旧会话立即失效，需要重新登录</p></div></div><div class="settings-card"><form id="ownPasswordForm" class="settings-form"><div class="settings-field"><label for="currentPassword">当前密码</label><input id="currentPassword" type="password" autocomplete="current-password" required></div><div class="settings-field"><label for="newPassword">新密码（至少 12 位）</label><input id="newPassword" type="password" autocomplete="new-password" minlength="12" required></div><div class="settings-field"><label for="newPasswordAgain">再次输入新密码</label><input id="newPasswordAgain" type="password" autocomplete="new-password" minlength="12" required></div><button class="primary" type="submit">更新密码</button></form><div class="settings-message" id="ownPasswordMessage" role="status"></div></div></section>
        <section class="section"><div class="section-head"><div><h3>创建账户</h3><p>只有管理员可以创建账户；普通操作员只能查看巡检数据</p></div></div><div class="settings-card"><form id="createUserForm" class="settings-form"><div class="settings-field"><label for="createUsername">用户名</label><input id="createUsername" autocomplete="off" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" required></div><div class="settings-field"><label for="createPassword">初始密码</label><input id="createPassword" type="password" autocomplete="new-password" required></div><div class="settings-field"><label for="createRole">角色</label><select id="createRole"><option value="operator">操作员</option><option value="admin">管理员</option></select></div><button class="primary" type="submit">创建账户</button></form><div class="settings-message" id="createUserMessage" role="status"></div></div></section>
      </div>
      <section class="section"><div class="section-head"><div><h3>账户列表</h3><p>管理员可重置其他用户密码、调整角色、启停或删除账户；当前账户不能自我停用或删除</p></div><span class="badge s-NOT_CONFIGURED" id="userRoleState">正在读取</span></div><div class="user-list" id="userList"><div class="empty">正在读取用户…</div></div><div class="settings-card"><div class="settings-message" id="userMessage" role="status"></div></div></section>
      </div>
    </main>
  </div>
</div>

<div class="drawer-backdrop" id="drawerBackdrop" role="dialog" aria-modal="true" aria-labelledby="drawerTitle" aria-hidden="true">
  <aside class="drawer"><div class="drawer-head"><div><h3 id="drawerTitle">检查详情</h3><p id="drawerMeta"></p></div><button class="close" id="closeDrawer" type="button" aria-label="关闭">×</button></div><div class="drawer-body" id="drawerBody"></div></aside>
</div>
${ONBOARDING_MARKUP}
<template id="intelligenceTemplate"><style>${INTELLIGENCE_STYLES}</style>${INTELLIGENCE_MARKUP}</template>
<script id="intelligenceClient">${INTELLIGENCE_CLIENT}</script>
<noscript><div class="noscript">此看板需要启用 JavaScript 才能显示实时数据。</div></noscript>
<script>
(function(){
  var crmReadOnly = ${JSON.stringify(crmReadOnly)};
  var sessionEnded = false;
  function endCrmSession(message){
    if(sessionEnded)return;
    sessionEnded=true;uiReady=false;refreshTimers.forEach(clearInterval);
    document.querySelectorAll('body > *').forEach(function(el){el.style.display='none'});
    var notice=document.createElement('p');notice.textContent=message;notice.style.padding='24px';document.body.appendChild(notice);
  }
  var data = null;
  var uploadData = null;
  var userData = null;
  var adsRulesData = null;
  var stagedUploadJob = null;
  var uploadConfirmReturnFocus = null;
  var uploadPage = 1;
  var resettingUploadJobId = null;
  var pages={riskMatrix:1,voiceMatrix:1,productMatrix:1,adsMatrix:1,riskIssues:1,voiceIssues:1,productIssues:1,adsIssues:1,systemIssues:1,asins:1,recommendations:1,evidenceGaps:1,alerts:1,sessions:1};
  var PAGE_SIZE={};
  var uiReady=false,refreshTimers=[],displaySettings=null;
  var activeView=null;
  var VIEW_META={overview:['巡检总览','所有店铺 · 今日巡检与处置'],"store-risk":['店铺风险','账户健康与绩效风险'],"customer-voice":['客户声音','Feedback、Inbox、Reviews 与 VOC'],"product-status":['商品状态','ASIN 可售性与 Outlet 监测'],intelligence:['竞品情报','主销与对标 · 商品观察 · 变化证据'],"ads-watch":['广告值守','广告组合与活动状态 · 时段合规'],upload:['上传中心','受控 Amazon 转交通道'],system:['系统保障','紫鸟、采集、证据与通知状态'],stores:['店铺配置','店铺接入与看板显示'],users:['用户管理','账户、角色与密码安全']};
  var CHECK_GROUPS={risk:['store-health','performance'],voice:['feedback','inbox','reviews','voc'],product:['asin-health','outlet'],ads:['ads-status']};
  var businessItemPlace = ${businessItemPlace.toString()};
  var LABEL = {OK:'正常',WARN:'业务关注',CRITICAL:'业务异常',ERROR:'采集异常',NOT_CONFIGURED:'配置缺失',NOT_COVERED:'本批未覆盖',NEVER_RUN:'尚未运行',SKIPPED:'已跳过'};
  var CELL_LABEL = {OK:'正常',WARN:'业务关注',CRITICAL:'业务异常',ERROR:'采集异常',NOT_CONFIGURED:'配置缺失',NOT_COVERED:'未覆盖',NEVER_RUN:'未运行',SKIPPED:'跳过'};
  var ACTION_LABEL = {NORMAL:'无需处理',BUSINESS:'运营处理',COLLECTION:'技术修复',PENDING:'等待执行'};
  var ACTION_RANK = {BUSINESS:4,COLLECTION:3,PENDING:2,NORMAL:0};
  var METRIC_LABEL = {majorityRule:'多数判定规则',matching:'符合时段预期',matchingPercent:'符合预期（%）',exceptionCount:'不符合预期',recordedExceptionCount:'少数例外留档',ahr:'账户评分',enabled:'已开启',paused:'已暂停',total:'总数',expected:'预期时段',nameContains:'组合名称包含',portfolioCount:'广告组合数',campaignCount:'广告活动数',excluded:'已结束 / 归档',limited:'启用但投放受限',unknown:'待核验',paginationComplete:'分页覆盖完整',selectedStars:'采集星级',pagesCollected:'已采集页数',resultTotal:'筛选结果总数',source:'判定依据',nameFilterVerified:'名称筛选已复核',date:'检查日期',todayTotal:'当天 Feedback',historicalIgnoredCount:'已忽略历史记录',unknownDateLowCount:'日期待核验低分',lowCount:'本店低星',ownedLowCount:'本店低星',brandLowCount:'品牌页低星',excludedOtherStoreCount:'已排除其他店铺',excludedOutOfScopeCount:'已排除范围外商品',ownershipPendingCount:'归属待核验',ownershipPendingAsins:'待核验 ASIN',ownershipInventoryCount:'本店 ASIN 清单',ownershipFiltered:'已按店铺过滤',ownershipReady:'归属清单可用',ownershipComplete:'归属判定完整',ownershipSource:'归属依据',newLowCount:'本次新增',recordedLowCount:'已归档',newBusinessEventCount:'本次新增',recordedBusinessEventCount:'已归档',activeBusinessEventCount:'当前异常',businessStatus:'业务记录',collectionStatus:'采集证据',average:'平均分',dealCount:'活动数',newCount:'新增活动',asinCount:'ASIN 数',poorCount:'较差数',registered:'已登记',rating:'当前评分',prevRating:'昨日评分',ratingDelta:'评分变化',reviewCount:'评论数',listingActive:'激活 / 可售',listingState:'ASIN 状态',checkSkipped:'已跳过后续检查',opened:'链接可达',hasCart:'购物车',redWarnings:'红色警告',badSections:'异常区块'};
  var RESULT_STATUS_LABEL={TODAY_LOW_RATING:'当天低分 Feedback',LOW_RATING:'低分 Feedback',INACTIVE_LISTING:'非激活 / 不可售（已排除）',LOW_REVIEW:'本店首次发现低星 Review',RECORDED_LOW_REVIEW:'本店低星已提醒归档',REVIEW_OWNERSHIP_UNKNOWN:'Review 归属待核验',POOR_CX:'首次发现 VOC 异常',RECORDED_BUSINESS_EVENT:'已提醒并归档',RECORDED_PERFORMANCE_EVENT:'绩效异常仍存在（旧版记录）',MAJORITY_ON:'多数已开启 · 少数例外留档',MAJORITY_OFF:'多数已关闭 · 少数例外留档',ADS_SPLIT:'开关各半 · 需关注',ADS_OBSERVED:'已核对当前状态',SHOULD_BE_OFF:'应关闭但仍启用',SHOULD_BE_ON:'应开启但未投放',PARTIAL_EVIDENCE:'证据不完整',ALL_OFF:'已全部关闭',ALL_ON:'已全部开启',CLEAR:'本店无新增问题'};
  function q(s){return document.querySelector(s)}
  function esc(v){return String(v == null ? '' : v).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]})}
  function stateLabel(s){return LABEL[s] || s || '未知'}
  function resultStatusLabel(s){return RESULT_STATUS_LABEL[s]||s||'未知'}
  function parseDate(s){if(!s)return null;var d=new Date(s);return isFinite(d.getTime())?d:null}
  function timeText(s){var d=parseDate(s);if(!d)return s||'从未';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d)}
  function pct(a,b){return b?Math.round(a*100/b):0}
  function stateClass(s){return 's-'+esc(s||'NEVER_RUN')}
  function actionClass(s){return 'a-'+esc(s||'PENDING')}
  function overallCopy(s){return ACTION_LABEL[s]||'等待执行'}
  function valueText(v){if(Array.isArray(v))return v.length?String(v.slice(0,3).join('、')):'—';if(v===true)return '是';if(v===false)return '否';if(v===null||v===undefined||v==='')return '—';if(typeof v==='object')return JSON.stringify(v);if(v==='portfolio+campaign')return '组合 + 活动';return String(v)}
  var ITEM_LABEL={disposition:'监测处理',portfolioName:'广告组合',portfolioStatus:'组合状态',campaignName:'广告活动',campaignStatus:'活动投放状态',toggle:'活动开关',effective:'综合判定',stars:'星级',rating:'评分',asin:'ASIN',parentAsin:'父 ASIN',childAsin:'子 ASIN',brand:'品牌',ownership:'店铺归属',ownershipAsin:'归属 ASIN',ownershipSource:'归属依据',sharedOwnership:'跨店共享商品',title:'标题',summary:'摘要',date:'时间',author:'评论人',identifier:'记录标识',source:'证据来源',sku:'SKU',offerId:'Offer 标识',reason:'原因',returnReason:'退货原因',cxHealth:'CX Health',ncxRate:'NCX',count:'数量',category:'类别',type:'类型',text:'说明',row:'页面行',unread:'未读',needsResponse:'待回复',oldestUnreadAt:'最早未回复'};
  function sourceText(v){var s=String(v||'');if(/^kat-star-rating|^attr:/.test(s))return 'DOM 评论行';if(/^pagetext/.test(s))return '页面文本（仅计数，不绑定记录）';return s||'—'}
  function reviewItemEvidenceHtml(item,checkId,pages){if(checkId!=='reviews')return '';var id=item.identifier||item.reviewId;var page=(pages||[]).find(function(p){return p.screenshot&&(p.reviewIds||[]).indexOf(id)>=0});return page?'<a class="shot" href="'+esc(page.screenshot)+'" target="_blank" rel="noopener">查看此评价所在第 '+page.page+' / '+page.pages+' 页原始截图 →</a>':''}
  function reviewSummaryHtml(r,checkId){if(checkId!=='reviews')return '';var dates=r.reviewDates||{},sm=r.screenshotMeta||{};return '<p class="brand-note"><b>本次采集：</b>'+esc(timeText(r.checkedAt))+'<br><b>本次取得的最新评价发表日期：</b>'+esc(dates.newestDate||'待核验')+'。明细按发表日期从新到旧排列；旧日期评价仍保留，不会改成采集日期。'+(dates.undatedCount?' 有 '+dates.undatedCount+' 条日期待核验。':'')+(sm.legacy?'<br><b>旧版截图仅保存第 '+sm.page+' / '+sm.pages+' 页，不能代表最新差评；请以上方日期和下方明细为准。</b>':'')+'</p>'}
  function itemHtml(item,checkId,reviewPages){var preferred=checkId==='reviews'?['ownership','stars','ownershipAsin','parentAsin','childAsin','asin','brand','author','date','title','summary','source']:checkId==='feedback'?['rating','asin','author','date','title','summary','identifier','source']:checkId==='ads-status'?['portfolioName','campaignName','disposition','portfolioStatus','toggle','campaignStatus','effective']:Object.keys(item||{});var hidden={portfolioId:1,campaignId:1,itemKey:1,storeKey:1,storeName:1,context:1,raw:1,legacyItemKey:1,previousItemKeys:1,detailDiagnostics:1};var seen={};var keys=preferred.concat(Object.keys(item||{})).filter(function(k){if(seen[k]||hidden[k])return false;seen[k]=1;return item&&item[k]!==null&&item[k]!==undefined&&item[k]!==''});if((checkId==='reviews'||checkId==='feedback')&&!item.asin&&!item.parentAsin&&!item.childAsin)keys.unshift('_unboundAsin');return '<article class="item-card"><div class="item-grid">'+keys.slice(0,12).map(function(k){var value=k==='_unboundAsin'?'未绑定（保留异常，不自动归档）':k==='disposition'?({RECORDED_EXCEPTION:'少数例外 · 仅留档',ACTION_REQUIRED:'多数不符 · 需处理',ATTENTION:'各半 · 需关注',MATCHED:'符合时段预期',EXCLUDED:'不参与本次比例',UNVERIFIED:'证据待核验',OBSERVED:'仅记录状态'}[item[k]]||valueText(item[k])):k==='effective'?({ON:'可投放',OFF:'未投放',EXCLUDED:'已结束 / 归档',LIMITED:'已启用但投放受限',UNKNOWN:'待核验'}[item[k]]||valueText(item[k])):k==='toggle'?({ENABLED:'已启用',PAUSED:'已暂停'}[item[k]]||valueText(item[k])):k==='source'?sourceText(item[k]):k==='ownership'&&item[k]==='OWNED'?'本店已确认':valueText(item[k]);var wide=/^(title|summary|text|row|reason|returnReason)$/.test(k);return '<div class="item-field '+(wide?'wide':'')+'"><small>'+esc(k==='_unboundAsin'?'ASIN 绑定':k==='date'&&checkId==='reviews'?'评价发表日期':ITEM_LABEL[k]||k)+'</small><b class="'+(k==='_unboundAsin'?'unbound':'')+'">'+esc(value)+'</b></div>'}).join('')+'</div>'+reviewItemEvidenceHtml(item,checkId,reviewPages)+'</article>'}
  function reviewBrandNote(storeKey){var current=data.stores.find(function(s){return s.key===storeKey});if(!current)return '';return '<div class="brand-note"><b>店铺口径：</b>Amazon 原页和原始截图是品牌级评论源；控制台已按 '+esc(storeKey)+' 的有效 ASIN 清单过滤。业务异常与结构化明细只包含“本店已确认”的 Review；其他店铺及不在本店商品范围内的 ASIN 会排除，评论行无 ASIN 或归属清单不可用时显示为采集待核验。采集 1～3 星的所有分页；Amazon 可能延迟最多 72 小时显示评价，旧日期的新发现同样纳入提醒。</div>'}
  function pageRows(key,rows){var size=PAGE_SIZE[key];var total=Math.max(1,Math.ceil(rows.length/size));pages[key]=Math.max(1,Math.min(pages[key]||1,total));return rows.slice((pages[key]-1)*size,pages[key]*size)}
  function renderPager(id,key,total){var el=q(id);if(!el)return;var size=PAGE_SIZE[key];var count=Math.max(1,Math.ceil(total/size));pages[key]=Math.max(1,Math.min(pages[key]||1,count));if(total<=size){el.innerHTML=total?'<span>共 '+total+' 条</span>':'';return}el.innerHTML='<button type="button" data-page-key="'+key+'" data-page-dir="-1" '+(pages[key]===1?'disabled':'')+'>上一页</button><b>'+pages[key]+' / '+count+'</b><button type="button" data-page-key="'+key+'" data-page-dir="1" '+(pages[key]===count?'disabled':'')+'>下一页</button><span>共 '+total+' 条</span>'}
  function activateView(name){
    if(!uiReady)return;
    if(!VIEW_META[name] || (crmReadOnly && ['intelligence','upload','stores','users'].includes(name)))name='overview';
    if(activeView===name)return;
    activeView=name;
    document.querySelectorAll('[data-view-panel]').forEach(function(x){x.classList.toggle('active',x.getAttribute('data-view-panel')===name)});
    document.querySelectorAll('[data-view]').forEach(function(x){var selected=x.getAttribute('data-view')===name;x.classList.toggle('active',selected);if(selected)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current')});
    q('#pageTitle').textContent=VIEW_META[name][0];q('#pageCrumb').textContent=VIEW_META[name][1]+' · Amazon · 紫鸟 WebDriver';
    q('.sync').style.display=name==='intelligence'?'none':'';
    document.title=VIEW_META[name][0]+' · 店铺巡检';
    if(name==='intelligence')window.amzIntelligence.activate();else window.amzIntelligence.suspend();
    if(name==='upload')loadUploads(uploadPage);if(name==='ads-watch')loadAdsRules();if(name==='users')loadUsers();if(name==='stores')storeSettings.activate();
  }

  function renderHero(){
    var s=data.summary;
    q('#heroTitle').textContent=s.businessActionCells>0?'今天有 '+s.businessActionCells+' 项业务事项需要运营处理':s.collectionActionCells>0?'业务无新增红灯，监测链路有 '+s.collectionActionCells+' 项待修复':s.pendingActionCells>0?'业务结果正常，仍有 '+s.pendingActionCells+' 项尚未完成':'今天已完成的巡检全部正常';
    q('#heroSub').textContent=s.stores+' 家店铺 · '+s.normalActionCells+' 个工作单元正常 · '+s.businessActionCells+' 个运营待办 · '+s.collectionActionCells+' 个技术待办 · '+s.pendingActionCells+' 个未完成。';
    var o=q('#overallState');o.className='state '+actionClass(data.overall);o.textContent=overallCopy(data.overall);
    q('#overallSub').textContent=s.businessActionCells+' 运营 · '+s.collectionActionCells+' 技术 · '+s.pendingActionCells+' 未完成';
    q('#syncTime').textContent=data.generatedAtHuman+' 北京时间';
  }

  function businessPlacesHtml(){
    var rows=(data.issues||[]).filter(function(x){return x.actionState==='BUSINESS'});
    if(!rows.length)return '';
    return '<ul class="kpi-places" aria-label="运营待处理位置">'+rows.map(function(x){
      var place=businessItemPlace(x,data.checks);
      var page=place.view&&VIEW_META[place.view]?VIEW_META[place.view][0]:'';
      var title=place.label+(page?' · 打开'+page:'');
      if(!place.view||!VIEW_META[place.view])return '<li><span class="kpi-place" title="'+esc(title)+'">'+esc(place.label)+'</span></li>';
      return '<li><a class="kpi-place" href="#'+esc(place.view)+'" data-view="'+esc(place.view)+'" title="'+esc(title)+'">'+esc(place.label)+'</a></li>';
    }).join('')+'</ul>';
  }

  function renderKpis(){
    var s=data.summary;var coverage=pct(s.completedCells,s.totalCells);
    var items=[
      {name:'已纳管店铺',value:s.stores,unit:'家',note:s.healthyStores+' 家全部检查无需处理',icon:'店'},
      {name:'正常工作单元',value:s.normalActionCells,unit:'项',note:'覆盖率 '+coverage+'% · '+s.completedCells+'/'+s.totalCells,icon:'✓',progress:coverage},
      {name:'运营待处理',value:s.businessActionCells,unit:'项',note:'页面证据确认的业务事项',icon:'运',bad:s.businessActionCells>0,places:true},
      {name:'技术待修复',value:s.collectionActionCells,unit:'项',note:'登录、证据、解析或数据过期',icon:'技',error:s.collectionActionCells>0},
      {name:'未完成 / 待复核',value:s.pendingActionCells+(data.asinInventory?data.asinInventory.deferred:0),unit:'项',note:(data.asinInventory?data.asinInventory.deferred:0)+' 个 ASIN 低频复核',icon:'待',warn:true}
    ];
    q('#kpis').innerHTML=items.map(function(x){return '<article class="kpi'+(x.places?' kpi-business':'')+'"><div class="kpi-top"><span>'+esc(x.name)+'</span><i class="kpi-icon">'+esc(x.icon)+'</i></div><div><div class="kpi-value" style="'+(x.bad?'color:var(--bad)':x.error?'color:var(--error)':x.warn?'color:var(--warn)':'')+'">'+esc(x.value)+'<small>'+esc(x.unit)+'</small></div><div class="kpi-note">'+esc(x.note)+'</div>'+(x.progress!==undefined?'<div class="progress"><span style="width:'+x.progress+'%"></span></div>':'')+(x.places?businessPlacesHtml():'')+'</div></article>'}).join('');
  }

  function renderReadiness(){
    var r=data.readiness;var title=q('#readyTitle');title.textContent=r.ready?'生产运行条件已就绪':'还有 '+r.blockers+' 个投产阻断项';title.style.color=r.ready?'var(--ok)':'var(--bad)';
    q('#readySub').textContent=r.ready?'排程、凭据、ASIN 与实时报警均已配置':'红点项目完成后才算可无人值守运行';
    q('#readyItems').innerHTML=r.items.map(function(x){return '<div class="ready-item '+(x.ok?'ok':(!x.required?'optional':''))+'"><b>'+esc(x.label)+'</b><small title="'+esc(x.detail)+'">'+esc(x.detail)+'</small></div>'}).join('');
  }

  var progressDisconnected=false,loading=false,progressLoading=false;
  var EXECUTION_LABEL={QUEUED:'等待中',RUNNING:'采集中',COMPLETED:'已完成',ERROR:'采集异常',SKIPPED:'已跳过',INTERRUPTED:'已中断'};
  function checkTitle(id){var check=(data.checks||[]).find(function(c){return c.id===id});return check?check.title:id||'准备任务'}
  function elapsedText(at){var start=parseDate(at);if(!start)return '';var seconds=Math.max(0,Math.floor((Date.now()-start.getTime())/1000));return seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒'}
  function progressDelayed(){var p=data.progress||{};return progressDisconnected||p.delayed||(p.active&&p.heartbeatAt&&Date.now()-Date.parse(p.heartbeatAt)>30000)}
  function renderRunBar(prefix){
    var p=data.progress||{state:'IDLE',active:false,percent:0},delayed=progressDelayed();
    var failed=['FAILED','INTERRUPTED','COMPLETED_WITH_ERRORS'].indexOf(p.state)>=0;
    q('#'+prefix+'Progress').className='runbar'+(p.active?' active':'')+(failed?' failed':'')+(delayed?' delayed':'');
    var track=q('#'+prefix+'Track'),percent=Math.max(0,Math.min(100,p.percent||0));track.style.width=percent+'%';
    track.parentElement.removeAttribute('aria-hidden');track.parentElement.setAttribute('role','progressbar');track.parentElement.setAttribute('aria-label','本轮巡检完成进度');track.parentElement.setAttribute('aria-valuemin','0');track.parentElement.setAttribute('aria-valuemax','100');track.parentElement.setAttribute('aria-valuenow',String(percent));
    var title=q('#'+prefix+'Title'),sub=q('#'+prefix+'Sub'),value=q('#'+prefix+'Value');
    if(p.active){
      title.textContent=(progressDisconnected?'进度连接中断':delayed?'任务响应延迟':'巡检正在运行')+' · '+checkTitle(p.check);
      var current=(p.cells||[]).find(function(c){return c.state==='RUNNING'});
      sub.textContent=(p.store?'当前店铺 '+p.store:'等待店铺启动')+(current&&current.currentAsin?' · '+current.currentAsin:'')+' · 已完成 '+(p.completed||0)+' / '+(p.total||'—')+' 个店铺检查单元 · 已运行 '+elapsedText(p.startedAt);
      value.textContent=percent+'%';
    }else{
      var labels={IDLE:'当前没有任务运行',COMPLETED:'最近一轮巡检已完成',COMPLETED_WITH_FINDINGS:'最近一轮已完成 · 有业务事项',COMPLETED_WITH_ERRORS:'最近一轮已完成 · 有采集异常',FAILED:'最近一次运行失败',INTERRUPTED:'任务已中断 · 采集进程已退出'};
      title.textContent=labels[p.state]||labels.IDLE;
      sub.textContent=(p.finishedAt?'结束于 '+timeText(p.finishedAt)+' · ':'')+'下一次：'+(data.nextRun?data.nextRun.nextAtHuman+' · '+data.nextRun.label:'尚无排程');
      value.textContent=p.state==='IDLE'?'等待排程':percent+'%';
    }
    track.parentElement.setAttribute('aria-valuetext',percent+'%，'+title.textContent);
  }
  function renderProgress(){
    renderRunBar('run');var p=data.progress||{},delayed=progressDelayed(),connection=q('#runConnection');
    connection.className='run-connection'+(progressDisconnected||delayed?' delayed':p.active?' live':'');
    connection.textContent=progressDisconnected?'连接中断 · 自动重连中':delayed?'心跳延迟 · 请留意运行状态':p.active?'实时同步 · 采集进程在线':'每 2 秒同步运行状态';
    q('#runStores').innerHTML=(p.stores||[]).map(function(s){
      var store=(data.stores||[]).find(function(item){return item.key===s.storeKey}),running=s.state==='RUNNING';
      var state=running&&delayed?'INTERRUPTED':s.state,label=running&&delayed?'等待状态恢复':EXECUTION_LABEL[s.state]||'等待中';
      var percent=Math.max(0,Math.min(100,s.percent||0));
      return '<article class="run-store '+(running?'running':'')+'"><span class="run-orbit e-'+state+'" role="img" aria-label="'+esc((store?store.name:s.storeKey)+' '+label+' '+percent+'%')+'"><svg viewBox="0 0 42 42" aria-hidden="true"><circle class="orbit-base" cx="21" cy="21" r="18"/><circle class="orbit-value" cx="21" cy="21" r="18" stroke-dasharray="113.1" stroke-dashoffset="'+(113.1*(1-percent/100)).toFixed(2)+'"/></svg><b>'+percent+'%</b></span><div class="run-store-copy"><b>'+esc(store?store.name:s.storeKey)+'</b><small class="execution-state">'+esc(label+(s.check?' · '+checkTitle(s.check):''))+'</small><small>已完成 '+s.completed+' / '+s.total+' 项'+(s.currentAsin?' · '+esc(s.currentAsin):'')+'</small></div></article>';
    }).join('');
    q('#runStores').hidden=!(p.stores||[]).length;
  }
  function renderSystemProgress(){renderRunBar('systemRun')}
  function executionCell(storeKey,checkId,cell){
    var p=data.progress||{},event=(p.cells||[]).find(function(item){return item.storeKey===storeKey&&item.check===checkId});
    var base='cell '+stateClass(cell.stale?'ERROR':cell.state);
    if(!event)return {className:base,html:esc(cell.stateLabel),label:cell.stateLabel,busy:false};
    var running=event.state==='RUNNING',queued=event.state==='QUEUED',delayed=running&&progressDelayed();
    if(event.state==='ERROR')base='cell s-ERROR';
    var label=delayed?'状态待确认':EXECUTION_LABEL[event.state]||'等待中';
    var symbol=event.state==='COMPLETED'?'✓':event.state==='ERROR'||event.state==='INTERRUPTED'?'!':event.state==='SKIPPED'?'−':'';
    var resultCurrent=cell.lastRunAt&&p.startedAt&&Date.parse(cell.lastRunAt)>=Date.parse(p.startedAt);
    var note=resultCurrent?cell.stateLabel:'上次：'+cell.stateLabel;
    if(running&&event.total>1)note=event.completed+'/'+event.total+' 个 ASIN';
    return {className:base+' has-execution'+(running?' execution-running':queued?' execution-queued':event.state==='INTERRUPTED'?' execution-interrupted':'')+(delayed?' execution-delayed':''),
      html:'<span class="run-spinner e-'+event.state+'" aria-hidden="true">'+symbol+'</span><span class="cell-copy"><b>'+esc(label)+'</b><small>'+esc(note)+'</small></span>',
      label:label+' · '+note+(running&&event.currentAsin?' · '+event.currentAsin:''),busy:running};
  }
  function updateExecutionCells(){
    document.querySelectorAll('button.cell[data-store][data-check]').forEach(function(button){
      var store=data.stores.find(function(s){return s.key===button.dataset.store});if(!store)return;
      var cell=store.cells[button.dataset.check]||{state:'NEVER_RUN',stateLabel:'尚未运行'},view=executionCell(store.key,button.dataset.check,cell);
      button.className=view.className;button.innerHTML=view.html;button.setAttribute('aria-busy',String(view.busy));button.title=checkTitle(button.dataset.check)+' · '+view.label;button.setAttribute('aria-label',store.name+' '+button.title);
    });
  }

  function renderSchedule(target,onlyAds){
    if(onlyAds)q('#adsMonitoringNotice').textContent=data.adsMonitoring&&data.adsMonitoring.paused?'广告监测已暂停。下方历史结果仅供参考，暂停期间不会自动检查或发送广告提醒。':'只展示广告相关排程；时间到达不代表检查结果成功';
    var now=new Date();var fmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(now).split(':');var mins=Number(fmt[0])*60+Number(fmt[1]);
    var slots=(data.slots||[]).filter(function(sl){return !onlyAds||sl.checks.indexOf('ads-status')>=0});q(target).innerHTML=slots.map(function(sl){var p=sl.at.split(':');var sm=Number(p[0])*60+Number(p[1]);var phase=sl.paused?'已暂停':sl.name===data.currentSlot?'当前窗口':(mins>sm?'今日已过':'今日待执行');return '<article class="slot '+(!sl.paused&&sl.name===data.currentSlot?'current':'')+'"><div class="slot-time">'+esc(sl.at)+'</div><div class="slot-name">'+esc(sl.label)+'</div><div class="slot-meta">'+sl.checks.length+' 项 · '+phase+'<br>'+(sl.paused?'等待恢复监测':'下次 '+esc(timeText(sl.nextAt)))+'</div></article>'}).join('');
  }

  function groupChecks(group){return data.checks.filter(function(c){return CHECK_GROUPS[group].indexOf(c.id)>=0})}
  function groupCounts(store,checks){var out={NORMAL:0,BUSINESS:0,COLLECTION:0,PENDING:0};checks.forEach(function(c){var cell=store.cells[c.id]||{};var state=cell.actionState||'PENDING';out[state]=(out[state]||0)+1});return out}
  function groupLatest(store,checks){return Math.max.apply(null,checks.map(function(c){var d=parseDate((store.cells[c.id]||{}).lastRunAt);return d?d.getTime():0}))}
  function groupActionState(counts){var best='NORMAL';Object.keys(counts).forEach(function(key){if(counts[key]&&(ACTION_RANK[key]||0)>(ACTION_RANK[best]||0))best=key});return best}
  function visibleStores(group){
    var term=q('#'+group+'Search').value.trim().toLowerCase();var filter=q('#'+group+'StateFilter').value;var sort=q('#'+group+'SortBy').value;var checks=groupChecks(group);
    var rows=data.stores.filter(function(s){var count=groupCounts(s,checks);var action=groupActionState(count);var match=!term||(s.name+' '+s.key+' '+s.market).toLowerCase().indexOf(term)>=0;if(!match)return false;if(filter==='BUSINESS')return count.BUSINESS>0;if(filter==='COLLECTION')return count.COLLECTION>0;if(filter==='PROBLEM')return count.BUSINESS+count.COLLECTION>0;if(filter==='PENDING')return count.PENDING>0;if(filter==='NORMAL')return action==='NORMAL';return true});
    rows.sort(function(a,b){var ac=groupCounts(a,checks),bc=groupCounts(b,checks);if(sort==='NAME')return String(a.name).localeCompare(String(b.name),'zh-CN');if(sort==='LATEST')return groupLatest(b,checks)-groupLatest(a,checks);return (ACTION_RANK[groupActionState(bc)]||0)-(ACTION_RANK[groupActionState(ac)]||0)||String(a.name).localeCompare(String(b.name),'zh-CN')});return rows;
  }

  function renderGroupMatrix(group,key,prefix){
    var checks=groupChecks(group),all=visibleStores(group),stores=pageRows(key,all),head=q('#'+prefix+'Head'),body=q('#'+prefix+'Body'),sub=q('#'+prefix+'Sub');
    if(sub)sub.textContent='筛选结果 '+all.length+' / '+data.stores.length+' 家店铺；当前第 '+pages[key]+' 页，每格可查看证据与指标';
    head.innerHTML='<tr><th scope="col">店铺</th>'+checks.map(function(c){return '<th scope="col" title="'+esc(c.title)+'"><span class="check-no">0'+c.no+'</span>'+esc(c.short)+'</th>'}).join('')+'<th scope="col">本页覆盖</th></tr>';
    renderPager('#'+prefix+'Pager',key,all.length);if(!stores.length){body.innerHTML='<tr><td colspan="'+(checks.length+2)+'"><div class="empty">没有符合当前筛选条件的店铺</div></td></tr>';return}
    body.innerHTML=stores.map(function(s){var count=groupCounts(s,checks);var cells=checks.map(function(c){var cell=s.cells[c.id]||{state:'NEVER_RUN',stateLabel:'尚未运行',actionOwner:'排程'};var execution=executionCell(s.key,c.id,cell);return '<td><button type="button" class="'+execution.className+'" aria-busy="'+execution.busy+'" data-store="'+esc(s.key)+'" data-check="'+esc(c.id)+'" title="'+esc(c.title+' · '+execution.label+' · '+cell.actionOwner+'负责')+'" aria-label="'+esc(s.name+' '+c.title+' '+execution.label+' '+cell.actionOwner+'负责')+'">'+execution.html+'</button></td>'}).join('');return '<tr><th scope="row"><div class="store-name">'+esc(s.name)+'</div><div class="store-meta">'+esc(s.market||'未标记站点')+(s.discovered?' · 远程上报':' · 已配置')+'</div></th>'+cells+'<td><div class="row-score">正常 '+count.NORMAL+' · 业务 '+count.BUSINESS+' · 技术 '+count.COLLECTION+' · 未完成 '+count.PENDING+'</div></td></tr>'}).join('');
  }

  function renderIssueQueue(options){
    var ids=options.group?CHECK_GROUPS[options.group]:null;var all=(data.issues||[]).filter(function(x){if(options.collectionOnly&&x.actionState!=='COLLECTION')return false;return !ids||ids.indexOf(x.checkId)>=0});var ordered=[].concat(all.filter(function(x){return x.actionState==='BUSINESS'}),all.filter(function(x){return x.actionState==='COLLECTION'}));var visible=pageRows(options.key,ordered);var count=q('#'+options.prefix+'Count');
    if(count){var business=all.filter(function(x){return x.actionState==='BUSINESS'}).length,collection=all.filter(function(x){return x.actionState==='COLLECTION'}).length;count.textContent=options.collectionOnly?collection+' 项技术待修复':business+' 运营 · '+collection+' 技术';count.className='badge '+stateClass(options.collectionOnly?(collection?'ERROR':'OK'):(business?'CRITICAL':collection?'ERROR':'OK'))}
    renderPager('#'+options.prefix+'Pager',options.key,ordered.length);var list=q('#'+options.prefix+'List');if(!ordered.length){list.innerHTML='<div class="empty">最近报告中没有本页范围内的明确异常。未完成事项仍需在上方矩阵中确认。</div>';return}
    function group(kind,title){var rows=visible.filter(function(x){return x.actionState===kind});if(!rows.length)return '';return '<div class="queue-title">'+title+'</div>'+rows.map(function(x){return '<button type="button" class="issue" data-store="'+esc(x.storeKey)+'" data-check="'+esc(x.checkId)+'"><i class="issue-sev '+esc(x.state)+'" aria-hidden="true"></i><div class="issue-store">'+esc(x.storeName)+'<small>'+esc(x.market||'')+'</small></div><div><div class="issue-title">0'+x.checkNo+' · '+esc(x.checkTitle)+'</div><div class="issue-reason">'+esc((x.reasons||[])[0]||x.status||'需要处理')+'</div></div><span class="badge '+stateClass(x.state)+'">'+esc(x.stateLabel)+'</span></button>'}).join('')}
    list.innerHTML=(options.collectionOnly?'':group('BUSINESS','运营待办'))+group('COLLECTION','技术待办');
  }

  function renderAsinInventory(){
    var x=data.asinInventory||{total:0,active:0,inactive:0,weekly:0,deferred:0,disabled:0,items:[]};
    q('#asinReviewCount').textContent=x.deferred+' 个待复核';
    var stats=[['清单总数',x.total],['激活 / 可售',x.active],['非激活 / 不可售',x.inactive],['低频复核',x.weekly],['人工停检',x.disabled]];
    q('#asinSummary').innerHTML=stats.map(function(s){return '<div class="asin-stat"><small>'+esc(s[0])+'</small><b>'+esc(s[1])+'</b></div>'}).join('');
    var all=x.items||[];var rows=pageRows('asins',all);renderPager('#asinPager','asins',all.length);if(!rows.length){q('#asinList').innerHTML='<div class="empty">没有低频复核或人工停检的 ASIN</div>';return}
    q('#asinList').innerHTML=rows.map(function(a){var inactive=a.lastStatus==='INACTIVE_LISTING',mode=inactive?'非激活 / 不可售':a.monitoring==='disabled'?'人工停检':'每 '+x.recheckDays+' 天复核';return '<div class="asin-row"><div><code>'+esc(a.asin)+'</code><small>'+esc(a.storeKey||'未指定店铺')+' · '+esc(a.market||'US')+'</small></div><span class="badge '+stateClass(inactive?'OK':a.monitoring==='disabled'?'SKIPPED':'WARN')+'">'+esc(mode)+'</span><small class="reason" title="'+esc(a.reason||'')+'">'+esc(a.reason||'状态预检后不进入在售商品健康判断')+'</small><span class="next">'+esc(a.nextCheckAt?'下次 '+timeText(a.nextCheckAt):inactive?'下批先复核状态':'不再自动检查')+'</span></div>'}).join('');
  }

  function renderMonitoringRecommendations(){
    var source=(data.asinInventory&&data.asinInventory.recommendations)||[];var all=source.filter(function(x){return x.recommendation!=='KEEP_DAILY'});var rows=pageRows('recommendations',all);var count=q('#monitoringRecommendationCount');count.textContent=all.length+' 项建议';count.className='badge '+stateClass(all.some(function(x){return x.recommendation==='FIX_COLLECTION_FIRST'})?'ERROR':all.length?'WARN':'OK');renderPager('#monitoringRecommendationPager','recommendations',all.length);
    if(!rows.length){q('#monitoringRecommendationList').innerHTML='<div class="empty">目前没有需要改变处理方式的 ASIN；持续监测项不在此重复展示。</div>';return}
    var labels={FIX_COLLECTION_FIRST:['先修复采集','ERROR'],MANUAL_VERIFY_OR_CONSIDER_WEEKLY:['人工核验','WARN'],RECOVERED:['已恢复','OK']};q('#monitoringRecommendationList').innerHTML=rows.map(function(x){var state=labels[x.recommendation]||['继续观察','WARN'];var mode=x.currentMonitoring==='active'?'每日监测':x.currentMonitoring==='weekly'?'低频复核':x.currentMonitoring==='disabled'?'人工停检':'未配置';return '<article class="recommendation-row"><div><code>'+esc(x.asin)+'</code><small>'+esc(x.storeKey)+' · '+esc(x.market||'US')+'</small></div><div><span class="badge '+stateClass(state[1])+'">'+esc(state[0])+'</span><small>当前：'+esc(mode)+'</small></div><small class="reason">'+esc(x.reason||'需要人工核验')+'</small><small>'+esc(x.latestCheckedAt?timeText(x.latestCheckedAt):'无检查时间')+'</small></article>'}).join('');
  }

  function renderEvidenceCompleteness(){
    var x=data.evidenceCompleteness||{state:'NO_DATA',total:0,complete:0,partial:0,missing:0,normalWithoutDualEvidence:0,percent:0,gaps:[]};var state=q('#evidenceCompletenessState');state.textContent=x.state==='OK'?'双路完整':x.state==='NO_DATA'?'尚无证据':'存在证据缺口';state.className='badge '+stateClass(x.state==='OK'?'OK':x.state==='NO_DATA'?'NEVER_RUN':'ERROR');var stats=[['证据结果',x.total,false],['双路完整',x.complete,false],['单路证据',x.partial,x.partial>0],['双路缺失',x.missing,x.missing>0]];q('#evidenceSummary').innerHTML=stats.map(function(s){return '<div class="evidence-stat '+(s[2]?'bad':'')+'"><small>'+esc(s[0])+'</small><b>'+esc(s[1])+'</b></div>'}).join('');var all=x.gaps||[],rows=pageRows('evidenceGaps',all);renderPager('#evidenceGapPager','evidenceGaps',all.length);if(!rows.length){q('#evidenceGapList').innerHTML='<div class="empty">'+(x.state==='NO_DATA'?'尚无可核验的采集证据':'当前结果均具备可靠 DOM 与页面文本证据')+'</div>';return}q('#evidenceGapList').innerHTML=rows.map(function(g){var check=(data.checks||[]).find(function(c){return c.id===g.checkId});var missing=!g.dom&&!g.text?'DOM 与文本均缺失':!g.dom?'DOM 缺失':'页面文本缺失';return '<article class="evidence-gap-row"><div><b>'+esc(g.storeKey)+'</b><small>'+esc((check&&check.title)||g.checkId)+'</small></div><span class="badge '+stateClass('ERROR')+'">'+esc(missing)+'</span><small class="reason">'+esc(g.subject||'未标记对象')+' · '+esc(resultStatusLabel(g.status))+'</small><small>技术核验</small></article>'}).join('');
  }

  function renderChecks(){
    q('#checkList').innerHTML=data.checks.map(function(c){var cov=c.coverage||{};return '<a class="check-item" href="/api/check/'+encodeURIComponent(c.id)+'" target="_blank" rel="noopener" title="打开脱敏后的 JSON 报告"><span class="number">0'+c.no+'</span><span><b>'+esc(c.title)+'</b><small>'+esc(c.requirement)+'</small></span><span class="coverage"><b>'+esc(cov.normalActions||0)+' 正常</b><br>'+esc(cov.businessActions||0)+' 业务 · '+esc(cov.collectionActions||0)+' 技术</span></a>'}).join('');
  }

  function renderChannels(){
    var rows=data.channels||[];if(!rows.length){q('#channelList').innerHTML='<div class="empty">没有可展示的通道状态</div>';return}
    q('#channelList').innerHTML=rows.map(function(x){var state=(x.state==='NO_DELIVERY'||x.state==='DRY_RUN')?'WARN':x.state;var label=x.state==='OK'?'最近成功':x.state==='ERROR'?'最近失败':x.state==='NO_DELIVERY'?'尚无记录':x.state==='DRY_RUN'?'仅 Dry-run':'未配置';var note=x.description||(x.last&&x.last.at?'最近 '+x.last.at:'不会展示端点或凭据');return '<div class="channel"><div><b>'+esc(x.label)+'</b><small>'+esc(note)+'</small></div><span class="badge '+stateClass(state)+'">'+esc(label)+'</span></div>'}).join('');
  }

  function renderAlerts(){
    var all=data.alerts||[];var rows=pageRows('alerts',all);renderPager('#alertPager','alerts',all.length);if(!rows.length){q('#alertList').innerHTML='<div class="empty">尚无告警记录</div>';return}
    q('#alertList').innerHTML=rows.map(function(x){return '<article class="alert-row"><div class="alert-row-head"><span class="badge '+stateClass(x.severity)+'">'+esc(x.test?'测试':stateLabel(x.severity))+'</span><b>'+esc(x.title)+'</b><time>'+esc(x.at||'')+'</time></div><p>'+esc((x.lines||[])[0]||'无附加说明')+'</p></article>'}).join('');
  }

  function renderSessions(){
    var all=data.sessionHealth||[];var rows=pageRows('sessions',all);var blocked=all.filter(function(x){return x.state==='BLOCKED'}).length;q('#sessionBlockCount').textContent=blocked+' 家登录受阻';q('#sessionBlockCount').className='badge '+stateClass(blocked?'ERROR':'OK');renderPager('#sessionPager','sessions',all.length);
    if(!rows.length){q('#sessionList').innerHTML='<div class="empty">尚无店铺会话证据</div>';return}
    q('#sessionList').innerHTML=rows.map(function(x){var raw=x.state==='READY'?'OK':x.state==='PENDING'?'NEVER_RUN':'ERROR';return '<article class="session-row"><div><b>'+esc(x.storeName)+'</b><small>'+esc(x.market||'未标记站点')+' · '+esc(x.storeKey)+'</small></div><div><span class="badge '+stateClass(raw)+'">'+esc(x.label)+'</span><small>'+x.collectionFailures+' 个采集项待处理</small></div><div class="session-time"><b>'+(x.lastSuccessfulAt?'最近成功 '+esc(timeText(x.lastSuccessfulAt)):'尚无成功记录')+'</b><small>'+(x.lastFailureAt?'最近失败 '+esc(timeText(x.lastFailureAt)):'无近期会话故障')+'</small></div><div class="session-action">'+esc(x.suggestedAction)+(x.lastFailureReason?'<small title="'+esc(x.lastFailureReason)+'">'+esc(x.lastFailureReason)+'</small>':'')+'</div></article>'}).join('');
  }

  var UPLOAD_STATE={STAGED:['待最终确认','WARN'],QUEUED:['等待紫鸟执行','NEVER_RUN'],PROCESSING:['提交前处理中','WARN'],PREPARED:['已选择文件','WARN'],SUBMITTING:['已进入提交边界','WARN'],COMPLETED:['Amazon 已接收','OK'],REJECTED:['Amazon 已拒绝','CRITICAL'],FAILED_BEFORE_SUBMIT:['提交前失败','ERROR'],UNKNOWN:['结果未知 · 禁止重试','ERROR'],EXPIRED:['确认已过期','SKIPPED']};
  var UPLOAD_RESULT={AMAZON_ACCEPTED_UPLOAD:'Amazon 已接收文件',AMAZON_REJECTED_FILE:'Amazon 已拒绝文件',UPLOAD_RESULT_UNCONFIRMED:'Amazon 结果尚无法确认',STORE_NOT_AVAILABLE:'目标店铺不可用',SUBMIT_BOUNDARY_CROSSED:'已进入 Amazon 提交边界',WORKER_INTERRUPTED_AFTER_SUBMIT_BOUNDARY:'提交后工作者中断，需人工核对',SUBMISSION_OUTCOME_UNKNOWN:'提交结果未知，禁止自动重试',FAILED_BEFORE_SUBMIT:'提交前失败，Amazon 未执行提交'};
  function uploadState(state){return UPLOAD_STATE[state]||[state||'未知','ERROR']}
  function uploadResult(code){return UPLOAD_RESULT[code]||code||'等待后续状态'}
  function uploadModeLabel(mode){return mode==='SIMPLE'?'简易模式':'标准模式'}
  function renderUploadMode(){q('#uploadModeHelp').textContent=q('#uploadMode').value==='SIMPLE'?'原样转发文件，模板、编码、SKU 与商品内容由 Amazon 核验；展示 Amazon 返回内容。保留文件安全检查与提交授权。':'本地检查文件格式与文本编码后原样转交 Amazon；商品内容和最终处理结果由 Amazon 核验。'}
  function uploadDetails(job,keepOpen){
    var d=job.diagnostic,r=job.result&&job.result.amazonResponse,available=r&&r.availability==='AVAILABLE',center=job.resultCenter||{},receipt=center.receipt||{},batch=(center.identifiers||{}).batchId,statusReceipt=job.state==='COMPLETED'&&receipt.evidence==='UPLOAD_STATUS_ROW'&&batch,refresh=job.processingRefresh||{},snapshot=refresh.snapshot;
    return '<details class="upload-details" data-upload-details="'+esc(job.id)+'"'+(d||keepOpen?' open':'')+'><summary>'+esc(d?'查看失败原因与 Amazon 返回':'查看处理详情')+'</summary>'
      +(job.reset&&job.reset.resetAt?'<p><b>已手动重置重复拦截</b> · '+esc(timeText(job.reset.resetAt))+'</p><p>'+esc(job.reset.reason||'')+'</p><p>旧任务结果保持不变；重置不会自动提交文件。</p>':'')
      +(d?'<p><b>'+esc(d.source==='AMAZON'?'Amazon 拒绝原因':'系统执行问题')+'</b> · '+esc(d.code||'')+'</p><p>'+esc(d.message||(d.source==='AMAZON'&&available?'请查看下方 Amazon 返回原文。':'未记录详细原因'))+'</p><p>'+esc(d.suggestion||'')+'</p>':'')
      +(statusReceipt?'<p>已在 Amazon 上传状态页核对本次批次与文件。批次：'+esc(batch)+'</p>':'')
      +(available?'<p>Amazon 页面返回（已脱敏）'+(r.truncated?' · 内容已截断':'')+'</p><pre>'+esc(r.text)+'</pre>':!statusReceipt?'<p>尚无本次 Amazon 返回内容；系统不会推断文件已被接收或商品处理成功。</p>':'')
      +(snapshot?'<p><b>'+esc(uploadProcessing(center))+'</b></p><p>'+esc(uploadCountLine(center))+'</p><p>Amazon 状态：'+esc(snapshot.statusText||snapshot.processingState||'未知')+' · 采集于 '+esc(timeText(snapshot.observedAt))+'</p>':'<p>商品处理结果尚未取得，取得后会显示在这里。收到文件不代表商品已经创建或更新成功。</p>')
      +(center.processingReport&&center.processingReport.availability==='AVAILABLE'&&String(center.processingReport.url||'').indexOf('/api/product-uploads/report?jobId=')===0?'<p><a class="secondary" href="'+esc(center.processingReport.url)+'" download>下载 Amazon 处理报告</a><small> '+esc(center.processingReport.format)+' · '+esc(center.processingReport.size)+' B · 采集于 '+esc(timeText(center.processingReport.observedAt))+'</small></p>':snapshot?'<p>'+esc(job.reportProblem||'处理报告尚未取得或已过期，可再次获取最新处理结果。')+'</p>':'')
      +(center.processingReport&&center.processingReport.availability==='AVAILABLE'&&center.processingReport.matchesLatestAttempt===false?'<p>当前报告为此前获取的版本，本次尚未取得新报告，请留意报告的采集时间。</p>':'')
      +'<p>'+esc(uploadRefreshNote(refresh))+'</p>'
      +(refresh.eligible&&uploadData.authorized?'<button class="secondary" type="button" data-refresh-upload="'+esc(job.id)+'" '+(refresh.queued||refresh.running?'disabled':'')+'>'+(refresh.running?'正在读取 Amazon 结果…':refresh.queued?'等待读取结果…':'获取最新处理结果')+'</button>':'')+'</details>';
  }
  function uploadRefreshNote(refresh){
    if(refresh.problem)return refresh.problem;
    if(refresh.running)return '正在通过对应店铺紫鸟读取结果，可留在本页等待。';
    if(refresh.queued)return '已安排结果采集，巡检或上传结束后依次执行。';
    var attempt=refresh.lastAttempt||{};
    if(attempt.status==='FAILED'||attempt.status==='INTERRUPTED')return '最近一次结果采集未完成（'+(attempt.errorCode||'结果未知')+'），已保留此前结果。系统不会重新上传文件。';
    return refresh.eligible?'系统会按配置采集未完成批次；本页刷新只更新已保存的结果。':'尚无可采集的已接收批次，或结果采集已关闭。';
  }
  function uploadProcessing(center){var p=center&&center.processing||{};var labels={RECEIVED:'Amazon 已接收，等待处理',PROCESSING:'SKU 处理中',COMPLETED:'商品处理完成',COMPLETED_WITH_WARNINGS:'处理完成，需查看提示',FAILED:'商品处理失败',UNKNOWN:'处理结果未知'};return p.availability==='AVAILABLE'?(labels[p.status]||p.status):'处理结果待获取'}
  function uploadCountLine(center){var c=center&&center.counts||{};if(c.availability==='NOT_AVAILABLE')return '商品处理数量：待获取';return (c.submitted==null?'':'提交 '+c.submitted+' · ')+'成功 '+(c.success==null?'—':c.success)+' · 失败 '+(c.failed==null?'—':c.failed)+' · 警告 '+(c.warning==null?'—':c.warning)+(c.source==='AMAZON_PROCESSING_REPORT'?' · 处理报告汇总':[c.success,c.failed,c.warning].some(function(n){return n==null})?'（— 表示 Amazon 未提供）':'')}
  function renderUploadResultSummary(){var s=uploadData&&uploadData.resultSummary||{total:0,acceptedAwaitingResult:0,processing:0,processedSuccess:0,processedWithWarnings:0,processedFailed:0,unknown:0};var rows=[['全部任务',s.total,false],['已接收待结果',s.acceptedAwaitingResult,false],['处理中',s.processing,false],['需处理任务',(s.processedWithWarnings||0)+(s.processedFailed||0)+(s.unknown||0)+(s.rejected||0)+(s.failedBeforeSubmit||0),Boolean((s.processedWithWarnings||0)+(s.processedFailed||0)+(s.unknown||0)+(s.rejected||0)+(s.failedBeforeSubmit||0))]];q('#uploadResultSummary').innerHTML=rows.map(function(x){return '<div class="upload-result-stat '+(x[2]?'bad':'')+'"><small>'+esc(x[0])+'</small><b>'+esc(x[1])+'</b></div>'}).join('')}
  function showUploadMessage(message,kind){var el=q('#uploadMessage');el.textContent=message;el.className='upload-message '+(kind||'bad')}
  function renderUploadContext(){
    if(!uploadData)return;var state=q('#uploadFeatureState');state.textContent=!uploadData.enabled?'按策略关闭':!uploadData.authorized?'当前账号无权限':'已受控启用';state.className='badge '+stateClass(uploadData.enabled&&uploadData.authorized?'OK':'SKIPPED');
    var noStores=!(uploadData.stores||[]).length;var disabled=!uploadData.enabled||!uploadData.authorized||noStores;q('#stageUpload').disabled=disabled;q('#uploadStore').disabled=disabled;q('#uploadFile').disabled=disabled;q('#uploadMode').disabled=disabled;
    q('#uploadLimits').textContent='支持 '+uploadData.limits.extensions.join(' / ')+'；单文件上限 '+Math.floor(uploadData.limits.maxBytes/1024/1024)+' MB；暂存 '+uploadData.limits.stageExpiresMinutes+' 分钟内必须完成最终确认。';
    var current=q('#uploadStore').value;q('#uploadStore').innerHTML=(uploadData.stores||[]).map(function(s){return '<option value="'+esc(s.key)+'">'+esc(s.name)+' · '+esc(s.market)+'</option>'}).join('');if(current&&uploadData.stores.some(function(s){return s.key===current}))q('#uploadStore').value=current;
    var filter=q('#uploadStoreFilter'),filterValue=filter.value;filter.innerHTML='<option value="">全部店铺</option>'+(uploadData.stores||[]).map(function(s){return '<option value="'+esc(s.key)+'">'+esc(s.name)+'</option>'}).join('');if(filterValue&&(uploadData.stores||[]).some(function(s){return s.key===filterValue}))filter.value=filterValue;
    if(!uploadData.enabled)showUploadMessage('商品上传当前按生产策略关闭；九项巡检与看板不受影响。完成安全扫描和紫鸟真机页面校准后才能开启。','neutral');else if(!uploadData.authorized)showUploadMessage('当前登录账号没有商品上传权限，请联系系统管理员。','neutral');else if(noStores)showUploadMessage('当前没有可用于上传的已启用店铺。','neutral');
    q('#uploadResetCount').textContent=uploadData.resetCount?'（'+uploadData.resetCount+'）':'';q('#uploadCorrupt').style.display=uploadData.corrupt>0?'inline-flex':'none';q('#uploadCorrupt').textContent=uploadData.corrupt+' 个账本异常';
  }
  function renderUploadHistory(){
    if(!uploadData)return;var openDetails=Array.from(q('#uploadHistory').querySelectorAll('details[open][data-upload-details]')).map(function(el){return el.getAttribute('data-upload-details')});renderUploadResultSummary();var rows=uploadData.jobs||[];if(!rows.length){q('#uploadHistory').innerHTML='<div class="empty">当前筛选条件下没有上传任务</div>'}else{q('#uploadHistory').innerHTML=rows.map(function(job){var st=uploadState(job.state),result=uploadResult(job.result&&job.result.code),center=job.resultCenter||{},ident=center.identifiers||{},batch=ident.availability!=='NOT_AVAILABLE'?(ident.batchId||ident.submissionId):null,errors=center.errors||{},errorLine=errors.availability==='AVAILABLE'&&errors.total!=null?' · 错误 '+errors.total+' 条':'',action=job.state==='STAGED'?'<button class="secondary" type="button" data-continue-upload="'+esc(job.id)+'">继续确认</button>':job.reset&&job.reset.eligible&&uploadData.authorized?'<button class="secondary" type="button" data-reset-upload="'+esc(job.id)+'" '+(resettingUploadJobId?'disabled':'')+'>'+(resettingUploadJobId===job.id?'正在重置…':'重置重复上传')+'</button>':'<small>'+esc(job.reset&&job.reset.resetAt?'已手动重置 · '+timeText(job.reset.resetAt):timeText(job.createdAt))+'</small>';return '<article class="upload-row"><div><b>'+esc(job.store.name)+'</b><small>'+esc(job.store.key)+' · '+esc(job.store.market)+'</small></div><div><span class="badge '+stateClass(st[1])+'">'+esc(st[0])+'</span><small>'+esc(job.id)+'</small></div><div><b>'+esc(job.file.extension)+' · '+esc(job.file.size)+' B</b><small>'+esc(uploadModeLabel(job.mode))+'</small><small class="upload-hash">SHA-256 '+esc(job.file.sha256Short)+'</small></div><div><b>'+esc(result)+'</b><small class="upload-result-line">'+esc(job.state==='FAILED_BEFORE_SUBMIT'?'尚未转交 Amazon':uploadProcessing(center))+(batch?' · 批次 '+esc(batch):'')+esc(errorLine)+'</small><small class="upload-result-line">'+esc(uploadCountLine(center))+' · 更新 '+esc(timeText(center.observedAt||job.updatedAt))+'</small></div>'+action+uploadDetails(job,openDetails.indexOf(job.id)>=0)+'</article>'}).join('')}
    var p=uploadData.pagination||{page:1,pageCount:1,total:rows.length};q('#uploadPager').innerHTML=p.pageCount<=1?(p.total?'<span>共 '+p.total+' 条</span>':''):'<button type="button" data-upload-page="'+(p.page-1)+'" '+(p.page<=1?'disabled':'')+'>上一页</button><b aria-current="page">'+p.page+' / '+p.pageCount+'</b><button type="button" data-upload-page="'+(p.page+1)+'" '+(p.page>=p.pageCount?'disabled':'')+'>下一页</button><span>共 '+p.total+' 条</span>';
  }
  async function loadUploads(page){
    var history=q('#uploadHistory');history.setAttribute('aria-busy','true');var store=q('#uploadStoreFilter').value,state=q('#uploadStateFilter').value;
    try{var r=await fetch('/api/product-uploads?page='+encodeURIComponent(page||1)+'&pageSize='+Math.min(displaySettings.listPageSize,50)+'&store='+encodeURIComponent(store)+'&state='+encodeURIComponent(state)+'&includeReset='+(q('#includeResetUploads').checked?'1':'0'),{cache:'no-store'});if(r.status===401){if(crmReadOnly){endCrmSession('会话已失效，请从 CRM 重新进入。')}else location.href='/login';return}var body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));uploadData=body;uploadPage=body.pagination.page;renderUploadContext();renderUploadHistory()}
    catch(e){showUploadMessage('上传工作区加载失败：'+e.message,'bad')}finally{history.removeAttribute('aria-busy')}
  }
  function showStagedUpload(job){
    uploadConfirmReturnFocus=document.activeElement;stagedUploadJob=job;q('#confirmCard').classList.add('open');q('#confirmPhrase').value='';q('#confirmAck').checked=false;
    q('#confirmSummary').innerHTML='<div><small>目标店铺</small><b>'+esc(job.store.name)+' · '+esc(job.store.key)+'</b></div><div><small>文件 · '+esc(uploadModeLabel(job.mode))+'</small><b>'+esc(job.file.extension)+' · '+esc(job.file.size)+' B</b></div><div><small>文件摘要</small><b class="upload-hash">'+esc(job.file.sha256Short)+'</b></div><div><small>必须完整输入</small><b>'+esc(job.confirmationPhrase)+'</b></div>';q('#confirmPhrase').focus();
  }
  async function stageUpload(e){
    e.preventDefault();if(!uploadData||!uploadData.enabled||!uploadData.authorized)return;var file=q('#uploadFile').files[0],storeKey=q('#uploadStore').value;if(!file||!storeKey){showUploadMessage('请选择目标店铺和批量文件。','bad');return}if(file.size>uploadData.limits.maxBytes){showUploadMessage('文件超过允许大小。','bad');return}
    var button=q('#stageUpload');button.disabled=true;button.textContent='正在本地预检…';
    try{var r=await fetch('/api/product-uploads/stage',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Amzguard-Csrf':uploadData.csrf,'X-Amzguard-Store-Key':storeKey,'X-Amzguard-File-Name':encodeURIComponent(file.name),'X-Amzguard-Upload-Mode':q('#uploadMode').value},body:file});var body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));showUploadMessage(body.job.mode==='SIMPLE'?'文件已原样暂存。确认后转交 Amazon 核验，请核对下方店铺与文件信息。':'文件已完成本地格式预检并暂存，请核对下方信息。','ok');showStagedUpload(body.job);await loadUploads(1)}catch(error){showUploadMessage('预检失败：'+error.message,'bad')}finally{button.disabled=!uploadData.enabled||!uploadData.authorized;button.textContent='暂存文件，继续确认'}
  }
  async function confirmUpload(e){
    e.preventDefault();if(!stagedUploadJob||!uploadData)return;var phrase=q('#confirmPhrase').value;var button=q('#confirmUpload');button.disabled=true;button.textContent='正在确认授权…';
    var payload={jobId:stagedUploadJob.id,storeKey:stagedUploadJob.store.key,sha256Short:stagedUploadJob.file.sha256Short,size:stagedUploadJob.file.size,confirmationChallenge:stagedUploadJob.confirmationChallenge,phrase:phrase};
    q('#confirmForm').setAttribute('aria-busy','true');try{var r=await fetch('/api/product-uploads/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-Amzguard-Csrf':uploadData.csrf},body:JSON.stringify(payload)});var body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));showUploadMessage('任务已获得本次 Amazon 提交授权并进入队列。结果未知时系统不会自动重试。','ok');stagedUploadJob=null;q('#confirmCard').classList.remove('open');q('#uploadForm').reset();renderUploadMode();if(uploadConfirmReturnFocus&&uploadConfirmReturnFocus.focus)uploadConfirmReturnFocus.focus();await loadUploads(1)}catch(error){showUploadMessage('最终确认失败：'+error.message,'bad')}finally{q('#confirmForm').removeAttribute('aria-busy');button.disabled=false;button.textContent='确认并授权向 Amazon 提交'}
  }

  async function refreshUploadResult(job){
    if(!uploadData||!uploadData.authorized)return;
    try{
      var response=await fetch('/api/product-uploads/refresh',{method:'POST',headers:{'Content-Type':'application/json','X-Amzguard-Csrf':uploadData.csrf},body:JSON.stringify({jobId:job.id})});var result=await response.json();if(!response.ok)throw new Error(result.error||('HTTP '+response.status));
      showUploadMessage('已安排读取这个批次的处理结果，稍后会自动显示在本页。','ok');
    }catch(error){showUploadMessage('结果刷新未完成：'+error.message,'bad')}
    await loadUploads(uploadPage);
  }

  async function resetDuplicateUpload(job){
    if(resettingUploadJobId||!uploadData||!uploadData.authorized||!job.reset||!job.reset.eligible)return;
    resettingUploadJobId=job.id;renderUploadHistory();
    var payload={jobId:job.id,storeKey:job.store.key,sha256Short:job.file.sha256Short,size:job.file.size,resetChallenge:job.reset.confirmationChallenge};
    try{
      var response=await fetch('/api/product-uploads/reset',{method:'POST',headers:{'Content-Type':'application/json','X-Amzguard-Csrf':uploadData.csrf},body:JSON.stringify(payload)});var result=await response.json();if(!response.ok)throw new Error(result.error||('HTTP '+response.status));
      showUploadMessage('已重置这条旧任务的重复拦截。请重新选择文件并暂存，新任务仍需确认后才能提交。旧记录可在“显示已重置记录”中查看。','ok');await loadUploads(1);
    }catch(error){showUploadMessage('重置未完成：'+error.message,'bad');await loadUploads(uploadPage);}
    finally{resettingUploadJobId=null;renderUploadHistory();}
  }

  function showSetting(selector,message,kind){var el=q(selector);el.textContent=message;el.className='settings-message '+(kind||'bad')}
  function renderAdsRules(){
    if(!adsRulesData)return;var missing=(adsRulesData.rules||[]).filter(function(x){return !x.configured}).length;var state=q('#adsRulesState');state.textContent=missing?missing+' 家未配置':'全部已配置';state.className='badge '+stateClass(missing?'ERROR':'OK');
    q('#adsRuleList').innerHTML=(adsRulesData.rules||[]).map(function(rule){return '<div class="rule-row"><div><b>'+esc(rule.storeName)+'</b><small>'+esc(rule.storeKey)+'</small></div><div><label class="settings-field"><span style="display:block;font-size:10px;font-weight:700;margin-bottom:5px">组合名称包含</span><input data-ads-rule="'+esc(rule.storeKey)+'" value="'+esc(rule.nameContains)+'" maxlength="40" required '+(adsRulesData.canManage?'':'disabled')+'></label></div><small>逐组合核对全部活动</small></div>'}).join('')||'<div class="empty">没有已启用店铺</div>';
    q('#saveAdsRules').disabled=!adsRulesData.canManage;if(!adsRulesData.canManage)showSetting('#adsRulesMessage','当前账户可查看规则，但只有管理员可以修改。','neutral')
  }
  async function loadAdsRules(){
    try{var r=await fetch('/api/ads-rules',{cache:'no-store'});if(r.status===401){if(crmReadOnly){endCrmSession('会话已失效，请从 CRM 重新进入。')}else location.href='/login';return}var body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));adsRulesData=body;renderAdsRules()}catch(e){showSetting('#adsRulesMessage','广告规则加载失败：'+e.message,'bad')}
  }
  async function saveAdsRules(e){
    e.preventDefault();if(!adsRulesData||!adsRulesData.canManage)return;var rules=[].slice.call(document.querySelectorAll('[data-ads-rule]')).map(function(input){return {storeKey:input.getAttribute('data-ads-rule'),nameContains:input.value.trim()}});var button=q('#saveAdsRules');button.disabled=true;
    try{var r=await fetch('/api/ads-rules',{method:'PUT',headers:{'Content-Type':'application/json','X-Amzguard-Csrf':adsRulesData.csrf},body:JSON.stringify({rules:rules})});var body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));adsRulesData=body;renderAdsRules();showSetting('#adsRulesMessage','已保存。恢复监测后，按这些名称特征匹配广告组合，再核对组合内全部活动。','ok')}catch(error){showSetting('#adsRulesMessage','保存失败：'+error.message,'bad')}finally{button.disabled=!adsRulesData.canManage}
  }
  function renderUsers(){
    if(!userData)return;var badge=q('#userRoleState');badge.textContent=userData.canManage?'管理员 · '+userData.users.length+' 个账户':'操作员 · 仅可修改自己密码';badge.className='badge '+stateClass(userData.canManage?'OK':'SKIPPED');q('#createUserForm').querySelectorAll('input,select,button').forEach(function(el){el.disabled=!userData.canManage});
    q('#userList').innerHTML=(userData.users||[]).map(function(user){var mine=userData.me&&user.username===userData.me.username;var role='<select data-user-role="'+esc(user.username)+'" '+(!userData.canManage||mine?'disabled':'')+'><option value="operator" '+(user.role==='operator'?'selected':'')+'>操作员</option><option value="admin" '+(user.role==='admin'?'selected':'')+'>管理员</option></select>';var enabled='<label><input type="checkbox" data-user-enabled="'+esc(user.username)+'" '+(user.enabled?'checked':'')+' '+(!userData.canManage||mine?'disabled':'')+'> 启用</label>';var reset=mine?'<small>请使用上方“修改我的密码”</small>':'<input type="password" data-user-password="'+esc(user.username)+'" minlength="12" placeholder="新密码（至少 12 位）" autocomplete="new-password" '+(userData.canManage?'':'disabled')+'>';var actions=mine?'<small>当前账户</small>':userData.canManage?'<div class="row-actions"><button type="button" data-user-action="save" data-username="'+esc(user.username)+'">保存状态</button><button type="button" data-user-action="reset" data-username="'+esc(user.username)+'">重置密码</button><button class="danger" type="button" data-user-action="delete" data-username="'+esc(user.username)+'">删除</button></div>':'';return '<div class="user-row"><div><b>'+esc(user.username)+(mine?'（我）':'')+'</b><small>更新 '+esc(timeText(user.updatedAt))+'</small></div>'+role+'<div>'+enabled+'</div><div>'+reset+'</div>'+actions+'</div>'}).join('')||'<div class="empty">没有账户</div>';
    if(!userData.canManage)showSetting('#createUserMessage','当前账户不是管理员，不能创建或维护其他账户。','neutral')
  }
  async function loadUsers(){
    try{var r=await fetch('/api/users',{cache:'no-store'});if(r.status===401){if(crmReadOnly){endCrmSession('会话已失效，请从 CRM 重新进入。')}else location.href='/login';return}var body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));userData=body;renderUsers()}catch(e){showSetting('#userMessage','用户列表加载失败：'+e.message,'bad')}
  }
  async function createUser(e){
    e.preventDefault();if(!userData||!userData.canManage)return;var payload={username:q('#createUsername').value.trim(),password:q('#createPassword').value,role:q('#createRole').value};
    try{var r=await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json','X-Amzguard-Csrf':userData.csrf},body:JSON.stringify(payload)});payload.password='';q('#createPassword').value='';var body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));q('#createUserForm').reset();showSetting('#createUserMessage','账户 '+body.user.username+' 已创建。','ok');await loadUsers()}catch(error){payload.password='';showSetting('#createUserMessage','创建失败：'+error.message,'bad')}
  }
  async function changeOwnPassword(e){
    e.preventDefault();if(!userData)return;var next=q('#newPassword').value;if(next!==q('#newPasswordAgain').value){showSetting('#ownPasswordMessage','两次输入的新密码不一致。','bad');return}var payload={currentPassword:q('#currentPassword').value,newPassword:next};q('#currentPassword').value='';q('#newPassword').value='';q('#newPasswordAgain').value='';
    try{var r=await fetch('/api/account/password',{method:'POST',headers:{'Content-Type':'application/json','X-Amzguard-Csrf':userData.csrf},body:JSON.stringify(payload)});payload.currentPassword='';payload.newPassword='';var body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));location.href='/login'}catch(error){payload.currentPassword='';payload.newPassword='';showSetting('#ownPasswordMessage','密码修改失败：'+error.message,'bad')}
  }
  async function userAction(button){
    if(!userData||!userData.canManage)return;var username=button.getAttribute('data-username'),action=button.getAttribute('data-user-action'),options={method:'PATCH',headers:{'Content-Type':'application/json','X-Amzguard-Csrf':userData.csrf}},payload={};
    if(action==='save'){payload.role=q('[data-user-role="'+CSS.escape(username)+'"]').value;payload.enabled=q('[data-user-enabled="'+CSS.escape(username)+'"]').checked}else if(action==='reset'){var input=q('[data-user-password="'+CSS.escape(username)+'"]');payload.password=input.value;input.value='';if(payload.password.length<12){showSetting('#userMessage','新密码至少 12 位。','bad');return}}else if(action==='delete'){if(!confirm('确定删除账户 '+username+'？'))return;options.method='DELETE'}
    if(options.method!=='DELETE')options.body=JSON.stringify(payload);button.disabled=true;try{var r=await fetch('/api/users/'+encodeURIComponent(username),options);if(payload.password)payload.password='';var body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));showSetting('#userMessage',action==='delete'?'账户已删除。':'账户已更新，旧会话已失效。','ok');await loadUsers()}catch(error){if(payload.password)payload.password='';showSetting('#userMessage','操作失败：'+error.message,'bad')}finally{button.disabled=false}
  }

  var drawerReturnFocus=null,activeDetail=null,historySelection=null,historyData=null,historyRequest=0;
  function evidenceHtml(e){var dom=e&&e.dom||{available:false};var text=e&&e.text||{available:false};function part(name,x){var detail=x.available?(x.status||x.reliable===true?'已取得':'已取得'):'未取得';if(x.status)detail+=' · '+x.status;if(x.reliable===false)detail+=' · 低可靠';return '<span class="'+(x.available?'ok':'')+'">'+name+'：'+esc(detail)+'</span>'}return '<div class="evidence" aria-label="双路证据">'+part('DOM',dom)+part('页面文本',text)+'</div>'}
  function openDetail(storeKey,checkId,refreshing){
    if(refreshing&&document.activeElement&&/^(historyDate|historyRun)$/.test(document.activeElement.id))return;
    if(!data)return;var store=data.stores.find(function(s){return s.key===storeKey});var check=data.checks.find(function(c){return c.id===checkId});if(!store||!check)return;var cell=store.cells[checkId];if(!refreshing){drawerReturnFocus=document.activeElement;historySelection=null;historyData=null;historyRequest++}activeDetail={storeKey:storeKey,checkId:checkId};
    q('#drawerTitle').textContent=store.name+' · '+check.short;q('#drawerMeta').textContent='事项 0'+check.no+' · '+(store.market||'未标记站点')+' · '+(cell.lastRunAt?timeText(cell.lastRunAt):'从未运行');
    var reasons=(cell.reasons||[]);var resultHtml=(cell.results||[]).map(function(r){var metrics=(checkId==='reviews'?['newLowCount','recordedLowCount','ownedLowCount','brandLowCount','selectedStars','paginationComplete','pagesCollected','collectionStatus','ownershipReady','ownershipPendingCount','excludedOtherStoreCount','excludedOutOfScopeCount'].filter(function(k){return k in (r.metrics||{})}):checkId==='ads-status'?['matching','total','matchingPercent','recordedExceptionCount','exceptionCount','enabled','paused','limited','excluded','portfolioCount','campaignCount','collectionStatus','majorityRule','expected'].filter(function(k){return k in (r.metrics||{})}):Object.keys(r.metrics||{})).filter(function(k){var v=r.metrics[k];return k!=='observedBusinessItemKeys'&&(typeof v!=='object'||Array.isArray(v))}).slice(0,14).map(function(k){return '<div class="metric"><small>'+esc(r.metrics.source==='portfolio+campaign'&&k==='enabled'?'可投放':r.metrics.source==='portfolio+campaign'&&k==='paused'?'未投放':METRIC_LABEL[k]||k)+'</small><b title="'+esc(valueText(r.metrics[k]))+'">'+esc(valueText(r.metrics[k]))+'</b></div>'}).join('');var items=(r.items||[]).slice(0,8).map(function(item){return itemHtml(item,checkId,r.reviewScreenshots)}).join('');var sm=r.screenshotMeta||{};var shotLabel='查看 '+esc(sm.storeKey||store.key)+' 店铺截图'+(sm.page?' · 第 '+sm.page+' / '+sm.pages+' 页':'')+(sm.evidenceId?' · 证据 '+esc(sm.evidenceId):'')+' →';return '<article class="result"><div class="result-head"><b>'+esc(r.subject||store.name)+'</b><span class="badge '+stateClass(r.severity)+'">'+esc(resultStatusLabel(r.status))+'</span></div>'+(r.reasons&&r.reasons.length?'<ul>'+r.reasons.map(function(reason){return '<li>'+esc(reason)+'</li>'}).join('')+'</ul>':'')+reviewSummaryHtml(r,checkId)+(metrics?'<div class="metrics">'+metrics+'</div>':'')+(items?'<div class="detail-block"><h4>'+(checkId==='ads-status'&&r.metrics.recordedExceptionCount?'少数例外留档与活动明细':'结构化明细')+'</h4><div class="item-list">'+items+'</div>'+((r.items||[]).length>8?'<p class="kpi-note">这里展示前 8 条，点击下方采集日期可逐页查看全部明细。</p>':'')+'</div>':'')+evidenceHtml(r.evidence)+(r.screenshot?'<a class="shot" href="'+esc(r.screenshot)+'" target="_blank" rel="noopener">'+shotLabel+'</a>':'')+'</article>'}).join('');
    var trend=(cell.trend||[]);var trendHtml=trend.length?'<div class="history-trend" aria-label="按采集日期查看历史，颜色为当日最严重状态">'+trend.map(function(point){return '<button type="button" class="history-day" data-history-date="'+esc(point.date)+'" aria-pressed="false" title="'+esc(point.date+' · '+stateLabel(point.state)+' · '+point.runCount+' 次采集')+'"><i class="'+esc(point.state)+'" aria-hidden="true"></i>'+esc(point.date.slice(5))+'<br>'+esc(point.runCount)+' 次</button>'}).join('')+'</div>':'<div class="empty">暂无历史采集记录</div>';var previous=cell.previous?'<button type="button" class="history-link" data-history-date="'+esc(cell.previous.date)+'" data-history-run="'+esc(cell.previous.runId)+'">查看前次：'+esc(stateLabel(cell.previous.state)+' · '+timeText(cell.previous.at))+'</button>':'无可比历史';
    q('#drawerBody').innerHTML='<div class="detail-state '+stateClass(cell.stale?'ERROR':cell.state)+'"><div><b>'+esc(cell.stateLabel)+'</b><small>'+esc(resultStatusLabel(cell.status))+'</small></div><span class="badge '+stateClass(cell.stale?'ERROR':cell.state)+'">'+esc(cell.actionOwner)+'负责</span></div>'+(checkId==='reviews'?reviewBrandNote(storeKey):'')+'<div class="detail-block"><h4>当前行动</h4><div>'+esc(cell.actionLabel)+' · '+esc(cell.actionOwner)+'负责。'+(checkId==='ads-status'?'按当前时段的多数规则判断，少数例外可在下方留档中查阅。':'原始判定标准未降低。')+'</div></div><div class="detail-block"><h4>判定要求</h4><div>'+esc(check.requirement)+'</div></div>'+(reasons.length?'<div class="detail-block"><h4>'+(checkId==='ads-status'&&cell.state==='OK'?'判定与留档说明':'需处理原因')+'</h4><ul>'+reasons.map(function(r){return '<li>'+esc(r)+'</li>'}).join('')+'</ul></div>':'')+'<div class="detail-block"><h4>采集结果与指标</h4>'+(resultHtml||'<div class="empty">最近一批报告没有该店铺的采集结果。</div>')+'</div><div class="detail-block"><h4>历史趋势与前次对比</h4>'+trendHtml+'<div class="kpi-note">'+previous+'</div><p class="kpi-note">点击日期查看当日记录（北京时间）；同一天可切换各次采集。颜色表示当天最严重状态。</p><div class="history-controls"><label for="historyDate">采集日期</label><input type="date" id="historyDate" aria-label="采集日期"></div><div id="historyRecords" class="history-records" aria-live="polite"></div></div><div class="detail-block"><h4>运行信息</h4><div class="metrics"><div class="metric"><small>最近运行</small><b>'+esc(cell.lastRunAt?timeText(cell.lastRunAt):'从未')+'</b></div><div class="metric"><small>耗时</small><b>'+esc(cell.durationMs!=null?Math.round(cell.durationMs/1000)+' 秒':'—')+'</b></div><div class="metric"><small>批次</small><b>'+esc(cell.slot||'—')+'</b></div><div class="metric"><small>运行 ID</small><b title="'+esc(cell.runId||'—')+'">'+esc(cell.runId||'—')+'</b></div><div class="metric"><small>置信度</small><b>'+esc((cell.results[0]&&cell.results[0].confidence)||'—')+'</b></div></div></div>';
    q('#drawerBackdrop').classList.add('open');q('#drawerBackdrop').setAttribute('aria-hidden','false');document.body.style.overflow='hidden';if(!refreshing)q('#closeDrawer').focus();
    var selected=historySelection||{date:trend.length?trend[trend.length-1].date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),runId:'',page:1};loadHistoryDay(selected.date,selected.runId,selected.page);
  }
  function renderHistoryRecords(body){
    var target=q('#historyRecords');if(!target||!activeDetail)return;
    var checkId=activeDetail.checkId;
    if(!body.runs.length){target.innerHTML='<div class="empty">这一天没有留存的采集记录。历史记录只包含当时实际采集到的数据，无法补还当时漏采的评价。</div>';return}
    var selected=body.selectedRun;
    var html='<div class="history-controls"><label for="historyRun">当日采集</label><select id="historyRun">'+body.runs.map(function(run){return '<option value="'+esc(run.runId)+'"'+(run.runId===selected.runId?' selected':'')+'>'+esc(timeText(run.at)+' · '+({am:'早巡',pm:'晚巡',adhoc:'手动采集'}[run.slot]||run.slot)+' · '+stateLabel(run.state))+'</option>'}).join('')+'</select></div><div class="kpi-note">本次 '+esc(selected.itemCount)+' 条结构化明细 · '+esc(selected.resultCount)+' 项结果'+(checkId==='reviews'?'。评价发表日期见明细；Amazon 可能延迟最多 72 小时显示。':'')+'</div>';
    var lastKey='';
    body.records.forEach(function(record){var r=record.result,key=r.subject+'|'+r.checkedAt;if(key!==lastKey){html+='<article class="result"><div class="result-head"><b>'+esc(r.subject)+'</b><span class="badge '+stateClass(r.severity)+'">'+esc(resultStatusLabel(r.status))+'</span></div><small>'+esc(timeText(r.checkedAt))+'</small>'+(r.reasons.length?'<ul>'+r.reasons.map(function(reason){return '<li>'+esc(reason)+'</li>'}).join('')+'</ul>':'')+evidenceHtml(r.evidence)+'</article>';lastKey=key}html+=record.item?itemHtml(record.item,checkId,r.reviewScreenshots):'<p class="kpi-note">该项没有结构化条目，请结合状态与原因查看。</p>'});
    html+='<div class="history-controls"><button type="button" class="btn" data-history-page="'+(body.page-1)+'"'+(body.page<=1?' disabled':'')+'>上一页</button><span>第 '+body.page+' / '+body.pages+' 页 · '+body.total+' 条记录</span><button type="button" class="btn" data-history-page="'+(body.page+1)+'"'+(body.page>=body.pages?' disabled':'')+'>下一页</button></div>';
    target.innerHTML=html;
  }
  async function loadHistoryDay(date,runId,page){
    if(!activeDetail||!date)return;var request=++historyRequest,detail=activeDetail;historySelection={date:date,runId:runId||'',page:page||1};
    q('#historyDate').value=date;document.querySelectorAll('.history-day').forEach(function(button){button.setAttribute('aria-pressed',String(button.dataset.historyDate===date))});
    var target=q('#historyRecords');target.setAttribute('aria-busy','true');if(historyData&&historyData.storeKey===detail.storeKey&&historyData.checkId===detail.checkId&&historyData.date===date&&historyData.page===(page||1)&&historyData.selectedRun&&historyData.selectedRun.runId===(runId||''))renderHistoryRecords(historyData);else target.innerHTML='<div class="empty">正在读取 '+esc(date)+' 的采集记录…</div>';
    try{var params=new URLSearchParams({store:detail.storeKey,date:date,page:String(page||1)});if(runId)params.set('runId',runId);var response=await fetch('/api/history/'+encodeURIComponent(detail.checkId)+'?'+params,{cache:'no-store'});if(response.status===401){if(crmReadOnly){endCrmSession('会话已失效，请从 CRM 重新进入。')}else location.href='/login';return}if(!response.ok)throw new Error('历史读取失败（'+response.status+'）');var body=await response.json();if(request!==historyRequest||!activeDetail||detail!==activeDetail)return;historyData=body;historySelection={date:date,runId:body.selectedRun?body.selectedRun.runId:'',page:body.page};renderHistoryRecords(body)}catch(error){if(request===historyRequest&&activeDetail)target.innerHTML='<div class="empty">'+esc(error.message)+'。可重新选择日期重试。</div>'}finally{if(request===historyRequest)target.removeAttribute('aria-busy')}
  }
  function closeDetail(){activeDetail=null;historyRequest++;historySelection=null;historyData=null;q('#drawerBackdrop').classList.remove('open');q('#drawerBackdrop').setAttribute('aria-hidden','true');document.body.style.overflow='';if(drawerReturnFocus&&drawerReturnFocus.focus)drawerReturnFocus.focus()}

  function render(){renderHero();renderKpis();renderReadiness();renderProgress();renderSystemProgress();renderSchedule('#scheduleList',false);renderSchedule('#adsScheduleList',true);renderGroupMatrix('risk','riskMatrix','riskMatrix');renderGroupMatrix('voice','voiceMatrix','voiceMatrix');renderGroupMatrix('product','productMatrix','productMatrix');renderGroupMatrix('ads','adsMatrix','adsMatrix');renderSessions();renderAsinInventory();renderMonitoringRecommendations();renderEvidenceCompleteness();renderIssueQueue({group:'risk',key:'riskIssues',prefix:'riskIssue'});renderIssueQueue({group:'voice',key:'voiceIssues',prefix:'voiceIssue'});renderIssueQueue({group:'product',key:'productIssues',prefix:'productIssue'});renderIssueQueue({group:'ads',key:'adsIssues',prefix:'adsIssue'});renderIssueQueue({key:'systemIssues',prefix:'systemIssue',collectionOnly:true});renderChecks();renderChannels();renderAlerts()}
  async function load(){
    if(loading||!uiReady)return;loading=true;
    q('#refresh').disabled=true;q('#refresh').setAttribute('aria-busy','true');
    try{var r=await fetch('/api/status',{cache:'no-store'});if(r.status===401){if(crmReadOnly){endCrmSession('会话已失效，请从 CRM 重新进入。')}else location.href='/login';return}if(!r.ok)throw new Error('服务暂时不可用（'+r.status+'）');var next=await r.json();if(sessionEnded)return;if(!next||!Array.isArray(next.stores)||!Array.isArray(next.checks))throw new Error('返回数据格式不完整');if(data&&data.progress&&next.progress&&Date.parse(data.progress.updatedAt)>Date.parse(next.progress.updatedAt))next.progress=data.progress;data=next;q('#error').style.display='none';render();if(activeDetail&&q('#drawerBackdrop').classList.contains('open'))openDetail(activeDetail.storeKey,activeDetail.checkId,true)}
    catch(e){q('#error').textContent='看板数据加载失败：'+e.message+'。系统会继续自动重试。';q('#error').style.display='block'}
    finally{loading=false;q('#refresh').disabled=false;q('#refresh').removeAttribute('aria-busy')}
  }
  async function loadProgress(){
    if(progressLoading||!data)return;progressLoading=true;
    var controller=new AbortController(),timeout=setTimeout(function(){controller.abort()},8000);
    try{
      var response=await fetch('/api/progress',{cache:'no-store',signal:controller.signal});
      if(response.status===401){if(crmReadOnly){endCrmSession('会话已失效，请从 CRM 重新进入。')}else location.href='/login';return}if(!response.ok)throw new Error('Progress unavailable');
      var next=await response.json();if(sessionEnded)return;if(!next||typeof next.active!=='boolean')throw new Error('Invalid progress');
      var previous=data.progress||{};progressDisconnected=false;
      // A concurrent, slower status request must not roll live progress back.
      if(!previous.updatedAt||!next.updatedAt||Date.parse(next.updatedAt)>=Date.parse(previous.updatedAt))data.progress=next;
      renderProgress();renderSystemProgress();updateExecutionCells();
      if(previous.runId!==next.runId||previous.state!==next.state||previous.completed!==next.completed)load();
    }catch(error){progressDisconnected=true;renderProgress();renderSystemProgress();updateExecutionCells()}
    finally{clearTimeout(timeout);progressLoading=false}
  }
  function resetMatrix(group){var key=group+'Matrix';pages[key]=1;renderGroupMatrix(group,key,key)}
  function rerenderPage(key){if(key==='riskMatrix')renderGroupMatrix('risk','riskMatrix','riskMatrix');else if(key==='voiceMatrix')renderGroupMatrix('voice','voiceMatrix','voiceMatrix');else if(key==='productMatrix')renderGroupMatrix('product','productMatrix','productMatrix');else if(key==='adsMatrix')renderGroupMatrix('ads','adsMatrix','adsMatrix');else if(key==='riskIssues')renderIssueQueue({group:'risk',key:'riskIssues',prefix:'riskIssue'});else if(key==='voiceIssues')renderIssueQueue({group:'voice',key:'voiceIssues',prefix:'voiceIssue'});else if(key==='productIssues')renderIssueQueue({group:'product',key:'productIssues',prefix:'productIssue'});else if(key==='adsIssues')renderIssueQueue({group:'ads',key:'adsIssues',prefix:'adsIssue'});else if(key==='systemIssues')renderIssueQueue({key:'systemIssues',prefix:'systemIssue',collectionOnly:true});else if(key==='asins')renderAsinInventory();else if(key==='recommendations')renderMonitoringRecommendations();else if(key==='evidenceGaps')renderEvidenceCompleteness();else if(key==='alerts')renderAlerts();else if(key==='sessions')renderSessions()}
  q('#refresh').addEventListener('click',function(){if(!uiReady)return;if(activeView==='intelligence')window.amzIntelligence.refresh();else if(activeView==='stores')storeSettings.refresh();else load()});document.querySelectorAll('[data-matrix-filter]').forEach(function(control){var event=control.type==='search'?'input':'change';control.addEventListener(event,function(){resetMatrix(control.getAttribute('data-matrix-filter'))})});
  q('#drawerBody').addEventListener('click',function(e){var day=e.target.closest('[data-history-date]');if(day){loadHistoryDay(day.dataset.historyDate,day.dataset.historyRun||'',1);q('#historyDate').scrollIntoView({block:'nearest'});return}var page=e.target.closest('[data-history-page]');if(page&&!page.disabled&&historySelection)loadHistoryDay(historySelection.date,historySelection.runId,Number(page.dataset.historyPage))});
  q('#drawerBody').addEventListener('change',function(e){if(e.target.id==='historyDate'&&e.target.value)loadHistoryDay(e.target.value,'',1);if(e.target.id==='historyRun'&&historySelection)loadHistoryDay(historySelection.date,e.target.value,1)});
  q('#includeResetUploads').addEventListener('change',function(){loadUploads(1)});q('#uploadMode').addEventListener('change',renderUploadMode);q('#uploadForm').addEventListener('submit',stageUpload);q('#confirmForm').addEventListener('submit',confirmUpload);q('#adsRulesForm').addEventListener('submit',saveAdsRules);q('#createUserForm').addEventListener('submit',createUser);q('#ownPasswordForm').addEventListener('submit',changeOwnPassword);q('#userList').addEventListener('click',function(e){var button=e.target.closest('[data-user-action]');if(button)userAction(button)});q('#uploadStoreFilter').addEventListener('change',function(){loadUploads(1)});q('#uploadStateFilter').addEventListener('change',function(){loadUploads(1)});q('#cancelConfirm').addEventListener('click',function(){stagedUploadJob=null;q('#confirmPhrase').value='';q('#confirmCard').classList.remove('open');showUploadMessage('任务仍处于待确认状态，30 分钟后自动过期；尚未访问 Amazon。','ok');if(uploadConfirmReturnFocus&&uploadConfirmReturnFocus.focus)uploadConfirmReturnFocus.focus()});
  document.addEventListener('click',function(e){var pageButton=e.target.closest('[data-page-key]');if(pageButton&&!pageButton.disabled){var key=pageButton.getAttribute('data-page-key');pages[key]=(pages[key]||1)+Number(pageButton.getAttribute('data-page-dir')||0);rerenderPage(key)}var uploadButton=e.target.closest('[data-upload-page]');if(uploadButton&&!uploadButton.disabled)loadUploads(Number(uploadButton.getAttribute('data-upload-page'))||1);var continueButton=e.target.closest('[data-continue-upload]');if(continueButton&&uploadData){var job=uploadData.jobs.find(function(x){return x.id===continueButton.getAttribute('data-continue-upload')});if(job)showStagedUpload(job)}var refreshButton=e.target.closest('[data-refresh-upload]');if(refreshButton&&!refreshButton.disabled&&uploadData){refreshButton.disabled=true;var refreshJob=uploadData.jobs.find(function(x){return x.id===refreshButton.getAttribute('data-refresh-upload')});if(refreshJob)refreshUploadResult(refreshJob)}var resetButton=e.target.closest('[data-reset-upload]');if(resetButton&&uploadData){var resetJob=uploadData.jobs.find(function(x){return x.id===resetButton.getAttribute('data-reset-upload')});if(resetJob)resetDuplicateUpload(resetJob)}var viewLink=e.target.closest('[data-view]');if(viewLink)activateView(viewLink.getAttribute('data-view'))});window.addEventListener('hashchange',function(){activateView(location.hash.slice(1))});
  ['#riskMatrixBody','#voiceMatrixBody','#productMatrixBody','#adsMatrixBody','#riskIssueList','#voiceIssueList','#productIssueList','#adsIssueList','#systemIssueList'].forEach(function(selector){q(selector).addEventListener('click',function(e){var b=e.target.closest('[data-store][data-check]');if(b)openDetail(b.dataset.store,b.dataset.check)})});
  q('#closeDrawer').addEventListener('click',closeDetail);q('#drawerBackdrop').addEventListener('click',function(e){if(e.target===this)closeDetail()});document.addEventListener('keydown',function(e){var open=q('#drawerBackdrop').classList.contains('open');if(e.key==='Escape'&&open)closeDetail();if(e.key==='Tab'&&open){var nodes=q('#drawerBackdrop').querySelectorAll('button:not([disabled]),a[href],input,select');if(!nodes.length)return;var first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});
  (${installOperatorTour.toString()})({window:window,document:document,lessons:${JSON.stringify(OPERATOR_LESSONS)},normalizeRecord:${normalizeTourRecord.toString()},activateView:activateView,readData:function(){return data},readUpload:function(){return uploadData}});
  function applyDisplaySettings(settings){
    displaySettings=settings;uiReady=true;
    Object.keys(pages).forEach(function(key){PAGE_SIZE[key]=/Matrix$/.test(key)?settings.matrixPageSize:settings.listPageSize});
    q('#refreshCadence').textContent='进度每 '+settings.progressRefreshSeconds+' 秒 · 报告每 '+settings.reportRefreshSeconds+' 秒刷新'+String.fromCharCode(10)+'北京时间运行';
    refreshTimers.forEach(function(timer){clearInterval(timer)});
    refreshTimers=[setInterval(load,settings.reportRefreshSeconds*1000),setInterval(loadProgress,settings.progressRefreshSeconds*1000),setInterval(function(){if(activeView==='upload')loadUploads(uploadPage)},settings.uploadRefreshSeconds*1000)];
    if(data)render();
  }
  var storeSettings=(${installStoreSettings.toString()})({window:window,document:document,settingsDefaults:${JSON.stringify(UI_DEFAULTS)},views:Object.keys(VIEW_META).map(function(id){return {id:id,title:VIEW_META[id][0]}}),onUiSettings:applyDisplaySettings,onStoresSaved:async function(){await Promise.all([load(),loadAdsRules(),loadUploads(uploadPage)])}});
  var initializeSettings=crmReadOnly ? fetch('/api/ui-config',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('会话已失效，请从 CRM 重新进入');return r.json()}).then(function(body){applyDisplaySettings(body.settings)}) : storeSettings.loadUIConfig();
  if(crmReadOnly){
    ['intelligence','upload','stores','users'].forEach(function(id){document.querySelectorAll('[data-view="'+id+'"],[data-view-panel="'+id+'"]').forEach(function(el){el.hidden=true;el.style.display='none'})});
    q('.logout-form').addEventListener('submit',async function(event){event.preventDefault();var r=await fetch('/crm/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(r.ok){endCrmSession('已退出，请从 CRM 重新进入。')}else{q('#error').textContent='退出失败，请重试。';q('#error').style.display='block'}});
  }
  initializeSettings.then(function(){activateView(location.hash.slice(1)||storeSettings.getDefaultView());if(activeView==='stores')storeSettings.activate();load()}).catch(function(error){q('#error').textContent=error.message;q('#error').style.display='block'});
})();
</script>
</body>
</html>`.replaceAll('/api/', crmReadOnly ? '/crm/dashboard/api/' : '/api/');
}

export const DASHBOARD_HTML = renderDashboard();
