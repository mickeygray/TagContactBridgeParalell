import { useDomainStore } from "@/lib/domain/domainStore";
import { useAuthStore } from "@/lib/auth/authStore";

/**
 * Resolve the active domain for the current session.
 *
 * - Domain selection follows the persisted `domainStore` for both admins and
 *   CX users. `company` is only a default, not an access boundary.
 *
 * This keeps shared workspaces (e.g. Clients) working in both shells without
 * conditional wiring inside every feature component.
 */
export function useActiveDomain(): string {
  const stored = useDomainStore((s) => s.domain);
  const user = useAuthStore((s) => s.user);

  return stored || String(user?.company || "TAG").toUpperCase();
}
