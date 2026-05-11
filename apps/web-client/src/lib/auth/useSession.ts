import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, setUnauthorizedHandler } from "@/lib/api/client";
import { useMeQuery } from "@/lib/api/queries/auth";
import { useAuthStore } from "@/lib/auth/authStore";

/**
 * Glue hook — wires the API client's 401-only handler to the auth store,
 * refreshes the user profile from /api/auth/me when a token exists, and
 * clears the TanStack Query cache on logout.
 *
 * Important: 403 (Forbidden — authenticated but lacks permission) does
 * NOT log the user out. Only 401 (no / invalid token) triggers clear().
 * Components handle 403 inline by rendering a permissions error.
 */
export function useSession() {
  const qc = useQueryClient();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const setUser = useAuthStore((s) => s.setUser);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clear();
      qc.clear();
    });
    return () => setUnauthorizedHandler(null);
  }, [clear, qc]);

  const me = useMeQuery(Boolean(token));
  useEffect(() => {
    if (me.data) {
      setUser(me.data);
    }
  }, [me.data, setUser]);

  return {
    token,
    user,
    isLoading: Boolean(token) && me.isLoading && !user,
    isAuthenticated: Boolean(token),
    logout: async () => {
      try {
        await api.post("/api/auth/logout");
      } catch {
        // Local session cleanup must still happen if the token has already
        // expired or the network drops during sign-out.
      } finally {
        clear();
        qc.clear();
      }
    },
  };
}
