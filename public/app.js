const $ = (selector) => document.querySelector(selector);
const state = {
  view: 'prospects', projects: [], prospects: [], selected: null,
  key: sessionStorage.getItem('adforge-key') || (location.hostname === 'localhost' ? 'local-adforge-demo' : ''),
};

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.key) headers.set('x-adforge-key', state.key);
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`);
  return response.headers.get('content-type')?.includes('json') ? response.json() : response.text();
}

async function load() {
  try {
    const health = await api('/health');
    $('#engine-mode').textContent = `${health.mode} AI · ${health.outreach} outreach`;
    [state.projects, state.prospects] = await Promise.all([api('/api/projects'), api('/api/prospects')]);
    const list = currentList();
    if (!state.selected || !list.some((item) => item.id === state.selected)) state.selected = list[0]?.id || null;
    render();
  } catch (error) {
    if (String(error.message).includes('authentication')) requestKey();
    else $('#record-list').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function currentList() { return state.view === 'prospects' ? state.prospects : state.projects; }

function render() {
  const prospectView = state.view === 'prospects';
  $('#view-overline').textContent = prospectView ? 'Acquisition' : 'Operations';
  $('#view-title').textContent = prospectView ? 'Prospect engine' : 'Production desk';
  $('#primary-action').textContent = prospectView ? '+ Import prospects' : '+ New project';
  $('#record-label').textContent = prospectView ? 'Prospects' : 'Projects';
  $('#nav-prospects').classList.toggle('active', prospectView);
  $('#nav-production').classList.toggle('active', !prospectView);
  $('#demo-prospect').hidden = !prospectView;
  $('#create-demo').hidden = prospectView;
  $('#generate-batch').hidden = !prospectView;
  if (prospectView) renderProspects(); else renderProjects();
}

function renderProspects() {
  const prospects = state.prospects;
  const ready = prospects.filter((item) => item.status === 'preview-ready').length;
  const approved = prospects.filter((item) => item.status === 'approved').length;
  const sent = prospects.filter((item) => ['sent', 'replied', 'qualified'].includes(item.status)).length;
  const won = prospects.filter((item) => item.status === 'won');
  const mrr = won.reduce((sum, item) => sum + Number(item.conversionValue || 1500), 0);
  $('#metrics').innerHTML = metric('Total prospects', prospects.length, 'database') + metric('Previews ready', ready, 'needs approval') + metric('Outreach active', sent + approved, 'approved or sent') + metric('Won MRR', `$${mrr.toLocaleString()}`, `${won.length} customers`);
  $('#record-count').textContent = `${ready} ready`;
  $('#record-list').innerHTML = prospects.length ? prospects.map(prospectRow).join('') : '<div class="empty">No prospects yet. Import a CSV or create the complete demo.</div>';
  document.querySelectorAll('.prospect-row').forEach((button) => button.onclick = () => { state.selected = button.dataset.id; render(); });
  const prospect = prospects.find((item) => item.id === state.selected);
  renderProspectDetail(prospect);
  renderActivity(prospect);
}

function prospectRow(item) {
  const score = item.qualification ? `${item.qualification.tier} · ${item.qualification.score}` : '—';
  return `<button class="project-row prospect-row ${item.id === state.selected ? 'active' : ''}" data-id="${item.id}"><strong>${escapeHtml(item.input.companyName)}</strong><span>${escapeHtml(item.input.sourceTitle)}</span><small>${escapeHtml(item.status)} · ${score}</small><div class="progress"><i style="width:${item.qualification?.score || (item.status === 'researching' ? 35 : 5)}%"></i></div></button>`;
}

function renderProspectDetail(item) {
  if (!item) { emptyDetail('Select a prospect', 'Qualify a public source and build its personalized Campaign Preview.'); return; }
  const previewUrl = item.preview ? `/preview/${item.previewToken}` : '';
  const email = item.preview ? `<div class="email-preview"><span>Outreach draft</span><strong>${escapeHtml(item.preview.outreachSubject)}</strong><pre>${escapeHtml(item.preview.outreachBody)}</pre></div>` : '';
  const qualification = item.qualification ? `<div class="score-card"><div><span>Fit score</span><b>${item.qualification.score}</b><small>Tier ${item.qualification.tier}</small></div><ul>${item.qualification.fitReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></div>` : '<div class="empty inline">Generate a preview to qualify this prospect.</div>';
  const actions = prospectActions(item, previewUrl);
  $('#detail-panel').innerHTML = `<section class="project-detail"><div class="detail-head"><div><span class="overline">${escapeHtml(item.input.role || item.input.country || 'Expert-led B2B')}</span><h2>${escapeHtml(item.input.companyName)}</h2><p>${escapeHtml(item.input.sourceTitle)}</p></div><span class="status-pill">${escapeHtml(item.status)}</span></div><div class="detail-grid"><div class="info-card"><span>Contact</span><strong>${escapeHtml(item.input.contactName || 'Not supplied')}<br>${escapeHtml(item.input.contactEmail || 'Email required')}</strong></div><div class="info-card"><span>Source</span><strong><a href="${escapeHtml(item.input.sourceUrl)}" target="_blank" rel="noreferrer">Open public source ↗</a></strong></div></div>${qualification}${item.preview ? `<div class="preview-angle"><span>Campaign angle</span><h3>${escapeHtml(item.preview.campaignAngle)}</h3><p>${escapeHtml(item.preview.whyNow)}</p></div>` : ''}${email}<div class="actions">${actions}</div>${item.error ? `<p style="color:var(--red)">${escapeHtml(item.error)}</p>` : ''}</section>`;
  bindProspectActions();
}

function prospectActions(item, previewUrl) {
  const actions = [];
  if (!['sent', 'won', 'unsubscribed'].includes(item.status)) actions.push(`<button data-generate="${item.id}">${item.preview ? 'Regenerate' : 'Generate preview'}</button>`);
  if (item.preview) actions.push(`<a href="${previewUrl}" target="_blank">Open Campaign Preview</a>`);
  if (item.status === 'preview-ready') actions.push(`<button class="primary" data-approve-prospect="${item.id}">Approve outreach</button>`);
  if (item.status === 'approved') actions.push(`<button class="primary" data-send="${item.id}">Send approved email</button>`);
  if (['sent', 'replied'].includes(item.status)) actions.push(`<button data-status="qualified" data-id="${item.id}">Mark qualified</button>`);
  if (['sent', 'replied', 'qualified'].includes(item.status)) actions.push(`<button class="primary" data-status="won" data-id="${item.id}">Mark won</button><button data-status="lost" data-id="${item.id}">Mark lost</button>`);
  return actions.join('');
}

function renderProjects() {
  const projects = state.projects;
  const active = projects.filter((item) => !['approved', 'failed'].includes(item.status)).length;
  const review = projects.filter((item) => item.status === 'client-review').length;
  const approved = projects.filter((item) => item.status === 'approved').length;
  const average = projects.length ? Math.round(projects.reduce((sum, item) => sum + item.progress, 0) / projects.length) : 0;
  $('#metrics').innerHTML = metric('Active projects', active, 'in queue') + metric('Awaiting review', review, 'client action') + metric('Approved', approved, 'delivered') + metric('Average progress', `${average}%`, 'all projects');
  $('#record-count').textContent = `${active} active`;
  $('#record-list').innerHTML = projects.length ? projects.map(projectRow).join('') : '<div class="empty">No projects yet.</div>';
  document.querySelectorAll('.project-record').forEach((button) => button.onclick = () => { state.selected = button.dataset.id; render(); });
  const project = projects.find((item) => item.id === state.selected);
  renderProjectDetail(project);
  renderActivity(project);
}

function metric(label, value, note) { return `<div class="metric"><span>${label}</span><b>${value}</b><small>${note}</small></div>`; }
function projectRow(item) { return `<button class="project-row project-record ${item.id === state.selected ? 'active' : ''}" data-id="${item.id}"><strong>${escapeHtml(item.intake.companyName)}</strong><span>${escapeHtml(item.intake.sourceType)} · ${new Date(item.updatedAt).toLocaleDateString()}</span><small>${escapeHtml(item.status)}</small><div class="progress"><i style="width:${item.progress}%"></i></div></button>`; }

function renderProjectDetail(item) {
  if (!item) { emptyDetail('Select a project', 'Follow the source from intake to reviewed delivery.'); return; }
  const completed = Math.ceil(item.progress / 17);
  const deliverables = item.bundle ? [['Premium guide', `${item.bundle.sections.length + 3} pages`], ['LinkedIn posts', item.bundle.linkedinPosts.length], ['Nurture emails', item.bundle.emails.length], ['Landing page', 'Ready'], ['Source references', item.bundle.sourceReferences.length]] : [['Production bundle', 'Generating']];
  const actions = item.artifacts ? `<a href="/api/projects/${item.id}/download/deliveryZip" data-download>Download bundle</a><a href="/review/${item.reviewToken}" target="_blank">Open client review</a><button class="primary" data-approve-project="${item.id}">Approve</button>` : `<button class="primary" data-run="${item.id}">Run production</button>`;
  $('#detail-panel').innerHTML = `<section class="project-detail"><div class="detail-head"><div><span class="overline">${escapeHtml(item.intake.sourceType)}</span><h2>${escapeHtml(item.intake.companyName)}</h2><p>${escapeHtml(item.bundle?.campaignAngle || item.intake.offer)}</p></div><span class="status-pill">${escapeHtml(item.status)}</span></div><div class="stage-track">${[0,1,2,3,4,5].map((index) => `<i class="stage ${index < completed ? 'done' : ''}"></i>`).join('')}</div><div class="detail-grid"><div class="info-card"><span>Audience</span><strong>${escapeHtml(item.intake.audience)}</strong></div><div class="info-card"><span>Primary CTA</span><strong>${escapeHtml(item.intake.callToAction)}</strong></div><div class="info-card"><span>Quality gate</span><strong>${item.quality ? `${item.quality.score}/100 · ${item.quality.blockers.length ? 'Blocked' : 'Passed'}` : 'Waiting for content'}</strong></div><div class="info-card"><span>Production mode</span><strong>${item.mode === 'live' ? 'Live OpenAI pipeline' : 'Deterministic demo'}</strong></div></div><div class="deliverables">${deliverables.map(([name,count]) => `<div class="deliverable"><span>${name}</span><b>${count}</b></div>`).join('')}</div><div class="actions">${actions}</div>${item.error ? `<p style="color:var(--red)">${escapeHtml(item.error)}</p>` : ''}</section>`;
  bindProjectActions();
}

function renderActivity(item) { $('#activity').innerHTML = item ? [...item.events].reverse().map((event) => `<div class="event ${event.type}"><time>${new Date(event.at).toLocaleString()}</time><p>${escapeHtml(event.message)}</p></div>`).join('') : '<div class="empty">Events appear here.</div>'; }
function emptyDetail(title, copy) { $('#detail-panel').innerHTML = `<div class="empty-detail"><span class="forge-icon">A</span><h2>${title}</h2><p>${copy}</p></div>`; }

function bindProspectActions() {
  document.querySelectorAll('[data-generate]').forEach((button) => button.onclick = () => act(`/api/prospects/${button.dataset.generate}/generate`));
  document.querySelectorAll('[data-approve-prospect]').forEach((button) => button.onclick = () => act(`/api/prospects/${button.dataset.approveProspect}/approve`));
  document.querySelectorAll('[data-send]').forEach((button) => button.onclick = async () => {
    if (!confirm('Send this exact approved email?')) return;
    const result = await api(`/api/prospects/${button.dataset.send}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    if (result.status === 'dry-run') alert('Dry-run passed. Configure Resend to send live outreach.');
    await load();
  });
  document.querySelectorAll('[data-status]').forEach((button) => button.onclick = async () => {
    const status = button.dataset.status;
    const note = prompt(status === 'won' ? 'Optional note or customer detail' : `Note for ${status}`, '') || '';
    await api(`/api/prospects/${button.dataset.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, note, conversionValue: status === 'won' ? 1500 : undefined }) });
    await load();
  });
}

function bindProjectActions() {
  document.querySelectorAll('[data-run]').forEach((button) => button.onclick = () => act(`/api/projects/${button.dataset.run}/run`));
  document.querySelectorAll('[data-approve-project]').forEach((button) => button.onclick = () => act(`/api/projects/${button.dataset.approveProject}/approve`));
  document.querySelectorAll('[data-download]').forEach((link) => link.onclick = (event) => { event.preventDefault(); fetch(link.href, { headers: { 'x-adforge-key': state.key } }).then((response) => { if (!response.ok) throw new Error('Download failed'); return response.blob(); }).then((blob) => { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'adforge-delivery.zip'; anchor.click(); URL.revokeObjectURL(url); }); });
}

async function act(path) { await api(path, { method: 'POST' }); await load(); }
function setView(view) { state.view = view; state.selected = currentList()[0]?.id || null; render(); }
function requestKey() { const key = prompt('Enter your AdForge operator key'); if (key) { state.key = key; sessionStorage.setItem('adforge-key', key); void load(); } }
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; }

$('#nav-prospects').onclick = () => setView('prospects');
$('#nav-production').onclick = () => setView('production');
$('#primary-action').onclick = () => $(state.view === 'prospects' ? '#prospect-dialog' : '#project-dialog').showModal();
$('#close-project-dialog').onclick = () => $('#project-dialog').close();
$('#close-prospect-dialog').onclick = () => $('#prospect-dialog').close();
$('#set-key').onclick = requestKey;
$('#refresh').onclick = load;
$('#create-demo').onclick = async () => { await api('/api/projects/demo/create', { method: 'POST' }); await load(); };
$('#demo-prospect').onclick = async () => { const item = await api('/api/prospects/demo/create', { method: 'POST' }); state.selected = item.id; await load(); };
$('#generate-batch').onclick = async () => { await api('/api/prospects/batch/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); await load(); };
$('#intake-form').onsubmit = async (event) => { event.preventDefault(); await submitForm(event, '/api/intake', '#project-dialog', 'Queue project →'); };
$('#prospect-form').onsubmit = async (event) => { event.preventDefault(); await submitForm(event, '/api/prospects/import', '#prospect-dialog', 'Import prospects →'); };

async function submitForm(event, path, dialogSelector, idleLabel) {
  const button = event.submitter;
  button.disabled = true;
  button.textContent = 'Working…';
  try { await api(path, { method: 'POST', body: new FormData(event.target) }); event.target.reset(); $(dialogSelector).close(); await load(); }
  catch (error) { alert(error.message); }
  finally { button.disabled = false; button.textContent = idleLabel; }
}

void load();
setInterval(load, 5000);
