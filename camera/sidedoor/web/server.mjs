import { randomUUID } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AccessError, AccessService, accessStateSchema, hashPassword, initialAccessState, initializeAccess, isAccessError,
  verifyPassword,
} from 'thesidedoor-core/access';
import { accessErrorStatus, cookieValue, createAccessHandler } from 'thesidedoor-core/access/http';
import { FileStateStore } from 'thesidedoor-core/storage';
import { createAiConfig } from '../ai-config.mjs';
import { createCamera, photoName } from './camera.mjs';
import { sendPreviewStream } from './stream.mjs';

const cookieName = '__Host-sony-viewer';
const ownerName = 'Camera admin';
const familyName = 'Camera family';
const activeStreams = new WeakMap();
const hourMs = 60 * 60 * 1000;
const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/viewer.css', 'viewer.css', 'text/css; charset=utf-8'],
  ['/viewer.js', 'viewer.js', 'text/javascript; charset=utf-8'],
  ['/admin.js', 'admin.js', 'text/javascript; charset=utf-8'],
].map(async ([path, file, type]) =>
  [path, [await readFile(new URL(file, import.meta.url)), type]])));

const ownerAccess = new Set(['issue-invitation', 'revoke-invitation', 'invitations',
  'sessions', 'revoke-session', 'reauthenticate', 'change-password']);
const accessPosts = new Set(['login', 'family-login', 'logout', 'redeem-invitation', 'issue-invitation',
  'revoke-invitation', 'revoke-session', 'reauthenticate', 'change-password']);
const cameraRoutes = new Map([
  ['GET /photos', '/api/photos?details=1'],
  ['GET /settings', '/api/settings'],
  ['GET /schedule', '/api/schedule'],
  ['POST /schedule', '/api/schedule'],
  ['POST /setting', '/api/setting'],
  ['POST /capture', '/api/capture'],
  ['POST /delete', '/api/delete'],
]);
const controlAssets = new Map([
  ['/controls', ['camera.html', 'text/html; charset=utf-8']],
  ['/camera.js', ['camera.js', 'text/javascript; charset=utf-8']],
  ['/camera.css', ['camera.css', 'text/css; charset=utf-8']],
]);
const controlRoutes = new Set([
  'GET /api/preview', 'GET /api/settings', 'GET /api/schedule',
  'GET /api/photos', 'GET /api/photos?details=1',
  'POST /api/capture', 'POST /api/setting', 'POST /api/focus',
  'POST /api/magnifier', 'POST /api/schedule', 'POST /api/delete',
]);

function send(response, status, value, type) {
  const body = type ? value : JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': type ?? 'application/json' });
  response.end(body);
}

async function readJson(request, maxLength = 8192) {
  const length = Number(request.headers['content-length']);
  if (!Number.isInteger(length) || length < 1 || length > maxLength ||
      request.headers['content-type'] !== 'application/json') throw new AccessError('invalid');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AccessError('invalid');
  }
}

function accessStore(directory) {
  return new FileStateStore({
    path: join(directory, 'access.json'),
    initial: initialAccessState,
    parse: (value) => accessStateSchema.parse(value),
  });
}

export async function initializeAdmin(directory, password) {
  return initializeAccess(accessStore(directory), 'sony-camera-admin', {
    mode: 'household',
    principals: [{
      id: randomUUID(), name: ownerName, role: 'owner', epoch: 0, createdAt: Date.now(),
      passwordHash: await hashPassword(password),
    }],
    householdPasswordHash: null,
  });
}

export async function initializeFamily(directory, password) {
  const store = accessStore(directory);
  const snapshot = await store.read();
  const owner = snapshot.principals.find(({ role, name }) => role === 'owner' && name === ownerName);
  if (snapshot.mode !== 'household' || !owner?.passwordHash) throw new Error('Configure the camera admin first');
  if (await verifyPassword(password, owner.passwordHash)) throw new Error('Choose a separate family password');
  const passwordHash = await hashPassword(password);
  return store.transact((state) => {
    if (state.mode !== 'household' || !state.principals.some((item) =>
      item.id === owner.id && item.role === 'owner' && item.passwordHash === owner.passwordHash))
      throw new Error('Camera admin account changed. Retry family setup.');
    if (state.principals.some(({ name }) => name === familyName)) return false;
    state.principals.push({
      id: randomUUID(), name: familyName, role: 'member', epoch: 0, createdAt: Date.now(), passwordHash,
    });
    return true;
  });
}

export async function createViewer({ origin, directory, mode = 'admin', inviteOrigin = origin, camera,
  privateStream = false, viewerStream = false }) {
  const guest = mode === 'guest';
  const shared = mode === 'shared';
  const publicUrl = new URL(origin);
  if (publicUrl.protocol !== 'https:' || publicUrl.origin !== origin || !camera)
    throw new Error('Invalid viewer configuration');

  const store = accessStore(directory);
  const state = await store.read();
  const familyEnabled = state.principals.some(({ name, role, passwordHash }) =>
    name === familyName && role === 'member' && passwordHash);
  if (state.mode !== 'household' || state.householdPasswordHash ||
      !state.principals.some(({ role, name }) => role === 'owner' && name === ownerName))
    throw new Error('Initialize the camera admin before starting the viewer');
  const access = new AccessService({
    store, householdSessionTtlMs: 30 * 24 * hourMs, sessionTtlMs: 12 * hourMs,
    allowPrincipalAccessInHousehold: true, allowHouseholdInvitations: true,
  });
  const sidedoor = createAccessHandler({ access, origin, cookieName, name: 'Sony Live Camera' });
  const ai = createAiConfig(directory);
  let checkingPassword = false;

  function browserRequest(request, body) {
    const headers = new Headers();
    for (const name of ['cookie', 'origin', 'sec-fetch-site']) {
      if (request.headers[name]) headers.set(name, request.headers[name]);
    }
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return new Request(origin, { method: request.method, headers,
      body: body === undefined ? undefined : JSON.stringify(body) });
  }

  async function authenticate(request, ownerOnly) {
    const token = cookieValue(browserRequest({ headers: request.headers, method: 'GET' }), cookieName);
    if (!/^[\w-]{43}$/.test(token ?? '')) throw new AccessError('unauthorized');
    const { principal, session } = await access.authenticate(token);
    const admin = session.principalId !== null && principal?.role === 'owner' && session.principalId === principal.id;
    if (admin && !guest) return { role: 'admin' };
    const invite = session.principalId === null && session.admission === 'invitation';
    const family = principal?.role === 'member' && principal.name === familyName && session.principalId === principal.id;
    if (!(guest || shared) || ownerOnly || !(invite || family))
      throw new AccessError('forbidden');
    return { role: 'viewer' };
  }

  async function handleAccess(request, response, action) {
    const viewerAction = action === 'redeem-invitation' || action === 'family-login';
    if ((!shared && guest !== viewerAction && action !== 'logout') ||
        (action === 'family-login' && !familyEnabled))
      return send(response, 404, { error: 'Not found.' });
    if (!(request.method === 'GET' && ['invitations', 'sessions'].includes(action)) &&
        !(request.method === 'POST' && accessPosts.has(action))) return send(response, 404, { error: 'Not found.' });
    if (ownerAccess.has(action)) await authenticate(request, true);
    if (guest && action === 'logout') await authenticate(request, false);
    let body;
    if (request.method === 'POST') {
      body = await readJson(request);
      if (action === 'login') body = { name: ownerName, password: body.password };
      if (action === 'family-login') body = { name: familyName, password: body.password };
      if (action === 'issue-invitation') body = { uses: 1 };
      if (action === 'redeem-invitation') body = { code: body.code };
    }
    const check = ['login', 'family-login', 'reauthenticate', 'change-password'].includes(action);
    if (check && checkingPassword) return send(response, 429, { error: 'Try again shortly.' });
    if (check) checkingPassword = true;
    try {
      if (action === 'change-password' && typeof body.password === 'string') {
        const family = (await store.read()).principals.find(({ name }) => name === familyName);
        if (family?.passwordHash && await verifyPassword(body.password, family.passwordHash))
          return send(response, 400, { error: 'Choose a password different from the family password.' });
      }
      const result = await sidedoor(browserRequest(request, body), action === 'family-login' ? 'login' : action);
      const cookie = result.headers.get('Set-Cookie');
      if (cookie) response.setHeader('Set-Cookie', cookie);
      if (action === 'issue-invitation' && result.ok)
        return send(response, result.status, { ...(await result.json()), origin: inviteOrigin });
      send(response, result.status, Buffer.from(await result.arrayBuffer()), 'application/json');
    } finally {
      if (check) checkingPassword = false;
    }
  }

  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000 }, (request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent || response.destroyed) return response.destroy();
      const status = isAccessError(error) ? accessErrorStatus(error) : 503;
      send(response, status, { error: status === 503 ? 'Camera viewer unavailable.' : error.code });
    });
  });

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (request.headers.host !== publicUrl.host) return send(response, 403, { error: 'Forbidden.' });
    const path = request.url;
    if (request.headers['x-forwarded-proto'] === 'http') {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return send(response, 403, { error: 'Use HTTPS to access the camera.' });
      if (!path.startsWith('/') || path.startsWith('//'))
        return send(response, 400, { error: 'Invalid request path.' });
      response.writeHead(301, { Location: origin + path }).end();
      return;
    }
    const route = request.method + ' ' + path;
    const photoRoute = request.method === 'GET' && /^\/(thumbnail|photo|download)\/([^/?]+)$/.exec(path);
    if (guest && !(request.method === 'GET' && (
      ['/', '/viewer.css', '/viewer.js', '/admin.js', '/session', '/photos', '/preview'].includes(path) ||
      (viewerStream && path === '/stream') ||
      photoRoute
    )) && !(request.method === 'POST' && ['/access/redeem-invitation', '/access/family-login', '/access/logout'].includes(path)))
      return send(response, 404, { error: 'Not found.' });
    if (request.method === 'POST' && (request.headers.origin !== origin ||
        request.headers['sec-fetch-site'] === 'cross-site')) return send(response, 403, { error: 'Forbidden.' });
    if (path.startsWith('/access/')) return handleAccess(request, response, path.slice(8));
    if (route === 'GET /admin-qr.js') {
      await authenticate(request, true);
      const script = await readFile(new URL('admin-qr.js', import.meta.url));
      return send(response, 200, script, 'text/javascript; charset=utf-8');
    }
    const assetPath = path === '/?manage=1' && !guest ? '/' : path;
    if (request.method === 'GET' && assets.has(assetPath)) {
      const [body, type] = assets.get(assetPath);
      if (assetPath === '/') {
        const guestAttr = guest ? ' data-guest' : '';
        const familyAttr = familyEnabled && (guest || shared) ? ' data-family' : '';
        return send(response, 200, body.toString().replace('<body>', `<body${guestAttr}${familyAttr}>`), type);
      }
      return send(response, 200, body, type);
    }
    if (request.method === 'GET' && controlAssets.has(path)) {
      await authenticate(request, true);
      const [file, type] = controlAssets.get(path);
      let content = await readFile(new URL('../../' + file, import.meta.url), 'utf8');
      if (path === '/controls') content = content.replace('<body>', '<body data-sidedoor>');
      return send(response, 200, content, type);
    }
    const controlPhoto = request.method === 'GET' && /^\/api\/(photos|thumbnail)\/([^/?]+)$/.exec(path);
    if (controlRoutes.has(route) || controlPhoto) {
      await authenticate(request, true);
      const name = controlPhoto && photoName(controlPhoto[2]);
      if (controlPhoto && !name) return send(response, 404, { error: 'Photo unavailable.' });
      const body = request.method === 'POST' ? await readJson(request, 4096) : undefined;
      const result = controlPhoto?.[1] === 'photos'
        ? await camera.download(name, response, /\.(jpe?g|png|webp)$/i.test(name))
        : await camera.cameraControl(path, response, body);
      if (result !== 200) send(response, result, { error: 'Camera request failed.' });
      return;
    }
    if (route === 'GET /session') {
      const session = await authenticate(request, false);
      return send(response, 200, {
        ...session, privateStream: session.role === 'admin' && privateStream,
        ...(viewerStream ? { viewerStream: true } : {}),
      });
    }
    if (route === 'GET /stream' && (privateStream || viewerStream)) {
      const authorize = () => authenticate(request, !viewerStream);
      await authorize();
      const count = activeStreams.get(camera) ?? 0;
      if (count >= 3) return send(response, 429, { error: 'Camera streams are busy.' });
      activeStreams.set(camera, count + 1);
      try {
        if (!await sendPreviewStream(response, camera, authorize))
          send(response, 503, { error: 'Rust preview stream unavailable.' });
      } finally {
        activeStreams.set(camera, activeStreams.get(camera) - 1);
      }
      return;
    }
    if (route === 'POST /ai/check') {
      await authenticate(request, true);
      await readJson(request);
      const result = await ai.check();
      return send(response, 200, result);
    }
    if (route === 'GET /ai' || route === 'POST /ai') {
      await authenticate(request, true);
      if (request.method === 'GET') return send(response, 200, await ai.read());
      const result = await ai.update(await readJson(request));
      return send(response, result ? 200 : 400, result ?? { error: 'Choose a provider, model, goal, and API key.' });
    }
    if (cameraRoutes.has(route)) {
      await authenticate(request, route !== 'GET /photos');
      const body = request.method === 'POST' ? await readJson(request) : undefined;
      if (route === 'POST /delete' && (typeof body.name !== 'string' || !photoName(encodeURIComponent(body.name))))
        return send(response, 400, { error: 'Invalid photo name.' });
      if (route === 'POST /setting' && (typeof body.name !== 'string' || typeof body.value !== 'string'))
        return send(response, 400, { error: 'Invalid setting.' });
      const result = await camera.json(cameraRoutes.get(route), body);
      return send(response, result.status, result.data);
    }
    if (route === 'GET /preview') {
      await authenticate(request, false);
      const frame = await camera.preview();
      return frame ? send(response, 200, frame, 'image/jpeg') : send(response, 503, { error: 'Preview unavailable.' });
    }
    if (photoRoute) {
      await authenticate(request, false);
      const name = photoName(photoRoute[2]);
      if (name) {
        if (photoRoute[1] === 'thumbnail') {
          const jpeg = await camera.thumbnail(name);
          if (jpeg) return send(response, 200, jpeg, 'image/jpeg');
          return send(response, 404, { error: 'Thumbnail unavailable.' });
        }
        const status = await camera.download(name, response, photoRoute[1] === 'photo');
        if (status !== 200) send(response, status, { error: 'Photo unavailable.' });
        return;
      }
    }
    send(response, 404, { error: 'Not found.' });
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.env.STATE_DIRECTORY;
  if (['setup', 'setup-family'].includes(process.argv[2])) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1024) throw new Error('Password is too long');
      chunks.push(chunk);
    }
    const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    const family = process.argv[2] === 'setup-family';
    const initialize = family ? initializeFamily : initializeAdmin;
    const account = family ? 'Camera family viewer' : 'Camera admin';
    if (!await initialize(directory, password)) throw new Error(account + ' already exists');
    console.log(account + ' configured.');
  } else {
    const cameraToken = (await readFile(join(homedir(), '.config/sony-pi-camera/camera-token'), 'utf8')).trim();
    if (!cameraToken) throw new Error('Configure a camera key');
    const camera = createCamera({ cameraToken, port: Number(process.env.PI_CAMERA_PORT ?? 8765) });
    const options = { directory, camera };
    const adminOrigin = process.env.ADMIN_ORIGIN;
    const viewerOrigin = process.env.VIEWER_ORIGIN;
    const shared = adminOrigin === viewerOrigin;
    if (!shared) {
      const admin = await createViewer({ ...options, origin: adminOrigin, inviteOrigin: viewerOrigin,
        privateStream: process.env.PRIVATE_PREVIEW_STREAM === '1' });
      admin.listen(join(process.env.RUNTIME_DIRECTORY, 'admin.sock'));
    }
    const broker = await createViewer({ ...options, origin: viewerOrigin, mode: shared ? 'shared' : 'guest',
      viewerStream: process.env.VIEWER_PREVIEW_STREAM === '1' });
    const brokerPath = join(process.env.RUNTIME_DIRECTORY, 'guest.sock');
    broker.listen(brokerPath, async () => { await chmod(brokerPath, 0o660); });
  }
}
