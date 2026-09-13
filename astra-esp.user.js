// ==UserScript==
// @name         Astra Attack ESP
// @namespace    anon
// @version      1.1
// @description  Enemy wallhack overlay for astra-attack.pages.dev — boxes, health, distance, names, tracers. PC + mobile.
// @match        https://astra-attack.pages.dev/*
// @run-at       document-start
// @grant        none
// @homepageURL  https://github.com/ad2das/astra-esp
// @updateURL    https://raw.githubusercontent.com/ad2das/astra-esp/main/astra-esp.user.js
// @downloadURL  https://raw.githubusercontent.com/ad2das/astra-esp/main/astra-esp.user.js
// ==/UserScript==
//
// PC: Tampermonkey, or paste this whole file into DevTools console BEFORE
// clicking through the profile-entry dialog (the dialog gates the main module,
// so hooks install before the renderer exists).
//
// Mobile: Tampermonkey (Firefox/Edge on Android) or Userscripts (iOS Safari).
// Tap the ESP chip top-left to toggle. Drag it if it covers something.
//
// Keys (PC): F8 master | F7 teammates | F6 tracers | F9 self
(() => {
'use strict';
if (globalThis.__AA_ESP__ && globalThis.__AA_ESP__.loaded) return;

const S = {
  loaded: true,
  state: null,
  myId: null,
  names: new Map(),
  p: null, v: null,
  cfg: { on: true, self: false, mates: false, tracers: true },
  overlay: null, octx: null,
  ui: null, chip: null, subs: null, uiPos: null,
  toastAt: 0, toastMsg: '', lastHint: 0, enemyCount: 0,
};
globalThis.__AA_ESP__ = S;

try {
  const saved = JSON.parse(localStorage.getItem('aa-esp-cfg-v1') || 'null');
  if (saved && typeof saved === 'object') {
    if (saved.cfg) Object.assign(S.cfg, saved.cfg);
    if (saved.pos && typeof saved.pos.x === 'number') S.uiPos = saved.pos;
  }
} catch (e) {}
const persist = () => { try { localStorage.setItem('aa-esp-cfg-v1', JSON.stringify({ cfg: S.cfg, pos: S.uiPos })); } catch (e) {} };

/* ---------------- network sniff ---------------- */
const origParse = JSON.parse;
JSON.parse = function (text, reviver) {
  const out = origParse.call(this, text, reviver);
  try {
    if (out && typeof out === 'object' && !Array.isArray(out)) {
      if (Array.isArray(out.players) && Array.isArray(out.grenades)) {
        S.state = out;
        if (typeof out.me === 'string') S.myId = out.me;
        for (const p of out.players) if (p && typeof p.id === 'string' && p.name) S.names.set(p.id, p.name);
      } else if (out.type === 'welcome' && typeof out.id === 'string') {
        S.myId = out.id;
      }
    }
  } catch (e) {}
  return out;
};

/* ---------------- GL capture: named uniforms ---------------- */
const locName = new WeakMap();
const copy16 = (v) => { const a = new Float32Array(16); for (let i = 0; i < 16; i++) a[i] = v[i]; return a; };
const isRigid = (v) => {
  if (v[15] !== 1 || v[3] !== 0 || v[7] !== 0 || v[11] !== 0) return false;
  const r00 = v[0], r01 = v[4], r02 = v[8];
  const r10 = v[1], r11 = v[5], r12 = v[9];
  const r20 = v[2], r21 = v[6], r22 = v[10];
  if (Math.abs(r00 * r10 + r01 * r11 + r02 * r12) > 2e-2) return false;
  if (Math.abs(r00 * r20 + r01 * r21 + r02 * r22) > 2e-2) return false;
  if (Math.abs(r10 * r20 + r11 * r21 + r12 * r22) > 2e-2) return false;
  const l0 = r00 * r00 + r01 * r01 + r02 * r02;
  const l1 = r10 * r10 + r11 * r11 + r12 * r12;
  const l2 = r20 * r20 + r21 * r21 + r22 * r22;
  return Math.abs(l0 - 1) < 4e-2 && Math.abs(l1 - 1) < 4e-2 && Math.abs(l2 - 1) < 4e-2;
};
const camFromV = (v) => {
  const tx = v[12], ty = v[13], tz = v[14];
  return [-(v[0] * tx + v[1] * ty + v[2] * tz), -(v[4] * tx + v[5] * ty + v[6] * tz), -(v[8] * tx + v[9] * ty + v[10] * tz)];
};
const camSane = (c) => c[1] > 0.35 && c[1] < 60 && Math.abs(c[0]) < 500 && Math.abs(c[2]) < 500;
const nearOf = (v) => { const k = v[10], q = v[14]; return k === 1 ? NaN : q / (k - 1); };
const isMainProj = (v) => {
  if (!(v[11] === -1 && v[15] === 0 && v[0] !== 0)) return false;
  const n = nearOf(v);
  if (!(n > 0.02 && n < 0.09)) return false;
  const asp = v[5] / v[0];
  const win = innerWidth / Math.max(1, innerHeight);
  return Math.abs(asp - win) < 0.1;
};
let pendP = null, pendN = 0;
function feed(name, v) {
  if (!v || v.length !== 16) return;
  if (name === 'projectionMatrix' || (name === undefined && isMainProj(v))) {
    if (isMainProj(v)) { S.p = copy16(v); pendP = S.p; pendN = 3; }
    return;
  }
  if (name === 'viewMatrix') {
    if (isRigid(v) && camSane(camFromV(v))) S.v = copy16(v);
    return;
  }
  if (name === undefined && pendP) {
    if (isRigid(v) && camSane(camFromV(v))) { S.v = copy16(v); pendP = null; }
    else if (--pendN <= 0) pendP = null;
  }
}
function patchProto(proto) {
  if (!proto || proto.__aaEsp) return;
  proto.__aaEsp = true;
  const og = proto.getUniformLocation;
  const om = proto.uniformMatrix4fv;
  if (og) proto.getUniformLocation = function (prog, name) {
    const loc = og.call(this, prog, name);
    if (loc) locName.set(loc, name);
    return loc;
  };
  if (om) proto.uniformMatrix4fv = function (loc, transpose, value) {
    try { feed(locName.get(loc), value); } catch (e) {}
    return om.call(this, loc, transpose, value);
  };
}
try { patchProto(WebGL2RenderingContext.prototype); } catch (e) {}
try { patchProto(WebGLRenderingContext.prototype); } catch (e) {}

/* ---------------- projection ---------------- */
function toScreen(x, y, z) {
  const v = S.v, p = S.p;
  if (!v || !p) return null;
  const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
  const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
  const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
  const vw = v[3] * x + v[7] * y + v[11] * z + v[15];
  const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12] * vw;
  const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13] * vw;
  const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * vw;
  if (cw <= 0.001) return null;
  return { x: (cx / cw * 0.5 + 0.5) * innerWidth, y: (-cy / cw * 0.5 + 0.5) * innerHeight, w: cw };
}

/* ---------------- overlay canvas ---------------- */
function mountOverlay() {
  if (!document.body) return;
  const c = document.createElement('canvas');
  c.id = 'aa-esp-overlay';
  c.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483600;';
  (document.fullscreenElement || document.body).appendChild(c);
  S.overlay = c;
  S.octx = c.getContext('2d');
}
document.addEventListener('fullscreenchange', () => {
  if (S.overlay) (document.fullscreenElement || document.body).appendChild(S.overlay);
});

/* ---------------- touch / mouse UI ---------------- */
const CHIP_CSS = 'pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;' +
  'display:inline-block;padding:5px 9px;margin:2px;border-radius:8px;' +
  'font:600 12px/1 Consolas,Menlo,monospace;letter-spacing:0.5px;' +
  'background:rgba(10,12,14,0.55);border:1px solid rgba(255,255,255,0.28);color:#e8e8e8;';
function mountUI() {
  if (!document.body || S.ui) return;
  const wrap = document.createElement('div');
  wrap.id = 'aa-esp-ui';
  wrap.style.cssText = 'position:fixed;z-index:2147483601;pointer-events:none;' +
    'top:' + (S.uiPos ? S.uiPos.y + 'px' : 'calc(56px + env(safe-area-inset-top,0px))') + ';' +
    'left:' + (S.uiPos ? S.uiPos.x + 'px' : 'calc(8px + env(safe-area-inset-left,0px))') + ';';
  const chip = document.createElement('div');
  chip.textContent = 'ESP';
  chip.style.cssText = CHIP_CSS;
  const subs = document.createElement('div');
  subs.style.cssText = 'pointer-events:none;margin-left:2px;';
  for (const [k, label] of [['mates', 'M'], ['tracers', 'T'], ['self', 'S']]) {
    const s = document.createElement('span');
    s.dataset.k = k;
    s.textContent = label;
    s.style.cssText = CHIP_CSS + 'padding:4px 8px;font-size:11px;';
    subs.appendChild(s);
  }
  wrap.append(chip, subs);
  document.body.appendChild(wrap);
  S.ui = wrap; S.chip = chip; S.subs = subs;
  paintUI();

  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  chip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    const r = wrap.getBoundingClientRect();
    ox = r.left; oy = r.top;
    chip.setPointerCapture(e.pointerId);
  }, true);
  chip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < 7) return;
    moved = true;
    wrap.style.left = Math.max(0, Math.min(innerWidth - 40, ox + dx)) + 'px';
    wrap.style.top = Math.max(0, Math.min(innerHeight - 30, oy + dy)) + 'px';
  }, true);
  chip.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      const r = wrap.getBoundingClientRect();
      S.uiPos = { x: Math.round(r.left), y: Math.round(r.top) };
      persist();
    } else {
      S.cfg.on = !S.cfg.on;
      toast('ESP ' + (S.cfg.on ? 'ON' : 'OFF'));
      persist();
      paintUI();
    }
  }, true);
  chip.addEventListener('pointercancel', () => { dragging = false; }, true);
  subs.addEventListener('pointerdown', (e) => {
    const k = e.target && e.target.dataset && e.target.dataset.k;
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    S.cfg[k] = !S.cfg[k];
    toast(k + ': ' + (S.cfg[k] ? 'ON' : 'OFF'));
    persist();
    paintUI();
  }, true);
}
function paintUI() {
  if (!S.chip) return;
  S.chip.textContent = 'ESP' + (S.cfg.on && S.enemyCount ? ' ' + S.enemyCount : '');
  S.chip.style.borderColor = S.cfg.on ? 'rgba(255,211,77,0.9)' : 'rgba(255,255,255,0.28)';
  S.chip.style.color = S.cfg.on ? '#ffd34d' : '#e8e8e8';
  for (const s of S.subs.children) {
    const on = !!S.cfg[s.dataset.k];
    s.style.borderColor = on ? 'rgba(255,211,77,0.9)' : 'rgba(255,255,255,0.28)';
    s.style.color = on ? '#ffd34d' : '#9a9a9a';
    s.style.opacity = S.cfg.on ? '1' : '0.4';
  }
}
function toast(msg) { S.toastAt = performance.now(); S.toastMsg = msg; }

/* ---------------- draw ---------------- */
const hpColor = (h) => (h > 60 ? '#39d98a' : h > 30 ? '#f5c542' : '#ff4757');
function draw() {
  const ctx = S.octx, c = S.overlay;
  if (!ctx || !c) return;
  const W = innerWidth, H = innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (c.width !== Math.floor(W * dpr) || c.height !== Math.floor(H * dpr)) {
    c.width = Math.floor(W * dpr);
    c.height = Math.floor(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'left';

  if (S.toastAt && performance.now() - S.toastAt < 1500) {
    ctx.font = '600 12px Consolas,Menlo,monospace';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(S.toastMsg, 14, H - 16);
    ctx.fillText(S.toastMsg, 14, H - 16);
  }

  if (!S.cfg.on || !S.state || !S.p || !S.v) {
    S.enemyCount = 0;
    return;
  }
  const st = S.state;
  const me = st.players.find((p) => p.id === S.myId);
  const rows = [];
  for (const p of st.players) {
    if (!p || !p.position || typeof p.feet !== 'number' || typeof p.position.x !== 'number') continue;
    if (p.health <= 0 || p.deployed === false) continue;
    const isSelf = S.myId != null && p.id === S.myId;
    const isMate = me ? p.team === me.team : false;
    if (isSelf && !S.cfg.self) continue;
    if (!isSelf && isMate && !S.cfg.mates) continue;
    const h = Math.min(Math.max(p.height || 1.8, 0.5), 2.4);
    const px = p.position.x, pz = p.position.z, fy = p.feet, hw = 0.38;
    const pts = [];
    for (const dx of [-hw, hw]) for (const dy of [0, h]) for (const dz of [-hw, hw]) {
      const s = toScreen(px + dx, fy + dy, pz + dz);
      if (s) pts.push(s);
    }
    if (pts.length < 6) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const s of pts) { if (s.x < x0) x0 = s.x; if (s.y < y0) y0 = s.y; if (s.x > x1) x1 = s.x; if (s.y > y1) y1 = s.y; }
    if (x1 < -100 || y1 < -100 || x0 > W + 100 || y0 > H + 100) continue;
    let dist = 0;
    if (me && me.position && typeof me.feet === 'number') {
      dist = Math.hypot(px - me.position.x, fy - me.feet, pz - me.position.z);
    }
    rows.push({ p, x0, y0, x1, y1, dist, isSelf, isMate });
  }
  rows.sort((a, b) => b.dist - a.dist);
  S.enemyCount = rows.filter((r) => !r.isMate && !r.isSelf).length;
  paintUI();

  for (const r of rows) {
    const col = r.isSelf ? '#ffd34d' : r.isMate ? '#2ed3ff' : '#ff4757';
    const txt = r.isSelf ? '#ffe9a8' : r.isMate ? '#bfeaff' : '#ffb3ba';
    ctx.lineWidth = r.isSelf ? 1 : 2;
    ctx.strokeStyle = col;
    ctx.globalAlpha = r.isSelf || r.isMate ? 0.65 : 0.95;
    ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.globalAlpha = 1;

    if (!r.isSelf && S.cfg.tracers) {
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(W / 2, H);
      ctx.lineTo((r.x0 + r.x1) / 2, r.y1);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (typeof r.p.health === 'number') {
      const frac = Math.min(Math.max(r.p.health, 0), 100) / 100;
      const bx = r.x0 - 7, by = r.y0, bh = Math.max(r.y1 - r.y0, 8);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx - 1, by - 1, 5, bh + 2);
      ctx.fillStyle = hpColor(r.p.health);
      ctx.fillRect(bx, by + bh * (1 - frac), 3, bh * frac);
      ctx.font = '600 11px Consolas,Menlo,monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = txt;
      ctx.fillText(String(Math.round(r.p.health)), bx - 4, by + 10);
      ctx.textAlign = 'left';
    }

    const name = S.names.get(r.p.id) || r.p.name || String(r.p.id).slice(0, 6);
    const line1 = r.isSelf ? name + ' (me)' : name;
    const line2 = (r.p.weapon && r.p.weapon !== 'rifle' ? String(r.p.weapon).toUpperCase() + ' · ' : '') + r.dist.toFixed(1) + 'm';
    ctx.font = '600 13px Consolas,Menlo,monospace';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.fillStyle = txt;
    ctx.strokeText(line1, r.x0, r.y0 - 18);
    ctx.fillText(line1, r.x0, r.y0 - 18);
    ctx.font = '600 11px Consolas,Menlo,monospace';
    ctx.strokeText(line2, r.x0, r.y0 - 6);
    ctx.fillText(line2, r.x0, r.y0 - 6);
  }

  if (!S.p && performance.now() - S.lastHint > 8000) {
    S.lastHint = performance.now();
    toast('ESP 준비 중 — 조준(ADS) 한 번 눌러줘');
  }
}

function loop() {
  requestAnimationFrame(loop);
  if (!S.overlay || !S.overlay.isConnected) mountOverlay();
  if (!S.ui || !S.ui.isConnected) mountUI();
  try { draw(); } catch (e) {}
}

/* ---------------- keys ---------------- */
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const set = (k, v) => { S.cfg[k] = v; toast('ESP ' + k + ': ' + (v ? 'ON' : 'OFF')); persist(); paintUI(); };
  if (e.code === 'F8') set('on', !S.cfg.on);
  else if (e.code === 'F7') set('mates', !S.cfg.mates);
  else if (e.code === 'F6') set('tracers', !S.cfg.tracers);
  else if (e.code === 'F9') set('self', !S.cfg.self);
}, true);

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mountUI(); mountOverlay(); });
else { mountUI(); mountOverlay(); }
requestAnimationFrame(loop);
})();
