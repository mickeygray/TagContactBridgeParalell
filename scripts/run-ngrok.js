"use strict";

// Tiny shim: load .env so NGROK_AUTHTOKEN is in process.env, then exec
// the ngrok CLI with our reserved-domain forwarding rule. Used by the
// `dev:ngrok` npm script so the auth token can live in .env (gitignored)
// instead of a global ngrok config or a shell-level env var that needs
// to be set per-machine.
//
// Binary resolution order:
//   1. NGROK_BIN env var (per-machine override; absolute path)
//   2. Known Windows install locations — first hit wins. The legacy
//      TagContactBridge app drops ngrok at the first one in this list,
//      so devs who already ran legacy don't need any extra setup.
//   3. Plain "ngrok" via system PATH (Linux/macOS or anywhere ngrok is
//      properly installed).
//
// We deliberately don't use `npx` because the npm `ngrok@5.x-beta`
// package has a broken Windows postinstall that lays down a non-`.exe`
// binary — npx finds the broken local copy and fails to execute it.
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

// Forward target — depends on whether nginx is in front of us.
//
//   - Local `npm run dev` (no NSSM, no nginx)   → 5001 (control-plane direct)
//   - Production NSSM with parallel.conf nginx  → 81 (nginx fans out to
//                                                  5001/4001/4002/3001)
//
// NODE_ENV=production is the cutover trigger — when the NSSM service
// boots with that set, ngrok auto-points at nginx without any per-host
// config change. Explicit `NGROK_FORWARD_PORT` always wins so devs can
// still target a specific backend during local debugging.
const DEFAULT_PORT = String(process.env.NODE_ENV || "").toLowerCase() === "production" ? "81" : "5001";
const PORT = String(process.env.NGROK_FORWARD_PORT || DEFAULT_PORT);
const DOMAIN = process.env.NGROK_DOMAIN || "tagcontactbridge.ngrok.app";

function resolveNgrokBinary() {
  const overridePath = String(process.env.NGROK_BIN || "").trim();
  if (overridePath) {
    try {
      if (fs.existsSync(overridePath)) return overridePath;
    } catch {
      // ignore — fall through to known locations
    }
  }

  // Known install locations on this machine (legacy TagContactBridge
  // dropped ngrok at the first one). Add more as new dev machines
  // surface different setups.
  const candidates = [
    "C:\\users\\admin\\downloads\\ngrok-v3-stable-windows-amd64\\ngrok.exe",
    "C:\\Users\\Admin\\Downloads\\ngrok-v3-stable-windows-amd64\\ngrok.exe",
    "C:\\Program Files\\ngrok\\ngrok.exe",
    "C:\\ProgramData\\chocolatey\\bin\\ngrok.exe",
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore — try the next
    }
  }

  // Last resort — let the shell resolve from PATH.
  return "ngrok";
}

const ngrokBin = resolveNgrokBinary();
// eslint-disable-next-line no-console
console.log("[run-ngrok] using:", ngrokBin);
// eslint-disable-next-line no-console
console.log(
  "[run-ngrok] forwarding https://" + DOMAIN + " -> http://localhost:" + PORT,
);

const args = ["http", "--domain=" + DOMAIN, PORT];

// Pass --authtoken inline if NGROK_AUTHTOKEN is set in .env. ngrok also
// caches the token in ~/.ngrok2/ngrok.yml after first use, so if it's
// already cached (e.g. from running the legacy app), not setting
// NGROK_AUTHTOKEN here still works.
if (process.env.NGROK_AUTHTOKEN) {
  args.push("--authtoken", process.env.NGROK_AUTHTOKEN);
} else {
  // eslint-disable-next-line no-console
  console.warn(
    "[run-ngrok] NGROK_AUTHTOKEN not set in .env — falling back to ngrok's cached config (~/.ngrok2/ngrok.yml).",
  );
}

const child = spawn(ngrokBin, args, {
  stdio: "inherit",
  shell: false,
});

child.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error("[run-ngrok] failed to spawn ngrok:", error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code == null ? 1 : code);
  }
});

// Forward Ctrl-C / SIGTERM cleanly so concurrently can tear the whole
// dev stack down without leaving an orphan ngrok tunnel running.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
