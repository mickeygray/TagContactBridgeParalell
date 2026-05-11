# NSSM Services

Parallel now expects per-process NSSM services instead of one `npm run dev` wrapper.

Installed by:

- [install-services.ps1](C:\Users\Admin\Code\TagContactBridgeParallel\ops\nssm\install-services.ps1)

Services:

- `ParallelControlPlane`
- `ParallelInboundGateway`
- `ParallelOutboundGateway`
- `ParallelRingCentralCx`
- `ParallelRestartHelper`
- `ParallelBlogger`

Why this shape:

- nginx and ngrok depend on `5001`, `4001`, `4002`, and `6101` all being alive
- if one process dies, NSSM can restart just that process
- the built web client is served from `5001`, so there is no separate `3001` production service

Typical install flow:

```powershell
cd C:\Users\Admin\Code\TagContactBridgeParallel\ops\nssm
.\install-services.ps1
```

Then set the run-as password for each service with `nssm edit <service>`.

`ParallelRestartHelper` is a demand-start helper, not an always-on daemon.
When started, it:

- restarts `ParallelInboundGateway`
- restarts `ParallelOutboundGateway`
- restarts `ParallelRingCentralCx`
- restarts `ParallelControlPlane`
- reloads nginx
- re-ensures the Parallel ngrok tunnel

It does not touch:

- the legacy TagContactBridge process
- the old blogger daemon
- `ParallelBlogger`

Use it with:

```powershell
Start-Service ParallelRestartHelper
```
