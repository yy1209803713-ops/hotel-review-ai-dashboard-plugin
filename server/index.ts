import http from 'node:http';
import { handleWarmupRequest } from './warmupHandler';

const port = Number(process.env.WARMUP_PORT || 8787);
const warmupSecret = process.env.WARMUP_SECRET || 'local-warmup-secret';

const server = http.createServer((incoming, outgoing) => {
  handleNodeRequest(incoming)
    .then((request) => handleWarmupRequest(request, { warmupSecret }))
    .then((response) => writeNodeResponse(outgoing, response))
    .catch((cause) => {
      console.error('__HOTEL_REVIEW_AI_WARMUP_SERVER_ERROR__', cause);
      outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'internal server error' }));
    });
});

server.listen(port, '127.0.0.1', () => {
  console.info('__HOTEL_REVIEW_AI_WARMUP_SERVER_READY__', JSON.stringify({
    url: `http://127.0.0.1:${port}/api/hotel-review-ai/warmup`,
  }));
});

async function handleNodeRequest(incoming: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = `http://${incoming.headers.host || `127.0.0.1:${port}`}${incoming.url || '/'}`;
  return new Request(url, {
    method: incoming.method,
    headers: incoming.headers as HeadersInit,
    body,
  });
}

async function writeNodeResponse(outgoing: http.ServerResponse, response: Response): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}
