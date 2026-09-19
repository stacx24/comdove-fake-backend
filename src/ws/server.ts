// The /ws endpoint (plan §11, §11d): parses every frame with the contract parser,
// gives each socket a Session, and runs the heartbeat. A client that misses a pong
// is terminated, which closes its session and releases its group lock (FR-16).

import type { Server } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { parseClientEvent } from '../contract/ws-events.js';
import { createSession, type Session, type SessionDeps } from './session.js';

export const WS_PATH = '/ws';
export const MAX_FRAME_BYTES = 65536;
export const DEFAULT_HEARTBEAT_MS = 15000;

export interface WsServerDeps extends SessionDeps {
  heartbeatMs?: number;
}

export interface WsServer {
  /** Stop the heartbeat, drop every client, close the WebSocket server. */
  close(): Promise<void>;
  sessionCount(): number;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function attachWsServer(http: Server, deps: WsServerDeps): WsServer {
  const wss = new WebSocketServer({ server: http, path: WS_PATH, maxPayload: MAX_FRAME_BYTES });
  const clients = new Map<WebSocket, { session: Session; alive: boolean }>();

  wss.on('connection', (socket) => {
    const client = { session: createSession(socket, deps), alive: true };
    clients.set(socket, client);

    socket.on('pong', () => {
      client.alive = true;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        client.session.send({ type: 'error', code: 'bad_json', message: 'binary frames are not supported' });
        return;
      }
      const parsed = parseClientEvent(toBuffer(data));
      if (!parsed.ok) {
        client.session.send({ type: 'error', ...parsed.error });
        return;
      }
      try {
        client.session.handle(parsed.event);
      } catch (err) {
        console.error('[ws] handler error', err);
        client.session.send({ type: 'error', code: 'bad_request', message: 'internal error' });
      }
    });

    socket.on('close', () => {
      client.session.close();
      clients.delete(socket);
    });

    // ws emits 'close' after 'error'; listening here stops an error from crashing the process.
    socket.on('error', () => client.session.close());
  });

  const heartbeat = setInterval(() => {
    for (const [socket, client] of clients) {
      if (!client.alive) {
        socket.terminate(); // fires 'close' → session.close() → lock released
        continue;
      }
      client.alive = false;
      socket.ping();
    }
  }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      for (const socket of clients.keys()) socket.terminate();
      return new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
    },
    sessionCount: () => clients.size,
  };
}
