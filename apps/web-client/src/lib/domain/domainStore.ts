import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

const DEFAULT_DOMAIN = import.meta.env.VITE_DEFAULT_DOMAIN ?? "TAG";

/**
 * Known domains today. Add entries here as Codex surfaces more through
 * `/api/control-plane`. The list is also reachable via the auth user's
 * `company` field for scoping.
 */
export const KNOWN_DOMAINS = ["TAG", "WYNN", "AMITY"] as const;
export type KnownDomain = (typeof KNOWN_DOMAINS)[number] | (string & {});

interface DomainState {
  domain: string;
  setDomain: (domain: string) => void;
}

export const useDomainStore = create<DomainState>()(
  persist(
    (set) => ({
      domain: DEFAULT_DOMAIN,
      setDomain: (domain) => set({ domain }),
    }),
    {
      name: "web-client-domain",
      storage: createJSONStorage(() => window.localStorage),
    },
  ),
);
