# Ubuntu Standby Host

This folder is for a warm Ubuntu standby for `TagContactBridgeParalell`.

The intended shape is:

- Windows/current host stays public and live.
- Ubuntu host runs the app locally with `PARALLEL_RC_SUSPENDED=true`.
- `parallel-ngrok` stays stopped until failover.
- Deploys can be pulled from GitHub with `sudo parallel-deploy`.
- Failover is `sudo parallel-go-live` after the old host/tunnel is stopped.

## Fresh server bootstrap

Install Ubuntu Server 24.04 LTS, enable OpenSSH during install, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/mickeygray/TagContactBridgeParalell/master/ops/linux/bootstrap-ubuntu-standby.sh -o /tmp/bootstrap-ubuntu-standby.sh
sudo bash /tmp/bootstrap-ubuntu-standby.sh
```

If the repo is private, the script prints an SSH deploy key. Add that key to:

`GitHub repo -> Settings -> Deploy keys -> Add deploy key`

Use read-only unless this server needs to push.

Then rerun the bootstrap command.

## Copy `.env`

From the Windows machine, after SSH works:

```powershell
scp "C:\Users\micke\Documents\Codex\2026-05-14\files-mentioned-by-the-user-definitely\TagContactBridgeParalell\.env" YOUR_ADMIN_USER@UBUNTU_IP:/tmp/parallel.env
ssh YOUR_ADMIN_USER@UBUNTU_IP "sudo mv /tmp/parallel.env /opt/tagcontactbridge-parallel/.env && sudo chown parallel:parallel /opt/tagcontactbridge-parallel/.env && sudo chmod 600 /opt/tagcontactbridge-parallel/.env"
```

Then on Ubuntu:

```bash
sudo parallel-deploy
```

## Keep standby updated

After pushing changes from Windows:

```powershell
ssh YOUR_ADMIN_USER@UBUNTU_IP "sudo parallel-deploy"
```

## Promote standby

Only after the old host/app/ngrok are stopped:

```bash
sudo parallel-go-live
```

Rollback:

```bash
sudo parallel-standby
```
