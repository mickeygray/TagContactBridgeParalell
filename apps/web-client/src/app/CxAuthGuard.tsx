import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertCircle } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { useSession } from "@/lib/auth/useSession";
import { useAuthStore } from "@/lib/auth/authStore";
import { api, ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries/keys";
import type { AuthUser } from "@/lib/api/types";
import { Button } from "@/components/ui/Button";

/**
 * CxAuthGuard — gates the /cx surface on the agent having valid RingCX
 * OAuth credentials. Behavior:
 *
 *   - If user.cxAuth.isOAuthValidated === true  → render children normally
 *   - If false → POST /api/auth/cx/start, then
 *     window.location.href = authorizeUrl (full-page redirect to RC).
 *     Shows a loading spinner while in flight.
 *   - If RC consent fails (URL has ?cxauth=err) → shows an error UI with
 *     a "Try again" button. Does NOT auto-retry to prevent loops.
 *   - On success (?cxauth=ok) → fires a toast; the next /me refresh
 *     flips isOAuthValidated to true and the guard becomes a no-op.
 *
 * Admins are NOT exempt — they only see this when they navigate INTO
 * /cx (the CX workspace). The /admin shell isn't wrapped by this guard
 * so admin work continues without prompting. Going to /cx means doing
 * CX work, which needs per-user RingCX credentials regardless of role.
 *
 * Per-mount React ref prevents StrictMode double-fire. Does NOT
 * survive navigations — if the user comes back to /cx after a failed
 * round-trip, the guard re-fires (intentional; the previous failure
 * doesn't lock them out).
 */

export function CxAuthGuard({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [starting, setStarting] = useState(false);
  const [refreshingAfterSuccess, setRefreshingAfterSuccess] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Per-mount sentinel — survives StrictMode's double-mount but not
  // navigation. We don't want a sticky sessionStorage flag because a
  // previous failed attempt (e.g. nginx misroute, RC consent denied)
  // shouldn't lock the user out forever in this tab.
  const attemptedRef = useRef(false);
  // "We just succeeded" memory — set true when ?cxauth=ok arrives, never
  // cleared in this mount. Prevents the post-param-strip race where the
  // URL flips to no-param but `user` cache hasn't yet been replaced via
  // /me refetch. With this ref true, the guard renders children and
  // does NOT auto-fire OAuth, even if the in-memory user still claims
  // isOAuthValidated=false. The next render after the refetch lands
  // makes the ref redundant.
  const justSucceededRef = useRef(false);
  const successSuppressUntilRef = useRef<number>(0);

  const cxauthParam = searchParams.get("cxauth");
  const cxauthReason = searchParams.get("reason");

  // Surface success / error toasts when RC redirects back with a result
  useEffect(() => {
    if (cxauthParam === "ok") {
      // Latch the "we just succeeded" signal BEFORE the param gets
      // stripped — this ref is what `skip` reads on subsequent renders
      // when cxauthParam is gone but the /me cache hasn't yet flushed.
      justSucceededRef.current = true;
      attemptedRef.current = true;
      const suppressUntil = Date.now() + 30_000;
      successSuppressUntilRef.current = suppressUntil;
      setRefreshingAfterSuccess(true);
      setStartError(null);
      try {
        window.sessionStorage.setItem("cx-oauth-success-suppress-until", String(suppressUntil));
      } catch {
        /* storage unavailable; in-memory ref still protects this mount */
      }
      toast.success("RingCentral connected", {
        description: "You're authorized to dial as yourself.",
      });
      // CRITICAL: bust the auth.me cache so the next render sees the fresh
      // cxAuth.isOAuthValidated = true. Without this, the 60s staleTime on
      // useMeQuery means the guard reads stale `user.cxAuth.isOAuthValidated
      // = false` and immediately fires another OAuth round-trip — infinite
      // loop. Invalidating forces a refetch; once `user` updates, `skip`
      // flips true and rendering proceeds.
      let cancelled = false;
      (async () => {
        try {
          const freshUser = await qc.fetchQuery({
            queryKey: queryKeys.auth.me(),
            queryFn: () => api.get<AuthUser>("/api/auth/me"),
            staleTime: 0,
          });
          if (cancelled) return;
          useAuthStore.getState().setUser(freshUser);
          if (freshUser.cxAuth?.isOAuthValidated === true) {
            try {
              window.sessionStorage.removeItem("cx-oauth-success-suppress-until");
            } catch {
              /* ignore */
            }
          } else {
            const reason = freshUser.cxAuth?.invalidReason || "cx-session-not-ready";
            setStartError(`RingCentral connected, but CX session is not ready yet (${reason}).`);
          }
        } catch (err) {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : "unknown";
          setStartError(`Could not refresh RingCentral status: ${message}`);
        } finally {
          if (cancelled) return;
          qc.invalidateQueries({ queryKey: queryKeys.auth.me() });
          const next = new URLSearchParams(searchParams);
          next.delete("cxauth");
          next.delete("reason");
          setSearchParams(next, { replace: true });
          setRefreshingAfterSuccess(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    } else if (cxauthParam === "err") {
      toast.error("RingCentral connection failed", {
        description: cxauthReason ? decodeURIComponent(cxauthReason) : "Try again.",
      });
      setStartError(cxauthReason || "rc-error");
      // Don't strip — keep visible so the user knows what happened
    }
  }, [cxauthParam, cxauthReason, searchParams, setSearchParams, qc]);

  // Determine whether to gate.
  // Admins are NOT exempt — going to /cx implies CX work, so admins
  // need the same bearer/session as agents to dial. They can avoid the
  // prompt by staying in /admin (which isn't wrapped by this guard).
  //
  // `cxauthParam === "ok"` is a "just succeeded" signal — even if our
  // cached user object still says isOAuthValidated=false (60s staleTime
  // on /me), the URL tells us OAuth just completed server-side. Skipping
  // here breaks the loop while the /me invalidate above flushes the
  // stale cache. Without this, the OAuth-fire effect below would race
  // ahead of the refetch and send the user back to RC immediately.
  let successSuppressActive = false;
  try {
    const storedUntil = Number(window.sessionStorage.getItem("cx-oauth-success-suppress-until") || 0);
    const inMemoryUntil = successSuppressUntilRef.current || 0;
    const activeUntil = Math.max(storedUntil || 0, inMemoryUntil);
    successSuppressActive = Number.isFinite(activeUntil) && Date.now() < activeUntil;
    if (storedUntil && !successSuppressActive) {
      window.sessionStorage.removeItem("cx-oauth-success-suppress-until");
    }
  } catch {
    successSuppressActive = false;
  }

  const skip = !user
    || user.cxAuth?.oauthRequired === false
    || user.cxAuth?.isOAuthValidated === true
    || cxauthParam === "ok"
    || cxauthParam === "err"
    || justSucceededRef.current
    || refreshingAfterSuccess
    || successSuppressActive;

  useEffect(() => {
    if (skip) return;
    if (startError) return;
    if (attemptedRef.current) return;  // StrictMode double-mount guard
    if (starting) return;

    attemptedRef.current = true;
    setStarting(true);
    setStartError(null);
    (async () => {
      try {
        const res = await api.post<{ ok: boolean; authorizeUrl?: string; error?: string }>(
          "/api/auth/cx/start",
          { finalRedirectTo: location.pathname || "/cx" },
        );
        if (res.ok && res.authorizeUrl) {
          window.location.href = res.authorizeUrl;
          return;
        }
        setStartError(res.error || "no-authorize-url");
        setStarting(false);
      } catch (err) {
        if (err instanceof ApiError) {
          // 403 → user lacks permission to start; admin doesn't need to anyway
          // 5xx → backend issue
          setStartError(`${err.status}: ${err.message}`);
        } else {
          setStartError((err as Error).message);
        }
        setStarting(false);
      }
    })();
  }, [skip, startError, starting, location.pathname]);

  // ── Render states ────────────────────────────────────────────

  if (startError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <div>
          <div className="text-sm font-medium">RingCentral connection failed</div>
          <div className="text-xs text-muted-foreground mt-1">{startError}</div>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            // Clear any stale sentinel from prior implementations + reload
            // (the new ref-based sentinel resets automatically on mount)
            try { sessionStorage.removeItem("cx-oauth-attempt-this-tab"); } catch {}
            try { sessionStorage.removeItem("cx-oauth-success-suppress-until"); } catch {}
            window.location.reload();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (skip) return <>{children}</>;

  return (
    <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <div className="text-sm font-medium">Connecting to RingCentral…</div>
      <div className="text-xs text-muted-foreground">
        You'll be redirected to authorize this app to dial on your behalf.
      </div>
    </div>
  );
}
