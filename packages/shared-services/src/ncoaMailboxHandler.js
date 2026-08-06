"use strict";

/**
 * The NCOA handler for `mailboxIngestService`.
 *
 * Mickey 2026-08-05: "I think we can move the ncoa check up to this point so you
 * get into the mailbox once and then send the right email to invoice scraping and
 * the right csv to logics, instead of checking and blasting emails."
 *
 * The shared loop was built for exactly this — its own header quotes him asking for
 * it a week earlier — and it already takes an ARRAY of handlers and opens the
 * mailbox once, outside the loop. Until now only the mail invoice used it, while
 * NCOA kept its own entry point on the hourly sweeper. So the same mailbox was
 * being opened on two different schedules to read two different documents out of it.
 *
 * This makes NCOA the second handler. Nothing about what happens to a CSV changes:
 * `processAttachment` in ncoaMailboxIngestService still parses it, uploads it to
 * Logics and records the workflow stages. What changes is who opens the door.
 *
 * ── WHY THE BUFFER IS PASSED IN ─────────────────────────────────────────────
 *
 * The shared loop downloads every attachment on a message before calling a handler,
 * because the mail invoice has to see the invoice and its receipt together to decide.
 * NCOA does not need that — each CSV stands alone — but the bytes are already in
 * hand by the time we are called, so refetching them would pull the same file from
 * Gmail twice against the same quota. `processAttachment` now accepts the buffer and
 * only fetches when it is not given one.
 *
 * ── THE CADENCE CHANGES, DELIBERATELY ───────────────────────────────────────
 *
 * Hourly becomes nightly. Mickey, asked directly: "it's a mail list that has no
 * application on your business for 2-3 days max, so it's fine." Recorded because a
 * future reader will otherwise assume the delay was an oversight.
 */

const path = require("path");

const DEFAULT_QUERY = "has:attachment newer_than:2d";

/** The extensions NCOA will take. Same default the standalone runner uses. */
const DEFAULT_EXTENSIONS = [".csv", ".txt"];

function extensionAllowed(filename, accepted = []) {
  const list = accepted.length ? accepted : DEFAULT_EXTENSIONS;
  const lower = String(filename || "").toLowerCase();
  return list.some((ext) => lower.endsWith(String(ext).toLowerCase()));
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * @param {Object}   opts
 * @param {string}   [opts.gmailQuery]  which mail to look at
 * @param {string}   [opts.domain]      TAG / WYNN / AMITY — whose list this is
 * @param {string}   [opts.outDir]      where the raw CSV is kept for audit
 * @param {string[]} [opts.acceptedExtensions]
 * @param {Object}   [opts.service]     injected for tests
 */
function createNcoaHandler({
  gmailQuery = null,
  domain = null,
  outDir = null,
  acceptedExtensions = null,
  service = null,
  config: configOverride = null,
} = {}) {
  const impl = () => service || require("./ncoaMailboxIngestService");

  // Read from the SAME shared config the standalone runner uses rather than
  // inventing defaults. The query in particular is unread-scoped and tuned; a
  // handler quietly substituting "has:attachment newer_than:2d" would widen the
  // scan and change which mail is even considered.
  const cfg = () => configOverride || impl().buildConfig({
    ...(domain ? { domain } : {}),
    ...(outDir ? { outDir } : {}),
  });

  const settled = cfg();

  return {
    key: "ncoa",
    gmailQuery: gmailQuery || settled.gmailQuery || DEFAULT_QUERY,

    /**
     * Accept on EXTENSION, unlike the mail invoice which accepts on content.
     *
     * The two are different problems. The vendor's PDFs are named by habit and an
     * invoice must be told apart from its receipt, so that one has to read the bytes.
     * An NCOA return is a CSV from a list provider and the extension is the contract.
     * Reading the file to decide whether to read the file would buy nothing.
     */
    accepts(attachments = []) {
      const exts = acceptedExtensions || settled.acceptedExtensions || [];
      return attachments.some((a) => extensionAllowed(a.filename, exts));
    },

    async process({ attachments = [], message, messageId, subject, apply, gmail, logger }) {
      const { processAttachment } = impl();
      const config = cfg();
      const exts = acceptedExtensions || config.acceptedExtensions || [];
      const runDir = path.join(config.outDir, `run-${timestampForFile()}`);

      const files = [];
      let written = 0;
      for (const a of attachments) {
        if (!extensionAllowed(a.filename, exts)) continue;
        // Each CSV independently. One bad file must not cost the others on the
        // same message — the whole point of handing the set over at once is that
        // the handler decides, and here the decision is per file.
        try {
          const result = await processAttachment({
            // No gmail client: the buffer is already in hand, so nothing refetches.
            gmail: null,
            message: message || { id: messageId },
            part: a,
            buffer: a.buffer,
            config,
            runDir,
            dryRun: !apply,
          });
          files.push(result);
          if (!result.skipped) written += 1;
        } catch (error) {
          files.push({
            filename: a.filename || null,
            skipped: true,
            skipReason: `failed: ${String(error.message).slice(0, 120)}`,
          });
        }
      }

      // Clear the message the way the standalone runner does. The Gmail query is
      // unread-scoped, so leaving the flag set means re-listing the same growing
      // set every night — the dedupe ledger would stop us acting on it, but the
      // scan would get slower forever and the mailbox would never look handled.
      //
      // Only after a CLEAN pass: any file error and the flag stays, so the message
      // comes back rather than going quiet in an archive nobody reads.
      const clean = written > 0 && !files.some((f) => /^failed:/.test(String(f.skipReason || "")));
      if (apply && clean && config.markRead && gmail?.modifyMessage) {
        const removeLabelIds = ["UNREAD"];
        if (config.archiveProcessed) removeLabelIds.push("INBOX");
        try {
          await gmail.modifyMessage(message?.id || messageId, { removeLabelIds });
        } catch (error) {
          // Never fails the ingest — the CSV is already uploaded by this point.
          logger?.warn?.("ncoa_handler.mark_read_failed", {
            error: String(error.message).slice(0, 120),
          });
        }
      }

      return {
        // The loop only claims a message as handled when this is true, so a dry
        // run stays repeatable and a message whose files all failed comes back.
        written: apply && written > 0,
        summary: {
          // The RESOLVED domain, not the parameter — that is null unless a caller
          // overrode it, and the config default is what actually got uploaded to.
          domain: config.domain || null,
          subject: String(subject || "").slice(0, 200),
          files: files.length,
          uploaded: files.filter((f) => !f.skipped).length,
          skipped: files.filter((f) => f.skipped).length,
          rows: files.reduce((n, f) => n + Number(f.total || 0), 0),
          succeeded: files.reduce((n, f) => n + Number(f.succeeded || 0), 0),
          failed: files.reduce((n, f) => n + Number(f.failed || 0), 0),
        },
        files,
      };
    },
  };
}

module.exports = { createNcoaHandler, extensionAllowed, DEFAULT_QUERY };
