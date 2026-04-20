# NSSM Plan

Introduce NSSM after local startup and health checks are stable.

Planned services:

- `tcb-parallel-control-plane`
- `tcb-parallel-inbound-gateway`
- `tcb-parallel-outbound-gateway`
- `tcb-parallel-ringcentral-cx`
- `tcb-parallel-brand-ssh-gateway`
- `tcb-parallel-event-worker`
- `tcb-parallel-web-client`

Reserved port layout:

- `3001` web client
- `3333` brand SSH/deploy gateway
- `4001` inbound gateway
- `4002` outbound gateway
- `5001` control plane
- `6101` RingCentral/CX
