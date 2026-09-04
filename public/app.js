const $ = (selector) => document.querySelector(selector);
const state = { projects: [], selected: null, key: sessionStorage.getItem('adforge-key') || (location.hostname === 'localhost' ? 'local-adforge-demo' : '') };

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
    $('#engine-mode').textContent = `${health.mode} engine · secure`;
    state.projects = await api('/api/projects');
    if (!state.selected && state.projects[0]) state.selected = state.projects[0].id;
    render();
  } catch (error) {
    if (String(error.message).includes('authentication')) requestKey();
    else $('#project-list').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function render() {
  const projects = state.projects;
  const active = projects.filter((p) => !['approved', 'failed'].includes(p.status)).length;
  const review = projects.filter((p) => p.status === 'client-review').length;
  const approved = projects.filter((p) => p.status === 'approved').length;
  const average = projects.length ? Math.round(projects.reduce((sum, p) => sum + p.progress, 0) / projects.length) : 0;
  $('#metrics').innerHTML = metric('Active projects', active, 'in queue') + metric('Awaiting review', review, 'client action') + metric('Approved', approved, 'delivered') + metric('Average progress', `${average}%`, 'all projects');
  $('#project-count').textContent = `${active} active`;
  $('#project-list').innerHTML = projects.length ? projects.map(projectRow).join('') : '<div class="empty">No projects yet. Create a demo or start with a client source.</div>';
  document.querySelectorAll('.project-row').forEach((button) => button.addEventListener('click', () => { state.selected = button.dataset.id; render(); }));
  const project = projects.find((item) => item.id === state.selected);
  renderDetail(project);
  renderActivity(project);
}

function metric(label, value, note) { return `<div class="metric"><span>${label}</span><b>${value}</b><small>${note}</small></div>`; }
function projectRow(p) { return `<button class="project-row ${p.id === state.selected ? 'active' : ''}" data-id="${p.id}"><strong>${escapeHtml(p.intake.companyName)}</strong><span>${escapeHtml(p.intake.sourceType)} · ${new Date(p.updatedAt).toLocaleDateString()}</span><small>${escapeHtml(p.status)}</small><div class="progress"><i style="width:${p.progress}%"></i></div></button>`; }

function renderDetail(p) {
  if (!p) { $('#detail-panel').innerHTML = '<div class="empty-detail"><span class="forge-icon">A</span><h2>Select a project</h2><p>Follow the source from intake to reviewed delivery.</p></div>'; return; }
  const completed = Math.ceil(p.progress / 17);
  const deliverables = p.bundle ? [['Premium guide', `${p.bundle.sections.length + 3} pages`], ['LinkedIn posts', p.bundle.linkedinPosts.length], ['Nurture emails', p.bundle.emails.length], ['Landing page', 'Ready'], ['Source references', p.bundle.sourceReferences.length]] : [['Production bundle', 'Generating']];
  const actions = p.artifacts ? `<a href="/api/projects/${p.id}/download/deliveryZip" data-download>Download bundle</a><a href="/review/${p.reviewToken}" target="_blank">Open client review</a><button class="primary" data-approve="${p.id}">Approve</button>` : `<button class="primary" data-run="${p.id}">Run production</button>`;
  $('#detail-panel').innerHTML = `<section class="project-detail"><div class="detail-head"><div><span class="overline">${escapeHtml(p.intake.sourceType)}</span><h2>${escapeHtml(p.intake.companyName)}</h2><p>${escapeHtml(p.bundle?.campaignAngle || p.intake.offer)}</p></div><span class="status-pill">${escapeHtml(p.status)}</span></div><div class="stage-track">${[0,1,2,3,4,5].map(i => `<i class="stage ${i < completed ? 'done' : ''}"></i>`).join('')}</div><div class="detail-grid"><div class="info-card"><span>Audience</span><strong>${escapeHtml(p.intake.audience)}</strong></div><div class="info-card"><span>Primary CTA</span><strong>${escapeHtml(p.intake.callToAction)}</strong></div><div class="info-card"><span>Quality gate</span><strong>${p.quality ? `${p.quality.score}/100 · ${p.quality.blockers.length ? 'Blocked' : 'Passed'}` : 'Waiting for content'}</strong></div><div class="info-card"><span>Production mode</span><strong>${p.mode === 'live' ? 'Live OpenAI pipeline' : 'Deterministic demo'}</strong></div></div><div class="deliverables">${deliverables.map(([name,count]) => `<div class="deliverable"><span>${name}</span><b>${count}</b></div>`).join('')}</div><div class="actions">${actions}</div>${p.error ? `<p style="color:var(--red)">${escapeHtml(p.error)}</p>` : ''}</section>`;
  bindActions();
}

function renderActivity(p) { $('#activity').innerHTML = p ? [...p.events].reverse().map(event => `<div class="event ${event.type}"><time>${new Date(event.at).toLocaleString()}</time><p>${escapeHtml(event.message)}</p></div>`).join('') : '<div class="empty">Project events appear here.</div>'; }
function bindActions() {
  document.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => { await api(`/api/projects/${b.dataset.run}/run`, { method: 'POST' }); await load(); });
  document.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => { await api(`/api/projects/${b.dataset.approve}/approve`, { method: 'POST' }); await load(); });
  document.querySelectorAll('[data-download]').forEach(a => a.onclick = (event) => { event.preventDefault(); fetch(a.href, { headers: { 'x-adforge-key': state.key } }).then(r => { if (!r.ok) throw new Error('Download failed'); return r.blob(); }).then(blob => { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'adforge-delivery.zip'; link.click(); URL.revokeObjectURL(url); }); });
}
function requestKey() { const key = prompt('Enter your AdForge operator key'); if (key) { state.key = key; sessionStorage.setItem('adforge-key', key); void load(); } }
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; }

$('#new-project').onclick = () => $('#project-dialog').showModal();
$('#close-dialog').onclick = () => $('#project-dialog').close();
$('#set-key').onclick = requestKey;
$('#refresh').onclick = load;
$('#create-demo').onclick = async () => { await api('/api/projects/demo/create', { method: 'POST' }); await load(); };
$('#intake-form').onsubmit = async (event) => { event.preventDefault(); const button = event.submitter; button.disabled = true; button.textContent = 'Queuing…'; try { await api('/api/intake', { method: 'POST', body: new FormData(event.target) }); event.target.reset(); $('#project-dialog').close(); await load(); } catch (error) { alert(error.message); } finally { button.disabled = false; button.textContent = 'Queue project →'; } };

void load();
setInterval(load, 5000);
