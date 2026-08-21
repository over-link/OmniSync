async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

// ─── Accordion (Setup page modules, and Field mapping's own sub-tiers) ──
// Only one item open at a time within a given accordion — clicking a
// closed header opens it and closes its siblings; clicking the
// already-open one just collapses it. Shared by the top-level accordion
// and the Field mapping sub-accordion, each wired independently so
// opening a sub-tier doesn't affect which top-level module is open.
function wireAccordion(containerId, itemClass, headerClass) {
  document.querySelectorAll(`#${containerId} .${headerClass}`).forEach((header) => {
    header.addEventListener('click', () => {
      const item = header.closest(`.${itemClass}`);
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll(`#${containerId} .${itemClass}`).forEach((i) => i.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });
}
wireAccordion('setup-accordion', 'accordion-item', 'accordion-header');
wireAccordion('field-mapping-subaccordion', 'subaccordion-item', 'subaccordion-header');

/** Opens the top-level "Field mapping" module and its "Mapping warnings"
 * sub-tab — used by the page-top warning banner so clicking it jumps
 * straight to the relevant place instead of just describing where to go. */
function openMappingWarningsTab() {
  document.querySelectorAll('#setup-accordion .accordion-item').forEach((i) => i.classList.remove('open'));
  document.querySelector('#setup-accordion .accordion-item[data-step="field-mapping"]').classList.add('open');
  document.querySelectorAll('#field-mapping-subaccordion .subaccordion-item').forEach((i) => i.classList.remove('open'));
  document.querySelector('#field-mapping-subaccordion .subaccordion-item[data-substep="warnings"]').classList.add('open');
  document.getElementById('setup-top-warning').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
document.getElementById('setup-top-warning').addEventListener('click', openMappingWarningsTab);

let currentRevizto = { connected: false };
let currentAcc = { connected: false };

window.addEventListener('app:ready', async (e) => {
  // nav.js already redirects non-admins away from this page — if we get
  // here, the user is an admin. Still guard against the brief moment
  // before that redirect fires.
  if (!e.detail.user || e.detail.user.role !== 'admin') return;
  currentRevizto = e.detail.revizto;
  currentAcc = e.detail.acc;
  document.getElementById('revizto-region-hidden').value = e.detail.revizto.region || 'virginia';
  await loadLicenseAndHubOptions();
  updateLicenseHubDot();
  await Promise.all([
    currentRevizto.connected && currentRevizto.licenseId ? loadReviztoProjectOptions() : Promise.resolve(),
    currentAcc.connected && currentAcc.hubId ? loadAccProjectOptions() : Promise.resolve(),
  ]);
  await loadProjects();
  await loadActiveProjectOptions();
});

// ─── Shared project selector (warnings + field mapping) ───────────

async function loadActiveProjectOptions() {
  const { projects } = await api('/api/projects');
  const select = document.getElementById('active-project-select');
  select.innerHTML = '<option value="">Select a project</option>' + projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');

  const lastProjectId = localStorage.getItem('setup:lastProjectId');
  if (lastProjectId && projects.some((p) => String(p.id) === lastProjectId)) {
    select.value = lastProjectId;
    await onActiveProjectChange(lastProjectId);
  }
}

async function onActiveProjectChange(projectId) {
  const warningsEl = document.getElementById('setup-warnings');
  const mappingPanels = document.getElementById('mapping-panels');
  const autoSyncPanels = document.getElementById('auto-sync-panels');
  if (!projectId) {
    warningsEl.classList.add('hidden');
    mappingPanels.classList.add('hidden');
    autoSyncPanels.classList.add('hidden');
    document.getElementById('mapping-warnings-caution').classList.add('hidden');
    document.getElementById('setup-top-warning').classList.add('hidden');
    return;
  }
  warningsEl.classList.remove('hidden');
  mappingPanels.classList.remove('hidden');
  autoSyncPanels.classList.remove('hidden');
  // These four each populate their own independent section of the page —
  // no data dependencies between them — so running them in parallel
  // instead of stacked awaits cuts wall-clock load time roughly to the
  // slowest one instead of the sum of all four.
  await Promise.all([
    loadMappingWarnings(projectId),
    loadFieldMapping(projectId),
    loadAutoSyncSettings(projectId),
    loadManualUnlinkSetting(projectId),
  ]);
}

document.getElementById('active-project-select').addEventListener('change', async (e) => {
  const projectId = e.target.value;
  if (projectId) localStorage.setItem('setup:lastProjectId', projectId);
  else localStorage.removeItem('setup:lastProjectId');
  await onActiveProjectChange(projectId);
});

async function loadMappingWarnings(projectId) {
  const warningsEl = document.getElementById('setup-warnings');
  const cautionIcon = document.getElementById('mapping-warnings-caution');
  const topWarning = document.getElementById('setup-top-warning');
  const topWarningText = document.getElementById('setup-top-warning-text');
  warningsEl.textContent = 'Loading...';
  try {
    const { unmappedStatuses, unmappedStamps } = await api(`/api/projects/${projectId}/mapping-warnings`);
    const warnings = [];
    if (unmappedStatuses.length) {
      warnings.push(`⚠️ ${unmappedStatuses.length} status${unmappedStatuses.length === 1 ? '' : 'es'} in use but not mapped: ${unmappedStatuses.join(', ')}`);
    }
    if (unmappedStamps.length) {
      warnings.push(`⚠️ ${unmappedStamps.length} stamp${unmappedStamps.length === 1 ? '' : 's'} in use but not mapped: ${unmappedStamps.join(', ')}`);
    }
    warningsEl.innerHTML = warnings.length
      ? warnings.map((w) => `<div class="dashboard-warning">${w}</div>`).join('')
      : '<div class="hint">All in-use statuses and stamps are mapped.</div>';

    const totalUnmapped = unmappedStatuses.length + unmappedStamps.length;
    cautionIcon.classList.toggle('hidden', totalUnmapped === 0);
    topWarning.classList.toggle('hidden', totalUnmapped === 0);
    if (totalUnmapped > 0) {
      topWarningText.textContent = `${totalUnmapped} unmapped field${totalUnmapped === 1 ? '' : 's'} for this project`;
    }
  } catch (err) {
    warningsEl.textContent = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
    cautionIcon.classList.add('hidden');
    topWarning.classList.add('hidden');
  }
}

function updateLicenseHubDot() {
  const dot = document.getElementById('license-hub-dot');
  const connected = !!(currentRevizto.licenseId && currentAcc.hubId);
  dot.classList.toggle('connected', connected);
  dot.title = connected ? 'License and hub both set' : 'Select and save both to enable project pairing below';
}

async function loadLicenseAndHubOptions() {
  const licenseSelect = document.getElementById('license-select');
  const hubSelect = document.getElementById('acc-hub-select');

  if (!currentRevizto.connected) {
    licenseSelect.innerHTML = '<option value="">Connect Revizto on My Connections first</option>';
  } else {
    licenseSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      const { licenses } = await api('/api/revizto/licenses');
      licenseSelect.innerHTML = licenses.length
        ? licenses
            .map(
              (l) =>
                `<option value="${l.uuid}" ${String(l.uuid) === String(currentRevizto.licenseId) ? 'selected' : ''}>${l.name} (${l.region}${l.frozen ? ' — suspended' : ''})</option>`
            )
            .join('')
        : '<option value="">No licenses found</option>';
    } catch {
      licenseSelect.innerHTML = '<option value="">—</option>';
    }
  }

  if (!currentAcc.connected) {
    hubSelect.innerHTML = '<option value="">Connect ACC on My Connections first</option>';
  } else {
    hubSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      const { hubs } = await api('/api/acc/hubs');
      hubSelect.innerHTML = hubs.length
        ? hubs.map((h) => `<option value="${h.id}" ${String(h.id) === String(currentAcc.hubId) ? 'selected' : ''}>${h.name}</option>`).join('')
        : '<option value="">No hubs found</option>';
    } catch {
      hubSelect.innerHTML = '<option value="">—</option>';
    }
  }
}

document.getElementById('license-hub-save-btn').addEventListener('click', async () => {
  const licenseId = document.getElementById('license-select').value;
  const hubId = document.getElementById('acc-hub-select').value;
  const resultEl = document.getElementById('license-hub-result');
  if (!licenseId && !hubId) return;
  resultEl.textContent = 'Saving...';
  try {
    await Promise.all([
      licenseId ? api('/auth/revizto/license', { method: 'POST', body: JSON.stringify({ licenseId }) }) : Promise.resolve(),
      hubId ? api('/auth/acc/hub', { method: 'POST', body: JSON.stringify({ hubId }) }) : Promise.resolve(),
    ]);
    if (licenseId) currentRevizto.licenseId = licenseId;
    if (hubId) currentAcc.hubId = hubId;
    updateLicenseHubDot();
    resultEl.textContent = 'Saved ✓';
    await Promise.all([loadReviztoProjectOptions(), loadAccProjectOptions()]);
  } catch (err) {
    resultEl.textContent = err.message;
  }
});

// ─── Field mapping ────────────────────────────────────────────────

let mappingOptions = null;

async function loadFieldMapping(projectId) {
  const statusRows = document.getElementById('status-map-rows');
  const typeRows = document.getElementById('type-map-rows');
  statusRows.textContent = 'Loading...';
  typeRows.textContent = 'Loading...';
  try {
    const [options, statusMapRes, typeMapRes] = await Promise.all([
      api(`/api/projects/${projectId}/mapping-options`),
      api(`/api/projects/${projectId}/status-map`),
      api(`/api/projects/${projectId}/type-map`),
    ]);
    mappingOptions = options;
    renderStatusMapRows(options, statusMapRes.map);
    renderTypeMapRows(options, typeMapRes.map);
  } catch (err) {
    const msg = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
    statusRows.textContent = msg;
    typeRows.textContent = msg;
  }
}

function prettyStatus(s) {
  const withSpaces = s.replace(/_/g, ' ');
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

// One row per mappable status name — shared by both the required (in-use)
// and optional (defined but unused) tiers below. Optional rows never get
// the red "unmapped" treatment and show "Optional mapping" as their
// placeholder instead of "-Select ACC Status-", since nothing real is
// waiting on them yet. `workflowMap` is this ONE workflow's saved
// mappings (with the '' legacy bucket already folded in by the caller),
// so the same status name in a different workflow can show/save a
// different ACC target. `secondaryOptions` is ACC's "Revizto Status"
// list field's own options (or null if that field doesn't exist in ACC
// yet) — used to disambiguate the ACC->Revizto direction when several
// statuses in this workflow share the same primary ACC status.
function statusMapRowHtml(s, workflowUuid, workflowMap, accStatuses, secondaryOptions, { optional }) {
  const mapped = workflowMap[s];
  const cls = !mapped && !optional ? ' mapping-select-unmapped' : '';
  const title = optional
    ? 'Optional — no issue uses this status yet'
    : mapped
      ? ''
      : 'Not mapped — defaults to ACC \'Draft\' until configured';
  const placeholder = optional ? 'Optional mapping' : '-Select ACC Status-';

  // Exact-name auto-match against ACC's "Revizto Status" options — same
  // zero-config idea as the 4 canonical statuses, extended to any custom
  // status whose name already matches an ACC option. An explicit saved
  // mapping (mapped.accCustomStatusOptionId) always takes precedence over
  // this, even if it happens to equal the auto-match.
  const autoSecondaryMatch = secondaryOptions?.find((o) => o.label.trim().toLowerCase() === s.trim().toLowerCase()) || null;

  let secondaryHtml;
  if (secondaryOptions === null) {
    secondaryHtml = `<select class="acc-custom-status-select" disabled title="Create a 'Revizto Status' list field in ACC to enable this">
      <option value="">Not available</option>
    </select>`;
  } else if (!mapped?.accCustomStatusOptionId && autoSecondaryMatch) {
    secondaryHtml = `<span class="badge badge-neutral" title="Auto-mapped — the Revizto status name matches an ACC \"Revizto Status\" option exactly">${autoSecondaryMatch.label} · auto</span>`;
  } else {
    const secondaryMapped = mapped?.accCustomStatusOptionId || '';
    const secondaryCls = !optional && !secondaryMapped ? ' mapping-select-unmapped' : '';
    secondaryHtml = `<select class="acc-custom-status-select${secondaryCls}">
      <option value="">${optional ? 'Optional' : '-Select-'}</option>
      ${secondaryOptions.map((o) => `<option value="${o.id}" ${secondaryMapped === o.id ? 'selected' : ''}>${o.label}</option>`).join('')}
    </select>`;
  }

  return `<div class="mapping-row" data-revizto-status="${s}" data-workflow-uuid="${workflowUuid}">
    <span>${s}</span>
    <select class="status-select${cls}" title="${title}">
      <option value="">${placeholder}</option>
      ${accStatuses.map((a) => `<option value="${a}" ${mapped?.accStatus === a ? 'selected' : ''}>${prettyStatus(a)}</option>`).join('')}
    </select>
    ${secondaryHtml}
  </div>`;
}

function renderStatusMapRows(options, currentMap) {
  const container = document.getElementById('status-map-rows');
  const autoMapped = options.autoMappedStatuses || [];
  const workflows = options.workflows || [];

  if (!autoMapped.length && !workflows.length) {
    container.textContent = 'No Revizto statuses found yet — statuses appear here once an issue with that status exists, or once a workflow defines one.';
    return;
  }

  // Column headers, once at the top — the same 3-column grid as every row
  // below, so the three headers line up directly over their column.
  const columnHeadersHtml = `<div class="status-map-column-headers">
    <span>Revizto Status</span>
    <span>ACC Primary Status</span>
    <span>ACC Secondary Status</span>
  </div>`;

  // Read-only: the 4 canonical status names always auto-map to a fixed
  // ACC status, no admin config needed, in any workflow — grouped under
  // "Standard Workflow" (same visual treatment as a real custom workflow
  // group) so it's clear they're already handled, using a distinct class
  // (not .mapping-row) so the save button's row query below doesn't pick
  // these up and choke on the missing .status-select. No secondary column
  // here — canonical statuses aren't ambiguous by definition, so the
  // "Revizto Status" disambiguation field doesn't apply to them.
  const autoRowsHtml = autoMapped.length
    ? `<div class="workflow-group">
        <div class="workflow-group-header">Standard Workflow</div>
        ${autoMapped
          .map(
            (s) => `<div class="status-auto-row" title="Auto-mapped — no configuration needed, in any workflow">
              <span>${s.name}</span>
              <span class="badge badge-neutral status-auto-badge">${prettyStatus(s.accStatus)} · auto</span>
            </div>`
          )
          .join('')}
      </div>`
    : '';

  // One group per custom workflow currently in use — a same-named status
  // in two different workflows is mapped independently (data-workflow-uuid
  // on each row disambiguates them for the save handler below). The ''
  // legacy bucket (mappings saved before workflow scoping existed) is
  // folded in as a fallback so those keep showing as mapped.
  const workflowGroupsHtml = workflows.length
    ? workflows
        .map((w) => {
          const workflowMap = { ...(currentMap[''] || {}), ...(currentMap[w.uuid] || {}) };
          const requiredHtml = w.required.length
            ? w.required.map((s) => statusMapRowHtml(s, w.uuid, workflowMap, options.accStatuses, w.customStatusOptions, { optional: false })).join('')
            : '';
          const optionalHtml = w.optional.length
            ? `<div class="hint" style="margin-top:0.4rem;">Optional — not used by any issue yet:</div>` +
              w.optional.map((s) => statusMapRowHtml(s, w.uuid, workflowMap, options.accStatuses, w.customStatusOptions, { optional: true })).join('')
            : '';
          // Each workflow can have its own dedicated ACC field (e.g.
          // "Revizto Status - Pre Pour Checklist") — flag it per group,
          // not once globally, since one workflow's field can exist while
          // another's doesn't.
          const noFieldHint =
            w.customStatusOptions === null
              ? `<div class="hint" style="margin-top:0.4rem;">ACC Secondary Status is disabled for this workflow — create a list-type custom field in ACC named "Revizto Status" or "Revizto Status - ${w.label}" to enable it.</div>`
              : '';
          return `<div class="workflow-group">
            <div class="workflow-group-header">${w.label}</div>
            ${requiredHtml}${optionalHtml}${noFieldHint}
          </div>`;
        })
        .join('')
    : '<div class="hint">No other custom statuses in use yet.</div>';

  container.innerHTML = columnHeadersHtml + autoRowsHtml + workflowGroupsHtml;
}

document.getElementById('save-status-map-btn').addEventListener('click', async () => {
  const projectId = document.getElementById('active-project-select').value;
  const resultEl = document.getElementById('status-map-result');
  const mappings = [...document.querySelectorAll('#status-map-rows .mapping-row')]
    .map((row) => ({
      workflowUuid: row.dataset.workflowUuid,
      reviztoStatus: row.dataset.reviztoStatus,
      accStatus: row.querySelector('.status-select').value,
      accCustomStatusOptionId: row.querySelector('.acc-custom-status-select:not(:disabled)')?.value || null,
    }))
    .filter((m) => m.accStatus);
  try {
    await api(`/api/projects/${projectId}/status-map`, { method: 'POST', body: JSON.stringify({ mappings }) });
    resultEl.textContent = 'Saved ✓';
    // Re-render from the just-saved data so the red "unmapped" highlight
    // (primary and secondary) clears immediately — the rows were built
    // from the state at page-load time, which the save above just made
    // stale, and nothing was re-rendering them after a save before this.
    const statusMapRes = await api(`/api/projects/${projectId}/status-map`);
    renderStatusMapRows(mappingOptions, statusMapRes.map);
  } catch (err) {
    resultEl.textContent = err.message;
  }
});

// One row per stamp actually in use (options.reviztoStamps, already
// filtered to in-use by the backend) — no manual "add row" step needed.
// Unmapped ones get a red-highlighted select so they're impossible to
// miss, instead of silently having no row at all. Falls back to the
// project's default ACC subtype server-side if left unmapped (see
// reviztoService.toAccIssue), so this is a visibility aid, not something
// that blocks issues from syncing.
function renderTypeMapRows(options, currentMap) {
  const container = document.getElementById('type-map-rows');
  const stamps = options.reviztoStamps || [];
  if (!stamps.length) {
    container.textContent = 'No Revizto stamps in use yet — they appear here once an issue with that stamp exists.';
    return;
  }
  container.innerHTML = stamps
    .map((s) => {
      const mapped = currentMap[s.value];
      return `<div class="mapping-row" data-revizto-type="${s.value}">
        <span>${s.label}</span>
        <span class="bridge-connector" aria-hidden="true">→</span>
        <select class="subtype-select${mapped ? '' : ' mapping-select-unmapped'}" title="${mapped ? '' : 'Not mapped — defaults to the project\'s default ACC issue type until configured'}">
          <option value="">-Select ACC Issue Type-</option>
          ${(options.accSubtypes || []).map((a) => `<option value="${a.id}" ${a.id === mapped ? 'selected' : ''}>${a.label}</option>`).join('')}
        </select>
      </div>`;
    })
    .join('');
}

document.getElementById('save-type-map-btn').addEventListener('click', async () => {
  const projectId = document.getElementById('active-project-select').value;
  const resultEl = document.getElementById('type-map-result');
  const mappings = [...document.querySelectorAll('#type-map-rows .mapping-row')]
    .map((row) => ({
      reviztoType: row.dataset.reviztoType,
      accSubtypeId: row.querySelector('.subtype-select').value,
    }))
    .filter((m) => m.reviztoType && m.accSubtypeId);
  try {
    await api(`/api/projects/${projectId}/type-map`, { method: 'POST', body: JSON.stringify({ mappings }) });
    resultEl.textContent = 'Saved ✓';
    await loadFieldMapping(projectId); // re-render so the red highlight clears for newly-mapped stamps
  } catch (err) {
    resultEl.textContent = err.message;
  }
});

let reviztoProjectOptions = []; // {id, uuid, title}
let accProjectOptions = []; // {id, name}
let currentProjectsList = [];
let editingPairingId = null; // number | null

async function loadReviztoProjectOptions() {
  try {
    const { projects } = await api('/api/revizto/projects');
    reviztoProjectOptions = projects;
  } catch {
    reviztoProjectOptions = [];
  }
  renderProjectPairings();
}

async function loadAccProjectOptions() {
  if (!currentAcc.hubId) {
    accProjectOptions = [];
    renderProjectPairings();
    return;
  }
  try {
    const { projects } = await api(`/api/acc/hubs/${currentAcc.hubId}/projects`);
    accProjectOptions = projects;
  } catch {
    accProjectOptions = [];
  }
  renderProjectPairings();
}

async function loadProjects() {
  const { projects } = await api('/api/projects');
  currentProjectsList = projects;
  renderProjectPairings();
}

// One row per saved pairing — locked (plain names + "Modify pairing") by
// default so an admin can't accidentally change a live pairing, editable
// dropdowns only while that specific row is being modified. The dot
// reflects whether the sync webhook is actually registered (set
// automatically on save — see routes/index.js's _autoRegisterWebhook),
// not just "this row exists in the DB".
function pairingRowHtml(p) {
  if (editingPairingId !== p.id) {
    const missingIdHtml = p.revizto_project_id
      ? ''
      : `<div class="hint pairing-missing-id">Missing numeric Revizto project ID (needed for comment sync) —
          <input type="number" class="revizto-project-id-input" data-id="${p.id}" placeholder="numeric ID" style="width:100px" />
          <button type="button" class="btn secondary save-revizto-project-id-btn" data-id="${p.id}">Save</button>
        </div>`;
    return `<div class="pairing-row" data-id="${p.id}">
      <span class="pairing-row-name">${p.name}</span>
      <span class="pairing-dot${p.webhook_id ? ' connected' : ''}" title="${p.webhook_id ? 'Webhook registered — syncing active' : 'Webhook not registered yet — Modify and re-save to retry'}"></span>
      <span class="pairing-row-name">${p.acc_project_name || p.acc_project_id}</span>
      <button type="button" class="btn secondary modify-pairing-btn" data-id="${p.id}">Modify pairing</button>
    </div>${missingIdHtml}`;
  }
  return pairingEditRowHtml(p);
}

// No more "add new pairing" path here — each project has exactly one
// pairing, set once when the project itself is created. See the TODO in
// README ("Planned: multi-project workspaces") — that'll happen via the
// (not yet built) "+ New Project" button instead.
function pairingEditRowHtml(p) {
  const id = p.id;
  const reviztoOptionsHtml = reviztoProjectOptions
    .map((rp) => `<option value="${rp.uuid}" data-project-id="${rp.id}" ${rp.uuid === p.revizto_project_uuid ? 'selected' : ''}>${rp.title}</option>`)
    .join('');
  const accOptionsHtml = accProjectOptions
    .map((ap) => `<option value="${ap.id}" ${ap.id === p.acc_project_id ? 'selected' : ''}>${ap.name}</option>`)
    .join('');
  return `<div class="pairing-row pairing-row-editing" data-id="${id}">
    <select class="pairing-revizto-select" data-id="${id}">
      <option value="">${reviztoProjectOptions.length ? 'Select Revizto project' : 'No Revizto projects — set license above'}</option>
      ${reviztoOptionsHtml}
    </select>
    <span class="pairing-dot" aria-hidden="true"></span>
    <select class="pairing-acc-select" data-id="${id}">
      <option value="">${accProjectOptions.length ? 'Select ACC project' : 'No ACC projects — set hub above'}</option>
      ${accOptionsHtml}
    </select>
  </div>
  <div class="pairing-extra-fields">
    <label>Default ACC issue type (safeguard for unmapped stamps):</label>
    <select class="pairing-default-subtype-select" data-id="${id}" data-current="${p.acc_default_subtype_id || ''}"><option value="">Loading...</option></select>
  </div>
  <div class="pairing-actions">
    <button type="button" class="btn save-pairing-btn" data-id="${id}">Save</button>
    <button type="button" class="btn secondary cancel-pairing-btn" data-id="${id}">Cancel</button>
    <span class="pairing-result" data-id="${id}"></span>
  </div>`;
}

function renderProjectPairings() {
  const container = document.getElementById('project-pairing-rows');
  if (!currentProjectsList.length) {
    container.innerHTML = '<p class="hint">No project paired yet — use "+ New Project" above to set one up (coming soon).</p>';
    return;
  }
  container.innerHTML = currentProjectsList.map((p) => pairingRowHtml(p)).join('');
  wirePairingRowHandlers();
}

function wirePairingRowHandlers() {
  const container = document.getElementById('project-pairing-rows');

  container.querySelectorAll('.modify-pairing-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingPairingId = Number(btn.dataset.id);
      renderProjectPairings();
    });
  });
  container.querySelectorAll('.cancel-pairing-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingPairingId = null;
      renderProjectPairings();
    });
  });
  container.querySelectorAll('.save-revizto-project-id-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const input = document.querySelector(`.revizto-project-id-input[data-id="${id}"]`);
      const value = input.value.trim();
      if (!value) return;
      try {
        await api(`/api/projects/${id}/revizto-project-id`, { method: 'PATCH', body: JSON.stringify({ revizto_project_id: value }) });
        await loadProjects();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Editing row, if any: populate the default-subtype dropdown and wire Save.
  container.querySelectorAll('.pairing-default-subtype-select').forEach((select) => {
    const id = select.dataset.id;
    const current = select.dataset.current;
    api(`/api/projects/${id}/subtypes`)
      .then(({ subtypes }) => {
        select.innerHTML =
          '<option value="">— none set —</option>' +
          subtypes.map((s) => `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${s.issueTypeTitle} > ${s.title}</option>`).join('');
      })
      .catch(() => {
        select.innerHTML = '<option value="">Could not load ACC issue types</option>';
      });
  });

  container.querySelectorAll('.save-pairing-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const reviztoSelect = document.querySelector(`.pairing-revizto-select[data-id="${id}"]`);
      const accSelect = document.querySelector(`.pairing-acc-select[data-id="${id}"]`);
      const resultEl = document.querySelector(`.pairing-result[data-id="${id}"]`);
      const reviztoOption = reviztoSelect.options[reviztoSelect.selectedIndex];
      const accOption = accSelect.options[accSelect.selectedIndex];
      if (!reviztoSelect.value || !accSelect.value) {
        resultEl.textContent = 'Select both a Revizto project and an ACC project.';
        return;
      }
      const body = {
        name: reviztoOption.textContent,
        revizto_project_uuid: reviztoSelect.value,
        revizto_project_id: reviztoOption.dataset.projectId || '',
        revizto_region: document.getElementById('revizto-region-hidden').value,
        acc_hub_id: currentAcc.hubId,
        acc_project_id: accSelect.value,
        acc_project_name: accOption.textContent,
      };
      const subtypeSelect = document.querySelector(`.pairing-default-subtype-select[data-id="${id}"]`);
      if (subtypeSelect && subtypeSelect.value) {
        await api(`/api/projects/${id}/default-subtype`, {
          method: 'PATCH',
          body: JSON.stringify({ acc_default_subtype_id: subtypeSelect.value }),
        }).catch(() => {}); // best-effort — the pairing save below is the important one
      }
      resultEl.textContent = 'Saving...';
      try {
        await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        editingPairingId = null;
        await loadProjects();
        await loadActiveProjectOptions();
      } catch (err) {
        resultEl.textContent = err.message;
      }
    });
  });
}

// ─── Auto-sync by filter ────────────────────────────────────────────
// Same field split as the Issues page's own filters (public/js/issues.js)
// — kept in sync manually since one's this page's script and one's that
// page's, but the option-building/matching semantics are identical.
const AUTO_SYNC_SCALAR_FIELDS = ['status', 'stampCategory', 'issueType', 'stamp', 'assignee', 'assigneeCompany', 'priority', 'isClash'];
const AUTO_SYNC_ARRAY_FIELDS = ['tags', 'level', 'zone', 'room'];
const AUTO_SYNC_ALL_FIELDS = [...AUTO_SYNC_SCALAR_FIELDS, ...AUTO_SYNC_ARRAY_FIELDS];
let autoSyncFilters = Object.fromEntries(AUTO_SYNC_ALL_FIELDS.map((f) => [f, []]));
let autoSyncBoard = [];

// Mirrors syncService.js's _matchesAutoSyncFilters exactly (AND across
// fields, OR within a field's selected values) — kept in sync manually
// since one's server-side and one's client-side, same as the field lists
// above. Only counts currently-unlinked issues, since linked ones are
// never touched by auto-sync.
function updateAutoSyncCount() {
  const countEl = document.getElementById('auto-sync-issue-count');
  const matching = autoSyncBoard.filter((i) => {
    if (i.linked) return false;
    return AUTO_SYNC_ALL_FIELDS.every((field) => {
      const selected = autoSyncFilters[field];
      if (!selected.length) return true;
      if (AUTO_SYNC_ARRAY_FIELDS.includes(field)) return (i[field] || []).some((v) => selected.includes(v));
      return selected.includes(i[field]);
    });
  });
  countEl.textContent = `${matching.length} unlinked issue${matching.length === 1 ? '' : 's'} would be auto-linked`;
}

// Renders (or re-renders) a single auto-sync filter field's dropdown from
// the currently-loaded autoSyncBoard — shared by the initial load and the
// reset button, so there's one place that builds options from board data.
function renderAutoSyncField(field) {
  const container = document.getElementById(`auto-sync-filter-${field}`);
  const values = AUTO_SYNC_ARRAY_FIELDS.includes(field)
    ? [...new Set(autoSyncBoard.flatMap((i) => i[field] || []))].sort()
    : [...new Set(autoSyncBoard.map((i) => i[field]).filter(Boolean))].sort();
  // Drop selections for values no longer present in the board.
  autoSyncFilters[field] = autoSyncFilters[field].filter((v) => values.includes(v));
  renderMultiSelect(container, values, autoSyncFilters[field], (updated) => {
    autoSyncFilters[field] = updated;
    updateAutoSyncCount();
  });
}

// Filters are greyed out and non-interactive until the toggle is on —
// explicit request, so it's visually obvious the criteria below don't do
// anything while auto-sync itself is off.
function updateAutoSyncLockState() {
  const enabled = document.getElementById('auto-sync-enabled-toggle').checked;
  document.getElementById('auto-sync-filters-card').classList.toggle('filters-locked', !enabled);
}
document.getElementById('auto-sync-enabled-toggle').addEventListener('change', updateAutoSyncLockState);

document.getElementById('reset-auto-sync-filters-btn').addEventListener('click', () => {
  for (const field of AUTO_SYNC_ALL_FIELDS) {
    autoSyncFilters[field] = [];
    renderAutoSyncField(field);
  }
  updateAutoSyncCount();
});

async function loadAutoSyncSettings(projectId) {
  const resultEl = document.getElementById('auto-sync-result');
  resultEl.textContent = '';
  try {
    // Filter option VALUES come from the same board data the Issues page
    // itself filters on — real values currently in the project, not a
    // separate options endpoint.
    const [{ board }, saved] = await Promise.all([
      api(`/api/projects/${projectId}/issues-board`),
      api(`/api/projects/${projectId}/auto-sync-filters`),
    ]);
    autoSyncBoard = board;
    document.getElementById('auto-sync-enabled-toggle').checked = !!saved.enabled;
    updateAutoSyncLockState();
    autoSyncFilters = Object.fromEntries(AUTO_SYNC_ALL_FIELDS.map((f) => [f, saved.filters?.[f] || []]));

    for (const field of AUTO_SYNC_ALL_FIELDS) renderAutoSyncField(field);
    updateAutoSyncCount();
  } catch (err) {
    resultEl.textContent = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
  }
}

document.getElementById('save-auto-sync-btn').addEventListener('click', async () => {
  const projectId = document.getElementById('active-project-select').value;
  const resultEl = document.getElementById('auto-sync-result');
  const enabled = document.getElementById('auto-sync-enabled-toggle').checked;
  try {
    await api(`/api/projects/${projectId}/auto-sync-filters`, {
      method: 'POST',
      body: JSON.stringify({ enabled, filters: autoSyncFilters }),
    });
    resultEl.textContent = 'Saved ✓';
  } catch (err) {
    resultEl.textContent = err.message;
  }
});

// ─── Issue linking (manual unlink toggle) ────────────────────────────

async function loadManualUnlinkSetting(projectId) {
  const resultEl = document.getElementById('allow-manual-unlink-result');
  resultEl.textContent = '';
  try {
    const { projects } = await api('/api/projects');
    const project = projects.find((p) => String(p.id) === String(projectId));
    document.getElementById('allow-manual-unlink-toggle').checked = !!project?.allow_manual_unlink;
  } catch (err) {
    resultEl.textContent = err.message;
  }
}

document.getElementById('allow-manual-unlink-toggle').addEventListener('change', async (e) => {
  const projectId = document.getElementById('active-project-select').value;
  const resultEl = document.getElementById('allow-manual-unlink-result');
  if (!projectId) {
    e.target.checked = false;
    return;
  }
  try {
    await api(`/api/projects/${projectId}/allow-manual-unlink`, {
      method: 'POST',
      body: JSON.stringify({ enabled: e.target.checked }),
    });
    resultEl.textContent = 'Saved ✓';
  } catch (err) {
    e.target.checked = !e.target.checked; // revert the toggle, the save didn't actually take
    resultEl.textContent = err.message;
  }
});
