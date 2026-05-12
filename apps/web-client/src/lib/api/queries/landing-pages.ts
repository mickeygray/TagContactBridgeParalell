import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export interface LandingPagePendingRow {
  slug: string;
  brand: string | null;
  generatedAt: string | null;
  mtime: string;
  status: "pending-review" | "approved" | "shipped";
  heroImageUrl: string | null;
  claudeModel: string | null;
  claudeUsage: { input_tokens?: number; output_tokens?: number } | null;
  composerDraft: Record<string, unknown> | null;
  pageDraft: LandingPageDraft | null;
}

export interface LandingPageDraft {
  headline: string;
  subhead: string;
  bullets: string[];
  sections: { title: string; body: string[] }[];
  faq: { q: string; a: string }[];
  imagePrompt: string;
  seoTitle: string;
  seoDescription: string;
  jsonLd: Record<string, unknown>;
}

interface PendingResponse {
  ok: true;
  result: { rows: LandingPagePendingRow[] };
}

export function useLandingPagesPending() {
  return useQuery({
    queryKey: ["landing-pages", "pending"],
    queryFn: () =>
      api
        .get<PendingResponse>("/api/read/landing-pages/pending")
        .then((r) => r.result.rows),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
