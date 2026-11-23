import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createViewer, initializeAdmin, initializeFamily } from '../camera/sidedoor/web/server.mjs';
import { createCamera } from '../camera/sidedoor/web/camera.mjs';
import { createRelay } from '../camera/sidedoor/web/relay.mjs';

const origin = 'https://camera.example.test';
const password = 'valid-admin-password';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function call(port, path, { method = 'GET', body, cookie, site = origin, host = 'camera.example.test', protocol } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { Host: host };
    if (protocol) headers['X-Forwarded-Proto'] = protocol;
    if (cookie) headers.Cookie = cookie;
    if (method === 'POST') Object.assign(headers, {
      Origin: site, 'Content-Type': 'application/json', 'Content-Length': payload.length,
    });
    const outgoing = request({ host: '127.0.0.1', port, path, method, headers }, async (result) => {
      const chunks = [];
      for await (const chunk of result) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const data = result.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes) : bytes;
      const sid = result.headers['set-cookie']?.[0]?.split(';')[0];
      resolve({ status: result.statusCode, data, headers: result.headers, cookie: sid });
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

test('serves admins and read-only invitees on the same hostname', { timeout: 8000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sony-camera-shared-'));
  await initializeAdmin(directory, password);
  const familyPassword = 'separate-family-password';
  await assert.rejects(initializeFamily(directory, password), /separate family password/);
  assert.equal(await initializeFamily(directory, familyPassword), true);
  let schedule = { enabled: false, times: ['08:00'], timezone: 'UTC' };
  const camera = {
    async json(path, body) {
      if (path === '/api/schedule') {
        if (body) schedule = body;
        return { status: 200, data: schedule };
      }
      if (path === '/api/capture') return { status: 200, data: { ok: true, files: ['capture.jpg'] } };
      assert.equal(path, '/api/photos?details=1');
      return { status: 200, data: [{ name: 'street.jpg' }] };
    },
  };
  const server = await createViewer({ origin, directory, camera, mode: 'shared' });
  const port = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const get = (path, cookie) => call(port, path, { cookie });
  const post = (path, body, cookie) => call(port, path, { method: 'POST', body, cookie });
  assert.equal((await get('/photos')).status, 401);
  assert.equal((await get('/ai')).status, 401);
  assert.equal((await get('/admin-qr.js')).status, 401);
  const owner = await post('/access/login', { password });
  assert.equal(owner.status, 200);
  assert.equal((await get('/session', owner.cookie)).data.role, 'admin');
  assert.equal((await get('/ai', owner.cookie)).status, 200);
  assert.equal((await post('/access/login', { password: familyPassword })).status, 401);
  const family = await post('/access/family-login', { password: familyPassword });
  assert.equal(family.status, 200);
  assert.equal((await get('/session', family.cookie)).data.role, 'viewer');
  assert.equal((await get('/photos', family.cookie)).status, 200);
  assert.equal((await get('/controls', family.cookie)).status, 403);
  assert.equal((await post('/capture', {}, family.cookie)).status, 403);
  assert.equal((await post('/access/issue-invitation', {}, family.cookie)).status, 403);
  assert.deepEqual((await post('/capture', {}, owner.cookie)).data.files, ['capture.jpg']);
  assert.equal((await get('/schedule', owner.cookie)).data.enabled, false);
  const daily = { enabled: true, times: ['08:30'], timezone: 'America/Chicago' };
  assert.deepEqual((await post('/schedule', daily, owner.cookie)).data, daily);
  const invitation = await post('/access/issue-invitation', {}, owner.cookie);
  assert.equal(invitation.data.origin, origin);
  const body = { code: invitation.data.code };
  const viewer = await post('/access/redeem-invitation', body);
  assert.equal(viewer.status, 200);
  assert.equal((await post('/access/redeem-invitation', body)).status, 401);
  assert.deepEqual((await get('/session', viewer.cookie)).data, { role: 'viewer', idleSeconds: 15 });
  assert.equal((await post('/preview-settings', { idleSeconds: 30 }, viewer.cookie)).status, 403);
  for (const idleSeconds of [4, 301, 15.5, '15']) {
    assert.equal((await post('/preview-settings', { idleSeconds }, owner.cookie)).status, 400);
  }
  assert.deepEqual((await post('/preview-settings', { idleSeconds: 30 }, owner.cookie)).data, { idleSeconds: 30 });
  assert.equal((await get('/session', viewer.cookie)).data.idleSeconds, 30);
  assert.deepEqual((await get('/photos', viewer.cookie)).data, [{ name: 'street.jpg' }]);
  assert.equal((await get('/settings', viewer.cookie)).status, 403);
  assert.equal((await get('/ai', viewer.cookie)).status, 403);
  assert.equal((await get('/controls', viewer.cookie)).status, 403);
  assert.equal((await get('/camera.js', viewer.cookie)).status, 403);
  assert.equal((await post('/api/focus', { x: 0.5, y: 0.5 }, viewer.cookie)).status, 403);
  assert.equal((await get('/schedule', viewer.cookie)).status, 403);
  assert.equal((await post('/schedule', { ...daily, enabled: false }, viewer.cookie)).status, 403);
  assert.equal((await get('/admin-qr.js', viewer.cookie)).status, 403);
  assert.equal((await post('/delete', { name: 'street.jpg' }, viewer.cookie)).status, 403);
  assert.equal((await post('/capture', {}, viewer.cookie)).status, 403);
  assert.equal((await post('/access/issue-invitation', {}, viewer.cookie)).status, 403);
});

test('limits concurrent streams and lets only the admin disconnect active viewers', { timeout: 8000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sony-camera-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initializeAdmin(directory, password);
  const familyPassword = 'separate-family-password';
  await initializeFamily(directory, familyPassword);
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const camera = { async preview() { return frame; } };
  const viewer = await createViewer({ origin, directory, camera, mode: 'guest' });
  const admin = await createViewer({ origin, directory, camera });
  t.after(() => { viewer.close(); admin.close(); });
  const port = await listen(viewer);
  const adminPort = await listen(admin);
  const post = (target, path, body, cookie, site) => call(target, path, { method: 'POST', body, cookie, site });
  const owner = await post(adminPort, '/access/login', { password });
  assert.equal((await call(port, '/stream')).status, 401);
  const family = await post(port, '/access/family-login', { password: familyPassword });
  const invitation = await post(adminPort, '/access/issue-invitation', {}, owner.cookie);
  const invited = await post(port, '/access/redeem-invitation', { code: invitation.data.code });
  const spare = await post(adminPort, '/access/issue-invitation', {}, owner.cookie);
  const streams = [];
  t.after(() => streams.forEach((stream) => stream.destroy()));
  for (const cookie of [family.cookie, invited.cookie, family.cookie]) {
    const response = await new Promise((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port, path: '/stream',
        headers: { Host: 'camera.example.test', Cookie: cookie } }, resolve);
      outgoing.on('error', reject);
      outgoing.end();
    });
    streams.push(response);
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /multipart\/x-mixed-replace/);
  }
  assert.equal((await call(port, '/stream', { cookie: family.cookie })).status, 429);
  assert.equal((await call(port, '/settings', { cookie: family.cookie })).status, 404);
  const disconnect = '/access/disconnect-viewers';
  assert.equal((await post(port, disconnect, {}, family.cookie)).status, 404);
  assert.equal((await post(adminPort, disconnect, {}, family.cookie)).status, 403);
  assert.equal((await post(adminPort, disconnect, {}, owner.cookie, 'https://wrong.example')).status, 403);
  const sessionList = () => call(adminPort, '/access/viewer-sessions', { cookie: owner.cookie });
  const active = await sessionList();
  assert.deepEqual(active.data.sessions.map(({ kind }) => kind).sort(), ['family', 'invitation']);
  const closed = streams.map((stream) => new Promise((resolve) => {
    stream.once('close', resolve);
    stream.resume();
  }));
  assert.deepEqual((await post(adminPort, disconnect, {}, owner.cookie)).data, { disconnected: 2 });
  await Promise.all(closed);
  assert.deepEqual((await sessionList()).data, { sessions: [] });
  for (const cookie of [family.cookie, invited.cookie]) {
    assert.equal((await call(port, '/session', { cookie })).status, 401);
    assert.equal((await call(port, '/stream', { cookie })).status, 401);
  }
  assert.equal((await call(adminPort, '/session', { cookie: owner.cookie })).data.role, 'admin');
  assert.deepEqual((await post(adminPort, disconnect, {}, owner.cookie)).data, { disconnected: 0 });
  assert.equal((await post(port, '/access/redeem-invitation', { code: spare.data.code })).status, 200);
  assert.equal((await post(port, '/access/family-login', { password: familyPassword })).status, 200);
});

test('keeps viewer invitations read-only and admin AI credentials private', { timeout: 8000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sony-camera-test-'));
  let deleted = false;
  let previewCalls = 0;
  let iso = '100';
  const upstream = createServer(async (req, res) => {
    if (req.headers['x-camera-token'] !== 'camera-key') return res.writeHead(403).end();
    if (req.url === '/api/preview') {
      previewCalls++;
      return res.writeHead(200, {
        'Content-Type': 'image/jpeg', 'X-Preview-Backend': 'rust', 'X-Magnification': '5.9',
      }).end('jpeg');
    }
    if (req.url === '/api/photos/nonempty%2Fa%20%25.raw') return res.end('original');
    if (req.url === '/api/photos/street.jpg')
      return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end('original jpeg');
    if (req.url === '/api/photos/unsafe.svg')
      return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg/>');
    if (req.url === '/api/thumbnail/nonempty%2Fa%20%25.raw')
      return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end('thumbnail');
    if (req.url === '/api/photos?details=1') return res.end(JSON.stringify(deleted ? [] : [{ name: 'nonempty/a %.raw' }]));
    if (req.url === '/api/settings') return res.end(JSON.stringify({ iso }));
    if (req.method !== 'POST' || req.headers.origin !== `http://127.0.0.1:${upstream.address().port}`)
      return res.writeHead(404).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/api/setting' && data.name === 'iso') iso = data.value;
    else if (req.url === '/api/focus' && data.x === 0.5 && data.y === 0.5)
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"locked":true}');
    else if (req.url === '/api/delete' && data.name === 'nonempty/a %.raw') deleted = true;
    else return res.writeHead(404).end();
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(() => upstream.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initializeAdmin(directory, password);
  const privatePort = await listen(upstream);
  const camera = createCamera({ port: privatePort, cameraToken: 'camera-key' });
  const server = await createViewer({ origin, directory, camera });
  const broker = await createViewer({ origin, directory, camera, mode: 'guest' });
  const socket = join(directory, 'guest.sock');
  await new Promise((resolve) => broker.listen(socket, resolve));
  const relay = createRelay(socket);
  const relayPort = await listen(relay);
  t.after(() => relay.close());
  t.after(() => broker.close());
  t.after(() => server.close());
  const port = await listen(server);
  const get = (path, cookie) => call(port, path, { cookie });
  const post = (path, body, cookie, site) => call(port, path, { method: 'POST', body, cookie, site });
  const guestGet = (path, cookie) => call(relayPort, path, { cookie });
  const guestPost = (path, body, cookie) => call(relayPort, path, { method: 'POST', body, cookie });

  const redirect = await call(relayPort, '/?view=gallery', { protocol: 'http' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, origin + '/?view=gallery');
  assert.equal((await call(relayPort, '/access/login', {
    method: 'POST', body: { password }, protocol: 'http',
  })).status, 403);
  assert.equal((await get('/photos')).status, 401);
  assert.equal((await get('/stream')).status, 401);
  assert.equal((await call(port, '/', { host: 'wrong.example.test' })).status, 403);
  assert.equal((await post('/access/login', { password }, undefined, 'https://other.example.test')).status, 403);
  const owner = await post('/access/login', { password });
  assert.equal(owner.status, 200);
  assert.match(owner.headers['set-cookie'][0], /HttpOnly.*Secure/);
  assert.equal((await get('/session', owner.cookie)).data.role, 'admin');
  assert.equal((await get('/controls')).status, 401);
  const controls = await get('/controls', owner.cookie);
  assert.equal(controls.status, 200);
  assert.match(controls.data.toString(), /<body data-sidedoor>/);
  assert.match(controls.data.toString(), /id="focus-target"/);
  const controlPreview = await get('/api/preview', owner.cookie);
  assert.equal(controlPreview.headers['x-magnification'], '5.9');
  assert.equal(controlPreview.data.toString(), 'jpeg');
  previewCalls = 0;
  assert.equal((await post('/api/focus', { x: 0.5, y: 0.5 }, owner.cookie)).data.locked, true);
  assert.equal((await post('/api/focus', { x: 0.5, y: 0.5 }, owner.cookie, 'https://other.example.test')).status, 403);
  assert.equal((await get('/api/advice-input', owner.cookie)).status, 404);
  const invitation = await post('/access/issue-invitation', { uses: null }, owner.cookie);
  assert.equal(invitation.status, 200);
  const redeemed = await guestPost('/access/redeem-invitation', { code: invitation.data.code });
  assert.equal(redeemed.status, 200);
  const guest = redeemed.cookie;
  assert.equal((await guestPost('/access/redeem-invitation', { code: invitation.data.code })).status, 401);
  assert.equal((await guestGet('/session', guest)).data.role, 'viewer');
  assert.equal((await guestGet('/thumbnail/nonempty%2Fa%20%25.raw')).status, 401);
  const thumbnail = await guestGet('/thumbnail/nonempty%2Fa%20%25.raw', guest);
  assert.equal(thumbnail.headers['content-type'], 'image/jpeg');
  assert.equal(thumbnail.data.toString(), 'thumbnail');
  assert.match(thumbnail.headers['cache-control'], /no-store/);
  assert.equal((await guestGet('/thumbnail/%2e%2e%2Ffile', guest)).status, 404);
  assert.equal((await guestGet('/photo/street.jpg')).status, 401);
  const original = await guestGet('/photo/street.jpg', guest);
  assert.equal(original.status, 200);
  assert.equal(original.headers['content-type'], 'image/jpeg');
  assert.match(original.headers['content-disposition'], /^inline/);
  assert.match(original.headers['cache-control'], /no-store/);
  assert.equal(original.data.toString(), 'original jpeg');
  assert.equal((await guestGet('/photo/unsafe.svg', guest)).status, 415);
  assert.equal((await guestGet('/photo/%2e%2e%2Ffile', guest)).status, 404);
  const guestStream = await new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: relayPort, path: '/stream',
      headers: { Host: 'camera.example.test', Cookie: guest } }, resolve);
    outgoing.on('error', reject);
    outgoing.end();
  });
  assert.equal(guestStream.statusCode, 200);
  guestStream.destroy();
  assert.equal((await guestGet('/session', owner.cookie)).status, 403);
  assert.equal((await guestPost('/access/logout', {}, owner.cookie)).status, 403);
  assert.equal((await guestPost('/access/login', { password })).status, 404);
  assert.equal((await guestGet('/settings', guest)).status, 404);
  assert.equal((await guestPost('/delete', { name: 'nonempty/a %.raw' }, guest)).status, 404);
  assert.equal((await guestPost('/ai', {}, guest)).status, 404);
  assert.deepEqual((await guestGet('/photos', guest)).data, [{ name: 'nonempty/a %.raw' }]);
  const downloads = await guestGet('/download/nonempty%2Fa%20%25.raw', guest);
  assert.equal(downloads.data.toString(), 'original');
  assert.match(downloads.headers['content-disposition'], /^attachment/);
  assert.match(downloads.headers['cache-control'], /no-store/);
  assert.equal((await guestGet('/download/%2e%2e%2Ffile', guest)).status, 404);
  assert.equal((await get('/settings', guest)).status, 403);
  assert.equal((await post('/setting', { name: 'iso', value: '400' }, guest)).status, 403);
  assert.equal((await post('/delete', { name: 'nonempty/a %.raw' }, guest)).status, 403);
  assert.equal((await get('/ai', guest)).status, 403);
  assert.equal((await post('/ai', {}, guest)).status, 403);
  assert.equal((await post('/access/issue-invitation', {}, guest)).status, 403);
  assert.equal((await get('/api/advice-input', owner.cookie)).status, 404);
  assert.equal((await post('/access/configure-household', { password }, owner.cookie)).status, 404);
  assert.equal((await guestGet('/preview', guest)).status, 404);
  const firstFrame = await camera.preview();
  previewCalls = 0;
  const previews = await Promise.all([camera.preview(firstFrame), camera.preview(firstFrame)]);
  assert.equal(previews[0].toString(), 'jpeg');
  assert.equal(previews[0], previews[1]);
  assert.equal(previewCalls, 1);

  const configured = await post('/ai', {
    enabled: true, provider: 'openai', model: 'vision-model', prompt: 'Lift shadows', apiKey: 'example-test-credential',
  }, owner.cookie);
  assert.equal(configured.status, 200);
  assert.equal((await get('/ai', owner.cookie)).data.hasKey, true);
  assert.ok(!JSON.stringify(configured.data).includes('example-test-credential'));
  assert.ok(!(await readFile(join(directory, 'ai.json'), 'utf8')).includes('example-test-credential'));
  assert.equal((await post('/setting', { name: 'iso', value: '400' }, owner.cookie)).status, 200);
  assert.equal((await get('/settings', owner.cookie)).data.iso, '400');
  assert.equal((await post('/delete', { name: 'nonempty/a %.raw' }, owner.cookie)).status, 200);
  assert.deepEqual((await guestGet('/photos', guest)).data, []);

  const sessions = await get('/access/sessions', owner.cookie);
  const activeViewer = sessions.data.sessions.find(({ admission }) => admission === 'invitation');
  assert.ok(activeViewer);
  assert.equal((await post('/access/revoke-session', { id: activeViewer.id }, owner.cookie)).status, 200);
  assert.equal((await guestGet('/photos', guest)).status, 401);

  let onDisconnect;
  const disconnected = new Promise((resolve) => { onDisconnect = resolve; });
  const received = await new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path: '/stream',
      headers: { Host: 'camera.example.test', Cookie: owner.cookie } }, (reply) => {
      reply.on('error', () => {});
      reply.once('close', onDisconnect);
      let body = '';
      reply.on('data', (chunk) => {
        body += chunk;
        if (body.split('jpeg\r\n').length >= 3) resolve({ type: reply.headers['content-type'], body });
      });
    });
    outgoing.on('error', reject);
    t.after(() => outgoing.destroy());
    outgoing.end();
  });
  assert.match(received.type, /^multipart\/x-mixed-replace/);
  assert.match(received.body, /--sony-preview\r\nContent-Type: image\/jpeg/);
  assert.equal((await post('/access/logout', {}, owner.cookie)).status, 200);
  await disconnected;
});
