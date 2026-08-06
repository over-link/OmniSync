/**
 * services/accService.js
 * ACC Construction Issues API calls. Same endpoints as the old
 * accService.js, but every function now takes (userId, project) so the
 * right person's token and the right project's IDs are used — this is
 * what makes multi-user and multi-project work.
 */
const axios = require('axios');
const { getValidAccToken } = require('./authManager');
const { APS_BASE } = require('./accAuth');

function _containerId(project) {
  return project.acc_project_id.startsWith('b.') ? project.acc_project_id.slice(2) : project.acc_project_id;
}

async function _client(userId, project) {
  const token = await getValidAccToken(userId);
  return {
    token,
    baseURL: `${APS_BASE}/construction/issues/v1/projects/${_containerId(project)}`,
  };
}

async function getIssues(userId, project, filters = {}) {
  const { token, baseURL } = await _client(userId, project);
  const issues = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const { data } = await axios.get(`${baseURL}/issues`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit, offset, ...filters },
    });
    issues.push(...(data.results || []));
    if (issues.length >= (data.pagination?.totalResults || 0)) break;
    offset += limit;
  }
  return issues;
}

async function getIssue(userId, project, issueId) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.get(`${baseURL}/issues/${issueId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

async function createIssue(userId, project, issueBody) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.post(`${baseURL}/issues`, issueBody, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return data;
}

async function updateIssue(userId, project, issueId, fields) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.patch(`${baseURL}/issues/${issueId}`, fields, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return data;
}

async function addComment(userId, project, issueId, comment) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.post(
    `${baseURL}/issues/${issueId}/comments`,
    { body: comment },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data;
}

/**
 * GET .../issues/{issueId}/comments — confirmed to exist as a real
 * endpoint (distinct from the base issue GET, which does NOT include
 * comments inline) via an official third-party SDK usage example. The
 * exact response field names are NOT independently confirmed for GET —
 * extrapolated from the POST shape ({body: comment} -> assume `.body`
 * holds text on read too). Returns oldest-first; unconfirmed, sorted
 * defensively by createdAt if present.
 */
async function getIssueComments(userId, project, issueId) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.get(`${baseURL}/issues/${issueId}/comments`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const comments = data?.results || data?.data || [];
  return comments.slice().sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

/**
 * GET .../construction/issues/v1/projects/{projectId}/attachments/{issueId}/items
 * — an issue's attachments. NOT confirmed the way comments/subtypes were:
 * a real test showed the base issue GET does NOT include attachments
 * inline (empty array every time), same as comments — this dedicated
 * endpoint is a best guess (path pattern "attachments/{issueId}/items",
 * from the official tutorial) applying the SAME base-path correction
 * already proven necessary for the POST attach endpoint in this file
 * (`construction/issues/v1`, not the tutorial's bare `issues/v1` — see
 * _attachToIssue). Logs the full error response if this 404s so the real
 * path can be confirmed from Autodesk's own error message rather than
 * guessed again blind.
 */
async function getIssueAttachments(userId, project, issueId) {
  const { token, baseURL } = await _client(userId, project);
  try {
    const { data } = await axios.get(`${baseURL}/attachments/${issueId}/items`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return data?.results || data?.data || [];
  } catch (err) {
    console.warn(`[acc] getIssueAttachments failed (status ${err.response?.status}):`, JSON.stringify(err.response?.data) || err.message);
    throw err;
  }
}

async function getIssueSubtypes(userId, project) {
  const { token, baseURL } = await _client(userId, project);
  const { data } = await axios.get(`${baseURL}/issue-types`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { include: 'subtypes' },
  });
  return (data.results || []).flatMap((t) =>
    (t.subtypes || []).map((s) => ({ id: s.id, title: s.title, issueTypeId: t.id, issueTypeTitle: t.title }))
  );
}

/**
 * GET .../construction/issues/v1/projects/{projectId}/issue-attribute-definitions
 * — the project's admin-created custom issue fields (ACC has no native
 * grid/room fields, so those map to custom fields here instead). Same
 * container-ID convention and results/pagination response shape as every
 * other Issues API call in this file — confirmed path from Autodesk's own
 * API reference text (unlike the Locations endpoint's containers/projects
 * mixup, this one follows the established Issues API pattern exactly).
 */
async function getIssueAttributeDefinitions(userId, project) {
  const { token, baseURL } = await _client(userId, project);
  const definitions = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const { data } = await axios.get(`${baseURL}/issue-attribute-definitions`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit, offset },
    });
    const results = data.results || [];
    definitions.push(...results);
    if (!results.length || definitions.length >= (data.pagination?.totalResults || 0)) break;
    offset += limit;
  }
  return definitions;
}

/**
 * GET .../construction/issues/v1/projects/{projectId}/issue-attribute-mappings
 * — which issue type/subtype (or the whole project) each custom field
 * actually applies to. A field existing in issue-attribute-definitions
 * does NOT mean it's usable on every issue — ACC rejects a customAttributes
 * value with "custom attribute definition is deleted or unmapped" if the
 * field isn't mapped to that specific issue's subtype (confirmed by real
 * testing). Each mapping has attributeDefinitionId, mappedItemType
 * ('container' | 'issueType' | 'issueSubtype'), and mappedItemId.
 */
async function getIssueAttributeMappings(userId, project) {
  const { token, baseURL } = await _client(userId, project);
  const mappings = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const { data } = await axios.get(`${baseURL}/issue-attribute-mappings`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit, offset },
    });
    const results = data.results || [];
    mappings.push(...results);
    if (!results.length || mappings.length >= (data.pagination?.totalResults || 0)) break;
    offset += limit;
  }
  return mappings;
}

// ─── Project members / assignee mapping ────────────────────────────

async function getProjectMembers(userId, project) {
  const token = await getValidAccToken(userId);
  const projectId = _containerId(project);
  const members = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const { data } = await axios.get(`${APS_BASE}/construction/admin/v1/projects/${projectId}/users`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit, offset },
    });
    const results = data.results || [];
    members.push(...results);
    if (members.length >= (data.pagination?.totalResults || 0)) break;
    offset += limit;
  }
  return members;
}

// ─── Locations (Location Breakdown Structure) ───────────────────────

/**
 * GET .../construction/locations/v2/projects/{projectId}/trees/{treeId}/nodes
 * — every node in the project's Location Breakdown Structure (the tree
 * behind ACC's "Location" field on an issue, distinct from the free-text
 * "Location Details" field). `treeId` is always "default" — a project can
 * only have one tree. Confirmed path, params, and response shape
 * (pagination/results/id/name/parentId) directly from Autodesk's own
 * Locations API reference — but that reference's own example response
 * shows the stripped (no "b." prefix) ID in a returned nextUrl, and
 * passing the full acc_project_id here got a real "container is
 * unprocessable" error back — confirms it wants the same stripped
 * container ID as the Construction Issues API, despite docs text
 * suggesting a Data-Management-style ID. Returns [] (not an error) if the
 * project has no Locations tree configured — a 404 here just means
 * "nothing to match against," not a real failure.
 */
async function getLocationNodes(userId, project) {
  const token = await getValidAccToken(userId);
  const containerId = _containerId(project);
  const nodes = [];
  let offset = 0;
  const limit = 100;
  try {
    while (true) {
      const { data } = await axios.get(
        `${APS_BASE}/construction/locations/v2/projects/${containerId}/trees/default/nodes`,
        { headers: { Authorization: `Bearer ${token}` }, params: { limit, offset } }
      );
      const results = data.results || [];
      nodes.push(...results);
      if (!results.length || nodes.length >= (data.pagination?.totalResults || 0)) break;
      offset += limit;
    }
  } catch (err) {
    if (err.response?.status === 404) return [];
    throw err;
  }
  return nodes;
}

// ─── Webhooks ───────────────────────────────────────────────────────

async function registerWebhook(userId, project, callbackUrl) {
  const token = await getValidAccToken(userId);
  const projectId = _containerId(project);
  const { data } = await axios.post(
    `${APS_BASE}/webhooks/v1/systems/autodesk.construction.issues/events/issue.updated-1.0/hooks`,
    { callbackUrl, scope: { project: projectId } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-region': 'US' } }
  );
  return data;
}

/**
 * Same as registerWebhook but for an arbitrary callback URL (e.g. a
 * webhook.site test URL) — used purely to diagnose whether ACC's webhook
 * delivery reaches ANY server at all, isolating our app/hosting from
 * ACC's own delivery mechanism. Doesn't touch the projects table.
 */
async function registerTestWebhook(userId, project, callbackUrl) {
  return registerWebhook(userId, project, callbackUrl);
}

async function deleteWebhook(userId, hookId) {
  const token = await getValidAccToken(userId);
  await axios.delete(
    `${APS_BASE}/webhooks/v1/systems/autodesk.construction.issues/events/issue.updated-1.0/hooks/${hookId}`,
    { headers: { Authorization: `Bearer ${token}`, 'x-ads-region': 'US' } }
  );
}

/**
 * Fetches the real, current status of a registered webhook straight from
 * ACC — for diagnosing "it fired once, then stopped" without guessing.
 * Returns whatever Autodesk's own API says (status, dates, etc.).
 */
async function getWebhookStatus(userId, hookId) {
  const token = await getValidAccToken(userId);
  const { data } = await axios.get(
    `${APS_BASE}/webhooks/v1/systems/autodesk.construction.issues/events/issue.updated-1.0/hooks/${hookId}`,
    { headers: { Authorization: `Bearer ${token}`, 'x-ads-region': 'US' } }
  );
  return data;
}

/**
 * Lists all currently registered hooks for this event (across all
 * projects the token can see), for finding an existing hook whose ID
 * never got saved locally — e.g. if the create-response's ID field name
 * assumption was wrong. Returns the raw list; caller filters by scope.
 */
async function listWebhooks(userId) {
  const token = await getValidAccToken(userId);
  const { data } = await axios.get(
    `${APS_BASE}/webhooks/v1/systems/autodesk.construction.issues/events/issue.updated-1.0/hooks`,
    { headers: { Authorization: `Bearer ${token}`, 'x-ads-region': 'US' } }
  );
  return data?.data || data?.hooks || data || [];
}

// ─── Hubs / Projects (Data Management API — for the "browse ACC" dropdowns) ─

async function getHubs(userId) {
  const token = await getValidAccToken(userId);
  const { data } = await axios.get(`${APS_BASE}/project/v1/hubs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (data.data || []).map((h) => ({ id: h.id, name: h.attributes?.name }));
}

async function getHubProjects(userId, hubId) {
  const token = await getValidAccToken(userId);
  const { data } = await axios.get(`${APS_BASE}/project/v1/hubs/${hubId}/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (data.data || []).map((p) => ({ id: p.id, name: p.attributes?.name }));
}

// ─── Issue attachments (image upload pipeline) ───────────────────────
// Confirmed from Autodesk's own official tutorial (get-started.aps.
// autodesk.com/tutorials/acc-issues/more) — a 4-step flow spanning the
// Data Management API (folders/storage/upload) and a DIFFERENT base path
// for the Issues API specifically for attachments (`issues/v1`, NOT
// `construction/issues/v1` like every other Issues endpoint we use).
// This mismatch is the likely cause of a 409 error a developer hit
// publicly when they guessed the wrong (construction/issues/v1) prefix.

/**
 * Step 1: get the project's root folder (Data Management API), needed
 * as the parent for creating a new storage location.
 */
async function _getProjectRootFolderId(userId, project) {
  const token = await getValidAccToken(userId);
  const { data } = await axios.get(
    `${APS_BASE}/project/v1/hubs/${project.acc_hub_id}/projects/${project.acc_project_id}/topFolders`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const folders = data?.data || [];
  return folders[0]?.id || null;
}

/**
 * Step 2: create a storage location for the file (Data Management API).
 * Returns { bucketKey, objectKey, storageUrn }, parsed from the
 * response's URN (format: urn:adsk.objects:os.object:{bucketKey}/{objectKey}).
 */
async function _createStorage(userId, project, folderId, fileName) {
  const token = await getValidAccToken(userId);
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'objects',
      attributes: { name: fileName },
      relationships: { target: { data: { type: 'folders', id: folderId } } },
    },
  };
  const { data } = await axios.post(`${APS_BASE}/data/v1/projects/${project.acc_project_id}/storage`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.api+json' },
  });
  const storageUrn = data?.data?.id; // urn:adsk.objects:os.object:{bucketKey}/{objectKey}
  const match = storageUrn?.match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Unexpected storage URN format: ${storageUrn}`);
  return { bucketKey: match[1], objectKey: match[2], storageUrn };
}

/**
 * Step 3: upload the actual file bytes via a signed S3 URL, then
 * finalize. Autodesk's signed-upload flow is single-part for smaller
 * files (which image previews are) — GET a signed URL, PUT the bytes,
 * POST to complete.
 */
async function _uploadFileBytes(userId, bucketKey, objectKey, fileBuffer) {
  const token = await getValidAccToken(userId);
  const { data: signed } = await axios.get(
    `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${objectKey}/signeds3upload`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const uploadUrl = signed?.urls?.[0];
  if (!uploadUrl) throw new Error('No signed upload URL returned');

  await axios.put(uploadUrl, fileBuffer, { headers: { 'Content-Type': 'application/octet-stream' } });

  await axios.post(
    `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${objectKey}/signeds3upload`,
    { uploadKey: signed.uploadKey },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

/**
 * Step 4: attach the uploaded file to an issue. NOTE the base path:
 * `issues/v1`, not `construction/issues/v1` like every other Issues API
 * call in this file — confirmed from the official tutorial.
 */
async function _attachToIssue(userId, project, issueId, displayName, objectKey, storageUrn) {
  const token = await getValidAccToken(userId);
  const attachmentId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
  const body = {
    domainEntityId: issueId,
    attachments: [
      {
        attachmentId,
        displayName,
        fileName: objectKey,
        attachmentType: 'issue-attachment',
        storageUrn,
      },
    ],
  };
  const url = `${APS_BASE}/construction/issues/v1/projects/${_containerId(project)}/attachments`;
  const { data } = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-region': 'US' },
  });
  return data;
}

/**
 * Full pipeline: downloads an image from a URL (e.g. Revizto's preview
 * image) and attaches it to an ACC issue. Orchestrates all 4 steps above.
 */
async function attachImageToIssue(userId, project, issueId, imageUrl, displayName) {
  const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  const fileBuffer = Buffer.from(imageResponse.data);
  const fileType = (imageResponse.headers['content-type'] || 'image/jpeg').split('/').pop();
  const fileName = displayName.includes('.') ? displayName : `${displayName}.${fileType}`;

  let folderId;
  try {
    folderId = await _getProjectRootFolderId(userId, project);
  } catch (err) {
    throw new Error(`[step 1: get root folder] ${err.response?.data?.developerMessage || err.message}`);
  }
  if (!folderId) throw new Error('[step 1: get root folder] No folders returned for this project');

  let storageResult;
  try {
    storageResult = await _createStorage(userId, project, folderId, fileName);
  } catch (err) {
    throw new Error(`[step 2: create storage] ${err.response?.data?.developerMessage || err.message}`);
  }
  const { bucketKey, objectKey, storageUrn } = storageResult;

  try {
    await _uploadFileBytes(userId, bucketKey, objectKey, fileBuffer);
  } catch (err) {
    throw new Error(`[step 3: upload bytes] ${err.response?.data?.developerMessage || err.message}`);
  }

  try {
    return await _attachToIssue(userId, project, issueId, fileName, objectKey, storageUrn);
  } catch (err) {
    throw new Error(`[step 4: attach to issue] ${JSON.stringify(err.response?.data) || err.message}`);
  }
}

/**
 * Downloads an ACC attachment's actual file bytes, for the ACC->Revizto
 * attachment sync direction — the reverse of attachImageToIssue's upload
 * pipeline. `storageUrn` (format: urn:adsk.objects:os.object:{bucketKey}/
 * {objectKey}) comes from an attachment entry on the issue (confirmed
 * shape from Autodesk's own docs — same URN format this file already
 * parses on the upload side in _createStorage). Downloading uses the
 * symmetric counterpart of the upload flow's signed URL step
 * (signeds3download vs signeds3upload), a standard, well-documented OSS
 * API pair — NOT independently confirmed by real testing yet the way the
 * upload side was, so treat the exact response shape as a first guess if
 * this doesn't work on first try.
 */
async function downloadAttachmentFile(userId, storageUrn) {
  const token = await getValidAccToken(userId);
  const match = storageUrn?.match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Unexpected storage URN format: ${storageUrn}`);
  const [, bucketKey, objectKey] = match;

  const { data: signed } = await axios.get(
    `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${objectKey}/signeds3download`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  // TEMP DEBUG: this response shape is a guess (symmetric with the
  // upload side's signeds3upload), not confirmed by real testing yet.
  console.log('[acc] Raw signeds3download response:', JSON.stringify(signed));
  const downloadUrl = signed?.url || signed?.urls?.[0];
  if (!downloadUrl) throw new Error(`No signed download URL returned: ${JSON.stringify(signed)}`);

  const { data: fileData, headers } = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(fileData), contentType: headers['content-type'] || 'application/octet-stream' };
}

module.exports = {
  getIssues,
  getIssue,
  createIssue,
  updateIssue,
  addComment,
  getIssueComments,
  getIssueAttachments,
  getIssueSubtypes,
  getProjectMembers,
  getLocationNodes,
  downloadAttachmentFile,
  getIssueAttributeDefinitions,
  getIssueAttributeMappings,
  registerWebhook,
  getWebhookStatus,
  listWebhooks,
  registerTestWebhook,
  deleteWebhook,
  getHubs,
  getHubProjects,
  attachImageToIssue,
};
