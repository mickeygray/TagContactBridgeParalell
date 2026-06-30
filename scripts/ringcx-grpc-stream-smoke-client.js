#!/usr/bin/env node
"use strict";

const path = require("path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function normalizeTarget(raw) {
  const value = String(raw || "").trim();
  if (/^https?:\/\//i.test(value) || /^grpcs?:\/\//i.test(value)) {
    const url = new URL(value.replace(/^grpcs?:\/\//i, "https://"));
    return `${url.hostname}:${url.port || "443"}`;
  }
  return value;
}

function loadProto(protoPath) {
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition);
  return loaded.ringcentral.ringcx.streaming.v1beta2;
}

async function main() {
  const argv = process.argv.slice(2);
  const target = normalizeTarget(readFlag(argv, "--target", "localhost:3334"));
  const secure = hasFlag(argv, "--secure") || !/^localhost:|^127\.0\.0\.1:/i.test(target);
  const protoPath = path.resolve(readFlag(argv, "--proto", path.join("scripts", "proto", "ringcx_streaming.proto")));
  const basicUser = readFlag(argv, "--basic-user", process.env.RINGCX_GRPC_USER || "");
  const basicPass = readFlag(argv, "--basic-pass", process.env.RINGCX_GRPC_PASS || "");
  const ringcx = loadProto(protoPath);
  const client = new ringcx.Streaming(
    target,
    secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
  );

  await new Promise((resolve, reject) => {
    const metadata = new grpc.Metadata();
    if (basicUser || basicPass) {
      metadata.set("authorization", `Basic ${Buffer.from(`${basicUser}:${basicPass}`, "utf8").toString("base64")}`);
    }
    const call = client.Stream(metadata, (error) => {
      if (error) reject(error);
      else resolve();
    });
    call.write({
      sessionId: "local-smoke-session",
      dialogInit: {
        account: { id: "smoke", subAccountId: "smoke-sub", rcAccountId: "smoke-rc" },
        dialog: {
          id: "local-smoke-dialog",
          type: 2,
          ani: "13106665997",
          dnis: "13106665997",
          language: "en-US",
          attributes: { source: "local-smoke" },
        },
      },
    });
    call.write({
      sessionId: "local-smoke-session",
      segmentStart: {
        segmentId: "segment-a",
        product: { id: "campaign-smoke", type: 2 },
        participant: { id: "contact-smoke", type: 1, name: "Smoke Contact" },
        audioFormat: { codec: 3, rate: 8000, ptime: 100 },
      },
    });
    call.write({
      sessionId: "local-smoke-session",
      segmentMedia: {
        segmentId: "segment-a",
        audioContent: {
          payload: Buffer.alloc(800, 0xff),
          seq: 1,
          duration: 100,
        },
      },
    });
    call.write({
      sessionId: "local-smoke-session",
      segmentStop: { segmentId: "segment-a" },
    });
    call.end();
  });

  console.log(`gRPC smoke sent to ${target} (${secure ? "TLS" : "insecure"})`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
