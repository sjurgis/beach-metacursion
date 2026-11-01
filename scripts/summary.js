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

const upd = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const [y, mo, d] = day.date.split("-").map(Number);
const dt = new Date(Date.UTC(y, mo - 1, d, 12));
const date = `${dt.toLocaleDateString("en-NZ", { timeZone: "UTC", weekday: "short" })} ${d} ${dt.toLocaleDateString("en-NZ", { timeZone: "UTC", month: "short" })}`;
const out = { updated: opt("--at") || upd, date, picks: outPicks, wind: fit(wind, LIM.wind), swell: fit(swell, LIM.swell), tide };
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${path.relative(ROOT, OUT)}: ${Buffer.byteLength(JSON.stringify(out, null, 1) + "\n")} bytes`);
