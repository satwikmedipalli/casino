import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/types';
import { GameError, Room } from './table';

const PORT = Number(process.env.PORT ?? 3001);
const rooms = new Map<string, Room>();
const sockets = new Map<WebSocket, { code: string; playerId: string }>();

const app = express();
const dist = path.resolve(process.cwd(), 'dist');
app.use(express.static(dist));
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room: Room) {
  for (const [ws, s] of sockets) {
    if (s.code !== room.code) continue;
    if (room.player(s.playerId)) send(ws, { t: 'state', state: room.view(s.playerId) });
    else { send(ws, { t: 'left' }); sockets.delete(ws); }
  }
}

function newCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code: string;
  do code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  while (rooms.has(code));
  return code;
}

function attach(ws: WebSocket, room: Room, playerId: string) {
  // One socket per player: drop any older connection for the same seat.
  for (const [other, s] of sockets) if (other !== ws && s.playerId === playerId) { sockets.delete(other); other.close(); }
  sockets.set(ws, { code: room.code, playerId });
  room.setConnected(playerId, true);
}

function handle(ws: WebSocket, msg: ClientMsg) {
  if (msg.t === 'create') {
    const startingChips = Math.max(1, Math.min(1_000_000, Math.floor(msg.startingChips)));
    const bb = Math.max(2, Math.min(startingChips, Math.floor(msg.bb)));
    const code = newCode();
    const room: Room = new Room(code, startingChips, bb, () => broadcast(room));
    rooms.set(code, room);
    const p = room.addPlayer(msg.name);
    attach(ws, room, p.id);
    send(ws, { t: 'joined', code, token: p.token });
    broadcast(room);
    return;
  }
  if (msg.t === 'join') {
    const room = rooms.get(String(msg.code).toUpperCase());
    if (!room) return send(ws, { t: 'error', message: 'Table not found', fatal: true });
    const existing = msg.token ? room.byToken(msg.token) : undefined;
    const p = existing ?? room.addPlayer(msg.name);
    attach(ws, room, p.id);
    send(ws, { t: 'joined', code: room.code, token: p.token });
    broadcast(room);
    return;
  }

  const s = sockets.get(ws);
  const room = s && rooms.get(s.code);
  if (!s || !room) return send(ws, { t: 'error', message: 'Not at a table', fatal: true });
  switch (msg.t) {
    case 'start': room.start(s.playerId); break;
    case 'choose': room.choose(s.playerId, msg.game, msg.target, msg.farthest); break;
    case 'act': room.act(s.playerId, msg.action, msg.amount); break;
    case 'discard': room.discard(s.playerId, msg.cards); break;
    case 'arrange': room.arrange(s.playerId, msg.cards); break;
    case 'rebuy': room.rebuy(s.playerId); break;
    case 'leave':
      room.leave(s.playerId);
      sockets.delete(ws);
      send(ws, { t: 'left' });
      break;
  }
  broadcast(room);
}

wss.on('connection', ws => {
  ws.on('message', data => {
    let msg: ClientMsg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    try { handle(ws, msg); }
    catch (e) {
      if (e instanceof GameError) send(ws, { t: 'error', message: e.message });
      else { console.error(e); send(ws, { t: 'error', message: 'Something went wrong' }); }
    }
  });
  ws.on('close', () => {
    const s = sockets.get(ws);
    sockets.delete(ws);
    const room = s && rooms.get(s.code);
    if (!s || !room) return;
    if (![...sockets.values()].some(o => o.playerId === s.playerId)) room.setConnected(s.playerId, false);
    broadcast(room);
  });
});

// Forget tables nobody has been connected to for an hour.
const lastSeen = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.some(p => p.connected) || !lastSeen.has(code)) lastSeen.set(code, now);
    else if (now - lastSeen.get(code)! > 60 * 60_000) { room.dispose(); rooms.delete(code); lastSeen.delete(code); }
  }
}, 60_000);

server.listen(PORT, () => console.log(`Poker server on http://localhost:${PORT}`));
