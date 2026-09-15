// ==UserScript==
// @name         Astra Attack ESP
// @namespace    anon
// @version      2.0
// @description  Enemy wallhack overlay for astra-attack.pages.dev — render-locked boxes, whole-map sound-track boxes (gunshot triangulation, moving estimates), hit-relay pins (shooters who hit you located at any distance), screen-edge gunshot arrows, sound radar, last-seen ghosts, grenade markers. PC + mobile.
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
// Chips: M teammates | T tracers | S self | R sound radar | G last-seen ghosts | K sound tracks
// Keys (PC): F8 master | F7 teammates | F6 tracers | F9 self | F10 radar | K tracks
//
// Radar: the server broadcasts every gunshot/explosion in the match as a
// "combat-sound" event with distance bucket (nearest 10m, 5-80m) and stereo
// pan (~sin of the bearing relative to your view, quantized to 0.5 steps).
// The radar draws those readings as wedges and runs a small particle filter
// per burst to triangulate the shooter's likely position on the map — intel
// you cannot get from replicated players (~20m cap). Blips are estimates:
// a burst of 4-6 shots converges to a few meters; a single shot stays fuzzy.
(() => {
'use strict';
if (globalThis.__AA_ESP__ && globalThis.__AA_ESP__.loaded) return;

const S = {
  loaded: true,
  state: null,
  myId: null,
  names: new Map(),
  p: null, v: null,
  cfg: { on: true, self: false, mates: false, tracers: true, radar: true, ghosts: true, tracks: true },
  overlay: null, octx: null,
  ui: null, chip: null, subs: null, uiPos: null,
  radar: null, rctx: null,
  sfx: [], sfxProc: 0,
  clusters: [],
  tracks: new Map(), trackSeq: 0, nades: [],
  ghosts: [],
  relays: [],
  lastAck: 0, hurtAt: 0,
  toastAt: 0, toastMsg: '', lastHint: 0, enemyCount: 0,
};
globalThis.__AA_ESP__ = S;

/* ---------------- three.js scene hook ----------------
   The game bundles its own three.js (rev 180) and tags every replicated
   player root as "player-<uuid>" in the scene graph. Hooking the three.js
   devtools registration at document-start hands us every Scene instance;
   each frame we read the entity root's world position — the exact spot the
   game is rendering/interpolating the body at, which is smoother and more
   accurate than the raw state snapshots (and matches the visible character
   pixel-for-pixel instead of snapping ahead of the interpolation). */
S.three = { scenes: [], roots: new Map(), lastScan: 0, ok: false };
try {
  if (!globalThis.__THREE_DEVTOOLS__) globalThis.__THREE_DEVTOOLS__ = new EventTarget();
  globalThis.__THREE_DEVTOOLS__.addEventListener('observe', (e) => {
    const d = e && e.detail;
    try {
      if (d && d.isScene && !S.three.scenes.includes(d)) S.three.scenes.push(d);
    } catch (err) {}
  });
} catch (e) {}

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
        trackFromState(out);
        if (Array.isArray(out.playerExits)) {
          const now = performance.now();
          for (const x of out.playerExits) {
            if (x && x.position && typeof x.position.x === 'number') {
              S.ghosts.push({ id: x.id, x: x.position.x, z: x.position.z, feet: typeof x.feet === 'number' ? x.feet : 0, t: now });
            }
          }
          if (S.ghosts.length > 24) S.ghosts.splice(0, S.ghosts.length - 24);
        }
      } else if (out.type === 'shot' && Array.isArray(out.origin) && typeof out.origin[0] === 'number') {
        /* hit-relay: the server relays the shot to the victim at any distance,
           with the shooter's exact origin. anyone who hits us from outside the
           replication radius gets pinned on the overlay instead of hinted. */
        const meNow = S.state && Array.isArray(S.state.players) ? S.state.players.find((p) => p.id === S.myId) : null;
        if (meNow && meNow.position) {
          const rd = Math.hypot(out.origin[0] - meNow.position.x, out.origin[2] - meNow.position.z);
          if (rd > 24) {
            const nowR = performance.now();
            const last = S.relays[S.relays.length - 1];
            const dmg = typeof out.damage === 'number' ? out.damage : 0;
            if (last && last.id === out.playerId && nowR - last.t < 2600) {
              last.t = nowR; last.dmg += dmg; last.n++;
            } else {
              S.relays.push({ id: out.playerId, x: out.origin[0], y: out.origin[1], z: out.origin[2], t: nowR, d: rd, dmg, n: 1, weapon: out.weapon || '', killed: !!out.killed });
              if (S.relays.length > 8) S.relays.shift();
            }
          }
        }
      } else if (out.type === 'combat-sound' && typeof out.distance === 'number' && typeof out.pan === 'number') {
        const now = performance.now();
        if (!(S.lastAck > 0 && now - S.lastAck < 260 && out.distance <= 10)) {
          S.sfx.push({ t: now, kind: out.kind === 'explosion' ? 'explosion' : 'shot', weapon: out.weapon || '', distance: out.distance, pan: Math.max(-1, Math.min(1, out.pan)), hurt: !!out.hurt });
          if (S.sfx.length > 90) { const drop = S.sfx.length - 90; S.sfx.splice(0, drop); S.sfxProc = Math.max(0, S.sfxProc - drop); }
          if (out.hurt) S.hurtAt = now;
        }
      } else if (out.type === 'combat-ack') {
        S.lastAck = performance.now();
      } else if (out.type === 'explosion' && Array.isArray(out.position) && typeof out.position[0] === 'number') {
        /* exact server explosion notice: position is the true detonation point
           (only sent when the blast is near you, but pixel-accurate). */
        const nowN = performance.now();
        S.nades.push({ x: out.position[0], y: out.position[1], z: out.position[2], t: nowN, by: out.playerId || null, hits: Array.isArray(out.hits) ? out.hits.length : 0 });
        if (S.nades.length > 6) S.nades.shift();
        exactCluster(out.position[0], out.position[2], nowN);
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

/* ---------------- sound radar math ---------------- */
const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const bucketOf = (d) => (d < 7.5 ? 5 : Math.min(80, Math.round(d / 10) * 10));
const panOf = (sinrel) => Math.max(-1, Math.min(1, Math.round(sinrel * 2) / 2));
function mePos(me) {
  if (!me || !me.position || typeof me.position.x !== 'number' || typeof me.yaw !== 'number') return null;
  return { x: me.position.x, z: me.position.z, yaw: me.yaw };
}
function readingAt(m, px, pz) {
  const dx = px - m.x, dz = pz - m.z;
  const d = Math.hypot(dx, dz);
  const sin = (dx * Math.cos(m.yaw) - dz * Math.sin(m.yaw)) / Math.max(0.001, d);
  return { d, b: bucketOf(d), p: panOf(sin) };
}
function bandSectors(pan) {
  const ap = Math.abs(pan), side = pan < 0 ? -1 : 1;
  let bands;
  if (ap === 0) bands = [[-17, 17], [163, 197]];
  else if (ap === 0.5) bands = [[20, 46], [134, 160]];
  else bands = [[52, 128]];
  if (ap !== 0 && side < 0) bands = bands.map((b) => [-b[1], -b[0]]);
  return bands;
}
function sampleParticles(m, ev, n) {
  const bands = bandSectors(ev.pan);
  const out = [];
  for (let i = 0; i < n; i++) {
    const band = bands[(Math.random() * bands.length) | 0];
    const rel = (band[0] + Math.random() * (band[1] - band[0])) * Math.PI / 180;
    let d = ev.distance <= 5 ? 0.5 + Math.random() * 7 : ev.distance + (Math.random() * 10 - 5);
    const bearing = m.yaw + rel;
    const px = Math.min(30, Math.max(-30, m.x + Math.sin(bearing) * d));
    const pz = Math.min(55, Math.max(-52, m.z + Math.cos(bearing) * d));
    out.push({ x: px, z: pz, w: 1 });
  }
  return out;
}
function clusterCentroid(cl, m) {
  let sx = 0, sz = 0;
  for (const p of cl.ps) { sx += p.x; sz += p.z; }
  const n = Math.max(1, cl.ps.length);
  return { x: sx / n, z: sz / n };
}
function clusterSpread(cl, c) {
  let s = 0;
  for (const p of cl.ps) s += (p.x - c.x) * (p.x - c.x) + (p.z - c.z) * (p.z - c.z);
  return Math.sqrt(s / Math.max(1, cl.ps.length));
}
function particleWeight(p, m, ev) {
  const r = readingAt(m, p.x, p.z);
  const db = Math.abs(r.b - ev.distance), dp = Math.abs(r.p - ev.pan);
  if (db > 10 || dp > 0.5) return 0;
  const w = (r.b === ev.distance ? 1 : 0.35) * (r.p === ev.pan ? 1 : 0.25);
  return w <= 0.2 ? 0 : w;
}
function clusterMatchScore(cl, m, ev) {
  let best = 0;
  for (const p of cl.ps) {
    const w = particleWeight(p, m, ev);
    if (w > best) best = w;
  }
  return best;
}
function splitBlobs(cl) {
  const cells = new Map();
  for (const p of cl.ps) {
    const key = Math.round(p.x / 9) + ':' + Math.round(p.z / 9);
    const cell = cells.get(key) || { n: 0, sx: 0, sz: 0 };
    cell.n++; cell.sx += p.x; cell.sz += p.z;
    cells.set(key, cell);
  }
  const arr = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 2).filter((c) => c.n >= cl.ps.length * 0.2);
  return arr.map((c) => ({ x: c.sx / c.n, z: c.sz / c.n, n: c.n }));
}
function updateCluster(cl, m, ev) {
  let kept = [];
  for (const p of cl.ps) {
    const w = particleWeight(p, m, ev);
    if (!w) continue;
    kept.push({ x: p.x, z: p.z, w });
  }
  if (kept.length < 4) { cl.ps = sampleParticles(m, ev, 60); cl.t = performance.now(); return; }
  const tot = kept.reduce((a, b) => a + b.w, 0);
  const ps = [];
  for (let i = 0; i < 60; i++) {
    let r = Math.random() * tot, pick = kept[0];
    for (const p of kept) { r -= p.w; if (r <= 0) { pick = p; break; } }
    ps.push({ x: Math.min(30, Math.max(-30, pick.x + (Math.random() - 0.5) * 1.2)), z: Math.min(55, Math.max(-52, pick.z + (Math.random() - 0.5) * 1.2)) });
  }
  cl.ps = ps;
  cl.t = performance.now();
}
/* ---------------- whole-map tracks ----------------
   The server only replicates enemies inside the ~21m interest radius, so
   anything farther is rendered as a TRACK: a triangulated sound contact or a
   last-known real enemy that keeps moving on its measured velocity. Tracks
   converge to a few meters after a burst of shots and drift while silent. */
function exactCluster(x, z, t) {
  const ps = [];
  for (let i = 0; i < 60; i++) ps.push({ x: x + (Math.random() - 0.5) * 1.6, z: z + (Math.random() - 0.5) * 1.6 });
  S.clusters.push({ kind: 'explosion', ps, t, exact: true });
  if (S.clusters.length > 6) S.clusters.shift();
}
function trackFromState(st) {
  const now = performance.now();
  const seen = new Set();
  for (const p of st.players) {
    if (!p || typeof p.id !== 'string' || !p.position || typeof p.position.x !== 'number') continue;
    seen.add(p.id);
    let tr = S.tracks.get(p.id);
    if (!tr) {
      tr = { key: p.id, id: p.id, syn: false, name: p.name || S.names.get(p.id) || '', team: p.team || null,
        x: p.position.x, z: p.position.z, feet: typeof p.feet === 'number' ? p.feet : 0,
        h: Math.min(Math.max(p.height || 1.8, 0.5), 2.4), hp: p.health, weapon: p.weapon || '',
        vx: 0, vz: 0, err: 0, real: true, tFix: now, tReal: now, tPrev: 0 };
      S.tracks.set(p.id, tr);
    } else {
      const dt = (now - tr.tReal) / 1000;
      if (dt > 0.01 && dt < 0.6) {
        const vx = (p.position.x - tr.x) / dt, vz = (p.position.z - tr.z) / dt;
        if (Math.hypot(vx, vz) < 12) {
          const a = Math.min(1, dt * 5);
          tr.vx += (vx - tr.vx) * a;
          tr.vz += (vz - tr.vz) * a;
        }
      }
      tr.x = p.position.x; tr.z = p.position.z;
      tr.real = true; tr.tFix = now; tr.tReal = now; tr.err = 0;
    }
    tr.name = p.name || tr.name; tr.team = p.team || tr.team; tr.hp = p.health; tr.weapon = p.weapon || '';
    tr.feet = typeof p.feet === 'number' ? p.feet : tr.feet;
    tr.h = Math.min(Math.max(p.height || 1.8, 0.5), 2.4);
    if (!tr.syn) for (const o of S.tracks.values()) {
      if (o.syn && Math.hypot(o.x - tr.x, o.z - tr.z) < 8) S.tracks.delete(o.key);
    }
  }
  for (const tr of S.tracks.values()) {
    if (tr.id && !tr.syn && !seen.has(tr.id)) tr.real = false;
  }
}
function trackFromCluster(cl) {
  const cen = clusterCentroid(cl, null);
  const spread = clusterSpread(cl, cen);
  const my = S.state && S.state.players ? S.state.players.find((p) => p.id === S.myId) : null;
  if (my && my.position && Math.hypot(cen.x - my.position.x, cen.z - my.position.z) < 5.5) return null;
  const now = performance.now();
  let best = null, bd = Math.max(12, spread * 2 + 6);
  for (const tr of S.tracks.values()) {
    if (tr.real) continue;
    const d = Math.hypot(tr.x - cen.x, tr.z - cen.z);
    if (d < bd) { bd = d; best = tr; }
  }
  if (!best) {
    const key = 'syn#' + (++S.trackSeq);
    best = { key, id: null, syn: true, name: '', team: null, x: cen.x, z: cen.z, feet: 0, h: 1.8,
      hp: null, weapon: '', vx: 0, vz: 0, err: spread * 1.5 + 3, real: false, tFix: now, tReal: 0, tPrev: 0 };
    S.tracks.set(key, best);
  } else {
    const dt = (now - (best.tPrev || best.tFix)) / 1000;
    if (dt > 0.35 && dt < 6) {
      const vx = (cen.x - best.x) / dt, vz = (cen.z - best.z) / dt;
      if (Math.hypot(vx, vz) < 12) { best.vx = best.vx * 0.5 + vx * 0.5; best.vz = best.vz * 0.5 + vz * 0.5; }
    }
    best.x = best.x * 0.35 + cen.x * 0.65;
    best.z = best.z * 0.35 + cen.z * 0.65;
    best.err = spread * 1.5 + 2;
    best.tPrev = best.tFix;
    best.tFix = now;
  }
  return best;
}
function processSfx(me) {
  const m = mePos(me);
  if (!m) return;
  const now = performance.now();
  while (S.sfxProc < S.sfx.length) {
    const ev = S.sfx[S.sfxProc++];
    if (now - ev.t > 6000) continue;
    let bestCl = null, bestScore = 0;
    for (const cl of S.clusters) {
      if (cl.kind !== ev.kind) continue;
      const sc = clusterMatchScore(cl, m, ev);
      if (sc > bestScore) { bestScore = sc; bestCl = cl; }
    }
    if (!bestCl) {
      S.clusters.push({ kind: ev.kind, ps: sampleParticles(m, ev, 60), t: now });
      if (S.clusters.length > 6) S.clusters.shift();
    } else {
      updateCluster(bestCl, m, ev);
    }
  }
  S.clusters = S.clusters.filter((c) => now - c.t < 7000);
  if (S.cfg.tracks) for (const cl of S.clusters) trackFromCluster(cl);
  for (const [k, tr] of S.tracks) { if (!tr.real && now - tr.tFix > 14000) S.tracks.delete(k); }
  S.nades = S.nades.filter((n) => now - n.t < 9000);
  S.ghosts = S.ghosts.filter((g) => now - g.t < 15000);
  S.relays = S.relays.filter((r) => now - r.t < 15000);
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
  for (const [k, label] of [['mates', 'M'], ['tracers', 'T'], ['self', 'S'], ['radar', 'R'], ['ghosts', 'G'], ['tracks', 'K']]) {
    const sp = document.createElement('span');
    sp.dataset.k = k;
    sp.textContent = label;
    sp.style.cssText = CHIP_CSS + 'padding:4px 8px;font-size:11px;';
    subs.appendChild(sp);
  }
  const radar = document.createElement('canvas');
  radar.id = 'aa-esp-radar';
  radar.width = 340;
  radar.height = 340;
  radar.style.cssText = 'pointer-events:none;display:block;width:170px;height:170px;margin-top:2px;opacity:0.94;';
  wrap.append(chip, subs, radar);
  document.body.appendChild(wrap);
  S.ui = wrap; S.chip = chip; S.subs = subs; S.radar = radar; S.rctx = radar.getContext('2d');
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

/* ---------------- radar draw ---------------- */
function drawRadar(me) {
  const c = S.radar, ctx = S.rctx;
  if (!ctx || !c) return;
  ctx.clearRect(0, 0, c.width, c.height);
  S.debugBlobs = [];
  if (!S.cfg.on || !S.cfg.radar) return;
  const m = mePos(me);
  if (!m) return;
  const now = performance.now();
  const C = 170, R = 156;
  const k = R / 85;
  const LP = (px, pz) => {
    const dx = px - m.x, dz = pz - m.z;
    const lx = dx * Math.cos(m.yaw) - dz * Math.sin(m.yaw);
    const lz = dx * Math.sin(m.yaw) + dz * Math.cos(m.yaw);
    return { x: C + lx * k, y: C - lz * k };
  };
  ctx.save();
  ctx.beginPath();
  ctx.arc(C, C, R + 6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(8,10,12,0.42)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  for (const ring of [20, 40, 60, 80]) {
    ctx.moveTo(C + ring * k, C);
    ctx.arc(C, C, ring * k, 0, Math.PI * 2);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(C, C - R);
  ctx.lineTo(C, C + R);
  ctx.moveTo(C - R, C);
  ctx.lineTo(C + R, C);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(C, C - R + 4);
  ctx.lineTo(C - 6, C - R + 16);
  ctx.lineTo(C + 6, C - R + 16);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,211,77,0.8)';
  ctx.fill();
  ctx.font = '600 15px Consolas,Menlo,monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'center';
  ctx.fillText('80', C, C + 80 * k + 14);
  ctx.textAlign = 'left';

  for (const ev of S.sfx) {
    const age = now - ev.t;
    if (age > 2200) continue;
    const a = 1 - age / 2200;
    const col = ev.kind === 'explosion' ? [255, 160, 60] : [255, 71, 87];
    const r0 = ev.distance <= 5 ? 0.5 * k : Math.max(0, (ev.distance - 5)) * k;
    const r1 = (ev.distance + 5) * k;
    for (const band of bandSectors(ev.pan)) {
      const a0 = band[0] * Math.PI / 180 - Math.PI / 2;
      const a1 = band[1] * Math.PI / 180 - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(C, C, r1, Math.min(a0, a1), Math.max(a0, a1));
      ctx.arc(C, C, r0, Math.max(a0, a1), Math.min(a0, a1), true);
      ctx.closePath();
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.10 + 0.16 * a})`;
      ctx.fill();
    }
  }
  for (const cl of S.clusters) {
    const age = now - cl.t;
    const a = Math.max(0.25, 1 - age / 7000);
    const cen = clusterCentroid(cl, m);
    const spread = clusterSpread(cl, cen);
    const isEx = cl.kind === 'explosion';
    for (const blob of splitBlobs(cl)) {
      const d = Math.hypot(blob.x - m.x, blob.z - m.z);
      const pt = LP(blob.x, blob.z);
      const rad = Math.max(4, (spread * 1.6 + 2) * k);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = isEx ? `rgba(255,160,60,${0.22 * a + 0.08})` : `rgba(255,71,87,${0.22 * a + 0.08})`;
      ctx.fill();
      ctx.strokeStyle = isEx ? `rgba(255,190,90,${a})` : `rgba(255,110,125,${a})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = '600 13px Consolas,Menlo,monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(255,235,235,${a})`;
      ctx.fillText(Math.round(d) + 'm', pt.x, pt.y - rad - 3);
      ctx.textAlign = 'left';
      S.debugBlobs.push({ kind: cl.kind, x: +blob.x.toFixed(2), z: +blob.z.toFixed(2), d: +d.toFixed(1), spread: +spread.toFixed(1), n: blob.n });
    }
  }
  if (S.hurtAt && now - S.hurtAt < 420) {
    ctx.beginPath();
    ctx.arc(C, C, R + 3, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,60,60,${1 - (now - S.hurtAt) / 420})`;
    ctx.lineWidth = 5;
    ctx.stroke();
  }
  /* whole-map sound tracks: triangulated contacts + last-known positions */
  if (S.cfg.tracks) for (const tr of S.tracks.values()) {
    const pt = LP(tr.x, tr.z);
    ctx.strokeStyle = 'rgba(255,184,77,0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pt.x - 4, pt.y - 4, 8, 8);
  }
  /* real-coordinate pins on the radar: hit-relay shooters + last-seen ghosts */
  for (const r of S.relays) {
    const pt = LP(r.x, r.z);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,169,77,0.9)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  for (const g of S.ghosts) {
    const pt = LP(g.x, g.z);
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y - 4.5);
    ctx.lineTo(pt.x + 4.5, pt.y);
    ctx.lineTo(pt.x, pt.y + 4.5);
    ctx.lineTo(pt.x - 4.5, pt.y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(200,162,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------------- render-locked positions (scene roots) ---------------- */
function scanRoots() {
  const T = S.three;
  if (!T.scenes.length) return;
  const found = new Map();
  for (const sc of T.scenes) {
    try {
      sc.traverse((o) => {
        if (typeof o.name === 'string' && o.name.length > 8 && o.name.startsWith('player-')) {
          const id = o.name.slice(7);
          let arr = found.get(id);
          if (!arr) { arr = []; found.set(id, arr); }
          arr.push(o);
        }
      });
    } catch (e) {}
  }
  T.roots = found;
  T.ok = found.size > 0;
  T.lastScan = performance.now();
}
function scenePos(p, sp) {
  const T = S.three;
  const arr = T.roots.get(p.id);
  if (!arr || !arr.length) return null;
  let best = null, bd = 4;
  for (const o of arr) {
    let wp;
    try {
      if (!o.parent) continue;
      wp = o.getWorldPosition(o.position.clone());
    } catch (e) { continue; }
    if (!isFinite(wp.x) || !isFinite(wp.z)) continue;
    const d = Math.hypot(wp.x - sp.x, wp.z - sp.z);
    if (d < bd) { bd = d; best = wp; }
  }
  return best;
}

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

  if (!S.cfg.on || !S.state) {
    S.enemyCount = 0;
    drawRadar(null);
    return;
  }
  const st = S.state;
  const me = st.players.find((p) => p.id === S.myId) || null;
  processSfx(me);
  drawRadar(me);
  if (!me || !S.p || !S.v) {
    S.enemyCount = 0;
    if (!S.p && performance.now() - S.lastHint > 8000) {
      S.lastHint = performance.now();
      toast('ESP 준비 중 — 조준(ADS) 한 번 눌러줘');
    }
    return;
  }
  const rows = [];
  if (S.three && S.three.scenes.length && performance.now() - S.three.lastScan > 700) scanRoots();
  for (const p of st.players) {
    if (!p || !p.position || typeof p.feet !== 'number' || typeof p.position.x !== 'number') continue;
    if (p.health <= 0 || p.deployed === false) continue;
    const isSelf = S.myId != null && p.id === S.myId;
    const isMate = me ? p.team === me.team : false;
    if (isSelf && !S.cfg.self) continue;
    if (!isSelf && isMate && !S.cfg.mates) continue;
    const h = Math.min(Math.max(p.height || 1.8, 0.5), 2.4);
    const rp = S.three && S.three.roots.size ? scenePos(p, p.position) : null;
    const px = rp ? rp.x : p.position.x, pz = rp ? rp.z : p.position.z, fy = rp ? rp.y : p.feet, hw = 0.38;
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

  /* whole-map sound tracks: estimated moving boxes for contacts outside the
     replication radius (dashed amber, uncertainty shown). */
  if (S.cfg.tracks) {
    const nowT = performance.now();
    ctx.setLineDash([5, 4]);
    for (const tr of S.tracks.values()) {
      if (tr.real) continue;
      const age = (nowT - tr.tFix) / 1000;
      if (age > 14) continue;
      const ext = Math.min(age, 9) * 0.9;
      const tx = tr.x + tr.vx * ext, tz = tr.z + tr.vz * ext;
      const a = Math.max(0.15, 1 - age / 14);
      const fy = tr.feet || 0;
      const pts = [];
      for (const dx of [-0.42, 0.42]) for (const dy of [0, tr.h || 1.8]) for (const dz of [-0.42, 0.42]) {
        const s = toScreen(tx + dx, fy + dy, tz + dz);
        if (s) pts.push(s);
      }
      if (pts.length < 6) continue;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const s of pts) { if (s.x < x0) x0 = s.x; if (s.y < y0) y0 = s.y; if (s.x > x1) x1 = s.x; if (s.y > y1) y1 = s.y; }
      if (x1 < -100 || y1 < -100 || x0 > W + 100 || y0 > H + 100) continue;
      ctx.globalAlpha = a;
      ctx.strokeStyle = '#ffb84d';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      const nm = tr.id ? (S.names.get(tr.id) || String(tr.id).slice(0, 6)) : 'SND';
      const dist = me && me.position ? Math.hypot(tx - me.position.x, tz - me.position.z) : 0;
      const line1 = nm;
      const line2 = '~' + dist.toFixed(0) + 'm ±' + Math.round(tr.err + ext * 3);
      ctx.font = '600 13px Consolas,Menlo,monospace';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.fillStyle = '#ffd8a8';
      ctx.strokeText(line1, x0, y0 - 18);
      ctx.fillText(line1, x0, y0 - 18);
      ctx.font = '600 11px Consolas,Menlo,monospace';
      ctx.strokeText(line2, x0, y0 - 6);
      ctx.fillText(line2, x0, y0 - 6);
      ctx.globalAlpha = 1;
    }
    ctx.setLineDash([]);
  }

  /* grenade markers: exact detonation positions from the server's explosion notice */
  for (const n of S.nades) {
    const age = (performance.now() - n.t) / 1000;
    if (age > 8) continue;
    const sPos = toScreen(n.x, (n.y || 0) + 1.1, n.z);
    if (!sPos) continue;
    const a = Math.max(0.2, 1 - age / 8);
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#ffa94d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sPos.x, sPos.y - 9);
    ctx.lineTo(sPos.x + 9, sPos.y);
    ctx.lineTo(sPos.x, sPos.y + 9);
    ctx.lineTo(sPos.x - 9, sPos.y);
    ctx.closePath();
    ctx.stroke();
    const who = n.by ? (S.names.get(n.by) || String(n.by).slice(0, 6)) : '';
    ctx.font = '600 11px Consolas,Menlo,monospace';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.fillStyle = '#ffd8a8';
    const txt = 'NADE' + (who ? ' ' + who : '') + (n.hits ? ' (' + n.hits + ')' : '');
    ctx.strokeText(txt, sPos.x + 12, sPos.y + 4);
    ctx.fillText(txt, sPos.x + 12, sPos.y + 4);
    ctx.globalAlpha = 1;
  }

  if (S.cfg.ghosts) {
    const now = performance.now();
    for (const g of S.ghosts) {
      const age = now - g.t;
      if (age > 15000) continue;
      const team = (st.roster || st.players).find((x) => x.id === g.id);
      const isMate = team && me && team.team === me.team;
      if (isMate && !S.cfg.mates) continue;
      const sPos = toScreen(g.x, g.feet + 0.9, g.z);
      if (!sPos) continue;
      const a = 0.75 * (1 - age / 15000);
      ctx.globalAlpha = a;
      ctx.strokeStyle = isMate ? '#2ed3ff' : '#c8a2ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sPos.x, sPos.y - 10);
      ctx.lineTo(sPos.x + 10, sPos.y);
      ctx.lineTo(sPos.x, sPos.y + 10);
      ctx.lineTo(sPos.x - 10, sPos.y);
      ctx.closePath();
      ctx.stroke();
      ctx.font = '600 11px Consolas,Menlo,monospace';
      const nm = S.names.get(g.id) || String(g.id).slice(0, 6);
      ctx.fillStyle = isMate ? '#bfeaff' : '#e6d4ff';
      ctx.fillText(nm + ' last', sPos.x + 13, sPos.y + 4);
      ctx.globalAlpha = 1;
    }
  }

  /* hit-relay pins: server-sent shooter origins for hits on us from outside replication */
  if (S.relays.length) {
    const now = performance.now();
    for (const r of S.relays) {
      const age = now - r.t;
      const a = Math.max(0.35, 1 - age / 15000);
      const hh = 1.8;
      const bot = toScreen(r.x, r.y, r.z);
      const top = toScreen(r.x, r.y + hh, r.z);
      if (!bot || !top) continue;
      const bw = Math.max(10, Math.abs(top.y - bot.y) * 0.35);
      ctx.globalAlpha = a;
      ctx.strokeStyle = '#ffa94d';
      ctx.lineWidth = 2;
      ctx.strokeRect(top.x - bw / 2, top.y, bw, bot.y - top.y);
      ctx.globalAlpha = a * 0.5;
      ctx.beginPath();
      ctx.moveTo(top.x, bot.y);
      ctx.lineTo(W / 2, H);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const nm = S.names.get(r.id) || String(r.id).slice(0, 6);
      const line1 = 'HIT ' + nm;
      const line2 = r.weapon.toUpperCase() + ' · ' + r.d.toFixed(0) + 'm' + (r.dmg ? ' · -' + r.dmg : '') + (r.n > 1 ? ' ×' + r.n : '');
      ctx.font = '600 13px Consolas,Menlo,monospace';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.fillStyle = '#ffd8a8';
      ctx.strokeText(line1, top.x - bw / 2, top.y - 18);
      ctx.fillText(line1, top.x - bw / 2, top.y - 18);
      ctx.font = '600 11px Consolas,Menlo,monospace';
      ctx.strokeText(line2, top.x - bw / 2, top.y - 6);
      ctx.fillText(line2, top.x - bw / 2, top.y - 6);
      if (r.killed) {
        ctx.fillStyle = '#ff6b6b';
        ctx.font = '700 13px Consolas,Menlo,monospace';
        ctx.fillText('KILLED YOU', top.x - bw / 2, top.y - 31);
      }
    }
  }

  /* screen-edge gunshot direction arrows (map-wide audio contacts, <=80m) */
  if (S.cfg.radar && S.sfx.length) {
    const nowA = performance.now();
    const cx = W / 2, cy = H / 2;
    for (const ev of S.sfx) {
      const age = nowA - ev.t;
      if (age > 1500) continue;
      const a = 1 - age / 1500;
      const az = ev.pan * Math.PI / 2;
      let x = cx + Math.sin(az) * W * 0.44;
      let y = cy - Math.cos(az) * H * 0.42;
      x = Math.max(18, Math.min(W - 18, x));
      y = Math.max(18, Math.min(H - 18, y));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(az);
      ctx.globalAlpha = 0.35 + 0.65 * a;
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(8, 7);
      ctx.lineTo(0, 3);
      ctx.lineTo(-8, 7);
      ctx.closePath();
      ctx.fillStyle = ev.hurt ? '#ff3b3b' : ev.kind === 'explosion' ? '#ffa94d' : '#ff6b6b';
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 0.45 + 0.55 * a;
      ctx.font = '600 11px Consolas,Menlo,monospace';
      ctx.fillStyle = '#ffd8d8';
      ctx.fillText(Math.round(ev.distance) + 'm', x + 10, y + 4);
      ctx.globalAlpha = 1;
    }
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
  else if (e.code === 'F10') { e.preventDefault(); set('radar', !S.cfg.radar); }
  else if (e.code === 'KeyK') set('tracks', !S.cfg.tracks);
}, true);

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mountUI(); mountOverlay(); });
else { mountUI(); mountOverlay(); }
requestAnimationFrame(loop);
})();
