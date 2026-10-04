'use strict';

const http = require('node:http');
const { handleCreate, handlePatch, handleGet } = require('./service');
const { DomainError } = require('./logic');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  const LIMIT = 5 * 1024 * 1024;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) {
      throw new DomainError('VALIDATION_ERROR', 'request body is too large (limit 5 MiB)', 413);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'request body is empty');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('VALIDATION_ERROR', 'request body is not valid JSON');
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/masks/events') {
        const body = await readJsonBody(req);
        const type = body && typeof body === 'object' && !Array.isArray(body) ? body.type : undefined;
        let result;
        if (type === 'create') {
          result = await handleCreate(body);
        } else if (type === 'patch') {
          result = await handlePatch(body);
        } else {
          throw new DomainError(
            'VALIDATION_ERROR',
            `unknown event type ${JSON.stringify(type)}; expected "create" or "patch"`
          );
        }
        sendJson(res, result.status, result.body);
        return;
      }

      const getMatch = url.pathname.match(/^\/api\/masks\/([^/]+)$/);
      if (req.method === 'GET' && getMatch) {
        const maskId = decodeURIComponent(getMatch[1]);
        const result = await handleGet(maskId);
        sendJson(res, result.status, result.body);
        return;
      }

      sendJson(res, 404, { error: 'NOT_FOUND', message: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof DomainError) {
        sendJson(res, err.statusCode, {
          error: err.code,
          message: err.message
        });
        return;
      }
      // eslint-disable-next-line no-console
      console.error('unhandled error:', err);
      sendJson(res, 500, { error: 'INTERNAL_ERROR', message: 'internal server error' });
    }
  });
}

function startServer(port = PORT) {
  const server = createServer();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`mask service listening on port ${server.address().port}`);
  });
  return server;
}

module.exports = { createServer, startServer };

if (require.main === module) {
  startServer();
}
