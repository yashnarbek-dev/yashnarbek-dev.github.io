/* ============================================================
   Admin panel for the portfolio.
   Edits content.json (every text, link, color and feature of the
   site) and publishes it to GitHub with a personal access token.
   ============================================================ */
"use strict";

const DRAFT_KEY = "yg-admin-draft", PREVIEW_KEY = "yg-preview", AUTH_KEY = "yg-admin-auth", PREF_KEY = "yg-admin-prefs";
const FALLBACK_REPO = { owner: "yashnarbek-dev", repo: "yashnarbek-dev.github.io", branch: "main" };
// admin password: only a PBKDF2 hash is stored (content.json "admin" can replace it; same default as app.js)
const DEFAULT_LOCK = { iter: 300000, salt: "107d09878cd512533ef660743aa9b8fa", hash: "cc7286a669ad61676e61a9801dab0c4b50ff873d704d22402038f7a36a312f8f" };
const UNLOCK_KEY = "yg-admin-unlock";
async function pbkdf2Hex(pw, saltHex, iter) {
  const salt = new Uint8Array(saltHex.match(/../g).map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const randomHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
const validLock = l => l && typeof l === "object" && /^[0-9a-f]{16,}$/.test(l.salt || "") && /^[0-9a-f]{64}$/.test(l.hash || "") ? l : null;
let publishedLock = DEFAULT_LOCK;

const $ = id => document.getElementById(id);
const clone = v => JSON.parse(JSON.stringify(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || sessionStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {} },
};

let state = null;        // the content being edited (content.json)
let base = "";           // JSON of the last loaded / published content
let baseSha = null;      // blob sha of content.json on GitHub when it was loaded
let pending = {};        // files waiting to be published: repo path -> { b64, type, size }
let recent = {};         // files published in this session (kept for the preview)
let auth = null;         // { token, owner, repo, branch, user }
let editLang = "en";
let current = "profile";
let openTarget = null;   // path to reveal after rendering (search results)
let changedIds = new Set();
const prefs = Object.assign({ preview: true, follow: true, mobile: false }, store.get(PREF_KEY) || {});
const savePrefs = () => store.set(PREF_KEY, prefs);

/* ================= DOM helpers ================= */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (["value", "checked", "open", "disabled", "selected", "hidden"].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const ICONS = {
  up: '<path d="m18 15-6-6-6 6"/>', down: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  dup: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  chev: '<path d="m9 6 6 6-6 6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>', copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
};
function icon(n, cls) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  s.innerHTML = ICONS[n];
  return s;
}
const ibtn = (n, label, onclick, cls, disabled) => h("button", { type: "button", class: "icon-btn" + (cls ? " " + cls : ""), title: label, "aria-label": label, onclick, disabled }, icon(n));
const btn = (label, onclick, cls, ic) => h("button", { type: "button", class: "btn " + (cls || ""), onclick }, ic ? icon(ic) : null, label);

function fit(t) {
  if (!t.isConnected || !t.offsetParent) return;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight + 2, 560) + "px";
}
const fitAll = root => requestAnimationFrame(() => root.querySelectorAll("textarea").forEach(fit));
document.addEventListener("toggle", e => { if (e.target.tagName === "DETAILS") fitAll(e.target); }, true);

function toast(msg, kind, ms = 4200) {
  const t = h("div", { class: "toast" + (kind ? " " + kind : ""), role: kind === "err" ? "alert" : "status" }, msg);
  $("toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

function dialog(title, body, buttons, opts = {}) {
  return new Promise(res => {
    const d = $("dlg");
    const acts = h("div", { class: "acts" }, buttons.map(b => h("button", { class: "btn " + (b.kind || ""), type: "button", onclick: () => { res(b.value); d.close(); } }, b.label)));
    d.replaceChildren(h("div", { class: "dlg" }, h("h3", null, title), h("div", { class: "body" }, body), acts));
    d.onclose = () => res(null);
    d.showModal();
    if (opts.focus) opts.focus.focus();
  });
}

/* ================= state ================= */
const get = (p, o = state) => p.reduce((a, k) => (a == null ? undefined : a[k]), o);
function set(p, v) {
  let o = state;
  for (let i = 0; i < p.length - 1; i++) {
    if (o[p[i]] == null || typeof o[p[i]] !== "object") o[p[i]] = typeof p[i + 1] === "number" ? [] : {};
    o = o[p[i]];
  }
  const k = p[p.length - 1];
  if (v === undefined && !Array.isArray(o)) delete o[k]; else o[k] = v === undefined ? "" : v;
  changed();
}
const langs = () => Object.keys(state.i18n);
const defLang = () => (state.i18n[state.site.defaultLang] ? state.site.defaultLang : langs()[0]);
const LP = (...k) => ["i18n", editLang, ...k];
const trv = (m, l = editLang) => (m && typeof m === "object" ? m[l] || m[defLang()] || Object.values(m).find(Boolean) || "" : m || "");
const norm = s => String(s || "").trim().toLowerCase();

function normalize(c) {
  c = c && typeof c === "object" && !Array.isArray(c) ? c : {};
  const need = (k, d) => { if (!c[k] || typeof c[k] !== "object" || Array.isArray(c[k]) !== Array.isArray(d)) c[k] = d; };
  for (const k of ["meta", "site", "profile", "theme", "features", "home", "boot", "photo", "commands", "i18n"]) need(k, {});
  for (const k of ["projects", "tracks", "chess", "custom"]) need(k, []);
  if (!Object.keys(c.i18n).length) c.i18n.en = { label: "English" };
  if (!Array.isArray(c.profile.links)) c.profile.links = [];
  for (const k of ["main", "contacts", "extras", "all", "next", "disabled"]) if (!Array.isArray(c.commands[k])) c.commands[k] = [];
  if (!c.commands.aliases || typeof c.commands.aliases !== "object" || Array.isArray(c.commands.aliases)) c.commands.aliases = {};
  if (!Array.isArray(c.home.banner)) c.home.banner = [];
  if (!Array.isArray(c.boot.steps)) c.boot.steps = [];
  if (!c.site.defaultLang || !c.i18n[c.site.defaultLang]) c.site.defaultLang = Object.keys(c.i18n)[0];
  return c;
}

/* ================= change tracking, draft, undo ================= */
let changeTimer = 0, histTimer = 0, draftWarned = false;
const hist = { stack: [], i: -1 };
function changed() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(afterChange, 220);
}
function afterChange(skipHistory) {
  const s = JSON.stringify(state);
  const ok = store.set(DRAFT_KEY, { content: state, pending, baseSha, savedAt: Date.now() });
  if (!ok && Object.keys(pending).length && !draftWarned) {
    draftWarned = true;
    toast("Your uploaded files are too big to keep in the browser's draft. Publish before closing this tab.", "err", 8000);
  }
  updateDirty(s);
  writePreview();
  if (!skipHistory) { clearTimeout(histTimer); histTimer = setTimeout(() => pushHistory(JSON.stringify(state)), 500); }
}
function pushHistory(s) {
  if (hist.stack[hist.i] === s) return;
  hist.stack = hist.stack.slice(0, hist.i + 1);
  hist.stack.push(s);
  if (hist.stack.length > 200) hist.stack.shift();
  hist.i = hist.stack.length - 1;
  updateUndo();
}
function updateUndo() { $("undo-btn").disabled = hist.i <= 0; $("redo-btn").disabled = hist.i >= hist.stack.length - 1; }
function restoreSnapshot(s) { state = normalize(JSON.parse(s)); if (!state.i18n[editLang]) editLang = defLang(); renderAll(); afterChange(true); updateUndo(); }
function undo() { if (hist.i > 0) { hist.i--; restoreSnapshot(hist.stack[hist.i]); toast("Undone"); } }
function redo() { if (hist.i < hist.stack.length - 1) { hist.i++; restoreSnapshot(hist.stack[hist.i]); toast("Redone"); } }

function diffPaths(a, b, p = [], out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b) && (!Array.isArray(a) || a.length === b.length)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], [...p, Array.isArray(a) ? +k : k], out);
  } else out.push(p);
  return out;
}
function updateDirty(s = JSON.stringify(state)) {
  const files = Object.keys(pending).length;
  const dirty = s !== base || files > 0;
  changedIds = new Set(dirty ? diffPaths(JSON.parse(base), state).filter(p => p[0] !== "meta").map(sectionFor) : []);
  if (files) changedIds.add("files");
  if (!publishing) setStatus(dirty ? "dirty" : "", dirty ? "Unpublished changes" : "All changes published");
  document.querySelectorAll("#side button[data-id]").forEach(b => {
    const m = b.querySelector(".mark");
    if (changedIds.has(b.dataset.id) && !m) b.append(h("span", { class: "mark", title: "Unpublished changes" }));
    else if (!changedIds.has(b.dataset.id) && m) m.remove();
  });
}
let publishing = false;
function setStatus(kind, text) {
  $("status").className = "status " + (kind || "");
  $("status-text").textContent = text;
}

/* ================= files ================= */
const blobUrls = {};
const stripQ = u => String(u || "").split(/[?#]/)[0];
const isLocal = u => !!u && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(u);
const safeName = n => String(n).normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^[_.]+|_+$/g, "") || "file";
const versioned = p => p + "?v=" + Date.now().toString(36);
const fmtSize = n => n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB";
const utf8ToB64 = s => { const b = new TextEncoder().encode(s); let bin = ""; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); };
const b64ToUtf8 = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), ch => ch.charCodeAt(0)));
const b64ToBlob = (b, type) => new Blob([Uint8Array.from(atob(b), ch => ch.charCodeAt(0))], { type });
const fileToB64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(new Error("Could not read " + f.name)); r.readAsDataURL(f); });
function blobUrl(p) {
  const f = pending[p] || recent[p];
  if (!f) return null;
  return blobUrls[p] || (blobUrls[p] = URL.createObjectURL(b64ToBlob(f.b64, f.type)));
}
const displayUrl = v => blobUrl(stripQ(v)) || v;
function addPending(path, data) {
  if (blobUrls[path]) { URL.revokeObjectURL(blobUrls[path]); delete blobUrls[path]; }
  pending[path] = { b64: data.b64, type: data.type || "application/octet-stream", size: Math.round(data.b64.length * 3 / 4) };
  changed();
}
// where an upload goes: replace the current file if it has the same name, otherwise put it next to it
function uploadPath(current, fileName, dir = "assets") {
  const cur = stripQ(current), name = safeName(fileName);
  if (isLocal(cur)) {
    const i = cur.lastIndexOf("/");
    const curDir = i >= 0 ? cur.slice(0, i) : "", curName = cur.slice(i + 1);
    if (curName.toLowerCase() === name.toLowerCase()) return cur;
    return (curDir ? curDir + "/" : "") + name;
  }
  return `${dir}/${name}`;
}
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file isn't an image this browser can read.")); i.src = url; });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function encodeJpeg(img, w, h, sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight, q = 0.86) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return { b64: c.toDataURL("image/jpeg", q).split(",")[1], type: "image/jpeg" };
}
async function photoFromFile(file) {   // crop to 3:4, 600x800
  const img = await loadImage(file);
  const W = 600, H = 800, r = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  const sw = W / r, sh = H / r;
  return encodeJpeg(img, W, H, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh);
}
async function imageFromFile(file) {   // keep small files as they are, shrink big ones
  if (/svg|gif/.test(file.type) || file.size < 450e3) return { b64: await fileToB64(file), type: file.type, name: file.name };
  const img = await loadImage(file);
  const r = Math.min(1, 1600 / img.naturalWidth);
  const out = encodeJpeg(img, Math.round(img.naturalWidth * r), Math.round(img.naturalHeight * r));
  return { ...out, name: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
}
function pickFile(accept) {
  return new Promise(res => {
    const i = h("input", { type: "file", accept, style: "position:fixed;left:-9999px" });
    i.addEventListener("change", () => { res(i.files[0] || null); i.remove(); });
    document.body.append(i);
    i.click();
  });
}

/* ================= preview ================= */
let previewTimer = 0;
function previewJSON() {
  let s = JSON.stringify(state);
  for (const p of new Set([...Object.keys(pending), ...Object.keys(recent)])) {
    const url = blobUrl(p);
    if (url) s = s.replace(new RegExp(`(?<=["(\\s])${escRe(p)}(\\?v=\\w+)?(?=["')\\s\\\\])`, "g"), url);
  }
  return s;
}
function writePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    try { localStorage.setItem(PREVIEW_KEY, previewJSON()); }
    catch (e) { toast("Preview couldn't update (browser storage is full).", "err"); }
  }, 150);
}
function previewUrl(cmd, boot) {
  return "index.html?preview" + (boot ? "&boot" : "") + (cmd ? "#" + encodeURIComponent(cmd.trim().replace(/\s+/g, "-")) : "");
}
function showPreview(cmd, boot) {
  $("pv-cmd").value = cmd || "";
  const f = $("pv-frame");
  const url = previewUrl(cmd, boot);
  try {
    const w = f.contentWindow, loc = w && w.location;
    if (!boot && loc && loc.pathname.endsWith("index.html") && loc.search === "?preview") {
      const hash = cmd ? url.split("#")[1] : "home";
      if (loc.hash.slice(1) === hash) w.dispatchEvent(new HashChangeEvent("hashchange"));
      else loc.hash = hash;
      return;
    }
  } catch (e) {}
  f.src = url;
}
function reloadPreview() { try { $("pv-frame").contentWindow.location.reload(); } catch (e) {} }
function renderPreviewOptions() {
  const sel = $("pv-cmd"), keep = sel.value;
  const names = ["", "help", "about", "projects", "teaching", "achievements", "skills", "miscellaneous", "mathbook", "neofetch", "music", "chess", "resume", "contact", "whoami", "sudo",
    ...state.custom.map(c => norm(c.name)).filter(Boolean)];
  sel.replaceChildren(...[...new Set(names)].map(n => h("option", { value: n }, n || "home")));
  sel.value = keep;
}
function followPreview() {
  if (!prefs.follow) return;
  const s = SECTIONS.find(x => x.id && x.id === current);
  if (s && s.preview !== undefined) showPreview(s.preview);
}

/* ================= form controls ================= */
let uid = 0;
function control(type, value, onValue, o = {}) {
  const id = "f" + (++uid);
  if (type === "area") {
    const t = h("textarea", { id, rows: o.rows || 2, class: o.mono ? "mono" : null, placeholder: o.ph || "", spellcheck: o.mono ? "false" : null });
    t.value = value == null ? "" : value;
    t.addEventListener("input", () => { onValue(t.value); fit(t); });
    return t;
  }
  if (type === "select") {
    const s = h("select", { id }, (o.options || []).map(([v, l]) => h("option", { value: v }, l)));
    s.value = value == null ? (o.options[0] || [""])[0] : value;
    s.addEventListener("change", () => onValue(s.value));
    return s;
  }
  if (type === "color") {
    const ok = v => /^#[0-9a-f]{6}$/i.test(v || "");
    const pick = h("input", { type: "color", value: ok(value) ? value : "#000000", "aria-label": (o.label || "Color") + " picker" });
    const txt = h("input", { id, type: "text", class: "mono", value: value || "", placeholder: "#000000", maxlength: 7, spellcheck: "false" });
    pick.addEventListener("input", () => { txt.value = pick.value; onValue(pick.value); });
    txt.addEventListener("input", () => { if (ok(txt.value)) pick.value = txt.value; onValue(txt.value); });
    return h("div", { class: "color" }, pick, txt);
  }
  const i = h("input", { id, type: type === "number" ? "number" : type === "email" ? "email" : "text", class: o.mono ? "mono" : null, placeholder: o.ph || "",
    spellcheck: o.mono ? "false" : null, inputmode: type === "url" ? "url" : null, list: o.list || null, min: o.min, max: o.max });
  i.value = value == null ? "" : value;
  i.addEventListener("input", () => onValue(type === "number" ? (i.value === "" ? "" : Number(i.value)) : i.value));
  return i;
}

const chip = () => langs().length > 1 ? h("span", { class: "chip", title: "Translated: you're editing " + editLang.toUpperCase() }, editLang.toUpperCase()) : null;

function field(o) {
  const type = o.type || "text";
  if (type === "check") return toggle(o);
  const v = o.value !== undefined ? o.value : get(o.path);
  let ph = o.ph;
  if (o.fallback) { const fv = get(o.fallback); if (fv && typeof fv === "string") ph = fv; }
  const onValue = val => {
    if (o.onValue) o.onValue(val);
    else set(o.path, o.clearEmpty && val === "" ? undefined : val);
    if (o.onChange) o.onChange(val);
  };
  const ctl = control(type, v, onValue, { ...o, ph });
  return h(type === "color" ? "div" : "label", { class: "field" + (o.wide || type === "area" && o.wide !== false ? " wide" : ""), "data-path": o.path ? o.path.join(".") : null },
    h("span", { class: "flabel" }, o.label, o.i18n ? chip() : null),
    ctl,
    o.help ? h("span", { class: "help", html: o.help }) : null);
}
function toggle(o) {
  const cur = o.get ? o.get() : get(o.path);
  const inp = h("input", { type: "checkbox", checked: cur === undefined ? o.def !== false : !!cur });
  inp.addEventListener("change", () => { if (o.set) o.set(inp.checked); else set(o.path, inp.checked); if (o.onChange) o.onChange(inp.checked); });
  return h("div", { class: "field" + (o.wide ? " wide" : ""), "data-path": o.path ? o.path.join(".") : null },
    h("label", { class: "toggle" }, inp, h("span", { class: "sw" }), h("span", { class: "tt" }, h("b", null, o.label), o.help ? h("span", { class: "help", html: o.help }) : null)));
}
// a text in the language being edited: i18n.<lang>.<key...>
function lf(label, key, o = {}) {
  const k = Array.isArray(key) ? key : [key], d = defLang();
  return field({ label, path: LP(...k), fallback: editLang !== d ? ["i18n", d, ...k] : null, i18n: true, ...o });
}
// a translated value stored on an item: { en: "...", uz: "..." }
function mf(label, basePath, o = {}) {
  const d = defLang();
  return field({ label, path: [...basePath, editLang], fallback: editLang !== d ? [...basePath, d] : null, i18n: true, clearEmpty: editLang !== d, ...o });
}
const group = (title, desc, ...kids) => h("div", { class: "group" }, h("h2", null, title), desc ? h("p", { class: "gdesc", html: desc }) : null, ...kids);
const fields = (...kids) => h("div", { class: "fields" }, ...kids);
const fields1 = (...kids) => h("div", { class: "fields one" }, ...kids);
const fields3 = (...kids) => h("div", { class: "fields three" }, ...kids);

// editable list of rows (strings, tuples or objects)
function list(o) {
  const box = h("div", { class: "list" });
  const cols = o.single ? [{ type: o.type || "text", ph: o.ph, mono: o.mono, list: o.list, rows: o.rows }] : o.cols;
  const tmpl = cols.map(c => c.fr || "minmax(0, 1fr)").join(" ");
  const cellPath = (i, c, j) => c.key != null ? [...o.path, i, c.key] : o.single ? [...o.path, i] : [...o.path, i, j];
  const blank = () => o.add ? o.add() : o.single ? "" : cols.map(() => "");
  function render(focusLast) {
    const arr = get(o.path), kids = [];
    if (!Array.isArray(arr) && o.fallback && Array.isArray(get(o.fallback))) {
      kids.push(h("div", { class: "fallback" }, `This language shows the ${defLang().toUpperCase()} list.`,
        btn("Copy it here to translate", () => { set(o.path, clone(get(o.fallback))); render(); }, "small")));
      return box.replaceChildren(...kids);
    }
    const a = Array.isArray(arr) ? arr : [];
    if (!o.single && a.length && cols.some(c => c.label)) kids.push(h("div", { class: "list-head", style: `grid-template-columns:${tmpl}` }, cols.map(c => h("span", null, c.label))));
    if (!a.length) kids.push(h("div", { class: "empty" }, o.emptyText || "Nothing here yet."));
    a.forEach((item, i) => {
      const cells = cols.map((c, j) => {
        const p = cellPath(i, c, j);
        const el = control(c.type || "text", get(p), v => set(p, v), { ph: c.ph, mono: c.mono, rows: c.rows || 1, list: c.list });
        el.setAttribute("aria-label", `${c.label || o.itemName || "item"} ${i + 1}`);
        return h("div", { class: "cell", "data-path": p.join(".") }, el);
      });
      kids.push(h("div", { class: "lrow", style: `--cols:${tmpl}` }, h("span", { class: "idx" }, i + 1), cells, h("div", { class: "ctl" },
        ibtn("up", "Move up", () => move(i, -1), null, i === 0),
        ibtn("down", "Move down", () => move(i, 1), null, i === a.length - 1),
        ibtn("trash", "Delete", () => del(i), "del"))));
    });
    kids.push(h("button", { type: "button", class: "btn small add", onclick: () => {
      const a2 = Array.isArray(get(o.path)) ? get(o.path) : [];
      a2.push(blank()); set(o.path, a2); render(true);
    } }, icon("plus"), "Add " + (o.itemName || "row")));
    box.replaceChildren(...kids);
    fitAll(box);
    if (focusLast) requestAnimationFrame(() => { const r = box.querySelectorAll(".lrow"); const el = r[r.length - 1] && r[r.length - 1].querySelector("input, textarea"); if (el) el.focus(); });
  }
  const move = (i, d) => { const a = get(o.path); [a[i], a[i + d]] = [a[i + d], a[i]]; set(o.path, a); render(); };
  const del = i => { const a = get(o.path); a.splice(i, 1); set(o.path, a); render(); if (o.onDelete) o.onDelete(); };
  render();
  return box;
}

// collapsible cards for lists of objects (projects, chess accounts, custom commands)
function cards(o) {
  const box = h("div", { class: "cards" });
  let open = new Set();
  function render(scrollTo) {
    const a = get(o.path) || [];
    const kids = a.map((item, i) => {
      const p = [...o.path, i];
      const t = h("span", { class: "ct" }), s = h("span", { class: "cs" });
      const upd = () => { const it = get(p); t.textContent = (it && o.title(it, i)) || `${o.itemName} ${i + 1}`; s.textContent = it && o.sub ? o.sub(it, i) || "" : ""; };
      upd();
      const body = h("div", { class: "body" });
      const isOpen = open.has(i) || (openTarget && openTarget.length > p.length && p.every((k, j) => String(openTarget[j]) === String(k)));
      const d = h("details", { class: "card", open: isOpen, "data-path": p.join(".") },
        h("summary", null, icon("chev", "chev"), t, s, h("span", { class: "ctl", onclick: e => e.preventDefault() },
          ibtn("up", "Move up", () => move(i, -1), null, i === 0),
          ibtn("down", "Move down", () => move(i, 1), null, i === a.length - 1),
          ibtn("dup", "Duplicate", () => dup(i)),
          ibtn("trash", "Delete", () => del(i), "del"))),
        body);
      let built = false;
      const build = () => { if (built) return; built = true; body.append(...[].concat(o.body(p, get(p), i))); fitAll(body); };
      if (isOpen) { open.add(i); build(); }
      d.addEventListener("toggle", () => { if (d.open) { open.add(i); build(); } else open.delete(i); });
      body.addEventListener("input", upd); body.addEventListener("change", upd);
      return d;
    });
    if (!a.length) kids.push(h("div", { class: "empty" }, o.emptyText || `No ${o.itemName}s yet.`));
    kids.push(h("button", { type: "button", class: "btn small add", onclick: () => {
      const a2 = get(o.path) || [];
      a2.push(o.add()); open.add(a2.length - 1); set(o.path, a2); render(a2.length - 1); if (o.onAdd) o.onAdd();
    } }, icon("plus"), "Add " + o.itemName));
    box.replaceChildren(...kids);
    if (scrollTo != null) requestAnimationFrame(() => { const el = box.children[scrollTo]; if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); const f = el.querySelector(".body input, .body textarea"); if (f) f.focus({ preventScroll: true }); } });
  }
  const swapOpen = (i, j) => { const n = new Set(); open.forEach(k => n.add(k === i ? j : k === j ? i : k)); open = n; };
  const move = (i, d) => { const a = get(o.path); [a[i], a[i + d]] = [a[i + d], a[i]]; swapOpen(i, i + d); set(o.path, a); render(); };
  const dup = i => { const a = get(o.path); const c = clone(a[i]); if (o.onDuplicate) o.onDuplicate(c); a.splice(i + 1, 0, c); open = new Set([...open].map(k => k > i ? k + 1 : k)); open.add(i + 1); set(o.path, a); render(i + 1); };
  const del = async i => {
    const a = get(o.path);
    const ok = await dialog(`Delete this ${o.itemName}?`, `“${o.title(a[i], i) || o.itemName}” will be removed. You can undo with Ctrl+Z.`, [{ label: "Cancel", value: false }, { label: "Delete", kind: "danger", value: true }]);
    if (!ok) return;
    const removed = a.splice(i, 1)[0];
    open = new Set([...open].filter(k => k !== i).map(k => k > i ? k - 1 : k));
    set(o.path, a); render();
    if (o.onDelete) o.onDelete(removed);
  };
  render();
  return box;
}

function imagePicker(o) {
  const wrap = h("div", { class: "media", "data-path": o.path.join(".") });
  function render() {
    const v = get(o.path) || "";
    const src = displayUrl(v);
    const isPending = !!pending[stripQ(v)];
    wrap.replaceChildren(
      h("div", { class: "thumb" + (o.wide ? " wide" : ""), style: src ? `background-image:url("${String(src).replace(/"/g, "%22")}")` : "" }),
      h("div", { class: "acts" },
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" },
          btn(v ? "Replace image" : "Upload image", () => upload(), "small", "upload"),
          v && o.removable ? btn("Remove", () => { set(o.path, ""); render(); }, "small ghost") : null,
          isPending ? h("span", { class: "pill" }, "not published yet") : null),
        field({ label: o.urlLabel || "Image file or URL", path: o.path, mono: true, onChange: () => { clearTimeout(wrap.t); wrap.t = setTimeout(render, 700); } }),
        o.help ? h("span", { class: "help", html: o.help }) : null));
  }
  async function upload() {
    const f = await pickFile("image/*");
    if (!f) return;
    try {
      if (o.mode === "photo") {
        const data = await photoFromFile(f);
        const cur = stripQ(state.photo.src);
        const path = isLocal(cur) && /\.jpe?g$/i.test(cur) ? cur : "assets/photo.jpg";
        addPending(path, data);
        state.photo.size = "600x800"; state.photo.type = "JPEG";
        state.photo.fileName = safeName(f.name.replace(/\.[^.]+$/, "")) + ".jpg";
        set(o.path, versioned(path));
        renderSection();
      } else {
        const data = await imageFromFile(f);
        const path = uploadPath(get(o.path), data.name, o.dir || "assets");
        addPending(path, data);
        set(o.path, versioned(path));
        render();
      }
      toast("Image added. It goes online when you publish.", "ok");
    } catch (e) { toast(e.message, "err"); }
  }
  render();
  return wrap;
}

function filePicker(o) {
  const wrap = h("div", { class: "fields one", "data-path": o.path.join(".") });
  function render() {
    const v = get(o.path) || "";
    wrap.replaceChildren(
      field({ label: o.label, path: o.path, mono: true, help: o.help }),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" },
        btn(v ? "Upload a new file" : "Upload file", upload, "small", "upload"),
        v ? h("a", { class: "btn small ghost", href: displayUrl(v), target: "_blank", rel: "noopener" }, icon("ext"), "Open current") : null,
        pending[stripQ(v)] ? h("span", { class: "pill" }, "not published yet") : null));
  }
  async function upload() {
    const f = await pickFile(o.accept || "");
    if (!f) return;
    if (f.size > 25e6) return toast("That file is bigger than 25 MB.", "err");
    const path = uploadPath(get(o.path), f.name, o.dir || "assets");
    addPending(path, { b64: await fileToB64(f), type: f.type });
    set(o.path, versioned(path));
    render();
    toast(`${f.name} added. It goes online when you publish.`, "ok");
  }
  render();
  return wrap;
}

/* ================= commands ================= */
const BUILTIN = {
  help: "list of commands", about: "your story card", whoami: "visitor joke", projects: "project cards", teaching: "teaching history",
  achievements: "results and awards", skills: "skills table", miscellaneous: "extra facts", mathbook: "math book details", music: "playlist",
  play: "play <n> opens a song", chess: "chess.com ratings", resume: "resume card", contact: "all contacts", email: "email", github: "GitHub",
  telegram: "Telegram", linkedin: "LinkedIn", lang: "switch language", neofetch: "system info joke", all: "everything at once",
  history: "typed commands", home: "start screen", welcome: "same as home", clear: "clear the screen", ls: "file list joke", pwd: "folder joke",
  sudo: "sudo joke", echo: "repeats the text", admin: "opens this admin panel",
};
const customNames = () => state.custom.map(c => norm(c.name)).filter(Boolean);
const linkNames = () => state.profile.links.map(l => norm(l.cmd)).filter(Boolean);
const allCommands = () => [...new Set([...Object.keys(BUILTIN), ...customNames(), ...linkNames()])];
function updateDatalist() { $("cmd-names").replaceChildren(...allCommands().map(n => h("option", { value: n }))); }
function renameCommand(from, to) {
  if (!from || from === to) return;
  const c = state.commands;
  for (const k of ["main", "contacts"]) c[k].forEach(r => { if (r[0] === from) r[0] = to; });
  for (const k of ["extras", "all", "next", "disabled"]) c[k] = c[k].map(n => n === from ? to : n);
  for (const a of Object.keys(c.aliases)) if (c.aliases[a] === from) c.aliases[a] = to;
  if (state.home.newTarget === from) state.home.newTarget = to;
}

/* ================= sections ================= */
const PRESETS = [
  { name: "Mint (original)", bg: "#000000", fg: "#ffebcd", accent: "#5abb9a", muted: "#b5a68f", pink: "#f4a3b4" },
  { name: "Amber CRT", bg: "#0d0a05", fg: "#ffdcaa", accent: "#ffb000", muted: "#a88d63", pink: "#ff7a59" },
  { name: "Matrix", bg: "#000000", fg: "#c9ffd6", accent: "#00e05a", muted: "#5f9a70", pink: "#e8ff6a" },
  { name: "Ice", bg: "#05080d", fg: "#dbe7f5", accent: "#5aa9ff", muted: "#8494a8", pink: "#ff8fb1" },
  { name: "Rose", bg: "#0c0609", fg: "#ffe4ec", accent: "#ff6f9c", muted: "#b08896", pink: "#ffd166" },
  { name: "Paper (light)", bg: "#f6f1e7", fg: "#1d1b17", accent: "#127a5a", muted: "#6f6656", pink: "#c2366b" },
];

const SECTIONS = [
  { group: "Basics" },
  { id: "profile", title: "Profile & contacts", preview: "contact", keywords: "name email github telegram linkedin links instagram copy",
    desc: "Your name and the ways visitors can reach you.", render: () => [
      group("Name", null, fields(field({ label: "Full name", path: ["profile", "name"], help: "Shown on the About card, the resume card and image descriptions." }))),
      group("Contacts", "Leave a field empty to hide that contact everywhere.", fields(
        field({ label: "Email", path: ["profile", "email"], type: "email" }),
        field({ label: "GitHub username", path: ["profile", "github"], mono: true, help: "Also used to build the project repository links." }),
        field({ label: "Telegram username", path: ["profile", "telegram"], mono: true, help: "Without the @." }),
        field({ label: "LinkedIn URL", path: ["profile", "linkedin"], type: "url", ph: "https://www.linkedin.com/in/…" }),
      )),
      group("More links", "Each link becomes a command visitors can type (for example <code>instagram</code>) and shows up under “Contact Me”.",
        list({ path: ["profile", "links"], itemName: "link", onDelete: updateDatalist, cols: [
          { key: "cmd", label: "Command", ph: "instagram", mono: true, fr: "minmax(0, .8fr)" },
          { key: "alias", label: "Short name", ph: "ig", mono: true, fr: "minmax(0, .5fr)" },
          { key: "text", label: "Link text", ph: "@yourname", fr: "minmax(0, 1fr)" },
          { key: "url", label: "URL", ph: "https://…", mono: true, fr: "minmax(0, 1.4fr)" }],
          add: () => ({ cmd: "", alias: "", text: "", url: "" }) })),
      group("Copy button", "The button next to your email address.", fields3(lf("Button", ["copy", 0]), lf("After copying", ["copy", 1]), lf("If copying fails", ["copy", 2]))),
    ] },
  { id: "site", title: "Site & SEO", preview: "", keywords: "title description seo google prompt tab",
    desc: "What browsers, search engines and link previews show.", render: () => [
      group("Browser tab and search results", null, fields1(
        field({ label: "Page title", path: ["site", "title"] }),
        field({ label: "Description", path: ["site", "description"], type: "area", rows: 3, help: "Shown by Google and in link previews." }))),
      group("Terminal prompt", null, fields(field({ label: "Prompt name", path: ["site", "promptUser"], mono: true, help: "Shown before <code>:~$</code> on every command line." }))),
    ] },
  { id: "theme", title: "Theme", preview: "", keywords: "color colour font size css background accent dark light",
    desc: "Colors and text size. Borders, glows and the portrait's colors follow the accent automatically.", render: () => [
      group("Presets", null, h("div", { class: "presets" }, PRESETS.map(p => h("button", { type: "button", class: "preset", onclick: () => {
        for (const k of ["bg", "fg", "accent", "muted", "pink"]) state.theme[k] = p[k];
        changed(); renderSection(); toast(`${p.name} applied`);
      } }, h("span", { class: "sw3" }, [p.bg, p.fg, p.accent, p.pink].map(c => h("i", { style: `background:${c}` }))), p.name)))),
      group("Colors", null, fields(
        field({ label: "Background", path: ["theme", "bg"], type: "color" }),
        field({ label: "Text", path: ["theme", "fg"], type: "color" }),
        field({ label: "Accent", path: ["theme", "accent"], type: "color", help: "Commands, links, headings and card borders." }),
        field({ label: "Muted text", path: ["theme", "muted"], type: "color" }),
        field({ label: "Highlight", path: ["theme", "pink"], type: "color", help: "The “NEW” tag." }),
      )),
      group("Text and portrait", null, fields(
        field({ label: "Text size (px)", path: ["theme", "fontSize"], type: "number", min: 10, max: 32, help: "On desktop. Tablets and phones scale it down." }),
        toggle({ label: "Tint the portrait with the accent color", path: ["theme", "tintPortrait"], def: true }))),
      group("Custom CSS", "Advanced: extra CSS added to the page after everything else.", fields1(
        field({ label: "CSS", path: ["theme", "customCss"], type: "area", rows: 6, mono: true, ph: ".card { border-radius: 4px; }" }))),
    ] },
  { id: "features", title: "Features", preview: "", keywords: "toggle enable disable animation boot portrait photo chess live language switcher",
    desc: "Turn parts of the site on or off. To turn single commands on or off, use Commands & menu.", render: () => [
      group("Animations", null, fields1(
        field({ label: "Boot animation", path: ["features", "boot"], type: "select", options: [["session", "Once per visit"], ["always", "Every time the page loads"], ["never", "Never"]] }),
        toggle({ label: "Matrix decoding animation on the photo", path: ["features", "photoScan"] }))),
      group("Parts of the site", null, fields1(
        toggle({ label: "3D ASCII portrait on the home screen", path: ["features", "portrait"] }),
        toggle({ label: "Photo on the About card", path: ["features", "photo"] }),
        toggle({ label: "“NEW” announcement line on the home screen", path: ["features", "newLine"] }),
        toggle({ label: "Language buttons on the home screen", path: ["features", "langSwitcher"], help: "Visitors can still type <code>lang uz</code>." }),
        toggle({ label: "Load live ratings from chess.com", path: ["features", "chessLive"], help: "When off, the saved numbers from the Chess section are shown." }))),
    ] },

  { group: "Pages" },
  { id: "home", title: "Home screen", preview: "", keywords: "welcome banner ascii new announcement headings portrait hint",
    desc: "The first screen visitors see.", render: () => [
      group("ASCII banner", "Shown line by line at the top. Leave empty for no banner.", fields(
        field({ label: "Banner", path: ["home", "banner"], type: "area", mono: true, rows: 7, wide: true, value: state.home.banner.join("\n"), onValue: v => set(["home", "banner"], v.replace(/\r/g, "").split("\n").filter((l, i, a) => l || i < a.length - 1)) }),
        field({ label: "Banner name for screen readers", path: ["home", "bannerLabel"], ph: "YG" }))),
      group("Welcome", null, fields1(lf("Welcome line (typed out)", "welcome"))),
      group("Help hint", "Shown as: <i>[before]</i> <code>'help'</code> <i>[after]</i>", fields(lf("Before 'help'", ["typeHelp", 0]), lf("After 'help'", ["typeHelp", 1]))),
      group("“NEW” line", null, fields(
        lf("Tag", "newTag"), lf("Button text", "seeIt"),
        lf("Announcement", "newLine", { wide: true }),
        field({ label: "Button opens command", path: ["home", "newTarget"], mono: true, list: "cmd-names" }))),
      group("Headings", null, fields(lf("Commands heading", "avail"), lf("Contacts heading", "contactMe"), lf("Extras heading (help screen)", "extras"), lf("Language label", "language"))),
      group("Portrait", null, fields(lf("Hint under the portrait", "hint"),
        field({ label: "Portrait description (screen readers)", path: ["site", "portraitAlt"], help: "<code>{name}</code> = your name." }))),
    ] },
  { id: "about", title: "About (story)", preview: "about", keywords: "story beats tag photo picture image scan whoami next",
    desc: "The card shown by the <code>about</code> command.", render: () => [
      group("Tagline", null, fields1(lf("Line under your name", "tag"))),
      group("Story lines", null, list({ path: LP("beats"), fallback: ["i18n", defLang(), "beats"], itemName: "line",
        cols: [{ label: "Label", fr: "minmax(0, .35fr)" }, { label: "Text", type: "area", fr: "minmax(0, 1fr)" }] })),
      group("Links under the story", "Commands shown after the arrow, then the “and you?” text with <code>[whoami]</code>.", fields(
        h("div", { class: "field" }, h("span", { class: "flabel" }, "Commands"), list({ path: ["commands", "next"], single: true, mono: true, list: "cmd-names", itemName: "command" })),
        lf("Text before [whoami]", "andYou"))),
      group("Photo", "Uploads are cropped to 3:4 and resized to 600×800. The 3D ASCII portrait on the home screen is made from the original photo and does not change.",
        imagePicker({ path: ["photo", "src"], mode: "photo", urlLabel: "Photo file or URL" }),
        h("div", { style: "height:14px" }),
        fields3(field({ label: "File name label", path: ["photo", "fileName"], mono: true }), field({ label: "Size label", path: ["photo", "size"], mono: true }), field({ label: "Type label", path: ["photo", "type"], mono: true })),
        h("div", { style: "height:14px" }),
        fields(field({ label: "Photo description (screen readers)", path: ["site", "photoAlt"], help: "<code>{name}</code> = your name." }))),
      group("Photo animation text", null, fields(lf("While decoding", ["scan", "decoding"]), lf("When finished", ["scan", "ok"]))),
    ] },
  { id: "projects", title: "Projects", preview: "projects", keywords: "project repo github card badge featured draft demo website",
    desc: "Cards shown by the <code>projects</code> command, in this order.", render: () => [
      cards({ path: ["projects"], itemName: "project",
        title: p => trv(p.name) || p.key, sub: p => trv(p.tech),
        add: () => ({ key: "p" + Date.now().toString(36), name: { [defLang()]: "New project" }, tech: {}, desc: {}, badge: "", featured: false, mutedBadge: false, repo: "", url: "", cmd: "", slug: "", image: "" }),
        onDuplicate: c => { c.key = "p" + Date.now().toString(36); },
        body: p => [
          fields(mf("Name", [...p, "name"]), mf("Tech line", [...p, "tech"], { ph: "Python · Django" })),
          h("div", { style: "height:14px" }),
          fields1(mf("Description", [...p, "desc"], { type: "area", rows: 3 })),
          h("div", { class: "sub-h" }, "Links"),
          fields(
            field({ label: "GitHub repository", path: [...p, "repo"], mono: true, help: "A repo name under your account, or a full URL. Leave empty if there is none." }),
            field({ label: "Website or demo", path: [...p, "url"], type: "url", ph: "https://…", help: "If set, the card opens this instead of GitHub." }),
            field({ label: "Path label", path: [...p, "slug"], mono: true, help: "Shown as <code>~/projects/label</code>. Defaults to the repo name." }),
            field({ label: "Title runs a command", path: [...p, "cmd"], mono: true, list: "cmd-names", help: "Optional. Clicking the title runs it (e.g. <code>mathbook</code>)." })),
          h("div", { class: "sub-h" }, "Badge and look"),
          fields(
            field({ label: "Badge text", path: [...p, "badge"], ph: "featured" }),
            h("div", { class: "fields one", style: "gap:4px" }, toggle({ label: "Highlight the card border", path: [...p, "featured"], def: false }), toggle({ label: "Grey badge (e.g. draft)", path: [...p, "mutedBadge"], def: false }))),
          h("div", { class: "sub-h" }, "Preview image (optional)"),
          imagePicker({ path: [...p, "image"], dir: "assets/projects", wide: true, removable: true, help: "Replaces the little terminal window at the top of the card." }),
        ] }),
      group("Under the projects", null, fields1(lf("Text before your GitHub link", "allCode"))),
    ] },
  { id: "teaching", title: "Teaching", preview: "teaching", keywords: "teaching instructor tutor class students",
    desc: "Entries shown by the <code>teaching</code> command.", render: () => [
      group("Entries", null, list({ path: LP("teaching"), fallback: ["i18n", defLang(), "teaching"], itemName: "entry",
        cols: [{ label: "Title", fr: "minmax(0, .8fr)" }, { label: "Subtitle", fr: "minmax(0, .8fr)", ph: "optional" }, { label: "Text", type: "area", fr: "minmax(0, 1.6fr)" }] })),
    ] },
  { id: "achievements", title: "Achievements", preview: "achievements", keywords: "achievements awards olympiad results ielts",
    render: () => [
      group("Rows", null, list({ path: LP("achievements"), fallback: ["i18n", defLang(), "achievements"], itemName: "row",
        cols: [{ label: "Title", fr: "minmax(0, .5fr)" }, { label: "Details", fr: "minmax(0, 1fr)" }] })),
      group("Olympiad year", null, fields(field({ label: "Year added to the first row", path: ["profile", "olympiadYear"], ph: "2025", help: "Leave empty to show no year." }))),
    ] },
  { id: "skills", title: "Skills", preview: "skills", keywords: "skills programming linux tools languages school",
    render: () => [group("Rows", null, list({ path: LP("skills"), fallback: ["i18n", defLang(), "skills"], itemName: "row",
      cols: [{ label: "Skill", fr: "minmax(0, .5fr)" }, { label: "Details", fr: "minmax(0, 1fr)" }] }))] },
  { id: "misc", title: "Miscellaneous", preview: "miscellaneous", keywords: "misc facts hobbies",
    render: () => [group("Lines", "Each line is shown with a dash in front.", list({ path: LP("misc"), fallback: ["i18n", defLang(), "misc"], single: true, type: "area", itemName: "line" }))] },
  { id: "mathbook", title: "Math book", preview: "mathbook", keywords: "math book series team role",
    render: () => [
      group("Rows", "Leave a row's value empty to show “My role” from below (or hide the row if that is empty too).", list({ path: LP("mathbook"), fallback: ["i18n", defLang(), "mathbook"], itemName: "row",
        cols: [{ label: "Label", fr: "minmax(0, .5fr)" }, { label: "Value", fr: "minmax(0, 1fr)" }] })),
      group("My role", null, fields(field({ label: "Your role in the book", path: ["profile", "mathbookRole"], ph: "wrote the algebra chapters" }))),
    ] },
  { id: "neofetch", title: "Neofetch", preview: "neofetch", keywords: "neofetch os uptime shell joke",
    render: () => [group("Rows", null, list({ path: LP("neofetch"), fallback: ["i18n", defLang(), "neofetch"], itemName: "row",
      cols: [{ label: "Key", fr: "minmax(0, .4fr)" }, { label: "Value", fr: "minmax(0, 1fr)" }] }))] },
  { id: "music", title: "Music", preview: "music", keywords: "music songs tracks playlist youtube spotify play",
    desc: "Your playlist. Links search YouTube and Spotify automatically unless you paste exact links.", render: () => [
      group("Tracks", null, list({ path: ["tracks"], itemName: "track", add: () => ({ song: "", artist: "", youtube: "", spotify: "" }), cols: [
        { key: "song", label: "Song" }, { key: "artist", label: "Artist" },
        { key: "youtube", label: "YouTube link", ph: "auto", mono: true }, { key: "spotify", label: "Spotify link", ph: "auto", mono: true }] })),
      group("Texts", "<code>{n}</code> = number of tracks.", fields(
        lf("Title", ["music", "title"]), lf("Track count", ["music", "count"]),
        lf("Note under the list", ["music", "note"], { wide: true }),
        lf("“play” usage", ["music", "usage"]), lf("“Opening” text", ["music", "opening"]))),
    ] },
  { id: "chess", title: "Chess", preview: "chess", keywords: "chess.com ratings rapid blitz bullet puzzles",
    desc: "chess.com accounts. Live ratings load automatically; the saved numbers are shown if chess.com can't be reached.", render: () => [
      cards({ path: ["chess"], itemName: "account", title: a => a.user, sub: a => a.saved && a.saved.rapid ? `rapid ${a.saved.rapid[0] || "–"}` : "",
        add: () => ({ user: "", saved: { rapid: ["", ""], blitz: ["", ""], bullet: ["", ""], puzzles: "", games: "", joined: "" } }),
        body: p => [
          fields(field({ label: "chess.com username", path: [...p, "user"], mono: true })),
          h("div", { class: "sub-h" }, "Saved numbers"),
          fields3(
            field({ label: "Rapid", path: [...p, "saved", "rapid", 0], type: "number" }), field({ label: "Rapid best", path: [...p, "saved", "rapid", 1], type: "number" }),
            field({ label: "Puzzles", path: [...p, "saved", "puzzles"], type: "number" }),
            field({ label: "Blitz", path: [...p, "saved", "blitz", 0], type: "number" }), field({ label: "Blitz best", path: [...p, "saved", "blitz", 1], type: "number" }),
            field({ label: "Games played", path: [...p, "saved", "games"], type: "number" }),
            field({ label: "Bullet", path: [...p, "saved", "bullet", 0], type: "number" }), field({ label: "Bullet best", path: [...p, "saved", "bullet", 1], type: "number" }),
            field({ label: "Joined", path: [...p, "saved", "joined"], mono: true, ph: "2025-02" })),
        ] }),
      group("Texts", null, fields3(
        lf("rapid", ["chessT", "rapid"]), lf("blitz", ["chessT", "blitz"]), lf("bullet", ["chessT", "bullet"]),
        lf("puzzles", ["chessT", "puzzles"]), lf("best", ["chessT", "best"]), lf("games", ["chessT", "games"]),
        lf("joined", ["chessT", "joined"])),
        h("div", { style: "height:14px" }),
        fields1(lf("While loading", ["chessT", "loading"]), lf("If chess.com can't be reached", ["chessT", "offline"]), lf("Note after loading", ["chessT", "note"]))),
    ] },
  { id: "resume", title: "Resume", preview: "resume", keywords: "resume cv pdf download",
    desc: "The PDF behind the <code>resume</code> command.", render: () => [
      group("File", null, filePicker({ path: ["profile", "resumeUrl"], label: "Resume file or URL", accept: "application/pdf,.pdf", help: "Leave empty to show the “coming soon” text instead." })),
      group("Texts", null, fields(
        lf("Card title (after your name)", "resumeTitle"), lf("“Open” link", ["resumeLinks", 0]), lf("“Download” link", ["resumeLinks", 1]),
        lf("Description", ["resumeLinks", 2], { wide: true }), lf("When there is no file", "resumeSoon", { wide: true }))),
    ] },

  { group: "Terminal" },
  { id: "commands", title: "Commands & menu", preview: "help", keywords: "commands menu aliases shortcuts disable enable order help ls pwd",
    desc: "Which commands exist, the order of the menus and the short names visitors can type.", render: secCommands },
  { id: "custom", title: "Custom commands", preview: undefined, keywords: "custom new command page section blog",
    desc: "Add your own commands with any text, links and images. A custom command with the same name as a built-in one replaces it.", render: secCustom },
  { id: "messages", title: "Messages", preview: "help", keywords: "not found error whoami sudo history keys or press enter",
    desc: "Small texts the terminal prints.", render: () => [
      group("Help screen", null, fields(lf("Word between a command and its short name", "or"), lf("“all at once” (next to contact)", "allAtOnce"), lf("Keyboard tip", "keys", { wide: true }))),
      group("Errors and hints", null, fields(
        lf("Unknown command", "notFound", { wide: true, help: "<code>{name}</code> = what they typed, <code>{help}</code> = the help button." }),
        lf("Prompt hint after “clear”", "pressEnter"), lf("Empty history", "noHistory"))),
      group("whoami", "Shown as: <i>[1]</i> <i>[2]</i> <code>[about]</code><i>[3]</i>", fields3(lf("1", ["whoami", 0]), lf("2", ["whoami", 1]), lf("3", ["whoami", 2]))),
      group("sudo", null, fields(lf("Message", "sudo", { wide: true }), lf("After it", "kidding"))),
      group("admin password prompt", "What the terminal shows after someone types <code>admin</code>.", fields3(
        lf("Prompt", "adminPassword"), lf("Wrong password", "adminDenied"), lf("Right password", "adminGranted"))),
    ] },
  { id: "boot", title: "Boot screen", preview: "", keywords: "boot animation ssh loading start",
    desc: "The fake SSH login that plays before the home screen.",
    actions: () => [btn("Replay in preview", () => { togglePreview(true); showPreview("", true); }, "small", "ext")], render: () => [
      group("When it plays", null, fields(field({ label: "Boot animation", path: ["features", "boot"], type: "select", options: [["session", "Once per visit"], ["always", "Every time the page loads"], ["never", "Never"]] }))),
      group("Lines", null, fields(
        field({ label: "Visitor prompt", path: ["boot", "prompt"], mono: true }), field({ label: "Typed command", path: ["boot", "command"], mono: true }),
        field({ label: "Connecting line", path: ["boot", "connecting"], mono: true }), field({ label: "Connected line", path: ["boot", "connected"], mono: true, help: "<code>{date}</code> = today's date." }),
        field({ label: "“Skip” hint", path: ["boot", "skip"] }))),
      group("[ OK ] steps", null, list({ path: ["boot", "steps"], itemName: "step", cols: [{ label: "Verb", fr: "minmax(0, .35fr)", mono: true }, { label: "What", mono: true }] })),
    ] },

  { group: "System" },
  { id: "languages", title: "Languages", preview: "", keywords: "language translation english uzbek russian add default",
    desc: "The site's languages. Pick the one you're editing in the bar at the top.", render: secLanguages },
  { id: "files", title: "Files", preview: undefined, keywords: "upload files images assets pdf",
    desc: "Upload images or documents to use anywhere (custom commands, projects, links).", render: secFiles },
  { id: "json", title: "Raw JSON", preview: undefined, keywords: "json export import backup download reset revert",
    desc: "Everything above is stored in one file, <code>content.json</code>. Back it up, restore it or edit it directly.", render: secJson },
  { id: "settings", title: "Settings", preview: undefined, keywords: "github token sign out repository account",
    desc: "Your GitHub connection.", render: secSettings },
];
const titleOf = id => (SECTIONS.find(s => s.id && s.id === id) || {}).title || id;

const I18N_ROUTE = { label: "languages", or: "messages", welcome: "home", typeHelp: "home", newTag: "home", newLine: "home", seeIt: "home", avail: "home",
  contactMe: "home", extras: "home", language: "home", hint: "home", pressEnter: "messages", keys: "messages", allAtOnce: "messages", notFound: "messages",
  desc: "commands", tag: "about", beats: "about", andYou: "about", whoami: "messages", sudo: "messages", kidding: "messages", resumeSoon: "resume",
  resumeLinks: "resume", resumeTitle: "resume", allCode: "projects", noHistory: "messages", teaching: "teaching", achievements: "achievements",
  skills: "skills", misc: "misc", mathbook: "mathbook", neofetch: "neofetch", copy: "profile", scan: "about", chessT: "chess", music: "music",
  adminPassword: "messages", adminDenied: "messages", adminGranted: "messages" };
function sectionFor(p) {
  const [a, b] = p;
  switch (a) {
    case "profile": return { resumeUrl: "resume", olympiadYear: "achievements", mathbookRole: "mathbook" }[b] || "profile";
    case "site": return { defaultLang: "languages", portraitAlt: "home", photoAlt: "about" }[b] || "site";
    case "theme": return "theme";
    case "features": return b === "boot" ? "boot" : "features";
    case "home": return "home";
    case "boot": return "boot";
    case "photo": return "about";
    case "commands": return b === "next" ? "about" : "commands";
    case "projects": return "projects";
    case "tracks": return "music";
    case "chess": return "chess";
    case "custom": return "custom";
    case "i18n": return p.length < 3 ? "languages" : I18N_ROUTE[p[2]] || "messages";
    case "admin": return "settings";
    default: return "json";
  }
}

function secCommands() {
  const dis = new Set(state.commands.disabled);
  const L = state.i18n[editLang];
  const rowsEls = allCommands().map(n => {
    const kind = customNames().includes(n) ? "custom" : linkNames().includes(n) ? "link" : "";
    const inp = h("input", { type: "checkbox", checked: !dis.has(n), "aria-label": "Enable " + n });
    const tr = h("tr", { class: dis.has(n) ? "off" : null, "data-path": "i18n." + editLang + ".desc." + n });
    inp.addEventListener("change", () => {
      const d = new Set(state.commands.disabled);
      inp.checked ? d.delete(n) : d.add(n);
      state.commands.disabled = [...d];
      tr.classList.toggle("off", !inp.checked);
      changed();
    });
    let desc;
    if (kind === "custom") desc = h("span", { class: "help" }, "Description is set in Custom commands.");
    else if (kind === "link") desc = h("span", { class: "help" }, "From Profile & contacts → More links.");
    else {
      desc = control("text", (L.desc || {})[n] || "", v => set(LP("desc", n), v), { ph: (state.i18n[defLang()].desc || {})[n] || BUILTIN[n] });
      desc.setAttribute("aria-label", "Description of " + n);
    }
    tr.append(h("td", null, h("label", { class: "toggle" }, inp, h("span", { class: "sw" }))), h("td", null, h("span", { class: "nm" }, n), kind ? h("span", { class: "kind" }, kind) : null), h("td", null, desc));
    return tr;
  });
  const aliasBox = h("div");
  const renderAliases = () => {
    const entries = Object.entries(state.commands.aliases);
    const arr = entries.map(([a, c]) => [a, c]);
    const rowsList = h("div", { class: "list" },
      arr.length ? h("div", { class: "list-head", style: "grid-template-columns:minmax(0,1fr) minmax(0,1fr)" }, h("span", null, "Visitor types"), h("span", null, "Runs command")) : null,
      arr.map(([a, c], i) => {
        const ai = control("text", a, () => sync(), { mono: true }), ci = control("text", c, () => sync(), { mono: true, list: "cmd-names" });
        ai.setAttribute("aria-label", "Alias " + (i + 1)); ci.setAttribute("aria-label", "Command for alias " + (i + 1));
        return h("div", { class: "lrow", style: "--cols:minmax(0,1fr) minmax(0,1fr)", "data-path": "commands.aliases." + a }, h("span", { class: "idx" }, i + 1),
          h("div", { class: "cell" }, ai), h("div", { class: "cell" }, ci),
          h("div", { class: "ctl" }, ibtn("trash", "Delete", () => { delete state.commands.aliases[a]; changed(); renderAliases(); }, "del")));
      }),
      h("button", { type: "button", class: "btn small add", onclick: () => { let k = "new", n = 1; while (state.commands.aliases[k]) k = "new" + ++n; state.commands.aliases[k] = ""; changed(); renderAliases(); } }, icon("plus"), "Add short name"));
    function sync() {
      const o = {};
      rowsList.querySelectorAll(".lrow").forEach(r => { const [x, y] = r.querySelectorAll("input"); if (x.value.trim()) o[x.value.trim().toLowerCase()] = y.value.trim().toLowerCase(); });
      state.commands.aliases = o; changed();
    }
    aliasBox.replaceChildren(rowsList);
  };
  renderAliases();
  return [
    group("All commands", "Switch a command off to remove it from every menu; typing it then says “command not found”. Descriptions appear on the <code>help</code> screen.",
      h("table", { class: "ctable" }, h("thead", null, h("tr", null, h("th", null, "On"), h("th", null, "Command"), h("th", null, h("span", { style: "display:inline-flex;gap:6px;align-items:center" }, "Description", chip())))), h("tbody", null, rowsEls))),
    group("Main menu", "“Available Commands” on the home and help screens. The short name is shown as <code>[about] or [a]</code>.",
      list({ path: ["commands", "main"], itemName: "command", add: () => ["", ""], cols: [{ label: "Command", mono: true, list: "cmd-names" }, { label: "Short name (optional)", mono: true }] })),
    group("Contact menu", "Contacts with an empty value in Profile & contacts are hidden automatically.",
      list({ path: ["commands", "contacts"], itemName: "contact", add: () => ["", ""], cols: [{ label: "Command", mono: true, list: "cmd-names" }, { label: "Short name (optional)", mono: true }] })),
    group("Extras", "Shown on the help screen under “Extras”.", list({ path: ["commands", "extras"], single: true, mono: true, list: "cmd-names", itemName: "command" })),
    group("The “all” command", "What <code>all</code> prints, in order.", list({ path: ["commands", "all"], single: true, mono: true, list: "cmd-names", itemName: "command" })),
    group("Short names", "Other words visitors can type to run a command.", aliasBox),
    group("Joke commands", null, fields(field({ label: "ls output", path: ["commands", "ls"], mono: true, wide: true }), field({ label: "pwd output", path: ["commands", "pwd"], mono: true }))),
  ];
}

function secCustom() {
  const cheat = h("div", { class: "cheat", html:
    "<code># Title</code> heading · <code>key | value</code> table row · <code>[text](https://…)</code> link · <code>[[projects]]</code> command button · " +
    "<code>**bold**</code> · <code>![description](assets/pic.jpg)</code> image on its own line · empty line = gap" });
  const inMenu = n => state.commands.main.some(r => r[0] === n);
  return [
    cards({ path: ["custom"], itemName: "command", emptyText: "No custom commands yet. Add one to create a new page in the terminal.",
      title: c => c.name ? c.name : "(unnamed)", sub: c => trv(c.desc),
      add: () => ({ name: "", aliases: "", boxed: true, desc: {}, body: { [defLang()]: "# A new section\nWrite anything here.\nkey | value\nSee also [[projects]]" } }),
      onDuplicate: c => { c.name = (c.name || "copy") + "2"; },
      onAdd: () => { updateDatalist(); renderPreviewOptions(); },
      onDelete: removed => { const n = norm(removed && removed.name); if (n) state.commands.main = state.commands.main.filter(r => r[0] !== n); changed(); updateDatalist(); renderPreviewOptions(); },
      body: (p, item) => {
        let oldName = norm(item.name);
        const bodyPath = [...p, "body"];
        const menuToggle = toggle({ label: "Show in the main menu", get: () => !!oldName && inMenu(oldName), set: v => {
          if (!oldName) { toast("Give the command a name first.", "err"); return; }
          state.commands.main = state.commands.main.filter(r => r[0] !== oldName);
          if (v) state.commands.main.push([oldName, ""]);
          changed();
        } });
        const insertImage = async () => {
          const f = await pickFile("image/*");
          if (!f) return;
          try {
            const data = await imageFromFile(f);
            const path = `assets/${safeName(data.name)}`;
            addPending(path, data);
            const ta = document.querySelector(`[data-path="${CSS.escape([...bodyPath, editLang].join("."))}"] textarea`);
            const snippet = `\n![${f.name.replace(/\.[^.]+$/, "")}](${versioned(path)})\n`;
            if (ta) { ta.focus(); ta.setRangeText(snippet, ta.selectionStart, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); }
            else set([...bodyPath, editLang], (get([...bodyPath, editLang]) || "") + snippet);
            toast("Image inserted.", "ok");
          } catch (e) { toast(e.message, "err"); }
        };
        return [
          fields(
            field({ label: "Command name", path: [...p, "name"], mono: true, help: "One word. What visitors type.", onChange: v => {
              const n = norm(v);
              if (/\s/.test(n)) return;
              renameCommand(oldName, n); oldName = n; changed(); updateDatalist(); renderPreviewOptions();
            } }),
            field({ label: "Other names", path: [...p, "aliases"], mono: true, ph: "blog, b", help: "Optional, separated by commas." })),
          h("div", { style: "height:10px" }),
          fields(menuToggle, toggle({ label: "Show inside a card (with border)", path: [...p, "boxed"], def: true })),
          h("div", { style: "height:14px" }),
          fields1(mf("Description (help screen)", [...p, "desc"]), mf("Content", bodyPath, { type: "area", rows: 8, mono: true })),
          h("div", { style: "display:flex;gap:8px;margin:10px 0;flex-wrap:wrap" },
            btn("Insert image", insertImage, "small", "upload"),
            btn("Preview this command", () => { const n = norm(get([...p, "name"])); if (!n) return toast("Give the command a name first.", "err"); togglePreview(true); showPreview(n); }, "small", "ext")),
          cheat.cloneNode(true),
        ];
      } }),
  ];
}

function secLanguages() {
  const d = defLang();
  const rowsEls = langs().map(code => h("div", { class: "lrow", style: "--cols:70px minmax(0,1fr) 150px", "data-path": `i18n.${code}.label` },
    h("span", { class: "idx" }, ""),
    h("div", { class: "cell mono", style: "padding-top:8px;font-weight:700" }, code.toUpperCase()),
    h("div", { class: "cell" }, (() => { const i = control("text", state.i18n[code].label || "", v => { state.i18n[code].label = v; changed(); }); i.setAttribute("aria-label", "Name of " + code); return i; })()),
    h("div", { class: "cell", style: "padding-top:6px" }, code === d ? h("span", { class: "chip" }, "DEFAULT") : btn("Make default", () => { set(["site", "defaultLang"], code); renderAll(); }, "small ghost")),
    h("div", { class: "ctl" }, ibtn("trash", "Delete language", () => removeLang(code), "del", langs().length < 2))));
  const codeIn = control("text", "", () => {}, { mono: true, ph: "de" });
  codeIn.setAttribute("aria-label", "New language code");
  const nameIn = control("text", "", () => {}, { ph: "Deutsch" });
  nameIn.setAttribute("aria-label", "New language name");
  const fromSel = control("select", d, () => {}, { options: langs().map(l => [l, "Copy texts from " + l.toUpperCase()]) });
  return [
    group("Languages", "The default language is used when a visitor hasn't chosen one, and for anything missing in another language.", h("div", { class: "list" }, rowsEls)),
    group("Add a language", "All texts are copied from the language you pick, then you translate them by switching to the new language at the top.",
      h("div", { class: "fields three" },
        h("label", { class: "field" }, h("span", { class: "flabel" }, "Code"), codeIn, h("span", { class: "help" }, "2–3 letters, e.g. de, tr, kk.")),
        h("label", { class: "field" }, h("span", { class: "flabel" }, "Name"), nameIn),
        h("label", { class: "field" }, h("span", { class: "flabel" }, "Start from"), fromSel)),
      h("div", { style: "margin-top:12px" }, btn("Add language", () => {
        const code = norm(codeIn.value);
        if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code)) return toast("Use a short code like de or pt-br.", "err");
        if (state.i18n[code]) return toast("That language already exists.", "err");
        state.i18n[code] = clone(state.i18n[fromSel.value]);
        state.i18n[code].label = nameIn.value.trim() || code.toUpperCase();
        editLang = code; changed(); renderAll(); toast(`${code.toUpperCase()} added. You're now editing it.`, "ok");
      }, "primary small", "plus"))),
  ];
}
async function removeLang(code) {
  const ok = await dialog(`Delete ${code.toUpperCase()}?`, "All texts in this language will be removed from the site. You can undo with Ctrl+Z.",
    [{ label: "Cancel", value: false }, { label: "Delete", kind: "danger", value: true }]);
  if (!ok) return;
  delete state.i18n[code];
  for (const p of state.projects) for (const k of ["name", "tech", "desc"]) if (p[k]) delete p[k][code];
  for (const c of state.custom) for (const k of ["desc", "body"]) if (c[k]) delete c[k][code];
  if (state.site.defaultLang === code) state.site.defaultLang = langs()[0];
  if (editLang === code) editLang = defLang();
  changed(); renderAll();
}

function secFiles() {
  const pendBox = h("div"), repoBox = h("div");
  const drop = h("div", { class: "drop", tabindex: 0, role: "button", onclick: () => choose(), onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } } },
    h("div", null, icon("upload")), h("b", null, "Drop files here or click to upload"), h("div", { class: "help" }, "Images over 450 KB are shrunk automatically. Max 25 MB per file."));
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); addFiles([...e.dataTransfer.files]); });
  async function choose() { const f = await pickFile(""); if (f) addFiles([f]); }
  async function addFiles(files) {
    for (const f of files) {
      if (f.size > 25e6) { toast(`${f.name} is bigger than 25 MB.`, "err"); continue; }
      try {
        const data = /^image\//.test(f.type) ? await imageFromFile(f) : { b64: await fileToB64(f), type: f.type, name: f.name };
        addPending(`assets/${safeName(data.name || f.name)}`, data);
      } catch (e) { toast(e.message, "err"); }
    }
    renderPending();
  }
  const copyBtn = path => ibtn("copy", "Copy path", async () => { try { await navigator.clipboard.writeText(path); toast("Copied " + path); } catch (e) { toast(path); } });
  function renderPending() {
    const ps = Object.keys(pending);
    pendBox.replaceChildren(ps.length ? h("table", { class: "files" }, h("tbody", null, ps.map(p => h("tr", null,
      h("td", { class: "path" }, h("a", { href: blobUrl(p), target: "_blank", rel: "noopener" }, p)),
      h("td", { class: "r" }, fmtSize(pending[p].size)),
      h("td", { class: "r" }, copyBtn(p), ibtn("trash", "Don't upload", () => { delete pending[p]; changed(); renderPending(); }, "del")))))) : h("div", { class: "empty" }, "No files waiting."));
  }
  async function loadRepo() {
    if (!auth) { repoBox.replaceChildren(h("div", { class: "empty" }, "Sign in to see the files in your repository.")); return; }
    repoBox.replaceChildren(h("div", { class: "help" }, "Loading…"));
    try {
      const t = await gh(`/repos/${auth.owner}/${auth.repo}/git/trees/${encodeURIComponent(auth.branch)}?recursive=1`);
      const files = t.tree.filter(x => x.type === "blob");
      repoBox.replaceChildren(h("table", { class: "files" }, h("tbody", null, files.map(f => h("tr", null,
        h("td", { class: "path" }, h("a", { href: f.path, target: "_blank", rel: "noopener" }, f.path)),
        h("td", { class: "r" }, fmtSize(f.size || 0)),
        h("td", { class: "r" }, copyBtn(f.path)))))));
    } catch (e) { repoBox.replaceChildren(h("div", { class: "empty" }, "Couldn't list files: " + e.message)); }
  }
  renderPending(); loadRepo();
  return [
    group("Upload", "Files go to the <code>assets/</code> folder. Copy a file's path and use it in a custom command (<code>![](assets/pic.jpg)</code>), a project image or a link.", drop),
    group("Waiting to be published", null, pendBox),
    group("Files in your repository", null, repoBox),
  ];
}

function secJson() {
  const ta = h("textarea", { class: "mono", rows: 24, spellcheck: "false", "aria-label": "content.json" });
  ta.value = JSON.stringify(state, null, 2);
  const download = () => {
    const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(state, null, 2) + "\n"], { type: "application/json" })), download: "content.json" });
    document.body.append(a); a.click(); a.remove();
  };
  const apply = text => {
    try {
      const c = JSON.parse(text);
      if (!c || typeof c !== "object" || !c.i18n) throw new Error("That doesn't look like this site's content.json (no i18n section).");
      state = normalize(c);
      if (!state.i18n[editLang]) editLang = defLang();
      changed(); renderAll(); toast("Content replaced. Publish to put it online.", "ok");
    } catch (e) { toast("Invalid JSON: " + e.message, "err", 7000); }
  };
  return [
    group("Backup", null, h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      btn("Download content.json", download, "small", "download"),
      btn("Import a file…", async () => { const f = await pickFile("application/json,.json"); if (f) apply(await f.text()); }, "small", "upload"),
      btn("Discard all unpublished changes", async () => {
        const ok = await dialog("Discard unpublished changes?", "Everything goes back to the version that is online now, including files waiting to be uploaded.",
          [{ label: "Cancel", value: false }, { label: "Discard", kind: "danger", value: true }]);
        if (!ok) return;
        state = normalize(JSON.parse(base)); pending = {}; store.del(DRAFT_KEY); changed(); renderAll(); toast("Back to the published version.");
      }, "small danger"))),
    group("Edit directly", "Careful: a mistake here can break the site. Use Apply to load your edits into the editor, then preview before publishing.",
      ta, h("div", { style: "margin-top:10px;display:flex;gap:8px" }, btn("Apply", () => apply(ta.value), "primary small"), btn("Reset text", () => { ta.value = JSON.stringify(state, null, 2); }, "small ghost"))),
  ];
}

function secSettings() {
  const live = pagesUrl();
  const repoUrl = auth ? `https://github.com/${auth.owner}/${auth.repo}` : null;
  return [
    group("GitHub", null, auth
      ? h("div", null,
          h("p", { style: "margin:0 0 12px" }, "Signed in", auth.user ? [" as ", h("b", null, "@" + auth.user)] : null, " to ", h("a", { href: repoUrl, target: "_blank", rel: "noopener", class: "mono" }, `${auth.owner}/${auth.repo}`), ` (branch ${auth.branch}).`),
          h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
            btn("Reload from GitHub", async () => {
              if (changedIds.size) { const ok = await dialog("Reload from GitHub?", "Your unpublished changes will be replaced with the version on GitHub.", [{ label: "Cancel", value: false }, { label: "Reload", kind: "danger", value: true }]); if (!ok) return; }
              store.del(DRAFT_KEY); pending = {}; await loadRemote(true);
            }, "small"),
            btn("Disconnect GitHub on this device", () => { store.del(AUTH_KEY); lockAndLeave(); }, "small danger")))
      : null),
    group("Admin password", "Asked when someone types <code>admin</code> in the terminal or opens this page. Only a scrambled hash of it is saved on the site.",
      passwordChanger()),
    group("Your site", null, h("p", { style: "margin:0" }, "Live site: ", h("a", { href: live, target: "_blank", rel: "noopener" }, live), h("br"),
      "This panel: ", h("a", { href: live + "admin", target: "_blank", rel: "noopener" }, live + "admin"), h("br"),
      h("span", { class: "help" }, "You can also type admin in the terminal. Switch the admin command off in Commands & menu to hide it."))),
    group("Leave", null, btn("Lock the admin panel", lockAndLeave, "small")),
    group("Keyboard shortcuts", null, h("div", { class: "help", html: "<kbd>/</kbd> search · <kbd>Ctrl</kbd>+<kbd>S</kbd> publish · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redo" })),
  ];
}

function passwordChanger() {
  const a = h("input", { type: "password", autocomplete: "new-password", "aria-label": "New password" });
  const b = h("input", { type: "password", autocomplete: "new-password", "aria-label": "Repeat new password" });
  const note = h("span", { class: "help" }, validLock(state.admin) && state.admin.hash !== publishedLock.hash ? "A new password is waiting to be published." : "");
  const save = btn("Change password", async () => {
    if (a.value.length < 8) return toast("Use at least 8 characters.", "err");
    if (a.value !== b.value) return toast("The two passwords don't match.", "err");
    const salt = randomHex(16), iter = 300000;
    const hash = await pbkdf2Hex(a.value, salt, iter);
    state.admin = { iter, salt, hash };
    a.value = b.value = "";
    changed();
    note.textContent = "A new password is waiting to be published.";
    toast("New password set. Publish to make it active.", "ok", 6000);
  }, "small");
  return h("div", null,
    h("div", { class: "fields" },
      h("label", { class: "field" }, h("span", { class: "flabel" }, "New password"), a),
      h("label", { class: "field" }, h("span", { class: "flabel" }, "Repeat it"), b)),
    h("div", { style: "display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap" }, save, note));
}
function lockAndLeave() {
  try { sessionStorage.removeItem(UNLOCK_KEY); } catch (e) {}
  location.href = "./";
}

/* ================= rendering ================= */
function renderSide() {
  $("side").replaceChildren(...SECTIONS.map(s => s.group ? h("div", { class: "grp" }, s.group)
    : h("button", { type: "button", class: s.id === current ? "on" : null, "data-id": s.id, "aria-current": s.id === current ? "page" : null, onclick: () => go(s.id) },
        s.title, changedIds.has(s.id) ? h("span", { class: "mark", title: "Unpublished changes" }) : null)));
}
function renderLangs() {
  $("langs").replaceChildren(...langs().map(l => h("button", { type: "button", role: "tab", class: l === editLang ? "on" : null, "aria-selected": String(l === editLang),
    title: (state.i18n[l].label || l) + (l === defLang() ? " (default)" : ""), onclick: () => setLang(l) }, l.toUpperCase())));
}
function renderSection() {
  const s = SECTIONS.find(x => x.id && x.id === current) || SECTIONS[1];
  current = s.id;
  updateDatalist();
  const inner = $("editor-inner");
  const scroll = $("editor").scrollTop;
  inner.replaceChildren(
    h("div", { class: "sec-head" }, h("div", null, h("h1", null, s.title), s.desc ? h("p", { html: s.desc }) : null), s.actions ? h("div", { class: "acts" }, s.actions()) : null),
    ...[].concat(s.render()));
  fitAll(inner);
  openTarget = null;
  return scroll;
}
function renderAll() {
  const scroll = renderSection();
  renderSide(); renderLangs(); renderPreviewOptions(); updateDirty();
  $("editor").scrollTop = scroll;
}
function go(id, target) {
  current = id; prefs.section = id; savePrefs();
  openTarget = target ? target.split(".") : null;
  renderSection(); renderSide();
  $("editor").scrollTop = 0;
  $("main").classList.remove("side-open");
  followPreview();
  if (target) requestAnimationFrame(() => {
    const parts = target.split(".");
    let el = null;
    for (let n = parts.length; n > 0 && !el; n--) el = $("editor-inner").querySelector(`[data-path="${CSS.escape(parts.slice(0, n).join("."))}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    const f = el.matches("input, textarea, select") ? el : el.querySelector("input:not([type=checkbox]):not([type=color]), textarea, select");
    if (f) f.focus({ preventScroll: true });
  });
}
function setLang(l) {
  if (!state.i18n[l]) return;
  editLang = l; prefs.lang = l; savePrefs();
  try { localStorage.setItem("lang", l); } catch (e) {}
  renderLangs();
  const scroll = renderSection();
  $("editor").scrollTop = scroll;
  reloadPreview();
}

/* ================= search ================= */
function searchAll(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const s of SECTIONS) if (s.id && (s.title.toLowerCase().includes(q) || (s.keywords || "").includes(q))) out.push({ section: s.id, label: "Go to " + s.title });
  const walk = (v, p) => {
    if (typeof v === "string") { if (v.toLowerCase().includes(q) && !/^data:/.test(v)) out.push({ p, v }); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...p, i]));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], [...p, k]);
  };
  for (const k of Object.keys(state)) if (!["meta", "version", "theme", "admin"].includes(k)) walk(state[k], [k]);
  return out.slice(0, 60);
}
function langOfPath(p) {
  if (p[0] === "i18n") return p[1];
  if ((p[0] === "projects" && ["name", "tech", "desc"].includes(p[2])) || (p[0] === "custom" && ["desc", "body"].includes(p[2]))) return p[3];
  return null;
}
function renderResults() {
  const box = $("results"), q = $("search").value;
  const res = searchAll(q);
  if (!q.trim()) { box.hidden = true; return; }
  const mark = (text) => {
    const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
    const start = Math.max(0, i - 30);
    const frag = (start ? "…" : "") + text.slice(start, i);
    return [frag, h("mark", null, text.substr(i, q.trim().length)), text.slice(i + q.trim().length, i + q.trim().length + 80)];
  };
  box.replaceChildren(...(res.length ? res.map((r, i) => h("button", { type: "button", class: i === 0 ? "on" : null, onmousedown: e => e.preventDefault(), onclick: () => pick(r) },
    r.label ? h("div", null, h("b", null, r.label))
      : [h("div", { class: "where" }, titleOf(sectionFor(r.p)), langOfPath(r.p) ? h("span", { class: "chip" }, langOfPath(r.p).toUpperCase()) : null), h("div", { class: "snip" }, mark(r.v))]))
    : [h("div", { class: "none" }, "No text matches “" + q + "”.")]));
  box.hidden = false;
  function pick(r) {
    box.hidden = true; $("search").value = ""; $("search").blur();
    if (r.label) return go(r.section);
    const l = langOfPath(r.p);
    if (l && l !== editLang && state.i18n[l]) { editLang = l; prefs.lang = l; savePrefs(); renderLangs(); }
    go(sectionFor(r.p), r.p.join("."));
  }
}

/* ================= GitHub ================= */
async function gh(path, opts = {}) {
  const r = await fetch("https://api.github.com" + path, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + auth.token, "X-GitHub-Api-Version": "2022-11-28", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!r.ok) {
    let msg = "";
    try { msg = (await r.json()).message || ""; } catch (e) {}
    const err = new Error(r.status === 401 ? "GitHub rejected the token (expired or revoked)." : r.status === 403 && /permission|accessible/i.test(msg) ? "This token isn't allowed to write to the repository. Give it “Contents: Read and write”." : r.status === 404 ? "Not found on GitHub (check the repository name, branch, and that the token can access this repository)." : `GitHub error ${r.status}: ${msg}`);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}
const repoPath = () => `/repos/${encodeURIComponent(auth.owner)}/${encodeURIComponent(auth.repo)}`;
function pagesUrl() {
  const a = auth || detectRepo();
  const owner = a.owner.toLowerCase();
  return a.repo.toLowerCase() === `${owner}.github.io` ? `https://${owner}.github.io/` : `https://${owner}.github.io/${a.repo}/`;
}
function detectRepo() {
  const host = location.hostname.toLowerCase();
  if (host.endsWith(".github.io")) {
    const owner = host.slice(0, -".github.io".length);
    const seg = location.pathname.split("/").filter(Boolean);
    return { owner, repo: seg.length > 1 ? seg[0] : `${owner}.github.io`, branch: "main" };
  }
  return { ...FALLBACK_REPO };
}

async function fetchContentFile() {
  const f = await gh(`${repoPath()}/contents/content.json?ref=${encodeURIComponent(auth.branch)}`);
  let text;
  if (f.content) text = b64ToUtf8(f.content);
  else text = b64ToUtf8((await gh(`${repoPath()}/git/blobs/${f.sha}`)).content);
  return { content: JSON.parse(text), sha: f.sha };
}

async function loadRemote(fresh) {
  setStatus("busy", "Loading…");
  const { content, sha } = await fetchContentFile();
  await startEditing(content, sha, fresh);
}

async function startEditing(content, sha, fresh) {
  const loaded = normalize(content);
  base = JSON.stringify(loaded);
  baseSha = sha;
  state = clone(loaded);
  const draft = fresh ? null : store.get(DRAFT_KEY);
  if (draft && draft.content && (JSON.stringify(normalize(draft.content)) !== base || (draft.pending && Object.keys(draft.pending).length))) {
    showApp();
    const when = new Date(draft.savedAt || Date.now()).toLocaleString();
    const ok = await dialog("Restore your unpublished changes?", `You have changes from ${when} that were never published.`,
      [{ label: "Discard them", kind: "danger", value: false }, { label: "Restore", kind: "primary", value: true }]);
    if (ok) {
      state = normalize(draft.content); pending = draft.pending || {};
      if (draft.baseSha && sha && draft.baseSha !== sha) toast("Heads up: the site was changed elsewhere after this draft was made. Publishing will overwrite those changes.", "err", 9000);
    } else store.del(DRAFT_KEY);
  }
  if (!state.i18n[editLang]) editLang = state.i18n[prefs.lang] ? prefs.lang : defLang();
  hist.stack = []; hist.i = -1; pushHistory(JSON.stringify(state));
  showApp();
  renderAll();
  writePreview();
  if (prefs.preview && !narrowScreen()) showPreview(currentPreview());
}

/* ================= publish ================= */
async function openPublish() {
  if (publishing) return;
  if (!auth) return;
  const secs = [...changedIds].filter(id => id !== "files").map(titleOf);
  const files = Object.keys(pending);
  if (!secs.length && !files.length) return toast("Nothing to publish. Everything is already online.");
  const msg = h("input", { type: "text", value: `Update ${secs.slice(0, 3).join(", ").toLowerCase() || "files"}${secs.length > 3 ? " and more" : ""} (admin panel)`, "aria-label": "Change description" });
  const body = h("div", null,
    secs.length ? [h("div", null, "Changed:"), h("ul", null, secs.map(s => h("li", null, s)))] : null,
    files.length ? [h("div", null, "New files:"), h("ul", null, files.map(f => h("li", { class: "mono" }, `${f} (${fmtSize(pending[f].size)})`)))] : null,
    h("label", { class: "field", style: "margin-top:12px" }, h("span", { class: "flabel" }, "Short description of the change"), msg),
    h("p", { class: "help", style: "margin:10px 0 0" }, "The site updates about a minute after publishing."));
  const go2 = await dialog("Publish to your site?", body, [{ label: "Cancel", value: false }, { label: "Publish", kind: "primary", value: true }], { focus: msg });
  if (go2) runPublish(msg.value.trim() || "Update site content (admin panel)");
}

async function runPublish(message) {
  publishing = true;
  $("publish-btn").disabled = true;
  setStatus("busy", "Publishing…");
  const steps = h("ul", { class: "progress" });
  const step = t => { const li = h("li", null, "… " + t); steps.append(li); return { ok: () => { li.className = "done"; li.textContent = "✓ " + t; }, fail: () => { li.className = "err"; li.textContent = "✗ " + t; } }; };
  const d = $("dlg");
  d.replaceChildren(h("div", { class: "dlg" }, h("h3", null, "Publishing…"), steps));
  d.onclose = null;
  if (!d.open) d.showModal();
  let s;
  try {
    s = step("Checking for changes made elsewhere");
    let remoteSha = null;
    try { remoteSha = (await gh(`${repoPath()}/contents/content.json?ref=${encodeURIComponent(auth.branch)}`)).sha; } catch (e) { if (e.status !== 404) throw e; }
    s.ok();
    if (baseSha && remoteSha && remoteSha !== baseSha) {
      d.close();
      const v = await dialog("The site was changed somewhere else", "content.json on GitHub changed after you opened the editor (maybe from another device). Publishing now replaces those changes with yours.",
        [{ label: "Cancel", value: false }, { label: "Publish anyway", kind: "danger", value: true }]);
      if (!v) throw new Error("cancelled");
      d.replaceChildren(h("div", { class: "dlg" }, h("h3", null, "Publishing…"), steps)); d.showModal();
    }
    const stamp = new Date().toISOString();
    state.meta = { ...(state.meta || {}), updatedAt: stamp };
    const files = [{ path: "content.json", b64: utf8ToB64(JSON.stringify(state, null, 2) + "\n") },
      ...Object.entries(pending).map(([path, f]) => ({ path, b64: f.b64 }))];
    s = step(`Uploading ${files.length} file${files.length > 1 ? "s" : ""}`);
    const ref = await gh(`${repoPath()}/git/ref/heads/${encodeURIComponent(auth.branch)}`);
    const head = ref.object.sha;
    const commit = await gh(`${repoPath()}/git/commits/${head}`);
    const tree = [];
    for (const f of files) {
      const blob = await gh(`${repoPath()}/git/blobs`, { method: "POST", body: JSON.stringify({ content: f.b64, encoding: "base64" }) });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    s.ok();
    s = step("Saving the change");
    const newTree = await gh(`${repoPath()}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: commit.tree.sha, tree }) });
    const newCommit = await gh(`${repoPath()}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }) });
    await gh(`${repoPath()}/git/refs/heads/${encodeURIComponent(auth.branch)}`, { method: "PATCH", body: JSON.stringify({ sha: newCommit.sha }) });
    s.ok();
    const entry = newTree.tree && newTree.tree.find(x => x.path === "content.json");
    baseSha = entry ? entry.sha : null;
    base = JSON.stringify(state);
    Object.assign(recent, pending);
    if (validLock(state.admin) && state.admin.hash !== publishedLock.hash) {   // new password is live: keep this session unlocked
      publishedLock = state.admin;
      try { sessionStorage.setItem(UNLOCK_KEY, state.admin.hash); } catch (e) {}
    }
    pending = {};
    store.del(DRAFT_KEY);
    publishing = false;
    updateDirty(); renderSide();
    d.close();
    const commitUrl = `https://github.com/${auth.owner}/${auth.repo}/commit/${newCommit.sha}`;
    toast(h("span", null, "Published. ", h("a", { href: commitUrl, target: "_blank", rel: "noopener" }, "See the change on GitHub")), "ok", 7000);
    watchLive(stamp);
    if (Object.keys(recent).length && current === "about") renderSection();
  } catch (e) {
    publishing = false;
    if (s) s.fail();
    if (e.message === "cancelled") { d.close(); setStatus("dirty", "Unpublished changes"); }
    else {
      d.replaceChildren(h("div", { class: "dlg" }, h("h3", null, "Publishing failed"), steps, h("p", { class: "body", style: "color:var(--danger)" }, e.message),
        h("p", { class: "help" }, "Nothing was lost: your changes are still here as a draft."), h("div", { class: "acts" }, btn("Close", () => d.close(), "primary"))));
      if (!d.open) d.showModal();
      updateDirty();
    }
  } finally {
    $("publish-btn").disabled = false;
  }
}

async function watchLive(stamp) {
  setStatus("busy", "Updating the site…");
  const url = pagesUrl() + "content.json";
  const t0 = Date.now();
  while (Date.now() - t0 < 6 * 60e3) {
    await sleep(7000);
    if (state.meta.updatedAt !== stamp) return;          // a newer publish took over
    try {
      const r = await fetch(url + "?v=" + Date.now(), { cache: "no-store" });
      const j = r.ok ? await r.json() : null;
      if (j && j.meta && j.meta.updatedAt === stamp) {
        if (!changedIds.size) setStatus("live", "Live on your site");
        toast(h("span", null, "Your changes are live. ", h("a", { href: pagesUrl(), target: "_blank", rel: "noopener" }, "Open the site")), "ok", 8000);
        return;
      }
    } catch (e) {}
  }
  if (!changedIds.size) setStatus("", "Published (the site may take a few more minutes)");
}

/* ================= boot ================= */
function showApp() { $("lock").hidden = true; $("login").hidden = true; $("app").hidden = false; }
function showLock() {
  $("app").hidden = true; $("login").hidden = true; $("lock").hidden = false;
  $("lock-pw").focus();
}
function showLogin(err) {
  $("app").hidden = true; $("lock").hidden = true; $("login").hidden = false;
  const r = (auth && auth.owner) ? auth : detectRepo();
  $("owner").value = r.owner; $("repo").value = r.repo; $("branch").value = r.branch || "main";
  const sum = () => { $("repo-summary").textContent = `${$("owner").value}/${$("repo").value} (${$("branch").value || "main"})`; $("repo-name-hint").textContent = $("repo").value || "your site repo"; };
  ["owner", "repo", "branch"].forEach(id => $(id).oninput = sum); sum();
  $("login-err").textContent = err || "";
  $("token").focus();
}

async function signIn(token, owner, repo, branch, remember) {
  auth = { token, owner, repo, branch };
  const info = await gh(repoPath());
  if (info.permissions && info.permissions.push === false) throw new Error("Your account can't write to this repository.");
  auth.branch = branch || info.default_branch || "main";
  try { auth.user = (await gh("/user")).login; } catch (e) {}
  store.del(AUTH_KEY);
  store.set(AUTH_KEY, auth, !remember);
  await loadRemote();
}

const narrowScreen = () => matchMedia("(max-width: 1180px)").matches;
const currentPreview = () => (SECTIONS.find(s => s.id && s.id === current) || {}).preview || "";
function togglePreview(force) {
  if (narrowScreen()) {
    const open = force !== undefined ? force : !$("main").classList.contains("pv-open");
    $("main").classList.toggle("pv-open", open);
    if (open && !$("pv-frame").getAttribute("src")) showPreview(currentPreview());
    return;
  }
  prefs.preview = force !== undefined ? force : !prefs.preview;
  savePrefs();
  $("main").classList.toggle("nopv", !prefs.preview);
  $("pv-btn").classList.toggle("on", prefs.preview);
  if (prefs.preview && !$("pv-frame").getAttribute("src")) showPreview(currentPreview());
}

function wireUi() {
  $("login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const b = $("login-btn");
    b.disabled = true; b.textContent = "Connecting…"; $("login-err").textContent = "";
    try { await signIn($("token").value.trim(), $("owner").value.trim(), $("repo").value.trim(), $("branch").value.trim(), $("remember").checked); }
    catch (err) { auth = null; $("login-err").textContent = err.message; }
    finally { b.disabled = false; b.textContent = "Connect"; }
  });
  $("lock-form").addEventListener("submit", async e => {
    e.preventDefault();
    const b = $("lock-btn"), pw = $("lock-pw").value;
    b.disabled = true; b.textContent = "Checking…"; $("lock-err").textContent = "";
    let ok = false;
    try { ok = !!pw && (await pbkdf2Hex(pw, publishedLock.salt, publishedLock.iter || 300000)) === publishedLock.hash; } catch (err) {}
    if (!ok) await sleep(600);
    b.disabled = false; b.textContent = "Unlock";
    if (!ok) { $("lock-err").textContent = "Wrong password."; $("lock-pw").select(); return; }
    try { sessionStorage.setItem(UNLOCK_KEY, publishedLock.hash); } catch (err) {}
    $("lock-pw").value = "";
    afterUnlock();
  });
  $("publish-btn").addEventListener("click", openPublish);
  $("undo-btn").addEventListener("click", undo);
  $("redo-btn").addEventListener("click", redo);
  $("pv-btn").addEventListener("click", () => togglePreview());
  $("pv-close").addEventListener("click", () => { $("main").classList.remove("pv-open"); });
  $("menu-btn").addEventListener("click", () => $("main").classList.toggle("side-open"));
  $("pv-cmd").addEventListener("change", () => showPreview($("pv-cmd").value));
  $("pv-follow").classList.toggle("on", prefs.follow);
  $("pv-follow").addEventListener("click", () => { prefs.follow = !prefs.follow; savePrefs(); $("pv-follow").classList.toggle("on", prefs.follow); followPreview(); });
  $("pv-mobile").classList.toggle("on", prefs.mobile);
  $("pv-stage").classList.toggle("mobile", prefs.mobile);
  $("pv-mobile").addEventListener("click", () => { prefs.mobile = !prefs.mobile; savePrefs(); $("pv-mobile").classList.toggle("on", prefs.mobile); $("pv-stage").classList.toggle("mobile", prefs.mobile); });
  $("pv-boot").addEventListener("click", () => showPreview("", true));
  $("pv-open").addEventListener("click", () => { $("pv-open").href = previewUrl($("pv-cmd").value); });
  $("main").classList.toggle("nopv", !prefs.preview);
  $("pv-btn").classList.toggle("on", prefs.preview);

  const search = $("search");
  search.addEventListener("input", renderResults);
  search.addEventListener("focus", renderResults);
  search.addEventListener("blur", () => setTimeout(() => { $("results").hidden = true; }, 150));
  search.addEventListener("keydown", e => {
    const items = [...$("results").querySelectorAll("button")];
    const i = items.findIndex(b => b.classList.contains("on"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const n = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((b, j) => b.classList.toggle("on", j === n));
      items[n].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); if (items[i]) items[i].click(); }
    else if (e.key === "Escape") { search.value = ""; $("results").hidden = true; search.blur(); }
  });

  document.addEventListener("keydown", e => {
    if ($("app").hidden || $("dlg").open) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); openPublish(); }
    else if (mod && !typing && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && !typing && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if (e.key === "/" && !typing) { e.preventDefault(); search.focus(); }
  });
}

async function afterUnlock() {
  const saved = store.get(AUTH_KEY);
  if (saved && saved.token) {
    auth = saved;
    try { await loadRemote(); return; }
    catch (e) {
      const msg = e.status === 401 ? "Your token expired or was revoked. Please sign in again." : e.message;
      if (e.status === 401) { store.del(AUTH_KEY); auth = null; }
      showLogin(msg);
      return;
    }
  }
  showLogin();
}

(async () => {
  wireUi();
  current = prefs.section && SECTIONS.some(s => s.id === prefs.section) ? prefs.section : "profile";
  if (prefs.lang) editLang = prefs.lang;
  // the password hash comes from the published content.json, so a changed password works everywhere
  try {
    const r = await fetch("content.json?v=" + Date.now(), { cache: "no-store" });
    if (r.ok) publishedLock = validLock((await r.json()).admin) || DEFAULT_LOCK;
  } catch (e) {}
  let unlocked = null;
  try { unlocked = sessionStorage.getItem(UNLOCK_KEY); } catch (e) {}
  if (unlocked && unlocked === publishedLock.hash) afterUnlock();
  else showLock();
})();
