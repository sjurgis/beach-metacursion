"""Live observations for the Snells Beach page.

Home weather stations (Weather Underground PWS): the official PWS API is the primary source. The key comes from
$WU_API_KEY or ~/.config/snells-beach/wu_api_key (never committed, never printed, never in an error message).
Stations the API doesn't answer for fall back to the public station pages, then headless Chrome (below), and with
no home station at all to the official airport METAR (aviationweather.gov, keyless),
which is 50+ km away, so it is shown but NOT blended into near-term scoring.
Nothing is invented: missing or stale readings are dropped.
"""
import datetime as dt, json, os, sys, urllib.request
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Pacific/Auckland")
KMH_TO_KN = 0.539957
METAR_IDS = ["NZWP", "NZAA"]
MAX_AGE_MIN = 90


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "snells-beach/1.0 github.com/sjurgis/snells-beach"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8") or "null")


def _fresh(t, now):
    return t is not None and (now - t).total_seconds() / 60 <= MAX_AGE_MIN


KEY_FILE = os.path.expanduser("~/.config/snells-beach/wu_api_key")
API = "https://api.weather.com/v2/pws/"
API_CALLS = {}        # endpoint -> calls this run (reported in fetchLog and the run output); limit ~1500/day, 30/min


def api_key():
    k = os.environ.get("WU_API_KEY", "").strip()
    if not k:
        try:
            with open(KEY_FILE, encoding="utf-8") as f: k = f.read().strip()
        except OSError: k = ""
    return k


def api_get(endpoint, params, key):
    """GET one PWS API endpoint. Errors never include the URL (it carries the key)."""
    import urllib.error, urllib.parse
    API_CALLS[endpoint] = API_CALLS.get(endpoint, 0) + 1
    q = urllib.parse.urlencode({**params, "format": "json", "units": "m", "numericPrecision": "decimal"})
    req = urllib.request.Request(f"{API}{endpoint}?{q}&apiKey={urllib.parse.quote(key)}",
                                 headers={"User-Agent": "snells-beach/1.0 github.com/sjurgis/snells-beach"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            if r.status == 204: return None
            return json.loads(r.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"PWS API {endpoint} HTTP {e.code}") from None
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"PWS API {endpoint} {type(e).__name__}") from None


def wu(key, now, stations, log):
    """Current readings from the official PWS API, one call per station (in parallel, well under 30/min)."""
    from concurrent.futures import ThreadPoolExecutor
    def one(st):
        sid, name, lat, lon = st
        entry = {"id": sid, "ok": False, "method": "api"}
        try:
            j = api_get("observations/current", {"stationId": sid}, key)
        except Exception as e:  # noqa: BLE001
            entry["error"] = str(e); return None, entry
        for o in (j or {}).get("observations", []):
            t = dt.datetime.fromisoformat(o["obsTimeUtc"].replace("Z", "+00:00")).astimezone(TZ)
            m = o.get("metric") or {}
            if not _fresh(t, now): entry["error"] = f"latest reading old ({t:%H:%M})"; continue
            if m.get("windSpeed") is None: entry["error"] = "no wind in latest reading"; continue
            entry["ok"] = True
            return {
                "id": sid, "name": name, "kind": "home",
                "lat": o.get("lat") or lat, "lon": o.get("lon") or lon, "time": t.replace(microsecond=0).isoformat(),
                "windKn": round(m["windSpeed"] * KMH_TO_KN, 1),
                "gustKn": None if m.get("windGust") is None else round(m["windGust"] * KMH_TO_KN, 1),
                "windDirDeg": o.get("winddir"), "airC": m.get("temp"),
                "pressureHpa": None if m.get("pressure") is None else round(m["pressure"], 1),
                "rainRateMmH": None if m.get("precipRate") is None else round(m["precipRate"], 1),
                "rainTodayMm": None if m.get("precipTotal") is None else round(m["precipTotal"], 1),
                "url": f"https://www.wunderground.com/dashboard/pws/{sid}", "via": "api",
            }, entry
        entry.setdefault("error", "no observations (station offline)"); return None, entry
    with ThreadPoolExecutor(max_workers=4) as ex:
        res = list(ex.map(one, stations))
    for r, e in res:
        log.append(e)
        if not r: print(f"warning: WU API {e['id']}: {e.get('error')}", file=sys.stderr)
    return [r for r, _ in res if r]


def metar(now):
    try:
        j = _get("https://aviationweather.gov/api/data/metar?format=json&ids=" + ",".join(METAR_IDS))
    except Exception as e:
        print(f"warning: METAR: {e}", file=sys.stderr); return []
    by = {o.get("icaoId"): o for o in j or []}
    for icao in METAR_IDS:  # nearest available airport only
        o = by.get(icao)
        if not o or o.get("wspd") is None: continue
        t = dt.datetime.fromtimestamp(o["obsTime"], dt.timezone.utc).astimezone(TZ)
        if not _fresh(t, now): continue
        wdir = o.get("wdir"); raw = o.get("rawOb") or ""
        return [{
            "id": icao, "name": (o.get("name") or icao).split(",")[0], "kind": "airport",
            "lat": o.get("lat"), "lon": o.get("lon"), "time": t.replace(microsecond=0).isoformat(),
            "windKn": float(o["wspd"]), "gustKn": None if o.get("wgst") is None else float(o["wgst"]),
            "windDirDeg": wdir if isinstance(wdir, (int, float)) else None,
            "airC": o.get("temp"), "pressureHpa": o.get("altim"), "rainRateMmH": None, "rainTodayMm": None,
            "raining": any(w in raw for w in ("RA ", "DZ ", "SHRA")),
            "url": f"https://aviationweather.gov/data/metar/?id={icao}",
        }]
    return []


# --- Public station pages (Jurgis asked for this): parse the HTML wunderground.com serves.
# The dashboard is Angular SSR; the server embeds the station's recent 5-minute readings in
# <script id="app-root-state">. We read only that served content: no API key is extracted or
# reused, one request per station, short timeout, and any block/captcha just means "no data".
# (id, name, lat, lon). Found via weatherwatch.co.nz's station list and checked on wunderground.com, 18 Oct 2026.
PAGE_STATIONS = [
    ("IWARKW15", "Algies Bay", -36.435, 174.74), ("ISNELL2", "Snells Beach", -36.415, 174.726),
    ("ISNELL1", "Snells Beach", -36.415, 174.726), ("IWARKW128", "Sandspit", -36.397, 174.724),
    ("IWARKW125", "Mahurangi East", -36.473, 174.734), ("IWARKW107", "Mahurangi East", -36.474, 174.735),
    ("IWARKWOR11", "Point Wells (Omaha)", -36.3425, 174.7594), ("IWARKW99", "Omaha Flats", -36.34, 174.742),
]
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
MPH_TO_KN, INHG_TO_HPA, IN_TO_MM = 0.868976, 33.8639, 25.4


def _page_urls(sid, now):
    d = now.date().isoformat()
    return [f"https://www.wunderground.com/dashboard/pws/{sid}",
            f"https://www.wunderground.com/dashboard/pws/{sid}/table/{d}/{d}/daily",
            f"https://www.wunderground.com/dashboard/pws/{sid}/graph/{d}/{d}/daily"]


def _parse_state(html, sid):
    """Latest 5-minute reading from the server-rendered app-root-state, or None if this page variant has none.
    WU is A/B-testing a new front end (x-origin-hint: WuNext-Preview-Phased) that renders nothing server-side;
    those pages carry no readings at all, so the only legitimate option is to ask again."""
    from bs4 import BeautifulSoup
    tag = BeautifulSoup(html, "html.parser").find("script", id="app-root-state")
    if not tag or not tag.string: return None
    raw = tag.string
    for x, y in (("&q;", '"'), ("&s;", "'"), ("&l;", "<"), ("&g;", ">"), ("&a;", "&")): raw = raw.replace(x, y)
    obs = []
    for v in json.loads(raw).values():
        bb = v.get("b") if isinstance(v, dict) else None
        if isinstance(bb, dict) and isinstance(bb.get("observations"), list) and "/pws/observations/" in str(v.get("u", "")):
            obs = [o for o in bb["observations"] if o.get("stationID") == sid and o.get("epoch")] or obs
    return max(obs, key=lambda o: o["epoch"]) if obs else None


def page_station(sid, name, now, log, lat=None, lon=None):
    import requests, time
    headers = {"User-Agent": BROWSER_UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
               "Accept-Language": "en-NZ,en;q=0.9"}
    urls = _page_urls(sid, now)
    o, tries = None, []
    for i in range(4):   # fresh request each time (no cookies), so each try gets a new A/B assignment
        url = urls[i % len(urls)]
        try:
            r = requests.get(url, headers=headers, timeout=15, proxies=_wu_proxies())
            variant = r.headers.get("x-origin-hint", "?")
            tries.append(f"{r.status_code}:{variant}")
            if r.status_code == 200: o = _parse_state(r.text, sid)
        except Exception as e:
            tries.append(f"err:{type(e).__name__}")
        if o: break
        if i < 3: time.sleep(2 * (i + 1))
    entry = {"id": sid, "ok": False, "method": "page", "via": "home" if wu_proxy() else "direct", "attempts": len(tries), "tries": tries}
    log.append(entry)
    if not o: entry["error"] = NO_STATE; raise ValueError(entry["error"])
    return _reading_from_state(o, sid, name, now, entry, lat, lon)


NO_STATE = "no readings in served page (client-rendered variant)"


def _reading_from_state(o, sid, name, now, entry, lat=None, lon=None):
    t = dt.datetime.fromtimestamp(o["epoch"], dt.timezone.utc).astimezone(TZ)
    if not _fresh(t, now): entry["error"] = f"latest reading old ({t:%H:%M})"; raise ValueError(entry["error"])
    if "metric" in o and isinstance(o["metric"], dict):
        m = o["metric"]; k = KMH_TO_KN
        wind, gust, temp, pres = m.get("windspeedAvg"), m.get("windgustHigh"), m.get("tempAvg"), m.get("pressureMax")
        rate, tot = m.get("precipRate"), m.get("precipTotal"); pk, rk = 1, 1
        tc = lambda v: v
    else:
        m = o.get("imperial") or {}; k = MPH_TO_KN
        wind, gust, temp, pres = m.get("windspeedAvg"), m.get("windgustHigh"), m.get("tempAvg"), m.get("pressureMax")
        rate, tot = m.get("precipRate"), m.get("precipTotal"); pk, rk = INHG_TO_HPA, IN_TO_MM
        tc = lambda f: None if f is None else (f - 32) * 5 / 9
    if wind is None: entry["error"] = "no wind in latest reading"; raise ValueError(entry["error"])
    r1 = lambda v, f: None if v is None else round(v * f, 1)
    entry["ok"] = True
    return {
        "id": sid, "name": name, "kind": "home", "lat": o.get("lat") or lat, "lon": o.get("lon") or lon,
        "time": t.replace(microsecond=0).isoformat(),
        "windKn": r1(wind, k), "gustKn": r1(gust, k), "windDirDeg": o.get("winddirAvg"),
        "airC": None if temp is None else round(tc(temp), 1), "pressureHpa": r1(pres, pk),
        "rainRateMmH": r1(rate, rk), "rainTodayMm": r1(tot, rk),
        "url": f"https://www.wunderground.com/dashboard/pws/{sid}", "via": entry.get("method", "page"),
    }


# --- Fallback: render the public dashboard in headless Chrome and read what it DISPLAYS.
# Chrome runs the page like a normal visitor's browser; we only read the rendered DOM text
# (or the page's own server-rendered state if that variant comes back). We never touch the
# page's API key and never call api.weather.com ourselves. One render per station per run.
# Google Chrome on the box force-installs policy extensions (/etc/opt/chrome/policies), which keep
# --dump-dom from ever exiting, so prefer Playwright's chrome-headless-shell (ignores those policies).
def _find_chrome():
    import glob
    hs = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")))
    return os.environ.get("WU_CHROME") or (hs[-1] if hs else "/usr/bin/google-chrome")
CHROME = _find_chrome()
RENDER_TIMEOUT_S = 45
RENDER_PARALLEL = 3

# Jurgis's home connection (Tailscale exit node via userspace tailscaled HTTP proxy). Used ONLY for
# wunderground.com fetches, and only when the proxy port answers; otherwise we go direct.
WU_PROXY = os.environ.get("WU_PROXY", "http://localhost:1056")
_proxy_ok = None


def wu_proxy():
    global _proxy_ok
    if _proxy_ok is None:
        import socket, urllib.parse
        u = urllib.parse.urlparse(WU_PROXY)
        try:
            socket.create_connection((u.hostname, u.port), timeout=2).close(); _proxy_ok = bool(WU_PROXY)
        except OSError:
            _proxy_ok = False
    return WU_PROXY if _proxy_ok else None


def _wu_proxies():
    p = wu_proxy()
    return {"http": p, "https": p} if p else None


def _parse_display(text, now):
    import re
    t = " ".join(text.split())
    if "connected" not in t: raise ValueError("station not shown as connected")
    m = re.search(r"connected\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s+NZ[DS]T\s+on\s+([A-Z][a-z]+ \d{1,2}, \d{4})", t)
    if not m: raise ValueError("no observation time on rendered page")
    h = int(m.group(1)) % 12 + (12 if m.group(3) == "PM" else 0)
    d = dt.datetime.strptime(m.group(4), "%B %d, %Y")
    when = dt.datetime(d.year, d.month, d.day, h, int(m.group(2)), tzinfo=TZ)
    num = lambda rx: (lambda mm: float(mm.group(1)) if mm else None)(re.search(rx, t))
    w = re.search(r"\bWind\s+([\d.]+)\s+gusts\s+([\d.]+)\s+(\d{1,3})°", t)
    if not w: raise ValueError("no wind on rendered page")
    temp, pres = num(r"\bTemperature\s+(-?[\d.]+)"), num(r"\bPressure\s+([\d.]+)")
    pr = re.search(r"\bPrecipitation\s+([\d.]+)\s+([\d.]+)", t)
    imperial = pres is None or pres < 40          # inHg -> the page is in US units (°F, mph, in)
    k, pk, rk = (MPH_TO_KN, INHG_TO_HPA, IN_TO_MM) if imperial else (KMH_TO_KN, 1, 1)
    r1 = lambda v, f: None if v is None else round(v * f, 1)
    return when, {
        "windKn": r1(float(w.group(1)), k), "gustKn": r1(float(w.group(2)), k), "windDirDeg": int(w.group(3)) % 360,
        "airC": None if temp is None else round((temp - 32) * 5 / 9 if imperial else temp, 1),
        "pressureHpa": r1(pres, pk),
        # the widget shows today's total first (main value), then the rate (secondary)
        "rainTodayMm": r1(float(pr.group(1)), rk) if pr else None, "rainRateMmH": r1(float(pr.group(2)), rk) if pr else None,
    }


def _rain_widget(rw):
    """Rain from the precipitation widget's own attributes (data-precip-rate / data-precip-total), {} if absent."""
    if rw is None: return {}
    f = IN_TO_MM if (rw.get("data-unit") or "e") == "e" else 1
    out = {}
    for attr, key in (("data-precip-rate", "rainRateMmH"), ("data-precip-total", "rainTodayMm")):
        try: out[key] = round(float(rw.get(attr)) * f, 1)
        except (TypeError, ValueError): pass
    return out


def render_station(sid, name, now, entry, lat=None, lon=None):
    import subprocess, tempfile, time
    from bs4 import BeautifulSoup
    entry["method"] = "render"
    t0 = time.time()
    import signal
    px = wu_proxy()
    with tempfile.TemporaryDirectory(prefix="wu-chrome-", ignore_cleanup_errors=True) as prof:
        cmd = [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
               f"--user-data-dir={prof}", f"--user-agent={BROWSER_UA}", "--timeout=25000"]
        if px: cmd.append(f"--proxy-server={px}")
        cmd += ["--dump-dom", f"https://www.wunderground.com/dashboard/pws/{sid}"]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
        try:
            html, _ = p.communicate(timeout=RENDER_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            html = None
        finally:   # kill the whole process group so no renderer/zygote is left orphaned
            try: os.killpg(p.pid, signal.SIGKILL)
            except OSError: pass
            p.wait()
        if html is None:
            entry["renderS"] = RENDER_TIMEOUT_S; entry["error"] = "render timed out"; raise ValueError(entry["error"])
    entry["renderS"] = round(time.time() - t0, 1)
    o = _parse_state(html, sid)                    # if the old variant came back, its own data is exact
    entry["parse"] = "state" if o else "display"
    if o: return _reading_from_state(o, sid, name, now, entry, lat, lon)
    soup = BeautifulSoup(html, "html.parser")
    rw = soup.find("rain-widget-view")
    for tag in soup(["script", "style", "svg"]): tag.decompose()
    try:
        when, v = _parse_display(soup.get_text(" "), now)
    except ValueError as e:
        entry["error"] = f"render: {e}"; raise
    v.update(_rain_widget(rw))
    if not _fresh(when, now): entry["error"] = f"render: latest reading old ({when:%H:%M})"; raise ValueError(entry["error"])
    entry["ok"] = True
    entry.pop("error", None)
    return {"id": sid, "name": name, "kind": "home", "lat": lat, "lon": lon, "time": when.isoformat(), **v,
            "url": f"https://www.wunderground.com/dashboard/pws/{sid}", "via": "render"}


def pages(now, log, stations=None):
    """Plain page fetches for all stations in parallel; any that only got the client-rendered
    variant are then rendered in headless Chrome, at most RENDER_PARALLEL at once."""
    from concurrent.futures import ThreadPoolExecutor
    stations = PAGE_STATIONS if stations is None else stations
    if not stations: return []
    def one(st):
        sid, name, lat, lon = st
        sub = []
        try: return page_station(sid, name, now, sub, lat, lon), sub
        except Exception as e:
            print(f"warning: WU page {sid}: {e}", file=sys.stderr); return None, sub
    with ThreadPoolExecutor(max_workers=len(stations)) as ex:
        res = list(ex.map(one, stations))
    todo = [(st, sub[0]) for st, (r, sub) in zip(stations, res) if r is None and sub and sub[0].get("error") == NO_STATE]
    def rend(item):
        (sid, name, lat, lon), entry = item
        entry["pageError"] = entry.pop("error", None)
        try: return sid, render_station(sid, name, now, entry, lat, lon)
        except Exception as e:
            entry.setdefault("error", f"render: {e}"); print(f"warning: WU render {sid}: {e}", file=sys.stderr); return sid, None
    rendered = {}
    if todo and os.path.exists(CHROME):
        with ThreadPoolExecutor(max_workers=RENDER_PARALLEL) as ex:
            rendered = dict(ex.map(rend, todo))
    for _, sub in res: log.extend(sub)
    return [r or rendered.get(st[0]) for st, (r, _) in zip(stations, res) if (r or rendered.get(st[0]))]


def collect(now=None):
    """(observations dict or None, sources entry or None). API first; stations it misses go to the pages."""
    now = now or dt.datetime.now(TZ)
    key = api_key()
    log = []
    st = wu(key, now, PAGE_STATIONS, log) if key else []
    got = {x["id"] for x in st}
    missing = [x for x in PAGE_STATIONS if x[0] not in got]
    if missing:
        st += pages(now, log, missing)
    order = [x[0] for x in PAGE_STATIONS]
    st.sort(key=lambda x: order.index(x["id"]) if x["id"] in order else 99)
    calls = dict(API_CALLS)
    if st:
        vias = {x.get("via") for x in st}
        how = "Weather Underground PWS API" if vias == {"api"} else (
              "Weather Underground PWS API + station pages" if "api" in vias else "Weather Underground station pages")
        return ({"fetched": now.replace(microsecond=0).isoformat(), "kind": "home", "blend": True, "stations": st,
                 "fetchLog": log, "apiCalls": calls},
                {"what": "Live wind & rain (home stations)", "name": f"{how}: " + ", ".join(dict.fromkeys(x["name"] for x in st)),
                 "url": "https://www.wunderground.com/wundermap"})
    st = metar(now)
    if not st: return None, None
    return ({"fetched": now.replace(microsecond=0).isoformat(), "kind": "airport", "blend": False, "stations": st,
             "fetchLog": log, "apiCalls": calls},
            {"what": "Live wind (airport, shown only)", "name": "aviationweather.gov METAR", "url": "https://aviationweather.gov/"})


DIRS = "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split()


def live_line(obs):
    if not obs: return "Live: no station readings right now."
    def one(s):
        t = dt.datetime.fromisoformat(s["time"]); h = t.hour % 12 or 12
        d = DIRS[round(s["windDirDeg"] / 22.5) % 16] + " " if s.get("windDirDeg") is not None and s["windKn"] >= 1 else ""
        g = f" gust {round(s['gustKn'])}" if s.get("gustKn") else ""
        tc = f", {round(s['airC'])}°C" if s.get("airC") is not None else ""
        r = f", rain {s['rainRateMmH']} mm/h" if s.get("rainRateMmH") else (", raining" if s.get("raining") else "")
        return f"{s['name']} ({s['id']}) {('calm' if s['windKn'] < 1 else d + str(round(s['windKn'])) + ' kn')}{g}{tc}{r} (at {h}:{t.minute:02d}{'pm' if t.hour >= 12 else 'am'})"
    if obs["kind"] == "home" and len(obs["stations"]) == 1:
        return "Live: " + one(obs["stations"][0]).replace(" (", " home station (", 1)
    lead = "Live home stations" if obs["kind"] == "home" else "Live (airport, 50+ km away; the Algies/Snells station pages did not load this run)"
    return lead + ": " + "; ".join(one(s) for s in obs["stations"][:5])
