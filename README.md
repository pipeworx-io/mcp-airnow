# @pipeworx/airnow

US EPA AirNow — official current and forecast air quality index (AQI) for every
US reporting area, plus hourly per-site monitor observations. Keyless: reads
AirNow's public file products on `files.airnowtech.org` live per call.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1872+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

AirNow **retired its keyed web service (`www.airnowapi.org/aq/*`) on
2026-10-01**; every call returned HTTP 410 until this pack was moved to the file
products (fleet #2808). The retired-service notice at
`docs.airnowapi.org/webservices/retired` redirects to a login page, so the file
products are the only public route left.

## Tools

- `current_by_zip(zip_code, distance_miles?)` — latest observed AQI per
  pollutant for the reporting area nearest a ZIP, with yesterday's AQI and the
  other reporting areas inside the radius.
- `current_by_location(latitude, longitude, distance_miles?)` — same, for a
  lat/lon.
- `forecast_by_zip(zip_code, date?, distance_miles?)` — issued forecasts (today
  + up to 3 days) per pollutant, with Action Day flag and forecaster discussion.
  Omit `date` for every issued day; `forecast_days_available` lists them.
- `observations_in_bbox(bbox, start_date, end_date, parameters?, data_type?, verbose?)`
  — hourly per-site AQI and concentrations inside `minLon,minLat,maxLon,maxLat`
  for a span of **UTC** hours (`YYYY-MM-DDTHH`), **max 24 hours per call** (one
  ~1 MB upstream file per hour). Pollutants: `OZONE, PM25, PM10, NO2, CO, SO2`
  (AQI exists for the first four only).

Every response carries `data_as_of` (the upstream file's `Last-Modified`),
`source` (the file URL) and `found`. A miss is `{found:false, reason, hint}`:
`zip_not_in_airnow_index`, `no_reporting_area_in_radius`,
`no_forecast_area_in_radius`, `no_forecast_for_date`, `hours_not_published`,
`no_sites_in_bbox`.

## Auth

None. No key, no account.

## Data sources

All under `https://files.airnowtech.org/airnow/` (an S3 bucket AirNow rewrites
hourly; format fact sheets in `airnow/docs/`):

| File | Used by | Refresh |
|------|---------|---------|
| `today/cityzipcodes.csv` — ZIP → city, state, lat, lon (27k rows) | `*_by_zip` | daily |
| `today/reportingarea.dat` — per reporting area: yesterday (`Y`), current observed (`O`), forecast (`F`) rows | `current_*`, `forecast_by_zip` | hourly |
| `YYYY/YYYYMMDD/HourlyAQObs_YYYYMMDDHH.dat` — per-site AQI + concentrations, one file per UTC hour | `observations_in_bbox` | ~30-60 min after the hour |

Quirks worth knowing:

- Forecasts two or more days out often carry a `category` but a `null` AQI —
  that is how the agencies issue them, not a parse gap.
- The current-hour `HourlyAQObs` file does not exist until AirNow publishes it;
  those hours are listed in `hours_not_yet_published` rather than erroring.
- "Nearest reporting area" is by great-circle distance to the area's published
  centroid, so a ZIP on a metro edge may resolve to the neighbouring region
  (ZIP 10001 → "New York City Region", 10 mi). `other_areas_in_radius` shows the
  alternatives.
- The gateway caches `airnow` results for 10 minutes
  (`CACHE_TTL_OVERRIDES`); the pack also keeps the parsed files in the isolate
  for 10 min (reporting area) / 24 h (ZIP index) / 6 h (hourly files).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "airnow": {
      "url": "https://gateway.pipeworx.io/airnow/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/airnow/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1872+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/current_by_zip \
  -H 'Content-Type: application/json' \
  -d '{"zip_code":"10001"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/current_by_zip`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "airnow": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-airnow"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-airnow
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Airnow data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
