#!/usr/bin/env python3
"""Fetch fresh forecasts and rewrite data/forecast.json (stdlib only).

Sources:
  wind          hourly slots 06-20; vector blend of met.no (smoothed over +-1 h) and Open-Meteo, equal weight
  weather       met.no locationforecast 2.0 (compact) sky/temp; Open-Meteo gusts + rain probability
  swell, sea    Open-Meteo marine: Kawau Bay (inner) and off Te Arai (open coast)
  sun           Open-Meteo daily sunrise/sunset
  tides         tides4fishing.com Mahurangi Harbour table
  rain history  data/rain_history.json: home-station rain totals per run + Open-Meteo past hours (scripts/rain_history.py)

Usage:  python3 scripts/update_forecast.py [--days 4] [--start YYYY-MM-DD] [--out data/forecast.json]
Then:   python3 scripts/validate.py
See data/SCHEMA.md for the file format.
"""
import argparse, time, os, datetime as dt, html, json, math, re, sys, urllib.request
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Pacific/Auckland")
UA = "snells-beach-site/1.0 github.com/sjurgis/snells-beach"
LAT, LON = -36.42, 174.73                 # Snells Beach
INNER = (-36.42, 174.80)                  # Kawau Bay (Open-Meteo snaps to -36.458, 174.875)
OPEN = (-36.13, 174.85)                   # off Te Arai (snaps to -36.125, 174.875)
SLOT_HOURS = list(range(6, 21))          # hourly 06:00-20:00 local
SWELL_HOURS = [6, 9, 12, 15, 18]
MS_TO_KN = 1.943844
TIDE_URL = "https://tides4fishing.com/nz/auckland/mahurangi-harbour"


def get(url, raw=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA if "met.no" in url else
                                               "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode("utf-8", "ignore")
    return body if raw else json.loads(body)


def sky(symbol):
    s = symbol or ""
    if "thunder" in s: return "storm"
    if "showers" in s: return "showers"
    if "rain" in s or "sleet" in s or "snow" in s: return "rain"
    if s.startswith("partlycloudy"): return "partly"
    if s.startswith("clearsky") or s.startswith("fair"): return "sun"
    if s.startswith("fog"): return "fog"
    if s: return "cloud"
    return None


def parse_tides(page, year, month):
    """Return {date: [ {time, type, heightM} ]} from the tides4fishing monthly table."""
    t = re.sub(r"(?s)<script.*?</script>|<style.*?</style>", "", page)
    t = html.unescape(re.sub(r"<[^>]+>", "\n", t))
    toks = [x.strip() for x in t.splitlines() if x.strip()]
    start = toks.index("SOLUNAR ACTIVITY", toks.index("TIDES FOR MAHURANGI"))
    toks = toks[start:]
    days, i = {}, 0
    wd = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
    while i < len(toks) - 1:
        if toks[i].isdigit() and toks[i + 1] in wd:
            day = int(toks[i]); i += 2
            times, j = [], i
            while j < len(toks) - 1:
                m = re.fullmatch(r"(\d{1,2}):(\d{2})", toks[j])
                if m and toks[j + 1] in ("am", "pm"):
                    h = int(m.group(1)) % 12 + (12 if toks[j + 1] == "pm" else 0)
                    hm = f"{h:02d}:{m.group(2)}"
                    if j + 3 < len(toks) and re.fullmatch(r"\d+\.\d+", toks[j + 2]) and toks[j + 3] == "m":
                        times.append((hm, float(toks[j + 2]))); j += 4
                    else:
                        times.append((hm, None)); j += 2
                else:
                    break
            tides = [(hm, h) for hm, h in times if h is not None]   # first two are sunrise/sunset
            key = dt.date(year, month, day)
            if key in days:          # the page repeats day rows in later sections: first table wins
                break
            days[key] = tides
            i = j
        else:
            i += 1
    allh = [h for v in days.values() for _, h in v]
    mid = (max(allh) + min(allh)) / 2
    return {d: [{"time": hm, "type": "high" if h > mid else "low", "heightM": h} for hm, h in v]
            for d, v in days.items()}


TIDE_TRIES = 3
HALF_TIDE = dt.timedelta(hours=6, minutes=12, seconds=37)   # mean semidiurnal half-cycle (M2 / 2)


def get_retry(url, tries=TIDE_TRIES, raw=True):
    """GET with a short backoff; tides4fishing sometimes resets the TLS connection."""
    errs = []
    for i in range(tries):
        try:
            return get(url, raw=raw), errs
        except Exception as e:  # noqa: BLE001 - network errors of every kind
            errs.append(f"{type(e).__name__}: {e}"[:160])
            if i < tries - 1: time.sleep(3 * (i + 1))
    raise RuntimeError("; ".join(errs))


def previous_tides(path):
    """{date: [tides]} from the last forecast.json we wrote (still valid for the days it covers)."""
    try:
        with open(path, encoding="utf-8") as f:
            old = json.load(f)
        return {dt.date.fromisoformat(d["date"]): d["tides"] for d in old.get("days", [])
                if isinstance(d.get("tides"), list) and len(d["tides"]) >= 2 and d.get("tidesSource", "tides4fishing") != "computed"}
    except Exception:  # noqa: BLE001
        return {}


def extrapolate_tides(known, want):
    """Rough fallback: carry the last known high/low sequence forward one half tide-cycle at a time.
    Accurate to ~15-30 min for a few days; flagged as 'computed' so it's obvious."""
    ev = sorted((dt.datetime.combine(d, dt.time.fromisoformat(t["time"])), t["type"], t["heightM"])
                for d, ts in known.items() for t in ts)
    if len(ev) < 2: return {}
    out, last_day = {}, max(want)
    while ev[-1][0].date() <= last_day:
        t, typ, _ = ev[-1]
        ev.append((t + HALF_TIDE, "low" if typ == "high" else "high", ev[-2][2]))
    for t, typ, h in ev:
        if t.date() in want and t.date() not in known:
            out.setdefault(t.date(), []).append({"time": t.strftime("%H:%M"), "type": typ, "heightM": h})
    return {d: ts for d, ts in out.items() if len(ts) >= 2}


def fetch_tides(dates, start, end, out_path, now):
    """Tides never abort the run: retry, then previous forecast.json, then a computed extrapolation."""
    log = {"source": "tides4fishing", "url": TIDE_URL, "at": now.replace(microsecond=0).isoformat(), "ok": False}
    tides = {}
    months = sorted({(d.year, d.month) for d in dates + [start - dt.timedelta(days=1), end + dt.timedelta(days=1)]})
    try:
        page, errs = get_retry(TIDE_URL)
        log["attempts"] = len(errs) + 1
        tides.update(parse_tides(page, *months[0]))
        log["ok"] = True
    except Exception as e:  # noqa: BLE001
        log["attempts"] = TIDE_TRIES; log["error"] = str(e)[:300]
        print("warning: tides4fishing failed:", e, file=sys.stderr)
    if log["ok"]:
        for y, m in months[1:]:
            if not all(d in tides for d in dates):
                try:
                    tides.update(parse_tides(get_retry(f"{TIDE_URL}/forecast/{y}-{m:02d}")[0], y, m))  # best effort
                except Exception as e:  # noqa: BLE001
                    print("warning: tides for", y, m, e, file=sys.stderr)
    src = {d: "tides4fishing" for d in tides}
    missing = [d for d in dates if len(tides.get(d, [])) < 2]
    if missing:
        prev = previous_tides(out_path)
        for d in missing:
            if d in prev: tides[d] = prev[d]; src[d] = "previous"
        still = {d for d in dates if len(tides.get(d, [])) < 2}
        if still:
            base = {d: ts for d, ts in {**prev, **{d: tides[d] for d in tides}}.items() if len(ts) >= 2}
            for d, ts in extrapolate_tides(base, still).items():
                tides[d] = ts; src[d] = "computed"
        log["fallback"] = {str(d): src.get(d, "none") for d in missing}
    return tides, {**log, "bySource": {str(d): src.get(d, "none") for d in dates}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=4)
    ap.add_argument("--start", help="first day YYYY-MM-DD (default today in Pacific/Auckland)")
    ap.add_argument("--out", default="data/forecast.json")
    a = ap.parse_args()
    now = dt.datetime.now(TZ)
    start = dt.date.fromisoformat(a.start) if a.start else now.date()
    dates = [start + dt.timedelta(days=k) for k in range(a.days)]
    end = dates[-1]

    met = get(f"https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={LAT}&lon={LON}")
    metno = {}
    for ts in met["properties"]["timeseries"]:
        t = dt.datetime.fromisoformat(ts["time"].replace("Z", "+00:00")).astimezone(TZ)
        d = ts["data"]; inst = d["instant"]["details"]
        nx = d.get("next_1_hours") or d.get("next_6_hours") or {}
        hours = 1 if "next_1_hours" in d else 6
        rain = nx.get("details", {}).get("precipitation_amount")
        metno[t.replace(minute=0, second=0, microsecond=0)] = {
            "windDirDeg": round(inst["wind_from_direction"]),
            "windKn": round(inst["wind_speed"] * MS_TO_KN, 1),
            "airC": round(inst["air_temperature"], 1),
            "cloudPct": round(inst.get("cloud_area_fraction", 0)),
            "rainMm": None if rain is None else round(rain / hours, 1),
            "sky": sky(nx.get("summary", {}).get("symbol_code")),
            "step": hours,
        }

    om = get("https://api.open-meteo.com/v1/forecast?"
             f"latitude={LAT}&longitude={LON}&timezone=Pacific%2FAuckland&wind_speed_unit=kn"
             f"&start_date={start}&end_date={end}"
             "&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,precipitation_probability,temperature_2m,cloud_cover,weather_code"
             "&daily=sunrise,sunset,temperature_2m_max")
    oh = om["hourly"]; ohi = {t: i for i, t in enumerate(oh["time"])}

    mar = get("https://marine-api.open-meteo.com/v1/marine?"
              f"latitude={INNER[0]},{OPEN[0]}&longitude={INNER[1]},{OPEN[1]}&cell_selection=sea"
              "&hourly=swell_wave_height,swell_wave_period,swell_wave_direction,wave_height,wave_period,wave_direction,sea_surface_temperature"
              f"&timezone=Pacific%2FAuckland&start_date={start}&end_date={end}")
    inner, open_ = mar[0]["hourly"], mar[1]["hourly"]

    tides, tide_log = fetch_tides(dates, start, end, a.out, now)

    def wmo_sky(code):
        if code is None: return None
        if code >= 95: return "storm"
        if code >= 80: return "showers"
        if code >= 51: return "rain"
        if code >= 45: return "fog"
        if code == 3: return "cloud"
        if code in (1, 2): return "partly"
        return "sun"

    days = []
    for di, d in enumerate(dates):
        slots = []
        for h in SLOT_HOURS:
            t = dt.datetime(d.year, d.month, d.day, h, tzinfo=TZ)
            key = f"{d}T{h:02d}:00"
            # met.no: smooth over h-1..h+1 while it is hourly; after ~2.5 days it is 6-hourly, use the exact step only
            mn = [metno[k] for k in (t - dt.timedelta(hours=1), t, t + dt.timedelta(hours=1))
                  if k in metno and metno[k]["step"] == 1]
            if not mn and t in metno:
                mn = [metno[t]]
            om_i = ohi.get(key)
            om_w = None
            if om_i is not None and oh["wind_speed_10m"][om_i] is not None:
                om_w = (oh["wind_direction_10m"][om_i], oh["wind_speed_10m"][om_i])
            if not mn and om_w is None:
                continue
            # Blend direction as a vector mean (met.no smoothed vs Open-Meteo, equal weight); speed = plain mean.
            models, u, v, spd = {}, 0.0, 0.0, []
            if mn:
                mu = sum(math.sin(math.radians(x["windDirDeg"])) * x["windKn"] for x in mn) / len(mn)
                mv = sum(math.cos(math.radians(x["windDirDeg"])) * x["windKn"] for x in mn) / len(mn)
                mk = sum(x["windKn"] for x in mn) / len(mn)
                md = math.degrees(math.atan2(mu, mv)) % 360
                models["metno"] = [round(md), round(mk, 1)]
                u += math.sin(math.radians(md)) * mk; v += math.cos(math.radians(md)) * mk; spd.append(mk)
            if om_w:
                models["openmeteo"] = [round(om_w[0]), round(om_w[1], 1)]
                u += math.sin(math.radians(om_w[0])) * om_w[1]; v += math.cos(math.radians(om_w[0])) * om_w[1]; spd.append(om_w[1])
            kn = sum(spd) / len(spd)
            wdir = round(math.degrees(math.atan2(u, v)) % 360) if (u or v) else (models.get("metno") or models["openmeteo"])[0]
            exact = metno.get(t)
            rain = []
            if exact and exact["step"] == 1 and exact.get("rainMm") is not None: rain.append(exact["rainMm"])
            if om_i is not None and oh["precipitation"][om_i] is not None: rain.append(oh["precipitation"][om_i])
            slot = {"time": f"{h:02d}:00", "windDirDeg": wdir % 360, "windKn": round(kn, 1)}
            if om_i is not None and oh["wind_gusts_10m"][om_i] is not None:
                slot["gustKn"] = round(max(oh["wind_gusts_10m"][om_i], kn), 1)
            if rain: slot["rainMm"] = round(sum(rain) / len(rain), 1)
            if om_i is not None and oh["precipitation_probability"][om_i] is not None:
                slot["rainProbPct"] = round(oh["precipitation_probability"][om_i])
            if exact and exact["step"] == 1:
                slot.update({"airC": exact["airC"], "cloudPct": exact["cloudPct"]})
                if exact.get("sky"): slot["sky"] = exact["sky"]
            elif om_i is not None:
                slot.update({"airC": round(oh["temperature_2m"][om_i], 1), "cloudPct": round(oh["cloud_cover"][om_i])})
                sk = wmo_sky(oh["weather_code"][om_i])
                if sk: slot["sky"] = sk
            slot["src"] = "+".join(k for k in ("metno", "openmeteo") if k in models)
            slot["models"] = models
            slots.append(slot)
        swell = []
        for h in SWELL_HOURS:
            key = f"{d}T{h:02d}:00"
            if key not in inner["time"]: continue
            i = inner["time"].index(key); j = open_["time"].index(key)
            swell.append({"time": f"{h:02d}:00",
                          "open": {"swellM": open_["swell_wave_height"][j], "periodS": open_["swell_wave_period"][j],
                                   "dirDeg": open_["swell_wave_direction"][j], "waveM": open_["wave_height"][j]},
                          "inner": {"waveM": inner["wave_height"][i], "periodS": inner["wave_period"][i],
                                    "dirDeg": inner["wave_direction"][i]}})
        sst = [inner["sea_surface_temperature"][k] for k, t in enumerate(inner["time"])
               if t.startswith(str(d)) and 9 <= int(t[11:13]) <= 18 and inner["sea_surface_temperature"][k] is not None]
        di_om = om["daily"]["time"].index(str(d))
        day = {"date": str(d),
               "sunrise": om["daily"]["sunrise"][di_om][11:16],
               "sunset": om["daily"]["sunset"][di_om][11:16],
               "airMaxC": om["daily"]["temperature_2m_max"][di_om],
               "waterTempC": round(sum(sst) / len(sst), 1) if sst else None,
               "tides": tides.get(d, []),
               **({"tidesSource": tide_log["bySource"][str(d)]} if tide_log["bySource"].get(str(d)) not in ("tides4fishing", None) else {}),
               "slots": slots, "swell": swell}
        if d.weekday() >= 5:
            day["traffic"] = {"level": "busy",
                              "note": "Weekend: expect queues through Matakana village, worst late morning to mid-afternoon"}
        if day["waterTempC"] is None: del day["waterTempC"]
        days.append(day)

    out = {
        "schemaVersion": 1,
        "updated": now.replace(microsecond=0).isoformat(),
        "timezone": "Pacific/Auckland",
        "location": {"name": "Snells Beach", "lat": LAT, "lon": LON},
        "sources": [
            {"what": "Wind & weather (blended)", "name": "met.no Locationforecast (Snells Beach)",
             "url": f"https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={LAT}&lon={LON}",
             "issued": dt.datetime.fromisoformat(met["properties"]["meta"]["updated_at"].replace("Z", "+00:00")).astimezone(TZ).replace(microsecond=0).isoformat()},
            {"what": "Wind (blended), gusts, rain chance, sun", "name": "Open-Meteo forecast (best match)", "url": f"https://api.open-meteo.com/v1/forecast?latitude={LAT}&longitude={LON}"},
            {"what": "Swell & sea temp", "name": "Open-Meteo Marine (Kawau Bay; off Te Ārai)", "url": "https://open-meteo.com/en/docs/marine-weather-api"},
            {"what": "Tides", "name": "tides4fishing Mahurangi Harbour" + ("" if tide_log["ok"] else
                     " (site unreachable this run: using the last good table" + (", some days estimated" if "computed" in tide_log["bySource"].values() else "") + ")"),
             "url": TIDE_URL},
        ],
        "days": days,
        "fetchLog": [tide_log],
    }
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from observations import collect, live_line
        obs, osrc = collect(now)
    except Exception as e:  # live obs must never break the forecast
        print("warning: observations:", e, file=sys.stderr)
        obs, osrc, live_line = None, None, (lambda o: "Live: no station readings right now.")
    if obs:
        out["observations"] = obs; out["sources"].append(osrc)
    with open(os.path.join(os.path.dirname(a.out) or ".", "live.txt"), "w", encoding="utf-8") as f:
        f.write(live_line(obs) + "\n")
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"wrote {a.out}: {len(days)} days, updated {out['updated']}")
    # rolling 48 h rain history for the header heatline; never breaks the forecast run
    try:
        from rain_history import update as rain_update
        rh = rain_update(os.path.join(os.path.dirname(a.out) or ".", "rain_history.json"), obs, now)
        print(f"wrote rain_history.json: {len(rh['hours'])} hours ({sum(h['src'] == 'station' for h in rh['hours'])} from stations)")
    except Exception as e:
        print("warning: rain_history.json:", e, file=sys.stderr)
    try:
        from observations import API_CALLS
        print(f"PWS API calls this run: {sum(API_CALLS.values())} " + json.dumps(API_CALLS, sort_keys=True))
    except Exception:  # noqa: BLE001
        pass
    # tiny 3-pick summary for the wall screen, scored by app.js itself; never breaks the forecast run
    try:
        import subprocess
        here = os.path.dirname(os.path.abspath(__file__))
        r = subprocess.run(["node", os.path.join(here, "summary.js"), "--out",
                            os.path.join(os.path.dirname(a.out) or ".", "summary.json")],
                           capture_output=True, text=True, timeout=60)
        print((r.stdout or "").strip() or f"warning: summary.js: {(r.stderr or '').strip()[-300:]}")
    except Exception as e:
        print("warning: summary.json:", e, file=sys.stderr)


if __name__ == "__main__":
    main()
