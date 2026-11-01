#!/usr/bin/env node
/* Write data/summary.json: a tiny 3-pick summary for the ESPHome wall screen.
   Reuses the site's own scoring by loading app.js (hangout mode, default prefs), so picks match the page.
   Usage: node scripts/summary.js [--at HH:MM] [--out data/summary.json]   (see data/SCHEMA.md) */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const OUT = opt("--out") || path.join(ROOT, "data", "summary.json");

const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const ctx = vm.createContext({ console, Intl, Date, Math, JSON, Set, Map, Object, Array, String, Number });
vm.runInContext(src + "\n;globalThis.__api = { buildTides, evalBeachDay, pickWindow, blendObservations, nzNow, hm, dayNum, isWeekend, dir16, windSummary, windRel, rainSummary, fmtTime, r30, wetness, localMin, setNow: (m) => { NOW_OVERRIDE = m; } };", ctx);
const A = ctx.__api;

const fc = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "forecast.json"), "utf8"));
const beaches = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "beaches.json"), "utf8"));
if (opt("--at")) A.setNow(A.hm(opt("--at")));
const now = A.nzNow();
A.blendObservations(fc, now, beaches);

const LIM = { name: 18, window: 14, note: 34, wind: 22, swell: 22, tide: 22 };
function fit(s, n) {   // trim at a word/comma boundary, never mid-word if avoidable
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  if ([...s].length <= n) return s;
  const cut = [...s].slice(0, n).join("");
  const parts = cut.split(", ");
  while (parts.length > 1) { parts.pop(); const t = parts.join(", "); if (t.length <= n) return t; }
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[ ,;·-]+$/, "");
}
const SHORT = { "Tāwharanui (Anchor Bay)": "Tāwharanui" };
const t12 = (m) => A.fmtTime(m);
function range(a, b) {
  a = A.r30(a); b = A.r30(b); if (b <= a) b = a + 30;
  const x = t12(a), y = t12(b);
  return `${x.slice(-2) === y.slice(-2) ? x.slice(0, -2) : x}-${y}`;
}

// Which day: today until ~7pm (or sunset), then tomorrow.
const tides = A.buildTides(fc.days);
const todayDay = fc.days.find((d) => d.date === now.date);
const late = !todayDay || now.min >= Math.min(19 * 60, A.hm(todayDay.sunset || "19:30") - 30);
const day = late ? fc.days.find((d) => d.date > now.date) : todayDay;
const stop = (beaches.drive?.stops || [])[1] || { maxMin: 35 };   // default prefs: drive = 1 ("Nearby")

function evalDay(act) {
  const isToday = day.date === now.date;
  const c = { isToday, nowMin: now.min, weekend: A.isWeekend(day.date), maxDrive: stop.maxMin, dog: false, favs: new Set() };
  const from = isToday ? now.min - 30 : -Infinity;
  const out = [];
  for (const b of beaches.beaches) {
    const R = A.evalBeachDay(b, day, act, tides, c);
    if (!R.evals.length) continue;
    const P = A.pickWindow(R, from, { nowMin: isToday ? now.min : null });
    if (P) out.push(P);
  }
  out.sort((a, b) => (b.eligible - a.eligible) || (a.done - b.done) || (b.score - a.score) || ((b.end - b.start) - (a.end - a.start)) || (a.b.driveMin - b.b.driveMin));
  return out.filter((p) => p.eligible && !p.done);
}
const winText = (p) => p.nowStart ? `Now-${t12(p.end)}` : range(p.start, p.end);

function note(p, act) {
  const es = p.inWin, w = A.windSummary(es), rel = A.windRel(p.b, w.dir), rs = A.rainSummary(es);
  const bits = [];
  if (act === "swim") bits.push("swim, deep enough");
  if (w.light) bits.push("almost still");
  else bits.push(`${A.dir16(w.dir)} ${w.lo === w.hi ? w.hi : w.lo + "-" + w.hi}kn`);
  if (rel === "sheltered") bits.push("sheltered");
  else if (rel === "offshore" && !w.light) bits.push("offshore");
  else if (rel === "onshore" && w.hi >= 10) bits.push("onshore");
  const skies = es.map((e) => e.sky);
  if (rs.prob >= 60 || rs.mm >= 0.5) bits.push(`rain ${rs.prob}%`);
  else if (rs.show) bits.push(`showers ${rs.prob}%`);
  else if (skies.filter((s) => s === "sun").length * 2 >= skies.length) bits.push("sunny");
  else bits.push("dry");
  if (act !== "swim" && p.b.tide?.mode === "high" && p.best.win && p.best.win.dist === 0) bits.push("high tide");
  if (p.traffic) bits.push("Matakana queues");
  return fit(bits.join(", "), LIM.note);
}

const hang = evalDay("hangout");
const picks = [];
const seen = new Set();
for (const p of hang) { if (picks.length >= 2) break; if (!seen.has(p.b.id)) { seen.add(p.b.id); picks.push({ p, act: "hangout" }); } }
// third: swim window at Algies/Snells on a good tide day, else the next hangout beach
const swim = evalDay("swim").filter((p) => (p.b.id === "algies" || p.b.id === "snells") && !seen.has(p.b.id) && p.tideWin && p.score >= 50 && p.end - p.start >= 90);
if (swim.length) picks.push({ p: swim[0], act: "swim" });
else { const n = hang.find((p) => !seen.has(p.b.id)); if (n) picks.push({ p: n, act: "hangout" }); }
while (picks.length < 3) picks.push(null);

const outPicks = picks.map((x) => x ? {
  name: fit(SHORT[x.p.b.name] || x.p.b.name, LIM.name), window: fit(winText(x.p), LIM.window), note: note(x.p, x.act),
} : { name: "", window: "", note: "" });

// day-level wind / swell / tide (daylight, from now on if today)
const sr = A.hm(day.sunrise || "06:30"), ss = A.hm(day.sunset || "19:30");
const from = day.date === now.date ? Math.max(sr, now.min - 30) : sr;
const slots = (day.slots || []).filter((s) => { const t = A.hm(s.time); return t >= from && t <= ss; });
let wind = "";
if (slots.length) {
  const ws = A.windSummary(slots.map((s) => ({ dir: s.windDirDeg, kn: s.windKn })));
  const g = Math.max(...slots.map((s) => s.gustKn ?? 0));
  wind = ws.light ? "Light <5kn" : `${A.dir16(ws.dir)} ${ws.lo === ws.hi ? ws.hi : ws.lo + "-" + ws.hi}kn${g >= ws.hi + 3 ? ` g${Math.round(g)}` : ""}`;
}
let swell = "";
const sw = (day.swell || []).filter((s) => s.open?.swellM != null);
if (sw.length) {
  const m = Math.max(...sw.map((s) => s.open.swellM));
  const per = Math.round(Math.max(...sw.map((s) => s.open.periodS ?? 0)));
  swell = m < 0.8 ? `${m.toFixed(1)}m, no surf` : m < 1.0 ? `${m.toFixed(1)}m, small surf` : `${m.toFixed(1)}m${per ? " " + per + "s" : ""}, surf up`;
}
let tide = "";
const highs = (day.tides || []).filter((t) => t.type === "high").map((t) => A.hm(t.time));
const nextH = highs.filter((m) => day.date !== now.date || m >= now.min - 60);
const hs = (nextH.length ? nextH : highs).filter((m) => m >= 5 * 60 && m <= 22 * 60);
if (hs.length || highs.length) {
  const est = day.tidesSource === "computed" ? " (est)" : "";
  tide = fit(`High ${(hs.length ? hs : highs).slice(0, 2).map(t12).join(", ")}${est}`, LIM.tide);
  if (est && !tide.endsWith("(est)")) tide = `High ${t12((hs.length ? hs : highs)[0])}${est}`;
}

// ---- weather (today, NZ local) ----
const W1 = { sun: "sunny", partly: "partly", cloud: "cloudy", fog: "cloudy", showers: "showers", rain: "rain", storm: "rain" };
function weather() {
  const td = fc.days.find((x) => x.date === now.date);
  const all = [];
  for (const x of fc.days) for (const sl of x.fcSlots || x.slots || []) all.push({ day: x, sl, abs: (A.dayNum(x.date) - A.dayNum(now.date)) * 1440 + A.hm(sl.time) });
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  let now_c = null;
  const L = fc.liveNow;
  if (L?.mode === "live") { const v = L.stations.map((q) => num(q.airC)).filter((v) => v != null); if (v.length) now_c = Math.round(v.reduce((a, b) => a + b) / v.length * 10) / 10; }
  if (now_c == null && all.length) { const c = all.reduce((a, b) => Math.abs(b.abs - now.min) < Math.abs(a.abs - now.min) ? b : a); if (Math.abs(c.abs - now.min) <= 90) now_c = num(c.sl.airC); }
  const ts = (td?.fcSlots || td?.slots || []);
  const temps = ts.map((q) => num(q.airC)).filter((v) => v != null);
  const hi_c = td?.airMaxC != null ? Math.round(td.airMaxC) : temps.length ? Math.round(Math.max(...temps)) : null;
  const lo_c = temps.length ? Math.round(Math.min(...temps)) : null;
  let cond = "";
  if (td && ts.length) {
    const sr = A.hm(td.sunrise || "06:30"), ss = A.hm(td.sunset || "19:30");
    const dl = ts.filter((q) => { const t = A.hm(q.time); return t >= sr && t <= ss; });
    const part = (lo, hi) => { const z = dl.filter((q) => { const t = A.hm(q.time); return t >= lo && t < hi; }); if (!z.length) return null;
      const c = {}; for (const q of z) c[q.sky] = (c[q.sky] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; };
    const NAME = { sun: "Sunny", partly: "Partly cloudy", cloud: "Cloudy", fog: "Foggy", showers: "Showers", rain: "Rain", storm: "Storms" };
    const am = part(0, 12 * 60), pm = part(12 * 60, 24 * 60);
    if (am && pm && am !== pm) cond = `${NAME[am] || am}, ${(NAME[pm] || pm).toLowerCase()} pm`;
    else if (am || pm) cond = NAME[am || pm] || (am || pm);
    if (cond.length > 26) cond = fit(`${NAME[am] || am} am, ${(NAME[pm] || pm).toLowerCase()} pm`, 26);
  }
  let rain = "";
  if (ts.length) {
    const mm = ts.filter((q) => q.rainMm != null), pr = ts.map((q) => q.rainProbPct).filter((v) => v != null);
    const tot = mm.reduce((a, q) => a + q.rainMm, 0);
    rain = [mm.length ? `${tot < 10 ? Math.round(tot * 10) / 10 : Math.round(tot)}mm` : "", pr.length ? `${Math.max(...pr)}%` : ""].filter(Boolean).join(", ");
  }
  let wnd = "";
  if (ts.length) { const ws = A.windSummary(ts.map((q) => ({ dir: q.windDirDeg, kn: q.windKn }))); const g = Math.max(...ts.map((q) => q.gustKn ?? 0));
    wnd = fit(ws.light ? "Light <5kn" : `${A.dir16(ws.dir)} ${ws.lo === ws.hi ? ws.hi : ws.lo + "-" + ws.hi}kn${g >= ws.hi + 3 ? ` g${Math.round(g)}` : ""}`, 22); }
  const later = [];
  let next = Math.ceil((now.min + 60) / 180) * 180;
  for (let k = 0; k < 3; k++) {
    const c = all.find((q) => q.abs === next) || all.filter((q) => Math.abs(q.abs - next) <= 60).sort((a, b) => Math.abs(a.abs - next) - Math.abs(b.abs - next))[0]
      || all.filter((q) => q.abs >= next).sort((a, b) => a.abs - b.abs)[0];   // overnight gap: next slot there is
    if (!c) break;
    const t = A.hm(c.sl.time), night = t < A.hm(c.day.sunrise || "06:30") || t > A.hm(c.day.sunset || "19:30");
    let w = W1[c.sl.sky] || "";
    if (night && (w === "sunny" || w === "partly")) w = "clear";
    else if (w && w !== "rain" && w !== "showers" && (c.sl.windKn ?? 0) >= 20) w = "windy";
    const h = Math.floor(t / 60), h12 = h % 12 || 12;
    later.push({ t: `${h12}${h >= 12 ? "pm" : "am"}`, c: num(c.sl.airC) == null ? null : Math.round(c.sl.airC), cond: w });
    next = c.abs + 180;
  }
  return { now_c, hi_c, lo_c, cond, rain: fit(rain, 22), wind: wnd, sunset: td?.sunset ? (() => { const m = A.hm(td.sunset), h = Math.floor(m / 60); return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`; })() : "", later };
}

const upd = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const [y, mo, d] = day.date.split("-").map(Number);
const dt = new Date(Date.UTC(y, mo - 1, d, 12));
const date = `${dt.toLocaleDateString("en-NZ", { timeZone: "UTC", weekday: "short" })} ${d} ${dt.toLocaleDateString("en-NZ", { timeZone: "UTC", month: "short" })}`;
const out = { updated: opt("--at") || upd, date, picks: outPicks, wind: fit(wind, LIM.wind), swell: fit(swell, LIM.swell), tide, weather: weather() };
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${path.relative(ROOT, OUT)}: ${Buffer.byteLength(JSON.stringify(out, null, 1) + "\n")} bytes`);
