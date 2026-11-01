# `data/forecast.json` — the daily file

This is the **only** file the morning job rewrites. The page (`index.html`, `app.js`, `style.css`) and the
beach guide (`data/beaches.json`) stay as they are. The page scores every beach from this file, so it needs
numbers, not prose.

Easiest path: `python3 scripts/update_forecast.py && python3 scripts/validate.py` (fetches everything below
and writes the file). If you fill it by hand or from other sources, follow this spec exactly.

All times are **local Pacific/Auckland wall-clock time**, `"HH:MM"` 24-hour (e.g. `"07:00"`, `"19:17"`).
Units are in the field names: `Kn` knots, `M` metres, `S` seconds, `Deg` degrees true, `C` °C, `Mm` mm, `Pct` %.

## Top level

| field | type | required | meaning |
|---|---|---|---|
| `schemaVersion` | number | yes | always `1` |
| `updated` | string | yes | ISO 8601 **with offset**, when this file was made, e.g. `"2026-10-09T07:19:00+13:00"` (NZDT +13, NZST +12) |
| `timezone` | string | yes | always `"Pacific/Auckland"` |
| `location` | object | no | `{ "name": "Snells Beach", "lat": -36.42, "lon": 174.73 }` (info only) |
| `sources` | array | yes | non-empty; each `{ "what": "Wind & weather", "name": "met.no Locationforecast", "url": "https://…", "issued": "<ISO time, optional>" }`. Shown in the footer. |
| `days` | array | yes | consecutive dates, **today first**, normally 4 days (today + 3) |

## `days[]`

| field | type | required | meaning |
|---|---|---|---|
| `date` | `"YYYY-MM-DD"` | yes | local date |
| `sunrise`, `sunset` | `"HH:MM"` | yes | local times; slots outside daylight are ignored for picks |
| `airMaxC` | number | no | daily max air temp °C |
| `waterTempC` | number | no | sea surface temp °C (daytime mean, Kawau Bay) |
| `tides` | array | yes | every high/low turn that day **in time order, alternating**: `{ "time": "06:59", "type": "high", "heightM": 2.7 }`. Mahurangi Harbour. At least 2. |
| `tidesSource` | string | no | only when the tide site failed: `"previous"` (copied from the last good forecast.json) or `"computed"` (last known highs/lows carried forward by half tide-cycles, ~15–30 min off). Absent = fresh from tides4fishing. |
| `slots` | array | yes | weather **every hour** `06:00`–`20:00`, in time order (at least 2, at least one in daylight). The page scores each hour, so hourly data gives the best windows and the now-vs-later timeline. |
| `swell` | array | yes | sea state at `06:00, 09:00, 12:00, 15:00, 18:00` (at least 1). The nearest entry to each slot is used. |
| `traffic` | object | no | `{ "level": "light" \| "moderate" \| "busy", "note": "short text" }`. Put it on Saturdays, Sundays and public holidays (Labour Day = 4th Monday of October). Its presence turns on the Matakana chip and a small score penalty for beaches through Matakana; weekends get the chip even without it. It is a heuristic note, not live traffic. |

### `slots[]`

| field | type | required | meaning |
|---|---|---|---|
| `time` | `"HH:MM"` | yes | local |
| `windDirDeg` | number 0–360 | yes | direction the wind blows **from**, degrees true (90 = easterly). Use the blend below, not a single model hour. |
| `windKn` | number | yes | mean wind speed, knots (met.no gives m/s: × 1.94384) |
| `gustKn` | number | no | gust, knots (≥ `windKn`) |
| `rainMm` | number | no | rain in the hour, mm (mean of met.no and Open-Meteo where both exist) |
| `rainProbPct` | number 0–100 | no, strongly recommended | chance of rain that hour, % (Open-Meteo `precipitation_probability`). Drives rain scoring and the rain chip; without it the page falls back to `rainMm`/`sky` and validate.py warns. |
| `airC` | number | no | air temp °C |
| `cloudPct` | number 0–100 | no | cloud cover |
| `sky` | string | no | one of `sun`, `partly`, `cloud`, `fog`, `showers`, `rain`, `storm` (drives the icon and a small rain penalty) |
| `src` | string | no | which models went in, e.g. `"metno+openmeteo"` (info only) |
| `models` | object | no | raw per-model wind for checking, `{ "metno": [dirDeg, kn], "openmeteo": [dirDeg, kn] }` (info only) |

**Wind blend (how `update_forecast.py` makes `windDirDeg`/`windKn`).** One model hour in light air can point
anywhere (on Sat 10 Oct 2026 met.no's 7am value was 345°/NNW while every other hour and model said N–NNE).
So each slot is: met.no averaged as vectors over h-1, h, h+1 (while met.no is hourly; its 6-hourly steps later in
the run are used only at their exact hour), then vector-averaged with Open-Meteo's hour h at equal weight.
Speed is the plain mean of the two. The page shows winds under 5 kn as "light", with no direction.

### `swell[]`

| field | type | required | meaning |
|---|---|---|---|
| `time` | `"HH:MM"` | yes | local |
| `open.swellM` | number | yes | swell height off Te Ārai (open coast), metres. Drives surf scores. |
| `open.periodS` | number | yes | swell period, seconds |
| `open.dirDeg` | number | yes | direction swell comes **from**, degrees true (45 = NE) |
| `open.waveM` | number | no | total significant wave height off Te Ārai, metres (flatness at open beaches) |
| `inner.waveM` | number | yes | total significant wave height in Kawau Bay, metres (flatness at the inner bays) |
| `inner.periodS`, `inner.dirDeg` | number | no | as above, Kawau Bay |

Open-Meteo Marine grid points used: inner `-36.42, 174.80` (snaps to -36.458, 174.875) and open `-36.13, 174.85`
(snaps to -36.125, 174.875), `cell_selection=sea`, hourly `swell_wave_height, swell_wave_period,
swell_wave_direction, wave_height, wave_period, wave_direction, sea_surface_temperature`.

## Minimal example (one day shown)

```json
{
  "schemaVersion": 1,
  "updated": "2026-10-09T07:19:00+13:00",
  "timezone": "Pacific/Auckland",
  "sources": [
    {"what": "Wind & weather", "name": "met.no Locationforecast", "url": "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=-36.42&lon=174.73"},
    {"what": "Swell & sea temp", "name": "Open-Meteo Marine", "url": "https://open-meteo.com/en/docs/marine-weather-api"},
    {"what": "Tides", "name": "tides4fishing Mahurangi Harbour", "url": "https://tides4fishing.com/nz/auckland/mahurangi-harbour"}
  ],
  "days": [
    {
      "date": "2026-10-10",
      "sunrise": "06:44", "sunset": "19:32",
      "airMaxC": 19.0, "waterTempC": 16.1,
      "tides": [
        {"time": "01:36", "type": "low",  "heightM": 0.6},
        {"time": "07:51", "type": "high", "heightM": 2.8},
        {"time": "13:57", "type": "low",  "heightM": 0.6},
        {"time": "20:06", "type": "high", "heightM": 2.8}
      ],
      "slots": [
        {"time": "07:00", "windDirDeg": 6,  "windKn": 4.6, "gustKn": 4.6, "rainMm": 0.1, "rainProbPct": 0, "sky": "cloud",
         "src": "metno+openmeteo", "models": {"metno": [356, 7.0], "openmeteo": [41, 2.2]}},
        {"time": "13:00", "windDirDeg": 18, "windKn": 11.4, "gustKn": 21.8, "rainMm": 0.2, "rainProbPct": 75, "sky": "partly"}
      ],
      "swell": [
        {"time": "09:00", "open": {"swellM": 0.5, "periodS": 6.5, "dirDeg": 46, "waveM": 0.62},
                          "inner": {"waveM": 0.32, "periodS": 6.2, "dirDeg": 54}}
      ],
      "traffic": {"level": "busy", "note": "Weekend: expect queues through Matakana village, worst late morning to mid-afternoon"}
    }
  ]
}
```

## Rules of thumb

- Never invent numbers. If a source is down, use another real one (MetService marine, Open-Meteo forecast) and name it in `sources`.
- Keep `updated` honest; the page warns if it is more than 30 hours old.
- After writing: `python3 scripts/validate.py` must print `OK`. Exit code 1 means fix and re-run.

# `data/beaches.json` — the standing guide (rarely edited)

Per beach: `id`, `name`, `area`, `lat`/`lon`, `driveMin`/`driveKm` (OSRM from Snells Beach township),
`viaMatakana`, `facingDeg` (direction the beach looks out to sea; wind from there is onshore, from the opposite side
offshore), `shelteredFrom` (8-point wind directions that the local knowledge says are sheltered, e.g. `["SE"]`),
`tide` (`{"mode":"high",…}` = tide-limited: the page treats it as swimmable from mid-tide rising to mid-tide falling,
i.e. halfway in time between each low and the high; `hours` is kept for reference only. `{"mode":"all"}` = any tide), `exposure`
(`{"source":"inner"|"open","factor":0–1}` scales the Kawau Bay or Te Ārai wave height to this beach),
`highTideSand` (`plenty` | `some` | `little`: dry sand left at high tide, a local estimate used by hangout mode),
`suits` (0–1 per activity: `swim`, `surf`, `snorkel`, `sup`, `hangout`), `notes` (short bullets), optional `doc` (Goat Island DOC limits), and `dog`:
`{verified, checked, source, rules:[{from:"MM-DD", to:"MM-DD", status, chip, text}, …, {status, chip, text}]}`.
Dog rules are matched in order by date (ranges may wrap the new year); the last rule has no dates and is the
catch-all. `status` is `offlead` | `leash` | `limited` (time-restricted) | `banned`. A beach whose rule is not
verified should have `"verified": false` and the page shows "unverified, check signs".

## `observations` (optional) — live station readings

Written by `scripts/observations.py` each run; omitted when nothing fresh (≤ 90 min) is available. Never invented.

| field | type | meaning |
|---|---|---|
| `fetched` | ISO time with offset | when the readings were pulled |
| `kind` | `"home"` \| `"airport"` | `home` = Weather Underground personal stations (needs env `WU_API_KEY`); `airport` = keyless METAR fallback (NZWP/NZAA) |
| `blend` | bool | `true` only for home stations: the page nudges today's wind/gust/direction (≤ 50 % weight, fading to 0 over ±3 h) and current-hour rain toward the readings |
| `fetchLog` | array | per home-station page fetch this run: `{ id, ok, method: "page"|"render", attempts, tries: ["200:wu-next-prod", "200:WuNext-Preview-Phased", …], parse?: "state"|"display", renderS?, pageError?, error? }` (render = headless-Chrome fallback reading the displayed page) (for tracking reliability) |
| `stations[]` | array | `{ id, name, kind, time, windKn, gustKn?, windDirDeg?, airC?, pressureHpa?, rainRateMmH?, rainTodayMm?, raining?, lat?, lon?, url }` |

`data/live.txt` gets one plain-text line summarising the same readings, for the hourly message to quote.

## `fetchLog` (optional, top level) — forecast fetch audit

Array of fetch records from `update_forecast.py`. Today one entry for tides:
`{ "source": "tides4fishing", "url", "at", "ok": bool, "attempts": n, "error"?: "...", "fallback"?: {date: "previous"|"computed"|"none"}, "bySource": {date: "tides4fishing"|"previous"|"computed"|"none"} }`.
A failed tide fetch never stops the run; the forecast and live readings still update.

## data/summary.json (wall screen)

Written every run by `scripts/summary.js` (called from `update_forecast.py` after forecast.json). It loads
`app.js` and scores with the site's own hangout-mode logic and default prefs (Nearby drive, no dog, no favourites),
so the picks match the page. Covers the rest of today, or tomorrow once it's about 7pm (or 30 min before sunset).
Fetched directly over HTTPS by the ESPHome 480x480 screen. Flat, under 1.5 KB, plain UTF-8, no emoji, keys always
present (empty string when data is missing).

```json
{
  "updated": "07:19",                 // NZ local HH:MM of the run
  "date": "Sun 1 Nov",                // the day the picks are for
  "picks": [                          // exactly 3, best first; name ≤18, window ≤14, note ≤34
    {"name": "Scotts Landing", "window": "8:00-10:30am", "note": "almost still, sheltered, sunny"}
  ],
  "wind": "NNE 10-12kn g24",          // ≤22, daylight range from now, gust max
  "swell": "0.2m, no surf",           // ≤22, max open-coast swell
  "tide": "High 2:30pm (est)"         // ≤22, "(est)" when tidesSource is "computed"
}
```

Picks: top two hangout beaches (distinct), then the swim window at Algies/Snells when the tide gives ≥1.5 h
(score ≥50), else the third hangout beach. Times are rounded to the half hour; "Now-…" means it's good already.
Checked by `validate.py`.
