// A browser-like WebSocket client for e2e tests: collects every frame and lets a test
// wait for the next frame of a given type.
import { once } from 'node:events';
import { WebSocket } from 'ws';

export type Frame = { type: string } & Record<string, any>;

export async function wsClient(url: string) {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  const listeners = new Set<() => void>();
  socket.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as Frame);
    for (const l of listeners) l();
  });
  await once(socket, 'open');
  let cursor = 0;

  /** Resolve with the next unread frame matching `type` (and `where`), skipping others. */
  function next(type: string, where: (f: Frame) => boolean = () => true, timeoutMs = 3000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const check = () => {
        for (let i = cursor; i < frames.length; i++) {
          if (frames[i].type === type && where(frames[i])) {
            cursor = i + 1;
            listeners.delete(check);
            clearTimeout(timer);
            resolve(frames[i]);
            return;
          }
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`no ${type} frame within ${timeoutMs}ms; got ${JSON.stringify(frames.slice(cursor).map((f) => f.type))}`));
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  }

  return {
    socket,
    frames,
    next,
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    /** Frames of `type` received so far (read or not). */
    all: (type: string) => frames.filter((f) => f.type === type),
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, 'close');
      socket.close();
      await closed;
    },
  };
}

export type WsClient = Awaited<ReturnType<typeof wsClient>>;

/** Open a browser on `group` and wait for its snapshot. */
export async function openGroup(url: string, group: string) {
  const c = await wsClient(url);
  c.send({ type: 'group.claim', group });
  const snapshot = await c.next('group.claimed');
  return { ...c, snapshot };
}
