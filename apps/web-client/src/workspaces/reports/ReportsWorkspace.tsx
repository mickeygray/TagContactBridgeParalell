import { useMemo, useState } from "react";
import { CalendarDays, Download, Loader2, Mail, Pencil, Play, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import {
  useArchiveDefinition,
  useReportCatalogue,
  useReportDefinitions,
  usePreviewReport,
  useRunDefinition,
  useSaveDefinition,
  type ReportDefinition,
  type ReportSection,
} from "@/lib/api/queries/reports";

/** Pacific day key — reports are Pacific everywhere else, so the pickers are too. */
function pacificToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftDays(key: string, delta: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + delta * 86400000)
    .toISOString()
    .slice(0, 10);
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// 1..28 then 0. Stops at 28 deliberately: 29-31 skip whole months, and 0 is
// the server's "last day", which is what a month-end report actually wants.
const MONTH_DAYS = [...Array.from({ length: 28 }, (_, i) => i + 1), 0];

/**
 * Say the cadence in words.
 *
 * The server ANDs weekday and date together, so a schedule can be saved that
 * looks armed and effectively never fires. Spelling it out is what makes that
 * visible on the list rather than a month later when nobody got the report.
 */
function describeCadence(s?: ReportDefinition["schedule"]): string {
  if (!s?.enabled) return "not scheduled";
  const dows = s.daysOfWeek ?? [];
  const doms = s.daysOfMonth ?? [];
  const when = doms.length
    ? `on the ${doms.map((n) => (n === 0 ? "last day" : `${n}`)).join(", ")}`
    : "";
  const wd = dows.length ? dows.map((i) => DOW[i]).join(", ") : "";
  if (!dows.length && !doms.length) return "every day";
  if (dows.length && doms.length) return `${wd} — but only ${when} (rarely both)`;
  return dows.length ? `every ${wd}` : `every month ${when}`;
}

function SectionTable({ section }: { section: ReportSection }) {
  if (section.error) {
    return (
      <p className="text-sm text-destructive">
        unavailable — {section.error}
      </p>
    );
  }
  if (!section.table || section.table.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing in this range.</p>;
  }
  const { columns, rows } = section.table;
  // Numbers right-align and use tabular figures so columns of money line up.
  const isNumeric = (v: unknown) => typeof v === "number";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            {columns.map((c) => (
              <th
                key={c}
                className="whitespace-nowrap py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                {c.replace(/_/g, " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={
                    isNumeric(cell)
                      ? "whitespace-nowrap py-1.5 pr-4 text-right tabular-nums"
                      : "py-1.5 pr-4"
                  }
                >
                  {cell === null || cell === undefined || cell === ""
                    ? <span className="text-muted-foreground">—</span>
                    : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReportsWorkspace() {
  const catalogue = useReportCatalogue();
  const definitions = useReportDefinitions();
  const preview = usePreviewReport();
  const saveDefinition = useSaveDefinition();
  const archiveDefinition = useArchiveDefinition();
  const runDefinition = useRunDefinition();

  const today = pacificToday();
  const [picked, setPicked] = useState<string[]>(["spend", "money", "net", "source"]);
  const [from, setFrom] = useState(shiftDays(today, -7));
  const [to, setTo] = useState(today);
  const [filters, setFilters] = useState("");
  const [tab, setTab] = useState("build");

  // Save-as-schedule form
  const [name, setName] = useState("");
  const [range, setRange] = useState("yesterday");
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState(0);
  const [recipients, setRecipients] = useState("");
  const [days, setDays] = useState<number[]>([]);
  // Day-of-month, with 0 meaning LAST DAY — that is how a month-end P/L gets
  // scheduled, and the 31st would silently skip the short months.
  const [monthDays, setMonthDays] = useState<number[]>([]);
  // Set while editing an existing definition, so Save overwrites that shape
  // instead of quietly minting a near-duplicate under a new name.
  const [editing, setEditing] = useState<string | null>(null);

  /** Load a saved definition back into the builder. */
  const loadDefinition = (d: ReportDefinition) => {
    setEditing(d.name);
    setName(d.name);
    setPicked(d.blocks ?? []);
    setFilters((d.filters ?? []).join(", "));
    setRange(d.range ?? "yesterday");
    setRecipients((d.recipients ?? []).join(", "));
    setHour(d.schedule?.hour ?? 7);
    setMinute(d.schedule?.minute ?? 0);
    setDays(d.schedule?.daysOfWeek ?? []);
    setMonthDays(d.schedule?.daysOfMonth ?? []);
    setTab("build");
  };

  const resetForm = () => {
    setEditing(null);
    setName("");
    setRecipients("");
    setDays([]);
    setMonthDays([]);
  };

  const whereList = useMemo(
    () => filters.split(",").map((f) => f.trim()).filter(Boolean),
    [filters],
  );

  const toggleBlock = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const runPreview = () =>
    preview.mutate({ blocks: picked, from, to, where: whereList });

  const downloadCsv = async () => {
    // Straight fetch: this is a file download, not application state.
    const token = localStorage.getItem("parallel_token");
    const res = await fetch("/api/reports/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ blocks: picked, from, to, where: whereList, format: "csv" }),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const applyPreset = (blocks: string[]) => setPicked(blocks);

  const setQuickRange = (kind: "today" | "yesterday" | "last7" | "month") => {
    if (kind === "today") { setFrom(today); setTo(today); }
    else if (kind === "yesterday") { setFrom(shiftDays(today, -1)); setTo(shiftDays(today, -1)); }
    else if (kind === "last7") { setFrom(shiftDays(today, -7)); setTo(shiftDays(today, -1)); }
    else { setFrom(`${today.slice(0, 7)}-01`); setTo(today); }
  };

  const result = preview.data;

  return (
    <div className="space-y-6 p-6">
      <SectionHeader
        title="Reports"
        description="Tick what you want, pick a range, preview it. Save it to send on a schedule."
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="build">Build</TabsTrigger>
          <TabsTrigger value="scheduled">
            Scheduled ({definitions.data?.length ?? 0})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "build" && (
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          {/* ── controls ── */}
          <div className="space-y-4">
            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold">Start from</h3>
              <div className="flex flex-wrap gap-2">
                {catalogue.data?.presets.map((p) => (
                  <Button
                    key={p.key}
                    variant="secondary"
                    size="sm"
                    onClick={() => applyPreset(p.blocks)}
                  >
                    {p.key}
                  </Button>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold">Include</h3>
              <div className="space-y-2">
                {catalogue.data?.blocks.map((b) => (
                  <label key={b.id} className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={picked.includes(b.id)}
                      onChange={() => toggleBlock(b.id)}
                    />
                    <span>
                      <span className="font-medium">{b.label}</span>
                      <span className="block text-xs text-muted-foreground">{b.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold">Range</h3>
              <div className="mb-3 flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => setQuickRange("today")}>Today</Button>
                <Button variant="secondary" size="sm" onClick={() => setQuickRange("yesterday")}>Yesterday</Button>
                <Button variant="secondary" size="sm" onClick={() => setQuickRange("last7")}>Last 7</Button>
                <Button variant="secondary" size="sm" onClick={() => setQuickRange("month")}>This month</Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="mb-1 text-sm font-semibold">Only show</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                Comma separated. {catalogue.data?.filterKeys.join(" · ")}
              </p>
              <Input
                placeholder="officer=Bruce, source=LD"
                value={filters}
                onChange={(e) => setFilters(e.target.value)}
              />
            </Card>

            <div className="flex gap-2">
              <Button onClick={runPreview} disabled={preview.isPending || picked.length === 0}>
                {preview.isPending
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Gathering…</>
                  : <><Play className="mr-2 h-4 w-4" />Run it</>}
              </Button>
              <Button variant="secondary" onClick={downloadCsv} disabled={!result}>
                <Download className="mr-2 h-4 w-4" />CSV
              </Button>
            </div>
            {preview.isPending && (
              <p className="text-xs text-muted-foreground">
                Gathering live from Logics, CallRail and the spend sheet. A day takes
                about 15 seconds, a month up to two minutes.
              </p>
            )}
            {preview.isError && (
              <p className="text-sm text-destructive">
                {(preview.error as Error)?.message ?? "That did not run."}
              </p>
            )}
          </div>

          {/* ── result ── */}
          <div className="space-y-4">
            {!result && !preview.isPending && (
              <Card className="p-8 text-center text-sm text-muted-foreground">
                Tick what you want and press Run it.
              </Card>
            )}

            {result && (
              <>
                <div className="flex items-baseline gap-3">
                  <h2 className="text-lg font-semibold">
                    {result.from}{result.to !== result.from ? ` → ${result.to}` : ""}
                  </h2>
                  {result.gathered?.durationMs && (
                    <span className="text-xs text-muted-foreground">
                      {result.gathered.activityRows?.toLocaleString()} activity rows ·{" "}
                      {Math.round(result.gathered.durationMs / 1000)}s
                    </span>
                  )}
                </div>

                {result.sections.map((s) => (
                  <Card key={s.id} className="p-4">
                    <h3 className="mb-3 text-sm font-semibold">{s.label}</h3>
                    <SectionTable section={s} />
                    {/* Terms travel with the numbers — two people can read the
                        same ROI and mean different things. */}
                    {s.terms && (
                      <p className="mt-3 border-t pt-2 text-xs leading-relaxed text-muted-foreground">
                        {s.terms}
                      </p>
                    )}
                  </Card>
                ))}

                {result.notes.length > 0 && (
                  <Card className="p-4">
                    <h3 className="mb-2 text-sm font-semibold">Worth knowing</h3>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {result.notes.map((n, i) => <li key={i}>· {n}</li>)}
                    </ul>
                  </Card>
                )}

                {/* ── turn it into a schedule ── */}
                <Card className="p-4">
                  <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                    <CalendarClockIcon />Send this on a schedule
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input placeholder="Name it" value={name} onChange={(e) => setName(e.target.value)} />
                    <select
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                      value={range}
                      onChange={(e) => setRange(e.target.value)}
                    >
                      {catalogue.data?.ranges.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <Input
                      placeholder="who@taxadvocategroup.com, comma separated"
                      value={recipients}
                      onChange={(e) => setRecipients(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <Input
                        type="number" min={0} max={23} className="w-20"
                        value={hour} onChange={(e) => setHour(Number(e.target.value))}
                      />
                      <span className="text-sm text-muted-foreground">:</span>
                      <Input
                        type="number" min={0} max={59} className="w-20"
                        value={minute} onChange={(e) => setMinute(Number(e.target.value))}
                      />
                      <span className="text-xs text-muted-foreground">PT</span>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Days (none = every day):</span>
                    {DOW.map((d, i) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDays((p) => p.includes(i) ? p.filter((x) => x !== i) : [...p, i])}
                        className={`rounded border px-2 py-0.5 text-xs ${
                          days.includes(i) ? "bg-primary text-primary-foreground" : "bg-background"
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      Dates (none = any date):
                    </span>
                    {MONTH_DAYS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        title={n === 0 ? "Last day of the month" : `Day ${n}`}
                        onClick={() =>
                          setMonthDays((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]))
                        }
                        className={`rounded border px-1.5 py-0.5 text-[11px] tabular-nums ${
                          monthDays.includes(n) ? "bg-primary text-primary-foreground" : "bg-background"
                        }`}
                      >
                        {n === 0 ? "last" : n}
                      </button>
                    ))}
                  </div>
                  {days.length > 0 && monthDays.length > 0 && (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                      Both are set, so this only sends when the weekday <em>and</em> the date
                      match — often never. Pick one.
                    </p>
                  )}
                  <div className="mt-4 flex items-center gap-2">
                    <Button
                      disabled={!name || saveDefinition.isPending}
                      onClick={() =>
                        saveDefinition.mutate({
                          name,
                          blocks: picked,
                          filters: whereList,
                          range,
                          recipients: recipients.split(",").map((r) => r.trim()).filter(Boolean),
                          schedule: {
                            enabled: true, hour, minute,
                            daysOfWeek: days, daysOfMonth: monthDays,
                          },
                        }, { onSuccess: () => { resetForm(); setTab("scheduled"); } })
                      }
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      {editing ? `Update "${editing}"` : "Save schedule"}
                    </Button>
                    {editing && (
                      <Button variant="ghost" onClick={resetForm}>Cancel</Button>
                    )}
                  </div>
                  {editing && editing !== name && (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                      Renaming saves a NEW schedule — “{editing}” stays as it is.
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Nothing sends until the scheduler is armed on the server.
                  </p>
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "scheduled" && (
        <div className="space-y-3">
          {definitions.data?.length === 0 && (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              Nothing scheduled yet. Build a report and save it.
            </Card>
          )}
          {definitions.data?.map((d) => (
            <Card key={d.name} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{d.name}</h3>
                    <StatusPill tone={d.schedule?.enabled ? "success" : "neutral"}>
                      {d.schedule?.enabled
                        ? `${String(d.schedule.hour).padStart(2, "0")}:${String(d.schedule.minute).padStart(2, "0")} PT`
                        : "not scheduled"}
                    </StatusPill>
                    {d.due && <StatusPill tone="warning">due now</StatusPill>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {d.blocks.join(" · ")} — {d.range}
                    {d.resolvedRange ? ` (${d.resolvedRange.from}…${d.resolvedRange.to})` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">{describeCadence(d.schedule)}</p>
                  <p className="text-xs text-muted-foreground">
                    to {d.recipients.length ? d.recipients.join(", ") : "nobody"}
                    {d.lastRunKey ? ` · last ran ${d.lastRunKey}` : " · never run"}
                  </p>
                  {d.lastError && (
                    <p className="mt-1 text-xs text-destructive">last error: {d.lastError}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary" size="sm"
                    onClick={() => loadDefinition(d)}
                  >
                    <Pencil className="mr-1 h-3 w-3" />Edit
                  </Button>
                  <Button
                    variant="secondary" size="sm"
                    disabled={runDefinition.isPending}
                    onClick={() => runDefinition.mutate({ name: d.name, send: false })}
                  >
                    <Play className="mr-1 h-3 w-3" />Preview
                  </Button>
                  <Button
                    variant="secondary" size="sm"
                    disabled={runDefinition.isPending || d.recipients.length === 0}
                    onClick={() => {
                      // Sending reaches real inboxes; make it deliberate.
                      if (window.confirm(`Email "${d.name}" to ${d.recipients.join(", ")} now?`)) {
                        runDefinition.mutate({ name: d.name, send: true });
                      }
                    }}
                  >
                    <Mail className="mr-1 h-3 w-3" />Send now
                  </Button>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => {
                      if (window.confirm(`Archive "${d.name}"?`)) archiveDefinition.mutate(d.name);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              {runDefinition.data?.definition === d.name && (
                <pre className="mt-3 max-h-96 overflow-auto rounded bg-muted p-3 text-xs leading-relaxed">
                  {runDefinition.data.text}
                </pre>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function CalendarClockIcon() {
  return <CalendarDays className="h-4 w-4" />;
}
