#!/usr/bin/env node
/**
 * Rentometer MCP server — hosted Streamable-HTTP transport.
 *
 * This is the endpoint remote-MCP connectors (Claude / ChatGPT) point at. It
 * serves the SAME tool set as the stdio server (./server.ts), but the API key
 * is per-request: each connected user authenticates via OAuth 2.1 (handled by
 * the Rails app at /oauth/*), and the connector then sends its access token as
 * `Authorization: Bearer <token>` on every /mcp call. We thread that token into
 * a freshly-built, stateless MCP server per request and forward it to the
 * Rentometer API, where it resolves to the user's ApiKey.
 *
 * Run:  node dist/http.js   (PORT, default 8080)
 * Reverse-proxy so the public URL is e.g. https://www.rentometer.com/mcp.
 */

import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, VERSION } from "./server.js";

const PORT = Number(process.env.PORT ?? 8080);

// Where compliant clients should look for OAuth metadata (RFC 9728). Points at
// the Rails-hosted protected-resource document by default.
const RENTOMETER_BASE_URL =
  process.env.RENTOMETER_BASE_URL ?? "https://www.rentometer.com";
const RESOURCE_METADATA_URL =
  process.env.RENTOMETER_OAUTH_RESOURCE_METADATA_URL ??
  `${RENTOMETER_BASE_URL}/.well-known/oauth-protected-resource`;

function bearerToken(req: Request): string | undefined {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header) return undefined;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return undefined;
  return value.trim() || undefined;
}

// RFC 9728 §5.1 — tell the client where to discover how to authenticate.
function challenge(res: Response): void {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`,
  );
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message:
        "Authentication required. Connect your Rentometer account to use this MCP server.",
    },
    id: null,
  });
}

const app = express();
app.use(express.json({ limit: "4mb" }));

// Liveness probe for the reverse proxy / orchestrator.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", server: "rentometer-mcp", version: VERSION });
});

// Streamable HTTP is a single endpoint. We run stateless (a new server +
// transport per request), which fits our purely request/response tools and
// avoids holding long-lived sessions in the process.
app.post("/mcp", async (req: Request, res: Response) => {
  const token = bearerToken(req);
  if (!token) {
    challenge(res);
    return;
  }

  const server = buildServer({
    apiKey: token,
    toolAttribution: "claude-mcp-remote",
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[rentometer-mcp-http] request error:", e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no server-initiated stream or session to tear down.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, () => {
  console.error(
    `[rentometer-mcp-http] listening on :${PORT} (resource metadata: ${RESOURCE_METADATA_URL})`,
  );
});
