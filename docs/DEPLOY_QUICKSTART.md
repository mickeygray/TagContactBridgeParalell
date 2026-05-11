# Deploy — come-back-later quick start

Short handoff note so future-you doesn't have to re-derive any of this.
Everything is already staged; three manual steps remain when you're ready.

## Status

| | Status |
|---|---|
| Control-plane code (5001) | ✅ Done — Deploy workspace + commands + GitHub client |
| Frontend (3001) | ✅ Done — Deploy tab with one-click buttons + confirm dialog |
| GitHub Actions workflows | ✅ Written + pre-staged in both site repos, **not yet committed/pushed** |
| GitHub Actions secrets | ⏳ Needs you to paste PEM + host + user into each repo |
| Fine-grained PATs | ⏳ Needs you to generate one per repo |
| Control-plane `.env` entries | ⏳ Needs the 2 PATs + target config JSON |

## Where everything lives

**SSH private keys (on this machine):**
```
C:\Users\Admin\Code\TagContactBridge\.ssh\tag.pem         ← for 3.22.168.127 (TAG)
C:\Users\Admin\Code\TagContactBridge\.ssh\wynntax2.pem    ← for 18.216.244.101 (WYNN)
```
Public halves are already on each EC2 box's `~/.ssh/authorized_keys` (same keys you use for manual SSH).

**Original deploy env values (for reference):**
```
C:\Users\Admin\Code\TagContactBridge\.env
  → DEPLOY_TAG_HOST, DEPLOY_TAG_USER, DEPLOY_TAG_PATH, DEPLOY_TAG_PEM, DEPLOY_TAG_BRANCH, DEPLOY_TAG_PM2
  → DEPLOY_WYNN_HOST, DEPLOY_WYNN_USER, DEPLOY_WYNN_PATH, DEPLOY_WYNN_PEM, DEPLOY_WYNN_PM2
```
Already baked into the workflows — no need to touch this.

**Pre-staged workflow files:**
```
C:\Users\Admin\Code\TaxAdvocateGroup\.github\workflows\
  ├── ssh-check.yml    ← safe connectivity test (run this first)
  └── deploy.yml       ← full / content / restart, preloaded with:
                          REPO_PATH=/var/www/taxadvocategroup
                          PM2_PROCESS=backend
                          (branch master is set via the control-plane target ref)

C:\Users\Admin\Code\WynnTax\.github\workflows\
  ├── ssh-check.yml
  └── deploy.yml       ← REPO_PATH=/var/www/WynnTax, PM2_PROCESS=backend
```

**Long-form setup guide with copy-paste blocks:**
```
C:\Users\Admin\Code\TagContactBridgeParallel\docs\deploy-templates\README.md
```

## The three manual steps when you're ready

### 1. Push the workflows

```bash
cd C:/Users/Admin/Code/TaxAdvocateGroup
git add .github/workflows/ssh-check.yml .github/workflows/deploy.yml
git commit -m "Add deploy + ssh-check workflows"
git push origin master

cd C:/Users/Admin/Code/WynnTax
git add .github/workflows/ssh-check.yml .github/workflows/deploy.yml
git commit -m "Add deploy + ssh-check workflows"
git push origin main
```

### 2. Paste Actions secrets (per repo)

GitHub → repo → Settings → Secrets and variables → Actions.

| Repo | Secret | Value |
|---|---|---|
| `mickeygray/taxadvocategroup` | `AWS_HOST` | `3.22.168.127` |
| | `AWS_USER` | `ubuntu` |
| | `AWS_SSH_PRIVATE_KEY` | full contents of `.ssh\tag.pem` (include BEGIN/END lines) |
| `mickeygray/WynnTax` | `AWS_HOST` | `18.216.244.101` |
| | `AWS_USER` | `ubuntu` |
| | `AWS_SSH_PRIVATE_KEY` | full contents of `.ssh\wynntax2.pem` (include BEGIN/END lines) |

### 3. Generate 2 fine-grained PATs + add to control-plane `.env`

For each repo: GitHub → avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens → *Generate new token*.

- Resource owner: your account
- Repository access: only that one repo
- Permissions: **Actions: Read and write**, Metadata: Read (auto)

Then paste the PAT into `TagContactBridgeParallel/.env`:

```bash
GITHUB_DEPLOY_TARGETS=[{"key":"tag-site","label":"TAG marketing site","workflow":"deploy.yml","ref":"master","company":"TAG","inputs":{"brand":"TAG"},"allowedActions":["full","content","restart"]},{"key":"tag-ssh-check","label":"TAG — SSH check (safe)","workflow":"ssh-check.yml","ref":"master","company":"TAG","allowedActions":["full"]},{"key":"wynn-site","label":"WYNN marketing site","workflow":"deploy.yml","ref":"main","company":"WYNN","inputs":{"brand":"WYNN"},"allowedActions":["full","content","restart"]},{"key":"wynn-ssh-check","label":"WYNN — SSH check (safe)","workflow":"ssh-check.yml","ref":"main","company":"WYNN","allowedActions":["full"]}]

GITHUB_OWNER_TAG_SITE=mickeygray
GITHUB_REPO_TAG_SITE=taxadvocategroup
GITHUB_DEPLOY_TOKEN_TAG_SITE=<paste TAG PAT>
GITHUB_OWNER_TAG_SSH_CHECK=mickeygray
GITHUB_REPO_TAG_SSH_CHECK=taxadvocategroup
GITHUB_DEPLOY_TOKEN_TAG_SSH_CHECK=<paste TAG PAT>

GITHUB_OWNER_WYNN_SITE=mickeygray
GITHUB_REPO_WYNN_SITE=WynnTax
GITHUB_DEPLOY_TOKEN_WYNN_SITE=<paste WYNN PAT>
GITHUB_OWNER_WYNN_SSH_CHECK=mickeygray
GITHUB_REPO_WYNN_SSH_CHECK=WynnTax
GITHUB_DEPLOY_TOKEN_WYNN_SSH_CHECK=<paste WYNN PAT>
```

Restart control-plane.

## Verify

3001 → Admin → Operations → Deploy → click **TAG — SSH check (safe)** → type `tag-ssh-check` → wait ~30s.

- ✅ green row = SSH is good, proceed to a real `content` push first, then `full`.
- ❌ red row = click **Open** to see the log; common failures are in the troubleshooting table of `docs/deploy-templates/README.md`.

## One-line reminders

- TAG branch is `master`, not `main`. WYNN is `main`.
- pm2 process on both boxes is `backend`.
- PEM contents go into GitHub Actions secrets — **never** into any file under a `.git`-tracked path.
- Destructive actions (`full`, `restart`) require typing the target key to confirm, both in the UI and on the backend.
