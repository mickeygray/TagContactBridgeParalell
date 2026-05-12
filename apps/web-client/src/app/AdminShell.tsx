import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronsUpDown,
  Eye,
  LogOut,
  Radio,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { CaseInspector } from "@/components/ui/CaseInspector";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { DomainSwitcher } from "@/components/ui/DomainSwitcher";
import { StatusPill } from "@/components/ui/StatusPill";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { adminWorkspaces } from "@/app/workspaceRegistry";
import { useSession } from "@/lib/auth/useSession";
import { useControlPlaneHealth } from "@/lib/api/queries/health";
import { cn } from "@/lib/utils/cn";

export function AdminShell() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const health = useControlPlaneHealth();

  return (
    <div className="shell-gradient flex min-h-screen text-foreground">
      <aside className="sticky top-0 flex h-screen w-[248px] flex-col border-r border-border bg-card/60 backdrop-blur">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Radio className="h-4 w-4" />
          </div>
          <div className="flex flex-1 flex-col leading-tight">
            <span className="text-sm font-semibold">TagContactBridge</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Admin Console
            </span>
          </div>
          <ThemeToggle />
        </div>

        <div className="border-b border-border px-3 py-3">
          <DomainSwitcher className="w-full" />
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <ul className="space-y-0.5">
            {adminWorkspaces.map((w) => (
              <li key={w.key}>
                <NavLink
                  to={w.path}
                  className={({ isActive }) =>
                    cn(
                      "group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                      isActive
                        ? "bg-primary/10 text-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )
                  }
                >
                  <w.icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">{w.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-border px-3 py-3">
          <Dialog>
            <DialogTrigger asChild>
              <button className="flex w-full items-center gap-2 rounded-md p-2 text-left transition-colors hover:bg-muted">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <ShieldCheck className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-xs font-semibold">
                    {user?.name ?? user?.email ?? "Admin"}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {user?.company ?? user?.role ?? "admin"}
                  </div>
                </div>
                <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Session</DialogTitle>
                <DialogDescription>
                  Signed in as {user?.email ?? "unknown"}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Role</span>
                  <span className="font-medium">{user?.role ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Audience</span>
                  <span className="font-medium">{user?.audience ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Company</span>
                  <span className="font-medium">{user?.company ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Control plane</span>
                  <StatusPill
                    dotted
                    tone={health.data ? "success" : health.isLoading ? "info" : "danger"}
                  >
                    {health.data ? "Online" : health.isLoading ? "Checking" : "Offline"}
                  </StatusPill>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/cx")}
                >
                  <Eye className="h-3.5 w-3.5" />
                  Preview CX view
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/admin/settings")}
                >
                  <Settings className="h-3.5 w-3.5" />
                  Settings
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    void logout().finally(() => {
                      navigate("/login", { replace: true });
                    });
                  }}
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sign out
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </aside>

      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-[1400px] px-8 py-8">
          <ErrorBoundary resetKeys={[location.pathname]}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>

      <CaseInspector />
    </div>
  );
}
