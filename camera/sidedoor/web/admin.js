const byId = (id) => document.getElementById(id);
const section = byId('admin');
const status = byId('admin-status');
const settingsStatus = byId('settings-status');
const menu = byId('admin-menu');
const inviteLink = byId('invite-link');
const settings = byId('settings');
const sessions = byId('viewer-sessions');
const disconnectViewers = byId('disconnect-viewers');
const sessionStatus = byId('viewer-session-status');
const ai = byId('ai');
const schedule = byId('schedule');
const scheduleFields = byId('schedule-fields');
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
const settingLabels = {
  iso: 'ISO',
  shutterspeed: 'Shutter speed',
  'f-number': 'Aperture',
  whitebalance: 'White balance',
  focusmode: 'Focus mode',
  focusarea: 'Focus area',
  sensorcrop: 'Sensor crop',
  exposurecompensation: 'Exposure compensation',
  imagequality: 'Image quality',
};

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

export async function post(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed.');
    error.status = response.status;
    throw error;
  }
  return data;
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

async function loadSettings(current) {
  const data = await get('/settings');
  if (generation !== current) return;
  const fields = [];
  for (const [name, title] of Object.entries(settingLabels)) {
    const setting = data[name];
    if (!setting || !setting.current) continue;
    const row = document.createElement('div');
    row.className = 'setting-row';
    const editable = !setting.readonly && setting.choices?.length;
    const caption = document.createElement(editable ? 'label' : 'span');
    caption.textContent = title;
    row.append(caption);
    if (!editable) {
      const value = document.createElement('span');
      value.className = 'setting-value';
      value.textContent = setting.current;
      row.append(value);
    } else {
      const select = document.createElement('select');
      select.id = 'camera-setting-' + name;
      caption.htmlFor = select.id;
      const choices = [...new Set([setting.current, ...setting.choices])];
      select.append(...choices.map((value) => new Option(value, value, false, value === setting.current)));
      let confirmed = setting.current;
      select.onchange = () => act(async () => {
        const value = select.value;
        select.value = confirmed;
        select.disabled = true;
        try {
          const result = await post('/setting', { name, value });
          confirmed = result.current;
          select.value = confirmed;
        } finally {
          select.disabled = false;
        }
      }, settingsStatus);
      row.append(select);
    }
    fields.push(row);
  }
  settings.replaceChildren(...fields);
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
  const visible = () => current === generation && !section.hidden && activity.open &&
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

function renderAi(data) {
  byId('ai-enabled').checked = data.enabled;
  byId('ai-required').checked = data.requireAdvice;
  byId('ai-provider').replaceChildren(new Option('Choose provider', ''),
    ...data.providers.map(({ id, label }) => new Option(label ?? id, id)));
  byId('ai-provider').value = data.provider;
  byId('ai-model').value = data.model;
  byId('ai-prompt').value = data.prompt;
  const key = byId('ai-key');
  key.value = '';
  key.placeholder = data.hasKey ? 'Saved. Enter a new key to replace it.' : '';
}

export function showAdmin(enabled, idleSeconds) {
  const current = ++generation;
  section.hidden = !enabled;
  byId('open-admin-menu').hidden = !enabled;
  status.textContent = '';
  settingsStatus.textContent = '';
  sessionStatus.textContent = '';
  previewSettingsStatus.textContent = '';
  if (enabled) {
    previewIdle.value = idleSeconds;
    void act(async () => {
      const data = await get('/ai');
      if (current === generation) renderAi(data);
    });
    return act(loadSettings, settingsStatus);
  }
  menu.hidePopover();
  schedule.reset();
  scheduleFields.disabled = true;
  clearQr(byId('admin-qr'));
  clearQr(byId('invite-qr'));
  ai.reset();
  byId('issue').reset();
  inviteLink.value = '';
  inviteLink.hidden = inviteLink.labels[0].hidden = true;
  settings.replaceChildren();
  sessions.replaceChildren();
  clearTimeout(activityTimer);
  activityList.replaceChildren();
  activityStatus.textContent = '';
  viewerMap.getContext('2d').clearRect(0, 0, viewerMap.width, viewerMap.height);
  for (const details of menu.querySelectorAll('details')) details.open = false;
}

byId('preview-settings').onsubmit = (event) => {
  event.preventDefault();
  const button = event.submitter;
  void act(async (current) => {
    if (button) button.disabled = true;
    try {
      const { idleSeconds } = await post('/preview-settings', { idleSeconds: previewIdle.valueAsNumber });
      if (generation !== current) return;
      previewIdle.value = idleSeconds;
      document.dispatchEvent(new CustomEvent('preview-timeout', { detail: idleSeconds }));
      previewSettingsStatus.textContent = 'Preview timeout saved.';
    } finally {
      if (button) button.disabled = false;
    }
  }, previewSettingsStatus);
};

function showSchedule(data) {
  byId('schedule-enabled').checked = data.enabled;
  byId('schedule-times').value = data.times.join(', ');
  byId('schedule-zone').value = data.timezone;
}

schedule.closest('details').addEventListener('toggle', () => {
  if (!schedule.closest('details').open || !scheduleFields.disabled) return;
  void act(async (current) => {
    const data = await get('/schedule');
    if (generation !== current) return;
    showSchedule(data);
    scheduleFields.disabled = false;
  });
});

schedule.onsubmit = (event) => {
  event.preventDefault();
  void act(async (current) => {
    const body = {
      enabled: byId('schedule-enabled').checked,
      times: byId('schedule-times').value.split(',').map((time) => time.trim()),
      timezone: byId('schedule-zone').value.trim(),
    };
    scheduleFields.disabled = true;
    try {
      const data = await post('/schedule', body);
      if (generation !== current) return;
      showSchedule(data);
      status.textContent = 'Capture schedule saved.';
    } finally {
      if (generation === current) scheduleFields.disabled = false;
    }
  });
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
byId('check-ai').onclick = () => act(async (current) => {
  const result = await post('/ai/check');
  if (generation !== current) return;
  status.textContent = {
    valid: 'The provider verified the saved API key.',
    rejected: 'The provider rejected the saved API key.',
    missing: 'Save a provider and API key first.',
    inconclusive: 'The provider could not verify the saved API key.',
  }[result.status];
});
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
  void act(async (current) => {
    const key = byId('ai-key');
    const apiKey = key.value;
    key.value = '';
    const result = await post('/ai', {
      enabled: byId('ai-enabled').checked,
      requireAdvice: byId('ai-required').checked,
      provider: byId('ai-provider').value,
      model: byId('ai-model').value,
      prompt: byId('ai-prompt').value,
      apiKey,
    });
    if (generation !== current) return;
    renderAi(result);
    status.textContent = 'AI settings saved.';
  });
};
