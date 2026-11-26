import { post } from './request.js';

const byId = (id) => document.getElementById(id);
const status = byId('admin-status');
const menu = byId('admin-menu');
const inviteLink = byId('invite-link');
const sessions = byId('viewer-sessions');
const disconnectViewers = byId('disconnect-viewers');
const sessionStatus = byId('viewer-session-status');
const ai = byId('ai');
const previewIdle = byId('preview-idle');
const previewSettingsStatus = byId('preview-settings-status');
const activity = byId('viewer-activity');
const activityStatus = byId('viewer-activity-status');
const activityList = byId('viewer-activity-list');
const viewerMap = byId('viewer-map');
const regionNames = new Intl.DisplayNames(undefined, { type: 'region' });
const viewerKinds = { family: 'Family', invitation: 'Invited', wifi: 'Local Wi-Fi' };
let mapPaths;
let activityTimer;
let generation = 0;
const qrCleanup = new Map();
function clearQr(container) {
  qrCleanup.get(container)?.();
  qrCleanup.delete(container);
  container.hidden = true;
}

async function showQr(container, value, current) {
  const { renderQr } = await import('/admin-qr.js');
  if (generation !== current) return;
  clearQr(container);
  qrCleanup.set(container, renderQr(container, value));
  container.hidden = false;
}

async function get(path) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function act(operation, message = status) {
  const current = generation;
  message.textContent = '';
  try {
    await operation(current);
  } catch (error) {
    if (generation === current) message.textContent = error.message;
  }
}

async function loadSessions(current) {
  const data = await get('/access/viewer-sessions');
  if (generation !== current) return;
  const rows = data.sessions.map(({ id, expiresAt, kind }) => {
    const button = document.createElement('button');
    button.title = 'Sign this viewer out on their device';
    const label = kind === 'family' ? 'Family viewer' : 'Invited viewer';
    button.textContent = label + ' · Sign out · Expires ' + new Date(expiresAt).toLocaleString();
    button.onclick = () => act(async (active) => {
      await post('/access/revoke-session', { id });
      await loadSessions(active);
    }, sessionStatus);
    return button;
  });
  sessions.replaceChildren(...(rows.length ? rows : ['No signed-in viewers.']));
}

function renderActivity(viewers) {
  const counts = new Map();
  const rows = viewers.map(({ kind, ip, country, since }) => {
    if (country) counts.set(country, (counts.get(country) ?? 0) + 1);
    const row = document.createElement('li');
    const detail = [viewerKinds[kind], ip ?? 'IP unavailable'];
    if (country) detail.push(regionNames.of(country));
    detail.push('Since ' + new Date(since).toLocaleTimeString());
    row.textContent = detail.join(' · ');
    return row;
  });
  activityList.replaceChildren(...rows);
  activityStatus.textContent = viewers.length === 0 ? 'Nobody is watching live.'
    : viewers.length === 1 ? '1 live preview' : viewers.length + ' live previews';
  const context = viewerMap.getContext('2d');
  context.clearRect(0, 0, viewerMap.width, viewerMap.height);
  for (const [country, path] of mapPaths) {
    const count = counts.get(country) ?? 0;
    context.fillStyle = ['#adb9c8', '#548dea', '#2365cb', '#194594'][Math.min(count, 3)];
    context.fill(path, 'evenodd');
  }
}

async function updateActivity() {
  clearTimeout(activityTimer);
  const current = generation;
  const visible = () => current === generation && activity.open &&
    menu.matches(':popover-open') && !document.hidden;
  if (!visible()) return;
  try {
    const { viewers } = await get('/live-viewers');
    if (!mapPaths) mapPaths = (await get('/world-map.json')).map(([code, path]) => [code, new Path2D(path)]);
    if (visible()) renderActivity(viewers);
  } catch (error) {
    if (visible()) {
      activityList.replaceChildren();
      activityStatus.textContent = error.message;
    }
  } finally {
    if (visible()) {
      clearTimeout(activityTimer);
      activityTimer = setTimeout(updateActivity, 3000);
    }
  }
}

activity.addEventListener('toggle', updateActivity);
menu.addEventListener('toggle', updateActivity);
document.addEventListener('visibilitychange', updateActivity);

const aiProvider = byId('ai-provider');
const aiModel = byId('ai-model');
const aiCustom = byId('ai-custom-model');
const aiKey = byId('ai-key');
const aiStatus = byId('ai-status');
const saveAi = byId('save-ai');
const checkAi = byId('check-ai');
let savedAi;
let testedAi;
let aiBusy = false;

function aiDraft() {
  return {
    enabled: byId('ai-enabled').checked,
    requireAdvice: byId('ai-required').checked,
    provider: aiProvider.value,
    model: aiModel.value === 'custom' ? aiCustom.value.trim() : aiModel.value,
    prompt: byId('ai-prompt').value,
    apiKey: aiKey.value,
  };
}

function aiFingerprint({ provider, model, apiKey }) {
  return JSON.stringify([provider, model, apiKey.trim()]);
}

function refreshAiActions() {
  const draft = aiDraft();
  const disabled = savedAi && !draft.enabled && !draft.apiKey && draft.provider === savedAi.provider &&
    draft.model === savedAi.model;
  checkAi.disabled = aiBusy || !draft.provider || !draft.model;
  saveAi.disabled = aiBusy || (!disabled && testedAi !== aiFingerprint(draft));
}

function renderAiModels(selected = '') {
  const provider = savedAi.providers.find(({ id }) => id === aiProvider.value);
  const models = provider?.models ?? [];
  aiModel.replaceChildren(new Option('Choose model', ''),
    ...models.map(({ id, label }) => new Option(label, id)));
  if (provider) aiModel.add(new Option('Enter model ID', 'custom'));
  aiModel.value = models.some(({ id }) => id === selected) ? selected : selected ? 'custom' : '';
  aiCustom.value = aiModel.value === 'custom' ? selected : '';
  aiKey.value = '';
  aiKey.hidden = byId('ai-key-label').hidden = provider?.transport !== 'api';
  aiKey.placeholder = provider?.hasKey ? 'Saved. Enter a new key to replace it.' : '';
  byId('ai-cli-help').hidden = provider?.transport !== 'cli';
  updateAiModelField();
}

function updateAiModelField() {
  aiCustom.hidden = byId('ai-custom-model-label').hidden = aiModel.value !== 'custom';
  refreshAiActions();
}

function renderAi(data) {
  savedAi = data;
  testedAi = undefined;
  byId('ai-enabled').checked = data.enabled;
  byId('ai-required').checked = data.requireAdvice;
  aiProvider.replaceChildren(new Option('Choose provider', ''),
    ...data.providers.map(({ id, label }) => new Option(label, id)));
  aiProvider.value = data.provider;
  byId('ai-prompt').value = data.prompt;
  renderAiModels(data.model);
}

aiProvider.onchange = () => renderAiModels();
aiModel.onchange = updateAiModelField;
ai.oninput = () => {
  aiStatus.textContent = '';
  refreshAiActions();
};

byId('preview-settings').onsubmit = (event) => {
  event.preventDefault();
  const button = event.submitter;
  void act(async (current) => {
    if (button) button.disabled = true;
    try {
      const { idleSeconds } = await post('/preview-settings', { idleSeconds: previewIdle.valueAsNumber });
      if (generation !== current) return;
      previewIdle.value = idleSeconds;
      previewSettingsStatus.textContent = 'Preview timeout saved.';
    } finally {
      if (button) button.disabled = false;
    }
  }, previewSettingsStatus);
};

byId('show-admin-qr').onclick = () => act((current) =>
  showQr(byId('admin-qr'), location.origin + '/', current));
sessions.closest('details').addEventListener('toggle', () => {
  if (sessions.closest('details').open) void act(loadSessions, sessionStatus);
});
disconnectViewers.onclick = () => act(async (current) => {
  if (!confirm('Sign out all current viewers? Family members can sign in again with their password.')) return;
  disconnectViewers.disabled = true;
  try {
    const { disconnected } = await post('/access/disconnect-viewers');
    if (generation !== current) return;
    await loadSessions(current);
    if (generation === current) sessionStatus.textContent = disconnected === 1
      ? 'Disconnected 1 viewer.' : disconnected
        ? `Disconnected ${disconnected} viewers.` : 'No viewers were signed in.';
  } finally {
    disconnectViewers.disabled = false;
  }
}, sessionStatus);
checkAi.onclick = () => act(async (current) => {
  const draft = aiDraft();
  const fingerprint = aiFingerprint(draft);
  aiBusy = true;
  testedAi = undefined;
  refreshAiActions();
  try {
    aiStatus.textContent = 'Testing the selected model…';
    const result = await post('/ai/check', draft);
    if (generation !== current || fingerprint !== aiFingerprint(aiDraft())) return;
    if (result.status === 'valid') testedAi = fingerprint;
    aiStatus.textContent = {
      valid: 'Model test passed. You can now save.',
      missing: 'Choose a model and enter an API key if required.',
      busy: 'A model test is already running.',
      not_installed: 'This CLI is not installed on the Pi.',
      failed: 'Model test failed. Check the model and API key or CLI login.',
    }[result.status];
  } finally {
    aiBusy = false;
    refreshAiActions();
  }
}, aiStatus);
byId('issue').onsubmit = (event) => {
  event.preventDefault();
  void act(async (current) => {
    const field = byId('confirm-password');
    const password = field.value;
    field.value = '';
    await post('/access/reauthenticate', { password });
    const { code, origin } = await post('/access/issue-invitation');
    if (generation !== current) return;
    inviteLink.value = origin + '/#invite=' + encodeURIComponent(code);
    inviteLink.hidden = inviteLink.labels[0].hidden = false;
    inviteLink.focus();
    inviteLink.select();
    await showQr(byId('invite-qr'), inviteLink.value, current);
  });
};
ai.onsubmit = (event) => {
  event.preventDefault();
  if (saveAi.disabled) return;
  void act(async (current) => {
    aiBusy = true;
    refreshAiActions();
    try {
      const result = await post('/ai', aiDraft());
      if (generation !== current) return;
      renderAi(result);
      aiStatus.textContent = 'AI settings saved.';
    } finally {
      aiBusy = false;
      refreshAiActions();
    }
  }, aiStatus);
};

menu.addEventListener('toggle', () => {
  if (menu.matches(':popover-open')) {
    void act(async (current) => {
      const [session, data] = await Promise.all([get('/session'), get('/ai')]);
      if (generation !== current) return;
      previewIdle.value = session.idleSeconds;
      renderAi(data);
    });
    return;
  }
  generation++;
  clearQr(byId('admin-qr'));
  clearQr(byId('invite-qr'));
  byId('confirm-password').value = '';
  aiKey.value = '';
  testedAi = undefined;
  aiStatus.textContent = '';
  refreshAiActions();
});
