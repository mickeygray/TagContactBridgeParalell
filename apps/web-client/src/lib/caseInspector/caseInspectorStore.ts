import { create } from "zustand";

/**
 * Global case inspector — any workspace can call `openCase(domain, caseId)`
 * and the shell-mounted `<CaseInspector />` will pop open a drawer backed by
 * the existing `useClientDetail(domain, caseId)` query.
 *
 * Using a global store rather than local state lets us drop a `<CaseLink>`
 * anywhere without plumbing props through parent components.
 */

interface CaseInspectorState {
  domain: string | null;
  caseId: string | null;
  open: boolean;
  /** Imperatively open the inspector for a case. */
  openCase: (domain: string, caseId: string | number) => void;
  /** Close without clearing so reopening the same case is instant. */
  close: () => void;
  /** Clear the backing case id so the drawer fully resets on next open. */
  reset: () => void;
}

export const useCaseInspectorStore = create<CaseInspectorState>((set) => ({
  domain: null,
  caseId: null,
  open: false,
  openCase: (domain, caseId) => {
    const normalized = String(caseId ?? "").trim();
    if (!domain || !normalized) return;
    set({ domain, caseId: normalized, open: true });
  },
  close: () => set({ open: false }),
  reset: () => set({ domain: null, caseId: null, open: false }),
}));
