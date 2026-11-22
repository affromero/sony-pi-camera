import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function createCamera({ port, cameraToken, previewInterval = 2000 }) {
  const upstream = `http://127.0.0.1:${port}`;
  let frame;
  let pendingFrame;
  let refreshAt = 0;
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

  async function preview() {
    if (pendingFrame) return pendingFrame;
    if (Date.now() < refreshAt) return frame;
    pendingFrame = (async () => {
      try {
        const result = await request('/api/preview', AbortSignal.timeout(20000));
        if (!result.ok || result.headers.get('content-type') !== 'image/jpeg') {
          await result.body?.cancel();
          return null;
        }
        return Buffer.from(await result.arrayBuffer());
      } catch {
        return null;
      }
    })();
    try {
      frame = await pendingFrame;
      return frame;
    } finally {
      refreshAt = Date.now() + previewInterval;
      pendingFrame = undefined;
    }
  }

  async function json(path, body) {
    const result = await request(path, AbortSignal.timeout(120000), body);
    if (result.ok) return { status: result.status, data: await result.json() };
    await result.body?.cancel();
    return { status: result.status, data: { error: result.status === 409 ? 'Camera busy.' : 'Camera request failed.' } };
  }

  async function download(name, response) {
    if (downloads >= 2) return 429;
    downloads++;
    const disconnect = new AbortController();
    const cancel = () => disconnect.abort();
    response.once('close', cancel);
    try {
      const path = '/api/photos/' + encodeURIComponent(name);
      const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(300000)]);
      const result = await request(path, signal);
      if (!result.ok || !result.body) {
        await result.body?.cancel();
        return 404;
      }
      const filename = name.split('/').at(-1);
      const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) =>
        '%' + char.charCodeAt(0).toString(16).toUpperCase());
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
      const length = result.headers.get('content-length');
      if (length !== null) response.setHeader('Content-Length', length);
      await pipeline(Readable.fromWeb(result.body), response);
      return 200;
    } finally {
      response.off('close', cancel);
      downloads--;
    }
  }

  return { preview, download, json };
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
