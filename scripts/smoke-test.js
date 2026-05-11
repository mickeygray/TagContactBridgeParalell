"use strict";

const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");

const targets = [
  path.join(root, "apps", "control-plane", "src", "server.js"),
  path.join(root, "apps", "inbound-gateway", "src", "server.js"),
  path.join(root, "apps", "outbound-gateway", "src", "server.js"),
  path.join(root, "apps", "ringcentral-cx", "src", "server.js"),
];

async function runCheck(file) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", file], {
      cwd: root,
      env: { ...process.env },
      stdio: "ignore",
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(file)} failed syntax check`));
      }
    });
  });
}

async function main() {
  for (const target of targets) {
    await runCheck(target);
  }

  console.log("Smoke checks passed for backend entrypoints.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
