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

window.addEventListener('app:ready', async (e) => {
  // nav.js already redirects non-admins away from this page — if we get
  // here, the user is an admin. Still guard against the brief moment
  // before that redirect fires.
  if (!e.detail.user || e.detail.user.role !== 'admin') return;
  document.getElementById('license-status').textContent = e.detail.revizto.licenseId || 'Not set';
  document.getElementById('license-status').className = 'badge ' + (e.detail.revizto.licenseId ? 'badge-success' : 'badge-neutral');
  if (e.detail.revizto.connected) await loadLicenseOptions(e.detail.revizto.licenseId);
  if (e.detail.revizto.connected && e.detail.revizto.licenseId) await loadReviztoProjectOptions();
  document.getElementById('revizto-region-hidden').value = e.detail.revizto.region || 'virginia';
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
  if (!projectId) {
    warningsEl.classList.add('hidden');
    mappingPanels.classList.add('hidden');
    return;
  }
  warningsEl.classList.remove('hidden');
  mappingPanels.classList.remove('hidden');
  await loadMappingWarnings(projectId);
  await loadFieldMapping(projectId);
}

document.getElementById('active-project-select').addEventListener('change', async (e) => {
  const projectId = e.target.value;
  if (projectId) localStorage.setItem('setup:lastProjectId', projectId);
  else localStorage.removeItem('setup:lastProjectId');
  await onActiveProjectChange(projectId);
});

async function loadMappingWarnings(projectId) {
  const warningsEl = document.getElementById('setup-warnings');
  warningsEl.textContent = 'Loading...';
  try {
    const { unmappedStatuses, unmappedStamps, unmappedAccStatuses } = await api(`/api/projects/${projectId}/mapping-warnings`);
    const warnings = [];
    if (unmappedStatuses.length) {
      warnings.push(`⚠️ ${unmappedStatuses.length} status${unmappedStatuses.length === 1 ? '' : 'es'} in use but not mapped: ${unmappedStatuses.join(', ')}`);
    }
    if (unmappedStamps.length) {
      warnings.push(`⚠️ ${unmappedStamps.length} stamp${unmappedStamps.length === 1 ? '' : 's'} in use but not mapped: ${unmappedStamps.join(', ')}`);
    }
    if (unmappedAccStatuses && unmappedAccStatuses.length) {
      warnings.push(`⚠️ ${unmappedAccStatuses.length} ACC status${unmappedAccStatuses.length === 1 ? '' : 'es'} not mapped back to Revizto (using a built-in guess): ${unmappedAccStatuses.map(prettyStatus).join(', ')}`);
    }
    warningsEl.innerHTML = warnings.length
      ? warnings.map((w) => `<div class="dashboard-warning">${w}</div>`).join('')
      : '<div class="hint">All in-use statuses and stamps are mapped.</div>';
  } catch (err) {
    warningsEl.textContent = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
  }
}

async function loadLicenseOptions(currentLicenseId) {
  const select = document.getElementById('license-select');
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const { licenses } = await api('/api/revizto/licenses');
    if (!licenses.length) {
      select.innerHTML = '<option value="">No licenses found</option>';
      return;
    }
    select.innerHTML = licenses
      .map(
        (l) =>
          `<option value="${l.uuid}" ${String(l.uuid) === String(currentLicenseId) ? 'selected' : ''}>${l.name} (${l.region}${l.frozen ? ' — suspended' : ''})</option>`
      )
      .join('');
  } catch (err) {
    select.innerHTML = '<option value="">—</option>';
  }
}

document.getElementById('license-save-btn').addEventListener('click', async () => {
  const licenseId = document.getElementById('license-select').value;
  if (!licenseId) return;
  const statusEl = document.getElementById('license-status');
  try {
    await api('/auth/revizto/license', { method: 'POST', body: JSON.stringify({ licenseId }) });
    statusEl.textContent = licenseId;
    statusEl.className = 'badge badge-success';
    await loadReviztoProjectOptions();
  } catch (err) {
    alert(err.message);
  }
});

// ─── Field mapping ────────────────────────────────────────────────

let mappingOptions = null;

async function loadFieldMapping(projectId) {
  const statusRows = document.getElementById('status-map-rows');
  const typeRows = document.getElementById('type-map-rows');
  const accStatusRows = document.getElementById('acc-status-map-rows');
  statusRows.textContent = 'Loading...';
  typeRows.textContent = 'Loading...';
  accStatusRows.textContent = 'Loading...';
  try {
    const [options, statusMapRes, typeMapRes, accStatusMapRes] = await Promise.all([
      api(`/api/projects/${projectId}/mapping-options`),
      api(`/api/projects/${projectId}/status-map`),
      api(`/api/projects/${projectId}/type-map`),
      api(`/api/projects/${projectId}/acc-status-map`),
    ]);
    mappingOptions = options;
    renderStatusMapRows(options, statusMapRes.map);
    renderTypeMapRows(options, typeMapRes.map);
    renderAccStatusMapRows(options, accStatusMapRes.map);
  } catch (err) {
    const msg = err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message;
    statusRows.textContent = msg;
    typeRows.textContent = msg;
    accStatusRows.textContent = msg;
  }
}

function prettyStatus(s) {
  const withSpaces = s.replace(/_/g, ' ');
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

function renderStatusMapRows(options, currentMap) {
  const container = document.getElementById('status-map-rows');
  const autoMapped = options.autoMappedStatuses || [];
  const mappable = options.reviztoStatuses || [];

  if (!autoMapped.length && !mappable.length) {
    container.textContent = 'No Revizto statuses found yet — statuses appear here once an issue with that status exists.';
    return;
  }

  // Read-only: "To do"/"Completed" category statuses always auto-map to a
  // fixed ACC status, no admin config needed — shown greyed out so it's
  // clear they're already handled, using a distinct class (not
  // .mapping-row) so the save button's row query below doesn't pick these
  // up and choke on the missing .status-select.
  const autoRowsHtml = autoMapped
    .map(
      (s) => `<div class="status-auto-row" title="Auto-mapped by status category (${s.category}) — no configuration needed">
        <span>${s.name}</span>
        <span class="bridge-connector" aria-hidden="true">→</span>
        <span class="badge badge-neutral">${prettyStatus(s.accStatus)} · auto</span>
      </div>`
    )
    .join('');

  // Editable: "Tracking" category statuses (the ones needing a judgment
  // call between ACC statuses like in_progress/in_review/etc.), shown for
  // every current issue so an admin can configure the project correctly
  // from the start. Unmapped ones are highlighted red — they still sync
  // (defaulting to ACC "Draft" as a safeguard, see toAccIssue), but
  // should be mapped explicitly.
  const editableRowsHtml = mappable.length
    ? mappable
        .map((s) => {
          const mapped = currentMap[s];
          return `<div class="mapping-row" data-revizto-status="${s}">
            <span>${s}</span>
            <span class="bridge-connector" aria-hidden="true">→</span>
            <select class="status-select${mapped ? '' : ' mapping-select-unmapped'}" title="${mapped ? '' : 'Not mapped — defaults to ACC \'Draft\' until configured'}">
              <option value="">-Select ACC Status-</option>
              ${options.accStatuses.map((a) => `<option value="${a}" ${mapped === a ? 'selected' : ''}>${prettyStatus(a)}</option>`).join('')}
            </select>
          </div>`;
        })
        .join('')
    : '<div class="hint">No "Tracking" category statuses in use yet.</div>';

  container.innerHTML = autoRowsHtml + editableRowsHtml;
}

document.getElementById('save-status-map-btn').addEventListener('click', async () => {
  const projectId = document.getElementById('active-project-select').value;
  const resultEl = document.getElementById('status-map-result');
  const mappings = [...document.querySelectorAll('#status-map-rows .mapping-row')]
    .map((row) => ({ reviztoStatus: row.dataset.reviztoStatus, accStatus: row.querySelector('.status-select').value }))
    .filter((m) => m.accStatus);
  try {
    await api(`/api/projects/${projectId}/status-map`, { method: 'POST', body: JSON.stringify({ mappings }) });
    resultEl.textContent = 'Saved ✓';
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

// The reverse direction: one row per ACC status (a fixed 9-value enum,
// not "in use" filtered — an admin should see all of them up front).
// 4 unambiguous ACC statuses (open/in_progress/completed/closed) always
// auto-map — read-only grey rows, same treatment as the forward
// direction's "To do"/"Completed". The remaining 5 are editable; unmapped
// ones are red-highlighted and fall back to a built-in guess
// (reviztoService.mapStatusFromAcc) server-side, so this doesn't block
// the ACC->Revizto pull, just flags that it's using a guess.
function renderAccStatusMapRows(options, currentMap) {
  const container = document.getElementById('acc-status-map-rows');
  const autoMapped = options.autoMappedAccStatuses || [];
  const mappable = options.mappableAccStatuses || [];
  if (!autoMapped.length && !mappable.length) {
    container.textContent = 'Could not load ACC statuses.';
    return;
  }

  const autoRowsHtml = autoMapped
    .map(
      (s) => `<div class="status-auto-row" title="Auto-mapped — no configuration needed">
        <span>${prettyStatus(s.accStatus)}</span>
        <span class="bridge-connector" aria-hidden="true">→</span>
        <span class="badge badge-neutral">${s.reviztoStatus} · auto</span>
      </div>`
    )
    .join('');

  const editableRowsHtml = mappable
    .map((accStatus) => {
      const mapped = currentMap[accStatus];
      return `<div class="mapping-row" data-acc-status="${accStatus}">
        <span>${prettyStatus(accStatus)}</span>
        <span class="bridge-connector" aria-hidden="true">→</span>
        <select class="revizto-status-select${mapped ? '' : ' mapping-select-unmapped'}" title="${mapped ? '' : 'Not mapped — falls back to a built-in guess until configured'}">
          <option value="">-Select Revizto Status-</option>
          ${(options.allReviztoStatusNames || []).map((s) => `<option value="${s}" ${s === mapped ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>`;
    })
    .join('');

  container.innerHTML = autoRowsHtml + editableRowsHtml;
}

document.getElementById('save-acc-status-map-btn').addEventListener('click', async () => {
  const projectId = document.getElementById('active-project-select').value;
  const resultEl = document.getElementById('acc-status-map-result');
  const mappings = [...document.querySelectorAll('#acc-status-map-rows .mapping-row')]
    .map((row) => ({
      accStatus: row.dataset.accStatus,
      reviztoStatus: row.querySelector('.revizto-status-select').value,
    }))
    .filter((m) => m.accStatus && m.reviztoStatus);
  try {
    await api(`/api/projects/${projectId}/acc-status-map`, { method: 'POST', body: JSON.stringify({ mappings }) });
    resultEl.textContent = 'Saved ✓';
    await loadFieldMapping(projectId);
    await loadMappingWarnings(projectId);
  } catch (err) {
    resultEl.textContent = err.message;
  }
});

async function loadReviztoProjectOptions() {
  const select = document.getElementById('revizto-project-select');
  const errorEl = document.getElementById('revizto-project-error');
  select.innerHTML = '<option value="">Loading...</option>';
  errorEl.textContent = '';
  try {
    const { projects } = await api('/api/revizto/projects');
    if (!projects.length) {
      select.innerHTML = '<option value="">No Revizto projects found</option>';
      return;
    }
    select.innerHTML = projects
      .map((p) => `<option value="${p.uuid}" data-project-id="${p.id}">${p.title} (${p.uuid})</option>`)
      .join('');
    updateReviztoProjectIdHidden();
  } catch (err) {
    select.innerHTML = '<option value="">—</option>';
    errorEl.textContent = err.data?.message || err.message || 'Connect Revizto on My Connections first.';
  }
}

function updateReviztoProjectIdHidden() {
  const select = document.getElementById('revizto-project-select');
  const selected = select.options[select.selectedIndex];
  document.getElementById('revizto-project-id-hidden').value = selected?.dataset.projectId || '';
}

document.getElementById('revizto-project-select').addEventListener('change', updateReviztoProjectIdHidden);
document.getElementById('revizto-project-refresh').addEventListener('click', loadReviztoProjectOptions);

async function loadProjects() {
  const { projects } = await api('/api/projects');
  const list = document.getElementById('projects-list');
  list.innerHTML = '';
  if (!projects.length) {
    list.textContent = 'No projects paired yet.';
    return;
  }
  for (const p of projects) {
    const row = document.createElement('div');
    row.className = 'project-row';
    row.innerHTML = `
      <strong>${p.name}</strong>
      <span>Revizto: ${p.revizto_project_uuid} (${p.revizto_region})</span>
      <span>ACC: ${p.acc_project_id}</span>
      <button data-id="${p.id}" class="btn secondary register-webhook-btn">Register ACC webhook</button>
      <button data-id="${p.id}" class="btn secondary relink-webhook-btn">Find &amp; relink existing webhook</button>
      <button data-id="${p.id}" class="btn secondary check-webhook-btn">Check webhook status</button>
      <button data-id="${p.id}" data-webhook-id="${p.webhook_id || ''}" class="btn secondary delete-webhook-btn">Delete webhook</button>
      <span class="webhook-result" data-id="${p.id}"></span>
      <div class="hint">Default ACC issue type (safeguard for unmapped stamps) —
        <select class="default-subtype-select" data-id="${p.id}" data-current="${p.acc_default_subtype_id || ''}"><option value="">Loading...</option></select>
        <button data-id="${p.id}" class="btn secondary save-default-subtype-btn">Save</button>
        <span class="default-subtype-result" data-id="${p.id}"></span>
      </div>
      ${
        p.revizto_project_id
          ? ''
          : `<div class="hint">Missing numeric Revizto project ID (needed for comment sync) —
              <input type="number" class="revizto-project-id-input" placeholder="numeric ID" style="width:100px" />
              <button data-id="${p.id}" class="btn secondary save-revizto-project-id-btn">Save</button>
            </div>`
      }
    `;
    list.appendChild(row);
  }
  // Separate async pass per project so N slow ACC subtype lookups don't
  // block the rest of the list from rendering.
  list.querySelectorAll('.default-subtype-select').forEach((select) => {
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
  list.querySelectorAll('.save-default-subtype-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const select = document.querySelector(`.default-subtype-select[data-id="${id}"]`);
      const resultEl = document.querySelector(`.default-subtype-result[data-id="${id}"]`);
      resultEl.textContent = 'Saving...';
      try {
        await api(`/api/projects/${id}/default-subtype`, {
          method: 'PATCH',
          body: JSON.stringify({ acc_default_subtype_id: select.value }),
        });
        resultEl.textContent = 'Saved ✓';
      } catch (err) {
        resultEl.textContent = err.message;
      }
    });
  });
  list.querySelectorAll('.register-webhook-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const resultEl = document.querySelector(`.webhook-result[data-id="${id}"]`);
      resultEl.textContent = 'Registering...';
      try {
        await api(`/api/projects/${id}/register-webhook`, { method: 'POST' });
        resultEl.textContent = 'Webhook registered ✓';
        await loadProjects();
      } catch (err) {
        resultEl.textContent = err.message;
      }
    });
  });
  list.querySelectorAll('.save-revizto-project-id-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const input = btn.previousElementSibling;
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
  list.querySelectorAll('.delete-webhook-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const hookId = btn.dataset.webhookId;
      const resultEl = document.querySelector(`.webhook-result[data-id="${id}"]`);
      if (!hookId) {
        resultEl.textContent = 'No webhook_id on record — try "Check webhook status" or "Find & relink" first.';
        return;
      }
      if (!confirm('Delete this webhook? You can re-register a fresh one after.')) return;
      resultEl.textContent = 'Deleting...';
      try {
        await api(`/api/projects/${id}/webhook/${hookId}`, { method: 'DELETE' });
        resultEl.textContent = 'Deleted ✓ — click "Register ACC webhook" to create a fresh one.';
        await loadProjects();
      } catch (err) {
        resultEl.textContent = err.message;
      }
    });
  });
  list.querySelectorAll('.relink-webhook-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const resultEl = document.querySelector(`.webhook-result[data-id="${id}"]`);
      resultEl.textContent = 'Searching for existing webhook...';
      try {
        const { hookId } = await api(`/api/projects/${id}/relink-webhook`, { method: 'POST' });
        resultEl.textContent = `Relinked ✓ (hookId: ${hookId})`;
        await loadProjects();
      } catch (err) {
        resultEl.textContent = err.data?.error || err.message;
      }
    });
  });
  list.querySelectorAll('.check-webhook-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const resultEl = document.querySelector(`.webhook-result[data-id="${id}"]`);
      resultEl.textContent = 'Checking...';
      try {
        const { hook } = await api(`/api/projects/${id}/webhook-status`);
        resultEl.innerHTML = `status: <strong>${hook.status}</strong>, event: ${hook.event}, callback: ${hook.callbackUrl}, last updated: ${hook.lastUpdatedDate}`;
      } catch (err) {
        resultEl.textContent = err.data?.error || err.message;
      }
    });
  });
}

// ─── Diagnostics: test webhook (webhook.site) ──────────────────────

async function loadTestWebhookProjectOptions() {
  const { projects } = await api('/api/projects');
  const select = document.getElementById('test-webhook-project');
  select.innerHTML = projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
}
loadTestWebhookProjectOptions();

document.getElementById('register-test-webhook-btn').addEventListener('click', async () => {
  const projectId = document.getElementById('test-webhook-project').value;
  const callbackUrl = document.getElementById('test-webhook-url').value.trim();
  const resultEl = document.getElementById('test-webhook-result');
  if (!projectId || !callbackUrl) {
    resultEl.textContent = 'Pick a project and paste a webhook.site URL first.';
    return;
  }
  resultEl.textContent = 'Registering test webhook...';
  try {
    const { hookId } = await api(`/api/projects/${projectId}/register-test-webhook`, {
      method: 'POST',
      body: JSON.stringify({ callbackUrl }),
    });
    resultEl.innerHTML = `Registered ✓ (hookId: ${hookId}). Now change a status in ACC and check webhook.site. <button type="button" id="delete-test-webhook-btn" class="btn secondary">Delete test hook</button>`;
    document.getElementById('delete-test-webhook-btn').addEventListener('click', async () => {
      resultEl.textContent = 'Deleting...';
      try {
        await api(`/api/projects/${projectId}/webhook/${hookId}`, { method: 'DELETE' });
        resultEl.textContent = 'Test hook deleted ✓';
      } catch (err) {
        resultEl.textContent = err.message;
      }
    });
  } catch (err) {
    resultEl.textContent = err.data?.error || err.message;
  }
});

document.getElementById('project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = Object.fromEntries(form.entries());
  body.makeMeOwner = form.get('makeMeOwner') === 'on';
  try {
    await api('/api/projects', { method: 'POST', body: JSON.stringify(body) });
    e.target.reset();
    await loadProjects();
  } catch (err) {
    alert(err.message);
  }
});
