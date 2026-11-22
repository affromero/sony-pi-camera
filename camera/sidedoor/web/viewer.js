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
let inviteCode = new URLSearchParams(location.hash.slice(1)).get('invite');
if (inviteCode) history.replaceState(null, '', location.pathname);

function locked() {
  generation++;
  galleryRequest++;
  clearTimeout(timer);
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

async function refreshPreview() {
  clearTimeout(timer);
  const current = ++generation;
  if (document.hidden || camera.hidden) return;
  try {
    const response = await fetch('/preview');
    if (current !== generation) return;
    if (response.status === 401) return locked();
    if (!response.ok) throw new Error();
    const blob = await response.blob();
    if (current !== generation) return;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(blob);
    preview.src = imageUrl;
    preview.hidden = false;
    previewStatus.hidden = true;
  } catch {
    if (current === generation) {
      previewStatus.textContent = preview.hidden ? 'Preview unavailable.' : 'Showing the last frame.';
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
  const { role } = await response.json();
  admin = role === 'admin';
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
