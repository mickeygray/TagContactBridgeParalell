# Runtime Topology

- `3001`: React workstation for admin and user-facing CX shells.
- `5001`: Control plane for auth, event visibility, and internal orchestration.
- `4001`: Inbound gateway for lead/contact intake.
- `4002`: Outbound gateway for delivery requests.
- `6101`: RingCentral/CX ingestion and workflow service.
- `3333`: Dedicated brand SSH/deploy gateway for main website operations.
- Worker: separate process for durable event processing and replay.
