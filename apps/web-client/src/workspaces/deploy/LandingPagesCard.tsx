import * as React from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  Globe,
  GripVertical,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { StatusPill } from "@/components/ui/StatusPill";
import { cn } from "@/lib/utils/cn";
import {
  useLandingPagesPending,
  type LandingPagePendingRow,
} from "@/lib/api/queries/landing-pages";
import { LandingPagePreviewSheet } from "./LandingPagePreviewSheet";

// ─────────────────────────────────────────────────────────────────────
// Landing Pages — structured prompt composer (mockup)
// ─────────────────────────────────────────────────────────────────────
//
// The operator fills in **six sections** of structured inputs. Behind
// the scenes the backend assembles them into ONE logical prompt for
// Claude, with the boring scaffolding pre-written and the operator's
// words slotted into the right slots. This is the design intent the
// user called out: "it needs to feel like a tool" — not a freeform
// chat box.
//
// Sections:
//   1. Brand & basics       — subject, audience, CTA, brand picker
//   2. Design language      — visual mood, color, density, imagery
//   3. Copy voice           — tone, reading level, forbidden/required phrases
//   4. Form construction    — operator-built fields w/ steps. Submit
//                             payload stays locked to {name, email, phone}
//                             so the inbound webhook contract is stable;
//                             all other questions are presentation-only
//                             and get stamped on the payload as metadata.
//   5. Motion + animations  — entry, transitions, interaction, speed
//   6. Free-form notes      — escape hatch
//
// The composer offers a "Show composed prompt" toggle so the operator
// can see exactly what gets sent to Claude — transparency without
// freeform chaos.

// ── Inline Textarea (no Textarea in components/ui/Input.tsx) ───
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm shadow-sm transition-colors focus-visible:border-ring",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";

// ── Types ──────────────────────────────────────────────────────
type Brand = "tag" | "wynn";

type VisualMood =
  | "authoritative"
  | "friendly"
  | "urgent"
  | "premium"
  | "editorial"
  | "playful";
type Density = "roomy" | "balanced" | "dense";
type Imagery = "photographic" | "illustrated" | "graphic" | "mixed";

type Voice = "plainspoken" | "insider" | "empathetic" | "professional" | "punchy";
type ReadingLevel = "conversational" | "standard" | "technical";

type FieldType =
  | "short-text"
  | "long-text"
  | "number"
  | "select"
  | "radio"
  | "multi-select"
  | "slider"
  | "yes-no"
  | "card-grid"; // big visual selector tiles
type LockedField = "name" | "email" | "phone";

interface FormField {
  id: string;
  type: FieldType;
  label: string;
  options: string; // comma-separated for select/radio/multi-select/card-grid
  step: number; // 1-indexed
  required: boolean;
  locked?: LockedField; // name/email/phone — type + label can't be edited
  postsToBackend: boolean; // true for locked contact fields, false by default for others
}

type MotionEntry = "none" | "soft-fade" | "slide-up" | "stagger" | "hero-zoom";
type MotionSection = "none" | "soft-fade" | "slide" | "crossfade";
type MotionInteraction = "none" | "hover-scale" | "card-lift" | "button-bloom";
type MotionSpeed = "subtle" | "standard" | "bold";

interface ComposerDraft {
  // Brand & basics
  brand: Brand;
  slug: string;
  subject: string;
  audience: string;
  cta: string;
  bareNav: boolean;

  // Design language
  visualMood: VisualMood;
  colorLeaning: string;
  density: Density;
  imagery: Imagery;
  designNotes: string;

  // Copy voice
  voice: Voice;
  readingLevel: ReadingLevel;
  forbiddenPhrases: string;
  requiredPhrases: string;
  voiceNotes: string;

  // Form construction
  fields: FormField[];
  stepCount: number;

  // Motion
  motionEntry: MotionEntry;
  motionSection: MotionSection;
  motionInteraction: MotionInteraction;
  motionSpeed: MotionSpeed;
  motionNotes: string;

  // Free-form
  freeFormNotes: string;
}

interface ShippedPage {
  id: string;
  brand: Brand;
  slug: string;
  liveUrl: string;
  commitSha: string;
  shippedAt: string;
}

// ── Label maps ──────────────────────────────────────────────────
const BRAND_LABEL: Record<Brand, string> = { tag: "TAG", wynn: "Wynn" };
const BRAND_TONE: Record<Brand, "info" | "accent"> = {
  tag: "info",
  wynn: "accent",
};

const VISUAL_MOOD: Record<VisualMood, string> = {
  authoritative: "Authoritative",
  friendly: "Friendly",
  urgent: "Urgent",
  premium: "Premium",
  editorial: "Editorial",
  playful: "Playful",
};
const DENSITY: Record<Density, string> = {
  roomy: "Roomy (lots of whitespace)",
  balanced: "Balanced (default)",
  dense: "Dense (more content visible)",
};
const IMAGERY: Record<Imagery, string> = {
  photographic: "Photographic",
  illustrated: "Illustrated",
  graphic: "Graphic / geometric",
  mixed: "Mixed",
};
const VOICE: Record<Voice, string> = {
  plainspoken: "Plainspoken",
  insider: "Insider / expert",
  empathetic: "Empathetic",
  professional: "Professional",
  punchy: "Punchy / direct",
};
const READING_LEVEL: Record<ReadingLevel, string> = {
  conversational: "Conversational (~8th grade)",
  standard: "Standard (~11th grade)",
  technical: "Technical / specialist",
};
const FIELD_TYPE: Record<FieldType, string> = {
  "short-text": "Short text",
  "long-text": "Long text",
  number: "Number",
  select: "Dropdown select",
  radio: "Radio group",
  "multi-select": "Multi-select",
  slider: "Slider",
  "yes-no": "Yes / No",
  "card-grid": "Card grid (visual tiles)",
};
const NEEDS_OPTIONS: Set<FieldType> = new Set([
  "select",
  "radio",
  "multi-select",
  "card-grid",
]);

const MOTION_ENTRY: Record<MotionEntry, string> = {
  none: "None",
  "soft-fade": "Soft fade",
  "slide-up": "Slide up",
  stagger: "Staggered",
  "hero-zoom": "Hero zoom-in",
};
const MOTION_SECTION: Record<MotionSection, string> = {
  none: "None",
  "soft-fade": "Soft fade",
  slide: "Slide",
  crossfade: "Crossfade",
};
const MOTION_INTERACTION: Record<MotionInteraction, string> = {
  none: "None",
  "hover-scale": "Hover scale",
  "card-lift": "Card lift",
  "button-bloom": "Button bloom",
};
const MOTION_SPEED: Record<MotionSpeed, string> = {
  subtle: "Subtle (~150ms)",
  standard: "Standard (~250ms)",
  bold: "Bold (~400ms)",
};

// ── Helpers ────────────────────────────────────────────────────
function slugify(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function lockedFieldFor(locked: LockedField): FormField {
  return {
    id: `locked-${locked}`,
    type: "short-text",
    label: locked === "name" ? "Full name" : locked[0].toUpperCase() + locked.slice(1),
    options: "",
    step: 99, // pushed to final step
    required: true,
    locked,
    postsToBackend: true,
  };
}

// Composes a single Claude prompt from the structured fields. This is
// the "preset scaffolding + operator words in the slots" assembly.
function composePrompt(d: ComposerDraft): string {
  const finalStep = Math.max(d.stepCount, 1);
  function describeFields() {
    const byStep = new Map<number, FormField[]>();
    for (const f of d.fields) {
      const step = f.locked ? finalStep : Math.min(f.step, finalStep);
      const arr = byStep.get(step) || [];
      arr.push(f);
      byStep.set(step, arr);
    }
    const lines: string[] = [];
    for (let s = 1; s <= finalStep; s++) {
      const fields = byStep.get(s) || [];
      if (fields.length === 0) continue;
      lines.push(`  Step ${s}:`);
      for (const f of fields) {
        const required = f.required ? " (required)" : "";
        const opts =
          NEEDS_OPTIONS.has(f.type) && f.options.trim()
            ? ` — options: [${f.options}]`
            : "";
        const postsNote = f.locked
          ? " [posts to backend]"
          : f.postsToBackend
            ? " [posts to backend as metadata]"
            : " [presentation-only, NOT posted]";
        lines.push(
          `    • ${f.label || "(unlabeled)"} — ${FIELD_TYPE[f.type]}${required}${opts}${postsNote}`,
        );
      }
    }
    return lines.join("\n");
  }

  return `You are an expert landing-page generator for ${BRAND_LABEL[d.brand]} (one of two tax-relief brands operated by the same parent). Output strictly matches the JSON tool schema you've been given. Do NOT generate code — only structured content; the post-processor renders the JSX.

== SUBJECT ==
${d.subject || "(operator left blank)"}

== AUDIENCE ==
${d.audience || "(operator left blank)"}

== CTA ==
${d.cta || "Get my free qualification call"}

== DESIGN LANGUAGE ==
Visual mood: ${VISUAL_MOOD[d.visualMood]}
Color leaning: ${d.colorLeaning || "(brand defaults)"}
Density: ${DENSITY[d.density]}
Imagery direction: ${IMAGERY[d.imagery]}
Notes: ${d.designNotes || "(none)"}

== COPY VOICE ==
Voice: ${VOICE[d.voice]}
Reading level: ${READING_LEVEL[d.readingLevel]}
Forbidden phrases: ${d.forbiddenPhrases || "(none)"}
Required phrases: ${d.requiredPhrases || "(none)"}
Notes: ${d.voiceNotes || "(none)"}

== FORM CONSTRUCTION (PRESENTATION) ==
Steps: ${finalStep}
${describeFields() || "  (no fields configured)"}

IMPORTANT: the lead form POSTS only name, email, phone to the backend webhook (the existing /lead-contact contract). Any other fields here are presentation-only — they qualify visually but get stamped on the payload as metadata if marked "[posts to backend as metadata]", otherwise discarded after submit. Do not redesign the post payload.

== MOTION & ANIMATION ==
Entry: ${MOTION_ENTRY[d.motionEntry]}
Section transitions: ${MOTION_SECTION[d.motionSection]}
Interaction motion: ${MOTION_INTERACTION[d.motionInteraction]}
Speed: ${MOTION_SPEED[d.motionSpeed]}
Notes: ${d.motionNotes || "(none)"}

== LAYOUT ==
${d.bareNav ? "Bare route — no Navbar, no Footer." : "Full route — Navbar + Footer wrap the page."}

== OPERATOR FREE-FORM NOTES ==
${d.freeFormNotes || "(none)"}

== OUTPUT CONTRACT ==
Return JSON matching the LandingPageDraft schema:
  • headline (string, <= 90 chars)
  • subhead (string, <= 240 chars)
  • bullets (string[], 3-5 items, <= 90 chars each)
  • sections (array of { title, body[] }) — 3-5 supporting blocks below the form
  • faq (array of { q, a }) — 3-5 items, plain conversational answers
  • imagePrompt (string) — a topic-specific concept for gpt-image-2 (NO text, NO faces, photographic editorial)
  • seoTitle (string, <= 60 chars)
  • seoDescription (string, <= 155 chars)
  • jsonLd (object) — a JSON-LD WebPage + LocalBusiness or Service schema graph

The page renderer takes care of:
  - the reusable LeadForm component + your custom presentation fields
  - react-helmet integration (seoTitle, seoDescription)
  - JSON-LD <script type="application/ld+json"> injection
  - framer-motion wrappers per the motion section above
  - tailwind class application per the design section
`;
}

// ── Mock data ──────────────────────────────────────────────────
const MOCK_SHIPPED: ShippedPage[] = [
  {
    id: "lp-shipped-1",
    brand: "tag",
    slug: "offer-in-compromise-quiz",
    liveUrl: "https://www.taxadvocategroup.com/offer-in-compromise-quiz",
    commitSha: "9991144",
    shippedAt: "2026-05-11T16:22:00Z",
  },
];

// Sensible defaults — three locked contact fields on the final step
// and one example qualifier so the operator sees the variety.
function defaultDraft(): ComposerDraft {
  let nextId = 1;
  const mkId = () => `f-${nextId++}`;
  return {
    brand: "wynn",
    slug: "",
    subject: "",
    audience: "",
    cta: "Get my free qualification call",
    bareNav: true,

    visualMood: "authoritative",
    colorLeaning: "",
    density: "balanced",
    imagery: "photographic",
    designNotes: "",

    voice: "plainspoken",
    readingLevel: "conversational",
    forbiddenPhrases: "",
    requiredPhrases: "",
    voiceNotes: "",

    fields: [
      {
        id: mkId(),
        type: "card-grid",
        label: "What kind of tax problem are you facing?",
        options:
          "IRS debt, State tax debt, Unfiled returns, Wage garnishment, Bank levy, Audit defense",
        step: 1,
        required: true,
        postsToBackend: true,
      },
      {
        id: mkId(),
        type: "slider",
        label: "How much do you owe (estimate)?",
        options: "",
        step: 2,
        required: true,
        postsToBackend: true,
      },
      lockedFieldFor("name"),
      lockedFieldFor("email"),
      lockedFieldFor("phone"),
    ],
    stepCount: 3,

    motionEntry: "stagger",
    motionSection: "soft-fade",
    motionInteraction: "card-lift",
    motionSpeed: "standard",
    motionNotes: "",

    freeFormNotes: "",
  };
}

// ── Collapsible section wrapper ─────────────────────────────────
function Section({
  title,
  hint,
  defaultOpen = true,
  children,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-muted/50"
      >
        <div className="flex flex-col">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
            {title}
          </span>
          {hint ? (
            <span className="text-[11px] font-normal text-muted-foreground">
              {hint}
            </span>
          ) : null}
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {open ? <div className="border-t border-border/60 p-4">{children}</div> : null}
    </div>
  );
}

// ── Field row in the form builder ───────────────────────────────
function FieldRow({
  field,
  stepCount,
  onChange,
  onRemove,
  onMove,
}: {
  field: FormField;
  stepCount: number;
  onChange: (next: FormField) => void;
  onRemove: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const isLocked = Boolean(field.locked);
  return (
    <div
      className={cn(
        "rounded-md border p-3 text-xs",
        isLocked
          ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900/50 dark:bg-emerald-950/20"
          : "border-border bg-card",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onMove("up")}
          title="Move up"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1">
          <Input
            value={field.label}
            placeholder="Field label"
            disabled={isLocked}
            onChange={(e) => onChange({ ...field, label: e.target.value })}
            className="h-8"
          />
        </div>
        <div className="w-40">
          <Select
            value={field.type}
            disabled={isLocked}
            onChange={(e) =>
              onChange({ ...field, type: e.target.value as FieldType })
            }
            className="h-8"
          >
            {(Object.keys(FIELD_TYPE) as FieldType[]).map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE[t]}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-16">
          <Select
            value={isLocked ? "final" : String(field.step)}
            disabled={isLocked}
            onChange={(e) =>
              onChange({ ...field, step: Number(e.target.value) || 1 })
            }
            className="h-8"
            title="Which step this field appears on"
          >
            {Array.from({ length: stepCount }, (_, i) => i + 1).map((s) => (
              <option key={s} value={s}>
                {`Step ${s}`}
              </option>
            ))}
            {isLocked ? <option value="final">Final</option> : null}
          </Select>
        </div>
        {!isLocked ? (
          <button
            type="button"
            onClick={onRemove}
            className="text-muted-foreground hover:text-rose-600"
            title="Remove field"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <StatusPill tone="success" dotted>
            posts
          </StatusPill>
        )}
      </div>

      {NEEDS_OPTIONS.has(field.type) ? (
        <div className="mt-2">
          <Label className="text-[10px]">Options (comma-separated)</Label>
          <Input
            value={field.options}
            placeholder="Option A, Option B, Option C"
            onChange={(e) => onChange({ ...field, options: e.target.value })}
            className="h-8"
          />
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={field.required}
            disabled={isLocked}
            onChange={(e) =>
              onChange({ ...field, required: e.target.checked })
            }
          />
          Required
        </label>
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={field.postsToBackend}
            disabled={isLocked}
            onChange={(e) =>
              onChange({ ...field, postsToBackend: e.target.checked })
            }
          />
          Stamp answer onto webhook payload
        </label>
        {isLocked ? (
          <span className="text-[10px] uppercase tracking-wider text-emerald-700">
            Locked — contract field
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ── Pending page preview row (rich) ────────────────────────────
function PendingPagePreview({
  row,
  onApprove,
  onReject,
}: {
  row: LandingPagePendingRow;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [showSections, setShowSections] = React.useState(false);
  const [showFaq, setShowFaq] = React.useState(false);
  const [showPrompt, setShowPrompt] = React.useState(false);
  const [showSeo, setShowSeo] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const draft = row.pageDraft;
  const composer = row.composerDraft as
    | Record<string, unknown>
    | null;
  const brand = (row.brand || "wynn") as Brand;
  const fields =
    Array.isArray((composer as { fields?: unknown[] } | null)?.fields)
      ? ((composer as { fields: unknown[] }).fields as Array<{
          step: number;
          label: string;
          type: string;
          locked?: string;
          postsToBackend?: boolean;
          options?: string[];
        }>)
      : [];
  const stepCount =
    typeof (composer as { steps?: unknown } | null)?.steps === "number"
      ? ((composer as { steps: number }).steps as number)
      : 1;

  return (
    <li className="rounded-lg border border-border bg-card p-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={BRAND_TONE[brand]} dotted>
          {BRAND_LABEL[brand]}
        </StatusPill>
        <span className="font-mono text-[10px] text-muted-foreground">
          /{row.slug}
        </span>
        {row.claudeModel ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            · {row.claudeModel}
          </span>
        ) : null}
        {row.claudeUsage ? (
          <span className="text-[10px] text-muted-foreground">
            · in={row.claudeUsage.input_tokens ?? "?"} out=
            {row.claudeUsage.output_tokens ?? "?"}
          </span>
        ) : null}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {row.generatedAt
            ? new Date(row.generatedAt).toLocaleString()
            : ""}
        </span>
      </div>

      {/* Hero + above-fold */}
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-[260px_1fr]">
        <div className="overflow-hidden rounded-md border border-border bg-muted">
          {row.heroImageUrl ? (
            <img
              src={row.heroImageUrl}
              alt=""
              className="aspect-square h-auto w-full object-cover"
            />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center">
              <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
            </div>
          )}
        </div>
        <div>
          {draft?.headline ? (
            <h3 className="text-base font-semibold leading-snug">
              {draft.headline}
            </h3>
          ) : null}
          {draft?.subhead ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {draft.subhead}
            </p>
          ) : null}
          {Array.isArray(draft?.bullets) && draft.bullets.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs">
              {draft.bullets.map((b, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {/* Form preview */}
          {fields.length > 0 ? (
            <div className="mt-3 rounded-md border border-border/60 bg-muted/40 p-2 text-[11px]">
              <div className="mb-1 font-semibold text-muted-foreground">
                Form ({stepCount} step{stepCount === 1 ? "" : "s"} ·{" "}
                {fields.length} fields)
              </div>
              <ol className="space-y-1">
                {fields.map((f, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      step {f.step}
                    </span>
                    <span className="flex-1">{f.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {f.type}
                    </span>
                    {f.locked ? (
                      <StatusPill tone="success" dotted>
                        posts
                      </StatusPill>
                    ) : f.postsToBackend ? (
                      <StatusPill tone="info" dotted>
                        meta
                      </StatusPill>
                    ) : (
                      <StatusPill tone="neutral" dotted>
                        ui only
                      </StatusPill>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      </div>

      {/* Collapsible sections */}
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
        <button
          type="button"
          onClick={() => setShowSections((v) => !v)}
          className="rounded-md border border-border bg-muted/40 px-2 py-1 text-left hover:bg-muted"
        >
          {showSections ? "▼" : "▶"} Body sections ({draft?.sections?.length ?? 0})
        </button>
        <button
          type="button"
          onClick={() => setShowFaq((v) => !v)}
          className="rounded-md border border-border bg-muted/40 px-2 py-1 text-left hover:bg-muted"
        >
          {showFaq ? "▼" : "▶"} FAQ ({draft?.faq?.length ?? 0})
        </button>
        <button
          type="button"
          onClick={() => setShowSeo((v) => !v)}
          className="rounded-md border border-border bg-muted/40 px-2 py-1 text-left hover:bg-muted"
        >
          {showSeo ? "▼" : "▶"} SEO + JSON-LD
        </button>
        <button
          type="button"
          onClick={() => setShowPrompt((v) => !v)}
          className="rounded-md border border-border bg-muted/40 px-2 py-1 text-left hover:bg-muted"
        >
          {showPrompt ? "▼" : "▶"} Image prompt
        </button>
      </div>

      {showSections && Array.isArray(draft?.sections) ? (
        <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
          {draft.sections.map((s, i) => (
            <div key={i}>
              <div className="font-semibold">{s.title}</div>
              {Array.isArray(s.body)
                ? s.body.map((p, j) => (
                    <p key={j} className="mt-1 text-muted-foreground">
                      {p}
                    </p>
                  ))
                : null}
            </div>
          ))}
        </div>
      ) : null}

      {showFaq && Array.isArray(draft?.faq) ? (
        <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
          {draft.faq.map((f, i) => (
            <div key={i}>
              <div className="font-semibold">Q: {f.q}</div>
              <p className="mt-0.5 text-muted-foreground">A: {f.a}</p>
            </div>
          ))}
        </div>
      ) : null}

      {showSeo ? (
        <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
          <div>
            <span className="font-mono text-[10px] text-muted-foreground">title:</span>{" "}
            {draft?.seoTitle}
          </div>
          <div>
            <span className="font-mono text-[10px] text-muted-foreground">description:</span>{" "}
            {draft?.seoDescription}
          </div>
          <pre className="max-h-40 overflow-auto rounded bg-background p-2 font-mono text-[10px]">
            {draft?.jsonLd ? JSON.stringify(draft.jsonLd, null, 2) : ""}
          </pre>
        </div>
      ) : null}

      {showPrompt ? (
        <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 text-[11px] text-muted-foreground">
          {draft?.imagePrompt}
        </pre>
      ) : null}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3 text-xs">
        <span className="font-mono text-[10px] text-muted-foreground">
          branch:{" "}
          <span className="text-foreground">landing/{row.slug}</span>
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPreviewOpen(true)}
          >
            <Eye className="h-3.5 w-3.5" />
            Preview page
          </Button>
          <Button size="sm" variant="ghost">
            <Globe className="h-3.5 w-3.5" />
            Preview branch
          </Button>
          <Button size="sm" variant="secondary">
            <RefreshCw className="h-3.5 w-3.5" />
            Regenerate w/ tweaks
          </Button>
          <Button size="sm" variant="destructive" onClick={onReject}>
            <Trash2 className="h-3.5 w-3.5" />
            Reject
          </Button>
          <Button size="sm" variant="primary" onClick={onApprove}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            Approve + deploy
          </Button>
        </div>
      </div>

      {/* Side-pane preview */}
      <LandingPagePreviewSheet
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        row={row}
      />
    </li>
  );
}

// ── Main card ──────────────────────────────────────────────────
export function LandingPagesCard() {
  const [draft, setDraft] = React.useState<ComposerDraft>(defaultDraft());
  // Pull real pending rows from the backend (populated by
  // scripts/test-landing-page-end-to-end.js or the full pipeline once
  // wired). Mock data left in the file for reference.
  const pendingQuery = useLandingPagesPending();
  const realPending = pendingQuery.data ?? [];
  const [shipped] = React.useState<ShippedPage[]>(MOCK_SHIPPED);
  const [generating, setGenerating] = React.useState(false);
  const [showPrompt, setShowPrompt] = React.useState(false);

  // Auto-slug from subject until operator manually edits the slug.
  const slugManuallyEdited = React.useRef(false);
  function onSubjectChange(value: string) {
    setDraft((d) => ({
      ...d,
      subject: value,
      slug: slugManuallyEdited.current ? d.slug : slugify(value),
    }));
  }
  function onSlugChange(value: string) {
    slugManuallyEdited.current = true;
    setDraft((d) => ({ ...d, slug: slugify(value) }));
  }

  // Field builder ops
  function addField() {
    setDraft((d) => {
      const id = `f-${Date.now()}`;
      const newField: FormField = {
        id,
        type: "select",
        label: "",
        options: "",
        step: 1,
        required: false,
        postsToBackend: false,
      };
      // Insert before the locked rows so locked stay at the end.
      const lockedIdx = d.fields.findIndex((f) => f.locked);
      const nextFields =
        lockedIdx === -1
          ? [...d.fields, newField]
          : [
              ...d.fields.slice(0, lockedIdx),
              newField,
              ...d.fields.slice(lockedIdx),
            ];
      return { ...d, fields: nextFields };
    });
  }
  function updateField(id: string, next: FormField) {
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f) => (f.id === id ? next : f)),
    }));
  }
  function removeField(id: string) {
    setDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.id !== id) }));
  }
  function moveField(id: string, dir: "up" | "down") {
    setDraft((d) => {
      const idx = d.fields.findIndex((f) => f.id === id);
      if (idx < 0) return d;
      const target = dir === "up" ? idx - 1 : idx + 1;
      if (target < 0 || target >= d.fields.length) return d;
      if (d.fields[target].locked) return d; // don't cross into locked block
      const copy = [...d.fields];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return { ...d, fields: copy };
    });
  }

  async function onGenerate() {
    if (!draft.subject.trim() || !draft.slug.trim()) return;
    setGenerating(true);
    // Mock — pipeline backend not wired yet. When wired this will hit
    // POST /api/commands/landing-pages/generate which spawns the
    // script we ran by hand earlier, then refetches the pending list.
    await new Promise((r) => setTimeout(r, 1200));
    setGenerating(false);
    await pendingQuery.refetch();
    setDraft((d) => ({
      ...d,
      subject: "",
      audience: "",
      slug: "",
      freeFormNotes: "",
    }));
    slugManuallyEdited.current = false;
  }

  async function onApprove(_slug: string) {
    // Mock — would hit POST /api/commands/landing-pages/:slug/approve.
    await pendingQuery.refetch();
  }
  async function onReject(_slug: string) {
    // Mock — would hit DELETE /api/commands/landing-pages/:slug.
    await pendingQuery.refetch();
  }

  const composedPrompt = React.useMemo(() => composePrompt(draft), [draft]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Landing Pages
          </span>
          <span className="text-[10px] font-normal text-muted-foreground">
            structured prompt composer · branch + approve · auto-deploy
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4 pt-0">
        {/* ── 1. Brand & basics ──────────────────────────────────── */}
        <Section
          title="1. Brand & basics"
          hint="Who the page is for and what it's about."
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Brand</Label>
              <div className="flex gap-2">
                {(["tag", "wynn"] as Brand[]).map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, brand: b }))}
                    className={cn(
                      "flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                      draft.brand === b
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {BRAND_LABEL[b]}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="lp-slug">URL slug</Label>
              <Input
                id="lp-slug"
                value={draft.slug}
                placeholder="auto-from-subject"
                onChange={(e) => onSlugChange(e.target.value)}
              />
            </div>

            <div className="md:col-span-2 space-y-1">
              <Label htmlFor="lp-subject">Subject</Label>
              <Textarea
                id="lp-subject"
                rows={2}
                placeholder="What is this landing page about?"
                value={draft.subject}
                onChange={(e) => onSubjectChange(e.target.value)}
              />
            </div>

            <div className="md:col-span-2 space-y-1">
              <Label htmlFor="lp-audience">Target audience</Label>
              <Input
                id="lp-audience"
                placeholder="Self-employed CA taxpayers, $10k+ IRS debt, payment plan rejected"
                value={draft.audience}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, audience: e.target.value }))
                }
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="lp-cta">CTA copy</Label>
              <Input
                id="lp-cta"
                value={draft.cta}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, cta: e.target.value }))
                }
              />
            </div>

            <div className="space-y-1">
              <Label>Layout</Label>
              <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-card px-3 text-sm">
                <input
                  type="checkbox"
                  checked={draft.bareNav}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, bareNav: e.target.checked }))
                  }
                />
                <span>Bare (no nav / footer)</span>
              </label>
            </div>
          </div>
        </Section>

        {/* ── 2. Design language ─────────────────────────────────── */}
        <Section
          title="2. Design language"
          hint="Visual mood, color, density. Claude turns this into Tailwind class choices + section composition."
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Visual mood</Label>
              <Select
                value={draft.visualMood}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    visualMood: e.target.value as VisualMood,
                  }))
                }
              >
                {(Object.keys(VISUAL_MOOD) as VisualMood[]).map((m) => (
                  <option key={m} value={m}>
                    {VISUAL_MOOD[m]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Density</Label>
              <Select
                value={draft.density}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, density: e.target.value as Density }))
                }
              >
                {(Object.keys(DENSITY) as Density[]).map((d2) => (
                  <option key={d2} value={d2}>
                    {DENSITY[d2]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Imagery direction</Label>
              <Select
                value={draft.imagery}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    imagery: e.target.value as Imagery,
                  }))
                }
              >
                {(Object.keys(IMAGERY) as Imagery[]).map((i) => (
                  <option key={i} value={i}>
                    {IMAGERY[i]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Color leaning (free text)</Label>
              <Input
                value={draft.colorLeaning}
                placeholder='"warm navy + cream" / blank = brand defaults'
                onChange={(e) =>
                  setDraft((d) => ({ ...d, colorLeaning: e.target.value }))
                }
              />
            </div>
            <div className="md:col-span-2 space-y-1">
              <Label>Design notes (anything else?)</Label>
              <Textarea
                rows={2}
                value={draft.designNotes}
                placeholder="e.g. 'lean editorial like a NYT business piece, big hero, single accent color'"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, designNotes: e.target.value }))
                }
              />
            </div>
          </div>
        </Section>

        {/* ── 3. Copy voice ──────────────────────────────────────── */}
        <Section
          title="3. Copy voice"
          hint="How the words should read."
          defaultOpen={false}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Voice</Label>
              <Select
                value={draft.voice}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, voice: e.target.value as Voice }))
                }
              >
                {(Object.keys(VOICE) as Voice[]).map((v) => (
                  <option key={v} value={v}>
                    {VOICE[v]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Reading level</Label>
              <Select
                value={draft.readingLevel}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    readingLevel: e.target.value as ReadingLevel,
                  }))
                }
              >
                {(Object.keys(READING_LEVEL) as ReadingLevel[]).map((r) => (
                  <option key={r} value={r}>
                    {READING_LEVEL[r]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Forbidden phrases</Label>
              <Input
                value={draft.forbiddenPhrases}
                placeholder='e.g. "pennies on the dollar"'
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    forbiddenPhrases: e.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Required phrases</Label>
              <Input
                value={draft.requiredPhrases}
                placeholder='e.g. "Currently Not Collectible"'
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    requiredPhrases: e.target.value,
                  }))
                }
              />
            </div>
            <div className="md:col-span-2 space-y-1">
              <Label>Voice notes</Label>
              <Textarea
                rows={2}
                value={draft.voiceNotes}
                placeholder="e.g. 'first-person, talk to the reader like a calm advisor, no jargon, no hype'"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, voiceNotes: e.target.value }))
                }
              />
            </div>
          </div>
        </Section>

        {/* ── 4. Form construction ───────────────────────────────── */}
        <Section
          title="4. Form construction"
          hint="Build the visible form. Submit payload stays locked to name/email/phone — anything else is presentation that can stamp metadata."
        >
          <div className="mb-3 flex items-center gap-3 text-xs">
            <Label className="m-0">Steps:</Label>
            <Input
              type="number"
              min={1}
              max={5}
              value={draft.stepCount}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  stepCount: Math.max(
                    1,
                    Math.min(5, Number(e.target.value) || 1),
                  ),
                }))
              }
              className="h-8 w-20"
            />
            <span className="text-muted-foreground">
              ({draft.fields.length} field{draft.fields.length === 1 ? "" : "s"} total)
            </span>
          </div>

          <div className="space-y-2">
            {draft.fields.map((f) => (
              <FieldRow
                key={f.id}
                field={f}
                stepCount={draft.stepCount}
                onChange={(next) => updateField(f.id, next)}
                onRemove={() => removeField(f.id)}
                onMove={(dir) => moveField(f.id, dir)}
              />
            ))}
          </div>

          <Button
            size="sm"
            variant="secondary"
            onClick={addField}
            className="mt-3"
          >
            <Plus className="h-3.5 w-3.5" />
            Add field
          </Button>

          <p className="mt-3 rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">
            <strong>Posting contract:</strong> name + email + phone always
            POST to <span className="font-mono">/lead-contact</span> on the
            inbound gateway (existing webhook, no changes needed). For
            qualification fields, toggle "Stamp answer onto webhook
            payload" if you want the answer included as metadata — leave it
            off to make the field purely presentational.
          </p>
        </Section>

        {/* ── 5. Motion & animations ─────────────────────────────── */}
        <Section
          title="5. Motion & animations"
          hint="Page entry, section transitions, interaction feedback."
          defaultOpen={false}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Entry animation</Label>
              <Select
                value={draft.motionEntry}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    motionEntry: e.target.value as MotionEntry,
                  }))
                }
              >
                {(Object.keys(MOTION_ENTRY) as MotionEntry[]).map((m) => (
                  <option key={m} value={m}>
                    {MOTION_ENTRY[m]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Section transitions</Label>
              <Select
                value={draft.motionSection}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    motionSection: e.target.value as MotionSection,
                  }))
                }
              >
                {(Object.keys(MOTION_SECTION) as MotionSection[]).map((m) => (
                  <option key={m} value={m}>
                    {MOTION_SECTION[m]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Interaction motion</Label>
              <Select
                value={draft.motionInteraction}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    motionInteraction: e.target.value as MotionInteraction,
                  }))
                }
              >
                {(Object.keys(MOTION_INTERACTION) as MotionInteraction[]).map(
                  (m) => (
                    <option key={m} value={m}>
                      {MOTION_INTERACTION[m]}
                    </option>
                  ),
                )}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Motion speed</Label>
              <Select
                value={draft.motionSpeed}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    motionSpeed: e.target.value as MotionSpeed,
                  }))
                }
              >
                {(Object.keys(MOTION_SPEED) as MotionSpeed[]).map((m) => (
                  <option key={m} value={m}>
                    {MOTION_SPEED[m]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="md:col-span-2 space-y-1">
              <Label>Motion notes</Label>
              <Textarea
                rows={2}
                value={draft.motionNotes}
                placeholder="e.g. 'hero number counts up on viewport entry, then trust badges stagger in'"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, motionNotes: e.target.value }))
                }
              />
            </div>
          </div>
        </Section>

        {/* ── 6. Free-form notes ─────────────────────────────────── */}
        <Section
          title="6. Anything else"
          hint="Escape hatch — anything not covered above."
          defaultOpen={false}
        >
          <Textarea
            rows={3}
            value={draft.freeFormNotes}
            placeholder="Free-form direction. Reference competitors, attach inspiration links, mention edge cases…"
            onChange={(e) =>
              setDraft((d) => ({ ...d, freeFormNotes: e.target.value }))
            }
          />
        </Section>

        {/* ── Compose / preview / generate ───────────────────────── */}
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[11px] text-muted-foreground">
              Sections compose into one structured prompt → Claude returns
              JSON → renderer builds JSX + helmet meta + JSON-LD + framer
              motion + hero image. Commits on{" "}
              <span className="font-mono">
                landing/{draft.slug || "<slug>"}
              </span>{" "}
              of the {BRAND_LABEL[draft.brand]} repo.
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowPrompt((v) => !v)}
              >
                <Eye className="h-3.5 w-3.5" />
                {showPrompt ? "Hide" : "Show"} composed prompt
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={onGenerate}
                disabled={
                  generating || !draft.subject.trim() || !draft.slug.trim()
                }
              >
                {generating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {generating ? "Generating…" : "Generate page"}
              </Button>
            </div>
          </div>
          {showPrompt ? (
            <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background p-3 text-[11px] leading-relaxed text-muted-foreground">
              {composedPrompt}
            </pre>
          ) : null}
        </div>

        {/* ── Pending review ─────────────────────────────────────── */}
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Pending review ({realPending.length})
            </span>
            {realPending.length > 0 ? (
              <span className="text-[11px] text-muted-foreground">
                approve to merge + deploy
              </span>
            ) : null}
          </div>
          {pendingQuery.isLoading ? (
            <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              Loading…
            </p>
          ) : realPending.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              No pages waiting for review.
            </p>
          ) : (
            <ul className="space-y-4">
              {realPending.map((row) => (
                <PendingPagePreview
                  key={row.slug}
                  row={row}
                  onApprove={() => onApprove(row.slug)}
                  onReject={() => onReject(row.slug)}
                />
              ))}
            </ul>
          )}
        </section>

        {/* ── Recently shipped ───────────────────────────────────── */}
        <section>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recently shipped ({shipped.length})
          </div>
          {shipped.length === 0 ? (
            <p className="text-xs text-muted-foreground">No pages shipped yet.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {shipped.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded border border-border/60 px-3 py-2"
                >
                  <span className="inline-flex items-center gap-2">
                    <StatusPill tone={BRAND_TONE[s.brand]} dotted>
                      {BRAND_LABEL[s.brand]}
                    </StatusPill>
                    <a
                      href={s.liveUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[11px] text-primary hover:underline"
                    >
                      /{s.slug}
                    </a>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {s.commitSha}
                    </span>
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    shipped {new Date(s.shippedAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="rounded-md border border-dashed border-border p-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-semibold text-foreground">
            <XCircle className="h-3 w-3" /> Mockup
          </span>
          : composer + field builder are interactive (try toggling
          everything). Generate / approve / reject are no-ops until
          backend wiring lands.
        </div>
      </CardContent>
    </Card>
  );
}
