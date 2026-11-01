#!/usr/bin/env python3
"""Check data/forecast.json (and data/beaches.json) against data/SCHEMA.md. Stdlib only.

Usage: python3 scripts/validate.py [path/to/forecast.json]
Exit code 0 = OK, 1 = problems (printed one per line).
"""
import datetime as dt, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
errors, warnings = [], []
err = errors.append
warn = warnings.append

HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
SKY = {"sun", "partly", "cloud", "fog", "showers", "rain", "storm"}


def num(v, lo, hi, where, required=True):
    if v is None:
        if required: err(f"{where}: missing")
        return
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        err(f"{where}: must be a number, got {v!r}"); return
    if not lo <= v <= hi:
        err(f"{where}: {v} outside {lo}..{hi}")


def hhmm(v, where):
    if not isinstance(v, str) or not HHMM.match(v):
        err(f"{where}: must be 'HH:MM' 24h local time, got {v!r}"); return None
    h, m = map(int, v.split(":")); return h * 60 + m


def check_forecast(fc):
    if not isinstance(fc, dict): err("forecast: top level must be an object"); return
    if fc.get("schemaVersion") != 1: err("schemaVersion: must be 1")
    if fc.get("timezone") != "Pacific/Auckland": err("timezone: must be 'Pacific/Auckland'")
    up = fc.get("updated")
    try:
        u = dt.datetime.fromisoformat(up)
        if u.tzinfo is None: err("updated: needs a UTC offset, e.g. 2026-10-09T07:19:00+13:00")
    except Exception:
        err(f"updated: not an ISO 8601 datetime: {up!r}"); u = None
    obs = fc.get("observations")
    if obs is not None:
        if not isinstance(obs, dict) or obs.get("kind") not in ("home", "airport") or not isinstance(obs.get("stations"), list) or not obs["stations"]:
            err("observations: need kind home|airport and a non-empty stations list")
        else:
            for i, s in enumerate(obs["stations"]):
                w = f"observations.stations[{i}]"
                for k in ("id", "name", "time"):
                    if not isinstance(s.get(k), str) or not s.get(k): err(f"{w}.{k}: required string")
                try:
                    if dt.datetime.fromisoformat(s.get("time", "")).tzinfo is None: err(f"{w}.time: needs offset")
                except Exception: err(f"{w}.time: not ISO 8601")
                num(s.get("windKn"), 0, 120, f"{w}.windKn")
                num(s.get("gustKn"), 0, 150, f"{w}.gustKn", required=False)
                num(s.get("windDirDeg"), 0, 360, f"{w}.windDirDeg", required=False)
                num(s.get("airC"), -10, 45, f"{w}.airC", required=False)
                num(s.get("pressureHpa"), 900, 1100, f"{w}.pressureHpa", required=False)
                num(s.get("rainRateMmH"), 0, 300, f"{w}.rainRateMmH", required=False)
    src = fc.get("sources")
    if not isinstance(src, list) or not src: err("sources: need a non-empty list")
    else:
        for i, s in enumerate(src):
            for k in ("what", "name"):
                if not isinstance(s.get(k), str) or not s.get(k): err(f"sources[{i}].{k}: required string")
            if "url" in s and not str(s["url"]).startswith("http"): err(f"sources[{i}].url: must be http(s)")
    days = fc.get("days")
    if not isinstance(days, list) or not days: err("days: need a non-empty list"); return
    if len(days) < 2: warn("days: only one day; the 'next days' strip will be empty")
    prev = None
    for di, d in enumerate(days):
        w = f"days[{di}]"
        try:
            date = dt.date.fromisoformat(d.get("date", ""))
        except Exception:
            err(f"{w}.date: must be YYYY-MM-DD"); continue
        w = f"days[{di}] {date}"
        if prev and (date - prev).days != 1: err(f"{w}: dates must be consecutive (previous {prev})")
        prev = date
        sr, ss = hhmm(d.get("sunrise"), f"{w}.sunrise"), hhmm(d.get("sunset"), f"{w}.sunset")
        if sr is not None and ss is not None and not sr < ss: err(f"{w}: sunrise must be before sunset")
        num(d.get("airMaxC"), -5, 40, f"{w}.airMaxC", required=False)
        num(d.get("waterTempC"), 5, 30, f"{w}.waterTempC", required=False)
        if d.get("tidesSource") not in (None, "previous", "computed"): err(f"{w}.tidesSource: 'previous' | 'computed' if present")
        elif d.get("tidesSource") == "computed": warnings.append(f"{w}: tides estimated (tide site unreachable)")
        tides = d.get("tides")
        if not isinstance(tides, list) or len(tides) < 2:
            err(f"{w}.tides: need at least 2 tide turns (high/low)")
        else:
            last_t, last_type = -1, None
            for ti, t in enumerate(tides):
                tw = f"{w}.tides[{ti}]"
                m = hhmm(t.get("time"), f"{tw}.time")
                if t.get("type") not in ("high", "low"): err(f"{tw}.type: 'high' or 'low'")
                num(t.get("heightM"), -1, 5, f"{tw}.heightM")
                if m is not None:
                    if m <= last_t: err(f"{tw}: tides must be in time order")
                    last_t = m
                if t.get("type") == last_type: err(f"{tw}: two {last_type} tides in a row")
                last_type = t.get("type")
            if not any(t.get("type") == "high" for t in tides): err(f"{w}.tides: no high tide")
        slots = d.get("slots")
        if not isinstance(slots, list) or len(slots) < 2:
            err(f"{w}.slots: need at least 2 time slots")
        else:
            last = -1
            for si, s in enumerate(slots):
                sw = f"{w}.slots[{si}]"
                m = hhmm(s.get("time"), f"{sw}.time")
                if m is not None:
                    if m <= last: err(f"{sw}: slots must be in time order")
                    last = m
                num(s.get("windDirDeg"), 0, 360, f"{sw}.windDirDeg")
                num(s.get("windKn"), 0, 80, f"{sw}.windKn")
                num(s.get("gustKn"), 0, 100, f"{sw}.gustKn", required=False)
                if s.get("gustKn") is not None and isinstance(s.get("windKn"), (int, float)) and s["gustKn"] + 0.5 < s["windKn"]:
                    warn(f"{sw}: gustKn below windKn")
                num(s.get("rainMm"), 0, 100, f"{sw}.rainMm", required=False)
                num(s.get("airC"), -5, 40, f"{sw}.airC", required=False)
                num(s.get("cloudPct"), 0, 100, f"{sw}.cloudPct", required=False)
                num(s.get("rainProbPct"), 0, 100, f"{sw}.rainProbPct", required=False)
                if "models" in s:
                    if not isinstance(s["models"], dict): err(f"{sw}.models: must be an object")
                    else:
                        for mk, mv in s["models"].items():
                            if not (isinstance(mv, list) and len(mv) == 2 and all(isinstance(z, (int, float)) for z in mv)):
                                err(f"{sw}.models.{mk}: must be [dirDeg, kn]")
                if "sky" in s and s["sky"] not in SKY: err(f"{sw}.sky: one of {sorted(SKY)}")
            if not any("rainProbPct" in s for s in slots):
                warn(f"{w}.slots: no rainProbPct anywhere; rain scoring falls back to rainMm/sky only")
            if sr is not None and ss is not None and not any(sr - 60 <= hhmm(s.get("time"), "x") <= ss + 30 for s in slots if HHMM.match(str(s.get("time")))):
                err(f"{w}.slots: no slot in daylight")
        swell = d.get("swell")
        if not isinstance(swell, list) or not swell:
            err(f"{w}.swell: need at least 1 entry")
        else:
            for xi, x in enumerate(swell):
                xw = f"{w}.swell[{xi}]"
                hhmm(x.get("time"), f"{xw}.time")
                o, i = x.get("open"), x.get("inner")
                if not isinstance(o, dict): err(f"{xw}.open: required object"); o = {}
                if not isinstance(i, dict): err(f"{xw}.inner: required object"); i = {}
                num(o.get("swellM"), 0, 15, f"{xw}.open.swellM")
                num(o.get("periodS"), 0, 25, f"{xw}.open.periodS")
                num(o.get("dirDeg"), 0, 360, f"{xw}.open.dirDeg")
                num(o.get("waveM"), 0, 15, f"{xw}.open.waveM", required=False)
                num(i.get("waveM"), 0, 10, f"{xw}.inner.waveM")
                num(i.get("periodS"), 0, 25, f"{xw}.inner.periodS", required=False)
                num(i.get("dirDeg"), 0, 360, f"{xw}.inner.dirDeg", required=False)
        tr = d.get("traffic")
        if tr is not None:
            if not isinstance(tr, dict) or tr.get("level") not in ("light", "moderate", "busy"):
                err(f"{w}.traffic.level: 'light' | 'moderate' | 'busy'")
            if not isinstance((tr or {}).get("note"), str): err(f"{w}.traffic.note: required string")
    if u:
        first = dt.date.fromisoformat(days[0]["date"]) if isinstance(days[0].get("date"), str) else None
        if first and u.astimezone(dt.timezone(dt.timedelta(hours=13))).date() - first > dt.timedelta(days=1):
            warn("days[0] is more than a day before 'updated': is the file stale?")


def check_beaches(b):
    ids = set()
    for i, x in enumerate(b.get("beaches", [])):
        w = f"beaches[{i}] {x.get('id')}"
        if x.get("id") in ids: err(f"{w}: duplicate id")
        ids.add(x.get("id"))
        for k in ("name", "area"):
            if not isinstance(x.get(k), str): err(f"{w}.{k}: required")
        num(x.get("driveMin"), 0, 300, f"{w}.driveMin"); num(x.get("facingDeg"), 0, 360, f"{w}.facingDeg")
        if not isinstance(x.get("viaMatakana"), bool): err(f"{w}.viaMatakana: bool")
        if x.get("tide", {}).get("mode") not in ("high", "all"): err(f"{w}.tide.mode: 'high' | 'all'")
        if x.get("exposure", {}).get("source") not in ("open", "inner"): err(f"{w}.exposure.source: 'open' | 'inner'")
        if x.get("highTideSand", "some") not in ("plenty", "some", "little"): err(f"{w}.highTideSand: 'plenty' | 'some' | 'little'")
        for a in ("swim", "surf", "snorkel", "sup", "hangout"): num(x.get("suits", {}).get(a), 0, 1, f"{w}.suits.{a}")
        dog = x.get("dog") or {}
        if not dog.get("rules"): err(f"{w}.dog.rules: required")
        if not dog.get("verified"): warn(f"{w}: dog rule unverified (page will say 'check signs')")
        for r in dog.get("rules", []):
            if r.get("status") not in ("offlead", "leash", "limited", "banned"): err(f"{w}.dog.rules status {r.get('status')!r}")
        if dog.get("rules") and "from" in dog["rules"][-1]: err(f"{w}.dog.rules: last rule must be the catch-all (no from/to)")
    if not ids: err("beaches.json: no beaches")


def check_site_versions():
    """PWA: app.js APP_VERSION, sw.js VERSION and data/version.txt should match. Warning only, so a
    mismatch never blocks the hourly data push."""
    import re
    try:
        app = re.search(r'APP_VERSION = "([^"]+)"', (ROOT / "app.js").read_text(encoding="utf-8"))
        sw = re.search(r'const VERSION = "([^"]+)"', (ROOT / "sw.js").read_text(encoding="utf-8"))
        txt = (ROOT / "data" / "version.txt").read_text(encoding="utf-8").strip()
    except FileNotFoundError as e:
        warnings.append(f"site version check skipped: {e.filename} missing"); return
    vals = {"app.js": app and app.group(1), "sw.js": sw and sw.group(1), "version.txt": txt}
    if len(set(vals.values())) != 1: warnings.append(f"site versions differ: {vals}")
    try:
        m = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
        for i in m.get("icons", []):
            if not (ROOT / i["src"]).exists(): warnings.append(f"manifest icon missing: {i['src']}")
    except Exception as e:
        warnings.append(f"manifest.webmanifest: {e}")


SUMMARY_LIM = {"name": 18, "window": 14, "note": 34, "wind": 22, "swell": 22, "tide": 22}
EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F]")


def check_summary(s):
    """data/summary.json: the wall-screen summary (see SCHEMA.md)."""
    w = "summary.json"
    if not isinstance(s, dict): err(f"{w}: not an object"); return
    want = {"updated", "date", "picks", "wind", "swell", "tide", "weather"}
    if set(s) != want: err(f"{w}: keys {sorted(s)} != {sorted(want)}")
    if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", str(s.get("updated", ""))): err(f"{w}: updated must be HH:MM")
    if not isinstance(s.get("date"), str) or not s["date"]: err(f"{w}: date missing")
    for k in ("wind", "swell", "tide"):
        v = s.get(k)
        if not isinstance(v, str): err(f"{w}: {k} must be a string")
        elif len(v) > SUMMARY_LIM[k]: err(f"{w}: {k} longer than {SUMMARY_LIM[k]}")
    picks = s.get("picks")
    if not isinstance(picks, list) or len(picks) != 3: err(f"{w}: picks must be exactly 3"); picks = []
    for i, p in enumerate(picks):
        if not isinstance(p, dict) or set(p) != {"name", "window", "note"}: err(f"{w}: picks[{i}] keys must be name/window/note"); continue
        for k, v in p.items():
            if not isinstance(v, str): err(f"{w}: picks[{i}].{k} must be a string")
            elif len(v) > SUMMARY_LIM[k]: err(f"{w}: picks[{i}].{k} longer than {SUMMARY_LIM[k]}")
    wx = s.get("weather")
    wk = {"now_c", "hi_c", "lo_c", "cond", "rain", "wind", "sunset", "later"}
    if not isinstance(wx, dict) or set(wx) != wk: err(f"{w}: weather keys must be {sorted(wk)}"); wx = {}
    for k in ("now_c", "hi_c", "lo_c"):
        v = wx.get(k)
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or not -10 <= v <= 45): err(f"{w}: weather.{k} must be a number or null")
    for k, n in (("cond", 26), ("rain", 22), ("wind", 22), ("sunset", 8)):
        if k in wx and (not isinstance(wx[k], str) or len(wx[k]) > n): err(f"{w}: weather.{k} must be a string <= {n}")
    lt = wx.get("later", [])
    if not isinstance(lt, list) or len(lt) > 3: err(f"{w}: weather.later must be a list of up to 3"); lt = []
    for i, x in enumerate(lt):
        if not isinstance(x, dict) or set(x) != {"t", "c", "cond"}: err(f"{w}: weather.later[{i}] keys must be t/c/cond"); continue
        if not re.match(r"^(1[0-2]|[1-9])(am|pm)$", str(x["t"])): err(f"{w}: weather.later[{i}].t bad")
        if x["c"] is not None and not isinstance(x["c"], (int, float)): err(f"{w}: weather.later[{i}].c must be a number or null")
        if x["cond"] not in {"", "sunny", "partly", "cloudy", "rain", "showers", "windy", "clear"}: err(f"{w}: weather.later[{i}].cond bad")
    raw = json.dumps(s, ensure_ascii=False)
    if EMOJI.search(raw): err(f"{w}: contains emoji")
    if re.search(r"\b(IWARKW|ISNELL|NZAA)", raw): err(f"{w}: contains a station ID")


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "forecast.json"
    for p, fn in ((path, check_forecast), (ROOT / "data" / "beaches.json", check_beaches)):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            err(f"{p}: cannot read/parse JSON: {e}"); continue
        fn(data)
    sp = ROOT / "data" / "summary.json"
    if sp.exists():
        if sp.stat().st_size > 2048: err(f"summary.json: {sp.stat().st_size} bytes, over 2 KB")
        try: check_summary(json.loads(sp.read_text(encoding="utf-8")))
        except ValueError as e: err(f"summary.json: cannot parse: {e}")
    else:
        warn("data/summary.json missing")
    check_site_versions()
    for w in warnings: print("warning:", w)
    for e in errors: print("ERROR:", e)
    if errors:
        print(f"FAILED: {len(errors)} problem(s)"); sys.exit(1)
    print(f"OK: {path.name} and beaches.json look valid" + (f" ({len(warnings)} warning(s))" if warnings else ""))


if __name__ == "__main__":
    main()
