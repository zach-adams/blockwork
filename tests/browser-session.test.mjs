import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';

import { connect } from '../tools/browser-session.mjs';

test('a stalled WebSocket handshake times out', async () => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const started = Date.now();
    await assert.rejects(connect(`ws://127.0.0.1:${server.address().port}/`, 200), /handshake/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
