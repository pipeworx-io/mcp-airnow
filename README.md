# @pipeworx/airnow

EPA AirNow MCP — official US real-time + forecast AQI.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `current_by_zip(zip_code, distance_miles?)`
- `current_by_location(latitude, longitude, distance_miles?)`
- `forecast_by_zip(zip_code, date?, distance_miles?)`
- `observations_in_bbox(bbox, start_date, end_date, parameters?, data_type?, verbose?)`

## Auth

- **Platform key:** gateway env `PLATFORM_AIRNOW_KEY`.
- **BYO:** `?_apiKey=<key>` after registering at https://docs.airnowapi.org/account/request/.

Free tier: 500 requests/hour per key.

## Data source

`https://www.airnowapi.org/aq/` — `?API_KEY=` query param.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Airnow data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
