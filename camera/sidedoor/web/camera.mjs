import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

export function createCamera({ port, cameraToken }) {
  const upstream = `http://127.0.0.1:${port}`;
  let frame;
  let pendingFrame;
  let refreshedAt = -Infinity;
  let nextCapture = 0;
  let downloads = 0;

  function request(path, signal, body) {
    return fetch(upstream + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-Camera-Token': cameraToken,
        ...(body === undefined ? {} : { Origin: upstream, 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal,
    });
  }

  async function preview(previous) {
    if (frame && frame !== previous && performance.now() - refreshedAt < 500) return frame;
    pendingFrame ??= refresh();
    return pendingFrame;
  }

  async function refresh() {
    const wait = nextCapture - performance.now();
    if (wait > 0) await delay(wait);
    nextCapture = performance.now() + 100;
    try {
      const result = await request('/api/preview', AbortSignal.timeout(20000));
      if (!result.ok || result.headers.get('content-type') !== 'image/jpeg' ||
          result.headers.get('x-preview-backend') !== 'rust') {
        await result.body?.cancel();
        frame = null;
      } else {
        frame = Buffer.from(await result.arrayBuffer());
      }
      return frame;
    } catch {
      frame = null;
      return null;
    } finally {
      refreshedAt = performance.now();
      if (!frame) nextCapture = refreshedAt + 250;
      pendingFrame = undefined;
    }
  }

  async function json(path, body) {
    const result = await request(path, AbortSignal.timeout(120000), body);
    if (result.ok) return { status: result.status, data: await result.json() };
    await result.body?.cancel();
    return { status: result.status, data: { error: result.status === 409 ? 'Camera busy.' : 'Camera request failed.' } };
  }

  async function download(name, response, inline = false) {
    if (downloads >= 2) return 429;
    downloads++;
    const disconnect = new AbortController();
    const cancel = () => disconnect.abort();
    response.once('close', cancel);
    try {
      const path = '/api/photos/' + encodeURIComponent(name) + (inline ? '?display=1' : '');
      const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(300000)]);
      const result = await request(path, signal);
      if (!result.ok || !result.body) {
        await result.body?.cancel();
        return 404;
      }
      const type = result.headers.get('content-type');
      if (inline && !['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
        await result.body.cancel();
        return 415;
      }
      const filename = name.split('/').at(-1);
      const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) =>
        '%' + char.charCodeAt(0).toString(16).toUpperCase());
      response.setHeader('Content-Type', inline ? type : 'application/octet-stream');
      if (inline) response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      response.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`);
      const length = result.headers.get('content-length');
      if (length !== null) response.setHeader('Content-Length', length);
      await pipeline(Readable.fromWeb(result.body), response);
      return 200;
    } finally {
      response.off('close', cancel);
      downloads--;
    }
  }

  async function thumbnail(name) {
    const result = await request('/api/thumbnail/' + encodeURIComponent(name), AbortSignal.timeout(30000));
    if (!result.ok || result.headers.get('content-type') !== 'image/jpeg') {
      await result.body?.cancel();
      return null;
    }
    return Buffer.from(await result.arrayBuffer());
  }

  async function cameraControl(path, response, body) {
    const disconnect = new AbortController();
    const cancel = () => disconnect.abort();
    response.once('close', cancel);
    try {
      const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(120000)]);
      const result = await request(path, signal, body);
      const type = result.headers.get('content-type');
      if (!result.body || !['application/json', 'image/jpeg'].includes(type)) {
        await result.body?.cancel();
        return 502;
      }
      for (const name of ['content-type', 'content-length', 'x-preview-backend',
        'x-magnification', 'x-magnifier-x', 'x-magnifier-y']) {
        const value = result.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      response.writeHead(result.status);
      await pipeline(Readable.fromWeb(result.body), response);
      return 200;
    } finally {
      response.off('close', cancel);
    }
  }

  return { preview, download, json, thumbnail, cameraControl };
}

export function photoName(encoded) {
  try {
    const name = decodeURIComponent(encoded);
    if (/[\u0000-\u001f\u007f\\]/u.test(name)) return null;
    return name.split('/').every((part) => part && !part.startsWith('.')) ? name : null;
  } catch {
    return null;
  }
}
