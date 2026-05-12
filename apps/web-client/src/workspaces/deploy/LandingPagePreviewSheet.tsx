import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { LandingPagePendingRow } from "@/lib/api/queries/landing-pages";

// ─────────────────────────────────────────────────────────────────────
// LandingPagePreviewSheet
// ─────────────────────────────────────────────────────────────────────
//
// A side-anchored Radix Dialog that slides in from the right and
// renders the generated landing page approximately the way it would
// look in production. Bare layout (no Navbar/Footer) per the operator's
// direction. Form is rendered using the composerDraft.fields config
// so the operator can click through the steps and feel the flow.
//
// This is a STATIC preview — clicking "Submit" doesn't fire the
// webhook. The intent is to evaluate look, copy, motion direction,
// and form construction before approving.

interface PreviewSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: LandingPagePendingRow;
}

type ComposerField = {
  step: number;
  label: string;
  type: string;
  locked?: string;
  postsToBackend?: boolean;
  options?: string[];
  required?: boolean;
};

function extractFields(row: LandingPagePendingRow): ComposerField[] {
  const composer = row.composerDraft as
    | { fields?: ComposerField[] }
    | null;
  return Array.isArray(composer?.fields) ? composer.fields : [];
}

function extractStepCount(row: LandingPagePendingRow): number {
  const composer = row.composerDraft as
    | { steps?: number; stepCount?: number }
    | null;
  return Math.max(1, Number(composer?.steps ?? composer?.stepCount ?? 1));
}

function extractCta(row: LandingPagePendingRow): string {
  const composer = row.composerDraft as { cta?: string } | null;
  return composer?.cta || "Continue";
}

// ── Form preview state machine ─────────────────────────────────
function FormPreview({ row }: { row: LandingPagePendingRow }) {
  const fields = extractFields(row);
  const stepCount = extractStepCount(row);
  const cta = extractCta(row);

  const [currentStep, setCurrentStep] = React.useState(1);
  const [answers, setAnswers] = React.useState<Record<string, unknown>>({});

  const fieldsForStep = fields.filter((f) =>
    f.locked ? stepCount === currentStep || currentStep === stepCount : f.step === currentStep,
  );

  const isLastStep = currentStep >= stepCount;
  const stepLabel = isLastStep ? cta : "Continue";

  function setAnswer(key: string, value: unknown) {
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  function renderField(f: ComposerField, i: number) {
    const key = `${f.locked || f.label}-${i}`;
    const value = answers[key];

    if (f.locked === "name") {
      return (
        <input
          key={key}
          type="text"
          placeholder="Your full name"
          value={String(value || "")}
          onChange={(e) => setAnswer(key, e.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-4 py-3 text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
        />
      );
    }
    if (f.locked === "email") {
      return (
        <input
          key={key}
          type="email"
          placeholder="Email address"
          value={String(value || "")}
          onChange={(e) => setAnswer(key, e.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-4 py-3 text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
        />
      );
    }
    if (f.locked === "phone") {
      return (
        <input
          key={key}
          type="tel"
          placeholder="Phone number"
          value={String(value || "")}
          onChange={(e) => setAnswer(key, e.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-4 py-3 text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
        />
      );
    }

    const type = String(f.type || "").toLowerCase();

    // Card grid — visual tile selector
    if (type.includes("card") || type.includes("grid")) {
      const options = Array.isArray(f.options) ? f.options : [];
      return (
        <div key={key} className="space-y-2">
          <label className="text-sm font-medium text-slate-700">
            {f.label}
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setAnswer(key, opt)}
                className={cn(
                  "rounded-lg border-2 px-4 py-3 text-left text-sm font-medium transition-all",
                  value === opt
                    ? "border-amber-500 bg-amber-50 text-slate-900"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-400 hover:shadow-sm",
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      );
    }

    // Slider
    if (type.includes("slider")) {
      const buckets = [
        "Under $10k",
        "$10k–$25k",
        "$25k–$50k",
        "$50k–$100k",
        "$100k+",
      ];
      const idx = typeof value === "number" ? value : 2;
      return (
        <div key={key} className="space-y-2">
          <label className="text-sm font-medium text-slate-700">{f.label}</label>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
              <span>{buckets[0]}</span>
              <span className="font-semibold text-amber-600">
                {buckets[idx]}
              </span>
              <span>{buckets[buckets.length - 1]}</span>
            </div>
            <input
              type="range"
              min={0}
              max={buckets.length - 1}
              value={idx}
              onChange={(e) => setAnswer(key, Number(e.target.value))}
              className="w-full accent-amber-500"
            />
          </div>
        </div>
      );
    }

    // Select
    if (type.includes("select") || type.includes("dropdown")) {
      const options = Array.isArray(f.options) ? f.options : [];
      return (
        <div key={key} className="space-y-2">
          <label className="text-sm font-medium text-slate-700">{f.label}</label>
          <select
            value={String(value || "")}
            onChange={(e) => setAnswer(key, e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-3 text-slate-900 focus:border-slate-900 focus:outline-none"
          >
            <option value="">Select…</option>
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      );
    }

    // Radio
    if (type.includes("radio")) {
      const options = Array.isArray(f.options) ? f.options : [];
      return (
        <div key={key} className="space-y-2">
          <label className="text-sm font-medium text-slate-700">{f.label}</label>
          <div className="space-y-1.5">
            {options.map((opt) => (
              <label
                key={opt}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 hover:border-slate-400"
              >
                <input
                  type="radio"
                  checked={value === opt}
                  onChange={() => setAnswer(key, opt)}
                  className="accent-amber-500"
                />
                <span className="text-sm text-slate-700">{opt}</span>
              </label>
            ))}
          </div>
        </div>
      );
    }

    // Yes/no
    if (type.includes("yes")) {
      return (
        <div key={key} className="space-y-2">
          <label className="text-sm font-medium text-slate-700">{f.label}</label>
          <div className="grid grid-cols-2 gap-2">
            {["Yes", "No"].map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setAnswer(key, opt)}
                className={cn(
                  "rounded-md border-2 py-2 text-sm font-medium transition-all",
                  value === opt
                    ? "border-amber-500 bg-amber-50 text-slate-900"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-400",
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      );
    }

    // Number / short-text fallback
    return (
      <div key={key} className="space-y-2">
        <label className="text-sm font-medium text-slate-700">{f.label}</label>
        <input
          type={type.includes("number") ? "number" : "text"}
          value={String(value || "")}
          onChange={(e) => setAnswer(key, e.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-4 py-3 text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
        />
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-xl ring-1 ring-slate-200 sm:p-8">
      {/* Step indicator */}
      <div className="mb-5 flex items-center gap-2">
        {Array.from({ length: stepCount }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full",
              i + 1 <= currentStep ? "bg-amber-500" : "bg-slate-200",
            )}
          />
        ))}
        <span className="ml-2 text-xs font-medium text-slate-500">
          Step {currentStep} of {stepCount}
        </span>
      </div>

      <div className="space-y-4">
        {fieldsForStep.map((f, i) => renderField(f, i))}
      </div>

      <div className="mt-6 flex items-center justify-between">
        {currentStep > 1 ? (
          <button
            type="button"
            onClick={() => setCurrentStep((s) => Math.max(1, s - 1))}
            className="text-sm font-medium text-slate-500 hover:text-slate-900"
          >
            ← Back
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => {
            if (!isLastStep) setCurrentStep((s) => s + 1);
          }}
          className="rounded-lg bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-slate-800 hover:shadow-md"
        >
          {stepLabel}
        </button>
      </div>
    </div>
  );
}

// ── FAQ accordion ──────────────────────────────────────────────
function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border-b border-slate-200 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 py-4 text-left"
      >
        <span className="text-base font-semibold text-slate-900">{q}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-slate-500" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
        )}
      </button>
      {open ? (
        <p className="pb-4 text-sm leading-relaxed text-slate-600">{a}</p>
      ) : null}
    </div>
  );
}

// ── The actual page mock ───────────────────────────────────────
function LandingPageRender({ row }: { row: LandingPagePendingRow }) {
  const draft = row.pageDraft;
  if (!draft) return null;

  return (
    <article
      className="min-h-full bg-[#f7f4ee] text-slate-900"
      style={{
        // Approximate the "warm navy + cream + gold" palette from the
        // operator's composer choices. Without compiling Tailwind
        // custom theme tokens, we use inline-fallback hex.
      }}
    >
      {/* Hero */}
      <header className="mx-auto max-w-5xl px-6 pt-8 sm:px-8 sm:pt-12">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_460px]">
          <div className="flex flex-col justify-center">
            <span className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-amber-700">
              Wynn Tax Solutions
            </span>
            <h1 className="text-3xl font-serif font-semibold leading-tight text-slate-900 sm:text-4xl">
              {draft.headline}
            </h1>
            <p className="mt-4 text-base leading-relaxed text-slate-700 sm:text-lg">
              {draft.subhead}
            </p>
            {Array.isArray(draft.bullets) && draft.bullets.length > 0 ? (
              <ul className="mt-6 space-y-2.5">
                {draft.bullets.map((b, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-3 text-[15px] text-slate-700"
                  >
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="lg:pt-4">
            <FormPreview row={row} />
          </div>
        </div>

        {/* Hero image full-width below */}
        {row.heroImageUrl ? (
          <div className="mt-12 overflow-hidden rounded-2xl shadow-lg ring-1 ring-slate-200">
            <img
              src={row.heroImageUrl}
              alt=""
              className="aspect-[5/3] w-full object-cover"
            />
          </div>
        ) : null}
      </header>

      {/* Body sections */}
      {Array.isArray(draft.sections) && draft.sections.length > 0 ? (
        <section className="mx-auto max-w-3xl px-6 py-16 sm:px-8">
          {draft.sections.map((s, i) => (
            <div key={i} className={cn("space-y-3", i > 0 && "mt-12")}>
              <h2 className="text-2xl font-serif font-semibold text-slate-900">
                {s.title}
              </h2>
              {Array.isArray(s.body)
                ? s.body.map((p, j) => (
                    <p
                      key={j}
                      className="text-[15px] leading-relaxed text-slate-700"
                    >
                      {p}
                    </p>
                  ))
                : null}
            </div>
          ))}
        </section>
      ) : null}

      {/* FAQ */}
      {Array.isArray(draft.faq) && draft.faq.length > 0 ? (
        <section className="bg-white py-16">
          <div className="mx-auto max-w-3xl px-6 sm:px-8">
            <h2 className="mb-2 text-2xl font-serif font-semibold text-slate-900">
              Common questions
            </h2>
            <p className="mb-6 text-sm text-slate-600">
              The short version of what people ask before they sign up.
            </p>
            <div className="rounded-2xl border border-slate-200 bg-white px-6">
              {draft.faq.map((f, i) => (
                <FaqItem key={i} q={f.q} a={f.a} />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* Footer-lite */}
      <footer className="border-t border-slate-200 bg-[#f7f4ee] py-10">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-6 text-xs text-slate-500 sm:flex-row sm:px-8">
          <span>© 2026 Wynn Tax Solutions</span>
          <span>Free consultation · No obligation · Privacy-first</span>
        </div>
      </footer>
    </article>
  );
}

// ── Side sheet wrapper ─────────────────────────────────────────
export function LandingPagePreviewSheet({
  open,
  onOpenChange,
  row,
}: PreviewSheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col bg-white shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
            "duration-200",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            Landing page preview: {row.slug}
          </DialogPrimitive.Title>

          <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-6 py-3">
            <div className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Preview · {(row.brand || "wynn").toUpperCase()}
              </span>
              <span className="font-mono text-sm text-slate-900">
                /{row.slug}
              </span>
            </div>
            <DialogPrimitive.Close className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="flex-1 overflow-y-auto">
            <LandingPageRender row={row} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
