import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const port = parentPort!;
let serial = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const callHost = (method: string, input: unknown) => new Promise((resolve, reject) => {
  const id = ++serial; pending.set(id, { resolve, reject }); port.postMessage({ type: 'host', id, method, input });
});
let plugin: { commands?: Record<string, (input: unknown) => unknown> };
port.on('message', async message => {
  if (message.type === 'host-result') {
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result);
  } else if (message.type === 'command') {
    try {
      const command = plugin.commands?.[message.command];
      if (!command) throw new Error('Plugin did not implement this command');
      port.postMessage({ type: 'result', id: message.id, result: await command(message.input) });
    } catch (error) { port.postMessage({ type: 'result', id: message.id, error: error instanceof Error ? error.message : 'Plugin command failed' }); }
  }
});

try {
  const module = await import(pathToFileURL(workerData.entry).href);
  plugin = await module.activate(Object.freeze({
    apiVersion: 1,
    storage: Object.freeze({ get: (key: string) => callHost('storage.get', { key }), set: (key: string, value: unknown) => callHost('storage.set', { key, value }) }),
    services: Object.freeze({ request: (service: string, path: string, options?: unknown) => callHost('services.request', { service, path, options }) }),
    settings: Object.freeze(workerData.settings),
  }));
  if (!plugin || typeof plugin !== 'object') throw new Error('activate must return a plugin object');
  for (const command of workerData.commands) if (typeof plugin.commands?.[command] !== 'function') throw new Error(`Missing command: ${command}`);
  port.postMessage({ type: 'ready' });
} catch (error) { port.postMessage({ type: 'failed', error: error instanceof Error ? error.message : 'Plugin could not start' }); }
