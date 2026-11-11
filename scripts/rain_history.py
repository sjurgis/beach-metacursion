"""Rolling rain history for the header heatline: data/rain_history.json (see data/SCHEMA.md).

Each hourly run rebuilds one value per clock hour for the last 48 h, best source first:
  api      official PWS API: today's 5-minute readings (observations/all/1day, one call per home station per run)
           and yesterday's hourly history (history/hourly, once per station per day, cached in this file).
           Their "precipTotal" is the day's running total, so each hour is the change in the median running
           total across the stations that have readings at both ends of the hour.
  station  (fallback when the API gives nothing for an hour) change in the median "rain today" total across the home stations both runs have
           (median of totals, so it adds up to the day's median total) (midnight reset handled: after midnight only the new day's total
           counts, the bit before midnight is left uncovered). A run-to-run change is spread evenly over
           the hours it spans. No totals -> rate x time for the hour before the reading ("rate" estimate).
  model    Open-Meteo past-hour precipitation, only for hours the stations do not cover.
The runs record (station totals seen by each hourly run) is still kept as that fallback.
Hours with none of these are left out (shown as gaps). Nothing is invented.

One-off seeding from git history:  python3 scripts/rain_history.py --seed-from-git
"""
import datetime as dt, json, os, statistics, subprocess, sys, urllib.request
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Pacific/Auckland")
UTC = dt.timezone.utc
HOME_IDS = {"IWARKW15", "ISNELL2", "ISNELL1", "IWARKW128", "IWARKW125", "IWARKW107"}  # Algies, Snells x2, Sandspit, Mahurangi x2
KEEP_H = 48
MAX_GAP_H = 4.5          # longest gap between runs we will bridge (cron skips 23-1, 1-4 and 4-6)
LAT, LON = -36.42, 174.73
H = dt.timedelta(hours=1)


def _t(s): return dt.datetime.fromisoformat(s)
def _iso(t): return t.astimezone(TZ).replace(microsecond=0).isoformat()
def _floor(t): return t.astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def load(path):
    try:
        with open(path, encoding="utf-8") as f: return json.load(f)
    except Exception:  # noqa: BLE001 - missing or broken file: start fresh
        return {"runs": []}


def run_from_obs(obs, fetched=None):
    """One run record from forecast.json 'observations' (home stations only), or None."""
    if not obs or obs.get("kind") != "home": return None
    st = {}
    for s in obs.get("stations", []):
        if s.get("id") not in HOME_IDS or not s.get("time"): continue
        tot, rate = s.get("rainTodayMm"), s.get("rainRateMmH")
        if tot is None and rate is None: continue
        st[s["id"]] = {"t": s["time"], "totalMm": tot, "rateMmH": rate}
    return {"at": fetched or obs.get("fetched"), "stations": st} if st else None


def add_run(hist, run, now):
    runs = [r for r in hist.get("runs", []) if r.get("at") != run["at"]] + [run] if run else hist.get("runs", [])
    cut = now - dt.timedelta(hours=KEEP_H + 6)
    hist["runs"] = sorted((r for r in runs if _t(r["at"]) >= cut), key=lambda r: _t(r["at"]))
    return hist


def _station_intervals(runs):
    """[(start, end, mm, n_stations, how)] measured intervals, from consecutive runs."""
    out = []
    for a, b in zip(runs, runs[1:]):
        ta, tb = _t(a["at"]), _t(b["at"])
        if not 0 < (tb - ta).total_seconds() <= MAX_GAP_H * 3600: continue
        midnight = None
        if tb.astimezone(TZ).date() != ta.astimezone(TZ).date():
            d = tb.astimezone(TZ).date(); midnight = dt.datetime(d.year, d.month, d.day, tzinfo=TZ)
        if midnight is not None:   # after the reset only the new day's total counts
            tb_tot = [s["totalMm"] for s in b["stations"].values() if s.get("totalMm") is not None and _t(s["t"]) >= midnight]
            if tb_tot:
                out.append((midnight, tb, max(0.0, statistics.median(tb_tot)), len(tb_tot), "total")); continue
        else:   # change in the median daily total over the stations both runs have
            both = [sid for sid, sb in b["stations"].items() if sb.get("totalMm") is not None
                    and (a["stations"].get(sid) or {}).get("totalMm") is not None]
            if both:
                d = statistics.median(b["stations"][x]["totalMm"] for x in both) - statistics.median(a["stations"][x]["totalMm"] for x in both)
                out.append((ta, tb, max(0.0, d), len(both), "total")); continue
        rates = [s["rateMmH"] for s in b["stations"].values() if s.get("rateMmH") is not None]
        if rates:
            start = max(ta, tb - H)
            out.append((start, tb, statistics.median(rates) * (tb - start).total_seconds() / 3600, len(rates), "rate"))
    return out


def fetch_model():
    """{utc hour start: mm} from Open-Meteo, last 48 h. Open-Meteo's value at T is the hour BEFORE T."""
    url = ("https://api.open-meteo.com/v1/forecast?"
           f"latitude={LAT}&longitude={LON}&hourly=precipitation&past_hours={KEEP_H + 2}&forecast_hours=2&timezone=GMT")
    req = urllib.request.Request(url, headers={"User-Agent": "snells-beach-site/1.0 github.com/sjurgis/snells-beach"})
    with urllib.request.urlopen(req, timeout=60) as r: j = json.loads(r.read().decode("utf-8"))
    h = j["hourly"]
    return {dt.datetime.fromisoformat(t).replace(tzinfo=UTC) - H: v for t, v in zip(h["time"], h["precipitation"]) if v is not None}


def _cum_series(points_by_day):
    """[(utc time, running mm)] across days from {local date: [(utc time, day total)]}, midnight reset handled.
    Each day gets a 0 mm point at its local midnight (the day total restarts there)."""
    out, offset = [], 0.0
    for d in sorted(points_by_day):
        mid = dt.datetime(d.year, d.month, d.day, tzinfo=TZ).astimezone(UTC)
        if out and (mid - out[-1][0]).total_seconds() > 75 * 60: offset = None   # previous day ended early: no carry
        if offset is None: out, offset = [], 0.0
        pts = sorted(points_by_day[d])
        out.append((mid, offset))
        out += [(t, offset + v) for t, v in pts]
        offset = offset + pts[-1][1] if pts else offset
    return out


def _cum_at(series, t):
    best = None
    for pt, v in series:
        if pt <= t + dt.timedelta(minutes=3): best = (pt, v)
        else: break
    return best[1] if best and (t - best[0]).total_seconds() <= 70 * 60 else None


def _api_points(j):
    pts = []
    for o in (j or {}).get("observations", []):
        v = (o.get("metric") or {}).get("precipTotal")
        if v is None or not o.get("obsTimeUtc"): continue
        pts.append((dt.datetime.fromisoformat(o["obsTimeUtc"].replace("Z", "+00:00")).astimezone(UTC), float(v)))
    return pts


def api_series(key, now, cache):
    """{station id: running-total series} from the PWS API. cache = previous file's "apiYesterday" (reused all day)."""
    from concurrent.futures import ThreadPoolExecutor
    from observations import api_get
    today = now.astimezone(TZ).date(); yday = today - dt.timedelta(days=1)
    if not cache or cache.get("date") != str(yday): cache = {"date": str(yday), "stations": {}}
    def one(sid):
        log = {"id": sid}
        try: tp = _api_points(api_get("observations/all/1day", {"stationId": sid}, key))
        except Exception as e:  # noqa: BLE001
            tp = []; log["1day"] = str(e)
        if sid not in cache["stations"]:
            try: cache["stations"][sid] = [[_iso(t), v] for t, v in _api_points(api_get("history/hourly", {"stationId": sid, "date": yday.strftime("%Y%m%d")}, key))]
            except Exception as e:  # noqa: BLE001
                log["hourly"] = str(e)   # not cached: tried again next run
        yp = [(_t(t).astimezone(UTC), v) for t, v in cache["stations"].get(sid, [])]
        days = {}
        if yp: days[yday] = yp
        tp = [(t, v) for t, v in tp if t.astimezone(TZ).date() == today]
        if tp: days[today] = tp
        return sid, (_cum_series(days) if days else []), log
    with ThreadPoolExecutor(max_workers=3) as ex:
        res = list(ex.map(one, sorted(HOME_IDS)))
    return {sid: ser for sid, ser, _ in res if ser}, cache, [l for _, _, l in res if len(l) > 1]


def api_hours(series, now):
    """{utc hour start: (mm, n)} where at least one station has readings at both ends of the hour."""
    out = {}
    hcur = _floor(now) - dt.timedelta(hours=KEEP_H - 1)
    while hcur <= _floor(now):
        end = min(hcur + H, now)
        both = [(a, b) for a, b in ((_cum_at(s, hcur), _cum_at(s, end)) for s in series.values()) if a is not None and b is not None]
        if both:
            out[hcur] = (max(0.0, statistics.median(b for _, b in both) - statistics.median(a for a, _ in both)), len(both))
        hcur += H
    return out


def build_hours(runs, model, now, api=None):
    first = _floor(now) - dt.timedelta(hours=KEEP_H - 1)
    cover, mm, n, how = {}, {}, {}, {}
    for s, e, v, k, w in _station_intervals(runs):
        span = (e - s).total_seconds()
        hcur = _floor(s)
        while hcur < e:
            ov = (min(e, hcur + H) - max(s, hcur)).total_seconds()
            if ov > 0:
                cover[hcur] = cover.get(hcur, 0) + ov
                mm[hcur] = mm.get(hcur, 0) + v * ov / span
                n[hcur] = max(n.get(hcur, 0), k)
                how.setdefault(hcur, set()).add(w)
            hcur += H
    out = []
    hcur = first
    while hcur <= _floor(now):
        full = (min(hcur + H, now) - hcur).total_seconds() or 1
        c = cover.get(hcur, 0) / full
        mv = model.get(hcur)
        if api and hcur in api:
            out.append({"start": _iso(hcur), "mm": round(api[hcur][0], 1), "src": "station", "n": api[hcur][1], "how": "total"})
        elif hcur in mm and (c >= 0.5 or mv is None):
            e = {"start": _iso(hcur), "mm": round(mm[hcur], 1), "src": "station", "n": n[hcur],
                 "how": "rate" if how[hcur] == {"rate"} else "total"}
            if c < 0.999: e["cover"] = round(min(c, 1), 2)
            out.append(e)
        elif mv is not None:
            out.append({"start": _iso(hcur), "mm": round(mv, 1), "src": "model"})
        hcur += H
    return out


def update(path, obs, now, model=None, write=True):
    hist = add_run(load(path), run_from_obs(obs), now)
    if model is None:
        try: model = fetch_model()
        except Exception as e:  # noqa: BLE001 - no model: station hours only, gaps elsewhere
            print("warning: rain history model:", e, file=sys.stderr); model = {}
    api, ycache, alog = None, hist.get("apiYesterday"), []
    try:
        from observations import api_key
        key = api_key()
        if key:
            series, ycache, alog = api_series(key, now, ycache)
            api = api_hours(series, now)
    except Exception as e:  # noqa: BLE001 - API trouble: fall back to the runs record
        print("warning: rain history API:", e, file=sys.stderr)
    for l in alog: print("warning: rain history API:", l, file=sys.stderr)
    hours = build_hours(hist["runs"], model, now, api)
    out = {"schemaVersion": 1, "updated": _iso(now), "timezone": "Pacific/Auckland",
           "sources": {"station": "Weather Underground home stations (Algies Bay, Snells Beach, Sandspit, Mahurangi East)",
                       "model": "Open-Meteo forecast, past-hour precipitation (estimate)"},
           "hours": hours, "runs": hist["runs"], **({"apiYesterday": ycache} if ycache else {})}
    if write:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1); f.write("\n")
    return out


def seed_from_git(repo, hours=KEEP_H + 6):
    """Runs from earlier committed forecast.json files. Before 2026-11-11r2 the rendered-page parser had
    the two precipitation numbers swapped (rainRateMmH held the daily total), so swap them back for 'render'."""
    log = subprocess.run(["git", "-C", repo, "log", f"--since={hours} hours ago", "--format=%H", "--", "data/forecast.json"],
                         capture_output=True, text=True, check=True).stdout.split()
    runs = []
    for c in log:
        try:
            fc = json.loads(subprocess.run(["git", "-C", repo, "show", f"{c}:data/forecast.json"], capture_output=True, text=True, check=True).stdout)
        except Exception: continue  # noqa: BLE001
        o = fc.get("observations")
        if not o: continue
        o = json.loads(json.dumps(o))
        for s in o.get("stations", []):
            if s.get("via") == "render": s["rainTodayMm"], s["rainRateMmH"] = s.get("rainRateMmH"), s.get("rainTodayMm")
        r = run_from_obs(o)
        if r: runs.append(r)
    return runs


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, "data", "rain_history.json")
    if "--seed-from-git" in sys.argv:
        now = dt.datetime.now(TZ)
        hist = load(path)
        for r in seed_from_git(root): hist = add_run(hist, r, now)
        with open(path, "w", encoding="utf-8") as f: json.dump({"runs": hist["runs"]}, f)
        out = update(path, None, now)
        print(f"seeded {len(out['runs'])} runs, {len(out['hours'])} hours")
