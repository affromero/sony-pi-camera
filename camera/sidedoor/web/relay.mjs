import { chmod } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createRelay(socketPath) {
  return createServer({ headersTimeout: 5000, requestTimeout: 10000 }, (incoming, outgoing) => {
    const headers = {};
    for (const name of ['host', 'origin', 'sec-fetch-site', 'cookie', 'content-type', 'content-length', 'x-forwarded-proto']) {
      if (incoming.headers[name] !== undefined) headers[name] = incoming.headers[name];
    }
    const broker = request({ socketPath, method: incoming.method, path: incoming.url, headers }, (reply) => {
      const forwarded = { ...reply.headers };
      delete forwarded.connection;
      delete forwarded['transfer-encoding'];
      outgoing.writeHead(reply.statusCode, forwarded);
      reply.on('error', () => outgoing.destroy());
      reply.pipe(outgoing);
    });
    broker.on('error', () => {
      if (outgoing.headersSent) return outgoing.destroy();
      outgoing.writeHead(503, { 'Cache-Control': 'no-store' }).end('Camera unavailable.');
    });
    outgoing.on('close', () => broker.destroy());
    incoming.on('error', () => broker.destroy());
    incoming.pipe(broker);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const socket = join(process.env.RUNTIME_DIRECTORY, 'viewer.sock');
  const relay = createRelay(process.argv[2]);
  relay.listen(socket, async () => { await chmod(socket, 0o666); });
}
