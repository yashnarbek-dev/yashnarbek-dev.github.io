/* ============================================================
   Portfolio terminal.
   Every text, link, color and feature comes from content.json.
   Don't edit content here: open /admin on the site instead.
   ============================================================ */
"use strict";

const PREVIEW = new URLSearchParams(location.search).has("preview");
const PREVIEW_KEY = "yg-preview";
// admin password: only a PBKDF2 hash is stored (content.json "admin" can replace it)
const DEFAULT_LOCK = { iter: 300000, salt: "107d09878cd512533ef660743aa9b8fa", hash: "cc7286a669ad61676e61a9801dab0c4b50ff873d704d22402038f7a36a312f8f" };
const UNLOCK_KEY = "yg-admin-unlock";
async function pbkdf2Hex(pw, saltHex, iter) {
  const salt = new Uint8Array(saltHex.match(/../g).map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const DEFAULT_ACCENT = "#5abb9a";

let S = null;                 // content.json
let CONFIG = {}, PROJECTS = [], TRACKS = [], CHESS = [], I18N = {}, BANNER = [], HEAD3D = null;
let MAIN = [], ALIASES = {}, DEF_LANG = "en", LANG = "en", lastCmd = "";
const T = () => I18N[LANG] || I18N[DEF_LANG];

const out = document.getElementById("out");
const input = document.getElementById("cmd");
const inputRow = document.getElementById("input-row");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const cmdHistory = [];
let histPos = 0;

/* ================= helpers ================= */
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const fmt = (s, vars) => String(s == null ? "" : s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const tr = m => (m && typeof m === "object") ? (m[LANG] || m[DEF_LANG] || Object.values(m).find(Boolean) || "") : (m || "");
const safeUrl = u => /^\s*(javascript|data|vbscript):/i.test(u) && !/^\s*data:image\//i.test(u) ? "#" : String(u);
const c = (name, label, extra) => `<button type="button" class="cmd${extra ? " " + extra : ""}" data-cmd="${esc(name)}">[${esc(label || name)}]</button>`;
const gh = repo => `https://github.com/${CONFIG.github}${repo ? "/" + repo : ""}`;
const link = (url, text) => `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${esc(text)}</a>`;
const rows = pairs => `<div class="rows">${pairs.filter(Boolean).map(([k, v]) => `<div class="k">${k}</div><div>${v}</div>`).join("")}</div>`;
const on = name => !!COMMANDS[name] && !(S.commands.disabled || []).includes(name);
const descOf = n => COMMANDS[n] && COMMANDS[n].custom ? tr(COMMANDS[n].custom.desc) : (T().desc || {})[n] || "";
const pair = ([n, a]) => `<span>${c(n)}${a ? ` ${esc(T().or)} ${c(n, a)}` : ""}</span>`;

// colors
const hexRgb = h => {
  h = String(h || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.replace(/./g, "$&$&");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
};
const rgba = (c3, a) => `rgba(${c3[0]}, ${c3[1]}, ${c3[2]}, ${a})`;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp01 = v => Math.max(0, Math.min(1, v));
function rgbHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslRgb([h, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
// shifts the built-in green palette towards the theme accent color
let TINT = null;
const tint = c3 => {
  if (!TINT) return c3;
  const [h, s, l] = rgbHsl(c3);
  return hslRgb([(h + TINT.dh + 1) % 1, clamp01(s * TINT.sk), clamp01(l + TINT.dl * 0.6)]);
};

function applyTheme() {
  const th = S.theme || {}, st = document.documentElement.style;
  const col = (k, d) => hexRgb(th[k]) ? th[k] : d;
  const bgH = col("bg", "#000000"), fgH = col("fg", "#ffebcd"), acH = col("accent", DEFAULT_ACCENT);
  const bg = hexRgb(bgH), fg = hexRgb(fgH), ac = hexRgb(acH);
  st.setProperty("--bg", bgH); st.setProperty("--fg", fgH); st.setProperty("--accent", acH);
  st.setProperty("--muted", col("muted", "#b5a68f")); st.setProperty("--pink", col("pink", "#f4a3b4"));
  st.setProperty("--line", rgba(ac, 0.18)); st.setProperty("--card-border", rgba(ac, 0.3)); st.setProperty("--card-border-soft", rgba(ac, 0.14));
  st.setProperty("--card-bg", rgba(fg, 0.03));
  st.setProperty("--panel", `rgb(${mix(bg, fg, 0.04)})`); st.setProperty("--panel-border", `rgb(${mix(bg, fg, 0.16)})`);
  if (acH.toLowerCase() !== DEFAULT_ACCENT) {
    const a = rgbHsl(hexRgb(DEFAULT_ACCENT)), b = rgbHsl(ac);
    TINT = { dh: b[0] - a[0], sk: b[1] / a[1], dl: b[2] - a[2] };
  }
  st.setProperty("--scan-hi", `rgb(${tint([159, 245, 212]).map(Math.round)})`);
  st.setProperty("--scan-glow", rgba(ac, 0.8));
  if (+th.fontSize > 0) st.setProperty("--fs-base", +th.fontSize + "px");
  if (th.tintPortrait === false) TINT = null;
  if (th.customCss) { const el = document.createElement("style"); el.textContent = th.customCss; document.head.appendChild(el); }
}

/* ================= content ================= */
async function loadSite() {
  if (PREVIEW) {
    try { const d = localStorage.getItem(PREVIEW_KEY); if (d) return JSON.parse(d); } catch (e) {}
  }
  // the ?v= minute stamp makes a new publish show up within about a minute
  const r = await fetch("content.json?v=" + Math.floor(Date.now() / 60000), { cache: "no-cache" });
  if (!r.ok) throw new Error("content.json: HTTP " + r.status);
  return r.json();
}

async function loadPortrait() {
  try { const r = await fetch("assets/portrait.json"); return r.ok ? await r.json() : null; } catch (e) { return null; }
}

// a language falls back to the default language for anything it doesn't define
function fill(o, d) {
  if (o === undefined || o === null) return d;
  if (Array.isArray(o) || typeof o !== "object" || !d || typeof d !== "object" || Array.isArray(d)) return o;
  const r = { ...d };
  for (const k of Object.keys(o)) r[k] = fill(o[k], d[k]);
  return r;
}

function prepare(site) {
  S = site || {};
  for (const k of ["site", "profile", "theme", "features", "home", "boot", "photo", "commands"]) S[k] = S[k] || {};
  CONFIG = S.profile;
  PROJECTS = S.projects || [];
  TRACKS = S.tracks || [];
  CHESS = S.chess || [];
  BANNER = S.home.banner || [];

  const raw = S.i18n && Object.keys(S.i18n).length ? S.i18n : { en: {} };
  DEF_LANG = raw[S.site.defaultLang] ? S.site.defaultLang : Object.keys(raw)[0];
  I18N = {};
  for (const l of Object.keys(raw)) I18N[l] = fill(raw[l], raw[DEF_LANG]);
  LANG = DEF_LANG;
  try { const saved = localStorage.getItem("lang"); if (I18N[saved]) LANG = saved; } catch (e) {}
  document.documentElement.lang = LANG;

  // extra contact links become commands
  for (const l of CONFIG.links || []) {
    const n = String(l.cmd || "").trim().toLowerCase();
    if (!n || /\s/.test(n) || !l.url) continue;
    contactRow[n] = () => [esc(n), link(l.url, l.text || l.url.replace(/^https?:\/\/(www\.)?/, ""))];
    COMMANDS[n] = { run: () => rows([contactRow[n]()]) };
    if (l.alias) ALIASES_EXTRA[String(l.alias).toLowerCase()] = n;
  }
  // custom commands (can also replace a built-in one)
  for (const cc of S.custom || []) {
    const n = String(cc.name || "").trim().toLowerCase();
    if (!n || /\s/.test(n)) continue;
    COMMANDS[n] = { run: () => customCard(cc), custom: cc };
    for (const a of String(cc.aliases || "").split(/[\s,]+/).filter(Boolean)) ALIASES_EXTRA[a.toLowerCase()] = n;
  }
  ALIASES = {};
  for (const [k, v] of Object.entries(S.commands.aliases || {})) if (k && v) ALIASES[k.toLowerCase()] = String(v).toLowerCase();
  Object.assign(ALIASES, ALIASES_EXTRA);
  MAIN = (S.commands.main || []).filter(([n]) => on(n));

  document.title = S.site.title || document.title;
  const md = document.querySelector('meta[name="description"]');
  if (md && S.site.description) md.setAttribute("content", S.site.description);
  document.getElementById("prompt-user").textContent = S.site.promptUser || "";
  applyTheme();
}
const ALIASES_EXTRA = {};

const ICON = {
  github: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm6.93 6h-2.95a15.6 15.6 0 00-1.38-3.56A8.03 8.03 0 0118.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14a8.2 8.2 0 010-4h3.38a16.5 16.5 0 000 4H4.26zm.81 2h2.95c.32 1.25.78 2.45 1.38 3.56A8 8 0 015.07 16zm2.95-8H5.07a8 8 0 014.33-3.56C8.8 5.55 8.34 6.75 8.02 8zM12 19.96A14.2 14.2 0 0110.09 16h3.82A14.2 14.2 0 0112 19.96zM14.34 14H9.66a14.7 14.7 0 010-4h4.68a14.7 14.7 0 010 4zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 01-4.33 3.56zM16.36 14a16.5 16.5 0 000-4h3.38a8.2 8.2 0 010 4h-3.38z"/></svg>',
};

/* ================= 2.5D portrait ================= */
const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const KINDS = "fblsrhv";   // face/suit, dark hair, lens, lens sheen, frame, frame highlight, rivet
const LEVELS = 12;
const PALETTES = [
  t => [40 + 162 * t, 105 + 150 * t, 85 + 146 * t, 0.35 + 0.65 * t],
  t => [25 + 70 * t, 70 + 92 * t, 60 + 82 * t, 0.25 + 0.5 * t],
  t => [14 + 44 * t, 34 + 76 * t, 34 + 72 * t, 1],
  t => [60 + 90 * t, 110 + 100 * t, 105 + 100 * t, 0.85],
  t => [22 + 30 * t, 28 + 36 * t, 27 + 35 * t, 1],
  t => [150 + 105 * t, 140 + 95 * t, 120 + 85 * t, 0.5 + 0.5 * t],
  t => [205 + 50 * t, 210 + 45 * t, 205 + 50 * t, 1],
];
const LIGHT = (() => { const l = Math.hypot(-0.35, -0.45, 1); return [-0.35 / l, -0.45 / l, 1 / l]; })();
let HEAD_PTS = null;

function headPoints() {
  if (HEAD_PTS) return HEAD_PTS;
  const s = HEAD3D && HEAD3D.p;
  if (!s) return null;
  const R = 12, n = s.length / R;
  const P = { n, cols: HEAD3D.cols || 100, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), b: new Float32Array(n),
    k: new Uint8Array(n), nx: new Float32Array(n), ny: new Float32Array(n), nz: new Float32Array(n), ch: new Array(n), ymax: 0 };
  const d2 = o => (B36.indexOf(s[o]) * 36 + B36.indexOf(s[o + 1]) - 648) / 4;
  const d1 = o => B36.indexOf(s[o]) / 35;
  for (let i = 0, o = 0; i < n; i++, o += R) {
    P.x[i] = d2(o); P.y[i] = d2(o + 2); P.z[i] = d2(o + 4); P.b[i] = d1(o + 6); P.k[i] = KINDS.indexOf(s[o + 7]);
    P.nx[i] = d1(o + 8) * 2 - 1; P.ny[i] = d1(o + 9) * 2 - 1; P.nz[i] = d1(o + 10) * 2 - 1; P.ch[i] = s[o + 11];
    P.ymax = Math.max(P.ymax, Math.abs(P.y[i]));
  }
  return (HEAD_PTS = P);
}

function mountPortrait(canvas) {
  const P = headPoints();
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!P || !ctx) return false;
  const chars = [...new Set(P.ch)];
  const charIdx = new Uint8Array(P.n);
  for (let i = 0; i < P.n; i++) charIdx[i] = chars.indexOf(P.ch[i]);
  let W = 0, H = 0, unit = 1, dpr = 1, sheet = null, cw = 0, chh = 0;
  let yaw = 0, pitch = 0, tYaw = 0, tPitch = 0, lastMove = -1e9, running = false, visible = true, dirty = true, slow = false, tick = 0;

  function buildSheet(fontPx) {
    sheet = document.createElement("canvas");
    cw = Math.ceil(fontPx * 0.72 * dpr) + 2; chh = Math.ceil(fontPx * 1.15 * dpr) + 2;
    sheet.width = cw * chars.length; sheet.height = chh * PALETTES.length * LEVELS;
    const s = sheet.getContext("2d");
    s.font = `700 ${(fontPx * dpr).toFixed(2)}px "Geist Mono", ui-monospace, monospace`;
    s.textAlign = "center"; s.textBaseline = "middle";
    PALETTES.forEach((pal, pi) => {
      for (let lv = 0; lv < LEVELS; lv++) {
        const [r0, g0, b0, a] = pal(lv / (LEVELS - 1));
        const [r, g, b] = pi <= 4 ? tint([r0, g0, b0]) : [r0, g0, b0];
        s.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(2)})`;
        chars.forEach((ch, ci) => s.fillText(ch, ci * cw + cw / 2, (pi * LEVELS + lv) * chh + chh / 2));
      }
    });
  }
  function resize(force) {
    const w = canvas.clientWidth;
    if (!w || (w === W && !force)) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = w; unit = W / (P.cols + 14); H = Math.round(unit * (P.ymax * 2 + 16));
    canvas.style.height = H + "px";
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildSheet(unit * 1.55);
    dirty = true;
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const f = 300, ox = W / 2, oy = H / 2, cwC = cw / dpr, chC = chh / dpr;
    const { x, y, z, b, k, nx, ny, nz, n } = P;
    for (let i = 0; i < n; i++) {
      const kind = k[i];
      const nx1 = nx[i] * cyw + nz[i] * syw, nz1 = -nx[i] * syw + nz[i] * cyw;
      const ny1 = ny[i] * cp - nz1 * sp, nz2 = ny[i] * sp + nz1 * cp;
      if (nz2 < -0.06) continue;
      const x1 = x[i] * cyw + z[i] * syw, z1 = -x[i] * syw + z[i] * cyw;
      const y1 = y[i] * cp - z1 * sp, z2 = y[i] * sp + z1 * cp;
      const lam = Math.max(0, nx1 * LIGHT[0] + ny1 * LIGHT[1] + nz2 * LIGHT[2]);
      const rim = 1 - Math.max(0, nz2);
      const shade = kind <= 1 ? 0.3 + 0.7 * lam + rim * rim * rim * 0.3 : 0.65 + 0.35 * lam;
      const base = kind === 6 ? 1 : b[i];
      const lv = Math.min(LEVELS - 1, Math.round(base * shade * (LEVELS - 1)));
      const s = f / (f - z2), dw = cwC * s, dh = chC * s;
      ctx.drawImage(sheet, charIdx[i] * cw, (kind * LEVELS + lv) * chh, cw, chh,
        ox + x1 * s * unit - dw / 2, oy + y1 * s * unit - dh / 2, dw, dh);
    }
  }
  function frame(t) {
    if (!canvas.isConnected || !visible) { running = false; return; }
    if (!reduceMotion && t - lastMove > 2500) { tYaw = Math.sin(t / 1800) * 0.34; tPitch = Math.sin(t / 2600) * 0.06; }
    const dy = tYaw - yaw, dp = tPitch - pitch;
    yaw += dy * 0.07; pitch += dp * 0.07;
    if (dirty || Math.abs(dy) > 0.0004 || Math.abs(dp) > 0.0004) {
      if (!(slow && (tick++ & 1))) { const t0 = performance.now(); draw(); dirty = false; slow = performance.now() - t0 > 14; }
    }
    requestAnimationFrame(frame);
  }
  function start() { if (!running && visible) { running = true; requestAnimationFrame(frame); } }
  function aim(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const mx = (clientX - (r.left + r.width / 2)) / (window.innerWidth / 2);
    const my = (clientY - (r.top + r.height / 2)) / (window.innerHeight / 2);
    // 2.5D relief: keep the turn small so it always looks solid
    tYaw = Math.max(-1, Math.min(1, mx)) * 0.42;
    tPitch = -Math.max(-1, Math.min(1, my)) * 0.16;
    lastMove = performance.now();
    start();
  }
  function onMove(e) {
    if (!canvas.isConnected) { window.removeEventListener("pointermove", onMove); return; }
    if (e.pointerType === "touch") return;
    aim(e.clientX, e.clientY);
  }
  window.addEventListener("pointermove", onMove, { passive: true });
  canvas.addEventListener("pointermove", e => { if (e.pointerType === "touch") aim(e.clientX, e.clientY); }, { passive: true });
  if ("IntersectionObserver" in window) new IntersectionObserver(es => { visible = es[0].isIntersecting; start(); }).observe(canvas);
  if ("ResizeObserver" in window) new ResizeObserver(() => requestAnimationFrame(() => { resize(); start(); })).observe(canvas);
  if (document.fonts) document.fonts.ready.then(() => { resize(true); start(); });
  resize(true); draw(); start();
  return true;
}

function mountPortraits() {
  document.querySelectorAll("canvas.portrait:not([data-on])").forEach(cv => {
    cv.dataset.on = "1";
    if (!mountPortrait(cv)) cv.closest(".art").hidden = true;
  });
}

/* ================= screens ================= */
const showPortrait = () => S.features.portrait !== false && !!HEAD3D;
const CONTACT_VALUE = { email: () => CONFIG.email, github: () => CONFIG.github, telegram: () => CONFIG.telegram, linkedin: () => CONFIG.linkedin };
function CONTACTS() {
  const list = (S.commands.contacts || []).filter(([n]) => on(n) && (!CONTACT_VALUE[n] || CONTACT_VALUE[n]()));
  for (const l of CONFIG.links || []) {
    const n = String(l.cmd || "").trim().toLowerCase();
    if (n && on(n) && !list.some(([x]) => x === n)) list.push([n, l.alias || ""]);
  }
  return list;
}
const langRow = () => `<div class="cmdrow"><span class="muted">${esc(T().language)}</span>${Object.keys(I18N).map(l => c("lang " + l, l.toUpperCase(), l === LANG ? "on" : "")).join("")}</div>`;

function welcome(instant) {
  const L = T(), F = S.features, art = showPortrait(), target = S.home.newTarget;
  const contacts = CONTACTS();
  return `<div class="hero${art ? "" : " noart"}">
    <div class="intro">
      <pre class="banner${BANNER.length ? "" : " empty"}" aria-label="${esc(S.home.bannerLabel || "")}">${instant ? esc(BANNER.join("\n")) : ""}</pre>
      <p class="typed${instant ? " done" : ""}">${instant ? esc(L.welcome) : ""}</p>
      <div class="later">
        <p>${esc(L.typeHelp[0])} <span class="acc">'help'</span>${esc(L.typeHelp[1])}</p>
        ${F.newLine !== false && L.newLine ? `<p><span class="pink">${esc(L.newTag)}</span> ${esc(L.newLine)} ${target && on(target) ? c(target, L.seeIt) : ""}</p>` : ""}
        ${F.langSwitcher !== false && Object.keys(I18N).length > 1 ? langRow() : ""}
      </div>
    </div>
    ${art ? `<div class="art${instant ? " on" : ""}">
      <canvas class="portrait" role="img" aria-label="${esc(fmt(S.site.portraitAlt, { name: CONFIG.name }))}"></canvas>
      <div class="hint">${esc(L.hint)}</div>
    </div>` : ""}
    <div class="cmds later">
      <h3>${esc(L.avail)}</h3>
      <div class="cmdlist">${MAIN.map(pair).join("")}</div>
      ${contacts.length ? `<h3>${esc(L.contactMe)}</h3><div class="cmdlist">${contacts.map(pair).join("")}</div>` : ""}
    </div>
  </div>`;
}

function storyCard() {
  const L = T(), photo = S.features.photo !== false && S.photo.src;
  const next = (S.commands.next || []).filter(on);
  return `<div class="card"><div class="about-grid${photo ? "" : " nophoto"}">${photo ? photoPanel() : ""}<div>
    <div class="name">${esc(CONFIG.name)}</div>
    <div class="tag">${esc(L.tag)}</div>
    <div>${(L.beats || []).map(([l, t], i) => `<div class="beat"><span class="n">${String(i + 1).padStart(2, "0")}</span><span class="lbl">${esc(l)}</span><p>${esc(t)}</p></div>`).join("")}</div>
    <div class="next"><span class="muted">→</span>${next.map(n => c(n)).join("")}${on("whoami") && L.andYou ? `<span class="muted">${esc(L.andYou)}</span>${c("whoami")}` : ""}</div>
  </div></div></div>`;
}

function projectCard(p) {
  const name = tr(p.name), tech = tr(p.tech), desc = tr(p.desc);
  const slug = p.slug || p.repo || p.key || "project";
  const repoUrl = p.repo ? (/^https?:\/\//i.test(p.repo) ? p.repo : gh(p.repo)) : "";
  const mainUrl = p.url || repoUrl;
  const inner = p.image
    ? `<div class="dots"><span></span><span></span><span></span></div><img src="${esc(safeUrl(p.image))}" alt="" loading="lazy" style="margin-top:10px">`
    : `<div class="dots"><span></span><span></span><span></span></div>
         <div class="path">~/projects/${esc(slug)}</div>
         <div class="big"><span class="acc">$</span> ./${esc(slug)}</div>`;
  const preview = mainUrl
    ? `<a class="preview" href="${esc(safeUrl(mainUrl))}" target="_blank" rel="noopener" aria-label="Open ${esc(name)}${p.url ? "" : " on GitHub"}">${inner}</a>`
    : `<div class="preview">${inner}</div>`;
  const icons = [
    repoUrl && `<a href="${esc(repoUrl)}" target="_blank" rel="noopener" aria-label="${esc(name)} on GitHub">${ICON.github}</a>`,
    p.url && `<a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener" aria-label="${esc(name)} website">${ICON.globe}</a>`,
  ].filter(Boolean).join("");
  const badge = p.badge ? `<span class="badge${p.mutedBadge ? " draft" : ""}">${esc(p.badge)}</span>` : "";
  const title = p.cmd ? `<button type="button" class="cmd" style="font-weight:700" data-cmd="${esc(p.cmd)}">${esc(name)}</button>`
    : mainUrl ? `<a class="tlink" href="${esc(safeUrl(mainUrl))}" target="_blank" rel="noopener">${esc(name)}</a>` : `<span>${esc(name)}</span>`;
  const repoLine = repoUrl ? `<div class="repo">${link(repoUrl, repoUrl.replace(/^https?:\/\//i, "") + " ↗")}</div>` : "";
  return `<div class="pcard${p.featured ? " featured" : ""}">${preview}
    <div class="title">${title}${badge}</div>
    ${tech ? `<div class="tech">${esc(tech)}</div>` : ""}
    <div>${esc(desc)}</div>
    ${repoLine}${icons ? `<div class="icons">${icons}</div>` : ""}</div>`;
}

const trackUrls = t => {
  const q = encodeURIComponent(`${t.artist} ${t.song}`);
  return { yt: t.youtube || "https://www.youtube.com/results?search_query=" + q, sp: t.spotify || "https://open.spotify.com/search/" + q };
};
function musicCard() {
  const M = T().music, n = TRACKS.length;
  return `<div class="card player">
    <div class="head"><b><span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${esc(M.title)}</b><span class="muted">${esc(fmt(M.count, { n }))}</span></div>
    ${TRACKS.map((t, i) => { const u = trackUrls(t); return `<div class="track"><span class="n">${String(i + 1).padStart(2, "0")}</span><span class="song">${esc(t.song)}</span><span class="artist">${esc(t.artist)}</span>
      <span class="go">${link(u.yt, "▶ YouTube")}${link(u.sp, "Spotify")}</span></div>`; }).join("")}
    ${M.note ? `<p class="note" style="margin:14px 0 0">${esc(fmt(M.note, { n }))}</p>` : ""}
  </div>`;
}

// custom commands use a tiny markup: "# title", "key | value", "![alt](image)", "[text](url)", "[[command]]", "**bold**"
function inline(s) {
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])|\*\*([^*]+)\*\*/g;
  let html = "", last = 0;
  for (const m of s.matchAll(re)) {
    html += esc(s.slice(last, m.index));
    if (m[1]) html += c(m[1].trim(), (m[2] || m[1]).trim());
    else if (m[3]) html += link(m[4], m[3]);
    else if (m[5]) html += link(m[5], m[5]);
    else if (m[6]) html += `<b>${esc(m[6])}</b>`;
    last = m.index + m[0].length;
  }
  return html + esc(s.slice(last));
}
function markup(src) {
  let html = "", buf = [];
  const flush = () => { if (buf.length) { html += rows(buf); buf = []; } };
  for (const raw of String(src || "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    let m;
    if (!line) flush();
    else if ((m = line.match(/^#{1,3}\s+(.*)$/))) { flush(); html += `<div class="t">${inline(m[1])}</div>`; }
    else if ((m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/))) { flush(); html += `<img src="${esc(safeUrl(m[2]))}" alt="${esc(m[1])}" loading="lazy">`; }
    else if ((m = line.match(/^(.+?)\s+\|\s+(.+)$/))) buf.push([inline(m[1]), inline(m[2])]);
    else { flush(); html += `<p>${inline(line)}</p>`; }
  }
  flush();
  return html;
}
const customCard = cc => cc.boxed === false ? `<div class="md">${markup(tr(cc.body))}</div>` : `<div class="card md">${markup(tr(cc.body))}</div>`;

const contactRow = {
  email: () => CONFIG.email && ["email", `${link("mailto:" + CONFIG.email, CONFIG.email)}<button type="button" class="cmd copy" data-copy="${esc(CONFIG.email)}">${esc(T().copy[0])}</button>`],
  github: () => CONFIG.github && ["github", link(gh(), "github.com/" + CONFIG.github)],
  telegram: () => CONFIG.telegram && ["telegram", link("https://t.me/" + CONFIG.telegram, "@" + CONFIG.telegram)],
  linkedin: () => CONFIG.linkedin && ["linkedin", link(CONFIG.linkedin, CONFIG.linkedin.replace(/^https?:\/\/(www\.)?/, ""))],
};

const COMMANDS = {
  help: { run: () => { const L = T(), contacts = CONTACTS(), extras = (S.commands.extras || []).filter(on);
    return `<h3 style="margin-top:0">${esc(L.avail)}</h3>
    <div class="cmdlist">${MAIN.map(([n, a]) => `<span>${c(n)}${a ? ` ${esc(L.or)} ${c(n, a)}` : ""} <span class="muted">- ${esc(descOf(n))}</span></span>`).join("")}</div>
    ${contacts.length ? `<h3>${esc(L.contactMe)}</h3><div class="cmdlist">${contacts.map(pair).join("")} ${on("contact") ? `<span>${c("contact")} <span class="muted">- ${esc(L.allAtOnce)}</span></span>` : ""}</div>` : ""}
    ${extras.length ? `<h3>${esc(L.extras)}</h3><div class="cmdrow">${extras.map(n => c(n)).join("")}</div>` : ""}
    ${on("lang") && Object.keys(I18N).length > 1 ? `<h3>${esc(L.language)}</h3>${langRow()}` : ""}
    <p class="note" style="margin-top:12px">${esc(L.keys)}</p>`; } },

  about: { run: () => storyCard() },
  projects: { run: () => `<div class="grid">${PROJECTS.map(projectCard).join("")}</div>${CONFIG.github ? `<p>${esc(T().allCode)} ${link(gh(), "github.com/" + CONFIG.github)}</p>` : ""}` },

  teaching: { run: () => `<div class="card">${(T().teaching || []).map(([t, s, p], i, a) =>
      `<div class="entry"${i === a.length - 1 ? ' style="margin-bottom:0"' : ""}><div class="t">${esc(t)}</div>${s ? `<div class="s">${esc(s)}</div>` : ""}<p${i === a.length - 1 ? ' style="margin-bottom:0"' : ""}>${esc(p)}</p></div>`).join("")}</div>` },

  achievements: { run: () => `<div class="card">${rows((T().achievements || []).map(([k, v], i) => [esc(k), esc(v) + (i === 0 && CONFIG.olympiadYear ? " · " + esc(CONFIG.olympiadYear) : "")]))}</div>` },
  skills: { run: () => `<div class="card">${rows((T().skills || []).map(([k, v]) => [esc(k), esc(v)]))}</div>` },
  miscellaneous: { run: () => `<div class="card">${(T().misc || []).map((m, i, a) => `<p${i === a.length - 1 ? ' style="margin-bottom:0"' : ""}>- ${esc(m)}</p>`).join("")}</div>` },
  mathbook: { run: () => `<div class="card">${rows((T().mathbook || []).map(([k, v]) => v ? [esc(k), esc(v)] : (CONFIG.mathbookRole ? [esc(k), esc(CONFIG.mathbookRole)] : null)))}</div>` },
  music: { run: () => musicCard() },
  chess: { run: () => chessCard() },
  play: { run: args => {
      const M = T().music, i = parseInt(args[0], 10) - 1;
      if (!(i >= 0 && i < TRACKS.length)) return esc(fmt(M.usage, { n: TRACKS.length }));
      const t = TRACKS[i], url = trackUrls(t).yt;
      window.open(url, "_blank", "noopener");
      return `${esc(M.opening)} ${link(url, `${t.song} — ${t.artist}`)}`;
    } },

  resume: { run: () => {
      if (!CONFIG.resumeUrl) return `<span class="muted">${esc(T().resumeSoon)}</span> ${c("about")}`;
      const [open, download, oneLine] = T().resumeLinks;
      return `<div class="card"><div class="t" style="color:var(--accent);font-weight:700">${esc(CONFIG.name)} · ${esc(T().resumeTitle)}</div>
        <p class="muted" style="margin:6px 0 12px">${esc(oneLine)}</p>
        <div class="cmdrow">${link(CONFIG.resumeUrl, open + " ↗")}<a href="${esc(safeUrl(CONFIG.resumeUrl))}" download>${esc(download)} ↓</a></div></div>`;
    } },
  clear: { run: () => { out.innerHTML = ""; return null; } },
  contact: { run: () => `<div class="card">${rows(CONTACTS().map(([n]) => contactRow[n] && contactRow[n]()))}</div>` },
  email: { run: () => CONFIG.email ? rows([contactRow.email()]) : "-" },
  github: { run: () => CONFIG.github ? rows([contactRow.github()]) : "-" },
  telegram: { run: () => CONFIG.telegram ? rows([contactRow.telegram()]) : "-" },
  linkedin: { run: () => CONFIG.linkedin ? rows([contactRow.linkedin()]) : "-" },
  lang: { run: args => {
      const l = (args[0] || "").toLowerCase();
      if (!I18N[l]) return `${esc(T().desc.lang)}<br>${langRow()}`;
      LANG = l;
      try { localStorage.setItem("lang", l); } catch (e) {}
      document.documentElement.lang = l;
      return "__home__";
    } },

  neofetch: { run: () => `<div class="card">${rows((T().neofetch || []).map(([k, v]) => [esc(k), esc(v)]))}</div>` },
  all: { run: () => (S.commands.all || []).filter(k => k !== "all" && on(k))
      .map(k => [k, COMMANDS[k].run([])]).filter(([, r]) => r && r !== "__home__")
      .map(([k, r]) => `<h3>${esc(k)}</h3>` + r).join("") },
  whoami: { run: () => { const w = T().whoami; return `${esc(w[0])} <span class="muted">${esc(w[1])}</span> ${c("about")}<span class="muted">${esc(w[2])}</span>`; } },
  history: { run: () => cmdHistory.length ? cmdHistory.map((h, i) => `${String(i + 1).padStart(3)}  ${esc(h)}`).join("<br>") : esc(T().noHistory) },
  home: { run: () => "__home__" },
  welcome: { run: () => "__home__" },
  ls: { run: () => esc(S.commands.ls || "") },
  pwd: { run: () => esc(S.commands.pwd || "") },
  sudo: { run: () => `${esc(T().sudo)} <span class="muted">${esc(T().kidding)}</span>` },
  echo: { run: args => esc(args.join(" ")) },
  admin: { run: () => { startPassword(); return null; } },
};

/* ================= about: photo decoded like a matrix ================= */
const dims = s => String(s || "").trim().replace(/px$/i, "");
function photoPanel() {
  const P = S.photo;
  return `<div class="scan" data-scan>
    <div class="scan-head">FILE: <b>${esc(P.fileName)}</b><br>SIZE: <b>${esc(dims(P.size))}${dims(P.size) ? "px" : ""}</b>&nbsp; TYPE: <b>${esc(P.type)}</b></div>
    <div class="scan-box"><img src="${esc(safeUrl(P.src))}" alt="${esc(fmt(S.site.photoAlt, { name: CONFIG.name }))}"><pre class="hex" aria-hidden="true"></pre><div class="line"></div></div>
    <div class="scan-status">${esc(T().scan.decoding)}</div>
  </div>`;
}

function mountReveals() {
  document.querySelectorAll("[data-scan]:not([data-on])").forEach(panel => {
    panel.dataset.on = "1";
    const box = panel.querySelector(".scan-box"), hex = panel.querySelector(".hex"), status = panel.querySelector(".scan-status");
    const Sc = T().scan, size = dims(S.photo.size);
    if (reduceMotion || S.features.photoScan === false) {
      box.style.setProperty("--p", "100%"); box.classList.add("done"); status.textContent = Sc.ok + (size ? ` · ${size}` : ""); return;
    }
    const HEX = "0123456789ABCDEF";
    const fill = () => {
      const cols = Math.max(8, Math.floor(box.clientWidth / 10.2)), rows = Math.ceil(box.clientHeight / 15.6) + 1;
      let s = "";
      for (let r = 0; r < rows; r++) { for (let i = 0; i < cols; i++) s += HEX[(Math.random() * 16) | 0]; s += "\n"; }
      hex.textContent = s;
    };
    const dur = 3600;
    let t0 = null, lastFill = 0;
    const step = () => {
      if (!panel.isConnected) return;
      const t = performance.now();
      if (t0 === null) t0 = t;
      const k = Math.min(1, (t - t0) / dur);
      box.style.setProperty("--p", (Math.floor(k * 64) / 64 * 100).toFixed(2) + "%");   // line by line
      if (t - lastFill > 70) { fill(); lastFill = t; }
      status.textContent = `${Sc.decoding} ${Math.round(k * 100)}%`;
      if (k < 1) requestAnimationFrame(step);
      else { box.classList.add("done"); status.textContent = Sc.ok + (size ? ` · ${size}` : ""); }
    };
    fill();
    requestAnimationFrame(step);
  });
}

/* ================= chess.com, live ================= */
function chessStats(s, C) {
  const cell = (label, v) => v && v[0] ? `<span>${esc(label)} <b>${esc(v[0])}</b>${v[1] ? ` <span class="muted">(${esc(C.best)} ${esc(v[1])})</span>` : ""}</span>` : "";
  return cell(C.rapid, s.rapid) + cell(C.blitz, s.blitz) + cell(C.bullet, s.bullet)
    + (s.puzzles ? `<span>${esc(C.puzzles)} <b>${esc(s.puzzles)}</b></span>` : "")
    + (s.games ? `<span class="muted">${Number(s.games).toLocaleString("en-US")} ${esc(C.games)}</span>` : "");
}
function chessCard() {
  const C = T().chessT, live = S.features.chessLive !== false;
  return `<div class="card chess">${CHESS.map(a => `<div class="acct" data-chess="${esc(a.user)}">
      <div><b class="acc">♞ ${link("https://www.chess.com/member/" + a.user, a.user)}</b> <span class="muted" data-f="meta">${!live && a.saved && a.saved.joined ? `· ${esc(C.joined)} ${esc(a.saved.joined)}` : ""}</span></div>
      <div class="stats" data-f="stats">${chessStats(a.saved || {}, C)}</div></div>`).join("")}
    <p class="note" style="margin:12px 0 0" data-f="note">${live ? esc(C.loading) : ""}</p></div>`;
}
async function loadChess() {
  if (S.features.chessLive === false) return;
  for (const card of document.querySelectorAll(".chess:not([data-on])")) {
    card.dataset.on = "1";
    const C = T().chessT;
    let ok = 0;
    await Promise.all(CHESS.map(async a => {
      const row = card.querySelector(`[data-chess="${CSS.escape(a.user)}"]`);
      try {
        const get = u => fetch(u).then(r => r.ok ? r.json() : Promise.reject(r.status));
        const [st, pr] = await Promise.all([get(`https://api.chess.com/pub/player/${encodeURIComponent(a.user)}/stats`), get(`https://api.chess.com/pub/player/${encodeURIComponent(a.user)}`)]);
        const g = k => st[k] ? [st[k].last.rating, (st[k].best || st[k].last).rating] : null;
        const games = ["chess_rapid", "chess_blitz", "chess_bullet", "chess_daily"]
          .reduce((n, k) => n + (st[k] ? st[k].record.win + st[k].record.loss + st[k].record.draw : 0), 0);
        row.querySelector('[data-f="stats"]').innerHTML = chessStats({ rapid: g("chess_rapid"), blitz: g("chess_blitz"), bullet: g("chess_bullet"),
          puzzles: st.tactics && st.tactics.highest && st.tactics.highest.rating, games }, C);
        row.querySelector('[data-f="meta"]').textContent = `· ${C.joined} ${new Date(pr.joined * 1000).toISOString().slice(0, 7)}`;
        ok++;
      } catch (e) {
        row.querySelector('[data-f="meta"]').textContent = a.saved && a.saved.joined ? `· ${C.joined} ${a.saved.joined}` : "";
      }
    }));
    card.querySelector('[data-f="note"]').textContent = ok ? C.note : C.offline;
  }
}

/* ================= terminal ================= */
function say(html, cls) {
  if (html == null) return null;
  const d = document.createElement("div");
  d.className = cls || "block";
  d.innerHTML = html;
  out.appendChild(d);
  return d;
}

// print an output block piece by piece, like a terminal
function reveal(block, stepMs = 55) {
  if (reduceMotion || !block) return;
  const parts = block.querySelectorAll(".beat, .rows > div, .entry, .pcard, .track, .card > p, .md > .t, .md > img, .cmdlist > span, .cmdrow > *, h3, .next, :scope > p");
  const items = parts.length ? parts : [block];
  items.forEach((el, i) => { el.classList.add("rv"); el.style.animationDelay = Math.min(i * stepMs, 1400) + "ms"; });
}

const promptHtml = () => `<span class="prompt"><span class="u">${esc(S.site.promptUser || "")}</span>:~$</span>`;

/* ================= admin: ask for the password ================= */
let pwMode = false, pwBusy = false;
const promptLabel = document.querySelector("label.prompt");
const pwLabel = () => T().adminPassword || "Password:";
function startPassword() {
  pwMode = true;
  promptLabel.innerHTML = `<span class="u">${esc(pwLabel())}</span>`;
  input.value = ""; input.type = "password"; input.setAttribute("aria-label", pwLabel());
  enterHint.hidden = true;
  setTimeout(() => input.focus({ preventScroll: true }), 0);
}
function endPassword() {
  pwMode = false;
  input.value = ""; input.type = "text"; input.setAttribute("aria-label", "Type a command");
  promptLabel.innerHTML = `<span class="u" id="prompt-user">${esc(S.site.promptUser || "")}</span>:~$`;
}
async function submitPassword() {
  if (pwBusy) return;
  const pw = input.value;
  say(`<span class="prompt"><span class="u">${esc(pwLabel())}</span></span>`, "block echo");
  endPassword();
  pwBusy = true; input.disabled = true;
  const lock = S.admin && S.admin.hash && S.admin.salt ? S.admin : DEFAULT_LOCK;
  let ok = false;
  try { ok = !!pw && (await pbkdf2Hex(pw, lock.salt, lock.iter || 300000)) === lock.hash; } catch (e) {}
  if (!ok) await new Promise(r => setTimeout(r, 600));
  pwBusy = false; input.disabled = false;
  if (ok) {
    try { sessionStorage.setItem(UNLOCK_KEY, lock.hash); } catch (e) {}
    say(`<span class="acc">${esc(T().adminGranted || "Access granted.")}</span>`);
    setTimeout(() => { location.href = "admin.html"; }, 700);
  } else {
    say(`<span class="pink">${esc(T().adminDenied || "Access denied.")}</span>`);
    input.focus({ preventScroll: true });
  }
}

function goHome() {
  out.innerHTML = "";
  reveal(say(welcome(true)));
  mountPortraits();
  enterHint.textContent = T().pressEnter;
  window.scrollTo({ top: 0, behavior: "auto" });
}

function run(raw, opts = {}) {
  if (pwMode) endPassword();
  const text = raw.trim();
  const [name0 = "", ...args] = text.split(/\s+/);
  const name = ALIASES[name0.toLowerCase()] || name0.toLowerCase();
  if ((name === "home" || name === "welcome") && on(name)) {          // home = clear the screen, then the start screen
    cmdHistory.push(text); histPos = cmdHistory.length; lastCmd = "";
    goHome();
    return;
  }
  const echo = say(`${promptHtml()} ${esc(text)}`, "block echo");
  if (!text) return;
  cmdHistory.push(text); histPos = cmdHistory.length;
  if (!on(name)) reveal(say(fmt(esc(T().notFound), { name: esc(name0), help: c("help") })));
  else {
    const res = COMMANDS[name].run(args);
    if (name === "clear") { lastCmd = ""; suggest("home"); return; }
    if (res === "__home__") { lastCmd = ""; goHome(); return; }
    lastCmd = text;
    reveal(say(res));
    mountPortraits();
    mountReveals();
    loadChess();
  }
  if (!opts.silent) echo.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
}

function complete() {
  const v = input.value.trim().toLowerCase();
  if (!v) return;
  const names = [...new Set([...Object.keys(COMMANDS).filter(on), ...Object.keys(ALIASES).filter(a => on(ALIASES[a]))])].filter(k => k.startsWith(v));
  if (names.length === 1) input.value = names[0];
  else if (names.length > 1) say(names.map(n => c(n)).join(" "));
}

// after "clear": type a suggestion into the prompt so new visitors know what to do next
const enterHint = document.getElementById("enter-hint");
let suggestId = 0;
async function suggest(text) {
  const id = ++suggestId;
  input.value = "";
  enterHint.hidden = true;
  await new Promise(r => setTimeout(r, 350));
  for (let i = 1; i <= text.length; i++) {
    if (id !== suggestId) return;
    input.value = text.slice(0, i);
    await new Promise(r => setTimeout(r, 160));
  }
  if (id !== suggestId) return;
  enterHint.textContent = T().pressEnter;
  enterHint.hidden = false;
  if (window.matchMedia("(pointer: fine)").matches) { input.focus({ preventScroll: true }); input.setSelectionRange(text.length, text.length); }
}
input.addEventListener("input", () => { suggestId++; enterHint.hidden = true; });

input.addEventListener("keydown", e => {
  if (pwMode) {
    if (e.key === "Enter") { e.preventDefault(); submitPassword(); }
    else if (e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "c")) {
      e.preventDefault();
      say(`<span class="prompt"><span class="u">${esc(pwLabel())}</span></span> ^C`, "block echo");
      endPassword();
    }
    else if (e.key === "Tab" || e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
    return;
  }
  if (e.key === "Enter") { suggestId++; enterHint.hidden = true; run(input.value); input.value = ""; }
  else if (e.key === "Tab") { e.preventDefault(); complete(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); if (histPos > 0) input.value = cmdHistory[--histPos]; }
  else if (e.key === "ArrowDown") { e.preventDefault(); histPos = Math.min(cmdHistory.length, histPos + 1); input.value = cmdHistory[histPos] || ""; }
  else if (e.ctrlKey && e.key.toLowerCase() === "l") { e.preventDefault(); out.innerHTML = ""; suggest("home"); }
});

/* ================= boot: slow, like a real terminal ================= */
let booting = false, skipBoot = false;
const wait = ms => skipBoot ? Promise.resolve() : new Promise(r => setTimeout(r, ms));
document.addEventListener("keydown", () => { if (booting) skipBoot = true; });

document.addEventListener("click", async e => {
  if (booting) { skipBoot = true; return; }
  const cp = e.target.closest("[data-copy]");
  if (cp) {
    const [, done, fail] = T().copy;
    try { await navigator.clipboard.writeText(cp.dataset.copy); cp.textContent = done; }
    catch (err) { cp.textContent = fail; }
    return;
  }
  const b = e.target.closest(".cmd");
  if (b && b.dataset.cmd) { run(b.dataset.cmd); return; }
  if (e.target.closest("a, button, canvas")) return;
  if (!window.getSelection().toString()) input.focus({ preventScroll: true });
});

async function typeInto(el, text, speed) {
  for (let i = 1; i <= text.length; i++) {
    if (skipBoot) { el.textContent = text; break; }
    el.textContent = text.slice(0, i);
    await wait(speed + (Math.random() < 0.08 ? 90 : 0));
  }
}

async function boot() {
  const B = S.boot, mode = S.features.boot || "session";
  let seen = false;
  try { seen = sessionStorage.getItem("booted") === "1"; sessionStorage.setItem("booted", "1"); } catch (e) {}
  const params = new URLSearchParams(location.search);
  let animate = !reduceMotion && (mode === "always" || (mode === "session" && !seen));
  if (PREVIEW) animate = params.has("boot") && mode !== "never";
  if (animate) {
    booting = true;
    const skipNote = document.createElement("div");
    skipNote.className = "skip"; skipNote.textContent = B.skip || "";
    if (B.skip) document.body.appendChild(skipNote);

    const box = say("", "boot");
    const line = (html, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; d.innerHTML = html; box.appendChild(d); return d; };
    const cmdLine = line(`<span class="prompt"><span class="u">${esc(B.prompt)}</span>:~$</span> <span class="t"></span>`, "cursor");
    await wait(700);
    await typeInto(cmdLine.querySelector(".t"), B.command || "", 70);
    await wait(450);
    cmdLine.classList.remove("cursor");
    if (B.connecting) { line(`<span class="dim">${esc(B.connecting)}</span>`); await wait(750); }
    if (B.connected) { line(`<span class="dim">${esc(fmt(B.connected, { date: new Date().toDateString() }))}</span>`); await wait(500); }
    for (const [verb, what] of B.steps || []) {
      line(`[ <span class="ok">OK</span> ] ${esc(verb)} ${esc(what)}.`);
      await wait(220 + Math.random() * 220);
    }
    await wait(700);
    box.remove();
    skipNote.remove();
  }

  const hero = say(welcome(!animate));
  mountPortraits();
  if (animate) {
    const banner = hero.querySelector(".banner");
    const later = hero.querySelectorAll(".later");
    later.forEach(el => el.style.visibility = "hidden");
    for (const row of BANNER) { banner.textContent += (banner.textContent ? "\n" : "") + row; await wait(110); }
    await wait(250);
    const art = hero.querySelector(".art");
    if (art) art.classList.add("on");
    const typed = hero.querySelector(".typed");
    await typeInto(typed, T().welcome, 38);
    typed.classList.add("done");
    await wait(300);
    for (const el of later) { el.style.visibility = ""; reveal(el, 90); await wait(500); }
    booting = false;
  }
  inputRow.hidden = false;
  const start = decodeURIComponent(location.hash.slice(1));
  if (start) run(start.replace(/-/g, " "));
  if (window.matchMedia("(pointer: fine)").matches) input.focus({ preventScroll: true });
}

/* ================= start ================= */
(async () => {
  let site;
  try {
    [site, HEAD3D] = await Promise.all([loadSite(), loadPortrait()]);
  } catch (e) {
    out.innerHTML = `<p class="pink">Could not load the site content (content.json).</p><p class="muted">${esc(e.message)}</p>`;
    return;
  }
  prepare(site);
  enterHint.textContent = T().pressEnter;
  if (PREVIEW) {
    // the admin panel writes the draft to localStorage; every open preview reloads itself
    window.addEventListener("storage", e => {
      if (e.key !== PREVIEW_KEY) return;
      const hash = lastCmd ? "#" + encodeURIComponent(lastCmd.replace(/\s+/g, "-")) : "";
      history.replaceState(null, "", location.pathname + "?preview" + hash);
      location.reload();
    });
    if (window.top === window) document.body.insertAdjacentHTML("beforeend", '<div class="preview-flag">PREVIEW · DRAFT</div>');
  }
  await boot();
  // #command links (and the admin preview) can switch screens without reloading
  window.addEventListener("hashchange", () => {
    const cmd = decodeURIComponent(location.hash.slice(1)).replace(/-/g, " ").trim();
    if (!cmd || cmd === "home") { lastCmd = ""; goHome(); return; }
    out.innerHTML = "";
    run(cmd, { silent: true });
    window.scrollTo({ top: 0, behavior: "auto" });
  });
})();
