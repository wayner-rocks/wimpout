'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };


// ---------- persistent win tracking (by player name) ----------
// Default: a JSON file in ./data (or DATA_DIR). Optional durable storage: set
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to keep scores in a free Upstash Redis database.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SCORE_FILE = path.join(DATA_DIR, 'scores.json');
const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
let scores = {};
async function upstash(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN }, body: JSON.stringify(cmd) });
  return r.json();
}
async function loadScores() {
  try {
    if (UP_URL && UP_TOKEN) { const j = await upstash(['GET', 'cw:scores']); if (j.result) scores = JSON.parse(j.result); }
    else if (fs.existsSync(SCORE_FILE)) scores = JSON.parse(fs.readFileSync(SCORE_FILE, 'utf8'));
  } catch (e) { console.error('Could not load scores:', e.message); }
}
let saving = false, dirty = false;
async function saveScores() {
  if (saving) { dirty = true; return; }
  saving = true;
  try {
    const data = JSON.stringify(scores);
    if (UP_URL && UP_TOKEN) await upstash(['SET', 'cw:scores', data]);
    else { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SCORE_FILE + '.tmp', data); fs.renameSync(SCORE_FILE + '.tmp', SCORE_FILE); }
  } catch (e) { console.error('Could not save scores:', e.message); }
  saving = false;
  if (dirty) { dirty = false; saveScores(); }
}
function recordResult(room, winnerId) {
  const now = Date.now();
  for (const p of room.players) {
    const k = p.name.toLowerCase();
    const e = scores[k] || (scores[k] = { name: p.name, wins: 0, games: 0, last: 0 });
    e.name = p.name; e.games++; e.last = now;
    if (p.id === winnerId) e.wins++;
  }
  saveScores();
}
function leaderboard() {
  return Object.values(scores)
    .map((e) => ({ name: e.name, wins: e.wins, games: e.games, pct: e.games ? Math.round((100 * e.wins) / e.games) : 0, last: e.last }))
    .sort((a, b) => b.wins - a.wins || b.pct - a.pct || a.games - b.games || a.name.localeCompare(b.name))
    .slice(0, 50);
}

const rooms = new Map();
const rid = () => crypto.randomBytes(8).toString('hex');
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}
const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Player';

function log(room, text, kind) {
  room.log.push(text);
  if (room.log.length > 60) room.log.shift();
  room.event = { seq: (room.event ? room.event.seq : 0) + 1, text, kind: kind || 'info' };
}

// House rule: you can't stop on the same score as another player; you must keep rolling.
function bankBlocker(room) {
  const t = room.turn, cur = room.players[room.cur];
  if (!room.noShare || !t || !cur) return null;
  const ns = cur.score + t.pts;
  return room.players.find((p) => p.id !== cur.id && !p.out && p.score === ns && ns > 0) || null;
}

function stateFor(room, pid) {
  const t = room.turn;
  const cur = room.players[room.cur];
  return {
    code: room.code, status: room.status, goal: room.goal, noShare: room.noShare, hostId: room.hostId, you: pid,
    cur: cur ? cur.id : null,
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score, opened: p.opened, out: p.out, connected: p.conns.size > 0 })),
    turn: t ? {
      pts: t.pts, dice: t.dice, avail: t.avail, pending: t.pending, mustAll: t.mustAll, rolled: t.rolled,
      canRerollSun: t.canRerollSun, canBank: cur ? G.canBank(t, cur.opened) && !bankBlocker(room) : false, blockedBy: cur && G.canBank(t, cur.opened) && bankBlocker(room) ? bankBlocker(room).name : null, over: t.over,
      outcome: t.outcome, lastRoll: t.lastRoll, rollNo: t.rollNo, note: t.note
    } : null,
    lastLicks: room.lastLicks ? { leader: room.lastLicks.leader, left: [...room.lastLicks.left] } : null,
    winner: room.winner, log: room.log.slice(-25), event: room.event, openMin: G.OPEN_MIN
  };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const p of room.players) {
    const msg = JSON.stringify({ type: 'state', state: stateFor(room, p.id) });
    for (const ws of p.conns) if (ws.readyState === 1) ws.send(msg);
  }
}

function startTurn(room) {
  room.turn = G.newTurn();
  const p = room.players[room.cur];
  log(room, p.name + "'s turn" + (p.opened ? '' : ' (needs ' + G.OPEN_MIN + '+ to get in)'));
}

function finish(room, winnerId, reason) {
  if (room.status === 'ended') return;
  room.status = 'ended';
  if (room.players.length > 1) recordResult(room, winnerId);
  room.winner = winnerId;
  room.turn = null;
  const w = room.players.find((p) => p.id === winnerId);
  log(room, (w ? w.name : 'Nobody') + ' wins! ' + (reason || ''), 'win');
}

function nextPlayer(room) {
  const alive = room.players.filter((p) => !p.out);
  if (alive.length === 1 && room.players.length > 1) return finish(room, alive[0].id, '(last player standing)');
  if (alive.length === 0) return finish(room, null, 'Everyone went supernova!');
  if (room.lastLicks && room.lastLicks.left.size === 0) {
    const top = alive.slice().sort((a, b) => b.score - a.score)[0];
    return finish(room, top.id, 'Final score ' + top.score + '.');
  }
  for (let k = 1; k <= room.players.length; k++) {
    const i = (room.cur + k) % room.players.length;
    const p = room.players[i];
    if (p.out) continue;
    if (room.lastLicks && !room.lastLicks.left.has(p.id)) continue;
    room.cur = i;
    return startTurn(room);
  }
  const top = alive.slice().sort((a, b) => b.score - a.score)[0];
  finish(room, top.id, 'Final score ' + top.score + '.');
}

function endTurn(room) {
  if (room.status !== 'playing') return;
  const p = room.players[room.cur];
  if (room.lastLicks) room.lastLicks.left.delete(p.id);
  nextPlayer(room);
  broadcast(room);
}

function afterRoll(room) {
  const t = room.turn;
  const p = room.players[room.cur];
  if (!t.over) return;
  if (t.outcome === 'win') {
    log(room, p.name + ' rolled FIVE STARS - instant winner!', 'win');
    return finish(room, p.id, '');
  }
  if (t.outcome === 'supernova') { p.out = true; log(room, p.name + ' rolled five tens: SUPERNOVA! Out of the game.', 'bad'); }
  else if (t.outcome === 'trainwreck') log(room, p.name + ' - TRAIN WRECK! Lost the turn.', 'bad');
  else log(room, p.name + ' wimped out!', 'bad');
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endTurn(room), 3200);
}

function handle(ws, msg) {
  const ctx = ws.ctx;
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const err = (m) => send({ type: 'error', message: m });

  if (msg.type === 'create') {
    const room = { code: newCode(), players: [], hostId: null, status: 'lobby', goal: msg.goal === 300 ? 300 : 500, noShare: true, cur: 0, turn: null, lastLicks: null, winner: null, log: [], event: null, timer: null, touched: Date.now() };
    rooms.set(room.code, room);
    return join(ws, room, cleanName(msg.name));
  }
  if (msg.type === 'join') {
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return err('Room not found. Check the code.');
    if (room.status !== 'lobby') return err('That game already started.');
    if (room.players.length >= 8) return err('Room is full (8 players).');
    return join(ws, room, cleanName(msg.name));
  }
  if (msg.type === 'resume') {
    const room = rooms.get(String(msg.code || '').toUpperCase());
    const p = room && room.players.find((x) => x.token === msg.token);
    if (!p) return send({ type: 'left' });
    attach(ws, room, p);
    return broadcast(room);
  }
  if (!ctx) return err('Not in a room.');
  const { room, player } = ctx;

  if (msg.type === 'leave') {
    detach(ws);
    leave(room, player);
    send({ type: 'left' });
    return broadcast(room);
  }
  if (msg.type === 'goal' && room.status === 'lobby' && player.id === room.hostId) {
    room.goal = msg.goal === 300 ? 300 : 500;
    return broadcast(room);
  }
  if (msg.type === 'rule' && room.status === 'lobby' && player.id === room.hostId) {
    room.noShare = !!msg.noShare;
    return broadcast(room);
  }
  if (msg.type === 'start') {
    if (player.id !== room.hostId) return err('Only the host can start.');
    if (room.status !== 'lobby') return;
    if (room.players.length < 2) return err('Need at least 2 players.');
    room.status = 'playing';
    room.cur = crypto.randomInt(room.players.length);
    log(room, 'Game on! First to ' + room.goal + ' (then everyone gets last licks).');
    startTurn(room);
    return broadcast(room);
  }
  if (msg.type === 'again' && room.status === 'ended' && player.id === room.hostId) {
    room.players.forEach((p) => { p.score = 0; p.opened = false; p.out = false; });
    room.status = 'lobby'; room.winner = null; room.lastLicks = null; room.turn = null; room.log = [];
    return broadcast(room);
  }

  if (room.status !== 'playing') return;
  const cur = room.players[room.cur];
  const t = room.turn;

  if (msg.type === 'skip') {
    if (player.id !== room.hostId) return err('Only the host can skip a turn.');
    clearTimeout(room.timer);
    log(room, 'Host skipped ' + cur.name + "'s turn.");
    return endTurn(room);
  }
  if (cur.id !== player.id) return err("It's not your turn.");
  if (t.over) return;

  if (msg.type === 'roll') {
    G.rollTurn(t, { rerollSun: !!msg.rerollSun });
    if (!t.over) log(room, cur.name + ' rolled' + (t.note ? ': ' + t.note : '') + ' (turn: ' + t.pts + ')');
    afterRoll(room);
    return broadcast(room);
  }
  if (msg.type === 'bank') {
    if (!G.canBank(t, cur.opened)) return err("You can't stop yet.");
    const bl = bankBlocker(room);
    if (bl) return err("You can't land on " + bl.name + "'s space (" + bl.score + "). Roll again!");
    cur.score += t.pts;
    cur.opened = true;
    log(room, cur.name + ' banked ' + t.pts + ' -> ' + cur.score, 'good');
    if (cur.score >= room.goal && !room.lastLicks) {
      room.lastLicks = { leader: cur.id, left: new Set(room.players.filter((p) => !p.out && p.id !== cur.id).map((p) => p.id)) };
      log(room, cur.name + ' hit ' + room.goal + '! LAST LICKS - everyone else gets one more turn.', 'win');
    }
    return endTurn(room);
  }
}

function attach(ws, room, player) {
  ws.ctx = { room, player };
  player.conns.add(ws);
  ws.send(JSON.stringify({ type: 'joined', code: room.code, id: player.id, token: player.token }));
}
function detach(ws) {
  if (ws.ctx) { ws.ctx.player.conns.delete(ws); ws.ctx = null; }
}
function join(ws, room, name) {
  const player = { id: rid(), token: rid(), name, score: 0, opened: false, out: false, conns: new Set() };
  if (room.players.some((p) => p.name === name)) player.name = name + ' ' + (room.players.length + 1);
  room.players.push(player);
  if (!room.hostId) room.hostId = player.id;
  attach(ws, room, player);
  log(room, player.name + ' joined.');
  broadcast(room);
}
function leave(room, player) {
  const idx = room.players.indexOf(player);
  if (idx < 0) return;
  if (room.status === 'lobby') {
    room.players.splice(idx, 1);
  } else {
    player.out = true;
    log(room, player.name + ' left the game.');
    if (room.status === 'playing' && room.players[room.cur] === player) { clearTimeout(room.timer); endTurn(room); }
  }
  if (room.hostId === player.id) {
    const nh = room.players.find((p) => !p.out);
    room.hostId = nh ? nh.id : null;
  }
  if (room.players.every((p) => p.out) || room.players.length === 0) { clearTimeout(room.timer); rooms.delete(room.code); }
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url === '/api/scores') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(leaderboard())); }
  let file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handle(ws, msg); } catch (e) { console.error(e); ws.send(JSON.stringify({ type: 'error', message: 'Server error' })); }
  });
  ws.on('close', () => {
    const ctx = ws.ctx;
    detach(ws);
    if (ctx) broadcast(ctx.room);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.touched > 6 * 3600 * 1000) { clearTimeout(room.timer); rooms.delete(code); }
}, 30000);

if (require.main === module) loadScores().then(() => server.listen(PORT, () => console.log('Cosmic Wimpout running on port ' + PORT + (UP_URL ? ' (scores in Upstash)' : ' (scores in ' + SCORE_FILE + ')'))));
module.exports = { server, rooms, loadScores, leaderboard, recordForTest: recordResult, bankBlocker };
