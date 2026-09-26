/**
 * AI sales assistant - a tool-using agent that can act on a company's
 * behalf: search/inspect leads, log calls, create follow-up tasks,
 * schedule meetings, draft emails, update lead status, and generate sales
 * content. This is the "AI assistant that can carry out tasks for the
 * company even automatically... help with anything related to the leads"
 * requirement.
 *
 * Uses Anthropic's tool-use (function-calling) loop: the model decides
 * which tool(s) to call, we execute them against this company's data,
 * feed the results back, and repeat until the model produces a final
 * answer. Every message and tool call is logged to `assistant_messages`
 * for a full audit trail.
 *
 * Runs in two modes:
 *  - Chat: a user sends a message, the assistant replies (possibly after
 *    taking actions).
 *  - Autonomous: called with no user message (e.g. from a scheduler); the
 *    assistant is handed a snapshot of leads/tasks needing attention and
 *    asked to take whatever useful actions it can on its own.
 *
 * MOCK_MODE / no ANTHROPIC_API_KEY: falls back to a small deterministic
 * intent router covering the most common asks (list top leads, list open
 * tasks/meetings) so the assistant UI is never a dead end in demo mode -
 * but write-actions (creating tasks/meetings, logging calls) need the
 * real model, since deciding what to do autonomously is exactly what an
 * LLM is for.
 */
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const llm = require('./llm');
const tasksService = require('./tasksService');
const meetingsService = require('./meetingsService');
const emailGenerationService = require('./emailGenerationService');
const contentService = require('./contentService');
const outreach = require('./outreachService');
const cadence = require('./cadenceService');
const analytics = require('./analyticsService');
const { getDirections } = require('./directionsService');
const { playbookPromptBlock, ATTEMPT_RESULTS, OUTREACH_METHODS } = require('../config/playbook');

const USE_MOCK = !llm.enabled();
const MAX_TOOL_ROUNDS = 8;

const TOOLS = [
  {
    name: 'search_leads',
    description: 'Search this company\'s stored leads by status and/or minimum score.',
    input_schema: { type: 'object', properties: {
      status: { type: 'string', description: 'new|contacted|replied|meeting_booked|closed_won|closed_lost|bounced|unsubscribed' },
      minScore: { type: 'number' }, limit: { type: 'number' }
    } }
  },
  {
    name: 'get_lead',
    description: 'Get full details for one lead by id.',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] }
  },
  {
    name: 'log_call',
    description: 'Log the outcome of a call with a lead.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string' }, outcome: { type: 'string', description: 'interested|not_interested|callback_requested|meeting_booked|no_answer|voicemail|wrong_number' },
      notes: { type: 'string' }
    }, required: ['leadId', 'outcome'] }
  },
  {
    name: 'create_task',
    description: 'Create a follow-up task, optionally linked to a lead.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
      dueAt: { type: 'string', description: 'ISO 8601 datetime' }, priority: { type: 'string', description: 'low|normal|high' }
    }, required: ['title'] }
  },
  {
    name: 'schedule_meeting',
    description: 'Schedule a meeting with a lead and generate a calendar invite.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string' }, title: { type: 'string' }, startAt: { type: 'string' }, endAt: { type: 'string' },
      locationOrLink: { type: 'string' }, description: { type: 'string' }
    }, required: ['title', 'startAt', 'endAt'] }
  },
  {
    name: 'draft_email',
    description: 'Generate (but do not send) a unique cold/follow-up email draft for a lead.',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' }, stepId: { type: 'string' } }, required: ['leadId'] }
  },
  {
    name: 'update_lead_status',
    description: 'Manually change a lead\'s pipeline status.',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' }, status: { type: 'string' } }, required: ['leadId', 'status'] }
  },
  {
    name: 'generate_content',
    description: 'Generate marketing content: a sales pitch, ad copy set, or social media plan, optionally personalized to one lead.',
    input_schema: { type: 'object', properties: {
      type: { type: 'string', enum: ['sales_pitch', 'ad_copy', 'social_plan'] }, leadId: { type: 'string' }
    }, required: ['type'] }
  },
  {
    name: 'log_outreach_attempt',
    description: 'Record a contact attempt with a lead (door to door, cold call, digital DM or email) and its result. Moves the lead through the pipeline and schedules the next follow-up.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string' },
      method: { type: 'string', enum: OUTREACH_METHODS.map(m => m.key) },
      result: { type: 'string', enum: ATTEMPT_RESULTS.map(r => r.key) },
      notes: { type: 'string' }
    }, required: ['leadId', 'method', 'result'] }
  },
  {
    name: 'set_lead_outcome',
    description: 'Set a lead\'s outcome after contact: converted, on_fence, said_no (give a reasonCategory: price|timing|no_need|competitor|trust|results|service_quality|communication|moved_or_closed|other) or no_response.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string' }, outcome: { type: 'string', enum: ['converted', 'on_fence', 'said_no', 'no_response'] },
      reasonCategory: { type: 'string' }, reason: { type: 'string' }
    }, required: ['leadId', 'outcome'] }
  },
  {
    name: 'list_follow_ups_due',
    description: 'List leads whose next follow-up is due now, with the suggested outreach method for each.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } }
  },
  {
    name: 'get_analytics',
    description: 'Get funnel, outreach-method effectiveness, pipeline value and customer churn numbers for the last N days.',
    input_schema: { type: 'object', properties: { days: { type: 'number' } } }
  }
];

function loadLeadRow(companyId, leadId) {
  return db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(leadId, companyId);
}
function toLeadShape(l) {
  return { id: l.id, contactName: l.contact_name, title: l.title, companyName: l.company_name, industry: l.industry, city: l.city, country: l.country, companySize: l.company_size, email: l.email, status: l.status, score: l.score };
}

async function executeTool(companyId, userId, name, input) {
  switch (name) {
    case 'search_leads': {
      let q = 'SELECT id, company_name, contact_name, title, email, phone, status, score FROM leads WHERE company_id = ?';
      const params = [companyId];
      if (input.status) { q += ' AND status = ?'; params.push(input.status); }
      if (input.minScore != null) { q += ' AND score >= ?'; params.push(input.minScore); }
      q += ' ORDER BY score DESC LIMIT ?'; params.push(input.limit || 10);
      return db.prepare(q).all(...params);
    }
    case 'get_lead': {
      const lead = loadLeadRow(companyId, input.leadId);
      return lead || { error: 'lead not found' };
    }
    case 'log_call': {
      const lead = loadLeadRow(companyId, input.leadId);
      if (!lead) return { error: 'lead not found' };
      const id = uuid();
      db.prepare(`INSERT INTO calls (id, company_id, lead_id, user_id, status, outcome, notes, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`)
        .run(id, companyId, input.leadId, userId, input.outcome, input.notes || null, new Date().toISOString());
      return { ok: true, callId: id };
    }
    case 'create_task': {
      return tasksService.createTask(companyId, { ...input, createdBy: 'ai_assistant' });
    }
    case 'schedule_meeting': {
      const { meeting } = await meetingsService.scheduleMeeting(companyId, { ...input, createdBy: 'ai_assistant' });
      return meeting;
    }
    case 'draft_email': {
      const lead = loadLeadRow(companyId, input.leadId);
      if (!lead) return { error: 'lead not found' };
      const directions = getDirections(companyId);
      return emailGenerationService.generateEmailForLead(toLeadShape(lead), directions, input.stepId || 'intro');
    }
    case 'update_lead_status': {
      const lead = loadLeadRow(companyId, input.leadId);
      if (!lead) return { error: 'lead not found' };
      db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(input.status, input.leadId);
      return { ok: true };
    }
    case 'generate_content': {
      const directions = getDirections(companyId);
      const lead = input.leadId ? loadLeadRow(companyId, input.leadId) : null;
      if (input.type === 'sales_pitch') return contentService.generateSalesPitch(companyId, directions, lead ? toLeadShape(lead) : null);
      if (input.type === 'ad_copy') return contentService.generateAdCopy(companyId, directions, lead ? toLeadShape(lead) : null);
      if (input.type === 'social_plan') return contentService.generateSocialPlan(companyId, directions);
      return { error: 'unknown content type' };
    }
    case 'log_outreach_attempt': {
      const r = outreach.recordAttempt(companyId, userId, { leadId: input.leadId, method: input.method, result: input.result, notes: input.notes });
      return { ok: true, attemptId: r.attempt.id, leadStatus: r.lead.status, nextFollowUpAt: r.lead.next_follow_up_at };
    }
    case 'set_lead_outcome': {
      const r = outreach.setOutcome(companyId, input.leadId, { ...input, userId });
      return { ok: true, leadStatus: r.lead.status, customerCreated: !!r.customer };
    }
    case 'list_follow_ups_due':
      return cadence.dueQueue(companyId, { limit: input.limit || 20 });
    case 'get_analytics': {
      const o = analytics.workspaceOverview(companyId, { days: input.days || 30 });
      return { funnel: o.funnel, rates: o.rates, methods: o.methods, value: o.value, customers: { active: o.customers.totalActive, churnRateThisMonth: o.customers.churnRateThisMonth }, followUpsDue: o.followUpsDue };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

function saveMessage(companyId, userId, role, content, toolCallsJson, toolName) {
  const id = uuid();
  db.prepare('INSERT INTO assistant_messages (id, company_id, user_id, role, content, tool_calls_json, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, companyId, userId || null, role, content || null, toolCallsJson || null, toolName || null);
  return id;
}

function history(companyId, limit = 30) {
  return db.prepare('SELECT * FROM assistant_messages WHERE company_id = ? ORDER BY created_at DESC LIMIT ?').all(companyId, limit).reverse();
}

function callModel(system, messages) {
  return llm.create({ max_tokens: 16000, output_config: { effort: 'medium' }, system, tools: TOOLS, messages });
}

function buildSystemPrompt(directions, mode) {
  const base = `You are an AI sales assistant at an AI lead-generation agency, working in the workspace of "${directions.sender?.companyName || 'this company'}". \
Your job: help the team find, contact, book and convert leads - answer questions, and take actions using your tools when useful (creating tasks, scheduling meetings, logging attempts and outcomes, drafting emails, generating content, checking follow-ups and analytics). \
Outreach methods, strongest first: door to door, cold calling, multi-platform digital, email/DMs. \
Always prefer taking a concrete useful action over just describing what could be done, but never send an email or make irreversible external changes yourself - drafting is fine, sending is not one of your tools. \
Be concise. Brand voice: ${directions.brand?.voice || 'professional'}.

${playbookPromptBlock()}`;
  if (mode === 'autonomous') {
    return base + '\n\nYou are running autonomously (no human is watching right now). Review the snapshot you are given, decide what is worth doing, and take those actions directly with your tools (e.g. create follow-up tasks for stale hot leads). Then summarize what you did in one short paragraph.';
  }
  return base;
}

/** Deterministic fallback for MOCK_MODE - covers common read-only asks without an LLM. */
function mockRespond(companyId, userMessage) {
  const msg = (userMessage || '').toLowerCase();
  if (/top lead|best lead|hot lead/.test(msg)) {
    const rows = db.prepare('SELECT company_name, contact_name, score FROM leads WHERE company_id = ? ORDER BY score DESC LIMIT 5').all(companyId);
    if (!rows.length) return 'No leads yet - run a discovery search first.';
    return 'Top leads right now:\n' + rows.map(r => `- ${r.company_name}${r.contact_name ? ' (' + r.contact_name + ')' : ''} - ${Math.round((r.score || 0) * 100)}%`).join('\n');
  }
  if (/open task|to.?do/.test(msg)) {
    const rows = db.prepare("SELECT title, due_at FROM tasks WHERE company_id = ? AND status = 'open' ORDER BY due_at ASC LIMIT 5").all(companyId);
    if (!rows.length) return 'No open tasks.';
    return 'Open tasks:\n' + rows.map(r => `- ${r.title}${r.due_at ? ' (due ' + r.due_at + ')' : ''}`).join('\n');
  }
  if (/follow.?up|due/.test(msg)) {
    const rows = cadence.dueQueue(companyId, { limit: 8 });
    if (!rows.length) return 'No follow-ups are due right now.';
    return 'Follow-ups due:\n' + rows.map(r => `- ${r.lead.company_name || r.lead.contact_name}: ${r.suggestedMethod ? r.suggestedMethod.replace(/_/g, ' ') : 'needs a contact'} (${r.reason})`).join('\n');
  }
  if (/how are we|analytics|performance|funnel|churn/.test(msg)) {
    const o = analytics.workspaceOverview(companyId, { days: 30 });
    return `Last 30 days: ${o.funnel.map(f => `${f.label.toLowerCase()} ${f.n}`).join(', ')}. Customer churn this month: ${o.customers.churnRateThisMonth ?? 'n/a'}%. Follow-ups due: ${o.followUpsDue}.`;
  }
  return 'Running in demo mode (no ANTHROPIC_API_KEY set), so I can only answer a few canned questions right now - try "what are my top leads", "what follow-ups are due", "how are we doing" or "what tasks are open". Add an ANTHROPIC_API_KEY to unlock the full assistant: it can search leads, log attempts and outcomes, create tasks, schedule meetings, draft emails and generate content on its own.';
}

/**
 * @param {string} companyId
 * @param {string} userId
 * @param {string|null} userMessage - null for an autonomous run
 * @param {'chat'|'autonomous'} mode
 */
async function converse(companyId, userId, userMessage, mode = 'chat') {
  const directions = getDirections(companyId);

  if (userMessage) saveMessage(companyId, userId, 'user', userMessage);

  if (USE_MOCK) {
    const reply = mode === 'autonomous'
      ? 'Demo mode: autonomous runs need a real ANTHROPIC_API_KEY to decide what actions are worth taking.'
      : mockRespond(companyId, userMessage);
    saveMessage(companyId, userId, 'assistant', reply);
    return { reply, actions: [] };
  }

  const system = buildSystemPrompt(directions, mode);
  const seedText = mode === 'autonomous' ? await buildAutonomousSnapshot(companyId) : userMessage;
  let messages = [{ role: 'user', content: seedText }];

  const actions = [];
  let finalText = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callModel(system, messages);
    if (response.stop_reason === 'refusal') {
      finalText = 'I can\'t help with that request.';
      saveMessage(companyId, userId, 'assistant', finalText);
      break;
    }
    const content = llm.echoableContent(response.content || []);
    const toolUses = content.filter(b => b.type === 'tool_use');
    const textBlocks = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (textBlocks) finalText = textBlocks;

    if (!toolUses.length || response.stop_reason !== 'tool_use') {
      if (textBlocks) saveMessage(companyId, userId, 'assistant', textBlocks);
      break;
    }

    saveMessage(companyId, userId, 'assistant', textBlocks || null, JSON.stringify(toolUses));
    messages.push({ role: 'assistant', content });

    const toolResults = [];
    for (const tu of toolUses) {
      let result;
      try { result = await executeTool(companyId, userId, tu.name, tu.input || {}); }
      catch (err) { result = { error: err.message }; }
      actions.push({ tool: tu.name, input: tu.input, result });
      saveMessage(companyId, userId, 'tool', JSON.stringify(result), null, tu.name);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { reply: finalText || '(no response text - see actions taken)', actions };
}

async function buildAutonomousSnapshot(companyId) {
  const staleHotLeads = db.prepare(`
    SELECT id, company_name, contact_name, score, status FROM leads
    WHERE company_id = ? AND status = 'new' AND score >= 0.5 ORDER BY score DESC LIMIT 8
  `).all(companyId);
  const overdueTasks = db.prepare(`
    SELECT id, title, due_at FROM tasks WHERE company_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < datetime('now') LIMIT 8
  `).all(companyId);
  const upcomingMeetings = db.prepare(`
    SELECT id, title, start_at FROM meetings WHERE company_id = ? AND status = 'scheduled' AND start_at < datetime('now', '+2 days') ORDER BY start_at LIMIT 8
  `).all(companyId);
  return `AUTONOMOUS CHECK-IN SNAPSHOT
High-scoring leads with no outreach yet (status=new, score>=0.5): ${JSON.stringify(staleHotLeads)}
Overdue open tasks: ${JSON.stringify(overdueTasks)}
Meetings coming up in the next 2 days: ${JSON.stringify(upcomingMeetings)}

Take whatever useful actions you can (e.g. create a follow-up task for a hot untouched lead, flag an overdue task). Then summarize what you did.`;
}

module.exports = { converse, history, TOOLS };
