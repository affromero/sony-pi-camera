import { setTimeout as delay } from 'node:timers/promises';

export async function sendPreviewStream(response, camera, authorize) {
  const stream = new AbortController();
  const close = () => stream.abort();
  response.once('close', close);
  let previous;
  let checkAt = performance.now() + 1000;
  let expiresAt = performance.now() + 10000;
  try {
    while (!stream.signal.aborted && performance.now() < expiresAt) {
      const frame = response.writableNeedDrain ? null : await Promise.race([
        camera.preview(true),
        delay(Math.max(0, Math.min(checkAt, expiresAt) - performance.now()), null,
          { signal: stream.signal }),
      ]);
      if (stream.signal.aborted) return true;
      if (performance.now() >= checkAt) {
        await authorize();
        checkAt = performance.now() + 1000;
      }
      if (stream.signal.aborted) return true;
      if (performance.now() >= expiresAt) break;
      if (frame && frame !== previous) {
        if (!previous) response.writeHead(200, {
          'Content-Type': 'multipart/x-mixed-replace; boundary=sony-preview',
          'X-Accel-Buffering': 'no',
        });
        response.write(`--sony-preview\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
        response.write(frame);
        response.write('\r\n');
        previous = frame;
        expiresAt = performance.now() + 15000;
      }
      await delay(100, undefined, { signal: stream.signal });
    }
    if (!previous && !stream.signal.aborted) return false;
    if (!stream.signal.aborted) response.destroy();
    return true;
  } catch (error) {
    if (!stream.signal.aborted) throw error;
    return true;
  } finally {
    response.off('close', close);
  }
}
