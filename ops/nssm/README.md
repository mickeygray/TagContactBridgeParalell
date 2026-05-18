# NSSM Services

Parallel now expects per-process NSSM services instead of one `npm run dev` wrapper.

Installed by:

- [install-services.ps1](C:\code\TagContactBridgeParalell\ops\nssm\install-services.ps1)

Services:

- `ParallelNginx`
- `ParallelControlPlane`
- `ParallelInboundGateway`
- `ParallelOutboundGateway`
- `ParallelRingCentralCx`
- `ParallelNgrok`
- `ParallelRestartHelper`
- `ParallelBlogger`

Why this shape:

- nginx and ngrok depend on `5001`, `4001`, `4002`, and `6101` all being alive
- if one process dies, NSSM can restart just that process
- the built web client is served from `5001`, so there is no separate `3001` production service

Typical install flow:

```powershell
cd C:\code\TagContactBridgeParalell\ops\nssm
.\install-services.ps1
```

Then set the run-as password for each service with `nssm edit <service>`.

`ParallelRestartHelper` is a demand-start helper, not an always-on daemon.
When started, it runs [restart-parallel-all.ps1](C:\code\TagContactBridgeParalell\ops\nssm\restart-parallel-all.ps1), which restarts:

- `ParallelControlPlane`
- `ParallelInboundGateway`
- `ParallelOutboundGateway`
- `ParallelRingCentralCx`
- `ParallelBlogger` if installed
- `ParallelNginx`
- `ParallelNgrok` if installed

The app is Atlas-backed. `ParallelMongo`, if present from older local testing, is not part of the normal production restart path. Use `-IncludeMongo` on `restart-parallel-all.ps1` only for an explicit local Mongo test.

It does not touch:

- the legacy TagContactBridge process

Use it with:

```powershell
Start-Service ParallelRestartHelper
```

`Start-Service` itself does not stream output. To start the helper and watch
the live restart log in the same terminal, use:

```powershell
cd C:\code\TagContactBridgeParalell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\nssm\start-restart-helper-and-watch.ps1 -StopIfAlreadyRunning
```

Or run the script directly:

```powershell
cd C:\code\TagContactBridgeParalell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\nssm\restart-parallel-all.ps1 -BuildWeb -Healthcheck
```

Useful switches:

- `-SkipNgrok` keeps the tunnel untouched during migration tests.
- `-SkipMongo` avoids restarting Mongo during live debugging.
- `-BuildWeb` rebuilds the React client before restart.
- `-Healthcheck` runs the local cutover healthcheck after services start.
- `-EnsureAutomatic` sets included services to automatic startup.
