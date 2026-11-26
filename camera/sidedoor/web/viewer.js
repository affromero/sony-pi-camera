import { post, showAdmin } from './admin.js';

const byId = (id) => document.getElementById(id);
const unlock = byId('unlock');
const invite = byId('invite');
const lock = byId('lock');
const camera = byId('camera');
const adminMenu = byId('admin-menu');
const status = byId('status');
const photos = byId('photos');
const preview = byId('preview');
const previewStatus = byId('preview-status');
const previewSleep = byId('preview-sleep');
const captureButton = byId('capture-photo');
const captureStatus = byId('capture-status');
const photoDialog = byId('photo-dialog');
const photoFull = byId('photo-full');
const photoStatus = byId('photo-status');
const photoLoading = byId('photo-loading');
const photoProgress = byId('photo-progress');
const familyLogin = document.body.hasAttribute('data-family');
const guestPage = document.body.hasAttribute('data-guest');
const lanPage = document.body.hasAttribute('data-lan');
const adminButton = byId('login-admin');
const familyButton = byId('login-family');
const passkeyButton = byId('login-passkey');
const passkeyOffer = byId('passkey-offer');
const canUsePasskeys = Boolean(window.PublicKeyCredential && navigator.credentials);
adminButton.hidden = guestPage;
familyButton.hidden = !familyLogin;
passkeyButton.hidden = !canUsePasskeys || (guestPage && !familyLogin);
if (familyLogin) byId('password-label').textContent = 'Camera password';
let generation = 0;
let previewGeneration = 0;
let galleryRequest = 0;
let gallerySnapshot = '';
let photoRequest;
let photoUrl;
let timer;
let idleTimer;
let idleSeconds = 15;
let lastActivity = 0;
let sleeping = false;
let manualSleep = false;
let imageUrl;
let admin = false;
let streamRequest;
let inviteCode = lanPage ? null : new URLSearchParams(location.hash.slice(1)).get('invite');
if (inviteCode) history.replaceState(null, '', location.pathname);

function stopPreview() {
  previewGeneration++;
  clearTimeout(timer);
  streamRequest?.abort();
}

function clearFrame() {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = undefined;
  preview.removeAttribute('src');
  preview.hidden = true;
}

function stopIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = undefined;
}

function setManualSleep(enabled) {
  manualSleep = enabled;
  previewSleep.textContent = enabled ? 'Resume preview' : 'Sleep preview';
  previewSleep.title = enabled ? 'Start streaming in this tab again' :
    'Stop streaming in this tab until you resume';
}

function locked() {
  generation++;
  galleryRequest++;
  gallerySnapshot = '';
  stopPreview();
  stopIdleTimer();
  sleeping = false;
  setManualSleep(false);
  clearFrame();
  previewStatus.hidden = false;
  previewStatus.textContent = 'Waiting for the camera…';
  photos.replaceChildren();
  photoDialog.close();
  camera.hidden = lock.hidden = true;
  captureButton.hidden = true;
  captureStatus.textContent = '';
  passkeyOffer.hidden = true;
  invite.hidden = !inviteCode;
  unlock.hidden = lanPage || Boolean(inviteCode) || (guestPage && !familyLogin);
  if (unlock.hidden && !inviteCode && guestPage && !lanPage)
    status.textContent = 'Open the invitation link from the camera owner.';
  admin = false;
  showAdmin(false);
}

const fileSize = (bytes) => bytes < 1_000_000 ? `${Math.ceil(bytes / 1000)} KB` :
  `${(bytes / 1_000_000).toFixed(1)} MB`;

function showPhotoProgress(received, total, complete = false) {
  if (Number.isFinite(total) && total > 0) {
    const percent = complete ? 100 : Math.min(99, Math.floor(received / total * 100));
    photoProgress.value = percent;
    byId('photo-percent').textContent = `${percent}%`;
    byId('photo-bytes').textContent = `${fileSize(received)} of ${fileSize(total)}`;
  } else {
    photoProgress.removeAttribute('value');
    byId('photo-percent').textContent = 'Loading photo…';
    byId('photo-bytes').textContent = `${fileSize(received)} loaded`;
  }
}

function clearPhoto() {
  photoRequest?.abort();
  photoRequest = undefined;
  photoFull.removeAttribute('src');
  photoFull.hidden = true;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = undefined;
}

async function openPhoto(name, encoded, bytes) {
  clearPhoto();
  const request = new AbortController();
  photoRequest = request;
  const original = /\.(jpe?g|png|webp)$/i.test(name);
  byId('photo-title').textContent = name.split('/').at(-1);
  byId('photo-download').href = '/download/' + encoded;
  photoFull.alt = name.split('/').at(-1);
  photoStatus.textContent = '';
  photoLoading.hidden = false;
  showPhotoProgress(0, original ? bytes : 0);
  photoDialog.showModal();
  void refreshPreview();
  try {
    const response = await fetch((original ? '/photo/' : '/thumbnail/') + encoded, {signal: request.signal});
    if (!response.ok) throw new Error('Photo request failed');
    const encoding = response.headers.get('Content-Encoding');
    const length = !encoding || encoding === 'identity' ? Number(response.headers.get('Content-Length')) : 0;
    const total = length || (original ? bytes : 0);
    let received = 0;
    const chunks = [];
    showPhotoProgress(received, total);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (request.signal.aborted) return;
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        showPhotoProgress(received, total);
      }
    } finally {
      reader.releaseLock();
    }
    showPhotoProgress(received, total, true);
    photoUrl = URL.createObjectURL(new Blob(chunks, {type: response.headers.get('Content-Type')}));
    photoFull.src = photoUrl;
    await photoFull.decode();
    if (!request.signal.aborted) photoFull.hidden = false;
  } catch {
    if (!request.signal.aborted)
      photoStatus.textContent = 'Preview unavailable. You can still download the original.';
  } finally {
    if (photoRequest === request) photoLoading.hidden = true;
  }
}

photoDialog.addEventListener('close', () => {
  if (photoDialog.open) return;
  clearPhoto();
  byId('photo-download').removeAttribute('href');
  void refreshPreview();
});
photoDialog.addEventListener('click', (event) => {
  if (event.target === photoDialog) photoDialog.close();
});

function renderPhotos(entries) {
  const rows = entries.map(({ name, bytes }) => {
    const row = document.createElement('li');
    const link = document.createElement('button');
    const encoded = encodeURIComponent(name);
    link.type = 'button';
    link.onclick = () => openPhoto(name, encoded, bytes);
    link.className = 'photo-link';
    link.title = 'Open this photo in the viewer';
    const thumb = document.createElement('span');
    thumb.className = 'photo-thumbnail';
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = '/thumbnail/' + encoded;
    thumb.append(image);
    const filename = document.createElement('span');
    filename.textContent = name;
    link.append(thumb, filename);
    const size = document.createElement('span');
    size.textContent = fileSize(bytes);
    const actions = document.createElement('div');
    actions.className = 'photo-actions';
    actions.append(size);
    if (admin) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.title = 'Delete this saved copy from the Pi';
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
  stopPreview();
  const current = previewGeneration;
  if (document.hidden || camera.hidden || photoDialog.open) return;
  if (admin && adminMenu.matches(':popover-open')) {
    previewStatus.textContent = 'Preview paused while administration is open.';
    previewStatus.hidden = false;
    return;
  }
  if (manualSleep || sleeping) {
    clearFrame();
    previewStatus.textContent = manualSleep ? 'Preview asleep. Select Resume preview to start streaming.' :
      'Sleep mode. Move the pointer, tap, or press a key to wake the preview.';
    previewStatus.hidden = false;
    return;
  }
  try {
    streamRequest = new AbortController();
    const response = await fetch('/stream', { signal: streamRequest.signal });
    if (current !== previewGeneration) return;
    if (response.status === 401 || response.status === 403) return locked();
    if (!response.ok || !response.body) throw new Error();
    for await (const frame of streamFrames(response.body)) {
      if (current !== previewGeneration) return;
      showFrame(frame);
    }
  } catch {
    if (current === previewGeneration) {
      previewStatus.textContent = preview.hidden ? 'Preview unavailable. Reconnecting…' : 'Showing the last frame.';
      previewStatus.hidden = false;
    }
  } finally {
    if (current === previewGeneration) timer = setTimeout(refreshPreview, 2500);
  }
}

function scheduleIdle() {
  const remaining = idleSeconds * 1000 - (performance.now() - lastActivity);
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (document.hidden || camera.hidden) return;
    if (performance.now() - lastActivity < idleSeconds * 1000) {
      scheduleIdle();
      return;
    }
    sleeping = true;
    void refreshPreview();
  }, Math.max(0, remaining));
}

function noteActivity() {
  if (manualSleep || document.hidden || camera.hidden) return;
  lastActivity = performance.now();
  if (idleTimer === undefined) scheduleIdle();
  if (!sleeping) return;
  sleeping = false;
  previewStatus.textContent = 'Connecting to the camera…';
  void refreshPreview();
}

function synchronizePreviewVisibility() {
  stopIdleTimer();
  if (!document.hidden && !camera.hidden) {
    sleeping = false;
    noteActivity();
  }
  void refreshPreview();
}

async function refreshPhotos() {
  const current = ++galleryRequest;
  const response = await fetch('/photos');
  if (current !== galleryRequest) return;
  if (response.status === 401) return locked();
  if (!response.ok) throw new Error();
  const entries = await response.json();
  const snapshot = JSON.stringify(entries);
  if (current === galleryRequest && snapshot !== gallerySnapshot) {
    gallerySnapshot = snapshot;
    renderPhotos(entries);
  }
}

async function loadPhotos() {
  status.textContent = '';
  try {
    await refreshPhotos();
  } catch {
    status.textContent = 'Photos are temporarily unavailable. Reconnecting…';
  }
}

unlock.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = byId('password');
  const family = event.submitter === familyButton || guestPage;
  adminButton.disabled = familyButton.disabled = passkeyButton.disabled = true;
  try {
    await post(family ? '/access/family-login' : '/access/login', { password: password.value });
    unlock.reset();
    if (canUsePasskeys) {
      unlock.hidden = true;
      passkeyOffer.hidden = false;
      status.textContent = '';
      byId('save-passkey').focus();
    } else await enter();
  } catch (error) {
    status.textContent = error.status === 401 ? (family ? 'Check the family password.' : 'Check the admin password.') :
      error.status === 429 ? 'Too many attempts. Try again later.' : 'Could not open the viewer.';
  } finally {
    adminButton.disabled = familyButton.disabled = passkeyButton.disabled = false;
  }
});

passkeyButton.addEventListener('click', async () => {
  adminButton.disabled = familyButton.disabled = passkeyButton.disabled = true;
  status.textContent = '';
  try {
    const { passkeys } = await import('/passkey-client.js');
    await passkeys.authenticatePasskey();
    unlock.reset();
    await enter();
  } catch {
    status.textContent = 'Could not sign in with a passkey. Try again or use your password.';
  } finally {
    adminButton.disabled = familyButton.disabled = passkeyButton.disabled = false;
  }
});

async function finishPasskeyOffer(save) {
  const saveButton = byId('save-passkey');
  const skipButton = byId('skip-passkey');
  saveButton.disabled = skipButton.disabled = true;
  status.textContent = '';
  try {
    if (save) {
      const { passkeys } = await import('/passkey-client.js');
      await passkeys.registerPasskey('Live Camera');
    }
    await enter();
  } catch {
    status.textContent = save ? 'Could not save the passkey. Try again or continue without one.' :
      'Could not open the viewer. Try again.';
  } finally {
    saveButton.disabled = skipButton.disabled = false;
  }
}

byId('save-passkey').addEventListener('click', () => void finishPasskeyOffer(true));
byId('skip-passkey').addEventListener('click', () => void finishPasskeyOffer(false));

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
    status.textContent = 'Could not sign out. Try again.';
  }
});
captureButton.addEventListener('click', async () => {
  const current = generation;
  captureButton.disabled = true;
  captureStatus.textContent = 'Taking photo…';
  try {
    await post('/capture');
    if (current !== generation) return;
    captureStatus.textContent = 'Photo saved.';
    await loadPhotos();
  } catch (error) {
    if (current === generation) captureStatus.textContent = error.message;
  } finally {
    captureButton.disabled = false;
  }
});
document.addEventListener('visibilitychange', synchronizePreviewVisibility);
previewSleep.addEventListener('click', () => {
  setManualSleep(!manualSleep);
  if (!manualSleep) previewStatus.textContent = 'Connecting to the camera…';
  synchronizePreviewVisibility();
});
window.addEventListener('pagehide', () => {
  stopIdleTimer();
  stopPreview();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) synchronizePreviewVisibility();
});
for (const event of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'change']) {
  document.addEventListener(event, noteActivity, { passive: true });
}
document.addEventListener('preview-timeout', (event) => {
  idleSeconds = event.detail;
  stopIdleTimer();
  noteActivity();
});
adminMenu.addEventListener('toggle', () => {
  if (admin) void refreshPreview();
});
function syncGallery() {
  if (!document.hidden && !camera.hidden) void loadPhotos();
}
document.addEventListener('visibilitychange', syncGallery);
setInterval(syncGallery, 15000);

async function enter() {
  const response = await fetch('/session');
  if (!response.ok) return locked();
  const session = await response.json();
  const { role } = session;
  passkeyOffer.hidden = true;
  idleSeconds = session.idleSeconds ?? 15;
  admin = role === 'admin';
  if (admin && location.search !== '?manage=1') {
    location.replace('/controls');
    return;
  }
  camera.hidden = false;
  lock.hidden = lanPage;
  captureButton.hidden = !admin;
  unlock.hidden = invite.hidden = true;
  const current = generation;
  await Promise.all([showAdmin(admin, idleSeconds), loadPhotos()]);
  if (admin && current === generation) adminMenu.showPopover();
  if (current === generation) synchronizePreviewVisibility();
}
void enter().catch(() => {
  locked();
  status.textContent = 'The camera viewer is temporarily unavailable.';
});
