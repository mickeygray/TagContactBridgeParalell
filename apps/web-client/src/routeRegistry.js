export const routeRegistry = [
  {
    path: "/admin",
    requiredRole: "admin",
    audience: "admin",
    title: "Admin Console",
    description: "Event replay, platform health, and operator workflows.",
  },
  {
    path: "/user",
    audience: "user",
    title: "User Console",
    description: "CX-facing workflow shell for call recipients and agent actions.",
  },
];
