interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * EPA AirNow MCP — official US real-time AQI + forecast (free key)
 *
 * AirNow is the EPA's authoritative source for current and forecasted air
 * quality at >2,000 US monitoring sites. Complements `airquality` (Open-Meteo
 * gridded forecast), `openaq` (open dataset), and `waqi` (global private
 * stations) with the EPA-official US layer.
 *
 * API: https://docs.airnowapi.org
 * Auth: ?API_KEY= query param. Free tier 500 req/hour.
 *
 * Tools:
 * - current_by_zip:     latest AQI for a US ZIP code
 * - current_by_location: latest AQI nearest a lat/lon
 * - forecast_by_zip:    AQI forecast for a US ZIP code on a given date
 * - observations_in_bbox: historical observations inside a bounding box
 */


const BASE_URL = 'https://www.airnowapi.org/aq';

const tools: McpToolExport['tools'] = [
  {
    name: 'current_by_zip',
    description:
      'Latest observed AQI for a US ZIP code. Returns one record per pollutant reported at the nearest site (typically O3 + PM2.5). Includes AQI value, category (Good / Moderate / etc.), reporting area, and timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        zip_code: { type: 'string', description: 'US 5-digit ZIP code' },
        distance_miles: { type: 'number', description: 'Search radius (default 25, max 250)' },
      },
      required: ['zip_code'],
    },
  },
  {
    name: 'current_by_location',
    description: 'Latest observed AQI for the AirNow station nearest a lat/lon.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'US latitude' },
        longitude: { type: 'number', description: 'US longitude' },
        distance_miles: { type: 'number', description: 'Search radius (default 25, max 250)' },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'forecast_by_zip',
    description:
      'AQI forecast for a US ZIP code on a given date (defaults to today). Useful for "is tomorrow ok for outdoor activity" decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        zip_code: { type: 'string', description: 'US 5-digit ZIP code' },
        date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
        distance_miles: { type: 'number', description: 'Search radius (default 25)' },
      },
      required: ['zip_code'],
    },
  },
  {
    name: 'observations_in_bbox',
    description:
      'Historical AQI observations inside a bounding box for a date range. Specify pollutants as comma-separated parameter codes (e.g., "OZONE,PM25,PM10,CO,NO2,SO2"). bbox format: "minLon,minLat,maxLon,maxLat".',
    inputSchema: {
      type: 'object',
      properties: {
        bbox: { type: 'string', description: 'minLon,minLat,maxLon,maxLat' },
        start_date: { type: 'string', description: 'YYYY-MM-DDT00 (hour-granular ISO truncated)' },
        end_date: { type: 'string', description: 'YYYY-MM-DDT23' },
        parameters: { type: 'string', description: 'Comma-separated pollutants (default: OZONE,PM25,PM10)' },
        data_type: { type: 'string', description: 'A (AQI) | C (concentration) | B (both, default)' },
        verbose: { type: 'boolean', description: 'Include site / county / agency / full-AQS-code fields' },
      },
      required: ['bbox', 'start_date', 'end_date'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = (args._apiKey as string | undefined)?.trim();
  if (!apiKey) {
    throw new Error(
      'EPA AirNow requires an API key (free 500 req/hour). Contact the operator about platform credentials, or BYO via ?_apiKey=<key> after registering at https://docs.airnowapi.org/account/request/.',
    );
  }
  switch (name) {
    case 'current_by_zip':
      return currentByZip(apiKey, args);
    case 'current_by_location':
      return currentByLocation(apiKey, args);
    case 'forecast_by_zip':
      return forecastByZip(apiKey, args);
    case 'observations_in_bbox':
      return observationsInBbox(apiKey, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  }
  return v;
}

async function airnowFetch<T>(path: string, params: URLSearchParams): Promise<T> {
  const url = `${BASE_URL}${path}?${params}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new Error('AirNow: unauthorized — check the API key');
  if (res.status === 429) throw new Error('AirNow: rate-limit (HTTP 429) — free tier is 500/hour');
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AirNow error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

interface ObservationRow {
  DateObserved?: string;
  HourObserved?: number;
  LocalTimeZone?: string;
  ReportingArea?: string;
  StateCode?: string;
  Latitude?: number;
  Longitude?: number;
  ParameterName?: string;
  AQI?: number;
  Category?: { Number?: number; Name?: string };
}

interface ForecastRow extends ObservationRow {
  DateForecast?: string;
  ActionDay?: boolean;
  Discussion?: string;
}

function normalizeObservation(o: ObservationRow) {
  return {
    date: o.DateObserved?.trim() ?? null,
    hour: o.HourObserved ?? null,
    timezone: o.LocalTimeZone ?? null,
    reporting_area: o.ReportingArea ?? null,
    state: o.StateCode ?? null,
    latitude: o.Latitude ?? null,
    longitude: o.Longitude ?? null,
    pollutant: o.ParameterName ?? null,
    aqi: o.AQI ?? null,
    category: o.Category?.Name ?? null,
    category_number: o.Category?.Number ?? null,
  };
}

async function currentByZip(apiKey: string, args: Record<string, unknown>) {
  const zip = reqStr(args, 'zip_code', '"94103"');
  const params = new URLSearchParams({
    format: 'application/json',
    zipCode: zip,
    distance: String(Math.min(250, Math.max(0, (args.distance_miles as number) ?? 25))),
    API_KEY: apiKey,
  });
  const data = await airnowFetch<ObservationRow[]>('/observation/zipCode/current/', params);
  return { zip_code: zip, count: data.length, observations: data.map(normalizeObservation) };
}

async function currentByLocation(apiKey: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    format: 'application/json',
    latitude: String(args.latitude),
    longitude: String(args.longitude),
    distance: String(Math.min(250, Math.max(0, (args.distance_miles as number) ?? 25))),
    API_KEY: apiKey,
  });
  const data = await airnowFetch<ObservationRow[]>('/observation/latLong/current/', params);
  return {
    latitude: args.latitude,
    longitude: args.longitude,
    count: data.length,
    observations: data.map(normalizeObservation),
  };
}

async function forecastByZip(apiKey: string, args: Record<string, unknown>) {
  const zip = reqStr(args, 'zip_code', '"94103"');
  const params = new URLSearchParams({
    format: 'application/json',
    zipCode: zip,
    distance: String(Math.min(250, Math.max(0, (args.distance_miles as number) ?? 25))),
    API_KEY: apiKey,
  });
  if (args.date) params.set('date', String(args.date));

  const data = await airnowFetch<ForecastRow[]>('/forecast/zipCode/', params);
  return {
    zip_code: zip,
    requested_date: args.date ?? 'today',
    count: data.length,
    forecast: data.map((f) => ({
      forecast_date: f.DateForecast?.trim() ?? null,
      reporting_area: f.ReportingArea ?? null,
      state: f.StateCode ?? null,
      latitude: f.Latitude ?? null,
      longitude: f.Longitude ?? null,
      pollutant: f.ParameterName ?? null,
      aqi: f.AQI ?? null,
      category: f.Category?.Name ?? null,
      action_day: f.ActionDay ?? false,
      discussion: f.Discussion ?? null,
    })),
  };
}

interface BboxObservation {
  DateObserved?: string;
  HourObserved?: number;
  UTC?: string;
  Parameter?: string;
  AQI?: number;
  Category?: number;
  SiteName?: string;
  AgencyName?: string;
  FullAQSCode?: string;
  IntlAQSCode?: string;
  Latitude?: number;
  Longitude?: number;
  Value?: number;
  Unit?: string;
}

async function observationsInBbox(apiKey: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    BBOX: reqStr(args, 'bbox', '"-123.0,37.0,-121.0,38.5"'),
    startDate: reqStr(args, 'start_date', '"2026-05-01T00"'),
    endDate: reqStr(args, 'end_date', '"2026-05-01T23"'),
    parameters: (args.parameters as string) ?? 'OZONE,PM25,PM10',
    dataType: (args.data_type as string) ?? 'B',
    format: 'application/json',
    verbose: args.verbose ? '1' : '0',
    API_KEY: apiKey,
  });

  const data = await airnowFetch<BboxObservation[]>('/data/', params);
  return {
    bbox: args.bbox,
    count: data.length,
    observations: data.map((o) => ({
      observed_date: o.DateObserved?.trim() ?? null,
      hour: o.HourObserved ?? null,
      utc: o.UTC ?? null,
      site: o.SiteName ?? null,
      agency: o.AgencyName ?? null,
      aqs_code: o.FullAQSCode ?? null,
      latitude: o.Latitude ?? null,
      longitude: o.Longitude ?? null,
      pollutant: o.Parameter ?? null,
      aqi: o.AQI ?? null,
      category: o.Category ?? null,
      value: o.Value ?? null,
      unit: o.Unit ?? null,
    })),
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
