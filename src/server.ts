/**
 * Shared Rentometer MCP server definition. Both transports use this:
 *   - src/index.ts  — stdio (one process, one user, key from env/file)
 *   - src/http.ts   — Streamable HTTP (one process, many users, key per request)
 *
 * Because the HTTP transport serves concurrent users, the API key must be
 * per-request state, not a module global. buildServer() therefore closes
 * callRentometer over the apiKey passed in, and every tool handler calls that
 * closure — so the same tool definitions are safe under both transports.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const VERSION = "0.2.0";

const DEFAULT_BASE_URL =
  process.env.RENTOMETER_BASE_URL ?? "https://www.rentometer.com";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(body: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  };
}

function err(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export interface BuildServerOptions {
  /** Bearer credential (raw ApiKey or OAuth access token) for this server's calls. */
  apiKey?: string;
  /** Value sent as `?tool=` for usage attribution. */
  toolAttribution?: string;
  /** Override the Rentometer base URL (tests / staging). */
  baseUrl?: string;
}

/**
 * Build a fully-registered Rentometer MCP server bound to one credential.
 * Stateless and cheap to construct — the HTTP transport builds one per request.
 */
export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const apiKey = opts.apiKey;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const attribution = opts.toolAttribution ?? "claude-mcp";
  const userAgent = `rentometer-mcp/${VERSION}`;

  async function callRentometer(
    method: "GET" | "POST",
    path: string,
    options: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      requireAuth?: boolean;
    } = {},
  ): Promise<ToolResult> {
    const { query, body, requireAuth = true } = options;

    if (requireAuth && !apiKey) {
      return err(
        "No Rentometer API key for this request. Connect your Rentometer " +
          "account (OAuth) or set RENTOMETER_API_KEY. Generate a key at " +
          "https://www.rentometer.com/rentometer-api/settings.",
      );
    }

    const url = new URL(path, baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        url.searchParams.set(k, String(v));
      }
    }
    url.searchParams.set("tool", attribution);

    const headers: Record<string, string> = {
      "User-Agent": userAgent,
      Accept: "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      return err(`Network error calling Rentometer: ${(e as Error).message}`);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      return err(
        `Rentometer API ${response.status} ${response.statusText}: ${
          typeof parsed === "string" ? parsed : JSON.stringify(parsed)
        }`,
      );
    }

    return ok({
      status: response.status,
      rate_limit_usage: response.headers.get("x-ratelimit-usage"),
      body: parsed,
    });
  }

  const server = new McpServer({
    name: "rentometer",
    version: VERSION,
  });

  // -------------------------------------------------------------------------
  // Rent analysis
  // -------------------------------------------------------------------------

  server.tool(
    "rentometer_summary",
    "Get aggregate rent statistics (mean, median, percentiles, sample size) " +
      "for a property at an address, a lat/lng point, or an Atlas-bounded " +
      "geographic area. Charges 1 quickview credit. Pass exactly one of: " +
      "`address`, (`latitude` + `longitude`), or `slug`. When `slug` is " +
      "passed, `bedrooms` and the other filters are ignored and the response " +
      "reflects whole-area numbers (same as the public /average-rent-in/... " +
      "pages). Use rentometer_atlas_search to resolve a place name to a slug. " +
      "On address / lat-lng searches the response may include an `atlas` array — " +
      "the bounded Atlas areas containing the point, broadest to narrowest, each " +
      "{slug, geoid, name, type, area_type}. Reuse any returned slug directly with " +
      "rentometer_atlas_facts (no extra rentometer_atlas_search call needed).",
    {
      address: z
        .string()
        .optional()
        .describe(
          "Full street address including city + state. Mutually exclusive with latitude/longitude and slug.",
        ),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      slug: z
        .string()
        .optional()
        .describe(
          "Atlas slug from rentometer_atlas_search. When provided, takes precedence over address/lat-lng and returns whole-area numbers.",
        ),
      bedrooms: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe("0 = studio. Required for address / lat-lng searches. Ignored when slug is provided."),
      baths: z
        .enum(["1", "1.5", "1.5+"])
        .optional()
        .describe("Omit for any bath count. Ignored when slug is provided."),
      building_type: z
        .enum(["apartment", "house"])
        .optional()
        .describe("Omit to include both. Ignored when slug is provided."),
      look_back_days: z.number().int().min(90).max(1460).optional(),
    },
    async (args) =>
      callRentometer("GET", "/api/v1/summary", {
        query: args,
      }),
  );

  server.tool(
    "rentometer_nearby_comps",
    "List the individual comparable rental listings (address, rent, beds, baths, " +
      "distance) backing a search. Charges 1 premium credit. Pass `token` from a " +
      "prior rentometer_summary call to reuse the search (preferred).",
    {
      token: z.string().optional(),
      address: z.string().optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      bedrooms: z.number().int().min(0).max(6).optional(),
      baths: z.enum(["1", "1.5", "1.5+"]).optional(),
      building_type: z.enum(["apartment", "house"]).optional(),
    },
    async (args) =>
      callRentometer("GET", "/api/v1/nearby_comps", { query: args }),
  );

  server.tool(
    "rentometer_batch_submit",
    "Submit up to 1000 properties for asynchronous rent analysis. Charges 1 " +
      "quickview credit per property. Returns a batch_id; poll with " +
      "rentometer_batch_status.",
    {
      properties: z
        .array(
          z.object({
            address: z.string().optional(),
            latitude: z.number().min(-90).max(90).optional(),
            longitude: z.number().min(-180).max(180).optional(),
            bedrooms: z.number().int().min(0).max(6),
            baths: z.enum(["1", "1.5", "1.5+"]).optional(),
            building_type: z.enum(["apartment", "house"]).optional(),
            look_back_days: z.number().int().min(90).max(1460).optional(),
          }),
        )
        .min(1)
        .max(1000),
      defaults: z
        .object({
          baths: z.enum(["1", "1.5", "1.5+"]).optional(),
          building_type: z.enum(["apartment", "house"]).optional(),
          look_back_days: z.number().int().min(90).max(1460).optional(),
        })
        .optional(),
    },
    async (args) =>
      callRentometer("POST", "/api/v1/batch_summary", { body: args }),
  );

  server.tool(
    "rentometer_batch_status",
    "Get the status (and results, when complete) of a batch submitted via " +
      "rentometer_batch_submit.",
    {
      batch_id: z.string(),
    },
    async ({ batch_id }) =>
      callRentometer("GET", `/api/v1/batch_summary/${encodeURIComponent(batch_id)}`),
  );

  server.tool(
    "rentometer_property_rents",
    "Get historical rent records for a single exact address (not aggregate " +
      "stats — the literal listings for that address). Charges 1 premium credit. " +
      "Often returns zero matches; fall back to rentometer_summary for area stats.",
    {
      address: z.string(),
      max_age: z.number().int().min(1).optional(),
    },
    async (args) =>
      callRentometer("GET", "/api/v1/property_rents", { query: args }),
  );

  // -------------------------------------------------------------------------
  // Pro Report
  // -------------------------------------------------------------------------

  server.tool(
    "rentometer_request_pro_report",
    "Queue a Pro PDF report for a search identified by `token` (from a prior " +
      "rentometer_summary call). Charges 1 pro_report credit immediately. Poll " +
      "rentometer_pro_report_status until ready.",
    { token: z.string() },
    async (args) =>
      callRentometer("GET", "/api/v1/request_pro_report", { query: args }),
  );

  server.tool(
    "rentometer_pro_report_status",
    "Poll the build status of a Pro PDF report. Returns ready/queued state and " +
      "a download URL once finished.",
    { token: z.string() },
    async (args) =>
      callRentometer("GET", "/api/v1/pro_report_status", { query: args }),
  );

  server.tool(
    "rentometer_download_pro_report",
    "Get the download link (or JSON wrapper) for a finished Pro PDF report.",
    {
      token: z.string(),
      download: z
        .boolean()
        .optional()
        .describe(
          "Note: when true, the upstream endpoint returns binary PDF data. " +
            "Through MCP we recommend leaving this false and using the returned URL.",
        ),
    },
    async (args) =>
      callRentometer("GET", "/api/v1/download_pro_report", { query: args }),
  );

  // -------------------------------------------------------------------------
  // Atlas — live, key-gated bounded-geography analysis
  // -------------------------------------------------------------------------

  server.tool(
    "rentometer_atlas_search",
    "Resolve a place name (e.g. 'hyde park cincinnati', '45208', 'Austin TX') " +
      "to one or more Atlas slug values. Returns slug, name, area_type, listing " +
      "density, and has_rental_data. Free — no credit charge. Use the returned " +
      "slug with rentometer_summary({slug: ...}) for rent stats or " +
      "rentometer_atlas_facts for the full data bundle (demographics, fair-market " +
      "rents, unemployment, etc.). Pass `q` for a name search, OR `geoid` to " +
      "resolve a Census FIPS/GEOID or 5-digit ZCTA directly.",
    {
      q: z
        .string()
        .min(2)
        .optional()
        .describe("Name search query (min 2 characters). Pass this OR `geoid`."),
      geoid: z
        .string()
        .optional()
        .describe(
          "A Census FIPS/GEOID or 5-digit ZCTA. A bare 5-digit code can match " +
            "several area types, so all matches are returned; narrow with `area_type`.",
        ),
      area_type: z
        .enum([
          "state",
          "metro",
          "county",
          "place",
          "city",
          "zcta",
          "zip",
          "neighborhood",
          "school_district",
        ])
        .optional()
        .describe("Disambiguate a `geoid` lookup. Ignored for `q` searches."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (default 15)"),
    },
    async (args) =>
      callRentometer("GET", "/api/v1/atlas/search", { query: args }),
  );

  server.tool(
    "rentometer_atlas_facts",
    "Get the full Rentometer Atlas bundle for a bounded geographic area: rent " +
      "breakdown (overall, per-bedroom, per-property-type) PLUS ACS demographics, " +
      "HUD Fair Market Rents, HUD CHAS housing affordability, BLS LAUS local " +
      "unemployment, BLS QCEW industry/wages, and Census BPS building permits. " +
      "External sources are gated behind Flipper flags on your account and are " +
      "silently omitted when not enabled. Charges 1 quickview credit. The same " +
      "numbers as the public /average-rent-in/... pages, in one call — useful " +
      "for any agent doing market or neighborhood analysis. Identify the area by " +
      "`slug` (from rentometer_atlas_search) OR by `geoid` (Census FIPS / ZCTA).",
    {
      slug: z
        .string()
        .optional()
        .describe(
          "Atlas slug from rentometer_atlas_search (e.g. 'cincinnati-oh', '45208', " +
            "'hyde-park-cincinnati-oh'). Pass this OR `geoid`.",
        ),
      geoid: z
        .string()
        .optional()
        .describe(
          "A Census FIPS/GEOID or 5-digit ZCTA. Pass this OR `slug`. Add " +
            "`area_type` to disambiguate a bare 5-digit code (returns 422 with a " +
            "`candidates` list otherwise).",
        ),
      area_type: z
        .enum([
          "state",
          "metro",
          "county",
          "place",
          "city",
          "zcta",
          "zip",
          "neighborhood",
          "school_district",
        ])
        .optional()
        .describe("Disambiguate a `geoid` lookup. Ignored when `slug` is passed."),
    },
    async (args) =>
      callRentometer("GET", "/api/v1/atlas/facts", { query: args }),
  );

  server.tool(
    "rentometer_metrics",
    "List the metrics that rentometer_rankings can rank areas by (e.g. " +
      "acs.median_household_income, hud_fmr.two_br, bls_laus.unemployment_rate, " +
      "census_bps.permits_total). Returns each metric's key, label, unit, the " +
      "area types it's published for, its natural sort direction, and whether " +
      "YOUR account is entitled to it. Free — no credit charge, no key state " +
      "changed. Call this first when you're unsure of a metric key, and only " +
      "pass rentometer_rankings a metric whose `entitled` is true.",
    {},
    async () => callRentometer("GET", "/api/v1/atlas/metrics"),
  );

  server.tool(
    "rentometer_rankings",
    "Rank US areas of one type by a single metric — i.e. 'top N <area_type> by " +
      "<metric>' — optionally scoped to a parent area. This is the call for " +
      "leaderboards ('top/best/highest/lowest N ...'), as opposed to " +
      "rentometer_atlas_facts which describes ONE named area. One call replaces " +
      "enumerating areas and calling atlas_facts on each. Charges 1 quickview " +
      "credit (flat, regardless of limit). Metric must be a key from " +
      "rentometer_metrics that your account is entitled to (otherwise 403), and " +
      "must be published for the chosen area_type (otherwise 422). Phase 1 " +
      "covers government metrics (ACS/HUD/BLS/Census); rent-based ranking is not " +
      "available yet.",
    {
      area_type: z
        .enum([
          "metro",
          "city",
          "place",
          "county",
          "zcta",
          "zip",
          "neighborhood",
          "school_district",
          "state",
        ])
        .describe("What kind of area to rank. `city`=`place`, `zip`=`zcta`."),
      metric: z
        .string()
        .describe(
          "A metric key from rentometer_metrics, e.g. 'acs.median_household_income'.",
        ),
      within: z
        .string()
        .optional()
        .describe(
          "Parent Atlas slug (from rentometer_atlas_search) to scope the ranking to, e.g. 'cincinnati-oh-metro'. Omit for a country-wide ranking.",
        ),
      order: z
        .enum(["asc", "desc"])
        .optional()
        .describe(
          "Sort direction. Defaults to the metric's natural direction (e.g. income desc, unemployment asc). Set explicitly for 'lowest' vs 'highest'.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("How many areas to return (default 10, max 100)."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Skip this many ranked areas, for paging."),
    },
    async (args) =>
      callRentometer("GET", "/api/v1/atlas/rankings", { query: args }),
  );

  server.tool(
    "rentometer_screener",
    "Find US areas of one type whose government-fact metrics ALL fall within given " +
      "ranges — a multi-constraint screener (e.g. 'metros with median household income " +
      "$75k-$125k, effective property tax rate < 0.75%, median home value < $300k'). Where " +
      "rentometer_rankings sorts by one metric, this filters by several at once. Each filter " +
      "metric must be a rentometer_metrics key your account is entitled to and published for " +
      "the area_type. Charges 1 quickview credit (flat). Results include the matched value of " +
      "each filter metric.",
    {
      area_type: z
        .enum([
          "metro",
          "city",
          "place",
          "county",
          "zcta",
          "zip",
          "neighborhood",
          "school_district",
          "state",
        ])
        .describe("What kind of area to screen. city=place, zip=zcta."),
      filters: z
        .array(
          z.object({
            metric: z.string().describe("A rentometer_metrics key, e.g. acs.median_household_income."),
            min: z.number().optional().describe("Inclusive lower bound."),
            max: z.number().optional().describe("Inclusive upper bound."),
          }),
        )
        .min(1)
        .max(6)
        .describe("Metric range constraints; an area must satisfy all of them."),
      within: z
        .string()
        .optional()
        .describe("Parent Atlas slug to scope to (containment). Omit for country-wide."),
      sort: z
        .string()
        .optional()
        .describe("Metric key to order results by. Defaults to the first filter's metric."),
      order: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async ({ filters, ...rest }) =>
      callRentometer("GET", "/api/v1/atlas/screener", {
        // filters must reach the API as a JSON string, not nested query params.
        query: { ...rest, filters: JSON.stringify(filters) },
      }),
  );

  // -------------------------------------------------------------------------
  // Rental Data (public — no key required)
  // -------------------------------------------------------------------------

  server.tool(
    "rentometer_area",
    "Get pre-computed rent statistics for a US metro / city / school district " +
      "/ ZIP code. Public — no API key required. Use rentometer_area_search " +
      "first if you only have a place name, not an ID.",
    {
      area_type: z
        .enum(["metros", "cities", "school-districts", "zip-codes"])
        .describe("Pluralized URL segment matching the endpoint path"),
      id: z
        .string()
        .describe(
          "Area identifier. For metros: 5-digit CBSA code (e.g. 17140). " +
            "For zip-codes: 5-digit ZIP. For cities/school-districts: name slug.",
        ),
    },
    async ({ area_type, id }) =>
      callRentometer(
        "GET",
        `/api/v1/rental-data/${area_type}/${encodeURIComponent(id)}`,
        { requireAuth: false },
      ),
  );

  server.tool(
    "rentometer_area_search",
    "Resolve a place name to a Rentometer area ID (suitable for rentometer_area). " +
      "Public — no API key required.",
    {
      q: z.string().describe("Search query, e.g. 'Austin'"),
      type: z.enum(["metro", "city", "school_district", "zcta"]).optional(),
      state: z
        .string()
        .regex(/^[A-Z]{2}$/i)
        .optional()
        .describe("2-letter state abbreviation"),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) =>
      callRentometer("GET", "/api/v1/rental-data/search", {
        query: args,
        requireAuth: false,
      }),
  );

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  server.tool(
    "rentometer_rate_limit",
    "Check the current API key's rate-limit usage (minute / hour / day windows). " +
      "Free — does not consume credits.",
    {},
    async () => callRentometer("GET", "/api/v1/rate_limit"),
  );

  return server;
}
