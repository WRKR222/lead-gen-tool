# Chunguza Growth Platform

The operating system for **Chunguza, an AI lead-generation agency**. A business
(Company X) hires Chunguza; Chunguza finds leads for X (other companies, or people
such as dental patients), contacts them through the channels that work, books
meetings with decision makers, and keeps X's customers from leaving.

Full product and design docs: [`docs/PRD.docx`](docs/PRD.docx),
[`docs/Architecture_Plan_v3.docx`](docs/Architecture_Plan_v3.docx),
[`docs/OOAD_Specification_v3.docx`](docs/OOAD_Specification_v3.docx).

## What it does

- **Two kinds of workspace.** The agency workspace finds and signs Chunguza's own
  clients (stage 1 *find clients* → stage 2 *sign clients*). Each client gets a
  workspace (stage 3 *get results*) that the agency opens from the top-bar switcher.
  Client users only ever see their own workspace.
- **Every lead is clickable** and holds all of its contact means (phones, emails,
  WhatsApp, Instagram, Facebook, LinkedIn, TikTok, X, website, address), each
  labelled with who it belongs to (owner, reception, main line).
- **Ranked outreach methods**: door to door (best) → cold calling → multi-platform
  digital → email & DMs (auto). Pick one or more, get AI guidance for each, record
  the result against the five **meeting standards** (decision maker, straight to
  the point with a hook, scarcity, never pitch before the meeting, a no before a yes).
- **CPS meetings** (Attention → Identify → Solve → Cost): a brief is generated
  on booking; the outcome, notes and quoted price are recorded.
- **Outcomes**: converted / on the fence / said no (with a reason) / not responded.
  A converted agency lead becomes a client in one click.
- **Follow-up cadence** for non-responders (days 2, 4, 7, 14, 21; at most 4 touches
  in 30 days; then nurture every 60 days), rotating to the strongest method not used
  last. Emails go out automatically; other methods become tasks.
- **Bulk email** (one template, merge fields) or a **bespoke AI email per lead**,
  with unsubscribe, suppression, warm-up and rate limits.
- **Real-time replies**: IMAP polling or a webhook. Each reply is matched to its lead
  and classified, the bell and a toast fire live (SSE), and a bot drafts or sends a
  reply that steers towards the meeting. Opt-out words always unsubscribe.
- **Value pyramid** per workspace in the local currency (free value → lifetime
  value), giving value per customer and per lead. **Growth plan** for the four-step
  AI funnel on one ad platform.
- **Business profile upload** (Word/PDF/text) for AI analysis. **Customers** by
  count or Excel/CSV import; lost customers are registered with a reason.
- **Analytics**: leads, meetings, methods, standards adherence, customer churn,
  client churn and health, MRR, daily and monthly summaries. **AI learning**
  suggests better methods from the loss reasons.
- **Integrations**: HighLevel contact upsert and an Appointwise webhook. Carried over
  from v2: the content studio and the tool-using AI assistant (it now logs attempts,
  sets outcomes, lists due follow-ups and reads analytics).

Every AI feature has a deterministic fallback, so the whole product works with no
API key (or with `MOCK_MODE=true`).

## Architecture

```
src/
  server.js                 Express entrypoint, routers, JSON error handler, scheduler start
  config/playbook.js        Single source of truth: stages, methods, results, standards, CPS, funnel, cadence
  config/currencies.js      Country -> currency (+ approximate FX for fallback templates)
  middleware/auth.js        JWT + workspace resolution (X-Workspace-Id) + role guards
  services/
    llm.js                  Anthropic SDK gateway (model, effort, refusal fallback, JSON helpers)
    workspaceService.js     Agency/client workspaces, invites, health score, client churn
    leadsService.js         Lead shape, contacts, detail, status
    outreachService.js      Method preparation, attempts, outcomes
    cadenceService.js       Follow-up policy; followUpService.js runs it; scheduler.js ticks it
    bulkEmailService.js     Template/bespoke compose and rate-limited send
    inboxService.js         Inbound match/classify/draft/auto-reply; imapPoller.js polls a mailbox
    notificationService.js  Notifications + SSE pub/sub
    customersService.js     Customers, import, lost/reactivate, churn stats
    analyticsService.js     Workspace and agency analytics; insightsService.js does learning + summaries
    valuePyramidService.js  Value pyramid; strategyService.js growth plan; meetingPrepService.js CPS brief
    documentService.js      docx/pdf/xlsx/csv text extraction
    integrationsService.js  HighLevel + Appointwise (SSRF-guarded)
    ... v2 services (lead sources, scoring, email, calls, tasks, meetings, assistant, content)
  routes/                   auth, workspaces, companies, leads, outreach, followups, inbox, inbound (public),
                            notifications, customers, analytics, integrations, playbook, meetings + v2 routers
  db/                       schema.sql, database.js (idempotent v2 -> v3 migration), migrate.js
public/
  app.html, css/app.css     App shell (workspace switcher, bell, sidebar, drawer)
  js/app/                   core.js, charts.js, main.js (router, SSE) and views/*.js
  index.html, register.html, login.html
```

## Setup

```bash
npm install
cp .env.example .env      # fill in real credentials (see below for what's required vs optional)
npm run migrate
npm run dev                # or: npm start
```

Open `http://localhost:4000`, register a company, and you're in the
dashboard (`/app.html`).

### Zero-cost demo mode (no API keys, no signups)

Every AI-touching service in this app follows the same pattern: call a
real provider when its key is configured, otherwise fall back to a
realistic mock/heuristic so the *entire* product - onboarding, geo-scoped
multi-source discovery, scoring, call scripts, email generation and
sending, the content studio, and the AI assistant's read-only answers -
works end to end for free. Just:

```bash
npm install
echo "PORT=4000" > .env
echo "JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || echo dev-secret-change-me)" >> .env
npm run migrate
npm run dev
```

Register a company with a real description of what it does - the AI
profiling step's mock fallback still reads your description and adjusts
industries/keywords from it, it just doesn't call a paid model. The AI
assistant's mock fallback only answers a couple of canned, read-only
questions ("what are my top leads", "what tasks are open") - the full
tool-using assistant needs `ANTHROPIC_API_KEY` because deciding what
action to take is exactly what the model is for.

### Credentials (add incrementally - each is independent)

| Variable | Powers |
|---|---|
| `JWT_SECRET` | Required. Session auth. |
| `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_MODEL`, default `claude-opus-5`) | Every AI feature: profiling, value pyramid, growth plan, outreach guidance, emails, CPS briefs, reply bot, learning, summaries, assistant, content. |
| `CLAY_API_KEY` / `EXPLORIUM_API_KEY` | Lead sourcing from Clay / Explorium. |
| `SERPAPI_API_KEY` or `BING_SEARCH_API_KEY` | Web-research lead sourcing. |
| `SMTP_*`, `FROM_NAME`, `FROM_EMAIL` | Actually sending campaign emails (falls back to a free Ethereal.email sandbox, or a console-only stub with zero network). |
| `OPENAI_API_KEY` (+`IMAGE_PROVIDER=openai`) | Real graphics generation (falls back to a generated placeholder graphic). |
| `VIDEO_API_BASE`/`VIDEO_API_KEY` | Real video-ad generation (falls back to a text storyboard) - see `videoGenerationService.js` for wiring a specific provider. |
| `IMAP_HOST`/`IMAP_USER`/`IMAP_PASS` (+`IMAP_PORT`, `IMAP_SECURE`, `IMAP_MAILBOX`, `IMAP_WORKSPACE_ID`) | Live reply detection by polling the mailbox that leads reply to. Alternative: point your email provider's inbound webhook at `POST /api/inbound/email/<workspace inbound token>` (shown in Settings). |
| `HIGHLEVEL_API_KEY`, `HIGHLEVEL_LOCATION_ID` | Push leads to HighLevel (contact upsert). |
| `APPOINTWISE_WEBHOOK_URL` | Hand leads to Appointwise (a per-workspace URL in Settings overrides it). |
| `GOOGLE_CALENDAR_CLIENT_ID/SECRET` | Optional push-to-Google-Calendar (meetings always produce a working `.ics` invite with zero configuration). |

See `.env.example` for the full list with explanations.

## Core workflow

1. **Register the agency** at `/register.html?type=agency`. Clients sign up with the
   agency's link (`/register.html?agency=<agency code>`), or the agency adds them
   under **Clients** and creates their login with *Invite login*.
2. **Find clients**: Leads → *Find leads* (niche + area), or import a list. Open a
   lead, pick methods, *Prepare*, then record each attempt.
3. **Sign clients**: book the meeting (a CPS brief is generated), record the outcome,
   then *Sign as client*.
4. **Get results**: switch to the client workspace. Upload the business profile,
   review the value pyramid and growth plan, find or import leads, run outreach and
   bulk email, and answer replies from **Inbox**.
5. **Retain**: import customers and mark losses with a reason. Watch client health,
   churn and the monthly summary under **Analytics**.

## Compliance - read before sending real bulk email

Built-in guardrails (do not remove): every email gets a working one-click
unsubscribe link and `List-Unsubscribe` header; unsubscribes/bounces/spam
complaints are suppressed per company, forever, automatically; sending is
rate-limited and domain warm-up ramps volume gradually. Each company using
this platform is responsible for having a lawful basis to email each
contact in its jurisdiction (opt-out regimes like the US/CAN-SPAM vs.
largely opt-in regimes like the EU/UK GDPR-PECR and Canada/CASL) - this is
general information, not legal advice.

The web-research lead source deliberately does not scrape LinkedIn or
other social platforms directly (that breaks their Terms of Service); it
uses licensed search APIs to find public pages/snippets instead. For
LinkedIn specifically, the compliant path to that data is LinkedIn's own
official APIs/Sales Navigator, pluggable here as another source once you
have that access.

## Deploying

### Option A - Docker (recommended: VPS or any container host)

```bash
cp .env.example .env      # fill in real credentials
docker compose build
docker compose up -d
docker compose logs -f
```

The SQLite DB persists in the `leadgen_data` named volume across restarts
and redeploys - don't remove that volume unless you want to wipe your data.

Put this behind TLS: see `deploy/nginx.conf.example` for an nginx reverse
proxy config (get a cert with `certbot --nginx -d yourdomain.com` first).

### Option B - Railway / Render / Fly.io (fastest)

- **Render**: push to GitHub, then "New -> Blueprint" pointing at this
  repo - `render.yaml` is already set up with a persistent disk for the
  SQLite file and placeholders for every required secret (set the real
  values in the Render dashboard, not in the file).
- **Railway/Fly.io**: same idea - build command `npm install`, start
  command `node src/db/migrate.js && node src/server.js`, attach a
  persistent volume mounted at `/app/data`. Set every var from
  `.env.example` in the platform's environment/secrets UI.

### Option C - Plain VPS with PM2 (no Docker)

```bash
git clone <your repo> && cd leadgen-tool
npm install --omit=dev
cp .env.example .env && vim .env
npm run migrate
npm install -g pm2
pm2 start deploy/ecosystem.config.js
pm2 save && pm2 startup     # survives reboots
```
Then put nginx (`deploy/nginx.conf.example`) in front for TLS.

### Deployment checklist

- [ ] `.env` is never committed - it's already git-ignored; on your host,
      set secrets via the platform's secret manager.
- [ ] `JWT_SECRET` is a real random value, not the default.
- [ ] SQLite data directory is on a **persistent volume/disk**.
- [ ] Real domain + SPF/DKIM/DMARC records for `FROM_EMAIL`'s domain.
- [ ] `PUBLIC_BASE_URL` matches your real deployed URL (unsubscribe links,
      future OAuth redirects).
- [ ] TLS is on.
- [ ] `MAX_EMAILS_PER_HOUR`/`MAX_EMAILS_PER_DAY` set conservatively at
      first per company.

## Upgrading from v2

Nothing to do: `node src/db/migrate.js` (run on every start) adds the v3 columns
and tables, makes `leads.company_name` nullable (a one-time rebuild inside a
transaction), and backfills currency, inbound tokens and lead contacts. Existing
companies stay usable as stand-alone workspaces. After Chunguza registers its agency
workspace, set `ALLOW_AGENCY_SIGNUP=false` so nobody else can create one.

## Upgrading from v1 (single-tenant)

v1 had no `company_id` on any table. `src/db/database.js` detects an old
database automatically on `npm run migrate`: it renames every old table to
`<table>_v1_backup` (nothing is deleted) and creates the fresh multi-tenant
v2 schema. Export anything you need from the `*_v1_backup` tables, then
re-register your company and re-import/re-run discovery.

## Extending

- Swap `better-sqlite3` for Postgres by replacing `src/db/database.js` -
  the rest of the app only uses `db.prepare(...).run/get/all`.
- Add a new lead source: implement `{ search(filters, limit) }` and
  register it in `leadSourceRegistry.js`.
- Add a new content type or generation provider: follow the pattern in
  `contentService.js`/`imageGenerationService.js`/`videoGenerationService.js`
  (real call behind an env-configured key, mock fallback otherwise).
- Give the AI assistant a new capability: add a tool definition + a case
  in `executeTool()` in `assistantService.js` - nothing else changes.
- Change the model or AI behaviour in one place: `src/services/llm.js`
  (model, effort, refusal fallback) and `src/config/playbook.js` (the rules
  every prompt and template follows).

## Brand mark (3D logo)

`public/js/chunguza-logo-model.js` is the real Chunguza logo: a procedural
Three.js model (an open "C" ring catching a lead, plus the "chunguza"
wordmark) rather than a static image, so it renders crisp at any size and can
be re-lit/re-colored without a designer round-trip.

- `public/js/logoViewer.js` mounts it into any `<canvas data-chunguza-logo="mark|full">`
  on the page (`mark` = ring only, for nav bars; `full` = ring + wordmark, for
  the landing-page hero) and slowly auto-rotates it. It is wired into
  `index.html` (hero), `login.html`/`register.html` (nav), and `app.html` (nav).
- Three.js itself is **vendored locally** at `public/js/vendor/three/` (not
  loaded from a CDN) so the mark keeps working behind restrictive corporate
  networks or if a CDN is down - the only remaining network call is an
  optional fetch of the Poppins font for the wordmark; if that fetch fails
  (offline, blocked domain), the model falls back to its own built-in
  geometric letterforms automatically.
- Same real-integration + safe-fallback idiom as the rest of this codebase:
  if WebGL is unavailable or anything above throws, `logoViewer.js` catches
  it and simply leaves the plain-text "C" badge that already sits next to
  each canvas (`[data-logo-fallback]`) visible - the page never breaks.
- To refresh the vendored Three.js version: `npm install three@<version>`
  in a scratch folder, then copy `build/three.module.js`,
  `examples/jsm/loaders/{FontLoader,TTFLoader}.js`, and
  `examples/jsm/libs/opentype.module.js` into `public/js/vendor/three/`
  (same relative layout), and update the two `"three"` / `"three/addons/"`
  entries in each page's `<script type="importmap">` if the path changed.
