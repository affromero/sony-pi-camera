const byId = (id) => document.getElementById(id);
const section = byId('admin');
const status = byId('admin-status');
const inviteLink = byId('invite-link');
const settings = byId('settings');
const sessions = byId('viewer-sessions');
const ai = byId('ai');
const schedule = byId('schedule');
const scheduleFields = byId('schedule-fields');
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

async function act(operation) {
  const current = generation;
  status.textContent = '';
  try {
    await operation(current);
  } catch (error) {
    if (generation === current) status.textContent = error.message;
  }
}

async function loadSettings(current) {
  const data = await get('/settings');
  if (generation !== current) return;
  const fields = [];
  for (const [name, setting] of Object.entries(data)) {
    if (typeof setting !== 'object' || !setting.current) continue;
    const label = document.createElement('label');
    label.textContent = name === 'f-number' ? 'Aperture' : name;
    if (setting.readonly || !setting.choices?.length) {
      const value = document.createElement('span');
      value.textContent = setting.current;
      label.append(value);
    } else {
      const select = document.createElement('select');
      const choices = [...new Set([setting.current, ...setting.choices])];
      select.append(...choices.map((value) => new Option(value, value, false, value === setting.current)));
      select.onchange = () => act(async (active) => {
        try {
          await post('/setting', { name, value: select.value });
        } finally {
          await loadSettings(active);
        }
      });
      label.append(select);
    }
    fields.push(label);
  }
  settings.replaceChildren(...fields);
}

async function loadSessions(current) {
  const data = await get('/access/sessions');
  if (generation !== current) return;
  const rows = data.sessions.filter(({ principalId, admission }) =>
    principalId === null && admission === 'invitation').map(({ id, expiresAt }) => {
    const button = document.createElement('button');
    button.textContent = 'Revoke viewer expiring ' + new Date(expiresAt).toLocaleString();
    button.onclick = () => act(async (active) => {
      await post('/access/revoke-session', { id });
      await loadSessions(active);
    });
    return button;
  });
  sessions.replaceChildren(...(rows.length ? rows : ['No active viewers.']));
}

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

export function showAdmin(enabled) {
  const current = ++generation;
  section.hidden = !enabled;
  status.textContent = '';
  if (enabled) {
    void act(async () => {
      const data = await get('/ai');
      if (current === generation) renderAi(data);
    });
  } else {
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
    for (const details of section.querySelectorAll('details')) details.open = false;
  }
}

byId('refresh-settings').onclick = () => act(loadSettings);
function showSchedule(data) {
  byId('schedule-enabled').checked = data.enabled;
  byId('schedule-times').value = data.times.join(', ');
  byId('schedule-zone').value = data.timezone;
}

byId('refresh-schedule').onclick = () => act(async (current) => {
  const data = await get('/schedule');
  if (generation !== current) return;
  showSchedule(data);
  scheduleFields.disabled = false;
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
byId('refresh-sessions').onclick = () => act(loadSessions);
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
