import { post, showAdmin } from './admin.js';

const byId = (id) => document.getElementById(id);
const unlock = byId('unlock');
const invite = byId('invite');
const lock = byId('lock');
const camera = byId('camera');
const status = byId('status');
const photos = byId('photos');
const preview = byId('preview');
const previewStatus = byId('preview-status');
let generation = 0;
let galleryRequest = 0;
let timer;
let imageUrl;
let admin = false;
let privateStream = false;
let streamRequest;
let inviteCode = new URLSearchParams(location.hash.slice(1)).get('invite');
if (inviteCode) history.replaceState(null, '', location.pathname);

function locked() {
  generation++;
  galleryRequest++;
  clearTimeout(timer);
  streamRequest?.abort();
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = undefined;
  preview.removeAttribute('src');
  preview.hidden = true;
  previewStatus.hidden = false;
  previewStatus.textContent = 'Waiting for the camera…';
  photos.replaceChildren();
  camera.hidden = lock.hidden = true;
  invite.hidden = !inviteCode;
  unlock.hidden = Boolean(inviteCode) || document.body.hasAttribute('data-guest');
  if (unlock.hidden && !inviteCode && document.body.hasAttribute('data-guest'))
    status.textContent = 'Open the invitation link from the camera owner.';
  admin = false;
  privateStream = false;
  showAdmin(false);
}

function renderPhotos(entries) {
  const rows = entries.map(({ name, bytes }) => {
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.href = '/download/' + encodeURIComponent(name);
    link.textContent = name;
    link.download = '';
    const size = document.createElement('span');
    size.textContent = bytes < 1_000_000 ? `${Math.ceil(bytes / 1000)} KB` :
      `${(bytes / 1_000_000).toFixed(1)} MB`;
    const actions = document.createElement('div');
    actions.className = 'photo-actions';
    actions.append(size);
    if (admin) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', 'Delete ' + name);
      remove.onclick = async () => {
        if (!confirm('Delete ' + name + ' from the Pi?')) return;
        try {
          await post('/delete', { name });
          await loadPhotos();
        } catch (error) {
          if (error.status === 401) locked();
          status.textContent = error.message;
        }
      };
      actions.append(remove);
    }
    row.append(link, actions);
    return row;
  });
  photos.replaceChildren(...rows);
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No photos yet.';
    photos.append(empty);
  }
}

function showFrame(blob) {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = URL.createObjectURL(blob);
  preview.src = imageUrl;
  preview.hidden = false;
  previewStatus.hidden = true;
}

async function* streamFrames(body) {
  const reader = body.getReader();
  let unread = new Uint8Array();
  const decoder = new TextDecoder();
  async function fill() {
    while (unread.length === 0) {
      const part = await reader.read();
      if (part.done) throw new Error('Preview stream ended');
      unread = part.value;
    }
  }
  try {
    for (;;) {
      const header = [];
      let delimiter = 0;
      while (delimiter !== 0x0d0a0d0a && header.length < 128) {
        await fill();
        const byte = unread[0];
        unread = unread.subarray(1);
        header.push(byte);
        delimiter = (delimiter << 8) | byte;
      }
      const text = decoder.decode(Uint8Array.from(header));
      const match = /^--sony-preview\r\nContent-Type: image\/jpeg\r\nContent-Length: (\d+)\r\n\r\n$/.exec(text);
      const size = Number(match?.[1]);
      if (!Number.isInteger(size) || size < 4 || size > 2 * 1024 * 1024)
        throw new Error('Invalid preview frame');
      const bytes = new Uint8Array(size + 2);
      for (let offset = 0; offset < bytes.length;) {
        await fill();
        const count = Math.min(bytes.length - offset, unread.length);
        bytes.set(unread.subarray(0, count), offset);
        unread = unread.subarray(count);
        offset += count;
      }
      if (bytes[size] !== 13 || bytes[size + 1] !== 10) throw new Error('Invalid preview delimiter');
      yield new Blob([bytes.subarray(0, size)], { type: 'image/jpeg' });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function refreshPreview() {
  clearTimeout(timer);
  streamRequest?.abort();
  const current = ++generation;
  if (document.hidden || camera.hidden) return;
  try {
    if (privateStream) {
      streamRequest = new AbortController();
      const response = await fetch('/stream', { signal: streamRequest.signal });
      if (current !== generation) return;
      if (response.status === 401) return locked();
      if (!response.ok || !response.body) throw new Error();
      for await (const frame of streamFrames(response.body)) {
        if (current !== generation) return;
        showFrame(frame);
      }
      return;
    }
    const response = await fetch('/preview');
    if (current !== generation) return;
    if (response.status === 401) return locked();
    if (!response.ok) throw new Error();
    const blob = await response.blob();
    if (current !== generation) return;
    showFrame(blob);
  } catch {
    if (current === generation) {
      previewStatus.textContent = privateStream ? 'Live stream interrupted. Reconnecting…' :
        preview.hidden ? 'Preview unavailable.' : 'Showing the last frame.';
      previewStatus.hidden = false;
    }
  } finally {
    if (current === generation) timer = setTimeout(refreshPreview, 2500);
  }
}

async function refreshPhotos() {
  const current = ++galleryRequest;
  const response = await fetch('/photos');
  if (current !== galleryRequest) return;
  if (response.status === 401) return locked();
  if (!response.ok) throw new Error();
  const entries = await response.json();
  if (current === galleryRequest) renderPhotos(entries);
}

async function loadPhotos() {
  status.textContent = '';
  try {
    await refreshPhotos();
  } catch {
    status.textContent = 'Photos are temporarily unavailable. Try refreshing.';
  }
}

unlock.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = byId('password');
  const button = unlock.querySelector('button');
  button.disabled = true;
  try {
    await post('/access/login', { password: password.value });
    unlock.reset();
    await enter();
  } catch (error) {
    status.textContent = error.status === 401 ? 'Check the admin password.' :
      error.status === 429 ? 'Too many attempts. Try again later.' : 'Could not open the viewer.';
  } finally {
    button.disabled = false;
  }
});

invite.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = invite.querySelector('button');
  button.disabled = true;
  try {
    await post('/access/redeem-invitation', { code: inviteCode });
    inviteCode = null;
    await enter();
  } catch (error) {
    status.textContent = error.status === 401 ? 'This invitation has expired or already been used.' :
      'Could not accept the invitation. Try again.';
  } finally {
    button.disabled = false;
  }
});

lock.addEventListener('click', async () => {
  try {
    await post('/access/logout');
    status.textContent = '';
    locked();
  } catch {
    status.textContent = 'Could not lock the viewer. Try again.';
  }
});
byId('refresh').addEventListener('click', loadPhotos);
document.addEventListener('visibilitychange', refreshPreview);

async function enter() {
  const response = await fetch('/session');
  if (!response.ok) return locked();
  const { role, privateStream: streaming } = await response.json();
  admin = role === 'admin';
  privateStream = admin && streaming;
  camera.hidden = lock.hidden = false;
  unlock.hidden = invite.hidden = true;
  showAdmin(admin);
  void refreshPreview();
  await loadPhotos();
}
void enter().catch(() => {
  locked();
  status.textContent = 'The camera viewer is temporarily unavailable.';
});
