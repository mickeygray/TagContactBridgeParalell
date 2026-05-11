import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useSession } from "@/lib/auth/useSession";
import { Loader2 } from "lucide-react";
import { landingPathForUser } from "@/lib/auth/landing";

interface AuthGateProps {
  audience?: "admin" | "user";
}

export function AuthGate({ audience }: AuthGateProps) {
  const location = useLocation();
  const { isAuthenticated, isLoading, user } = useSession();

  if (!isAuthenticated) {
    const redirectTo = `${location.pathname}${location.search}${location.hash}`;
    return (
      <Navigate to="/login" replace state={{ redirectTo }} />
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (audience && user && user.audience && user.audience !== audience) {
    // Admins can preview either shell — the role grant supersedes audience
    // gating. Non-admins stay pinned to their own audience.
    if (user.role !== "admin") {
      return <Navigate to={landingPathForUser(user)} replace />;
    }
  }

  return <Outlet />;
}

export function RoleSplash() {
  const { user } = useSession();
  return <Navigate to={landingPathForUser(user)} replace />;
}
