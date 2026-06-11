#!/usr/bin/env node
/**
 * Rentometer MCP server — stdio transport. Exposes the Rentometer /api/v1
 * endpoints as MCP tools so any local MCP-capable agent client (Claude Desktop,
 * Claude Code, Cursor, Windsurf, Zed, ChatGPT Desktop, Gemini CLI, custom
 * LangChain/CrewAI builds) can analyze rental properties using first-party
 * Rentometer data.
 *
 * The tool definitions live in ./server.ts and are shared with the hosted
 * Streamable-HTTP transport (./http.ts). This file only handles the stdio
 * lifecycle and the auth/logout CLI subcommands.
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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";
import { runDeviceAuth, runLogout } from "./auth.js";

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

async function startMcpServer() {
  const server = buildServer({
    apiKey: resolveApiKey(),
    toolAttribution: "claude-mcp",
  });
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
