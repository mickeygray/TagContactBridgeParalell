import type { AuthUser } from "@/lib/api/types";

type AuthLandingUser = Pick<AuthUser, "role" | "audience" | "permissions"> | null | undefined;

export function isAdminLandingUser(user: AuthLandingUser): boolean {
  return user?.role === "admin" || user?.audience === "admin";
}

function hasResolutionAccess(user: AuthLandingUser): boolean {
  return (user?.permissions || []).includes("resolution.read");
}

// The Upsellerator crew: a per-user resolution grant on a widget-user seat
// (no CX/EX surface — they were provisioned for the panel and nothing else).
// A CX agent who ALSO holds resolution keeps /cx as home; the Upsellerator
// is one click away in their case.
export function isResolutionHomeUser(user: AuthLandingUser): boolean {
  return !isAdminLandingUser(user) && user?.role === "widget-user" && hasResolutionAccess(user);
}

export function landingPathForUser(user: AuthLandingUser): "/admin" | "/cx" | "/resolution" {
  if (isAdminLandingUser(user)) return "/admin";
  if (isResolutionHomeUser(user)) return "/resolution";
  return "/cx";
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

  // The Upsellerator is reachable post-login by anyone who can actually
  // open it (admins implicit, resolution.read holders) regardless of which
  // shell is their home.
  if (redirectPath.startsWith("/resolution")) {
    return isAdminLandingUser(user) || hasResolutionAccess(user) ? redirectPath : landing;
  }

  if (isResolutionHomeUser(user)) {
    return landing;
  }

  if (isAdminLandingUser(user)) {
    return redirectPath.startsWith("/admin") || redirectPath.startsWith("/cx")
      ? redirectPath
      : landing;
  }

  return redirectPath.startsWith("/cx") ? redirectPath : landing;
}
