import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, BookOpen, GraduationCap, Headphones, Headset, Inbox, LogOut } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CaseInspector } from "@/components/ui/CaseInspector";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { CxAvailabilityToggle } from "@/components/cx/CxAvailabilityToggle";
import { CxConnectButton } from "@/components/cx/CxConnectButton";
import { useSession } from "@/lib/auth/useSession";
import { cn } from "@/lib/utils/cn";

interface CxNavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
}

const CX_NAV: CxNavItem[] = [
  { to: "/cx", label: "Workspace", icon: Headset, end: true },
  { to: "/cx/inbox", label: "SMS", icon: Inbox },
  { to: "/cx/call-library", label: "Calls", icon: Headphones },
  { to: "/cx/coach", label: "Coach", icon: GraduationCap },
  { to: "/cx/manual", label: "Manual", icon: BookOpen },
];

export function CXShell() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const showCxControls = location.pathname === "/cx" || location.pathname === "/cx/";

  return (
    <div className="shell-gradient flex min-h-screen flex-col text-foreground">
      <header className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-[1400px] items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Headset className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">CX Workspace</div>
              <div className="text-xs text-muted-foreground">
                {user?.name ?? user?.email}
                {user?.stationLabel ? ` · ${user.stationLabel}` : ""}
              </div>
            </div>
          </div>

          <nav className="flex items-center gap-1" aria-label="CX navigation">
            {CX_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            {showCxControls ? (
              <>
                <CxConnectButton />
                <CxAvailabilityToggle />
              </>
            ) : null}
            {user?.role === "admin" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate("/admin")}
                title="You're viewing the CX shell as an admin"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to Admin
              </Button>
            ) : null}
            <Button
              variant="ghost"
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
        </div>
      </header>
      <main className="flex-1">
        <div className="mx-auto max-w-[1400px] px-6 py-8">
          <ErrorBoundary resetKeys={[location.pathname]}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>

      <CaseInspector />
    </div>
  );
}
