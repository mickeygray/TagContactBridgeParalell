"use strict";

// REPORTS API — the report builder, over HTTP.
//
// Mickey 2026-07-29: "it needs to be a working part of the app i can
// manipulate."
//
// Everything here is a thin wrapper over the same services the CLI uses, so a
// report run from the browser and one run from `scripts/build-report.js` are
// the same code producing the same numbers. No second implementation.
//
// ON THE LONG PREVIEW: composing live takes 13s for a day and up to ~150s for
// a month. That is fine here — nginx allows 3600-7200s on these paths
// (ops/nginx/parallel.conf), so a plain request works and a job queue would be
// machinery for a problem we do not have. The client shows progress instead.

const express = require("express");
const {
  BLOCKS, PRESETS, resolveSelection,
} = require("../../../../packages/shared-services/src/reportBlocksService");
const {
  composeReport, renderText, renderHtml, FILTER_KEYS,
} = require("../../../../packages/shared-services/src/reportComposerService");
const {
  ReportDefinition, isDue, resolveRange, runDefinition,
} = require("../../../../packages/shared-services/src/reportDefinitionService");
const { FUNCTIONS } = require("../../../../packages/shared-services/src/reportOpsService");
const { sendMail } = require("../../../../packages/shared-services/src/mailerService");
const { getInternalFromEmail } = require("../../../../packages/shared-config/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

const NEWLINE = String.fromCharCode(10);
const QUOTE = String.fromCharCode(34);

/** CSV for one section, from the same column declarations the CLI exports. */
function sectionCsv(section) {
  const table = section.block.csv(section.data);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? QUOTE + s.replace(/"/g, '""') + QUOTE : s;
  };
  const head = table.columns.map((c) => esc(c.header)).join(",");
  const body = (table.rows || []).map((r) => table.columns.map((c) => esc(c.get(r))).join(",")).join(NEWLINE);
  return `${head}${NEWLINE}${body}`;
}

function createReportsRouter(auth) {
  const router = express.Router();
  const guard = [auth.requireAuth, auth.requireAdmin];

  // ── what can be asked for ──
  // The catalogue the designer builds its checkboxes from. Terms travel with
  // each block so the UI can show what a number actually means.
  router.get("/catalogue", ...guard, async (req, res) => {
    try {
      return res.json({
        ok: true,
        result: {
          blocks: BLOCKS.map((b) => ({
            id: b.id, label: b.label, hint: b.hint, terms: b.terms || null, needs: b.needs,
          })),
          presets: Object.entries(PRESETS).map(([key, blocks]) => ({ key, blocks })),
          filterKeys: FILTER_KEYS,
          functions: Object.entries(FUNCTIONS).map(([key, f]) => ({
            key, label: f.label, unit: f.unit, hint: f.hint,
          })),
          ranges: ["today", "yesterday", "last7", "last30", "mtd", "lastmonth", "ytd"],
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // ── run one now ──
  // `format` picks the representation; the report is composed once either way.
  router.post("/preview", ...guard, async (req, res) => {
    try {
      const {
        blocks = ["board"], from, to, domain = null, where = [], format = "json",
      } = req.body || {};
      const sel = resolveSelection(blocks);
      if (sel.unknown.length) {
        // Refuse rather than quietly drop the thing that was asked for — a
        // silently-missing block reads as a zero.
        return res.status(400).json({
          ok: false,
          error: `unknown block(s): ${sel.unknown.join(", ")}`,
          available: BLOCKS.map((b) => b.id),
        });
      }
      const report = await composeReport({
        selection: blocks, from, to, domain, where, live: true,
      });

      if (format === "csv") {
        const csv = report.sections
          .filter((s) => !s.error)
          .map((s) => `# ${s.label}${NEWLINE}${sectionCsv(s)}`)
          .join(NEWLINE + NEWLINE);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition",
          `attachment; filename="report-${report.from}_${report.to}.csv"`);
        return res.send(csv);
      }
      if (format === "html") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(renderHtml(report));
      }
      return res.json({
        ok: true,
        result: {
          from: report.from, to: report.to, domain: report.domain,
          notes: report.notes || [],
          gathered: report.gathered || null,
          text: renderText(report),
          sections: report.sections.map((s) => ({
            id: s.id, label: s.label, terms: s.block?.terms || null,
            error: s.error || null,
            text: s.error ? null : s.block.renderText(s.data),
            table: s.error ? null : (() => {
              const t = s.block.csv(s.data);
              return {
                columns: t.columns.map((c) => c.header),
                rows: (t.rows || []).map((r) => t.columns.map((c) => c.get(r))),
              };
            })(),
          })),
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // ── saved shapes ──
  router.get("/definitions", ...guard, async (req, res) => {
    try {
      const docs = await ReportDefinition.find({ archivedAt: null }).sort({ name: 1 }).lean();
      return res.json({
        ok: true,
        result: docs.map((d) => {
          const verdict = isDue(d);
          return {
            ...d,
            resolvedRange: resolveRange(d.range),
            due: verdict.due,
            dueReason: verdict.reason,
          };
        }),
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/definitions", ...guard, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name) return res.status(400).json({ ok: false, error: "name is required" });
      const sel = resolveSelection(body.blocks?.length ? body.blocks : ["board"]);
      if (sel.unknown.length) {
        return res.status(400).json({ ok: false, error: `unknown block(s): ${sel.unknown.join(", ")}` });
      }
      const doc = await ReportDefinition.findOneAndUpdate(
        { name: body.name },
        {
          $set: {
            name: body.name,
            description: body.description || null,
            blocks: body.blocks || ["board"],
            filters: body.filters || [],
            domain: body.domain || null,
            range: body.range || "yesterday",
            recipients: body.recipients || [],
            sendEmail: body.sendEmail !== false,
            "schedule.enabled": Boolean(body.schedule?.enabled),
            "schedule.hour": Number(body.schedule?.hour ?? 7),
            "schedule.minute": Number(body.schedule?.minute ?? 0),
            "schedule.daysOfWeek": body.schedule?.daysOfWeek || [],
            "schedule.daysOfMonth": body.schedule?.daysOfMonth || [],
            archivedAt: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      return res.json({ ok: true, result: doc });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.delete("/definitions/:name", ...guard, async (req, res) => {
    try {
      // Archive, never delete — a schedule someone relied on should leave a
      // trace rather than vanish.
      const doc = await ReportDefinition.findOneAndUpdate(
        { name: req.params.name },
        { $set: { archivedAt: new Date(), "schedule.enabled": false } },
        { new: true },
      );
      if (!doc) return res.status(404).json({ ok: false, error: "no such definition" });
      return res.json({ ok: true, result: doc });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // ── run a saved shape now ──
  // send=false composes and returns the text WITHOUT delivering, which is how
  // you check what recipients would receive before they receive it.
  router.post("/definitions/:name/run", ...guard, async (req, res) => {
    try {
      const doc = await ReportDefinition.findOne({ name: req.params.name });
      if (!doc) return res.status(404).json({ ok: false, error: "no such definition" });
      const send = req.body?.send === true;
      const result = await runDefinition(doc, {
        dryRun: !send, sendMail, fromEmail: getInternalFromEmail(),
      });
      return res.json({
        ok: true,
        result: {
          definition: doc.name, range: result.range, sections: result.sections,
          delivered: result.delivered, errors: result.errors, notes: result.notes,
          text: result.text,
          recipients: send ? doc.recipients : [],
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = { createReportsRouter };
