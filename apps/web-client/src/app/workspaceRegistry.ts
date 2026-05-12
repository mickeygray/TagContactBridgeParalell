import type { ComponentType } from "react";
import {
  BarChart3,
  Headset,
  Inbox,
  ListChecks,
  Megaphone,
  Rocket,
  Users,
  UserCog,
  Wrench,
} from "lucide-react";

export type WorkspaceKey =
  | "metrics"
  | "ringbridge"
  | "inbox"
  | "clients"
  | "dispatch"
  | "social"
  | "cleaning"
  | "users"
  | "deploy"
  | "cx";

export interface WorkspaceDef {
  key: WorkspaceKey;
  path: string;
  label: string;
  description: string;
  group: "workspaces" | "operations" | "cx";
  icon: ComponentType<{ className?: string }>;
  audience: "admin" | "user";
  /** Backend readiness hint shown in the nav. */
  readiness: "ready" | "partial" | "gap";
}

export const adminWorkspaces: WorkspaceDef[] = [
  {
    key: "metrics",
    path: "/admin/metrics",
    label: "Metrics",
    description: "Leads, calls, spend, redlines, mail costs, callrail.",
    group: "workspaces",
    icon: BarChart3,
    audience: "admin",
    readiness: "ready",
  },
  {
    key: "ringbridge",
    path: "/admin/ringbridge",
    label: "RingBridge",
    description: "Agent presence, telephony state, RC runtime.",
    group: "workspaces",
    icon: Headset,
    audience: "admin",
    readiness: "ready",
  },
  {
    key: "inbox",
    path: "/admin/inbox",
    label: "SMS Inbox",
    description: "Conversation workflows, AI drafts, approvals.",
    group: "workspaces",
    icon: Inbox,
    audience: "admin",
    readiness: "partial",
  },
  {
    key: "clients",
    path: "/admin/clients",
    label: "Clients",
    description: "Search and open any prospect or case profile.",
    group: "workspaces",
    icon: Users,
    audience: "admin",
    readiness: "ready",
  },
  {
    key: "dispatch",
    path: "/admin/dispatch",
    label: "Dispatch",
    description: "Manual text / email / RVM campaigns and worklists.",
    group: "workspaces",
    icon: Megaphone,
    audience: "admin",
    readiness: "ready",
  },
  {
    key: "social",
    path: "/admin/social",
    label: "Meta Responder",
    description: "Facebook and Instagram auto-reply keywords and webhook status.",
    group: "operations",
    icon: Wrench,
    audience: "admin",
    readiness: "partial",
  },
  {
    key: "cleaning",
    path: "/admin/cleaning",
    label: "Lead Intake",
    description: "NCOA CSV uploads and the TCPA consent vault.",
    group: "workspaces",
    icon: ListChecks,
    audience: "admin",
    readiness: "ready",
  },
  {
    key: "users",
    path: "/admin/users",
    label: "Users & Agents",
    description: "Create users, pair to RingCentral, invite via OTP.",
    group: "operations",
    icon: UserCog,
    audience: "admin",
    readiness: "ready",
  },
  {
    key: "deploy",
    path: "/admin/deploy",
    label: "Deploy",
    description: "Targets, history, content push, restart.",
    group: "operations",
    icon: Rocket,
    audience: "admin",
    readiness: "partial",
  },
];

export const cxWorkspaces: WorkspaceDef[] = [
  {
    key: "cx",
    path: "/cx",
    label: "My Workspace",
    description: "Calls, tasks, Logics, SMS.",
    group: "cx",
    icon: UserCog,
    audience: "user",
    readiness: "partial",
  },
];

export const allWorkspaces = [...adminWorkspaces, ...cxWorkspaces];

export const readinessTone: Record<WorkspaceDef["readiness"], string> = {
  ready: "Live",
  partial: "Partial",
  gap: "Pending",
};

export { ListChecks, Wrench };
