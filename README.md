# @rentometer/mcp-server

[Model Context Protocol](https://modelcontextprotocol.io/) server that exposes
the Rentometer rental-analysis API to any MCP-capable agent client.

One server, many clients:

- Claude Desktop
- Claude Code
- Cursor
- Windsurf
- Zed
- ChatGPT Desktop
- Gemini CLI
- Custom LangChain / LlamaIndex / CrewAI builds that speak MCP

Same tools, same auth, same data — just plumbed through the MCP standard
instead of platform-specific skill formats.

## Tools

| Tool | Endpoint | Cost |
|---|---|---|
| `rentometer_summary` | `GET /api/v1/summary` (address, lat/lng, or Atlas slug) | 1 quickview |
| `rentometer_nearby_comps` | `GET /api/v1/nearby_comps` | 1 premium |
| `rentometer_batch_submit` | `POST /api/v1/batch_summary` | N quickview (on completion) |
| `rentometer_batch_status` | `GET /api/v1/batch_summary/{id}` | free |
| `rentometer_property_rents` | `GET /api/v1/property_rents` | 1 premium |
| `rentometer_request_pro_report` | `GET /api/v1/request_pro_report` | 1 pro_report |
| `rentometer_pro_report_status` | `GET /api/v1/pro_report_status` | free |
| `rentometer_download_pro_report` | `GET /api/v1/download_pro_report` | free |
| `rentometer_atlas_search` | `GET /api/v1/atlas/search` — resolve a place name (`q`) or Census FIPS/ZCTA (`geoid`) to an Atlas slug | free |
| `rentometer_atlas_facts` | `GET /api/v1/atlas/facts` — rent + ACS + HUD + BLS + Census bundle for an area | 1 quickview |
| `rentometer_metrics` | `GET /api/v1/atlas/metrics` — metrics rankable by `rentometer_rankings`, with entitlements | free |
| `rentometer_rankings` | `GET /api/v1/atlas/rankings` — rank areas by a metric ("top N … by X"), optionally within a parent | 1 quickview |
| `rentometer_area` | `GET /api/v1/rental-data/{type}/{id}` (precomputed RentalStatistics) | free, no auth |
| `rentometer_area_search` | `GET /api/v1/rental-data/search` | free, no auth |
| `rentometer_rate_limit` | `GET /api/v1/rate_limit` | free |

## Two ways to run it

| Transport | Entry | Who it's for | Auth |
|---|---|---|---|
| **stdio** (local) | `rentometer-mcp` / `npx @rentometer/mcp-server` | A single developer wiring the server into a local client (Claude Desktop, Cursor, …) | API key from env / `~/.config/rentometer/api_key` (device flow) |
| **Streamable HTTP** (hosted) | `rentometer-mcp-http` / `node dist/http.js` | A hosted endpoint that **remote MCP connectors** (Claude / ChatGPT) point at — one process, many users | OAuth 2.1 per request (the Rails app at `/oauth/*`); the connector sends `Authorization: Bearer <access_token>` on every call |

Both transports serve the **same 15 tools** from `src/server.ts`. The stdio path is one-user-one-key; the HTTP path is per-request — each connected user's OAuth access token is threaded into a freshly-built, stateless server instance and forwarded to the Rentometer API, where it resolves to that user's ApiKey.

### Hosted (Streamable HTTP)

```bash
npm run build
PORT=8080 node dist/http.js        # reverse-proxy so the public URL is https://<host>/mcp
```

- `POST /mcp` — the single MCP endpoint. Requests without a valid bearer get `401` + a
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"` header, which is how
  a connector discovers it must run the OAuth flow (served by the Rails app).
- `GET /healthz` — liveness probe.
- Env: `PORT` (default 8080), `RENTOMETER_BASE_URL` (default `https://www.rentometer.com`),
  `RENTOMETER_OAUTH_RESOURCE_METADATA_URL` (override the discovery pointer).

Connecting from a client is "paste the `/mcp` URL → Connect → approve OAuth" — see the website's
**Connect** page for the per-client walkthrough.

## Install + configure (stdio)

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "rentometer": {
      "command": "npx",
      "args": ["-y", "@rentometer/mcp-server"],
      "env": {
        "RENTOMETER_API_KEY": "your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the hammer/wrench icon.

### Claude Code

```bash
claude mcp add rentometer \
  --command "npx -y @rentometer/mcp-server" \
  --env RENTOMETER_API_KEY=your_key_here
```

### Cursor / Windsurf / Zed

Each client has its own MCP-config UI; the `command`/`args`/`env` triple is
the same as above. See your client's MCP docs.

### ChatGPT Desktop

ChatGPT Desktop's MCP support reads from
`~/.config/openai/mcp_config.json` (path may vary by version). Same triple.

## Authentication

The fastest path:

```bash
npx -y @rentometer/mcp-server auth
```

That runs the OAuth 2.0 device-authorization flow (RFC 8628):

1. Mints a short user-readable code (e.g. `BCDF-GHJK`) and prints the
   verification URL.
2. Opens your default browser to the URL (or you can copy/paste).
3. You sign into rentometer.com, confirm the code, and click **Authorize**.
4. The CLI receives the new API key and writes it to
   `~/.config/rentometer/api_key` with `0600` perms.

No key ever transits your clipboard. The same credential file is read by the
[`/rentometer-login` Claude Code skill](https://github.com/rentometer/claude-skills/tree/main/skills/rentometer-login),
so logging in once works across both surfaces.

### How the MCP server finds the key at runtime

The server resolves credentials in this order:

1. `RENTOMETER_API_KEY` environment variable (set in the MCP `env` block)
2. `~/.config/rentometer/api_key` (file written by `auth` or by the
   `/rentometer-login` skill)

You can also generate keys manually at
https://www.rentometer.com/rentometer-api/settings if you'd rather not use
the device flow — just paste the key into your shell rc as
`export RENTOMETER_API_KEY=...` or directly into the file above.

Requires an active Pro subscription with API access enabled. The public
`rentometer_area` and `rentometer_area_search` tools work without a key.

### Log out

```bash
npx -y @rentometer/mcp-server logout
```

Deletes the saved credential file. Tell you if `RENTOMETER_API_KEY` is still
set in your environment so you can unset it.

## Local development

```bash
npm install
npm run dev          # tsx watch on src/index.ts
```

Test it from the MCP CLI inspector:

```bash
npx @modelcontextprotocol/inspector npx -y tsx src/index.ts
```

## Build + publish

```bash
npm run build        # outputs to dist/
npm publish --access public
```

## Notes

- Every outbound request is attributed with `?tool=claude-mcp` so we can track
  agent-channel usage separately from web/widget traffic.
- The server is stateless (no local DB, no cache). All auth, credit metering,
  and rate limiting happen server-side at Rentometer.
- For the `rentometer_download_pro_report` tool, we recommend agents leave
  `download=false` and return the link URL — streaming binary PDF data through
  MCP isn't generally supported by host clients yet.
