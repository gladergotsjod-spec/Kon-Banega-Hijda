const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// Prevent browsers from keeping an older game UI cached.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function playerId() { return crypto.randomBytes(8).toString('hex'); }
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { for (const p of room.players) send(p.ws, msg); }

function publicState(room, forPlayerId) {
  const current = room.players[room.turnIndex];
  const alive = room.players.filter(p => !p.eliminated);
  return {
    type: 'state',
    roomCode: room.code,
    phase: room.phase,
    hostId: room.hostId,
    currentTurnId: current ? current.id : null,
    currentTurnName: current ? current.name : null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      ready: p.number !== null,
      eliminated: p.eliminated,
      isYou: p.id === forPlayerId,
      secretNumber: p.id === forPlayerId ? p.number : null
    })),
    cancelledNumbers: [...room.cancelledNumbers],
    aliveCount: alive.length,
    winnerId: room.winnerId || null,
    winnerName: room.winnerName || null,
    log: room.log.slice(-14)
  };
}

function sendState(room) {
  for (const p of room.players) send(p.ws, publicState(room, p.id));
}

function addLog(room, text) {
  room.log.push(text);
  if (room.log.length > 30) room.log.shift();
}

function nextAliveIndex(room, fromIndex) {
  if (!room.players.length) return -1;
  for (let step = 1; step <= room.players.length; step++) {
    const idx = (fromIndex + step) % room.players.length;
    if (!room.players[idx].eliminated) return idx;
  }
  return -1;
}

function startGame(room) {
  if (room.players.length < MIN_PLAYERS) return { ok: false, error: `Need at least ${MIN_PLAYERS} players.` };
  if (room.players.some(p => p.number === null)) return { ok: false, error: 'Everyone must choose a number first.' };
  room.phase = 'playing';
  room.turnIndex = Math.floor(Math.random() * room.players.length);
  room.winnerId = null;
  room.winnerName = null;
  room.cancelledNumbers.clear();
  room.log = [];
  addLog(room, 'Game started. Duplicate secret numbers are allowed.');
  addLog(room, `${room.players[room.turnIndex].name} goes first.`);
  sendState(room);
  return { ok: true };
}

function makeRoom(name) {
  const code = roomCode();
  const id = playerId();
  const room = {
    code,
    hostId: id,
    phase: 'lobby',
    turnIndex: 0,
    winnerId: null,
    winnerName: null,
    log: [],
    cancelledNumbers: new Set(),
    players: []
  };
  const p = { id, name, number: null, eliminated: false, ws: null, disconnectedAt: null };
  room.players.push(p);
  rooms.set(code, room);
  return { room, player: p };
}

function joinRoom(room, name) {
  const id = playerId();
  const p = { id, name, number: null, eliminated: false, ws: null, disconnectedAt: null };
  room.players.push(p);
  return p;
}

wss.on('connection', ws => {
  let player = null;
  let room = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', error: 'Invalid message.' }); }

    if (msg.type === 'create') {
      if (player) return;
      const name = String(msg.name || '').trim().slice(0, 20);
      if (!name) return send(ws, { type: 'error', error: 'Enter your name.' });
      const made = makeRoom(name);
      room = made.room; player = made.player; player.ws = ws; player.disconnectedAt = null;
      addLog(room, `${player.name} created the room.`);
      sendState(room);
      return;
    }

    if (msg.type === 'join') {
      if (player) return;
      const code = String(msg.code || '').trim().toUpperCase();
      const name = String(msg.name || '').trim().slice(0, 20);
      if (!name) return send(ws, { type: 'error', error: 'Enter your name.' });
      room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', error: 'Room not found.' });
      if (room.phase !== 'lobby') return send(ws, { type: 'error', error: 'That game has already started.' });
      if (room.players.length >= MAX_PLAYERS) return send(ws, { type: 'error', error: 'Room is full.' });
      if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return send(ws, { type: 'error', error: 'That player name is already used in this room.' });
      player = joinRoom(room, name); player.ws = ws; player.disconnectedAt = null;
      addLog(room, `${player.name} joined the room.`);
      sendState(room);
      return;
    }

    if (!player || !room) return send(ws, { type: 'error', error: 'Join or create a room first.' });

    if (msg.type === 'heartbeat') return;

    if (msg.type === 'pick') {
      if (room.phase !== 'lobby') return send(ws, { type: 'error', error: 'Number selection is closed.' });
      const n = Number(msg.number);
      if (!Number.isInteger(n) || n < 1 || n > 100) return send(ws, { type: 'error', error: 'Choose a whole number from 1 to 100.' });
      // Duplicate secret numbers are intentionally allowed.
      player.number = n;
      sendState(room);
      return;
    }

    if (msg.type === 'start') {
      if (player.id !== room.hostId) return send(ws, { type: 'error', error: 'Only the host can start the game.' });
      const result = startGame(room);
      if (!result.ok) return send(ws, { type: 'error', error: result.error });
      return;
    }

    if (msg.type === 'cancel') {
      if (room.phase !== 'playing') return send(ws, { type: 'error', error: 'The game is not in progress.' });
      if (room.players[room.turnIndex]?.id !== player.id) return send(ws, { type: 'error', error: 'It is not your turn.' });
      const n = Number(msg.number);
      if (!Number.isInteger(n) || n < 1 || n > 100) return send(ws, { type: 'error', error: 'Choose a number from 1 to 100.' });
      if (n === player.number) return send(ws, { type: 'error', error: 'You cannot cancel your own number.' });
      if (room.cancelledNumbers.has(n)) return send(ws, { type: 'error', error: 'That number has already been cancelled.' });

      room.cancelledNumbers.add(n);

      const targets = room.players.filter(p => !p.eliminated && p.number === n);
      if (targets.length) {
        for (const target of targets) target.eliminated = true;
        const names = targets.map(target => target.name).join(' & ');
        addLog(room, `${player.name} cancelled ${n}. ${names} is/are OUT!`);
      } else {
        addLog(room, `${player.name} cancelled ${n}, but nobody had that number.`);
      }

      const alive = room.players.filter(p => !p.eliminated);
      if (alive.length === 1) {
        room.phase = 'finished';
        room.winnerId = alive[0].id;
        room.winnerName = alive[0].name;
        addLog(room, `🏆 ${alive[0].name} is the last player left — HIJDA!`);
        sendState(room);
        return;
      }

      const next = nextAliveIndex(room, room.turnIndex);
      room.turnIndex = next;
      sendState(room);
      return;
    }

    if (msg.type === 'reset') {
      if (player.id !== room.hostId) return send(ws, { type: 'error', error: 'Only the host can start a new round.' });
      for (const p of room.players) { p.number = null; p.eliminated = false; }
      room.phase = 'lobby'; room.turnIndex = 0; room.winnerId = null; room.winnerName = null; room.log = [];
      room.cancelledNumbers.clear();
      addLog(room, 'New round created. Pick your secret numbers.');
      sendState(room);
      return;
    }
  });

  ws.on('close', () => {
    if (!player || !room) return;
    player.ws = null;
    if (room.phase === 'lobby') {
      // Keep the room alive if the host temporarily backgrounds Safari/Chrome
      // while sharing the room code. The player can disconnect briefly without
      // destroying the room before friends have a chance to join.
      player.disconnectedAt = Date.now();
      sendState(room);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    // Remove abandoned rooms only after 30 minutes with no connected players.
    if (room.players.length && room.players.every(p => !p.ws && p.disconnectedAt && now - p.disconnectedAt > 30 * 60_000)) {
      rooms.delete(code);
    }
  }
}, 60_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Kon Banega Hijda running on http://0.0.0.0:${PORT}`);
});
