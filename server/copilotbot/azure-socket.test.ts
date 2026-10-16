import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { openAzureSocket } from './azure-socket.ts';

it('can cancel a connecting socket after the controller detaches its callbacks', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const client = openAzureSocket(`ws://127.0.0.1:${port}/pending`, {});
  client.onerror = () => {};
  client.onerror = null;
  const closed = new Promise<void>(resolve => { client.onclose = () => resolve(); });
  client.close();
  await closed;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

it('authenticates an Azure sideband and forwards native events and graceful close', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  let authorization: string | undefined;
  let command: string | undefined;
  server.once('connection', (socket, request) => {
    authorization = request.headers.authorization;
    socket.send(JSON.stringify({ type: 'session.started' }));
    socket.once('message', message => {
      command = String(message);
      socket.send(JSON.stringify({ type: 'session.closed' }));
      socket.close();
    });
  });
  const client = openAzureSocket(`ws://127.0.0.1:${port}/live/sessions/test/attach`, { authorization: 'Bearer local-fixture' });
  const events: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      client.onerror = () => reject(new Error('Local sideband connection failed'));
      client.onmessage = event => {
        const type = JSON.parse(String(event.data)).type;
        events.push(type);
        if (type === 'session.started') client.send(JSON.stringify({ type: 'session.close' }));
      };
      client.onclose = () => resolve();
    });
    expect(authorization).toBe('Bearer local-fixture');
    expect(command).toBe('{"type":"session.close"}');
    expect(events).toEqual(['session.started', 'session.closed']);
  } finally {
    client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
