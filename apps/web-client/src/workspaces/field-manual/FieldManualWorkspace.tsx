import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  GraduationCap,
  Quote,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { cn } from "@/lib/utils/cn";
import {
  ALL_ENTRIES,
  ENTRY_BY_ID,
  PARTS,
  type ManualBlock,
  type ManualEntry,
  type ManualPart,
} from "./content";

// The Field Manual — the static, human-readable twin of the live coach. A
// dictionary, not a document: every entry is addressable (URL hash),
// searchable, collapsible, and cross-linked (script beat -> objection ->
// strategy -> psychology principle).

const PART_ACCENT: Record<ManualPart, { dot: string; chip: string }> = {
  script: { dot: "bg-sky-500", chip: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  objections: { dot: "bg-rose-500", chip: "bg-rose-500/10 text-rose-700 dark:text-rose-300" },
  strategies: { dot: "bg-amber-500", chip: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  psychology: { dot: "bg-violet-500", chip: "bg-violet-500/10 text-violet-700 dark:text-violet-300" },
};

const PART_SHORT: Record<ManualPart, string> = {
  script: "Script",
  objections: "Objection",
  strategies: "Strategy",
  psychology: "Psychology",
};

const INLINE_REF = /\[\[([a-z0-9.-]+)\]\]/g;

function entryHaystack(e: ManualEntry): string {
  const parts: string[] = [e.title, e.lead, ...(e.aliases ?? [])];
  for (const b of e.blocks) {
    if (b.kind === "prose" || b.kind === "compliance") parts.push(b.text);
    else if (b.kind === "example") parts.push(b.weak, b.strong, b.note ?? "");
    else if (b.kind === "drill") parts.push(b.prompt, b.answer);
    else parts.push(...b.items);
  }
  return parts.join("\n").toLowerCase();
}

const HAYSTACKS = new Map(ALL_ENTRIES.map((e) => [e.id, entryHaystack(e)]));

function sectionOrder(part: ManualPart, section: string): number {
  const meta = PARTS.find((p) => p.id === part);
  const idx = meta?.sections.findIndex((s) => s.id === section) ?? -1;
  return idx === -1 ? 999 : idx;
}

function sectionTitle(part: ManualPart, section: string): string {
  const meta = PARTS.find((p) => p.id === part);
  return meta?.sections.find((s) => s.id === section)?.title ?? section;
}

/** Renders prose with [[entry-id]] inline references as jump links. */
function InlineText({ text, onJump }: { text: string; onJump: (id: string) => void }) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE_REF)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    const target = ENTRY_BY_ID.get(m[1]);
    if (target) {
      nodes.push(
        <button
          key={key++}
          type="button"
          onClick={() => onJump(target.id)}
          className="rounded-sm text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        >
          {target.title}
        </button>,
      );
    } else {
      nodes.push(m[0]);
    }
    last = idx + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

function BlockHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      {children}
    </div>
  );
}

function Drill({ prompt, answer, onJump }: { prompt: string; answer: string; onJump: (id: string) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-2">
        <GraduationCap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="space-y-2 text-sm">
          <div className="font-medium text-foreground">
            <InlineText text={prompt} onJump={onJump} />
          </div>
          {open ? (
            <div className="text-muted-foreground">
              <InlineText text={answer} onJump={onJump} />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-xs font-medium text-primary hover:underline"
            >
              Show the move
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EntryBlock({ block, onJump }: { block: ManualBlock; onJump: (id: string) => void }) {
  switch (block.kind) {
    case "prose":
      return (
        <div className="space-y-1.5">
          {block.heading ? <BlockHeading>{block.heading}</BlockHeading> : null}
          {block.text.split(/\n\n+/).map((para, i) => (
            <p key={i} className="text-sm leading-relaxed text-foreground/90">
              <InlineText text={para} onJump={onJump} />
            </p>
          ))}
        </div>
      );
    case "moves":
      return (
        <div className="space-y-1.5">
          <BlockHeading>{block.heading ?? "The plays, in order"}</BlockHeading>
          <ol className="list-decimal space-y-1 pl-5">
            {block.items.map((item, i) => (
              <li key={i} className="text-sm leading-relaxed text-foreground/90">
                <InlineText text={item} onJump={onJump} />
              </li>
            ))}
          </ol>
        </div>
      );
    case "lines":
      return (
        <div className="space-y-1.5">
          <BlockHeading>{block.heading ?? "Lines in the floor’s voice — adapt, never recite"}</BlockHeading>
          <div className="space-y-1.5">
            {block.items.map((item, i) => (
              <div key={i} className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
                <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-sm italic leading-relaxed text-foreground/90">{item}</span>
              </div>
            ))}
          </div>
        </div>
      );
    case "avoid":
      return (
        <div className="space-y-1.5">
          <BlockHeading>{block.heading ?? "What not to do"}</BlockHeading>
          <ul className="space-y-1">
            {block.items.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-foreground/90">
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
                <span>
                  <InlineText text={item} onJump={onJump} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "example":
      return (
        <div className="space-y-1.5">
          <BlockHeading>Weak vs strong</BlockHeading>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400">
                <XCircle className="h-3.5 w-3.5" /> Weak
              </div>
              <p className="text-sm italic leading-relaxed text-foreground/80">{block.weak}</p>
            </div>
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> Strong
              </div>
              <p className="text-sm italic leading-relaxed text-foreground/80">{block.strong}</p>
            </div>
          </div>
          {block.note ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              <InlineText text={block.note} onJump={onJump} />
            </p>
          ) : null}
        </div>
      );
    case "drill":
      return <Drill prompt={block.prompt} answer={block.answer} onJump={onJump} />;
    case "compliance":
      return (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm leading-relaxed text-foreground/90">
            <InlineText text={block.text} onJump={onJump} />
          </p>
        </div>
      );
    default:
      return null;
  }
}

function EntryCard({
  entry,
  open,
  onToggle,
  onJump,
}: {
  entry: ManualEntry;
  open: boolean;
  onToggle: () => void;
  onJump: (id: string) => void;
}) {
  const accent = PART_ACCENT[entry.part];
  const seeAlso = (entry.links ?? []).map((id) => ENTRY_BY_ID.get(id)).filter(Boolean) as ManualEntry[];
  return (
    <Card id={`entry-${entry.id}`} className="scroll-mt-24">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-4 text-left"
        aria-expanded={open}
      >
        <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", accent.dot)} />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{entry.title}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", accent.chip)}>
              {PART_SHORT[entry.part]}
            </span>
          </span>
          <span className="block text-sm leading-relaxed text-muted-foreground">{entry.lead}</span>
        </span>
        <ChevronDown
          className={cn(
            "mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-180" : undefined,
          )}
        />
      </button>
      {open ? (
        <div className="space-y-4 border-t border-border px-4 pb-4 pt-3">
          {entry.blocks.map((block, i) => (
            <EntryBlock key={i} block={block} onJump={onJump} />
          ))}
          {seeAlso.length ? (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                See also
              </span>
              {seeAlso.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onJump(t.id)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-medium transition-colors hover:opacity-80",
                    PART_ACCENT[t.part].chip,
                  )}
                >
                  {t.title}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

interface SectionGroup {
  part: ManualPart;
  section: string;
  entries: ManualEntry[];
}

function groupEntries(entries: ManualEntry[]): { part: (typeof PARTS)[number]; sections: SectionGroup[] }[] {
  return PARTS.map((part) => {
    const inPart = entries.filter((e) => e.part === part.id);
    const bySection = new Map<string, ManualEntry[]>();
    for (const e of inPart) {
      const list = bySection.get(e.section) ?? [];
      list.push(e);
      bySection.set(e.section, list);
    }
    const sections = [...bySection.entries()]
      .sort((a, b) => sectionOrder(part.id, a[0]) - sectionOrder(part.id, b[0]))
      .map(([section, list]) => ({ part: part.id, section, entries: list }));
    return { part, sections };
  }).filter((g) => g.sections.length > 0);
}

export function FieldManualWorkspace() {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = React.useState("");
  const [openIds, setOpenIds] = React.useState<Set<string>>(() => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    return id && ENTRY_BY_ID.has(id) ? new Set([id]) : new Set();
  });

  const jumpTo = React.useCallback(
    (id: string) => {
      setOpenIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setQuery("");
      navigate(`${location.pathname}#${id}`, { replace: false });
      window.setTimeout(() => {
        document.getElementById(`entry-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    },
    [location.pathname, navigate],
  );

  // Deep link: open + scroll to the hash entry on load and on hash change.
  React.useEffect(() => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!id || !ENTRY_BY_ID.has(id)) return;
    setOpenIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    window.setTimeout(() => {
      document.getElementById(`entry-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }, [location.hash]);

  const trimmed = query.trim().toLowerCase();
  const visible = React.useMemo(() => {
    if (!trimmed) return ALL_ENTRIES;
    return ALL_ENTRIES.filter((e) => HAYSTACKS.get(e.id)?.includes(trimmed));
  }, [trimmed]);

  const grouped = React.useMemo(() => groupEntries(visible), [visible]);

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const expandAll = () => setOpenIds(new Set(visible.map((e) => e.id)));
  const collapseAll = () => setOpenIds(new Set());

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Field manual"
        title="Tax Resolution Sales — the Field Manual"
        description="The craft, written down: the script, every objection and its play, the strategies that advance a call, and the psychology underneath — cross-linked so one question leads to the next. Read it between calls; keep it open during them."
        actions={
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <BookOpen className="h-3.5 w-3.5" />
            {ALL_ENTRIES.length} entries
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full max-w-md">
          <Input
            leadingIcon={<Search />}
            placeholder="Search everything — “think about it”, boomerang, CP504, Voss…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={expandAll}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronsUpDown className="h-3.5 w-3.5" /> Expand all
        </button>
        <button
          type="button"
          onClick={collapseAll}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronsDownUp className="h-3.5 w-3.5" /> Collapse all
        </button>
        {trimmed ? (
          <span className="text-xs text-muted-foreground">
            {visible.length} match{visible.length === 1 ? "" : "es"}
          </span>
        ) : null}
      </div>

      <div className="flex gap-8">
        {/* TOC — hidden on small screens */}
        <nav
          aria-label="Manual contents"
          className="sticky top-6 hidden max-h-[calc(100vh-6rem)] w-64 shrink-0 space-y-5 self-start overflow-y-auto pr-2 lg:block"
        >
          {groupEntries(ALL_ENTRIES).map(({ part, sections }) => (
            <div key={part.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", PART_ACCENT[part.id].dot)} />
                <span className="text-xs font-semibold text-foreground">{part.title}</span>
              </div>
              {sections.map((s) => (
                <div key={s.section} className="space-y-1 pl-4">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {sectionTitle(s.part, s.section)}
                  </div>
                  {s.entries.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => jumpTo(e.id)}
                      className="block w-full truncate text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                      title={e.title}
                    >
                      {e.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </nav>

        {/* Entries */}
        <div className="min-w-0 flex-1 space-y-8">
          {grouped.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing matches “{query}”. Try a shorter phrase — or the words the prospect actually said.
            </p>
          ) : null}
          {grouped.map(({ part, sections }) => (
            <div key={part.id} className="space-y-4">
              <div className="space-y-1">
                <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
                  <span className={cn("h-2.5 w-2.5 rounded-full", PART_ACCENT[part.id].dot)} />
                  {part.title}
                </h3>
                {!trimmed ? (
                  <p className="max-w-2xl text-sm text-muted-foreground">{part.blurb}</p>
                ) : null}
              </div>
              {sections.map((s) => (
                <div key={s.section} className="space-y-2">
                  <div className="pt-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {sectionTitle(s.part, s.section)}
                  </div>
                  {s.entries.map((e) => (
                    <EntryCard
                      key={e.id}
                      entry={e}
                      open={openIds.has(e.id)}
                      onToggle={() => toggle(e.id)}
                      onJump={jumpTo}
                    />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
