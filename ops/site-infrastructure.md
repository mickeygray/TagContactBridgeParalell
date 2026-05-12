# Site Infrastructure — TAG + Wynn

The two marketing sites (Tax Advocate Group, Wynn Tax Solutions) live in
separate repos on this machine but share the same shape and the same
deploy pipeline. This doc is the single reference for "where does X
live for site Y" so future changes don't require spelunking.

The Parallel app's blog bot publishes to both sites in lockstep; manual
edits (new landing pages, copy tweaks) are committed locally and
deployed via the shared deploy CLI at `scripts/deploy.js`.

---

## Repos at a glance

| | TAG | Wynn |
|---|---|---|
| Local path | `C:\Users\Admin\Code\TaxAdvocateGroup` | `C:\Users\Admin\Code\WynnTax` |
| GitHub remote | `mickeygray/taxadvocategroup` | (Wynn equivalent — check `git remote -v`) |
| Public URL | https://www.taxadvocategroup.com | https://www.wynntaxsolutions.com |
| EC2 host | `ubuntu@3.22.168.127` | `ubuntu@18.216.244.101` |
| Remote path | `/var/www/taxadvocategroup` | `/var/www/WynnTax/client` |
| PM2 process | `backend` | `backend` |
| Brand interpolation | `Tax Advocate Group` | `Wynn Tax Solutions` |
| Blog entries include header image | **No** | **Yes** (`image: "/images/<slug>.png"`) |

Both sites are CRA-based React apps with `client/` as the React root and
a separate Express `server.js` at repo root that hosts the API. The
`prebuild` step generates a sitemap; `postbuild` runs react-snap to
prerender pages for SEO.

---

## File layout (same for both repos)

```
<RepoRoot>/
├── server.js                       # Express API — runs under PM2
├── package.json                    # Has `install` hook: cd client && npm install + npm run build
├── client/
│   ├── package.json                # scripts: start | prebuild | build | postbuild
│   ├── public/
│   │   └── images/                 # blog header images (Wynn only — TAG renders without)
│   ├── scripts/
│   │   └── generate-sitemap.js     # prebuild — reads route table, emits sitemap.xml
│   ├── src/
│   │   ├── App.js                  # route table + BARE_ROUTES list (no nav/footer pages)
│   │   ├── data/
│   │   │   └── blogData.js         # array of blog entries — bot prepends here
│   │   └── components/             # one file per page/landing; register routes in App.js
│   └── build/                      # tracked in git (yes, on purpose — rollback safety)
└── .gitignore                      # excludes node_modules + .env*
```

**`client/build/` is checked in.** Unusual, but intentional — committed builds let `git pull` on EC2 ship working pages even if `npm install` fails. The auto-blog commits include the regenerated build artifacts.

---

## Adding a new landing page

1. Create `client/src/components/MyNewPage.js`
2. In `client/src/App.js`:
   - Add an import for the component
   - Add a `<Route path="my-new-page" element={<MyNewPage />} />`
   - If it's a bare lander (no nav/footer), add `"/my-new-page"` to `BARE_ROUTES`
3. If you want it prerendered for SEO, add the path to `client/package.json`'s `reactSnap.include` array
4. Test locally: `cd client && npm start`
5. When ready: `git add -A && git commit -m "Add /my-new-page landing"`
6. Deploy: `node scripts/deploy.js deploy <tag|wynn> --pull`

---

## Adding a new blog post (manual — bypassing the bot)

The blog bot is the canonical writer. If you need to publish manually
(one-off, off-cadence post), the cleanest path is via the one-off
script pattern:

1. Drop a draft JSON in `scripts/blog-drafts/<slug>.json` (see existing entries for shape — `{id, title, teaser, contentTitle, contentBody, slide, ...}`). Use `{brand}` as a placeholder for brand name in `contentBody` strings.
2. Either:
   - Write a one-off wrapper script like `scripts/blogger-one-off-2.js` that calls `publishBlog(draft)`
   - OR manually prepend the entry to both `blogData.js` files (TAG without `image:`, Wynn with) and run the deploy CLI for each
3. The pipeline's `prependBlogToFile` throws on duplicate slug — safe to retry if a step fails.

---

## The blog bot pipeline (`scripts/blogger-*`)

| script | role |
|---|---|
| `blogger-daemon.js` | Long-running daemon that fires the daily runner on a cron |
| `blogger-daily-runner.js` | Picks the day's topic + invokes `publishBlog`. Updates `scripts/blogger-state.json` |
| `blogger-post-pipeline.js` | The publish pipeline: image render → mutate both blogData.js → build both → deploy both → email summary. Rollback path handles deploy-mid-failure cleanly. |
| `blogger-claude-writer.js` | Generates a draft via Claude given a topic |
| `blogger-corpus.js` | Topic corpus + day-of-week rotation logic |
| `blogger-one-off-*.js` | Manual one-shot publishers (legacy patterns) |
| `blogger-state.json` | Persistent state: `lastRunDate`, `lastPostedId`, `lastFridayCategory` |

**Pipeline behavior** (after the 2026-05-12 hardening):

- Preflight checks: draft shape, required env vars, **both repos clean** (with auto-restore for known bot-owned files when HEAD is a recent `Auto blog:` commit), deploy CLI configured
- Snapshots both `blogData.js` files BEFORE mutation
- Renders header image (Wynn only — TAG entries omit `image:` field)
- Mutates both `blogData.js` files via `prependBlogToFile`, which **throws on duplicate slug**
- Builds both clients (`cd client && npm run build`)
- Deploys Wynn first via `node scripts/deploy.js deploy wynn "Auto blog: <slug>" --pull`
- Then deploys TAG
- On any failure mid-flight: rolls back EC2 for any brand that already deployed; **only** restores working trees for repos that did NOT yet commit (avoids creating "uncommitted reverts")

**State write rules**:
- `state.lastRunDate` always advances (we don't retry the same day)
- `state.lastPostedId` advances **only on success** (state file should not lie about what's live)

---

## Deploying — CLI reference

The deploy CLI is at `scripts/deploy.js` (ported from legacy, lives in
Parallel/scripts/). Reads `DEPLOY_TAG_*` / `DEPLOY_WYNN_*` env vars
from `.env`.

```bash
# Local commit → push → SSH pull on EC2 → npm install → pm2 restart
node scripts/deploy.js deploy tag --pull        # full pipeline, you push first
node scripts/deploy.js deploy tag               # build + deploy, no git
node scripts/deploy.js deploy tag --skip        # deploy existing build, skip rebuild
node scripts/deploy.js deploy tag --dry         # verify only, no swap

node scripts/deploy.js restart tag              # pm2 restart only
node scripts/deploy.js rollback tag             # revert EC2 to previous commit
node scripts/deploy.js status tag               # what's live on EC2
node scripts/deploy.js sites                    # list configured sites

# Same commands work for wynn:
node scripts/deploy.js deploy wynn --pull
node scripts/deploy.js status wynn
```

---

## Env vars required

In `apps/web-client/.env` or Parallel root `.env`:

```
# TAG site
DEPLOY_TAG_HOST=3.22.168.127
DEPLOY_TAG_USER=ubuntu
DEPLOY_TAG_PEM=<path to tag.pem SSH key>          # WINDOWS-PATH TODAY — needs Linux path on AWS migration
DEPLOY_TAG_PATH=/var/www/taxadvocategroup
DEPLOY_TAG_PM2=backend
DEPLOY_TAG_BRANCH=master

# Wynn site
DEPLOY_WYNN_HOST=18.216.244.101
DEPLOY_WYNN_USER=ubuntu
DEPLOY_WYNN_PEM=<path to wynn.pem SSH key>
DEPLOY_WYNN_PATH=/var/www/WynnTax
DEPLOY_WYNN_PM2=backend
DEPLOY_WYNN_BRANCH=master
```

Each sales-site EC2 also needs its own `.env` for the contact-form webhook
back to Parallel:

```
# Both TAG and Wynn EC2 .env (deployed on each host, NOT in git)
WEBHOOK_URL=https://tagcontactbridge.ngrok.app   # Parallel public tunnel
LEAD_WEBHOOK_SECRET=<shared secret — matches Parallel root .env>
```

`WEBHOOK_URL` historically pointed at the legacy monolith's tunnel
(`tag-webhook.ngrok.app`) which is now offline. If the env is missing
or stale, `server.js` falls back to `DEFAULT_WEBHOOK_BASE_URL`
(`https://tagcontactbridge.ngrok.app`) — see the `postToWebhook` helper
in each repo's `server.js`. The receiver side (Parallel
`/lead-contact`) reads `body.company` (`TAG` / `WYNN`) to namespace
pre-ping lookup and lock the contactDomain on the resulting lead.

---

## Lead webhook routing — sales page → Parallel

```
Sales page form submit (TAG or Wynn)
  → POST https://tagcontactbridge.ngrok.app/lead-contact
     headers: x-webhook-key: <LEAD_WEBHOOK_SECRET>
     body:    { name, email, phone, ..., source: "website", company: "TAG"|"WYNN" }
  → ngrok edge → nginx :81
  → location = /lead-contact → proxy_pass parallel_cp (control-plane :5001)
  → app.all("/lead-contact", inboundProxy)
  → inbound-gateway :4001 /lead-contact
  → validateLegacyLeadWebhook (accepts x-webhook-key)
  → prePingRepository.findPrePing(body.company, emailHash)
       hit?  → intakeLdLead (LD vendor path, WYNN-only by business arrangement)
       miss? → pickLegacyLeadHandler → intakeWebsiteLead
  → intakeWebsiteLead
       → normalizeWebsiteLeadPayload  (resolveCompanyFromPayload → "TAG"|"WYNN")
       → lockResolvedContactDomain    (locks contactDomain to resolved value)
       → intakeNormalizedLead          (writes lead, fires downstream pipeline)
```

The receiver-side `lockResolvedContactDomain` replaced the old
`forceWynnContactDomain` for the website path — the latter
unconditionally clobbered the domain to WYNN, which mis-tagged TAG
sales-page leads. Facebook / Instagram / TikTok intake paths still use
`forceWynnContactDomain` since those funnels are Wynn-only.

---

## Outage post-mortem (2026-05-08 → 2026-05-12)

For posterity (so we don't make the same call again):

1. **2026-05-08**: Bot picked "Currently Not Collectible" topic for the day. Preflight passed (both repos clean). Image rendered, blogData.js mutated on both repos, both clients built.
2. Wynn deploy succeeded (commit `e57fd46` pushed, EC2 pulled, PM2 restarted).
3. TAG deploy failed (cause undetermined — likely transient SSH/network).
4. Rollback fired and:
   - Rolled back Wynn EC2 to previous commit (correct).
   - Restored Wynn's local `blogData.js` to pre-mutation snapshot (BUG: commit was already pushed).
   - Deleted the rendered image file (BUG: same — already committed via deploy).
5. State file advanced `lastPostedId: CNC` even though publish failed (BUG: state.lastPostedId only update path didn't gate on `summary.failed`).
6. Result: Wynn's working tree showed `D` on the image + 55-line revert on blogData.js while git HEAD contained the CNC post. TAG had no post at all.
7. The dirty state sat for 4 days because every subsequent bot run's preflight saw the uncommitted changes and bailed — `state.lastRunDate` kept advancing without publishing.
8. **2026-05-12**: Cleanup. Working trees restored (`git restore .` on Wynn). CNC entry manually backfilled into TAG, committed (`707999b`), deployed.

**Hardening that landed same day** (in `scripts/blogger-*.js`):
- Preflight auto-restores bot-owned dirty files when HEAD is a recent `Auto blog:` commit (catches the same pattern next time)
- Rollback path now checks deploy-committed flag before restoring working tree or deleting the image
- State file `lastPostedId` only advances on success
- `prependBlogToFile` throws on duplicate slug (defense in depth)
