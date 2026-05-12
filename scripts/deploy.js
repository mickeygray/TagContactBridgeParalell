// scripts/deploy.js
// ─────────────────────────────────────────────────────────────
// One-shot deploy CLI. No server, just runs and exits.
//
// USAGE:
//   node scripts/deploy.js deploy wynn "added iowa blog"   Commit + deploy
//   node scripts/deploy.js deploy wynn                     Build + deploy (no git)
//   node scripts/deploy.js deploy wynn --pull              Push + pull + build + deploy
//   node scripts/deploy.js deploy wynn --skip              Deploy existing build
//   node scripts/deploy.js deploy wynn --dry               Verify only, no swap
//   node scripts/deploy.js deploy wynn "fix nav" --dry     Commit + verify only
//   node scripts/deploy.js restart wynn                    PM2 restart
//   node scripts/deploy.js rollback wynn                   Revert to previous
//   node scripts/deploy.js status wynn                     Check what's live
//   node scripts/deploy.js sites                           List configured sites
//
// SHORTHAND:
//   node scripts/deploy.js d wynn "message"       commit + deploy
//   node scripts/deploy.js d wynn -p              push + pull + deploy
//   node scripts/deploy.js d wynn -s -d           verify existing build
//   node scripts/deploy.js r wynn                 restart
//   node scripts/deploy.js rb wynn                rollback
//   node scripts/deploy.js s wynn                 status
// ─────────────────────────────────────────────────────────────

require("dotenv").config();

const {
  deployBuild,
  rollbackBuild,
  checkRemote,
  SITES,
} = require("./deployService");
const { NodeSSH } = require("node-ssh");

// ─── Parse args ──────────────────────────────────────────────

const args = process.argv.slice(2);
const command = (args[0] || "").toLowerCase();
const brand = (args[1] || "").toLowerCase();
const extra = args.slice(2);

const COMMANDS = {
  deploy: "deploy",
  d: "deploy",
  restart: "restart",
  r: "restart",
  rollback: "rollback",
  rb: "rollback",
  status: "status",
  s: "status",
  sites: "sites",
};

const action = COMMANDS[command];

// ─── Help ────────────────────────────────────────────────────

function showHelp() {
  console.log(`
  Deploy CLI — manage EC2 site deployments

  Usage:  node scripts/deploy.js <command> <brand> [options]

  Commands:
    deploy   <brand> "message"   Commit + push + pull + build + deploy
    deploy   <brand>             Build + deploy (no git)
    deploy   <brand> --pull      Git push + pull, then build + deploy
    deploy   <brand> --skip      Deploy existing build (skip npm run build)
    deploy   <brand> --dry       Full pipeline but stop before swap (verify only)
    restart  <brand> [process]   PM2 restart on EC2 (default: all)
    rollback <brand>             Revert to previous build on EC2
    status   <brand>             Check what's live on EC2
    sites                        List configured sites

  Brands:  ${Object.keys(SITES).join(", ")}

  Flags: -s = --skip, -d = --dry, -p = --pull (auto when "message" given)

  Examples:
    node scripts/deploy.js deploy wynn "added iowa blog"
    node scripts/deploy.js deploy wynn "fix nav" --dry
    node scripts/deploy.js d wynn -p
    node scripts/deploy.js d wynn -s -d

  Examples:
    node scripts/deploy.js deploy wynn
    node scripts/deploy.js d tag --skip
    node scripts/deploy.js restart wynn server
    node scripts/deploy.js status wynn
`);
}

// ─── Sites ───────────────────────────────────────────────────

function showSites() {
  console.log("\n  Configured sites:\n");
  for (const [key, site] of Object.entries(SITES)) {
    const configured = site.host && site.pemPath;
    const status = configured ? "✓" : "✗ incomplete";
    console.log(`  ${status} ${key.toUpperCase().padEnd(6)} ${site.label}`);
    if (site.host) {
      console.log(`           ${site.user}@${site.host}:${site.remotePath}`);
      console.log(`           Build: ${site.localBuildPath || "not set"}`);
      console.log(`           PM2:   ${site.pm2Process || "all"}`);
    } else {
      console.log(
        `           Set DEPLOY_${key.toUpperCase()}_HOST and DEPLOY_${key.toUpperCase()}_PEM in .env`,
      );
    }
    console.log("");
  }
}

// ─── Restart ─────────────────────────────────────────────────

async function restartBackend(brand, processName) {
  const site = SITES[brand];
  if (!site) throw new Error(`Unknown brand: ${brand}`);
  if (!site.host) throw new Error(`No host configured for ${brand}`);

  const target = processName || site.pm2Process || "all";
  const escapedTarget = "'" + String(target).replace(/'/g, "'\\''") + "'";
  const ssh = new NodeSSH();

  try {
    console.log(`\n  Connecting to ${site.user}@${site.host}...`);
    await ssh.connect({
      host: site.host,
      username: site.user,
      privateKeyPath: site.pemPath,
      readyTimeout: 15000,
    });

    console.log(`  Running: pm2 restart ${target}\n`);
    const result = await ssh.execCommand(
      `sudo -u ubuntu pm2 restart ${escapedTarget} && sudo -u ubuntu pm2 status || pm2 restart ${escapedTarget} && pm2 status`,
    );

    if (result.code !== 0) {
      throw new Error(
        `PM2 restart failed (exit ${result.code}): ${result.stderr || result.stdout}`,
      );
    }

    if (result.stdout) {
      console.log(result.stdout);
    }

    console.log(`  ✓ PM2 restart complete\n`);
  } finally {
    ssh.dispose();
  }
}

// ─── Status ──────────────────────────────────────────────────

function printStatus(brand, info) {
  const site = SITES[brand];
  console.log(`
  ${site.label} — Remote Status
  ─────────────────────────────────────────────
  Host:          ${site.user}@${site.host}
  Build exists:  ${info.buildExists ? "✓" : "✗"}
  Pages:         ${info.pageCount}
  CSS files:     ${info.cssFiles}
  JS files:      ${info.jsFiles}
  Build date:    ${info.buildDate || "unknown"}
  Build owner:   ${info.buildOwner || "unknown"}
  Backups:       ${info.backupCount}
  Disk free:     ${info.diskFree}
  Nginx:         ${info.nginx || "unknown"}
  PM2:           ${info.pm2 || "unknown"}
  `);

  if (info.recentBackups?.length) {
    console.log("  Recent backups:");
    info.recentBackups.forEach((b) => console.log(`    ${b}`));
    console.log("");
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  // No args or help
  if (
    !action ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    showHelp();
    process.exit(0);
  }

  // Sites listing (no brand needed)
  if (action === "sites") {
    showSites();
    process.exit(0);
  }

  // Everything else needs a brand
  if (!brand || !SITES[brand]) {
    if (!brand) {
      console.error(
        "\n  ✗ Missing brand. Available:",
        Object.keys(SITES).join(", "),
      );
    } else {
      console.error(
        `\n  ✗ Unknown brand: "${brand}". Available:`,
        Object.keys(SITES).join(", "),
      );
    }
    process.exit(1);
  }

  const site = SITES[brand];
  if (!site.host || !site.pemPath) {
    console.error(
      `\n  ✗ ${brand.toUpperCase()} not fully configured. Check .env for DEPLOY_${brand.toUpperCase()}_HOST and _PEM`,
    );
    process.exit(1);
  }

  const startTime = Date.now();

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ${action.toUpperCase()} — ${site.label}`);
  console.log("═══════════════════════════════════════════════════════════");

  try {
    switch (action) {
      case "deploy": {
        const skipBuild = extra.includes("--skip") || extra.includes("-s");
        const dryRun = extra.includes("--dry") || extra.includes("-d");
        const pull = extra.includes("--pull") || extra.includes("-p");
        // Commit message: anything in extra that isn't a flag
        const commitMsg =
          extra
            .filter((a) => !a.startsWith("-"))
            .join(" ")
            .trim() || null;

        if (commitMsg) {
          console.log(
            `  Git: commit "${commitMsg}" → push → pull → build → deploy\n`,
          );
        } else if (pull) {
          console.log("  Git: push + pull latest before build\n");
        }
        if (dryRun) {
          console.log(
            "  Mode: DRY RUN (will verify everything but not swap live)\n",
          );
        }
        const result = await deployBuild(
          brand,
          { skipBuild, dryRun, pull: pull || !!commitMsg, commitMsg },
          (line) => console.log(`  ${line}`),
        );
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log("");
        if (result.dryRun) {
          console.log(
            "═══════════════════════════════════════════════════════════",
          );
          console.log("  ✓ DRY RUN COMPLETE — no changes made");
          console.log(
            "═══════════════════════════════════════════════════════════",
          );
          console.log(`  Local pages:  ${result.localPages}`);
          console.log(`  Remote pages: ${result.pageCount}`);
          console.log(`  CSS files:    ${result.cssFiles}`);
          console.log(`  JS files:     ${result.jsFiles}`);
          console.log(`  Duration:     ${duration}s`);
          console.log("");
          console.log(`  Everything looks good. Run without --dry to deploy:`);
          console.log(`    node scripts/deploy.js deploy ${brand}`);
        } else {
          console.log(
            "═══════════════════════════════════════════════════════════",
          );
          console.log("  ✓ DEPLOY COMPLETE");
          console.log(
            "═══════════════════════════════════════════════════════════",
          );
          console.log(`  Pages:       ${result.pageCount}`);
          console.log(`  CSS files:   ${result.cssFiles}`);
          console.log(`  JS files:    ${result.jsFiles}`);
          console.log(`  Permissions: ${result.permissions}`);
          console.log(`  Nginx:       ${result.nginx}`);
          console.log(`  PM2:         ${result.pm2}`);
          console.log(
            `  Verified:    ${result.verified ? "✓ site loads with CSS" : "⚠ could not verify"}`,
          );
          console.log(
            `  Backup:      ${result.backup || "none (first deploy)"}`,
          );
          console.log(`  Duration:    ${duration}s`);
          console.log(`  Live at:     ${site.url}`);
        }
        console.log("");
        break;
      }

      case "restart": {
        const processName = extra[0] || null;
        await restartBackend(brand, processName);
        break;
      }

      case "rollback": {
        const result = await rollbackBuild(brand, (line) =>
          console.log(`  ${line}`),
        );
        console.log("");
        console.log(
          "═══════════════════════════════════════════════════════════",
        );
        console.log("  ✓ ROLLBACK COMPLETE");
        console.log(
          "═══════════════════════════════════════════════════════════",
        );
        console.log(`  Restored: ${result.restored}`);
        console.log(`  Pages:    ${result.pageCount}`);
        console.log(`  Nginx:    ${result.nginx}`);
        console.log(`  PM2:      ${result.pm2}`);
        console.log(`  Live at:  ${site.url}`);
        console.log("");
        break;
      }

      case "status": {
        const info = await checkRemote(brand);
        if (info.ok) {
          printStatus(brand, info);
        } else {
          console.error(`\n  ✗ Could not reach ${brand}: ${info.error}\n`);
        }
        break;
      }
    }
  } catch (err) {
    console.error(`\n  ✗ ${err.message}\n`);
    process.exit(1);
  }

  process.exit(0);
}

main();
