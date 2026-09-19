-- =========================================================================
-- Multi-tenant lead-generation & growth platform schema.
-- Every business-data table is scoped by company_id so many organizations
-- can run on one deployment, each with its own leads, directions, model
-- weights, campaigns, calls, tasks, meetings and generated content.
-- SQLite for local/dev; swap src/db/database.js for Postgres in production
-- (every query in this app goes through db.prepare(...).run/get/all, which
-- maps closely onto node-postgres/Prisma equivalents).
-- =========================================================================

-- Companies: the tenant. Registration captures a free-text description of
-- what the company does and what it wants from the tool; ai_profile_json
-- holds the AI-synthesized ICP/geo/scoring/outreach "directions" derived
-- from that description (see companyProfileService.js), in the same shape
-- previously hard-coded in config/directions.default.json - but unique
-- per company now, and re-generatable at any time from Settings.
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  description TEXT,               -- free-text "what we do / what we want from this tool"
  industry TEXT,
  website TEXT,
  logo_url TEXT,
  home_country TEXT DEFAULT 'KE', -- ISO-3166 alpha-2, defaults to Kenya
  home_city TEXT DEFAULT 'Nairobi',
  ai_profile_json TEXT,           -- synthesized directions (ICP, geo, scoring, outreach, brand voice)
  onboarding_status TEXT DEFAULT 'pending', -- pending | profiling | ready
  plan TEXT DEFAULT 'trial',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Users belong to exactly one company (simple B2B model - one workspace
-- per company). Role gates a few sensitive actions (Settings, billing).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'owner',      -- owner | admin | member
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);

-- Leads: one row per company+contact combination
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  company_name TEXT NOT NULL,     -- the PROSPECT's company name (not the tenant)
  contact_name TEXT,
  title TEXT,
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL,
  industry TEXT,
  company_size INTEGER,
  source TEXT,                 -- 'clay' | 'explorium' | 'web_research' | 'csv_import' | 'manual' | 'ai_assistant'
  geo_tier INTEGER,            -- 1 = home country, 2 = region, 3 = global (auto-expansion mode)
  geo_scope TEXT,              -- explicit scope used to find it: nairobi | kenya | east_africa | africa | global
  score REAL DEFAULT 0,        -- current ML/heuristic score, 0-1
  status TEXT DEFAULT 'new',   -- new | contacted | replied | meeting_booked | opportunity | closed_won | closed_lost | bounced | unsubscribed | spam
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(company_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_geo_tier ON leads(company_id, geo_tier);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);

-- Feedback events feed the learning loop (leadScoring.js)
CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  event_type TEXT NOT NULL,   -- replied | meeting_booked | opportunity_created | closed_won | bounced | unsubscribed | marked_spam | closed_lost
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_company ON feedback_events(company_id);

-- Persisted model weights for the online learner - one row per company,
-- so each tenant's scorer learns from ITS OWN outcomes only.
CREATE TABLE IF NOT EXISTS model_weights (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  weights_json TEXT NOT NULL,
  samples_seen INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  template_sequence_json TEXT NOT NULL,
  status TEXT DEFAULT 'draft', -- draft | active | paused | completed
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaigns_company ON campaigns(company_id);

CREATE TABLE IF NOT EXISTS campaign_sends (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  step_id TEXT NOT NULL,        -- which step in the follow-up sequence, e.g. 'intro' | 'followup_1'
  subject TEXT,                 -- the actual AI-generated subject sent (kept so future generations avoid repeats)
  body TEXT,                    -- the actual AI-generated body sent
  angle TEXT,                   -- which rhetorical angle was used (pain_point | social_proof | question | industry_trend | ...)
  sent_at TEXT,
  opened_at TEXT,
  replied_at TEXT,
  status TEXT DEFAULT 'queued' -- queued | sent | failed | skipped_suppressed | skipped_rate_limited
);

CREATE INDEX IF NOT EXISTS idx_campaign_sends_lead ON campaign_sends(lead_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sends_campaign ON campaign_sends(campaign_id);

-- Warm-up tracking per company/sending domain: records the date of this
-- company's first-ever send, so daily sending caps can ramp up
-- automatically over the warm-up period instead of jumping straight to
-- full volume on a brand-new domain.
CREATE TABLE IF NOT EXISTS warmup_state (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  first_send_date TEXT
);

-- Suppression list (unsubscribes / bounces / spam complaints), scoped per
-- company - NEVER email these again on that company's behalf.
CREATE TABLE IF NOT EXISTS suppression_list (
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (company_id, email)
);

-- Calls: cold-call / discovery-call tracking, AI-assisted scripting and
-- follow-up, exactly like a sales rep's call log + coach.
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  user_id TEXT REFERENCES users(id),
  direction TEXT DEFAULT 'outbound',  -- outbound | inbound
  status TEXT DEFAULT 'planned',      -- planned | completed | no_answer | voicemail | bad_number
  outcome TEXT,                       -- interested | not_interested | callback_requested | meeting_booked | no_answer | wrong_number
  script_json TEXT,                   -- AI-generated opener/talk-track/objection-handling used for this call
  notes TEXT,                         -- rep's own notes after the call
  duration_seconds INTEGER,
  scheduled_at TEXT,
  completed_at TEXT,
  follow_up_task_id TEXT,             -- set when a follow-up task was auto-created from the outcome
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calls_company ON calls(company_id);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);

-- Tasks: to-dos, either created by a human or by the AI assistant acting
-- on a company's behalf (e.g. "follow up with X in 3 days").
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  lead_id TEXT REFERENCES leads(id),
  assigned_to TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open',   -- open | in_progress | done | cancelled
  priority TEXT DEFAULT 'normal', -- low | normal | high
  due_at TEXT,
  created_by TEXT DEFAULT 'user', -- user | ai_assistant
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_lead ON tasks(lead_id);

-- Meetings: scheduled online/offline meetings with a prospect. Generates a
-- downloadable .ics invite always; wires into a real calendar API
-- (Google/Microsoft) when credentials are configured (meetingsService.js).
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  lead_id TEXT REFERENCES leads(id),
  title TEXT NOT NULL,
  description TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  location_or_link TEXT,
  status TEXT DEFAULT 'scheduled', -- scheduled | completed | cancelled | no_show
  ics_uid TEXT,
  external_calendar_id TEXT,       -- id from a real calendar provider, once wired up
  created_by TEXT DEFAULT 'user',  -- user | ai_assistant
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_meetings_company ON meetings(company_id);
CREATE INDEX IF NOT EXISTS idx_meetings_lead ON meetings(lead_id);

-- Content assets: every generated sales pitch, ad copy set, social plan,
-- graphic or video-ad job, so a company can browse/reuse past generations
-- instead of regenerating from scratch every time.
CREATE TABLE IF NOT EXISTS content_assets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  lead_id TEXT REFERENCES leads(id),        -- set when the asset is personalized to one prospect
  type TEXT NOT NULL,                       -- sales_pitch | ad_copy | social_plan | graphic | video_ad
  provider TEXT,                            -- which backend produced it (anthropic | openai_images | mock | ...)
  prompt TEXT,
  result_text TEXT,                         -- text-based results (pitch script, ad copy, social calendar JSON)
  result_url TEXT,                          -- binary results (graphic/video) - URL or local path
  status TEXT DEFAULT 'completed',          -- queued | generating | completed | failed
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_company ON content_assets(company_id, type);

-- AI assistant conversation + tool-call log, per company (one shared
-- assistant thread per workspace, simplest useful model for now).
CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT REFERENCES users(id),
  role TEXT NOT NULL,           -- user | assistant | tool
  content TEXT,
  tool_calls_json TEXT,         -- when role='assistant' and it invoked tools
  tool_name TEXT,                -- when role='tool', which tool produced this result
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_company ON assistant_messages(company_id, created_at);
