/**
 * Centralized TanStack Query key factories.
 *
 * Keys are arrays of strings so that invalidation can target a family
 * (e.g., ["metrics"]) or a specific entity (e.g., ["metrics", "sources", domain]).
 */

export const queryKeys = {
  auth: {
    me: () => ["auth", "me"] as const,
  },
  accounts: {
    all: () => ["accounts"] as const,
    list: (filters?: Record<string, unknown>) =>
      ["accounts", "list", filters ?? {}] as const,
    detail: (id: string) => ["accounts", "detail", id] as const,
    callStats: (id: string) => ["accounts", "call-stats", id] as const,
    unassignedExtensions: (company?: string) =>
      ["accounts", "unassigned-extensions", company ?? "all"] as const,
  },
  consent: {
    all: () => ["consent"] as const,
    records: (filters?: Record<string, unknown>) =>
      ["consent", "records", filters ?? {}] as const,
    detail: (id: string) => ["consent", "detail", id] as const,
    stats: (filters?: Record<string, unknown>) =>
      ["consent", "stats", filters ?? {}] as const,
  },
  metrics: {
    all: () => ["metrics"] as const,
    workspace: (domain: string) => ["metrics", "workspace", domain] as const,
    sources: (domain: string, filters?: Record<string, unknown>) =>
      ["metrics", "sources", domain, filters ?? {}] as const,
    attributionReview: (domain: string, filters?: Record<string, unknown>) =>
      ["metrics", "attribution-review", domain, filters ?? {}] as const,
    daily: (domain: string, date?: string) => ["metrics", "daily", domain, date] as const,
    mailCosts: (domain: string, filters?: Record<string, unknown>) =>
      ["metrics", "mail-costs", domain, filters ?? {}] as const,
    redlines: (domain: string) => ["metrics", "redlines", domain] as const,
    callrail: (domain: string, filters?: Record<string, unknown>) =>
      ["metrics", "callrail", domain, filters ?? {}] as const,
  },
  clients: {
    all: () => ["clients"] as const,
    list: (domain: string, filters?: Record<string, unknown>) =>
      ["clients", "list", domain, filters ?? {}] as const,
    search: (domain: string, q: string) => ["clients", "search", domain, q] as const,
    detail: (domain: string, caseId: string) => ["clients", "detail", domain, caseId] as const,
  },
  ringcentral: {
    all: () => ["ringcentral"] as const,
    presence: (domain: string) => ["ringcentral", "presence", domain] as const,
    workspace: (domain: string) => ["ringcentral", "workspace", domain] as const,
    events: (domain: string, filters?: Record<string, unknown>) =>
      ["ringcentral", "events", domain, filters ?? {}] as const,
    callLog: (domain: string, filters?: Record<string, unknown>) =>
      ["ringcentral", "call-log", domain, filters ?? {}] as const,
    runtime: (domain: string) => ["ringcentral", "runtime", domain] as const,
    status: () => ["ringcentral", "status"] as const,
  },
  cx: {
    all: () => ["cx"] as const,
    workspace: (domain: string) => ["cx", "workspace", domain] as const,
    callQueue: (domain: string) => ["cx", "call-queue", domain] as const,
    tasks: (domain: string) => ["cx", "tasks", domain] as const,
    search: (domain: string, search: string, scope = "all") =>
      ["cx", "search", domain, search, scope] as const,
    logicsMatch: (domain: string, needle: string) => ["cx", "logics-match", domain, needle] as const,
    logicsTasks: (domain: string, startDate: string, endDate: string) =>
      ["cx", "logics-tasks", domain, startDate, endDate] as const,
    postdates: (domain: string, filters?: Record<string, unknown>) =>
      ["cx", "postdates", domain, filters ?? {}] as const,
  },
  inbox: {
    all: () => ["inbox"] as const,
    workspace: (domain: string, filters?: Record<string, unknown>) =>
      ["inbox", "workspace", domain, filters ?? {}] as const,
  },
  library: {
    all: () => ["library"] as const,
    workspace: (domain: string) => ["library", "workspace", domain] as const,
  },
  social: {
    all: () => ["social"] as const,
    workspace: (domain: string) => ["social", "workspace", domain] as const,
  },
  deploy: {
    all: () => ["deploy"] as const,
    workspace: (domain: string) => ["deploy", "workspace", domain] as const,
  },
  schedules: {
    all: () => ["schedules"] as const,
    overview: (domain: string) => ["schedules", "overview", domain] as const,
    cadence: (domain: string, filters?: Record<string, unknown>) =>
      ["schedules", "cadence", domain, filters ?? {}] as const,
    history: (domain: string, filters?: Record<string, unknown>) =>
      ["schedules", "history", domain, filters ?? {}] as const,
  },
  review: {
    all: () => ["review"] as const,
    overview: (domain: string) => ["review", "overview", domain] as const,
    queue: (domain: string, filters?: Record<string, unknown>) =>
      ["review", "queue", domain, filters ?? {}] as const,
  },
  dispatch: {
    all: () => ["dispatch"] as const,
    list: (domain: string) => ["dispatch", "list", domain] as const,
    item: (id: string) => ["dispatch", "item", id] as const,
  },
  worklists: {
    all: () => ["worklists"] as const,
    list: (domain: string) => ["worklists", "list", domain] as const,
  },
  hygiene: {
    all: () => ["hygiene"] as const,
    overview: () => ["hygiene", "overview"] as const,
    dailyRuns: (domain: string) => ["hygiene", "daily-runs", domain] as const,
    dailyDashboard: (domain: string) => ["hygiene", "daily-dashboard", domain] as const,
    reviewFeed: (domain: string) => ["hygiene", "review-feed", domain] as const,
  },
  health: {
    all: () => ["health"] as const,
    controlPlane: () => ["health", "control-plane"] as const,
    services: () => ["health", "services"] as const,
  },
  workflows: {
    all: () => ["workflows"] as const,
    list: (domain: string) => ["workflows", "list", domain] as const,
  },
  events: {
    all: () => ["events"] as const,
    list: (filters?: Record<string, unknown>) => ["events", "list", filters ?? {}] as const,
  },
  agentState: {
    all: () => ["agent-state"] as const,
    detail: (extensionId: string) => ["agent-state", "detail", extensionId] as const,
  },
} as const;
