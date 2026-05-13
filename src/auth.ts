/**
 * OAuth 2.0 Device Authorization Grant flow for the Rentometer MCP server.
 *
 * Invoked via `npx @rentometer/mcp-server auth`. Mints a device_code +
 * user_code from the API, prints the user_code + verification URL, optionally
 * opens the browser, and polls until the user authorizes — then writes the
 * resulting API key to ~/.config/rentometer/api_key (0600).
 *
 * The same credential file is read by the MCP server itself and by the
 * /rentometer-login Claude Code skill, so logging in once works everywhere.
 */

import { mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const RENTOMETER_BASE_URL =
  process.env.RENTOMETER_BASE_URL ?? "https://www.rentometer.com";
const CLIENT_NAME = "rentometer-mcp";
const CRED_PATH = join(homedir(), ".config", "rentometer", "api_key");

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

type TokenSuccess = {
  api_key: string;
  account_email: string;
  plan_name?: string;
};

type TokenError = { error: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postForm(
  path: string,
  body: Record<string, string>,
): Promise<Response> {
  const url = new URL(path, RENTOMETER_BASE_URL);
  return fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "rentometer-mcp-auth/0.1.0",
    },
    body: new URLSearchParams(body).toString(),
  });
}

function tryOpenBrowser(url: string): void {
  const opener =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Ignore — we already printed the URL.
  }
}

function saveApiKey(key: string): void {
  mkdirSync(dirname(CRED_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(CRED_PATH, key, { mode: 0o600 });
  chmodSync(CRED_PATH, 0o600);
}

export async function runDeviceAuth(): Promise<void> {
  process.stdout.write("Requesting device authorization code…\n");

  const codeRes = await postForm("/api/v1/auth/device/code", {
    client_name: CLIENT_NAME,
  });

  if (!codeRes.ok) {
    const text = await codeRes.text();
    throw new Error(
      `Failed to request device code (${codeRes.status}): ${text}`,
    );
  }

  const code = (await codeRes.json()) as DeviceCodeResponse;

  process.stdout.write("\n");
  process.stdout.write("Open this URL in your browser to authorize:\n");
  process.stdout.write(`  ${code.verification_uri_complete}\n`);
  process.stdout.write("\n");
  process.stdout.write(
    "  (or visit " +
      code.verification_uri +
      " and enter the code below)\n",
  );
  process.stdout.write("\n");
  process.stdout.write(`  Code: ${code.user_code}\n`);
  process.stdout.write("\n");

  if (!process.env.RENTOMETER_NO_BROWSER) {
    tryOpenBrowser(code.verification_uri_complete);
  }

  process.stdout.write("Waiting for authorization");

  const deadline = Date.now() + code.expires_in * 1000;
  let interval = Math.max(code.interval, 1);

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    process.stdout.write(".");

    const tokenRes = await postForm("/api/v1/auth/device/token", {
      device_code: code.device_code,
    });

    if (tokenRes.ok) {
      const success = (await tokenRes.json()) as TokenSuccess;
      saveApiKey(success.api_key);
      process.stdout.write("\n\n");
      process.stdout.write(
        `Authorized as ${success.account_email}${
          success.plan_name ? ` (${success.plan_name})` : ""
        }.\n`,
      );
      process.stdout.write(`Saved credential to ${CRED_PATH} (mode 0600).\n`);
      process.stdout.write(
        "\nThe MCP server, the /rentometer-login Claude Code skill, and any\n" +
          "future Rentometer agentic integration will pick this up automatically.\n",
      );
      return;
    }

    const error = (await tokenRes.json().catch(() => ({}))) as TokenError;

    switch (error.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "expired_token":
        process.stdout.write("\n\n");
        throw new Error(
          "Authorization request expired before you completed it. Run `npx @rentometer/mcp-server auth` again to start over.",
        );
      case "access_denied":
        process.stdout.write("\n\n");
        throw new Error("Authorization was denied in the browser.");
      default:
        process.stdout.write("\n\n");
        throw new Error(`Unexpected auth error: ${error.error ?? "unknown"}`);
    }
  }

  process.stdout.write("\n\n");
  throw new Error(
    "Timed out waiting for authorization. Run `npx @rentometer/mcp-server auth` again.",
  );
}

export function runLogout(): void {
  try {
    unlinkSync(CRED_PATH);
    process.stdout.write(`Removed ${CRED_PATH}.\n`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      process.stdout.write(`No saved credential at ${CRED_PATH}.\n`);
    } else {
      throw e;
    }
  }
  if (process.env.RENTOMETER_API_KEY) {
    process.stdout.write(
      "\nNote: RENTOMETER_API_KEY is still set in your environment. Unset it\n" +
        "in your shell (and remove any export from your shell rc) to fully log out.\n",
    );
  }
}
