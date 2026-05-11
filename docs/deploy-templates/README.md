# One-click deploy — setup guide

Workflows + values extracted from the existing `TagContactBridge/.env`. Since
you already deploy these boxes manually over SSH, most of the infrastructure
(EC2 hosts, security groups, authorized_keys) is already in place. The
remaining work is wiring GitHub Actions to use those same credentials.

> **Pre-installed in both site repos:**
> - `C:/Users/Admin/Code/TaxAdvocateGroup/.github/workflows/{ssh-check,deploy}.yml` (branch `master`, path `/var/www/taxadvocategroup`, pm2 `backend`)
> - `C:/Users/Admin/Code/WynnTax/.github/workflows/{ssh-check,deploy}.yml` (branch `main`, path `/var/www/WynnTax`, pm2 `backend`)
>
> Just commit + push (Step 1 below).

---

## Step 1 — Commit + push the workflow files

From each site repo:

```
cd C:/Users/Admin/Code/TaxAdvocateGroup
git add .github/workflows/ssh-check.yml .github/workflows/deploy.yml
git commit -m "Add deploy + ssh-check workflows"
git push origin main

cd C:/Users/Admin/Code/WynnTax
git add .github/workflows/ssh-check.yml .github/workflows/deploy.yml
git commit -m "Add deploy + ssh-check workflows"
git push origin main
```

GitHub indexes the workflows within seconds of the push.

## Step 2 — Add Actions secrets to each site repo

GitHub → repo → Settings → Secrets and variables → Actions → *New repository secret*.

Values extracted from the live `TagContactBridge/.env` — paste these exactly:

**For `mickeygray/taxadvocategroup`:**

| Secret | Value |
|---|---|
| `AWS_HOST` | `3.22.168.127` |
| `AWS_USER` | `ubuntu` |
| `AWS_SSH_PRIVATE_KEY` | full contents of `C:\Users\Admin\Code\TagContactBridge\.ssh\tag.pem` |
| `AWS_SSH_PORT` | *(leave unset; defaults to 22)* |

**For `mickeygray/WynnTax`:**

| Secret | Value |
|---|---|
| `AWS_HOST` | `18.216.244.101` |
| `AWS_USER` | `ubuntu` |
| `AWS_SSH_PRIVATE_KEY` | full contents of `C:\Users\Admin\Code\TagContactBridge\.ssh\wynntax2.pem` |
| `AWS_SSH_PORT` | *(leave unset; defaults to 22)* |

> **Paste the PEM raw.** Include the `-----BEGIN RSA PRIVATE KEY-----` header and
> the `-----END RSA PRIVATE KEY-----` footer, and every line between them. Don't
> base64 it, don't strip newlines. `appleboy/ssh-action` handles both OpenSSH
> and PEM formats automatically.

The public half of each key is already on the respective EC2 box's
`~/.ssh/authorized_keys` — you've been using them for manual SSH deploys, so
they're good to go.

## Step 3 — Confirm security group allows SSH from GitHub runners

You already SSH to both boxes from your laptop, so the security group is
already open on port 22. Whether GitHub's rotating runner IPs are also allowed
depends on how narrow the existing rule is.

- If your SG inbound rule for 22/tcp is `0.0.0.0/0`: nothing to do; GitHub
  runners will work immediately.
- If it's scoped to your laptop's IP only: widen to `0.0.0.0/0` (key auth
  keeps you safe) *or* add GitHub's runner CIDRs from `https://api.github.com/meta`.
- If you'd rather not open any inbound SSH at all: install a GitHub self-hosted
  runner on each EC2 box — the runner polls outbound to github.com and the
  workflow runs locally on the box. Tell me and I'll swap the workflows to
  `runs-on: self-hosted` + plain `run:` blocks.

## Step 4 — Create a fine-grained PAT per repo

GitHub → top-right avatar → Settings → Developer settings → Personal access
tokens → Fine-grained tokens → *Generate new token*.

For each repo:

- **Resource owner:** your org (or user)
- **Repository access:** *Only select repositories* → pick just the site repo
- **Permissions:** under "Repository permissions" set
  - **Actions** → *Read and write* (required to dispatch + cancel)
  - **Metadata** → *Read-only* (required automatically)
- Generate, copy the token, **paste into the control-plane `.env` immediately**
  — GitHub only shows it once.

## Step 5 — Control-plane env

In the `.env` file the `control-plane` process reads:

```bash
# Targets — no secrets in this JSON. Note TAG uses ref=master, WYNN ref=main.
GITHUB_DEPLOY_TARGETS=[
  {
    "key": "tag-site",
    "label": "TAG marketing site",
    "workflow": "deploy.yml",
    "ref": "master",
    "company": "TAG",
    "inputs": { "brand": "TAG" },
    "allowedActions": ["full", "content", "restart"]
  },
  {
    "key": "tag-ssh-check",
    "label": "TAG — SSH check (safe)",
    "description": "Read-only SSH connectivity test",
    "workflow": "ssh-check.yml",
    "ref": "master",
    "company": "TAG",
    "allowedActions": ["full"]
  },
  {
    "key": "wynn-site",
    "label": "WYNN marketing site",
    "workflow": "deploy.yml",
    "ref": "main",
    "company": "WYNN",
    "inputs": { "brand": "WYNN" },
    "allowedActions": ["full", "content", "restart"]
  },
  {
    "key": "wynn-ssh-check",
    "label": "WYNN — SSH check (safe)",
    "workflow": "ssh-check.yml",
    "ref": "main",
    "company": "WYNN",
    "allowedActions": ["full"]
  }
]

# Per-target credentials. Env-var suffix = target key uppercased,
# with non-alphanumerics → underscores. "tag-site" → TAG_SITE.
# SSH-check targets share the owner/repo/token with the main target since
# they live in the same repo.

GITHUB_OWNER_TAG_SITE=mickeygray
GITHUB_REPO_TAG_SITE=taxadvocategroup
GITHUB_DEPLOY_TOKEN_TAG_SITE=github_pat_xxx_TAG

GITHUB_OWNER_TAG_SSH_CHECK=mickeygray
GITHUB_REPO_TAG_SSH_CHECK=taxadvocategroup
GITHUB_DEPLOY_TOKEN_TAG_SSH_CHECK=github_pat_xxx_TAG

GITHUB_OWNER_WYNN_SITE=mickeygray
GITHUB_REPO_WYNN_SITE=WynnTax
GITHUB_DEPLOY_TOKEN_WYNN_SITE=github_pat_yyy_WYNN

GITHUB_OWNER_WYNN_SSH_CHECK=mickeygray
GITHUB_REPO_WYNN_SSH_CHECK=WynnTax
GITHUB_DEPLOY_TOKEN_WYNN_SSH_CHECK=github_pat_yyy_WYNN
```

> **Shortcut:** if you don't want to repeat the env vars per ssh-check target,
> you can set the `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_DEPLOY_TOKEN` global
> defaults to whichever repo is your "main" one and only define the suffixed
> vars for the other. Target resolution falls back to the globals when a
> target-specific var isn't set. The per-target pattern is cleaner when you
> have two different repos.

Restart the control-plane after editing `.env`.

## Step 6 — Verify end to end

1. Open 3001 → Admin → Operations → Deploy.
2. The page should now show your targets. Each should say **ready** (no warning
   pill). If one says `needs token + owner`, recheck the env var spelling.
3. Click **Deploy** on `TAG — SSH check (safe)`.
4. Type `tag-ssh-check` into the confirm dialog → click the green button.
5. Within ~15–30 seconds a new run should appear in **Recent runs** (the feed
   polls every 10 s). Click **Open** to see the live logs on GitHub.
6. Expected output in the `Verify SSH reaches the instance` step:

   ```
   === SSH OK ===
   user=ubuntu
   host=ip-10-0-xx-xx
   uptime=up 42 days
   disk: ...
   node=v20.11.x
   pm2=5.x
   git=git version 2.x
   ```

If you see that, SSH works. Move on to a real `tag-site` deploy with a `content`
push first (safer than `full`), then `full` when you're ready.

## Troubleshooting the SSH check

| Failure | Likely cause | Fix |
|---|---|---|
| Run never appears in the feed | PAT is wrong, or owner/repo env var misspelled | Check control-plane logs for `GitHub POST /... failed (401 or 404)`. Re-verify `GITHUB_*_TAG_SSH_CHECK` values. |
| Run appears but immediately fails with "no workflow file" | `ssh-check.yml` not committed to `main` yet | Push it and re-dispatch. GitHub only indexes files on the ref you pass. |
| Run fails on `Verify SSH` step with "Permission denied (publickey)" | Private key doesn't match the public key on the box, or wrong user | Regenerate the keypair, add public half to `~/.ssh/authorized_keys`, paste private half into `AWS_SSH_PRIVATE_KEY` |
| "ssh: connect to host ... port 22: Connection timed out" | Security group blocks GitHub runner IP | Use option A, B, or C from Step 3 |
| "Host key verification failed" | You enabled `strict_host_key_checking: yes` somewhere | Leave it at default (off) for the runner, or pre-provision known_hosts |

## When you're ready for real deploys

1. Edit `deploy.yml` — the three `TODO` comments mark where to put your repo
   path, build command, and the pm2 process name.
2. Test `content` action first. It's narrower-blast-radius than `full`.
3. Once `full` works, you're done — the restart target also runs on the same
   workflow and just does a pm2 restart.

## What happens on every click

For every button press, the control-plane writes a `WorkflowRecord` with
`family=deploy`, `actorEmail=your-email`, `targetKey`, `action`, `owner`,
`repo`, `dispatchedAt`, any note you typed, and the workflow inputs. Query via
`/api/workflows?family=deploy` or look at the audit log directly in Mongo.

Destructive actions (`full`, `restart`) require typing the target key to
confirm both in the UI and on the backend — the API refuses the dispatch if
`confirm !== targetKey`. Content pushes are instant.
