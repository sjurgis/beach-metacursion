/* Snells Beach daily pick. Template code: reads data/beaches.json + data/forecast.json, scores, renders.
   Nothing in here changes day to day. See data/SCHEMA.md. */
"use strict";

const TZ = "Pacific/Auckland";
const APP_VERSION = "2026-11-11r2";   // bump with data/version.txt when app.js/style.css/index.html change
const PREF_KEY = "snells-beach-prefs-v1";
const DEFAULT_PREFS = { activities: ["hangout"], drive: 1, dog: false };
const ACT = {
  hangout: { label: "Hangout / picnic", verb: "hang out" },
  swim: { label: "Swim / family", verb: "swim" },
  surf: { label: "Surf", verb: "surf" },
  snorkel: { label: "Snorkel", verb: "snorkel" },
  sup: { label: "SUP / kayak", verb: "paddle" },
  sailing: { label: "Sailing", verb: "sail", heuristic: true },
  fishing: { label: "Fishing", verb: "fish", heuristic: true },
  walking: { label: "Beach walk", verb: "walk", heuristic: true },
};
const ACT_ICON = { hangout: "hangout", swim: "swim", surf: "surf", snorkel: "snorkel", sup: "sup", sailing: "sail", fishing: "fish", walking: "walk" };
const TIDE_ACTS = new Set(["swim", "snorkel", "sup"]);   // these care about the mid-tide window
// how hard rain hits each activity (0 = ignore, 1 = rain ruins it)
const RAIN_K = { hangout: 0.85, swim: 0.6, sup: 0.5, snorkel: 0.45, surf: 0.2, sailing: 0.5, fishing: 0.35, walking: 0.6 };
const DIR16 = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const DIR8 = ["N","NE","E","SE","S","SW","W","NW"];

/* ---------- small helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const norm = (d) => ((d % 360) + 360) % 360;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const dir16 = (d) => DIR16[Math.round(norm(d) / 22.5) % 16];
const dir8 = (d) => DIR8[Math.round(norm(d) / 45) % 8];
const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const dayNum = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const icon = (id, cls = "ic", style = "") => `<svg class="${cls}"${style ? ` style="${style}"` : ""} aria-hidden="true"><use href="#i-${id}"/></svg>`;
const arrow = (dir, cls = "ic arrow") => icon("arrow", cls, `transform:rotate(${Math.round(norm(dir + 180))}deg)`);

function lerp(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) { const [x0, y0] = points[i - 1]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  }
  return points[points.length - 1][1];
}

/* Display times are rounded to the nearest half hour; the JSON keeps exact times. */
const r30 = (min) => Math.round(min / 30) * 30;
function fmtTime(min) {
  min = ((r30(min) % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? "pm" : "am", h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${ap}`;
}
function fmtRange(a, b) {
  a = r30(a); b = r30(b); if (b <= a) b = a + 30;
  const A = fmtTime(a), B = fmtTime(b);
  return `${A.slice(-2) === B.slice(-2) ? A.slice(0, -2) : A}–${B}`;
}
function fmtDate(iso, opts) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-NZ", { timeZone: "UTC", ...opts });
}
let NOW_OVERRIDE = null;   // testing only: ?at=21:00 pretends it's that time today (NZ)
function nzNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const real = { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
  return NOW_OVERRIDE != null ? { ...real, min: NOW_OVERRIDE } : real;
}
const isWeekend = (iso) => { const w = new Date(dayNum(iso) * 86400000).getUTCDay(); return w === 0 || w === 6; };

/* ---------- prefs ---------- */
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    const p = { ...DEFAULT_PREFS, ...saved };
    // migrate the old single-activity pref to the multi-select list
    if (!Array.isArray(saved.activities)) p.activities = saved.activity && ACT[saved.activity] ? [saved.activity] : ["hangout"];
    delete p.activity;
    // one-time switch to the new Hangout default for anyone saved before it existed
    if (!localStorage.getItem("snells-beach-hangout-default")) {
      p.activities = ["hangout"];
      localStorage.setItem("snells-beach-hangout-default", "1");
    }
    return fixPrefs(p);
  }
  catch { return { ...DEFAULT_PREFS }; }
}
function fixPrefs(p) {
  p.activities = (Array.isArray(p.activities) ? p.activities : []).filter((a) => ACT[a]);
  if (!p.activities.length) p.activities = ["hangout"];
  return p;
}
function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* private mode */ } }

/* ---------- data ---------- */
const OFFLINE = {};   // path -> true when the service worker answered from its cache (no network)
async function getJSON(path) {
  const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} returned HTTP ${r.status}`);
  OFFLINE[path] = r.headers.get("x-sw-offline") === "1";
  return r.json();
}

const getRain = () => getJSON("data/rain_history.json").catch(() => null);   // optional: header just skips the rain line

/* ---------- tides ---------- */
function buildTides(days) {
  const base = dayNum(days[0].date);
  const list = [];
  for (const d of days) for (const t of d.tides || []) {
    list.push({ t: (dayNum(d.date) - base) * 1440 + hm(t.time), type: t.type, h: t.heightM });
  }
  list.sort((a, b) => a.t - b.t);
  const hs = list.map((x) => x.h);
  // Mid-tide windows: halfway in time from the low before each high to the low after it.
  const windows = [];
  list.forEach((x, i) => {
    if (x.type !== "high") return;
    const pl = list[i - 1]?.type === "low" ? list[i - 1].t : x.t - 372;
    const nl = list[i + 1]?.type === "low" ? list[i + 1].t : x.t + 372;
    windows.push({ high: x.t, rise: (pl + x.t) / 2, fall: (x.t + nl) / 2 });
  });
  return { base, list, windows, hmin: Math.min(...hs, 0.4), hmax: Math.max(...hs, 2.8) };
}
const absMin = (tides, iso, min) => (dayNum(iso) - tides.base) * 1440 + min;
const localMin = (tides, iso, abs) => abs - (dayNum(iso) - tides.base) * 1440;
function tideHeight(tides, t) {
  const L = tides.list;
  if (!L.length) return null;
  let i = L.findIndex((x) => x.t >= t);
  if (i === -1) { const a = L[L.length - 1]; return a.h + ((a.type === "high" ? -1 : 1) * 2.1) * (1 - Math.cos(Math.PI * clamp((t - a.t) / 372, 0, 1))) / 2; }
  if (i === 0) { const b = L[0]; return b.h + ((b.type === "high" ? -1 : 1) * 2.1) * (1 - Math.cos(Math.PI * clamp((b.t - t) / 372, 0, 1))) / 2; }
  const a = L[i - 1], b = L[i];
  return a.h + (b.h - a.h) * (1 - Math.cos(Math.PI * (t - a.t) / (b.t - a.t))) / 2;
}
function nearestWindow(tides, t) {
  let best = null, bd = Infinity;
  for (const w of tides.windows) {
    const d = t < w.rise ? w.rise - t : t > w.fall ? t - w.fall : 0;
    if (d < bd || (d === bd && best && Math.abs(w.high - t) < Math.abs(best.high - t))) { best = w; bd = d; }
  }
  return best ? { ...best, dist: bd } : null;
}

/* ---------- scoring ---------- */
const EFF = { onshore: 1, "cross-on": 0.8, "cross-off": 0.55, offshore: 0.45, sheltered: 0.3 };
const EFF_HANG = { onshore: 1, "cross-on": 0.85, "cross-off": 0.65, offshore: 0.5, sheltered: 0.2 };
function windRel(b, dirDeg) {
  if ((b.shelteredFrom || []).includes(dir8(dirDeg))) return "sheltered";
  const d = angDiff(dirDeg, b.facingDeg);
  return d <= 50 ? "onshore" : d <= 90 ? "cross-on" : d <= 130 ? "cross-off" : "offshore";
}
function nearestSwell(day, min) {
  let best = null;
  for (const s of day.swell || []) if (!best || Math.abs(hm(s.time) - min) < Math.abs(hm(best.time) - min)) best = s;
  return best;
}
function dogRule(b, iso) {
  const md = iso.slice(5);
  for (const r of b.dog?.rules || []) {
    if (!r.from) return r;
    const inR = r.from <= r.to ? md >= r.from && md <= r.to : md >= r.from || md <= r.to;
    if (inR) return r;
  }
  return { status: "unknown", chip: "Unverified: check signs", text: "Unverified: check signs" };
}
/* 0 = dry, 1 = proper rain. Uses mm/h and the chance of rain, whichever says wetter. */
function wetness(s) {
  const mm = s.rainMm ?? 0;
  const p = s.rainProbPct != null ? s.rainProbPct / 100 : (s.sky === "rain" || s.sky === "showers" ? 0.5 : 0);
  return clamp(Math.max(lerp([[0, 0], [0.1, 0.3], [0.5, 0.65], [2, 1]], mm), p * 0.85), 0, 1);
}

function evalSlot(b, day, slot, act, tides) {
  const t = hm(slot.time);
  const kn = slot.windKn, gust = slot.gustKn ?? kn, dir = slot.windDirDeg;
  const rel = windRel(b, dir);
  const sw = nearestSwell(day, t);
  const open = sw?.open || {}, inner = sw?.inner || {};
  const fac = b.exposure?.factor ?? 0.5;
  const water = (b.exposure?.source === "open" ? (open.waveM ?? open.swellM ?? 0) : (inner.waveM ?? 0)) * fac;
  const surfH = (open.swellM ?? 0) * (b.exposure?.source === "open" ? fac : fac * 0.5);
  const period = open.periodS ?? 0;
  const tAbs = absMin(tides, day.date, t);
  const tideMode = b.tide?.mode || "all";
  const win = tideMode === "high" ? nearestWindow(tides, tAbs) : null;
  const tideQ = win ? lerp([[0, 1], [30, 0.75], [90, 0.3], [180, 0.1]], win.dist) : 1;
  const wet = wetness(slot);
  const rainQ = 1 - RAIN_K[act] * wet;
  const storm = slot.sky === "storm" ? 0.5 : 1;
  const effWind = (kn * 0.75 + gust * 0.25) * EFF[rel];
  const suit = b.suits?.[act] ?? 0;
  let score, windQ, waterQ;
  const extra = [];

  if (act === "surf") {
    const shelteredLike = rel === "offshore" || rel === "sheltered";
    windQ = shelteredLike ? lerp([[0, 1], [15, 1], [22, 0.7], [30, 0.4]], kn)
      : rel === "cross-off" ? lerp([[0, 0.95], [8, 0.8], [15, 0.55], [25, 0.3]], kn)
      : rel === "cross-on" ? lerp([[0, 0.85], [6, 0.6], [12, 0.35], [20, 0.15]], kn)
      : lerp([[0, 0.8], [5, 0.5], [10, 0.25], [18, 0.1]], kn);
    const dirQ = open.dirDeg == null ? 0.8 : lerp([[0, 1], [45, 1], [90, 0.7], [135, 0.3]], angDiff(open.dirDeg, b.facingDeg));
    waterQ = lerp([[0, 0], [0.3, 0.03], [0.5, 0.15], [0.8, 0.45], [1.0, 0.75], [1.3, 0.95], [2.0, 1], [2.8, 0.8], [3.5, 0.5]], surfH)
      * lerp([[4, 0.5], [6, 0.7], [8, 0.9], [10, 1.05], [13, 1.1]], period) * dirQ;
    score = 100 * suit * Math.min(1, waterQ) * (0.35 + 0.65 * windQ);
  } else if (act === "snorkel") {
    windQ = lerp([[0, 1], [5, 1], [9, 0.7], [13, 0.4], [18, 0.15], [25, 0]], effWind);
    waterQ = lerp([[0, 1], [0.15, 1], [0.3, 0.75], [0.5, 0.4], [0.8, 0.15], [1.2, 0]], water);
    score = 100 * suit * (tideMode === "high" ? 0.5 + 0.5 * tideQ : 1) * (0.4 * windQ + 0.6 * waterQ);
  } else if (act === "sup") {
    windQ = lerp([[0, 1], [4, 1], [7, 0.7], [10, 0.4], [14, 0.15], [20, 0]], effWind);
    waterQ = lerp([[0, 1], [0.15, 1], [0.3, 0.65], [0.5, 0.3], [0.8, 0.08]], water);
    score = 100 * suit * (tideMode === "high" ? 0.3 + 0.7 * tideQ : 1) * (0.6 * windQ + 0.4 * waterQ);
    if ((rel === "offshore" || rel === "cross-off") && kn > 12) { score *= 0.6; extra.push({ k: "bad", t: `Offshore ${Math.round(kn)} kn: could blow you out` }); }
  } else if (act === "hangout") {
    // shelter from the wind first, then rain (below), then dry sand; swell barely matters
    const eff = (kn * 0.6 + gust * 0.4) * EFF_HANG[rel];
    windQ = lerp([[0, 1], [5, 1], [8, 0.85], [12, 0.55], [16, 0.3], [22, 0.1]], eff);
    const h = tideHeight(tides, tAbs) ?? tides.hmin;
    const f = clamp((h - tides.hmin) / (tides.hmax - tides.hmin), 0, 1);
    const pen = { little: 0.3, some: 0.12, plenty: 0 }[b.highTideSand || "some"];
    const sandQ = 1 - pen * f * f;
    waterQ = lerp([[0, 1], [1, 1], [2, 0.85]], water);
    if (pen >= 0.3 && f > 0.75) extra.push({ k: "mid", t: "Little dry sand near high tide" });
    score = 100 * suit * (0.65 * windQ + 0.25 * sandQ + 0.1 * waterQ);
  } else if (act === "sailing") {
    // HEURISTIC: steady 8-18 kn, gusts close to the mean, moderate sea; open launch spots in Kawau Bay
    windQ = lerp([[0, 0], [4, 0.15], [8, 0.85], [10, 1], [16, 1], [18, 0.85], [22, 0.4], [28, 0.1]], kn);
    const gustQ = lerp([[0, 1], [5, 0.95], [8, 0.75], [12, 0.45], [16, 0.2]], Math.max(0, gust - kn));
    const sea = inner.waveM ?? open.waveM ?? 0;
    waterQ = lerp([[0, 1], [0.8, 0.9], [1.3, 0.5], [2, 0.15]], sea);
    score = 100 * suit * windQ * gustQ * (0.6 + 0.4 * waterQ);
    if (gust - kn >= 10) extra.push({ k: "bad", t: `Gusty: ${Math.round(kn)} kn gusting ${Math.round(gust)}` });
  } else if (act === "fishing") {
    // HEURISTIC: light-moderate wind, not too rough, around a tide turn, bonus at dawn/dusk
    windQ = lerp([[0, 1], [8, 1], [14, 0.6], [20, 0.25], [28, 0]], effWind);
    waterQ = lerp([[0, 1], [0.6, 0.9], [1.2, 0.5], [2, 0.2]], water);
    let turn = Infinity;
    for (const x of tides.list) turn = Math.min(turn, Math.abs(x.t - tAbs));
    const turnQ = lerp([[0, 1], [90, 0.9], [180, 0.65], [372, 0.5]], turn);
    const sr = hm(day.sunrise || "06:30"), ss = hm(day.sunset || "19:30");
    const lightB = Math.min(Math.abs(t - sr), Math.abs(t - ss)) <= 90 ? 1.1 : 1;
    score = 100 * suit * (0.45 * windQ + 0.3 * waterQ + 0.25 * turnQ) * lightB;
  } else if (act === "walking") {
    // HEURISTIC: not too windy on the sand, wider beach nearer low tide
    const eff = (kn * 0.6 + gust * 0.4) * EFF_HANG[rel];
    windQ = lerp([[0, 1], [10, 0.9], [18, 0.6], [28, 0.25]], eff);
    const h = tideHeight(tides, tAbs) ?? tides.hmin;
    const f = clamp((h - tides.hmin) / (tides.hmax - tides.hmin), 0, 1);
    waterQ = 1 - 0.35 * f;
    score = 100 * suit * (0.55 * windQ + 0.45 * waterQ);
  } else { // swim / family
    windQ = lerp([[0, 1], [6, 1], [10, 0.8], [15, 0.5], [20, 0.25], [28, 0.05]], effWind);
    waterQ = lerp([[0, 1], [0.3, 1], [0.5, 0.8], [0.8, 0.45], [1.2, 0.2], [2, 0.05]], water);
    score = 100 * suit * tideQ * (0.55 * windQ + 0.45 * waterQ);
  }
  score *= rainQ * storm;

  // DOC guidance for Goat Island: skip in E/NE wind over ~20 kn or E/NE swell over 1 m
  let docOff = null;
  if (b.doc) {
    const inDir = (d) => d != null && norm(d) >= b.doc.dirFromDeg && norm(d) <= b.doc.dirToDeg;
    if (inDir(dir) && kn > b.doc.maxWindKn) docOff = `${dir16(dir)} ${Math.round(kn)} kn`;
    else if (inDir(open.dirDeg) && (open.swellM ?? 0) > b.doc.maxSwellM) docOff = `${dir16(open.dirDeg)} swell ${open.swellM.toFixed(1)} m`;
    if (docOff) score = Math.min(score, 8);
  }
  return { t, slot, score: clamp(score, 0, 100), kn, gust, dir, rel, water, surfH, period, open, tideQ, tideMode, win, wet,
           rainMm: slot.rainMm ?? 0, rainProb: slot.rainProbPct, sky: slot.sky, docOff, extra };
}

function rating(score) {
  if (score >= 72) return { key: "great", label: "Great" };
  if (score >= 50) return { key: "good", label: "Good" };
  if (score >= 30) return { key: "meh", label: "Meh" };
  return { key: "nope", label: "Nope" };
}

/* Score every daylight hour for one beach on one day. */
function evalBeachDay(b, day, act, tides, ctx) {
  const sr = hm(day.sunrise || "06:30"), ss = hm(day.sunset || "19:30");
  const slots = (day.slotsByBeach?.[b.id] || day.slots || []).filter((s) => { const t = hm(s.time); return t >= sr - 30 && t <= ss + 15; });
  const traffic = b.viaMatakana && (ctx.weekend || !!day.traffic);
  const evals = slots.map((s) => {
    const e = evalSlot(b, day, s, act, tides);
    if (traffic) e.score *= 0.93;
    return e;
  });
  const dog = dogRule(b, day.date);
  const filters = [];
  if (b.driveMin > ctx.maxDrive) filters.push(`Too far · ${b.driveMin} min`);
  if (ctx.dog && dog.status === "banned") filters.push("Dogs banned");
  return { b, day, act, tides, ctx, sr, ss, evals, traffic, dog, filters, eligible: !filters.length };
}

/* Best window from `fromMin` onwards: contiguous good hours around the best hour, trimmed by daylight and,
   for high-tide beaches, by the mid-tide window. */
function pickWindow(R, fromMin = -Infinity, { nowMin = null } = {}) {
  let cand = R.evals.filter((e) => e.t >= fromMin);
  let done = false;
  if (!cand.length) { cand = R.evals; done = true; }
  if (!cand.length) return null;
  let bi = 0;
  cand.forEach((e, i) => { if (e.score > cand[bi].score) bi = i; });
  const best = cand[bi];
  const ok = (e) => e.score >= best.score - 12 && e.score >= best.score * 0.8;
  let lo = bi, hi = bi;
  while (lo > 0 && ok(cand[lo - 1])) lo--;
  while (hi < cand.length - 1 && ok(cand[hi + 1])) hi++;
  let start = Math.max(cand[lo].t - 30, R.sr), end = Math.min(cand[hi].t + 30, R.ss);
  let tideWin = null;
  if (best.tideMode === "high" && TIDE_ACTS.has(R.act) && best.win) {
    tideWin = { rise: localMin(R.tides, R.day.date, best.win.rise), fall: localMin(R.tides, R.day.date, best.win.fall), high: localMin(R.tides, R.day.date, best.win.high) };
    // The mid-tide window drives the time; only trim hours at its edges that are clearly poor (rain, wind).
    let s2 = Math.max(tideWin.rise, R.sr, fromMin === -Infinity ? R.sr : fromMin), e2 = Math.min(tideWin.fall, R.ss);
    const at = (m) => cand.find((e) => Math.abs(e.t - m) <= 30);
    const poor = (m) => { const e = at(m); return e && e.score < best.score * 0.6; };
    while (e2 - s2 > 30 && s2 < best.t - 30 && poor(s2 + 15)) s2 = Math.floor(s2 / 60) * 60 + 60;
    while (e2 - s2 > 30 && e2 > best.t + 30 && poor(e2 - 15)) e2 = Math.ceil(e2 / 60) * 60 - 60;
    if (e2 - s2 >= 30 && best.t >= s2 - 30 && best.t <= e2 + 30) { start = s2; end = e2; }
  }
  let nowStart = false;
  if (nowMin != null && !done && start <= nowMin) { start = nowMin; nowStart = true; }
  const inWin = cand.filter((e) => e.t >= start - 30 && e.t <= end + 30);
  const window = done ? "Earlier today" : nowStart ? `Now–${fmtTime(end)}` : fmtRange(start, end);
  const score = Math.round(best.score);
  return { ...R, best, score, rating: rating(score), start, end, window, done, nowStart, tideWin, inWin: inWin.length ? inWin : [best] };
}

/* ---------- summaries for chips ---------- */
function windSummary(es) {
  let x = 0, y = 0, lo = Infinity, hi = 0;
  for (const e of es) {
    x += Math.sin(e.dir * Math.PI / 180) * Math.max(e.kn, 0.5); y += Math.cos(e.dir * Math.PI / 180) * Math.max(e.kn, 0.5);
    lo = Math.min(lo, e.kn); hi = Math.max(hi, e.kn);
  }
  const dir = norm(Math.atan2(x, y) * 180 / Math.PI);
  return { dir, lo: Math.round(lo), hi: Math.round(hi), light: hi < 5 };
}
function rainSummary(es) {
  const prob = Math.max(0, ...es.map((e) => e.rainProb ?? 0));
  const mm = Math.max(0, ...es.map((e) => e.rainMm ?? 0));
  const wet = Math.max(0, ...es.map((e) => e.wet));
  return { prob, mm, wet, show: prob >= 30 || mm >= 0.2 };
}
const knText = (w) => w.lo === w.hi ? `${w.hi}` : `${w.lo}–${w.hi}`;

/* ---------- reasons + chips ---------- */
function reasons(r, act) {
  const e = r.best, out = [];
  const w = windSummary(r.inWin), rel = windRel(r.b, w.dir);
  const W = `${dir16(w.dir)} ${knText(w)} kn`;
  if (e.docOff) out.push({ k: "bad", t: `DOC: skip Goat Island (${e.docOff})` });
  // wind is shown in the Actual/Forecast boxes and the wind chip, so no wind bullet here

  const rs = rainSummary(r.inWin);
  if (rs.show) out.push({ k: rs.prob >= 60 || rs.mm >= 0.5 ? "bad" : "mid", t: `Rain ${rs.prob}% chance${rs.mm >= 0.1 ? `, ~${rs.mm.toFixed(1)} mm/h` : ""}` });

  if (act === "surf") {
    const h = e.surfH;
    out.push(h < 0.6 ? { k: "bad", t: `Swell ${h.toFixed(1)} m · ${Math.round(e.period)} s: too small` }
      : h < 0.8 ? { k: "mid", t: `Swell ${h.toFixed(1)} m · ${Math.round(e.period)} s: small` }
      : { k: "good", t: `Swell ${h.toFixed(1)} m · ${Math.round(e.period)} s` });
  } else if (act === "sailing") {
    const w = windSummary(r.inWin);
    out.push(w.hi < 7 ? { k: "bad", t: "Too light to sail" } : w.lo > 20 ? { k: "bad", t: "Too windy" } : { k: "good", t: `Sailable ${knText(w)} kn (heuristic)` });
  } else if (act === "fishing") {
    out.push({ k: "mid", t: "Fishing score: tide turn, dawn/dusk, calm (heuristic)" });
  } else if (act === "walking") {
    out.push({ k: "mid", t: "Walk score: wind + beach width (heuristic)" });
  } else if (act !== "hangout") {
    const h = e.water, flatT = act === "swim" ? 0.3 : 0.2;
    out.push(h < flatT ? { k: "good", t: "Flat water" } : h < 0.5 ? { k: act === "swim" ? "good" : "mid", t: `Small waves ~${h.toFixed(1)} m` } : { k: "bad", t: `Waves ~${h.toFixed(1)} m: lumpy` });
  }

  if (TIDE_ACTS.has(act)) {
    if (r.tideWin) {
      const inside = e.tideQ >= 0.9;
      out.push({ k: inside ? "good" : "bad", t: inside ? `Deep enough ~${fmtRange(r.tideWin.rise, r.tideWin.fall)} (mid-tide to mid-tide)` : `Too shallow: swimmable ~${fmtRange(r.tideWin.rise, r.tideWin.fall)}` });
    } else out.push({ k: "good", t: "Any tide" });
  }
  for (const x of e.extra) out.push(x);
  if (r.traffic) out.push({ k: "mid", t: "Weekend: Matakana queues" });
  if (r.b.doc && !e.docOff && act === "snorkel") out.push({ k: "good", t: "Within DOC limits" });
  return out.slice(0, 4);
}
function relClass(rel, kn, act) {
  if (act === "sailing") return kn >= 8 && kn <= 18 ? "good" : kn >= 5 && kn <= 22 ? "mid" : "bad";
  if (rel === "sheltered" || kn < 6) return "good";
  if (rel === "offshore") return act === "surf" || kn <= 15 ? "good" : "mid";
  if (rel === "onshore") return kn >= 10 || act === "surf" ? "bad" : "mid";
  return kn >= 14 ? "bad" : "mid";
}
function windChip(r, act, es = r.inWin) {
  const w = windSummary(es), rel = windRel(r.b, w.dir);
  if (w.light && act !== "sailing") return `<span class="chip c-good" title="Light and variable">${icon("wind")}Light <small>&lt;5 kn</small></span>`;
  return `<span class="chip c-${relClass(rel, w.hi, act)}" title="Wind from the ${dir16(w.dir)} (${rel}); arrow shows where it blows to">${arrow(w.dir)}${dir16(w.dir)} ${knText(w)}<small>kn</small></span>`;
}
function rainChip(es) {
  const rs = rainSummary(es);
  if (!rs.show) return "";
  return `<span class="chip c-${rs.prob >= 60 || rs.mm >= 0.5 ? "bad" : "mid"}" title="Chance of rain in this window">${icon("rain")}${rs.prob}<small>%</small></span>`;
}
function chips(r, act, prefs, { compact = false } = {}) {
  const e = r.best, c = [];
  if ((prefs.activities || []).length > 1) c.push(`<span class="chip c-act">${icon(ACT_ICON[act] || "dot")}${esc(ACT[act].label)}</span>`);
  c.push(windChip(r, act));
  const rc = rainChip(r.inWin); if (rc) c.push(rc);
  if (act === "surf") c.push(`<span class="chip c-${e.surfH >= 0.8 ? "good" : e.surfH >= 0.6 ? "mid" : "bad"}">${icon("wave")}${e.surfH.toFixed(1)}<small>m</small> · ${Math.round(e.period)}<small>s</small></span>`);
  else if (TIDE_ACTS.has(act)) c.push(`<span class="chip c-${e.water < 0.3 ? "good" : e.water < 0.5 ? "mid" : "bad"}">${icon("wave")}${e.water < 0.2 ? "Flat" : e.water.toFixed(1) + "<small>m</small>"}</span>`);
  if (TIDE_ACTS.has(act)) {
    if (r.tideWin) {
      const txt = r.tideWin.rise < r.start - 15 ? `Swimmable till ~${fmtTime(r.tideWin.fall)}` : `Swimmable from ~${fmtTime(r.tideWin.rise)}`;
      c.push(`<span class="chip c-${e.tideQ >= 0.9 ? "good" : "bad"}" title="Mid-tide ${fmtTime(r.tideWin.rise)}, high ${fmtTime(r.tideWin.high)}, mid-tide ${fmtTime(r.tideWin.fall)}">${icon("tide")}${txt}</span>`);
    } else if (!compact) c.push(`<span class="chip c-good">${icon("tide")}Any tide</span>`);
  }
  if (act === "hangout" && !compact) {
    const s = r.b.highTideSand || "some";
    c.push(`<span class="chip c-${s === "little" ? "mid" : "good"}" title="Dry sand left at high tide (local estimate)">${icon("sun")}${s === "little" ? "Little sand at high" : s === "some" ? "Some sand at high" : "Plenty of sand"}</span>`);
  }
  if (prefs.dog) {
    const s = r.dog.status, cls = s === "offlead" ? "good" : s === "banned" ? "bad" : "mid";
    c.push(`<span class="chip c-${cls}" title="${esc(r.dog.text)}">${icon("dog")}${esc(r.dog.chip)}</span>`);
  }
  if (!compact || r.b.driveMin > 15) c.push(`<span class="chip c-plain">${icon("car")}${r.b.driveMin}<small>min</small></span>`);
  if (r.traffic) c.push(`<span class="chip c-mid" title="${esc(r.day.traffic?.note || "Weekend traffic through Matakana")}">${icon("traffic")}Matakana</span>`);
  return `<div class="chips">${c.join("")}</div>`;
}
const bullets = (list) => !list.length ? "" : `<ul class="reasons">${list.map((x) => `<li class="r-${x.k}">${icon(x.k === "good" ? "check" : x.k === "bad" ? "x" : "dot")}<span>${esc(x.t)}</span></li>`).join("")}</ul>`;
const pill = (r) => `<span class="pill p-${r.rating.key}">${r.rating.label}</span>`;
function ring(score, key) {
  const C = 2 * Math.PI * 26, f = clamp(score, 0, 100) / 100;
  return `<svg class="ring k-${key}" viewBox="0 0 64 64" role="img" aria-label="Score ${score} out of 100"><circle cx="32" cy="32" r="26" class="ring-bg"/><circle cx="32" cy="32" r="26" class="ring-fg" stroke-dasharray="${(C * f).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 32 32)"/><text x="32" y="37" text-anchor="middle">${score}</text></svg>`;
}
const skyIcon = (s) => icon(s === "sun" ? "sun" : s === "partly" ? "partly" : s === "rain" || s === "showers" || s === "storm" ? "rain" : "cloud", `ic sky sky-${s || "cloud"}`);

/* ---------- now vs later ---------- */
/* Card heatline: inset bottom rail, one segment per hour (old rating colours), 1px gaps, past dimmed, now dot. */
const HX0 = 6 * 60, HX1 = 21 * 60, HP = (m) => ((clamp(m, HX0, HX1) - HX0) / (HX1 - HX0) * 100).toFixed(2);
function heatEdge(R, isToday, now, { labels = false } = {}) {
  const evals = R?.evals || [];
  if (!evals.length) return "";
  const W = (60 / (HX1 - HX0) * 100).toFixed(2);
  const segs = evals.filter((e) => e.t + 30 > HX0 && e.t - 30 < HX1).map((e) => {
    const k = rating(e.score);
    return `<i class="k-${k.key}${isToday && e.t + 30 <= now.min ? " past" : ""}" style="left:${HP(e.t - 30)}%;width:${W}%" title="${fmtTime(e.t)}: ${k.label}"></i>`;
  }).join("");
  const dot = isToday && now.min > HX0 && now.min < HX1 ? `<span class="hdot" style="left:${HP(now.min)}%"></span>` : "";
  const ax = labels ? `<div class="hax" aria-hidden="true"><span>6am</span><span>9</span><span>12pm</span><span>3</span><span>6</span><span>9pm</span></div>` : "";
  return `<div class="heat${labels ? " lbl" : ""}" role="img" aria-label="Hour by hour rating, 6am to 9pm">${ax}<div class="hrail">${segs}${dot}</div></div>`;
}
const fullOf = (res, r) => (res.all || []).find((a) => a.b.id === r.b.id && a.act === r.act) || r;
function nowLater(today, tomorrow, now, prefs) {
  const d = today.day, sr = hm(d.sunrise), ss = hm(d.sunset);
  const elig = today.all.filter((R) => R.eligible);
  let nowCard;
  if (now.min > ss) {
    const t = tomorrow?.picks[0];
    nowCard = `<article class="card nl dark"><span class="nl-tag">${icon("clock")}Right now</span><h4>It's dark</h4><p class="muted">Sunset was ~${fmtTime(ss)}.</p>${liveBasis(STATE.fc, now)}${t ? `<p class="nl-next">Tomorrow: <b>${bname(t.b)}</b> ${pill(t)}<br><span>${icon("clock")}${esc(t.window)}</span></p>` : ""}</article>`;
  } else if (now.min < sr - 30) {
    nowCard = `<article class="card nl dark"><span class="nl-tag">${icon("clock")}Right now</span><h4>Still dark</h4><p class="muted">Sunrise ~${fmtTime(sr)}.</p>${liveBasis(STATE.fc, now)}</article>`;
  } else {
    const hr = Math.min(Math.max(Math.round(now.min / 60) * 60, Math.ceil((sr - 30) / 60) * 60), ss);
    const cands = elig.map((R) => {
      const i = R.evals.findIndex((e) => Math.abs(e.t - hr) <= 30);
      if (i < 0) return null;
      const e = R.evals[i];
      const keep = Math.max(45, e.score * 0.8);
      let j = i; while (j + 1 < R.evals.length && R.evals[j + 1].score >= keep) j++;
      return { R, e, until: Math.min(R.evals[j].t + 30, ss), es: R.evals.slice(i, j + 1) };
    }).filter(Boolean).sort((a, b) => b.e.score - a.e.score);
    const c = cands[0];
    if (!c) nowCard = `<article class="card nl"><span class="nl-tag">${icon("clock")}Right now</span><h4>Nothing fits</h4></article>`;
    else {
      const sc = Math.round(c.e.score), rt = rating(sc);
      const fake = { ...c.R, best: c.e, inWin: [c.e], rating: rt };
      const tide = c.e.win && TIDE_ACTS.has(c.R.act)
        ? `<span class="chip c-${c.e.tideQ >= 0.9 ? "good" : "bad"}">${icon("tide")}${c.e.tideQ >= 0.9 ? "Deep enough" : `Swimmable from ~${fmtTime(localMin(c.R.tides, d.date, c.e.win.rise))}`}</span>` : "";
      nowCard = `<article class="card nl r-${rt.key}"><span class="nl-tag">${icon("clock")}Right now</span>
        <div class="rhead"><h4>${bname(c.R.b)}</h4>${pill(fake)}</div>
        <p class="when sm"><b>${sc < 30 ? "Not great anywhere" : `Good till ~${fmtTime(c.until)}`}</b></p>
        ${windPair(STATE.fc, d, c.R.b, now)}
        <div class="chips">${rainChip([c.e])}${tide}</div>${liveBasis(STATE.fc, now, c.R.b.id)}${heatEdge(c.R, true, now)}</article>`;
    }
  }
  // best later today: windows starting at least an hour from now
  let laterCard = "";
  if (now.min < ss - 60) {
    const later = elig.map((R) => pickWindow(R, Math.max(now.min + 60, sr))).filter((x) => x && !x.done).sort((a, b) => b.score - a.score)[0];
    if (later) laterCard = `<article class="card nl r-${later.rating.key}"><span class="nl-tag">${icon("clock")}Best later today</span>
      <div class="rhead"><h4>${bname(later.b)}</h4>${pill(later)}</div>
      <p class="when sm"><b>${esc(later.window)}</b></p>
      ${windPair(STATE.fc, d, later.b, now, { at: later.start })}
      ${chips(later, later.act, prefs, { compact: true })}${heatEdge(later, true, now)}</article>`;
  } else {
    const t = tomorrow?.picks[0];
    if (t && now.min <= ss) laterCard = `<article class="card nl r-${t.rating.key}"><span class="nl-tag">${icon("clock")}Tomorrow</span><div class="rhead"><h4>${bname(t.b)}</h4>${pill(t)}</div><p class="when sm"><b>${esc(t.window)}</b></p>${windPair(STATE.fc, t.day, t.b, now, { at: t.best.t })}${chips(t, t.act, prefs, { compact: true })}${heatEdge(fullOf(tomorrow, t), false, now)}</article>`;
  }
  return `<div class="nlgrid">${nowCard}${laterCard}</div>`;
}

/* Hour-by-hour coloured blocks for the top beaches, with a now marker. */
function timeline(today, now, { limit = 6, label = "Hour by hour, best beaches" } = {}) {
  const x0 = 6 * 60, x1 = 21 * 60, span = x1 - x0;
  const P = (m) => ((m - x0) / span * 100).toFixed(2);
  const rows = today.all.filter((R) => R.eligible)
    .map((R) => ({ R, top: Math.max(0, ...R.evals.map((e) => e.score)) }))
    .sort((a, b) => b.top - a.top).filter((x, i, arr) => arr.findIndex((y) => y.R.b.id === x.R.b.id) === i).slice(0, limit);
  const isToday = today.ctx.isToday;
  const nowM = isToday && now.min > x0 && now.min < x1 ? `<i class="tl-now" style="left:${P(now.min)}%"></i>` : "";
  const night = `<i class="tl-night" style="left:0;width:${P(clamp(today.sr, x0, x1))}%"></i><i class="tl-night" style="left:${P(clamp(today.ss, x0, x1))}%;right:0"></i>`;
  const axis = [6, 9, 12, 15, 18, 21].map((h) => `<span style="left:${P(h * 60)}%">${h === 12 ? "12pm" : h > 12 ? h - 12 + (h === 18 || h === 21 ? "pm" : "") : h + "am"}</span>`).join("");
  return `<section class="card tl${limit > 6 ? " full" : ""}" aria-label="${esc(label)}">
    <div class="tl-axis">${axis}</div>
    ${rows.map(({ R }) => `<div class="tl-row"><span class="tl-name">${bname(R.b)}</span><div class="tl-bar">${night}${R.evals.map((e) => {
      const k = rating(e.score).key, past = isToday && e.t + 30 < now.min;
      return `<i class="tl-b k-${k}${past ? " past" : ""}${e.wet >= 0.4 ? " wet" : ""}" style="left:${P(e.t - 30)}%;width:${(60 / span * 100).toFixed(2)}%" title="${fmtTime(e.t)}: ${rating(e.score).label}"></i>`;
    }).join("")}${nowM}</div></div>`).join("")}
    <p class="legend tl-legend"><span><i class="k-great"></i>Great</span><span><i class="k-good"></i>Good</span><span><i class="k-meh"></i>Meh</span><span><i class="k-nope"></i>Nope</span><span><i class="wetkey"></i>Rain</span></p>
  </section>`;
}

/* ---------- today's strip: hourly wind + tide curve ---------- */
function todayStrip(day, tides, ctx) {
  const x0 = 6 * 60, x1 = 20 * 60, Wd = 700, H = 92;
  const X = (m) => ((m - x0) / (x1 - x0)) * Wd;
  const slots = (day.slots || []).filter((s) => { const t = hm(s.time); return t > x0 && t < x1 && (t / 60) % 2 === 1; });
  const pts = [];
  for (let m = x0; m <= x1; m += 10) pts.push([X(m), tideHeight(tides, absMin(tides, day.date, m))]);
  let svg = "";
  if (pts.every((p) => p[1] != null)) {
    const hs = pts.map((p) => p[1]), hmin = Math.min(...hs, 0.3), hmax = Math.max(...hs, 3);
    const Y = (h) => H - 14 - ((h - hmin) / (hmax - hmin)) * (H - 34);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
    const sr = hm(day.sunrise || "06:30"), ss = hm(day.sunset || "19:30");
    let marks = "";
    for (const t of day.tides || []) {
      const m = hm(t.time); if (m < x0 || m > x1) continue;
      const y = Y(t.heightM), lx = clamp(X(m) / Wd * 100, 9, 91);
      marks += `<i class="tdot ${t.type}" style="left:${(X(m) / Wd * 100).toFixed(2)}%;top:${(y / H * 100).toFixed(2)}%"></i><span class="tlbl ${t.type}" style="left:${lx.toFixed(2)}%;top:${(y / H * 100).toFixed(2)}%">${t.type === "high" ? "High" : "Low"} ${fmtTime(m)}</span>`;
    }
    const night = `<rect x="0" y="0" width="${Math.max(0, X(sr)).toFixed(1)}" height="${H}" class="night"/><rect x="${Math.min(Wd, X(ss)).toFixed(1)}" y="0" width="${Math.max(0, Wd - X(ss)).toFixed(1)}" height="${H}" class="night"/>`;
    const showNow = ctx.isToday && ctx.nowMin > x0 && ctx.nowMin < x1;
    const now = showNow ? `<line x1="${X(ctx.nowMin).toFixed(1)}" x2="${X(ctx.nowMin).toFixed(1)}" y1="2" y2="${H}" class="nowline"/>` : "";
    const nowLbl = showNow ? `<span class="nowlbl" style="left:${(X(ctx.nowMin) / Wd * 100).toFixed(2)}%">now</span>` : "";
    svg = `<svg class="tidecurve" viewBox="0 0 ${Wd} ${H}" preserveAspectRatio="none" role="img" aria-label="Tide curve for today">${night}<path d="${line}L${Wd},${H}L0,${H}Z" class="tfill"/><path d="${line}" class="tline"/>${now}</svg><div class="tidelabels" aria-hidden="true">${marks}${nowLbl}</div>`;
  }
  const cols = slots.map((s) => {
    const past = ctx.isToday && hm(s.time) < ctx.nowMin - 60;
    const p = s.rainProbPct;
    return `<div class="hr${past ? " past" : ""}" style="left:${(X(hm(s.time)) / Wd * 100).toFixed(2)}%"><span class="t">${fmtTime(hm(s.time)).replace(":00", "")}</span>${skyIcon(s.sky)}<span class="pp">${p != null && p >= 20 ? p + "%" : "&nbsp;"}</span>${s.windKn < 5 ? `<span class="lt">light</span>` : arrow(s.windDirDeg)}<b>${Math.round(s.windKn)}</b><span class="d">${s.windKn < 5 ? "var" : dir16(s.windDirDeg)}</span></div>`;
  }).join("");
  return `<section class="card strip" aria-label="Today hour by hour"><div class="hours">${cols}</div><div class="tidewrap">${svg}</div><p class="legend"><span>${icon("tide")}Tide · Mahurangi Harbour</span><span>rain % · wind kn (arrow = blowing to)</span></p></section>`;
}

/* ---------- live station readings ---------- */
function obsMean(stations) {
  let x = 0, y = 0, kn = 0, g = [], rain = 0, n = 0;
  for (const s of stations) {
    n++; kn += s.windKn; if (s.gustKn != null) g.push(s.gustKn);
    if (s.windDirDeg != null) { x += Math.sin(s.windDirDeg * Math.PI / 180) * Math.max(s.windKn, 0.5); y += Math.cos(s.windDirDeg * Math.PI / 180) * Math.max(s.windKn, 0.5); }
    rain = Math.max(rain, s.rainRateMmH ?? 0);
  }
  return n ? { kn: kn / n, gust: g.length ? g.reduce((a, b) => a + b) / g.length : null, dir: x || y ? norm(Math.atan2(x, y) * 180 / Math.PI) : null, rain } : null;
}
function obsMinutes(iso, dayIso) {   // "2026-10-17T13:05:00+13:00" -> local minutes on dayIso, or null
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  return m && m[1] === dayIso ? +m[2] * 60 + +m[3] : null;
}
/* Live-first "now": a fresh (≤ 90 min) home-station reading REPLACES the current hour's wind, gust,
   direction and rain, then fades back to the forecast over ~3 h. Tide and swell stay from the models.
   Local stations (Algies IWARKW15, Snells ISNELL2) are preferred; several are combined by median.
   An airport reading is too far away to use, so then everything stays forecast-based. */
const LOCAL_IDS = ["IWARKW15", "ISNELL2"];
const NEAR_KM = 7, FAR_KM = 15;   // per-beach station radius: median of the nearest two within 7 km, else nearest within 15 km
const median = (xs) => { const v = xs.filter((x) => x != null).sort((p, q) => p - q); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const kmBetween = (a, b) => { const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r); return R * Math.hypot(dLa, dLo); };
function freshHome(fc, now) {
  const o = fc.observations;
  if (!o?.stations?.length) return { mode: "none" };
  if (o.kind !== "home") return { mode: "airport", label: o.stations[0].name };
  const fresh = o.stations.map((s) => ({ s, t: obsMinutes(s.time, now.date) })).filter((x) => x.t != null && now.min - x.t <= 90 && now.min - x.t >= -15);
  return fresh.length ? { mode: "live", fresh } : { mode: "stale" };
}
function combine(list, why) {
  const use = list.map((x) => x.s);
  const kn = median(use.map((s) => s.windKn)), gust = median(use.map((s) => s.gustKn));
  let x = 0, y = 0;
  for (const s of use) if (s.windDirDeg != null && s.windKn >= 1) { x += Math.sin(s.windDirDeg * Math.PI / 180) * s.windKn; y += Math.cos(s.windDirDeg * Math.PI / 180) * s.windKn; }
  return { mode: "live", kn, gust, dir: x || y ? norm(Math.atan2(x, y) * 180 / Math.PI) : null, rain: median(use.map((s) => s.rainRateMmH)),
           t0: Math.max(...list.map((q) => q.t)), stations: use, why, label: [...new Set(use.map((s) => s.name))].join(", ") };
}
/* Which live reading drives "now" at a beach: nearest fresh station(s), else the Algies/Snells median, else forecast. */
function liveNow(fc, now, beach = null) {
  const F = freshHome(fc, now);
  if (F.mode !== "live") return F;
  if (beach?.lat != null) {
    const near = F.fresh.filter((x) => x.s.lat != null).map((x) => ({ ...x, km: kmBetween(beach, x.s) })).sort((p, q) => p.km - q.km);
    const close = near.filter((x) => x.km <= NEAR_KM).slice(0, 2);
    if (close.length) return combine(close, "nearest");
    if (near[0] && near[0].km <= FAR_KM) return combine([near[0]], "nearest");
  }
  const local = F.fresh.filter((x) => LOCAL_IDS.includes(x.s.id));
  return combine(local.length ? local : F.fresh, "local");
}
function applyLive(slots, L, now) {
  return slots.map((sl0) => {
    const dt = hm(sl0.time) - now.min;             // minutes ahead of now
    if (dt < -30 || dt >= 180) return sl0;          // only the current hour and the next ~3 h
    const sl = { ...sl0 };
    const w = dt <= 30 ? 1 : lerp([[30, 1], [90, 0.8], [150, 0.4], [180, 0]], dt);
    const k0 = sl.windKn;
    if (L.kn != null) sl.windKn = +(k0 * (1 - w) + L.kn * w).toFixed(1);
    if (L.gust != null) sl.gustKn = +(((sl.gustKn ?? k0) * (1 - w)) + Math.max(L.gust, L.kn ?? 0) * w).toFixed(1);
    if (L.dir != null && sl.windDirDeg != null) {
      const a = sl.windDirDeg * Math.PI / 180, b = L.dir * Math.PI / 180;
      sl.windDirDeg = Math.round(norm(Math.atan2(Math.sin(a) * (1 - w) + Math.sin(b) * w, Math.cos(a) * (1 - w) + Math.cos(b) * w) * 180 / Math.PI));
    }
    if (L.rain != null) {
      const p = L.rain >= 0.2 ? 95 : L.rain > 0 ? 60 : 0;
      sl.rainMm = +(((sl.rainMm ?? 0) * (1 - w)) + L.rain * w).toFixed(1);
      sl.rainProbPct = Math.round((sl.rainProbPct ?? 0) * (1 - w) + p * w);
    }
    sl.obsAdj = w;
    return sl;
  });
}
function blendObservations(fc, now, beaches = STATE?.beaches) {
  const day = fc.days.find((d) => d.date === now.date);
  if (day && !day.fcSlots) day.fcSlots = day.slots || [];
  if (day) { day.slots = day.fcSlots; day.slotsByBeach = {}; }
  fc.liveByBeach = {};
  const L = liveNow(fc, now);
  fc.liveNow = L;
  if (L.mode !== "live" || !day) return;
  day.slots = applyLive(day.fcSlots, L, now);    // the "at a glance" strip uses the Algies/Snells reading
  for (const b of beaches?.beaches || []) {
    const Lb = liveNow(fc, now, b);
    fc.liveByBeach[b.id] = Lb;
    day.slotsByBeach[b.id] = applyLive(day.fcSlots, Lb, now);
  }
  fc.observations.applied = true;
}
/* Actual (live station) vs Forecast wind for one beach, side by side: label, arrow (blowing to), compass, kn, gust. */
function windCell(label, kn, dir, gust, cls, foot = "") {
  if (kn == null) return `<div class="wcell ${cls} none"><span class="wlbl">${label}</span><span class="wval">n/a</span>${foot ? `<span class="wgust">${foot}</span>` : ""}</div>`;
  const calm = kn < 1 || dir == null;
  const g = gust != null && gust >= 1 ? `gust ${Math.round(gust)}` : "";
  return `<div class="wcell ${cls}"><span class="wlbl">${label}</span><span class="wval">${calm ? icon("wind") : arrow(dir)}<b>${calm ? "Calm" : dir16(dir)}</b> ${calm ? "" : Math.round(kn) + "<small>kn</small>"}</span><span class="wgust">${[g, foot].filter(Boolean).join(" · ")}</span></div>`;
}
const nearestSlot = (slots, t) => slots.reduce((a, s) => (!a || Math.abs(hm(s.time) - t) < Math.abs(hm(a.time) - t) ? s : a), null);
/* today: Actual (this beach's live stations) + Forecast (model, current hour, or the card's window if it starts later);
   other days: Forecast only, at the card's best hour. */
function windPair(fc, day, b, now, { at = null } = {}) {
  const src = day.fcSlots || day.slots || [];
  const isToday = day.date === now.date;
  const hrNow = Math.round(now.min / 60) * 60;
  let ft = isToday ? hrNow : (at ?? 12 * 60), flabel = "Forecast";
  if (at != null && (!isToday || at > now.min + 45)) { ft = at; flabel = `Forecast ${fmtTime(at)}`; }
  else if (isToday) flabel = "Forecast now";
  const f = src.length ? nearestSlot(src, ft) : null;
  const fcst = f ? windCell(flabel, f.windKn, f.windDirDeg, f.gustKn, "fc") : windCell(flabel, null, null, null, "fc");
  if (!isToday) return `<div class="wpair one" aria-label="Wind forecast">${fcst}</div>`;
  const L = fc.liveByBeach?.[b.id] || fc.liveNow;
  let actual;
  if (L?.mode === "live") {
    const names = [...new Set(L.stations.map((x) => x.name))];
    actual = windCell(`Actual ${fmtTime(L.t0)}`, L.kn, L.dir, L.gust, "act", L.why === "local" ? "Algies/Snells" : names.slice(0, 2).join(", "));
  } else {
    const why = L?.mode === "airport" ? "airport only" : L?.mode === "stale" ? "readings old" : "no live data";
    actual = windCell("Actual", null, null, null, "act", why);
  }
  return `<div class="wpair" aria-label="Wind: actual vs forecast">${actual}${fcst}</div>`;
}
function liveBasis(fc, now, beachId = null) {
  const L = (beachId && fc.liveByBeach?.[beachId]) || fc.liveNow || {};
  if (L.mode === "live") return `<p class="basis live">${icon("wind")}Based on live readings (${esc(L.label)}, ${fmtTime(L.t0)})</p>`;
  if (L.mode === "airport") return `<p class="basis">${icon("dot")}Forecast-based: only a distant airport reading is live</p>`;
  if (L.mode === "stale") return `<p class="basis">${icon("dot")}Forecast-based: home-station readings are over 90 min old</p>`;
  return `<p class="basis">${icon("dot")}Forecast-based: no live readings right now</p>`;
}


/* Word for rain that respects both the tip rate and the next few forecast hours.
   Station mm/h often under-reads a wet afternoon, so "0.5 mm/h" must not win over a stormy forecast. */
function rainWord(liveMm, day, now) {
  const slots = day?.slots || [];
  const upcoming = slots.filter((s) => { const t = hm(s.time); return t >= now.min - 30 && t <= now.min + 180; });
  const maxMm = Math.max(liveMm ?? 0, 0, ...upcoming.map((s) => s.rainMm ?? 0));
  const maxProb = Math.max(0, ...upcoming.map((s) => s.rainProbPct ?? 0));
  const storm = upcoming.some((s) => s.sky === "storm");
  const wetNow = (liveMm ?? 0) > 0.05 || upcoming.slice(0, 2).some((s) => (s.rainMm ?? 0) >= 0.2 || (s.rainProbPct ?? 0) >= 70);
  if (storm || maxMm >= 4 || (maxProb >= 90 && maxMm >= 2)) return wetNow ? "Heavy rain" : "Heavy rain later";
  if (maxMm >= 1.2 || (maxProb >= 85 && maxMm >= 0.8)) return wetNow ? "Rain" : "Rain later";
  if (maxMm >= 0.3 || (liveMm ?? 0) > 0.05 || maxProb >= 60) return wetNow ? "Showers" : "Showers likely";
  if (maxProb >= 40) return "Rain possible";
  return "Dry";
}

function headerLive(fc, now, day) {
  const F = freshHome(fc, now);
  let air = null, windHtml = "", rainHtml = "", when = "", where = "";
  if (F.mode === "live") {
    const snells = F.fresh.filter((x) => /snells/i.test(x.s.name || "") || /^ISNELL/i.test(x.s.id || ""));
    const local = F.fresh.filter((x) => LOCAL_IDS.includes(x.s.id));
    const L = combine(snells.length ? snells : (local.length ? local : F.fresh), snells.length ? "snells" : "local");
    const temps = L.stations.map((s) => s.airC).filter((t) => t != null);
    air = temps.length ? Math.round(median(temps)) : null;
    where = snells.length ? "at home" : "nearby";
    when = fmtTime(L.t0);
    if (L.kn != null) {
      windHtml = L.kn < 1
        ? `${icon("wind")}<b>Calm</b>`
        : `${L.dir != null ? arrow(L.dir) : icon("wind")}<b>${L.dir != null ? dir16(L.dir) + " " : ""}${Math.round(L.kn)}</b><small>kn</small>${L.gust != null && L.gust > L.kn + 1 ? ` <small>g${Math.round(L.gust)}</small>` : ""}`;
    }
    const word = rainWord(L.rain, day, now);
    rainHtml = `${icon(word === "Dry" ? "sun" : "rain")}<b>${word}</b>`;
  } else if (day) {
    const word = rainWord(0, day, now);
    rainHtml = `${icon(word === "Dry" ? "sun" : "rain")}<b>${word}</b>`;
  }
  return { air, windHtml, rainHtml, when, where, live: F.mode === "live" };
}

/* Header rain heatline: last 24 clock hours ending now, from data/rain_history.json.
   Station hours solid, model hours hatched (estimates), hours with no data left as gaps. */
const RAIN_STEPS = [[0.05, 0], [0.5, 1], [2, 2], [5, 3], [Infinity, 4]];
function rainHistoryLine(rh) {
  if (!rh || !Array.isArray(rh.hours)) return "";
  const HMS = 3.6e6, end = Math.floor(Date.now() / HMS) * HMS;
  const by = new Map(rh.hours.map((h) => [Math.floor(new Date(h.start).getTime() / HMS) * HMS, h]));
  const hf = new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, weekday: "short", hour: "numeric" });
  const lab = (t) => hf.format(new Date(t)).replace(/\s?([ap]m)/i, "$1").replace(",", "");
  let total = 0, any = false, est = false;
  const cells = [];
  for (let i = 23; i >= 0; i--) {
    const t = end - i * HMS, h = by.get(t);
    const span = `${lab(t)}–${i ? lab(t + HMS).replace(/^\S+\s/, "") : "now"}`;
    if (!h || typeof h.mm !== "number") { cells.push(`<i class="rh-gap" title="${esc(span)}: no data"></i>`); continue; }
    any = true; total += h.mm;
    const model = h.src !== "station"; if (model) est = true;
    const lvl = RAIN_STEPS.find(([lim]) => h.mm < lim)[1];
    cells.push(`<i class="rh-${lvl}${model ? " rh-est" : ""}" title="${esc(span)}: ${h.mm} mm${model ? " (model estimate)" : ""}"></i>`);
  }
  const tot = !any ? "no data" : `${est ? "≈" : ""}${total < 9.95 ? (Math.round(total * 10) / 10) : Math.round(total)} mm`;
  return `<div class="rainhist" role="img" aria-label="Rain over the last 24 hours: ${esc(tot)}${est ? ", some hours are model estimates" : ""}">
      <div class="rh-head"><span>${icon("rain")}Rain, last 24h</span><b>${esc(tot)}</b></div>
      <div class="rh-cells">${cells.join("")}</div>
      <div class="rh-ax" aria-hidden="true"><span>${esc(lab(end - 23 * HMS))}</span>${est ? `<span class="rh-key"><i class="rh-2 rh-est"></i>estimate</span>` : ""}<span>now</span></div>
    </div>`;
}

function liveCard(fc, now) {
  const o = fc.observations;
  if (!o?.stations?.length) return "";
  const home = o.kind === "home";
  const rows = o.stations.slice(0, 12).map((s) => {
    const t = obsMinutes(s.time, now.date);
    const old = t == null || now.min - t > 120;
    const wind = s.windKn < 1 ? `${icon("wind")}Calm` : `${s.windDirDeg != null ? arrow(s.windDirDeg) : icon("wind")}${s.windDirDeg != null ? dir16(s.windDirDeg) + " " : ""}${Math.round(s.windKn)}<small>kn</small>${s.gustKn ? ` <small>gust ${Math.round(s.gustKn)}</small>` : ""}`;
    const c = [`<span class="chip c-plain">${wind}</span>`];
    if (s.airC != null) c.push(`<span class="chip c-plain c-temp">${icon("temp")}${Math.round(s.airC)}°</span>`);
    if (s.pressureHpa != null) c.push(`<span class="chip c-plain c-pres">${Math.round(s.pressureHpa)}<small>hPa</small></span>`);
    const rr = s.rainRateMmH;
    if (rr != null && rr > 0) {
      const w = rr >= 4 ? "Heavy" : rr >= 1.2 ? "Rain" : rr >= 0.3 ? "Showers" : "Drizzle";
      c.push(`<span class="chip c-bad">${icon("rain")}${w} ${rr}<small>mm/h</small></span>`);
    } else if (s.raining) c.push(`<span class="chip c-bad">${icon("rain")}Raining</span>`);
    else if (rr === 0 || s.raining === false) c.push(`<span class="chip c-good">${icon("sun")}Dry</span>`);
    return `<li><a href="${esc(s.url)}" rel="noopener"><b>${esc(s.name)}</b></a> <small class="muted">${t != null ? fmtTime(t) : "earlier"}${old ? " · old" : ""}</small><div class="chips">${c.join("")}</div></li>`;
  }).join("");
  const head = home ? `Live from ${o.stations.length} home station${o.stations.length > 1 ? "s" : ""}` : "Live reading · airport";
  const note = home ? (o.applied ? "Used as the wind and rain for right now, fading back to the forecast over ~3 h." : "Shown only; too old to change the scores.") : "This airport is a long way from Snells, so it's shown but not used in the scores.";
  return `<section class="card live${home ? "" : " far"}" aria-label="Live station readings"><h3>${icon("wind")}${head}</h3><ul>${rows}</ul><p class="muted sm">${note}</p></section>`;
}

/* ---------- render ---------- */
let STATE = null;
const bname = (b) => esc(b.name);

function render() {
  const { beaches, fc, prefs } = STATE;
  const now = nzNow();
  const app = $("#app");
  const acts = prefs.activities, act = acts[0];
  const actLabel = acts.map((a) => ACT[a].label.toLowerCase()).join(", ");
  const stops = beaches.drive?.stops || [{ label: "Local", maxMin: 15 }, { label: "Nearby", maxMin: 35 }, { label: "Road trip", maxMin: 999 }];
  const stop = stops[clamp(prefs.drive, 0, stops.length - 1)];
  $("#driveLabel").textContent = stop.maxMin >= 999 ? `${stop.label} · any distance` : `${stop.label} · ≤${stop.maxMin} min`;

  const tides = buildTides(fc.days);
  let days = fc.days.filter((d) => d.date >= now.date);
  const stale = !days.length;
  if (stale) days = fc.days.slice(-1);
  const updated = new Date(fc.updated);
  const ageH = (Date.now() - updated.getTime()) / 3.6e6;

  const results = days.slice(0, 4).map((day) => {
    const ctx = { isToday: day.date === now.date, nowMin: now.min, weekend: isWeekend(day.date), maxDrive: stop.maxMin, dog: prefs.dog };
    const from = ctx.isToday ? now.min - 30 : -Infinity;
    // every selected activity is scored; each beach shows the activity it suits best right then
    const all = [], picks = [];
    for (const b of beaches.beaches) {
      let bestR = null, bestP = null;
      for (const a of acts) {
        const Ra = evalBeachDay(b, day, a, tides, ctx);
        if (!Ra.evals.length) continue;
        const Pa = pickWindow(Ra, from, { nowMin: ctx.isToday ? now.min : null });
        if (Pa && (!bestP || (bestP.done && !Pa.done) || (Pa.done === bestP.done && Pa.score > bestP.score))) { bestR = Ra; bestP = Pa; }
      }
      if (bestR) { all.push(bestR); picks.push(bestP); }
    }
    picks.sort((a, b) => (b.eligible - a.eligible) || (a.done - b.done) || (b.score - a.score) || ((b.end - b.start) - (a.end - a.start)) || (a.b.driveMin - b.b.driveMin));
    const sr = hm(day.sunrise || "06:30"), ss = hm(day.sunset || "19:30");
    return { day, ctx, all, picks, sr, ss };
  });

  const today = results[0];
  const dLabel = (d, ctx) => ctx.isToday ? "Today" : (dayNum(d.date) - dayNum(now.date) === 1 ? "Tomorrow" : fmtDate(d.date, { weekday: "long" }));
  $("#title").textContent = today.ctx.isToday ? `Where to ${acts.length === 1 ? ACT[act].verb : "go"} today` : `Where to ${acts.length === 1 ? ACT[act].verb : "go"} · ${fmtDate(today.day.date, { weekday: "long" })}`;
  const updHM = new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(updated).replace(" ", "");
  const HL = today.ctx.isToday ? headerLive(fc, now, today.day) : { air: null, windHtml: "", rainHtml: "", when: "", where: "", live: false };
  const airNum = HL.air != null ? HL.air : (today.day.airMaxC != null ? Math.round(today.day.airMaxC) : null);
  const airKind = HL.air != null ? "" : (today.day.airMaxC != null ? " high" : "");
  const meta = [
    HL.windHtml,
    HL.rainHtml,
    today.day.waterTempC != null ? `${icon("wave")}<b>${Math.round(today.day.waterTempC)}°</b><small> water</small>` : "",
  ].filter(Boolean).join('<span class="sep">·</span>');
  const foot = [
    HL.live && HL.when ? `Live ${HL.where} ${HL.when}` : `Updated ${updHM}`,
    fmtDate(today.day.date, { weekday: "short", day: "numeric", month: "short" }),
    `${fmtTime(hm(today.day.sunrise))}–${fmtTime(hm(today.day.sunset))}`,
  ].filter(Boolean).join(" · ");
  $("#subtitle").innerHTML = `<div class="head-live">
      ${airNum != null ? `<div class="head-temp">${airNum}<small>°${airKind}</small></div>` : ""}
      <div class="head-meta">${meta}</div>
    </div>
    ${rainHistoryLine(STATE.rain)}
    <div class="head-foot"><span class="updlbl">${icon("clock")}${esc(foot)}</span></div>`;

  let html = "";
  if (OFFLINE["data/forecast.json"]) {
    const sameDay = updated.toLocaleDateString("en-CA", { timeZone: TZ }) === now.date;
    const when = updated.toLocaleString("en-NZ", { timeZone: TZ, ...(sameDay ? {} : { weekday: "short" }), hour: "numeric", minute: "2-digit" }).replace(/\s?([ap]m)/i, "$1").replace(",", "");
    html += `<div class="notice offline">${icon("clock")}<span>Offline · data from ${esc(when)}</span></div>`;
  }
  if (stale || ageH > 30) {
    html += `<div class="notice warn">${icon("clock")}<span>This forecast is from <b>${esc(updated.toLocaleString("en-NZ", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</b>. The morning update hasn't run yet, so treat it as a rough guide.</span></div>`;
  }

  const heur = acts.filter((a) => ACT[a].heuristic);
  if (heur.length) html += `<div class="notice">${icon("dot")}<span>${esc(heur.map((a) => ACT[a].label).join(", "))}: rough heuristic scores, not proper forecasts for ${heur.length > 1 ? "these" : "this"}.</span></div>`;
  const elig = today.picks.filter((r) => r.eligible);
  if (acts.includes("snorkel")) {
    const goat = today.picks.find((r) => r.b.doc);
    if (goat?.best.docOff) html += `<div class="notice bad">${icon("x")}<span><b>Goat Island is off today</b>: ${esc(goat.best.docOff)}. DOC says skip it in E/NE wind over ~20 kn or E/NE swell over 1 m.</span></div>`;
    else if (goat && !goat.eligible) html += `<div class="notice">${icon("dot")}<span>Goat Island is the snorkel spot, but it's hidden: ${esc(goat.filters.join(", ").toLowerCase())}.</span></div>`;
  }

  if (!elig.length) {
    html += `<section class="hero r-nope"><h2>Nothing fits</h2><p class="when">Every beach is filtered out by your settings. Try a longer drive${prefs.dog ? " or leave the dog home" : ""}.</p></section>`;
  } else {
    const top = elig[0];
    const lowNote = top.score < 30 ? `<p class="lownote">Nothing's really on for ${esc(actLabel)}. This is the least-bad option.</p>` : "";
    html += `<div class="topgrid"><section class="hero r-${top.rating.key}" aria-label="Top pick">
      <div class="hero-head"><div><span class="badge">${today.ctx.isToday ? "Today's pick" : esc(dLabel(today.day, today.ctx)) + "'s pick"}</span>${pill(top)}</div>${ring(top.score, top.rating.key)}</div>
      <h2>${bname(top.b)}</h2>
      <p class="when">${icon("clock")}<span>${top.done ? "" : "Best "}<b>${esc(top.window)}</b></span></p>
      ${windPair(fc, today.day, top.b, now, { at: top.done ? null : top.start })}
      ${chips(top, top.act, prefs)}
      ${bullets(reasons(top, top.act))}
      ${lowNote}
      ${heatEdge(fullOf(today, top), today.ctx.isToday, now, { labels: true })}
    </section>`;
    const ru = elig.slice(1, 3);
    html += `<div class="side">`;
    if (ru.length) {
      html += `<h3 class="sec">${ru.every((r) => r.score >= 50) ? (today.ctx.isToday ? "Also good today" : "Also good") : "Next best"}</h3><div class="runners">${ru.map((r) => `
        <article class="card runner r-${r.rating.key}">
          <div class="rhead"><h4>${bname(r.b)}</h4>${pill(r)}</div>
          <p class="when sm">${icon("clock")}<b>${esc(r.window)}</b></p>
          ${windPair(fc, today.day, r.b, now, { at: r.done ? null : r.start })}
          ${chips(r, r.act, prefs, { compact: true })}
          ${bullets(reasons(r, r.act).slice(0, 2))}
          ${heatEdge(fullOf(today, r), today.ctx.isToday, now)}
        </article>`).join("")}</div>`;
    }
    html += `</div></div>`;
  }

  if (today.ctx.isToday) {
    html += `<h3 class="sec" id="nowlater">Now vs later</h3>` + nowLater(today, results[1], now, prefs) + timeline(today, now);
  }
  if (today.ctx.isToday || stale) html += `<h3 class="sec">${stale ? "Last forecast day" : "Today"} at a glance</h3>` + todayStrip(today.day, tides, today.ctx);

  const ahead = results.slice(1, 4);
  if (ahead.length) {
    html += `<h3 class="sec">Next days</h3><div class="days">${ahead.map((res) => {
      const { day, ctx, picks } = res;
      const top = picks.find((r) => r.eligible);
      const mid = (day.slots || []).reduce((a, s) => (a && Math.abs(hm(a.time) - 13 * 60) < Math.abs(hm(s.time) - 13 * 60) ? a : s), null);
      const wk = ctx.weekend ? `<span class="tag">Weekend</span>` : "";
      if (!top) return `<article class="card day"><div class="dhead"><h4>${esc(dLabel(day, ctx))}</h4>${wk}</div><p class="muted">Nothing fits your filters.</p></article>`;
      return `<article class="card day r-${top.rating.key}">
        <div class="dhead"><div><h4>${esc(dLabel(day, ctx))}</h4><span class="muted">${esc(fmtDate(day.date, { day: "numeric", month: "short" }))}</span></div>${wk}<span class="wx">${mid ? skyIcon(mid.sky) : ""}${day.airMaxC != null ? Math.round(day.airMaxC) + "°" : ""}</span></div>
        <div class="dpick"><span class="dname">${bname(top.b)}</span>${pill(top)}</div>
        <p class="when sm">${icon("clock")}<b>${esc(top.window)}</b></p>
        ${windPair(fc, day, top.b, now, { at: top.best.t })}
        ${chips(top, top.act, prefs, { compact: true })}
        ${bullets(reasons(top, top.act).slice(0, 2))}
        ${heatEdge(fullOf(res, top), false, now)}
      </article>`;
    }).join("")}</div>`;
  }

  html += `<h3 class="sec">All beaches · ${today.ctx.isToday ? "today" : esc(fmtDate(today.day.date, { weekday: "short" }))}</h3><div class="list">${today.picks.map((r) => {
    const dogLine = r.dog ? `<p class="dogrule">${icon("dog")}<span>${esc(r.dog.text)}${r.b.dog?.source ? ` · <a href="${esc(r.b.dog.source)}" rel="noopener">source</a>` : ""}${r.b.dog?.verified === false ? " · <b>unverified, check signs</b>" : ""}</span></p>` : "";
    return `<details class="row ${r.eligible ? "r-" + r.rating.key : "off"}">
      <summary>
        <span class="rname"><b>${bname(r.b)}</b><small>${esc(r.b.area)} · ${r.b.driveMin} min</small></span>
        ${r.eligible ? `<span class="bar"><i style="width:${r.score}%"></i></span><span class="rs">${r.score}</span>${pill(r)}` : `<span class="why">${esc(r.filters.join(" · "))}</span>`}
        ${r.eligible ? heatEdge(fullOf(today, r), today.ctx.isToday, now) : ""}
      </summary>
      <div class="rbody">
        <p class="when sm">${icon("clock")}<b>${esc(r.window)}</b></p>
        ${windPair(fc, today.day, r.b, now, { at: r.done ? null : r.start })}
        ${chips(r, r.act, { ...prefs, dog: true })}
        ${bullets(reasons(r, r.act))}
        <ul class="notes">${(r.b.notes || []).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
        ${dogLine}
      </div>
    </details>`;
  }).join("")}</div>`;

  if (today.ctx.isToday && today.all.some((R) => R.eligible)) html += `<h3 class="sec">Hour by hour · every beach</h3>` + timeline(today, now, { limit: 99, label: "Hour by hour, every beach that fits" });
  if (today.ctx.isToday) html += liveCard(fc, now);   // live station readings sit at the bottom
  app.innerHTML = html;

  const src = (fc.sources || []).map((s) => `<li><b>${esc(s.what)}</b>: ${s.url ? `<a href="${esc(s.url)}" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</li>`).join("");
  $("#foot").innerHTML = `
    <p class="upd">${icon("clock")}Updated ${esc(updated.toLocaleString("en-NZ", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))} NZT</p>
    <ul class="srcs">${src}
      <li><b>Drive times</b>: ${esc(beaches.drive?.source || "")}, from ${esc(beaches.origin?.name || "Snells Beach")}</li>
      <li><b>Dog rules</b>: Auckland Council park pages and DOC, checked ${esc(beaches.beaches[0]?.dog?.checked || "")}. Tap a beach for its rule and link.</li>
    </ul>
    <p class="muted">Wind is a blend of met.no and Open-Meteo; arrows point where the wind blows to. Times are rounded to the half hour. Scores are a rough guide: check <a href="https://safeswim.org.nz/" rel="noopener">Safeswim</a> and the signs at the beach.</p>`;
}

/* Auto-refresh: new forecast -> re-render in place; new site code -> full reload. */
let refreshing = false, lastCheck = 0;
async function refresh() {
  if (refreshing || Date.now() - lastCheck < 20000) return;
  refreshing = true; lastCheck = Date.now();
  try {
    const vr = await fetch(`data/version.txt?t=${Date.now()}`, { cache: "no-store" }).catch(() => null);
    if (vr?.ok && vr.headers.get("x-sw-offline") !== "1") { const v = (await vr.text()).trim(); if (v && v !== APP_VERSION && await updateApp(v)) return; }
    const fc = await getJSON("data/forecast.json");
    if (fc?.days?.length && (fc.updated !== STATE.fc?.updated || fc.observations?.fetched !== STATE.fc?.observations?.fetched)) { blendObservations(fc, nzNow()); STATE.fc = fc; }
    const rain = await getRain(); if (rain) STATE.rain = rain;
    if (STATE.fc) render();
  } catch (e) { console.warn("refresh failed", e); }
  finally { refreshing = false; }
}

/* Service worker (offline shell + last data). New code arrives via version.txt -> updateApp(), or when the
   browser finds a new sw.js; either way the page reloads at most once per version (no loops). */
function reloadOnce(tag) {
  const key = "snells-beach-reloaded";
  try {
    const prev = JSON.parse(sessionStorage.getItem(key) || "null");
    if (prev && prev.tag === tag && Date.now() - prev.at < 10 * 60 * 1000) { console.info("already reloaded for", tag); return false; }
    sessionStorage.setItem(key, JSON.stringify({ tag, at: Date.now() }));
  } catch { /* storage off: still reload, the version check guards the rest */ }
  location.reload();
  return true;
}
let swReg = null;
async function updateApp(v) {
  if (swReg) {
    try { await swReg.update(); } catch { /* offline or blocked: plain reload below */ }
    // A new worker activates (skipWaiting + claim) -> controllerchange -> reload. Give it a moment first.
    await new Promise((r) => setTimeout(r, 4000));
  }
  return reloadOnce(v);   // false = already tried for this version: carry on refreshing data
}
function registerSW() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", async () => {
    if (!hadController) return;   // first install: this page is already current
    // Reload only when this page's code is older than the worker now in charge.
    const current = await caches.has("snells-beach-" + APP_VERSION).catch(() => true);
    if (!current) reloadOnce("sw:" + APP_VERSION);
  });
  navigator.serviceWorker.register("sw.js", { scope: "./", updateViaCache: "none" })
    .then((reg) => { swReg = reg; })
    .catch((e) => console.warn("service worker not registered", e));
}

function showError(err) {
  $("#app").innerHTML = `<section class="card errorcard"><h2>Can't load today's forecast</h2><p>${esc(err?.message || err)}</p><p class="muted">It's usually a blip with the connection. Try again in a moment.</p><button type="button" id="retry">Try again</button></section>`;
  $("#subtitle").textContent = "Forecast unavailable";
  $("#retry")?.addEventListener("click", () => location.reload());
}


function wirePrefs() {
  const prefs = STATE.prefs;
  for (const el of document.querySelectorAll('input[name="activity"]')) {
    el.checked = prefs.activities.includes(el.value);
    el.addEventListener("change", () => {
      const on = [...document.querySelectorAll('input[name="activity"]:checked')].map((x) => x.value);
      if (!on.length) { el.checked = true; return; }   // keep at least one
      prefs.activities = on; savePrefs(prefs); if (STATE.fc) render();
    });
  }
  const drive = $("#drive"); drive.value = prefs.drive;
  drive.addEventListener("input", () => { prefs.drive = +drive.value; savePrefs(prefs); render(); });
  const dog = $("#dog"); dog.checked = !!prefs.dog;
  dog.addEventListener("change", () => { prefs.dog = dog.checked; savePrefs(prefs); render(); });
}

async function main() {
  const prefs = loadPrefs();
  // URL overrides, handy for sharing: ?activity=hangout&drive=2&dog=1
  const q = new URLSearchParams(location.search);
  if (q.has("activity")) prefs.activities = q.get("activity").split(",");
  if (q.has("drive")) prefs.drive = clamp(parseInt(q.get("drive"), 10) || 0, 0, 2);
  if (q.has("dog")) prefs.dog = q.get("dog") === "1" || q.get("dog") === "true";
  fixPrefs(prefs);
  if (q.has("activity") || q.has("drive") || q.has("dog")) savePrefs(prefs);
  if (/^\d{1,2}:\d{2}$/.test(q.get("at") || "")) NOW_OVERRIDE = hm(q.get("at"));
  STATE = { prefs };
  wirePrefs();
  registerSW();
  try {
    const [beaches, fc, rain] = await Promise.all([getJSON("data/beaches.json"), getJSON("data/forecast.json"), getRain()]);
    if (!fc?.days?.length) throw new Error("forecast.json has no days in it");
    blendObservations(fc, nzNow(), beaches);
    Object.assign(STATE, { beaches, fc, rain });
    render();
    setInterval(refresh, 5 * 60 * 1000);   // pick up new hourly data and keep "now" fresh
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
    window.addEventListener("focus", refresh);
    window.addEventListener("online", () => { lastCheck = 0; refresh(); });
  } catch (err) {
    console.error(err);
    showError(err);
  }
}

if (typeof document !== "undefined") main();
