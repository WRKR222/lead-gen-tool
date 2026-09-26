import { state, esc } from '../core.js';

export async function render(root) {
  const pb = state.playbook;
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Playbook</div><h1>How we win</h1>
      <p>The standards every team member and every AI tool in this platform follows. Scripts, emails, DMs, meeting briefs and the reply bot are all generated against these rules.</p></div></div>

    <div class="section-title" style="margin-top:0">Three stages to success</div>
    <div class="stage-strip">${pb.AGENCY_STAGES.map(s => `<div class="stage"><div class="s-step">Stage ${s.step}</div><div class="card-title">${esc(s.label)}</div>
      <p class="small" style="margin-top:6px">${esc(s.summary)}</p><ul class="small muted" style="padding-left:18px;margin:0">${s.tactics.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`).join('')}</div>

    <div class="section-title">Contact methods, best first</div>
    <div class="grid2">${pb.OUTREACH_METHODS.map(m => `<div class="card"><div class="row" style="justify-content:space-between"><h3>${m.rank}. ${esc(m.label)}</h3>${m.badge ? `<span class="tag tag-good">${esc(m.badge)}</span>` : m.automatable ? '<span class="tag tag-accent">automated</span>' : ''}</div><p class="small">${esc(m.description)}</p></div>`).join('')}</div>

    <div class="section-title">Setting the meeting - standards</div>
    <div class="card"><ol style="margin:0;padding-left:20px">${pb.MEETING_STANDARDS.map(s => `<li style="margin-bottom:8px"><b>${esc(s.label)}</b><div class="small muted">${esc(s.guidance)}</div></li>`).join('')}</ol></div>

    <div class="section-title">The meeting - Conversational Problem Solving</div>
    <div class="grid2">${pb.CPS_STAGES.map(s => `<div class="card"><div class="kicker">Step ${s.step}</div><h3>${esc(s.label)}</h3><p class="small">${esc(s.goal)}</p>
      <ul class="small muted" style="padding-left:18px;margin:0">${s.moves.map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>`).join('')}</div>

    <div class="section-title">AI lead-generation funnel</div>
    <div class="grid2">${pb.FUNNEL_STEPS.map(s => `<div class="card"><div class="kicker">Step ${s.step}</div><h3>${esc(s.label)}</h3><p class="small">${esc(s.summary)}</p></div>`).join('')}</div>

    <div class="section-title">What we sell & the tools we use</div>
    <div class="grid3">
      <div class="card"><h3>Services</h3><ul class="small" style="padding-left:18px;margin:0">${pb.SERVICES.map(s => `<li>${esc(s.label)}</li>`).join('')}</ul></div>
      <div class="card"><h3>Ad platforms</h3><p class="small muted" style="margin:0 0 6px">One per client, to avoid overwhelming them.</p><ul class="small" style="padding-left:18px;margin:0">${pb.AD_PLATFORMS.map(s => `<li>${esc(s.label)}</li>`).join('')}</ul></div>
      <div class="card"><h3>AI tools</h3><ul class="small" style="padding-left:18px;margin:0">${pb.AI_TOOLS.map(s => `<li><b>${esc(s.label)}</b> - ${esc(s.purpose)}</li>`).join('')}</ul></div>
    </div>

    <div class="section-title">High-demand niches to prospect</div>
    <div class="chips">${pb.HIGH_DEMAND_NICHES.map(n => `<span class="tag tag-neutral">${esc(n)}</span>`).join('')}</div>`;
}
