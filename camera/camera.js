const $ = id => document.getElementById(id);
let token = location.hash.slice(1) || sessionStorage.getItem('camera-token');
if (location.hash) { sessionStorage.setItem('camera-token', token); history.replaceState(null, '', '/'); }
let busy = false;
let imageUrl;
let modalUrl;
let modalName;
const overview = document.createElement('canvas');
overview.id = 'mag-map';
overview.width = 160;
overview.height = 107;
overview.hidden = true;
overview.setAttribute('aria-label', 'Magnified area within the full frame');
$('preview').parentElement.append(overview);
const fullFrame = overview.cloneNode();
let selecting = false;
let dragging = null;
let moving = false;
let magnified = false;
let displayedViewport = null;
let previewRevision = 0;
let capturing = false;
function updateShutter() {
  $('capture').disabled = !displayedViewport || selecting || moving || capturing;
}
const surface = $('focus-target');
function selectionMode(enabled) {
  selecting = enabled;
  updateShutter();
  dragging = null;
  surface.classList.toggle('select-area', enabled);
  surface.setAttribute('aria-label', enabled ? 'Choose magnifier area. Enter selects the center.' : 'Focus on live preview. Enter focuses at the center.');
  surface.title = enabled ? 'Drag to select an area or tap a point' : 'Click or tap to focus';
  $('mag-select').textContent = enabled ? 'Cancel selection' : 'Select area to magnify';
  $('mag-help').textContent = enabled ? 'Drag a box around your subject, or tap its center.' : '';
  $('mag-selection').hidden = true;
  if (enabled) {
    $('focus-marker').hidden = true;
    surface.scrollIntoView({block:'nearest'});
    surface.focus({preventScroll:true});
  }
}
$('mag-select').onclick = () => selectionMode(!selecting);
async function moveMagnifier(request) {
  if (moving) return;
  moving = true;
  previewRevision++;
  displayedViewport = null;
  updateShutter();
  $('mag-select').disabled = $('mag-exit').disabled = true;
  $('mag-help').textContent = request.action === 'exit' ? 'Returning to full frame…' : 'Moving the camera magnifier…';
  try {
    await post('/api/magnifier', request);
    selectionMode(false);
  } catch (error) {
    selectionMode(false);
    $('mag-help').textContent = error.message;
  } finally {
    moving = false;
    previewRevision++;
    displayedViewport = null;
    updateShutter();
    $('mag-select').disabled = $('mag-exit').disabled = false;
  }
}
$('mag-exit').onclick = () => moveMagnifier({action:'exit'});
function previewGeometry() {
  const img = $('preview');
  const box = img.getBoundingClientRect();
  const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  const width = img.naturalWidth * scale, height = img.naturalHeight * scale;
  return {box, width, height, left:(box.width-width)/2, top:(box.height-height)/2};
}
function selectionPoint(event) {
  const g = previewGeometry();
  const clamp = value => Math.max(0, Math.min(1, value));
  return {x:clamp((event.clientX-g.box.left-g.left)/g.width), y:clamp((event.clientY-g.box.top-g.top)/g.height)};
}
surface.onpointerdown = event => {
  if (!selecting || moving || dragging || event.button !== 0) return;
  const {box,width,height,left,top} = previewGeometry();
  if (event.clientX < box.left + left || event.clientX > box.left + left + width ||
      event.clientY < box.top + top || event.clientY > box.top + top + height) return;
  dragging = {...selectionPoint(event), id:event.pointerId};
  surface.setPointerCapture(event.pointerId);
};
surface.onpointermove = event => {
  if (dragging?.id !== event.pointerId) return;
  const end = selectionPoint(event), g = previewGeometry(), rect = $('mag-selection');
  rect.style.left = g.left + Math.min(dragging.x,end.x)*g.width + 'px';
  rect.style.top = g.top + Math.min(dragging.y,end.y)*g.height + 'px';
  rect.style.width = Math.abs(dragging.x-end.x)*g.width + 'px';
  rect.style.height = Math.abs(dragging.y-end.y)*g.height + 'px';
  rect.hidden = false;
};
surface.onpointerup = event => {
  if (dragging?.id !== event.pointerId) return;
  const start = dragging, end = selectionPoint(event);
  dragging = null;
  const {width,height} = previewGeometry();
  const spanX = Math.abs(start.x-end.x), spanY = Math.abs(start.y-end.y);
  const tap = spanX*width < 5 && spanY*height < 5;
  moveMagnifier({action:'region', x:(start.x+end.x)/2, y:(start.y+end.y)/2,
    width:tap ? 0 : spanX, height:tap ? 0 : spanY});
};
surface.onpointercancel = () => { dragging = null; $('mag-selection').hidden = true; };
surface.onkeydown = event => {
  if (event.key === 'Escape' && selecting && !moving) selectionMode(false);
};
function showMagnifier(response) {
  const ratio = Number(response.headers.get('X-Magnification')) || 1;
  const active = ratio > 1;
  if (magnified && !active) $('preview-status').textContent = 'Tap to focus';
  if (active) $('preview-status').textContent = 'Capture this crop';
  const x = Number(response.headers.get('X-Magnifier-X'));
  const y = Number(response.headers.get('X-Magnifier-Y'));
  displayedViewport = {ratio,x,y};
  const label = active ? 'Take cropped photo' : 'Take photo';
  $('capture').setAttribute('aria-label', label);
  $('capture').title = label;
  updateShutter();
  overview.hidden = !active;
  if (active && selecting && !moving) selectionMode(false);
  magnified = active;
  $('mag-select').hidden = active;
  $('mag-select').disabled = moving;
  $('mag-exit').hidden = !active;
  $('mag-level').textContent = ratio + '×';
  $('focus-target').hidden = active;
  if (!active) {
    fullFrame.getContext('2d').drawImage($('preview'), 0, 0, 160, 107);
    return;
  }
  $('focus-marker').hidden = true;
  const ctx = overview.getContext('2d');
  ctx.drawImage(fullFrame, 0, 0);
  ctx.strokeStyle = '#ff9500';
  ctx.lineWidth = 2;
  ctx.strokeRect((x - 0.5 / ratio) * 160, (y - 0.5 / ratio) * 107, 160 / ratio, 107 / ratio);
}
async function api(path, options = {}) {
  const headers = {'X-Camera-Token': token || '', ...options.headers};
  const response = await fetch(path, {...options, headers});
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Camera unavailable'); }
  return response;
}
async function post(path, value) { return api(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value)}); }
async function preview() {
  if (!busy && !moving && !capturing) {
    const revision = previewRevision;
    try {
      const response = await api('/api/preview');
      const url = URL.createObjectURL(await response.blob());
      $('preview').src = url;
      $('preview').hidden = false;
      await $('preview').decode();
      if (revision === previewRevision) showMagnifier(response);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = url;
      $('preview-message').hidden = true;
      $('status').textContent = 'Connected';
    } catch (error) {
      displayedViewport = null;
      updateShutter();
      if (selecting && !moving) selectionMode(false);
      $('mag-select').disabled = true;
      overview.hidden = true;
      surface.hidden = true;
      $('focus-marker').hidden = true;
      $('status').textContent = error.message.includes('Could not claim') ? 'Camera busy. Retrying.' : 'Camera unavailable. Retrying.';
      $('status').title = error.message;
      $('preview').hidden = true;
      $('preview-message').hidden = false;
      $('preview-message').textContent = 'Preview unavailable';
    }
  }
  setTimeout(preview, 500);
}
const labels = {'iso':'ISO','shutterspeed':'Shutter speed','f-number':'Aperture','whitebalance':'White balance','focusmode':'Focus mode','exposurecompensation':'Exposure compensation','imagequality':'Image quality'};
labels.sensorcrop = 'APS-C crop (1.5×)';
labels.focusarea = 'Focus area';
$('focus-target').onclick = async event => {
  if (moving || magnified) return;
  if (selecting) {
    if (!event.detail) moveMagnifier({action:'region',x:0.5,y:0.5,width:0,height:0});
    return;
  }
  const target = $('focus-target');
  const img = $('preview');
  if (!img.naturalWidth || target.disabled) return;
  const {box,width,height,left,top} = previewGeometry();
  const x = event.detail ? (event.clientX - box.left - left) / width : 0.5;
  const y = event.detail ? (event.clientY - box.top - top) / height : 0.5;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  target.disabled = true;
  const marker = $('focus-marker');
  marker.hidden = true;
  $('preview-status').textContent = 'Focusing…';
  try {
    const result = await (await post('/api/focus', {x,y})).json();
    marker.style.left = (left + result.x * width) / box.width * 100 + '%';
    marker.style.top = (top + result.y * height) / box.height * 100 + '%';
    marker.dataset.locked = String(result.locked);
    marker.hidden = false;
    $('preview-status').textContent = result.locked ? 'Focus locked' : 'Focus lock unconfirmed';
  } catch (error) {
    $('preview-status').textContent = error.message;
  } finally {
    target.disabled = false;
  }
};
async function downloadPhoto(name) {
  const blob = await (await api(`/api/photos/${encodeURIComponent(name)}`)).blob();
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function fileSize(bytes) {
  if (bytes < 1000) return bytes + ' B';
  if (bytes < 1000000) return (bytes / 1000).toFixed(1) + ' kB';
  return (bytes / 1000000).toFixed(1) + ' MB';
}
let originalRequest;
function photoProgress(received, total) {
  const bar = $('load-progress');
  if (total > 0) {
    bar.value = Math.min(100, received / total * 100);
    $('load-percent').textContent = Math.floor(bar.value) + '%';
    $('load-bytes').textContent = fileSize(received) + ' of ' + fileSize(total);
  } else {
    bar.removeAttribute('value');
    $('load-percent').textContent = 'Loading original';
    $('load-bytes').textContent = fileSize(received);
  }
}
async function openPhoto(name, bytes) {
  $('modal-photo').parentElement.classList.remove('actual-size');
  $('modal-zoom').disabled = true;
  $('modal-zoom').textContent = '100%';
  originalRequest?.abort();
  const request = new AbortController();
  originalRequest = request;
  modalName = name;
  const title = name.split('/').pop() + ' · ' + fileSize(bytes);
  $('modal-name').textContent = title;
  $('modal-status').hidden = true;
  $('photo-loading').hidden = false;
  photoProgress(0, bytes);
  $('modal-photo').removeAttribute('src'); $('photo-dialog').showModal();
  try {
    const response = await api(`/api/photos/${encodeURIComponent(name)}`, {signal:request.signal});
    const total = Number(response.headers.get('Content-Length'));
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (request.signal.aborted || !$('photo-dialog').open) return;
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      photoProgress(received, total);
    }
    modalUrl = URL.createObjectURL(new Blob(chunks, {type:response.headers.get('Content-Type')}));
    const img = $('modal-photo');
    img.src = modalUrl;
    await img.decode();
    if (request.signal.aborted) return;
    $('modal-name').textContent = title + ' · ' + img.naturalWidth + ' × ' + img.naturalHeight;
    $('modal-zoom').disabled = false;
  } catch (error) {
    if (request.signal.aborted) return;
    $('modal-status').textContent = 'Unable to display original. ' + error.message;
    $('modal-status').hidden = false;
  } finally {
    if (originalRequest === request) $('photo-loading').hidden = true;
  }
}
$('photo-dialog').addEventListener('click', event => { if (event.target === $('photo-dialog')) $('photo-dialog').close(); });
$('photo-dialog').addEventListener('close', () => { originalRequest?.abort(); originalRequest = null; modalName = null; $('modal-photo').removeAttribute('src'); if (modalUrl) URL.revokeObjectURL(modalUrl); modalUrl = null; });
$('modal-close').onclick = () => $('photo-dialog').close();
function togglePhotoZoom(event) {
  if ($('modal-zoom').disabled) return;
  const img = $('modal-photo');
  const viewport = img.parentElement;
  const bounds = img.getBoundingClientRect();
  const onImage = event.currentTarget === img;
  const x = onImage ? (event.clientX - bounds.left) / bounds.width : 0.5;
  const y = onImage ? (event.clientY - bounds.top) / bounds.height : 0.5;
  const actual = viewport.classList.toggle('actual-size');
  $('modal-zoom').textContent = actual ? 'Fit' : '100%';
  viewport.scrollLeft = actual ? x * img.naturalWidth - viewport.clientWidth / 2 : 0;
  viewport.scrollTop = actual ? y * img.naturalHeight - viewport.clientHeight / 2 : 0;
}
$('modal-zoom').onclick = togglePhotoZoom;
$('modal-photo').onclick = togglePhotoZoom;
$('modal-download').onclick = () => downloadPhoto(modalName).catch(error => { $('modal-status').hidden = false; $('modal-status').textContent = error.message; });
$('modal-delete').onclick = async () => { if (modalName && confirm(`Delete ${modalName} from the Pi?`)) { try { await post('/api/delete', {name:modalName}); $('photo-dialog').close(); await photos(); } catch (error) { $('modal-status').hidden = false; $('modal-status').textContent = error.message; } } };
function controlledByMode(name, mode) {
  const value = mode.toLowerCase();
  const automatic = value.includes('auto') || value.includes('intelligent');
  if (automatic && ['iso','shutterspeed','f-number','exposurecompensation'].includes(name)) return true;
  if (['a','aperture priority'].includes(value) && name === 'shutterspeed') return true;
  if (['s','shutter priority'].includes(value) && name === 'f-number') return true;
  return ['p','program'].includes(value) && ['shutterspeed','f-number'].includes(name);
}
function showBattery(raw) {
  const match = /^(\d{1,3})\s*%?$/.exec(String(raw).trim());
  const level = match ? Number(match[1]) : NaN;
  const known = Number.isFinite(level) && level <= 100;
  $('battery-level').textContent = known ? level + '%' : 'Unavailable';
  $('battery-fill').setAttribute('width', known ? 23 * level / 100 : 0);
  $('battery').dataset.level = !known ? 'unknown' : level <= 10 ? 'critical' : level <= 20 ? 'low' : 'normal';
  $('battery-state').textContent = known ? 'Not charging' : '';
  $('battery').title = known ? 'The α7 III charges its battery when switched off.' : 'Camera battery status unavailable';
}
async function settings() {
  busy = true;
  try {
    const data = await (await api('/api/settings')).json();
    showBattery(data.battery);
    const explanations = {M:'Manual. You control aperture and shutter speed.', A:'Aperture priority. You control aperture; the camera chooses shutter speed.', S:'Shutter priority. You control shutter speed; the camera chooses aperture.', P:'Program auto. The camera chooses aperture and shutter speed.'};
    $('mode').textContent = explanations[data.mode] || `Shooting mode: ${data.mode}. Controls managed by this mode are disabled.`;
    for (const [name, label] of Object.entries(labels)) {
      const value = data[name];
      let select = $(name);
      if (!select) {
        const wrapper = document.createElement('label'); wrapper.className = 'control'; wrapper.textContent = label;
        select = document.createElement('select'); select.id = name;
        const feedback = document.createElement('span');
        feedback.className = 'setting-error';
        feedback.id = name + '-error';
        feedback.setAttribute('role', 'alert');
        select.setAttribute('aria-describedby', feedback.id);
        select.addEventListener('change', async () => {
          const requested = select.value;
          busy = true;
          select.disabled = true;
          feedback.textContent = '';
          try {
            await post('/api/setting', {name, value:requested});
          } catch (error) {
            feedback.textContent = label + ' change failed. ' + error.message;
            if (name === 'focusmode' && requested !== 'Manual' && error.message.includes('reports Manual')) {
              feedback.textContent += '. Check that the AF/MF switch on the lens is set to AF.';
            }
          } finally {
            await settings();
          }
        });
        wrapper.append(select, feedback); $('settings').append(wrapper);
        if (name === 'sensorcrop') {
          const hint = document.createElement('small');
          hint.textContent = 'Set on camera under APS-C/Super 35mm. The 35mm prime has a fixed focal length.';
          wrapper.append(hint);
        }
      }
      const available = value.choices.includes(value.current);
      const choices = JSON.stringify([value.choices, available ? null : value.current]);
      if (select.dataset.choices !== choices) {
        select.replaceChildren();
        if (!available) { const option = new Option(value.current || 'Unavailable', ''); option.disabled = true; select.add(option); }
        for (const choice of value.choices) select.add(new Option(choice, choice));
        select.dataset.choices = choices;
      }
      select.value = available ? value.current : '';
      select.disabled = value.readonly || !value.choices.length || controlledByMode(name, data.mode);
      select.title = select.disabled ? 'Unavailable in the current camera mode or configuration' : '';
    }
  } catch (error) { showBattery(null); $('status').textContent = error.message; } finally { busy = false; }
}
let library = [];
let libraryRequest = 0;
const stamp = new Intl.DateTimeFormat(undefined, {dateStyle:'medium', timeStyle:'medium'});
function renderPhotos() {
  const from = $('photo-from').value;
  const through = $('photo-through').value;
  const visible = library.filter(({saved}) => {
    const date = new Date(saved * 1000);
    const day = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
    return (!from || day >= from) && (!through || day <= through);
  });
  if ($('photo-sort').value === 'old') visible.reverse();
  const grid = $('photos');
  const signature = JSON.stringify(visible);
  $('photos-message').textContent = visible.length ? '' : library.length ? 'No photos in this date range.' : 'No photos yet.';
  if (grid.dataset.signature === signature) return;
  grid.dataset.signature = signature;
  for (const img of grid.querySelectorAll('img[src]')) URL.revokeObjectURL(img.src);
  grid.replaceChildren();
  for (const {name, saved, bytes} of visible) {
      const item = document.createElement('div'); item.className = 'photo';
      const thumb = document.createElement('img'); thumb.alt = ''; thumb.loading = 'lazy';
      api(`/api/thumbnail/${encodeURIComponent(name)}`).then(r => r.blob()).then(blob => { if (thumb.isConnected) thumb.src = URL.createObjectURL(blob); }).catch(() => { thumb.remove(); });
      const view = document.createElement('button'); view.className = 'photo-view'; view.setAttribute('aria-label', `Open ${name} at full resolution`); view.append(thumb);
      view.onclick = () => openPhoto(name, bytes);
      const filename = document.createElement('div'); filename.className = 'photo-name'; filename.textContent = name.split('/').pop();
      const date = new Date(saved * 1000);
      const time = document.createElement('time'); time.dateTime = date.toISOString(); time.textContent = 'Saved ' + stamp.format(date);
      const download = document.createElement('button'); download.textContent = 'Download'; download.onclick = () => downloadPhoto(name).catch(error => { $('status').textContent = error.message; });
      const remove = document.createElement('button'); remove.className = 'delete'; remove.textContent = 'Delete'; remove.onclick = async () => { if (confirm(`Delete ${name} from the Pi?`)) { try { await post('/api/delete',{name}); await photos(); } catch (error) { $('status').textContent = error.message; } } };
      const size = document.createElement('small'); size.textContent = fileSize(bytes);
      item.append(view,filename,time,size,document.createElement('br'),download,remove); grid.append(item);
    }
}
async function photos() {
  const request = ++libraryRequest;
  try {
    const entries = await (await api('/api/photos?details=1')).json();
    if (request !== libraryRequest) return;
    library = entries;
    renderPhotos();
  } catch (error) { if (request === libraryRequest) $('photos-message').textContent = error.message; }
}
updateShutter();
$('capture').onclick = async () => {
  if ($('capture').disabled) return;
  const viewport = displayedViewport;
  capturing = true;
  updateShutter();
  $('capture-status').textContent = 'Capturing…';
  try {
    await post('/api/capture', {viewport});
    $('capture-status').textContent = viewport.ratio > 1 ? 'Cropped photo saved' : 'Photo saved';
    await photos();
  } catch (error) {
    $('capture-status').textContent = error.message;
  } finally {
    capturing = false;
    displayedViewport = null;
    previewRevision++;
    updateShutter();
  }
};
for (const id of ['photo-from','photo-through','photo-sort']) $(id).onchange = renderPhotos;
function syncPhotos() { if (token && !document.hidden) photos(); }
setInterval(syncPhotos, 5000);
document.addEventListener('visibilitychange', syncPhotos);
function start() { settings().then(preview); photos(); }
if (token) start();
else {
  $('login').hidden = false;
  $('login-form').onsubmit = async event => {
    event.preventDefault(); token = $('access-key').value;
    try { await api('/api/photos'); sessionStorage.setItem('camera-token', token); $('access-key').value = ''; $('login').hidden = true; start(); }
    catch { token = ''; $('login-error').textContent = 'Access key was not accepted.'; }
  };
}
function syncVisibleSettings() {
  if (token && !busy && !document.hidden) settings();
}
document.addEventListener('visibilitychange', syncVisibleSettings);
setInterval(syncVisibleSettings, 10000);
