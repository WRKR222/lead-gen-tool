# Chunguza Growth Platform

A multi-tenant, AI-personalized lead-generation and growth platform. Any
company registers, describes what it does and what it wants from the tool,
and an AI immediately synthesizes that company's own ideal-customer
profile, geo strategy, scoring weights, outreach tone and sales narrative -
so the tool behaves differently for every company, not as one generic
template. From there, a company can:

- Search for prospects **within Nairobi, nationally (Kenya), across East
  Africa, Africa, or globally** - sourced from multiple providers in
  parallel (Clay, Explorium/Vibe Prospecting, AI-assisted web research, and
  CSV import), not locked to any one vendor.
- Score every lead with a **self-improving model** that retrains on every
  outcome you log (reply, meeting booked, closed won/lost, ...), per
  company.
- Run **AI cold-calling**: generates a call script (opener, discovery
  questions, objection handling, close) per lead, logs outcomes, and
  automatically creates follow-up tasks - like a sales manager coaching a
  rep.
- Send **AI-generated, per-lead-unique cold email campaigns** with
  built-in compliance guardrails (unsubscribe, suppression, rate limits,
  domain warm-up).
- Use a **content studio**: sales pitches, ad ideas + ad copy, a rolling
  social media content plan, on-brand graphics, and video-ad
  concepts/storyboards (pluggable toward a real video-generation
  provider).
- Delegate to an **AI sales assistant** that can search leads, log calls,
  create tasks, schedule meetings (with a real downloadable calendar
  invite), draft emails, and generate content on its own - in chat, or
  running autonomously on a schedule.

## Architecture

```
src/
  server.js                     Express entrypoint, route wiring, optional autonomous-assistant loop
  config/
    directions.default.json     Fallback seed shape only - each company's real directions now live in the DB
  middleware/
    auth.js                     JWT verification -> req.auth = { userId, companyId, role }; role gate
  services/
    authService.js              bcrypt + JWT
    companyProfileService.js    AI: turns a company's description into its full directions profile (onboarding)
    directionsService.js        Per-company directions read/write (companies.ai_profile_json)
    geoExpansion.js             Named geo scopes (nairobi/kenya/east_africa/africa/global) + v1 auto-expansion tiers
    leadSourceRegistry.js       Pluggable multi-source lead discovery (fan-out + merge)
    clayService.js              Clay API wrapper
    vibeProspectingService.js   Explorium/Vibe Prospecting API wrapper
    webResearchLeadService.js   Licensed web-search API + AI extraction (not scraping)
    csvImportService.js         Manual/CSV lead import
    mockDataService.js          Zero-cost realistic fake data for every source, in demo mode
    leadScoring.js              Online logistic-regression scorer, per company
    emailGenerationService.js   Per-lead-unique cold email generation, aware of send history
    emailService.js             SMTP sending, per-company suppression list, rate limiting, warm-up, unsubscribe
    callsService.js             AI call-script generation
    tasksService.js             Task CRUD (human- or AI-created)
    meetingsService.js          Meeting scheduling + real .ics generation (calendar-API-ready)
    assistantService.js         AI sales assistant: Anthropic tool-use agent loop + autonomous mode
    contentService.js           Sales pitch / ad copy / social plan generation
    imageGenerationService.js   Pluggable graphics generation (OpenAI Images, or local placeholder)
    videoGenerationService.js   Pluggable video-ad generation (generic submit/poll job API, or storyboard fallback)
  routes/
    auth.js, companies.js       Registration (= onboarding), login, company/directions settings
    leads.js                    Discover (geo-scoped, multi-source), list, CSV import, feedback
    campaigns.js                Create/preview/send AI email campaigns
    calls.js                    Call scripts, logging, auto follow-up tasks
    tasks.js, meetings.js       Task and meeting CRUD, .ics download
    assistant.js                AI assistant chat + autonomous run
    content.js                  Content studio endpoints
  db/
    schema.sql, database.js, migrate.js   SQLite, multi-tenant (swap database.js for Postgres in production)
public/
  index.html      Landing page
  register.html   Registration = AI onboarding wizard
  login.html      Login
  app.html        Authenticated multi-tab dashboard (Leads / Calls / Tasks & Meetings / Content Studio / AI Assistant / Settings)
  shared.js       Auth/session + API fetch helper shared by every page
```

## How it satisfies each requirement

- **Adaptable to any company, AI/ML-personalized**: registration
  (`POST /api/auth/register`) takes a company's name and a free-text
  description of what it does and wants, and `companyProfileService.js`
  calls an LLM to synthesize a full directions profile (ICP, geo strategy,
  scoring, outreach tone, brand voice, sales narrative) unique to that
  company. Every other module - scoring, email generation, call scripts,
  content studio, the AI assistant - reads from that per-company profile,
  so the tool's behavior genuinely differs company to company. Re-run
  anytime from Settings (`POST /api/companies/me/regenerate-profile`).
- **Geo search (Nairobi / national / East Africa / Africa / global)**:
  `geoExpansion.resolveScope()` + `POST /api/leads/discover` with
  `{ geoScope }`. Falls back to v1's automatic home-country-then-widening
  behavior when no explicit scope is given.
- **Company name, contact info (email/phone/both), role**: every lead
  source normalizes into one shape (`companyName`, `contactName`, `title`,
  `email`, `phone`, `linkedinUrl`, location, industry, size); stored per
  company in the `leads` table.
- **Sources beyond Clay/vibe prospecting**: `leadSourceRegistry.js` fans a
  discovery request out to every enabled source in parallel - Clay,
  Explorium, AI-assisted web research (`webResearchLeadService.js`,
  licensed search API + LLM extraction - not a LinkedIn/social-media
  scraper, which would violate those platforms' Terms of Service), and
  CSV import for lists a company already has the right to use. Adding
  another provider (Apollo.io, Hunter.io, ZoomInfo, a licensed registry
  feed, LinkedIn's own official APIs) is one file with the same interface.
- **Cold calling + AI follow-up like a sales person**: `callsService.js`
  generates a per-lead call script (opener, discovery questions, value
  prop, objection handling, close); `routes/calls.js` logs outcomes and
  automatically creates a follow-up task for outcomes that need one
  (no-answer, voicemail, callback-requested, interested), the way a sales
  manager would remind a rep.
- **Custom bulk cold email, never repeated**: unchanged from v1's
  `emailGenerationService.js`, now per-company - full history-awareness,
  angle rotation, similarity guard - plus per-company suppression list,
  rate limits and domain warm-up in `emailService.js`.
- **Sales pitches, ad ideas, social media plan, graphics, video ads**:
  `contentService.js` (text), `imageGenerationService.js` (graphics,
  pluggable to OpenAI Images or any provider with the same shape),
  `videoGenerationService.js` (video-ad concepts/storyboards, pluggable to
  a real submit-and-poll video generation API once you have one - see the
  file for why no provider is hardcoded). All generations are saved to
  `content_assets` for reuse.
- **AI assistant that can act automatically**: `assistantService.js` runs
  an Anthropic tool-use loop bound to real functions - search leads, log
  calls, create tasks, schedule meetings, draft emails, update lead
  status, generate content. `POST /api/assistant/chat` for conversation;
  `POST /api/assistant/run-autonomous` (or the optional in-process
  scheduler via `AUTONOMOUS_ASSISTANT_ENABLED`) for it to review leads/
  tasks/meetings and take useful actions with no one prompting it.

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
| `ANTHROPIC_API_KEY` | Company AI profiling, per-lead email generation, call scripts, AI assistant, text content (pitch/ad copy/social plan). |
| `CLAY_API_KEY` / `EXPLORIUM_API_KEY` | Lead sourcing from Clay / Explorium. |
| `SERPAPI_API_KEY` or `BING_SEARCH_API_KEY` | Web-research lead sourcing. |
| `SMTP_*`, `FROM_NAME`, `FROM_EMAIL` | Actually sending campaign emails (falls back to a free Ethereal.email sandbox, or a console-only stub with zero network). |
| `OPENAI_API_KEY` (+`IMAGE_PROVIDER=openai`) | Real graphics generation (falls back to a generated placeholder graphic). |
| `VIDEO_API_BASE`/`VIDEO_API_KEY` | Real video-ad generation (falls back to a text storyboard) - see `videoGenerationService.js` for wiring a specific provider. |
| `GOOGLE_CALENDAR_CLIENT_ID/SECRET` | Optional push-to-Google-Calendar (meetings always produce a working `.ics` invite with zero configuration). |

See `.env.example` for the full list with explanations.

## Core workflow

1. **Register** (`/register.html`) - company description in, AI-tuned
   directions out, straight into the dashboard.
2. **Leads tab** - pick a geo scope and click "Search prospects", or
   import a CSV. Log outcomes to retrain the scorer.
3. **Calls tab** - generate a script for a lead, make the call, log the
   outcome - a follow-up task is created automatically when useful.
4. **Tasks & Meetings tab** - track to-dos and scheduled meetings;
   download the `.ics` invite for any meeting.
5. **Content Studio tab** - generate a sales pitch, ad ideas/copy, a
   14-day social plan, a graphic, or a video-ad concept in one click.
6. **AI Assistant tab** - ask it anything about your leads, or click "Run
   assistant now" to let it review your pipeline and act on its own.
7. **Settings tab** - see and regenerate your company's AI profile at any
   time as your positioning evolves.

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
- Swap the email/scoring LLM provider: edit `callModel()` in the relevant
  service - the surrounding logic is provider-agnostic everywhere.

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
