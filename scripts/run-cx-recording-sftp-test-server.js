#!/usr/bin/env node
"use strict";

// Disposable user-mode SFTP receiver for RingCX recording delivery tests.
//
// This avoids requiring Windows OpenSSH-Server/admin rights during a proof of
// concept. It listens only on 127.0.0.1 by default; expose it publicly with:
//   ngrok tcp 2222
//
// RingCX destination values:
//   Protocol: SFTP
//   Host:     <ngrok TCP host>
//   Port:     <ngrok TCP port>
//   User:     rcx-delivery
//   Password: printed below / runtime/cx-recording-sftp-test/credentials.json
//   Path:     /

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { constants } = require("fs");
const {
  Server,
  utils: {
    sftp: { STATUS_CODE },
  },
} = require("ssh2");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function randomPassword() {
  // Avoid characters that are annoying in admin forms and chat paste.
  return crypto.randomBytes(18).toString("base64url");
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonLine(file, event) {
  ensureDirSync(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function ensureHostKey(keyPath) {
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath);
  ensureDirSync(path.dirname(keyPath));
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  return Buffer.from(privateKey);
}

function ensureCredentials(credentialsPath, username, password) {
  ensureDirSync(path.dirname(credentialsPath));
  if (password) {
    const creds = { username, password, updatedAt: new Date().toISOString() };
    fs.writeFileSync(credentialsPath, JSON.stringify(creds, null, 2));
    return creds;
  }
  if (fs.existsSync(credentialsPath)) {
    const creds = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    if (creds?.username && creds?.password) return creds;
  }
  const creds = {
    username,
    password: randomPassword(),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(credentialsPath, JSON.stringify(creds, null, 2));
  return creds;
}

function asVirtualPath(input) {
  const raw = String(input || "/").replace(/\\/g, "/");
  const normalized = path.posix.normalize(raw.startsWith("/") ? raw : `/${raw}`);
  const parts = normalized.split("/").filter((part) => part && part !== "." && part !== "..");
  return `/${parts.join("/")}`;
}

function localPathFor(rootDir, virtualPath) {
  const parts = asVirtualPath(virtualPath).split("/").filter(Boolean);
  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes SFTP root: ${virtualPath}`);
  }
  return resolved;
}

function attrsFromStats(stats) {
  return {
    mode: stats.mode,
    uid: 0,
    gid: 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

function longnameFor(name, stats) {
  const type = stats.isDirectory() ? "d" : "-";
  const size = String(stats.size).padStart(8, " ");
  const date = stats.mtime.toISOString().slice(0, 19).replace("T", " ");
  return `${type}rw-r--r-- 1 rcx rcx ${size} ${date} ${name}`;
}

function handleFromId(id) {
  const handle = Buffer.alloc(4);
  handle.writeUInt32BE(id, 0);
  return handle;
}

function idFromHandle(handle) {
  if (!Buffer.isBuffer(handle) || handle.length !== 4) return null;
  return handle.readUInt32BE(0);
}

function createSftpServer(options) {
  const {
    host,
    port,
    rootDir,
    credentials,
    hostKey,
    eventLog,
  } = options;

  const allowedUser = Buffer.from(credentials.username);
  const allowedPassword = Buffer.from(credentials.password);

  function checkValue(input, allowed) {
    const value = Buffer.from(String(input || ""));
    if (value.length !== allowed.length) {
      crypto.timingSafeEqual(allowed, allowed);
      return false;
    }
    return crypto.timingSafeEqual(value, allowed);
  }

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    const remote = `${client._sock?.remoteAddress || "unknown"}:${client._sock?.remotePort || "unknown"}`;
    writeJsonLine(eventLog, { type: "client.connected", remote });
    console.log(`[sftp] client connected ${remote}`);

    client
      .on("authentication", (ctx) => {
        writeJsonLine(eventLog, {
          type: "client.auth.attempt",
          username: ctx.username,
          method: ctx.method,
        });
        if (ctx.method !== "password") {
          writeJsonLine(eventLog, {
            type: "client.auth.rejected",
            username: ctx.username,
            method: ctx.method,
            reason: "unsupported-method",
          });
          return ctx.reject();
        }
        if (!checkValue(ctx.username, allowedUser)) {
          writeJsonLine(eventLog, {
            type: "client.auth.rejected",
            username: ctx.username,
            method: ctx.method,
            reason: "username-mismatch",
          });
          return ctx.reject();
        }
        if (!checkValue(ctx.password, allowedPassword)) {
          writeJsonLine(eventLog, {
            type: "client.auth.rejected",
            username: ctx.username,
            method: ctx.method,
            reason: "password-mismatch",
          });
          return ctx.reject();
        }
        writeJsonLine(eventLog, { type: "client.authenticated", username: ctx.username });
        ctx.accept();
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            const handles = new Map();
            let nextHandleId = 1;

            const openHandle = (state) => {
              const id = nextHandleId++;
              handles.set(id, state);
              return handleFromId(id);
            };

            const getHandle = (handle) => {
              const id = idFromHandle(handle);
              return id ? handles.get(id) : null;
            };

            const closeHandle = (handle) => {
              const id = idFromHandle(handle);
              if (!id || !handles.has(id)) return null;
              const state = handles.get(id);
              handles.delete(id);
              return state;
            };

            sftp
              .on("REALPATH", (reqid, filename) => {
                const virtualPath = asVirtualPath(filename);
                sftp.name(reqid, [{
                  filename: virtualPath,
                  longname: virtualPath,
                  attrs: {},
                }]);
              })
              .on("STAT", (reqid, filename) => statPath(reqid, filename))
              .on("LSTAT", (reqid, filename) => statPath(reqid, filename))
              .on("FSTAT", (reqid, handle) => {
                const state = getHandle(handle);
                if (!state) return sftp.status(reqid, STATUS_CODE.FAILURE);
                try {
                  const stats = state.fd ? fs.fstatSync(state.fd) : fs.statSync(state.localPath);
                  return sftp.attrs(reqid, attrsFromStats(stats));
                } catch {
                  return sftp.status(reqid, STATUS_CODE.FAILURE);
                }
              })
              .on("OPENDIR", (reqid, filename) => {
                try {
                  const virtualPath = asVirtualPath(filename);
                  const localPath = localPathFor(rootDir, virtualPath);
                  const stats = fs.statSync(localPath);
                  if (!stats.isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE);
                  const entries = fs.readdirSync(localPath).map((entry) => {
                    const entryPath = path.join(localPath, entry);
                    const entryStats = fs.statSync(entryPath);
                    return {
                      filename: entry,
                      longname: longnameFor(entry, entryStats),
                      attrs: attrsFromStats(entryStats),
                    };
                  });
                  const handle = openHandle({ type: "dir", entries, read: false, localPath });
                  sftp.handle(reqid, handle);
                } catch (error) {
                  writeJsonLine(eventLog, { type: "opendir.failed", filename, error: error.message });
                  sftp.status(reqid, STATUS_CODE.FAILURE);
                }
              })
              .on("READDIR", (reqid, handle) => {
                const state = getHandle(handle);
                if (!state || state.type !== "dir") return sftp.status(reqid, STATUS_CODE.FAILURE);
                if (state.read) return sftp.status(reqid, STATUS_CODE.EOF);
                state.read = true;
                sftp.name(reqid, state.entries);
              })
              .on("OPEN", (reqid, filename, flags, attrs) => {
                try {
                  const virtualPath = asVirtualPath(filename);
                  const localPath = localPathFor(rootDir, virtualPath);
                  ensureDirSync(path.dirname(localPath));
                  const fd = fs.openSync(localPath, "w");
                  const handle = openHandle({
                    type: "file",
                    fd,
                    localPath,
                    virtualPath,
                    bytes: 0,
                    openedAt: Date.now(),
                  });
                  writeJsonLine(eventLog, { type: "file.open", virtualPath, localPath, flags, attrs });
                  sftp.handle(reqid, handle);
                } catch (error) {
                  writeJsonLine(eventLog, { type: "file.open.failed", filename, error: error.message });
                  sftp.status(reqid, STATUS_CODE.FAILURE);
                }
              })
              .on("WRITE", (reqid, handle, offset, data) => {
                const state = getHandle(handle);
                if (!state || state.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
                fs.write(state.fd, data, 0, data.length, Number(offset), (error, written) => {
                  if (error) {
                    writeJsonLine(eventLog, { type: "file.write.failed", virtualPath: state.virtualPath, error: error.message });
                    return sftp.status(reqid, STATUS_CODE.FAILURE);
                  }
                  state.bytes += written;
                  sftp.status(reqid, STATUS_CODE.OK);
                });
              })
              .on("CLOSE", (reqid, handle) => {
                const state = closeHandle(handle);
                if (!state) return sftp.status(reqid, STATUS_CODE.FAILURE);
                if (state.fd) fs.closeSync(state.fd);
                if (state.type === "file") {
                  writeJsonLine(eventLog, {
                    type: "file.closed",
                    virtualPath: state.virtualPath,
                    localPath: state.localPath,
                    bytes: state.bytes,
                    elapsedMs: Date.now() - state.openedAt,
                  });
                  console.log(`[sftp] uploaded ${state.bytes} bytes -> ${state.localPath}`);
                }
                sftp.status(reqid, STATUS_CODE.OK);
              })
              .on("MKDIR", (reqid, filename) => {
                try {
                  fs.mkdirSync(localPathFor(rootDir, filename), { recursive: true });
                  sftp.status(reqid, STATUS_CODE.OK);
                } catch {
                  sftp.status(reqid, STATUS_CODE.FAILURE);
                }
              })
              .on("SETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK))
              .on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK))
              .on("REMOVE", (reqid, filename) => {
                try {
                  fs.unlinkSync(localPathFor(rootDir, filename));
                  sftp.status(reqid, STATUS_CODE.OK);
                } catch {
                  sftp.status(reqid, STATUS_CODE.FAILURE);
                }
              })
              .on("RENAME", (reqid, oldPath, newPath) => {
                try {
                  fs.renameSync(localPathFor(rootDir, oldPath), localPathFor(rootDir, newPath));
                  sftp.status(reqid, STATUS_CODE.OK);
                } catch {
                  sftp.status(reqid, STATUS_CODE.FAILURE);
                }
              });

            function statPath(reqid, filename) {
              try {
                const localPath = localPathFor(rootDir, filename);
                const stats = fs.statSync(localPath);
                sftp.attrs(reqid, attrsFromStats(stats));
              } catch {
                sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              }
            }
          });
        });
      })
      .on("close", () => {
        writeJsonLine(eventLog, { type: "client.disconnected", remote });
        console.log(`[sftp] client disconnected ${remote}`);
      })
      .on("error", (error) => {
        writeJsonLine(eventLog, { type: "client.error", remote, error: error.message });
      });
  });

  server.on("error", (error) => {
    writeJsonLine(eventLog, { type: "server.error", error: error.message });
    console.error(`[sftp] server error: ${error.message}`);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const runtimeDir = path.resolve(readFlag(argv, "--runtime-dir", path.join("runtime", "cx-recording-sftp-test")));
  const defaultRoot = path.join(os.homedir(), "Desktop", "cx-recordings", "inbox");
  const rootDir = path.resolve(readFlag(argv, "--root", defaultRoot));
  const host = readFlag(argv, "--host", "127.0.0.1");
  const port = Number(readFlag(argv, "--port", "2222"));
  const username = readFlag(argv, "--username", "rcx-delivery");
  const password = readFlag(argv, "--password", "");
  const credentialsPath = path.join(runtimeDir, "credentials.json");
  const hostKeyPath = path.join(runtimeDir, "host.key");
  const eventLog = path.join(runtimeDir, "events.ndjson");

  ensureDirSync(rootDir);
  ensureDirSync(runtimeDir);
  const credentials = ensureCredentials(credentialsPath, username, password);
  const hostKey = ensureHostKey(hostKeyPath);

  await createSftpServer({ host, port, rootDir, credentials, hostKey, eventLog });

  console.log("RingCX recording SFTP test receiver is listening");
  console.log(`  Local bind : ${host}:${port}`);
  console.log("  Protocol   : SFTP");
  console.log(`  User       : ${credentials.username}`);
  console.log(`  Password   : ${credentials.password}`);
  console.log("  Root path  : /");
  console.log(`  Inbox dir  : ${rootDir}`);
  console.log(`  Event log  : ${eventLog}`);
  console.log("");
  console.log("Expose with:");
  console.log(`  C:\\tools\\ngrok\\ngrok.exe tcp ${port}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
