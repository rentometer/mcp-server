#!/usr/bin/env node
/**
 * Rentometer MCP server. Exposes the Rentometer /api/v1 endpoints as MCP
 * tools so any MCP-capable agent client (Claude Desktop, Claude Code, Cursor,
 * Windsurf, Zed, ChatGPT Desktop, Gemini CLI, custom LangChain/CrewAI builds)
 * can analyze rental properties using first-party Rentometer data.
 *
 * Speaks the standard stdio transport. Configure in the host client's MCP
 * config like:
 *
 *   {
 *     "mcpServers": {
 *       "rentometer": {
 *         "command": "npx",
 *         "args": ["-y", "@rentometer/mcp-server"]
 *       }
 *     }
 *   }
 *
 * Subcommands:
 *   - (default)  start the MCP stdio server
 *   - auth       run the OAuth device-authorization flow + save credential
 *   - logout     delete the saved credential
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runDeviceAuth, runLogout } from "./auth.js";

const RENTOMETER_BASE_URL =
  process.env.RENTOMETER_BASE_URL ?? "https://www.rentometer.com";
const USER_AGENT = "rentometer-mcp/0.1.0";

function resolveApiKey(): string | undefined {
  if (process.env.RENTOMETER_API_KEY) return process.env.RENTOMETER_API_KEY;
  const credFile = join(homedir(), ".config", "rentometer", "api_key");
  try {
    const contents = readFileSync(credFile, "utf-8").trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

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

  const apiKey = resolveApiKey();
  if (requireAuth && !apiKey) {
    return err(
      "No Rentometer API key. Set RENTOMETER_API_KEY in the MCP server's env, " +
        "or save a key at ~/.config/rentometer/api_key. Generate one at " +
        "https://www.rentometer.com/rentometer-api/settings.",
    );
  }

  const url = new URL(path, RENTOMETER_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  url.searchParams.set("tool", "claude-mcp");

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
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
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Rent analysis
// ---------------------------------------------------------------------------

server.tool(
  "rentometer_summary",
  "Get aggregate rent statistics (mean, median, percentiles, sample size) " +
    "for a property at an address, a lat/lng point, or an Atlas-bounded " +
    "geographic area. Charges 1 quickview credit. Pass exactly one of: " +
    "`address`, (`latitude` + `longitude`), or `slug`. When `slug` is " +
    "passed, `bedrooms` and the other filters are ignored and the response " +
    "reflects whole-area numbers (same as the public /average-rent-in/... " +
    "pages). Use rentometer_atlas_search to resolve a place name to a slug.",
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

// ---------------------------------------------------------------------------
// Pro Report
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Atlas — live, key-gated bounded-geography analysis
// ---------------------------------------------------------------------------

server.tool(
  "rentometer_atlas_search",
  "Resolve a place name (e.g. 'hyde park cincinnati', '45208', 'Austin TX') " +
    "to one or more Atlas slug values. Returns slug, name, area_type, and " +
    "listing density. Free — no credit charge. Use the returned slug with " +
    "rentometer_summary({slug: ...}) for rent stats or rentometer_atlas_facts " +
    "for the full data bundle (demographics, fair-market rents, unemployment, " +
    "etc.).",
  {
    q: z
      .string()
      .min(2)
      .describe("Search query (min 2 characters)"),
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
    "for any agent doing market or neighborhood analysis.",
  {
    slug: z
      .string()
      .describe(
        "Atlas slug from rentometer_atlas_search (e.g. 'cincinnati-oh', '45208', 'hyde-park-cincinnati-oh').",
      ),
  },
  async (args) =>
    callRentometer("GET", "/api/v1/atlas/facts", { query: args }),
);

// ---------------------------------------------------------------------------
// Rental Data (public — no key required)
// ---------------------------------------------------------------------------

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
    type: z
      .enum(["metro", "city", "school_district", "zcta"])
      .optional(),
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

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

server.tool(
  "rentometer_rate_limit",
  "Check the current API key's rate-limit usage (minute / hour / day windows). " +
    "Free — does not consume credits.",
  {},
  async () => callRentometer("GET", "/api/v1/rate_limit"),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function printUsage() {
  process.stdout.write(
    "Usage: rentometer-mcp [auth|logout]\n" +
      "\n" +
      "  (no args)   Start the MCP stdio server (default; what host clients invoke)\n" +
      "  auth        Run the device-authorization flow + save your API key locally\n" +
      "  logout      Delete the saved credential at ~/.config/rentometer/api_key\n",
  );
}

async function main() {
  const subcommand = process.argv[2];

  switch (subcommand) {
    case undefined:
      await startMcpServer();
      break;
    case "auth":
    case "login":
      await runDeviceAuth();
      break;
    case "logout":
      runLogout();
      break;
    case "-h":
    case "--help":
    case "help":
      printUsage();
      break;
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n`);
      printUsage();
      process.exit(2);
  }
}

main().catch((error) => {
  console.error("[rentometer-mcp] fatal:", error.message ?? error);
  process.exit(1);
});
