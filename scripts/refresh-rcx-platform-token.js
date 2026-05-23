"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const ENV_PATH = path.resolve(__dirname, "..", ".env");

dotenv.config({ path: ENV_PATH });

function readEnvFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function upsertEnvValue(contents, key, value) {
  const normalizedValue = String(value ?? "");
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${normalizedValue}`;
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }
  // Use platform line ending so .env stays consistent with however the
  // file is currently written on the host (CRLF on Windows, LF on Linux).
  const eol = os.EOL;
  return `${contents.replace(/\s*$/, "")}${eol}${line}${eol}`;
}

async function mintPlatformToken() {
  const clientId = String(process.env.RINGCX_PLATFORM_CLIENT_ID || process.env.RING_CENTRAL_CLIENT_ID2 || "").trim();
  const clientSecret = String(process.env.RINGCX_PLATFORM_CLIENT_SECRET || process.env.RING_CENTRAL_CLIENT_SECRET2 || "").trim();
  const jwtToken = String(process.env.RINGCX_PLATFORM_JWT_TOKEN || process.env.RING_CENTRAL_JWT_TOKEN2 || "").trim();
  const serverUrl = String(
    process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com",
  ).trim();

  if (!clientId || !clientSecret || !jwtToken) {
    throw new Error(
      "RINGCX_PLATFORM_CLIENT_ID / RINGCX_PLATFORM_CLIENT_SECRET / RINGCX_PLATFORM_JWT_TOKEN are required",
    );
  }

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwtToken,
  });

  const response = await fetch(`${serverUrl}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Platform token mint failed (${response.status}): ${JSON.stringify(data)}`,
    );
  }

  const expiresInSeconds = Number(data.expires_in || 0);
  const expiresAt = expiresInSeconds > 0
    ? new Date(Date.now() + (expiresInSeconds * 1000)).toISOString()
    : "";

  return {
    accessToken: data.access_token || "",
    refreshToken: data.refresh_token || "",
    tokenType: data.token_type || "",
    scope: data.scope || "",
    ownerId: data.owner_id || "",
    endpointId: data.endpoint_id || "",
    expiresInSeconds,
    expiresAt,
  };
}

async function main() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`.env not found at ${ENV_PATH}`);
  }

  const token = await mintPlatformToken();
  let envContents = readEnvFile(ENV_PATH);
  envContents = upsertEnvValue(envContents, "RCX_PLATFORM_ACCESS_TOKEN", token.accessToken);
  envContents = upsertEnvValue(envContents, "RCX_PLATFORM_REFRESH_TOKEN", token.refreshToken);
  envContents = upsertEnvValue(envContents, "RCX_PLATFORM_TOKEN_TYPE", token.tokenType);
  envContents = upsertEnvValue(envContents, "RCX_PLATFORM_SCOPE", token.scope);
  envContents = upsertEnvValue(envContents, "RCX_PLATFORM_OWNER_ID", token.ownerId);
  envContents = upsertEnvValue(envContents, "RCX_PLATFORM_ENDPOINT_ID", token.endpointId);
  envContents = upsertEnvValue(envContents, "RCX_PLATFORM_EXPIRES_IN", token.expiresInSeconds);
  envContents = upsertEnvValue(envContents, "RCX_PLATFORM_EXPIRES_AT", token.expiresAt);
  fs.writeFileSync(ENV_PATH, envContents, "utf8");

  console.log(
    JSON.stringify(
      {
        ok: true,
        wrote: [
          "RCX_PLATFORM_ACCESS_TOKEN",
          "RCX_PLATFORM_REFRESH_TOKEN",
          "RCX_PLATFORM_TOKEN_TYPE",
          "RCX_PLATFORM_SCOPE",
          "RCX_PLATFORM_OWNER_ID",
          "RCX_PLATFORM_ENDPOINT_ID",
          "RCX_PLATFORM_EXPIRES_IN",
          "RCX_PLATFORM_EXPIRES_AT",
        ],
        scope: token.scope,
        expiresAt: token.expiresAt,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error.message,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
