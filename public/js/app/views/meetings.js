import { state, api, esc, $, $$, label, dateTime, leadName, toast, busy, openDialog, formValues, download, isAgencyWorkspace } from '../core.js';

export async function render(root) {
  const [meetings, tasks] = await Promise.all([api('/meetings'), api('/tasks')]);
  const upcoming = meetings.filter(m => m.status === 'scheduled');
  const past = meetings.filter(m => m.status !== 'scheduled');
  const open = tasks.filter(t => ['open', 'in_progress'].includes(t.status));
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">${isAgencyWorkspace() ? 'Stage 2 · Sign clients' : 'Meetings & tasks'}</div><h1>Meetings & tasks</h1>
      <p>Run every meeting with Conversational Problem Solving: Attention → Identify → Solve → Cost. Let them ask the price, then stay silent. Book meetings from a lead's page so the CPS brief is prepared for you.</p></div>
      <div class="row"><button class="btn btn-secondary" id="addTask">Add task</button></div></div>
    <div class="grid2">
      <div><div class="section-title" style="margin-top:0">Upcoming meetings (${upcoming.length})</div><div class="stack">${upcoming.map(card).join('') || '<p class="empty">No meetings booked yet.</p>'}</div>
        ${past.length ? `<div class="section-title">Past meetings</div><div class="stack">${past.slice(0, 20).map(card).join('')}</div>` : ''}</div>
      <div><div class="section-title" style="margin-top:0">Open tasks (${open.length})</div>
        <div class="stack">${open.map(t => `<div class="card"><div class="row" style="justify-content:space-between"><b>${esc(t.title)}</b>${t.created_by === 'ai_assistant' ? '<span class="tag tag-accent">auto</span>' : ''}</div>
          ${t.description ? `<div class="small muted">${esc(t.description)}</div>` : ''}
          <div class="row"><span class="small muted">${t.due_at ? 'Due ' + esc(dateTime(t.due_at)) : 'No due date'} · ${esc(t.priority)}</span>
          ${t.lead_id ? `<a class="btn btn-ghost btn-sm" href="#/lead/${esc(t.lead_id)}">Open lead</a>` : ''}<button class="btn btn-secondary btn-sm" data-done="${esc(t.id)}">Done</button></div></div>`).join('') || '<p class="empty">No open tasks.</p>'}</div></div>
    </div>`;
  $('#addTask', root).addEventListener('click', () => openDialog({
    title: 'Add a task',
    body: '<div class="field"><label>Task</label><input class="input" name="title" required/></div><div class="row"><div class="field grow"><label>Due</label><input class="input" type="datetime-local" name="due"/></div><div class="field grow"><label>Priority</label><select class="input" name="priority"><option>normal</option><option>high</option><option>low</option></select></div></div>',
    actions: [{ label: 'Add', primary: true, onClick: async (b) => { const v = formValues(b); if (!v.title) throw new Error('Give the task a title'); await api('/tasks', { method: 'POST', body: { title: v.title, priority: v.priority, dueAt: v.due ? new Date(v.due).toISOString() : undefined } }); await render(root); } }]
  }));
  $$('[data-done]', root).forEach(b => b.addEventListener('click', () => busy(b, async () => { await api(`/tasks/${b.dataset.done}`, { method: 'PATCH', body: { status: 'done' } }); await render(root); })));
  $$('[data-ics]', root).forEach(b => b.addEventListener('click', () => busy(b, () => download(`/meetings/${b.dataset.ics}/ics`, 'meeting.ics'))));
  $$('[data-regen]', root).forEach(b => b.addEventListener('click', () => busy(b, async () => { await api(`/meetings/${b.dataset.regen}/brief`, { method: 'POST' }); toast('Brief refreshed', 'ok'); await render(root); })));
  $$('[data-outcome]', root).forEach(b => b.addEventListener('click', () => outcome(meetings.find(m => m.id === b.dataset.outcome), root)));
}

function card(m) {
  const b = m.cps_brief;
  return `<div class="card"><div class="row" style="justify-content:space-between"><div><b>${esc(m.lead ? leadName(m.lead) : m.title)}</b>
      <div class="small muted">${esc(dateTime(m.start_at))} · ${esc(label(m.meeting_type))}${m.location_or_link ? ' · ' + esc(m.location_or_link) : ''}</div></div>
      ${m.outcome ? `<span class="tag ${m.outcome === 'yes' ? 'tag-good' : m.outcome === 'no' ? 'tag-bad' : 'tag-warn'}">${esc(label(m.outcome))}</span>` : ''}</div>
    ${b && b.attention ? `<details><summary class="small" style="cursor:pointer">CPS brief</summary><div class="small" style="margin-top:8px">
      <p><b>Attention:</b> ${esc(b.attention.openingObservation || '')}</p>
      <p><b>Identify:</b> ${esc((b.identify && b.identify.questions || []).slice(0, 3).join(' · '))}</p>
      <p><b>Solve:</b> ${esc(b.solve && b.solve.elevatorPitch || '')}</p>
      <p><b>Cost:</b> ${esc(b.cost && b.cost.howToState || '')}</p></div></details>` : ''}
    <div class="row"><button class="btn btn-secondary btn-sm" data-ics="${esc(m.id)}">.ics</button>
      ${m.lead_id ? `<button class="btn btn-ghost btn-sm" data-regen="${esc(m.id)}">Refresh brief</button><a class="btn btn-ghost btn-sm" href="#/lead/${esc(m.lead_id)}">Open lead</a>` : ''}
      <button class="btn btn-primary btn-sm" data-outcome="${esc(m.id)}">Record outcome</button></div></div>`;
}

function outcome(m, root) {
  const stages = state.playbook.CPS_STAGES;
  const notes = m.cps_notes || {};
  openDialog({
    title: 'How did it go?',
    body: `${stages.map(s => `<div class="field"><label>${s.step}. ${esc(s.label)}</label><textarea class="input" name="${s.key}" rows="2" placeholder="${esc(s.goal)}">${esc(notes[s.key] || '')}</textarea></div>`).join('')}
      <div class="row"><div class="field grow"><label>Price quoted</label><input class="input" type="number" name="quotedPrice" value="${esc(m.quoted_price ?? '')}"/></div>
      <div class="field grow"><label>Outcome</label><select class="input" name="outcome"><option value="yes">Yes</option><option value="on_fence">On the fence</option><option value="no">No</option><option value="no_show">No-show</option></select></div></div>
      <div class="field"><label>If no - why?</label><select class="input" name="reasonCategory">${state.playbook.LOSS_REASONS.map(r => `<option value="${r.key}">${esc(r.label)}</option>`).join('')}</select></div>`,
    actions: [{ label: 'Save', primary: true, onClick: async (b) => {
      const v = formValues(b);
      await api(`/meetings/${m.id}`, { method: 'PATCH', body: { outcome: v.outcome, quotedPrice: v.quotedPrice, cpsNotes: Object.fromEntries(stages.map(s => [s.key, v[s.key]])), reasonCategory: v.outcome === 'no' ? v.reasonCategory : undefined } });
      toast(v.outcome === 'yes' && isAgencyWorkspace() ? 'Recorded - open the lead and use "Sign as client"' : 'Recorded', 'ok');
      await render(root);
    } }]
  });
}
