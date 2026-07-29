import type { ComponentType } from "react";
import {
  BarChart3,
  FileBarChart,
  CalendarClock,
  Gem,
  GraduationCap,
  Headphones,
  Headset,
  Inbox,
  ListChecks,
  Megaphone,
  Radio,
  Rocket,
  UserCog,
  Wrench,
} from "lucide-react";

export type WorkspaceKey =
  | "reports"
  | "metrics"
  | "ringbridge"
  | "live-coach"
  | "live-coach-cockpit"
  | "inbox"
  | "dispatch"
  | "postdates"
  | "social"
  | "cleaning"
  | "users"
  | "cx-call-tracker"
  | "deploy"
  | "trainer"
  | "resolution"
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
    key: "reports",
    path: "/admin/reports",
    label: "Reports",
    description: "Build, preview and schedule reports. ROI by source, officer performance, P/L.",
    icon: FileBarChart,
    audience: "admin",
  },
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
    key: "live-coach",
    path: "/admin/live-coach",
    label: "Live Coach",
    description: "Agent coach streams, transcript, context, and dialog.",
    icon: Radio,
    audience: "admin",
  },
  {
    key: "live-coach-cockpit",
    path: "/admin/live-coach/cockpit",
    label: "Coach Cockpit",
    description: "Per-session Focus Card — say zone, script spine, summary, case.",
    icon: Headphones,
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
    label: "Appointments",
    description: "Agent appointment queues, releases, and scheduled callback holds.",
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
    // Lives OUTSIDE the /admin shell (like the trainer) — the resolution
    // crew logs straight into it; admins reach it from this sidebar.
    key: "resolution",
    path: "/resolution",
    label: "Upsellerator",
    description: "Resolution case bank, dossiers, and the Opus pitch designer.",
    icon: Gem,
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
    label: "Workspace",
    description: "Dialing, SMS, calls, and coach tools.",
    icon: UserCog,
    audience: "user",
  },
];

export const allWorkspaces = [...adminWorkspaces, ...cxWorkspaces];

export { ListChecks, Wrench };
