import type { ComponentType } from "react";
import {
  BarChart3,
  CalendarClock,
  GraduationCap,
  Headphones,
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
  | "postdates"
  | "social"
  | "cleaning"
  | "users"
  | "cx-call-tracker"
  | "deploy"
  | "trainer"
  | "cx";

export interface WorkspaceDef {
  key: WorkspaceKey;
  path: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  audience: "admin" | "user";
}

// Single flat nav for the admin shell. Order = display order in the
// sidebar. Daily-driver workspaces toward the top, ops toward the
// bottom.
export const adminWorkspaces: WorkspaceDef[] = [
  {
    key: "metrics",
    path: "/admin/metrics",
    label: "Metrics",
    description: "Leads, calls, spend, redlines, mail costs, callrail.",
    icon: BarChart3,
    audience: "admin",
  },
  {
    key: "ringbridge",
    path: "/admin/ringbridge",
    label: "RingBridge",
    description: "Agent presence, telephony state, RC runtime.",
    icon: Headset,
    audience: "admin",
  },
  {
    key: "inbox",
    path: "/admin/inbox",
    label: "SMS Inbox",
    description: "Conversation workflows, AI drafts, approvals.",
    icon: Inbox,
    audience: "admin",
  },
  {
    key: "clients",
    path: "/admin/clients",
    label: "Clients",
    description: "Search and open any prospect or case profile.",
    icon: Users,
    audience: "admin",
  },
  {
    key: "dispatch",
    path: "/admin/dispatch",
    label: "Dispatch",
    description: "Manual text / email / RVM campaigns and worklists.",
    icon: Megaphone,
    audience: "admin",
  },
  {
    key: "postdates",
    path: "/admin/postdates",
    label: "Post Dates",
    description: "Post-date holds, releases, and payment checks.",
    icon: CalendarClock,
    audience: "admin",
  },
  {
    key: "cleaning",
    path: "/admin/cleaning",
    label: "Lead Intake",
    description: "NCOA CSV uploads and the TCPA consent vault.",
    icon: ListChecks,
    audience: "admin",
  },
  {
    key: "social",
    path: "/admin/social",
    label: "Meta Responder",
    description: "Facebook and Instagram auto-reply keywords and webhook status.",
    icon: Wrench,
    audience: "admin",
  },
  {
    key: "users",
    path: "/admin/users",
    label: "Users & Agents",
    description: "Create users, pair to RingCentral, invite via OTP.",
    icon: UserCog,
    audience: "admin",
  },
  {
    key: "cx-call-tracker",
    path: "/admin/cx-call-tracker",
    label: "Call Library",
    description: "Playable Google Drive call recordings.",
    icon: Headphones,
    audience: "admin",
  },
  {
    key: "trainer",
    path: "/trainer",
    label: "Sales Trainer",
    description: "Roleplay calls, voice persona, live coaching.",
    icon: GraduationCap,
    audience: "admin",
  },
  {
    key: "deploy",
    path: "/admin/deploy",
    label: "Deploy",
    description: "Sales-site SSH deploys + blog bot pipeline status.",
    icon: Rocket,
    audience: "admin",
  },
];

export const cxWorkspaces: WorkspaceDef[] = [
  {
    key: "cx",
    path: "/cx",
    label: "My Workspace",
    description: "Calls, tasks, Logics, SMS.",
    icon: UserCog,
    audience: "user",
  },
];

export const allWorkspaces = [...adminWorkspaces, ...cxWorkspaces];

export { ListChecks, Wrench };
