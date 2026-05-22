"use strict";

// Bare-metal SFTP pull. Connects, lists the remote directory,
// downloads every file to a local folder. No parsing, no CallLog
// match, no Drive upload — just verifies the SFTP plumbing.
//
// Connection details from env (or CLI flags):
//   CX_SFTP_HOST            host or IP
//   CX_SFTP_PORT            default 22
//   CX_SFTP_USER            username
//   CX_SFTP_PASSWORD        password (or use --key for key auth)
//   CX_SFTP_PRIVATE_KEY     path to private key file (alternative to password)
//   CX_SFTP_REMOTE_DIR      default "/"
//   CX_SFTP_LOCAL_DIR       default C:\Users\micke\Desktop\cx-recordings\inbox
//
// Usage:
//   node scripts/pull-cx-recordings-sftp.js
//   node scripts/pull-cx-recordings-sftp.js --list-only   # don't download, just list
//   node scripts/pull-cx-recordings-sftp.js --host x.x.x.x --user u --pass p

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const SftpClient = require("ssh2-sftp-client");

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

function bool(flag) {
  return process.argv.includes(flag);
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const host = arg("--host") || process.env.CX_SFTP_HOST;
  const port = Number(arg("--port") || process.env.CX_SFTP_PORT || 22);
  const user = arg("--user") || process.env.CX_SFTP_USER;
  const password = arg("--pass") || process.env.CX_SFTP_PASSWORD;
  const keyPath = arg("--key") || process.env.CX_SFTP_PRIVATE_KEY;
  const remoteDir = arg("--remote") || process.env.CX_SFTP_REMOTE_DIR || "/";
  const localDir =
    arg("--local") ||
    process.env.CX_SFTP_LOCAL_DIR ||
    "C:\\Users\\micke\\Desktop\\cx-recordings\\inbox";
  const listOnly = bool("--list-only");

  if (!host) throw new Error("CX_SFTP_HOST not set (or pass --host)");
  if (!user) throw new Error("CX_SFTP_USER not set (or pass --user)");
  if (!password && !keyPath) {
    throw new Error("Provide CX_SFTP_PASSWORD or CX_SFTP_PRIVATE_KEY (or --pass / --key)");
  }

  console.log("");
  console.log(`SFTP pull — ${user}@${host}:${port}${remoteDir}`);
  console.log(`Local dir : ${localDir}`);
  console.log(`Mode      : ${listOnly ? "list-only" : "download"}`);
  console.log("");

  const sftp = new SftpClient();
  const connectOpts = { host, port, username: user };
  if (password) connectOpts.password = password;
  if (keyPath) connectOpts.privateKey = fs.readFileSync(keyPath);

  const t0 = Date.now();
  try {
    await sftp.connect(connectOpts);
    console.log(`Connected in ${Date.now() - t0}ms`);

    const items = await sftp.list(remoteDir);
    const files = items.filter((i) => i.type === "-"); // files only, not dirs
    console.log(`Found ${items.length} entries (${files.length} files):`);
    for (const f of files.slice(0, 50)) {
      const mtime = f.modifyTime ? new Date(f.modifyTime).toISOString() : "?";
      console.log(`  ${fmtSize(f.size).padStart(10)}  ${mtime}  ${f.name}`);
    }
    if (files.length > 50) console.log(`  … (+${files.length - 50} more)`);

    if (listOnly || files.length === 0) {
      console.log("");
      console.log(listOnly ? "List-only mode — no downloads." : "No files to download.");
      return;
    }

    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    for (const f of files) {
      const remotePath = path.posix.join(remoteDir, f.name);
      const localPath = path.join(localDir, f.name);
      if (fs.existsSync(localPath)) {
        const localSize = fs.statSync(localPath).size;
        if (localSize === f.size) {
          console.log(`  skip ${f.name} (already local, same size)`);
          skipped += 1;
          continue;
        }
      }
      const t = Date.now();
      try {
        await sftp.fastGet(remotePath, localPath);
        console.log(`  ok   ${f.name} ${fmtSize(f.size)} in ${Date.now() - t}ms`);
        downloaded += 1;
      } catch (error) {
        console.log(`  FAIL ${f.name}: ${error.message}`);
        failed += 1;
      }
    }

    console.log("");
    console.log(`Done: downloaded=${downloaded} skipped=${skipped} failed=${failed}`);
  } finally {
    try { await sftp.end(); } catch (_) {}
  }
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  if (e.code) console.error("  code:", e.code);
  process.exit(1);
});
