import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Link2, CheckCircle2 } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { useSession } from "@/lib/auth/useSession";
import { toast } from "@/components/ui/Toaster";
import { cn } from "@/lib/utils/cn";

/**
 * CxConnectButton — opt-in "Connect RingCentral" button shown in the
 * CXShell header. Visible whenever the current user's cxAuth is NOT
 * validated. Clicking fires POST /api/auth/cx/start and redirects the
 * browser to RC's consent page.
 *
 * Why this is a separate widget from CxAuthGuard:
 *   - CxAuthGuard auto-redirects non-admin users so they can't use the
 *     app without connecting
 *   - Admins are exempt from the auto-redirect (they can navigate the
 *     admin shell without ever placing a call)
 *   - But admins MIGHT want to connect anyway — to dial themselves, or
 *     to test the SSO flow as a real user
 *   - This button gives them that opt-in path
 *   - And it serves as a manual retry for anyone who hit ?cxauth=err
 *
 * The button hides itself once cxAuth.isOAuthValidated flips true.
 * Replaced by a discreet "Connected to RC" pill (still tappable to
 * re-trigger if needed) so the user sees the connection succeeded.
 */

export function CxConnectButton() {
  const { user } = useSession();
  const [pending, setPending] = useState(false);

  const start = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; authorizeUrl?: string; error?: string }>(
        "/api/auth/cx/start",
        { finalRedirectTo: window.location.pathname || "/cx" },
      ),
    onSuccess: (res) => {
      if (res.ok && res.authorizeUrl) {
        setPending(true);
        window.location.href = res.authorizeUrl;
      } else {
        toast.error("Could not start RingCentral connection", {
          description: res.error || "unknown error",
        });
      }
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error("Could not start RingCentral connection", { description: msg });
    },
  });

  if (!user) return null;
  if (user.cxAuth?.oauthRequired === false) return null;
  const isValidated = Boolean(user.cxAuth?.isOAuthValidated);

  if (isValidated) {
    // Render a small "connected" pill — clickable to refresh if needed
    return (
      <button
        type="button"
        onClick={() => start.mutate()}
        disabled={start.isPending || pending}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
          "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20",
        )}
        title={`RingCentral connected${user.cxAuth?.rcUserEmail ? ` as ${user.cxAuth.rcUserEmail}` : ""}. Click to re-authorize.`}
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
        RC connected
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => start.mutate()}
      disabled={start.isPending || pending}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        "bg-blue-500/10 text-blue-600 hover:bg-blue-500/20",
        (start.isPending || pending) && "opacity-60 cursor-wait",
      )}
      title="Authorize this app to dial on your behalf via your RingCentral account"
    >
      {start.isPending || pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Link2 className="h-3.5 w-3.5" />
      )}
      Connect RingCentral
    </button>
  );
}
