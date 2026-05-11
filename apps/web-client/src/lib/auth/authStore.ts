import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { TOKEN_STORAGE_KEY, USER_STORAGE_KEY } from "@/lib/api/client";
import type { AuthUser } from "@/lib/api/types";

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  setSession: (token: string, user: AuthUser) => void;
  setUser: (user: AuthUser) => void;
  clear: () => void;
  isAuthenticated: () => boolean;
  isAdmin: () => boolean;
  isCx: () => boolean;
}

// Seed from the existing localStorage keys so callers don't lose their session
// on this migration.
function readInitialToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readInitialUser(): AuthUser | null {
  try {
    const raw = window.localStorage.getItem(USER_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: readInitialToken(),
      user: readInitialUser(),
      setSession: (token, user) => {
        try {
          window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
          window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
        } catch {
          /* quota/SSR — fall through */
        }
        set({ token, user });
      },
      setUser: (user) => {
        try {
          window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
        } catch {
          /* quota/SSR */
        }
        set({ user });
      },
      clear: () => {
        try {
          window.localStorage.removeItem(TOKEN_STORAGE_KEY);
          window.localStorage.removeItem(USER_STORAGE_KEY);
        } catch {
          /* quota/SSR */
        }
        set({ token: null, user: null });
      },
      isAuthenticated: () => Boolean(get().token),
      isAdmin: () => {
        const u = get().user;
        return u?.role === "admin" || u?.audience === "admin";
      },
      isCx: () => {
        const u = get().user;
        return u?.role === "admin" || u?.audience === "user";
      },
    }),
    {
      name: "web-client-auth",
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({ token: state.token, user: state.user }),
    },
  ),
);
