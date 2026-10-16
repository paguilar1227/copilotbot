import WebSocket from 'ws';
import type { LiveSocket } from '../live-call-controller.ts';

export type AzureSocketFactory = (url: string, headers: Record<string, string>) => LiveSocket;

/** Azure's upgrade response is supported by ws across Node and Electron runtimes. */
export const openAzureSocket: AzureSocketFactory = (url, headers) => {
  const socket = new WebSocket(url, { headers });
  // ws emits an error when CONNECTING is cancelled, including after the
  // controller clears onerror. Keep it handled without replacing that callback.
  socket.on('error', () => {});
  return socket as unknown as LiveSocket;
};
