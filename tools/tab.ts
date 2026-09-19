// npm run tab -- <group> [ws-url]
// A terminal stand-in for one browser tab: claims <group> on /ws, prints every frame the
// server pushes, and sends each line you type (a JSON frame) to the server.
//
//   npm run tab -- alpha
//   {"type":"chat.read","number":"919876543210","peer":"918888800001"}
//   {"type":"message.send","from":"919876543210","to":"918888800001","body":"hi"}
//   {"type":"tile.presence","number":"919876543211","online":false}
// Ctrl+C closes the tab (the group lock is released).
import readline from 'node:readline';
import { WebSocket } from 'ws';

const group = process.argv[2] ?? 'alpha';
const url = process.argv[3] ?? `ws://localhost:${process.env.PORT ?? 4020}/ws`;
const socket = new WebSocket(url);
const time = () => new Date().toISOString().slice(11, 23);

function show(f: Record<string, any>): string {
  switch (f.type) {
    case 'group.claimed':
      return `group.claimed ${f.group.id}: ${f.tiles.map((t: any) => `${t.number}(${t.online ? 'on' : 'off'}, ${t.history.length} msgs, ${t.queued.length} queued)`).join('  ')}`;
    case 'message.new':
      return `message.new   ${f.number} ${f.message.direction === 'outbound' ? '⬅' : '➡'} ${JSON.stringify(f.message.body)}  ${f.message.wamid}`;
    case 'message.status':
      return `message.status ${f.number} ${f.status.padEnd(9)} ${f.wamid}`;
    case 'queue.flush':
      return `queue.flush   ${f.number}: ${f.messages.length} message(s)`;
    default:
      return JSON.stringify(f);
  }
}

socket.on('open', () => {
  console.log(`[tab] connected to ${url}, claiming "${group}" — type JSON frames, Ctrl+C to close`);
  socket.send(JSON.stringify({ type: 'group.claim', group }));
});
socket.on('message', (data) => console.log(`[tab] ${time()} ${show(JSON.parse(String(data)))}`));
socket.on('close', () => {
  console.log('[tab] closed');
  process.exit(0);
});
socket.on('error', (err) => {
  console.error(`[tab] ${err.message}`);
  process.exit(1);
});

// Lines typed before the socket opens (or piped in) wait until it is open.
const early: string[] = [];
socket.on('open', () => early.splice(0).forEach((t) => socket.send(t)));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  try {
    JSON.parse(text);
  } catch {
    console.log('[tab] not JSON — type a frame like {"type":"chat.read","number":"…","peer":"…"}');
    return;
  }
  if (socket.readyState === WebSocket.OPEN) socket.send(text);
  else early.push(text);
});
process.on('SIGINT', () => socket.close());
