import type { AuthUser } from "@/lib/api/types";

type AuthLandingUser = Pick<AuthUser, "role" | "audience"> | null | undefined;

export function isAdminLandingUser(user: AuthLandingUser): boolean {
  return user?.role === "admin" || user?.audience === "admin";
}

export function landingPathForUser(user: AuthLandingUser): "/admin" | "/cx" {
  return isAdminLandingUser(user) ? "/admin" : "/cx";
}

function normalizeRedirectPath(value: unknown): string | null {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) return null;
  if (path === "/login" || path.startsWith("/login?") || path.startsWith("/login#")) {
    return null;
  }
  return path;
}

export function postLoginPathForUser(user: AuthLandingUser, redirectTo?: string | null): string {
  const landing = landingPathForUser(user);
  const redirectPath = normalizeRedirectPath(redirectTo);
  if (!redirectPath || redirectPath === "/") return landing;

  if (isAdminLandingUser(user)) {
    return redirectPath.startsWith("/admin") || redirectPath.startsWith("/cx")
      ? redirectPath
      : landing;
  }

  return redirectPath.startsWith("/cx") ? redirectPath : landing;
}
