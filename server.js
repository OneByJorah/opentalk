'use strict';
/**
 * OpenTalk — anonymous public chat + code-joined private rooms.
 * No accounts, no database, nothing written to disk. Everything lives in RAM
 * and disappears when a room empties or the server restarts.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------------------
// Config (all via environment — see .env.example)
// ---------------------------------------------------------------------------
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const int = (k, d) => parseInt(env(k, String(d)), 10);
const bool = (k, d) => ['1', 'true', 'yes'].includes(String(env(k, d ? '1' : '0')).toLowerCase());

const CFG = {
  port: int('PORT', 8080),
  trustProxy: bool('TRUST_PROXY', false),
  allowedOrigins: env('ALLOWED_ORIGINS', '').split(',').map(s => s.trim()).filter(Boolean),
  maxConnPerIp: int('MAX_CONN_PER_IP', 5),
  maxRooms: int('MAX_ROOMS', 1000),
  maxPrivateRoomSize: int('MAX_PRIVATE_ROOM_SIZE', 50),
  maxLobbySize: int('MAX_LOBBY_SIZE', 500),
  lobbyHistory: bool('LOBBY_HISTORY', true),
  lobbyLinks: bool('LOBBY_LINKS', false),          // block URLs in the public lobby by default (anti-spam)
  enableLobby: bool('ENABLE_LOBBY', true),
  adminKey: env('ADMIN_KEY', ''),                   // long random string; enables /admin
  banHours: int('BAN_HOURS', 24),
  blockedWordsFile: env('BLOCKED_WORDS_FILE', path.join(__dirname, 'blocked-words.txt')),
  blockedWords: env('BLOCKED_WORDS', ''),
  // Branding & monetization (all optional)
  siteName: env('SITE_NAME', 'OpenTalk'),
  tagline: env('SITE_TAGLINE', 'Free & open. No sign-up, no login. Messages aren\'t saved.'),
  donateUrl: env('DONATE_URL', ''),                 // Ko-fi / Buy Me a Coffee / GitHub Sponsors / Stripe link
  donateLabel: env('DONATE_LABEL', '☕ Support this chat'),
  sponsorText: env('SPONSOR_TEXT', ''),             // self-hosted sponsor banner (no trackers)
  sponsorUrl: env('SPONSOR_URL', ''),
  adsenseClient: env('ADSENSE_CLIENT', ''),         // ca-pub-XXXXXXXXXXXXXXXX
  adsenseSlotHome: env('ADSENSE_SLOT_HOME', ''),
  adsenseSlotChat: env('ADSENSE_SLOT_CHAT', ''),
  githubUrl: env('GITHUB_URL', 'https://github.com/OneByJorah/opentalk'),
};

const MAX_MSG_LEN = 500;
const HISTORY_LEN = 50;
const LOBBY = 'lobby';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_LEN = 8;                                       // 32^8 ≈ 1.1 trillion combos
const VERSION = require('./package.json').version;

// ---------------------------------------------------------------------------
// Word filter
// ---------------------------------------------------------------------------
function loadBlockedWords() {
  let words = CFG.blockedWords.split(',');
  try {
    words = words.concat(fs.readFileSync(CFG.blockedWordsFile, 'utf8').split(/\r?\n/));
  } catch { /* file optional */ }
  words = [...new Set(words.map(w => w.trim().toLowerCase()).filter(w => w && !w.startsWith('#')))];
  if (!words.length) return null;
  const esc = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(${esc.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}
const BLOCKED_RE = loadBlockedWords();
const filterWords = (s) => (BLOCKED_RE ? s.replace(BLOCKED_RE, m => '*'.repeat(m.length)) : s);
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|gg|xyz|ru|cn|tk|ly|me|co|app|link|click|top)\b\S*/gi;

// ---------------------------------------------------------------------------
// HTTP: static whitelist + config + stats
// ---------------------------------------------------------------------------
const PUB = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const FILES = Object.fromEntries(
  [...new Set(Object.values(STATIC).map(v => v[0]))].map(f => [f, fs.readFileSync(path.join(PUB, f))])
);
// Inject site name into <title> server-side so link previews show your brand.
FILES['index.html'] = Buffer.from(
  FILES['index.html'].toString().replace(/__SITE_NAME__/g, CFG.siteName.replace(/[<>&"]/g, ''))
);

const ADS_ON = !!CFG.adsenseClient;
const ADS_SRC = 'https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://adservice.google.com https://*.gstatic.com';
function buildCsp(nonce) {
  return [
    "default-src 'self'",
    // With ads on we follow Google's recommended strict CSP: a per-request nonce + strict-dynamic,
    // so only our own app.js (and what it loads, i.e. adsbygoogle.js) can run.
    ADS_ON ? `script-src 'nonce-${nonce}' 'strict-dynamic' https:` : "script-src 'self'",
    `style-src 'self' https://fonts.googleapis.com${ADS_ON ? " 'unsafe-inline'" : ''}`,
    "font-src https://fonts.gstatic.com",
    `connect-src 'self'${ADS_ON ? ' ' + ADS_SRC : ''}`,
    `img-src 'self' data:${ADS_ON ? ' https:' : ''}`,
    ADS_ON ? `frame-src ${ADS_SRC}` : "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': ADS_ON ? 'strict-origin-when-cross-origin' : 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

const PUBLIC_CONFIG = JSON.stringify({
  siteName: CFG.siteName,
  tagline: CFG.tagline,
  enableLobby: CFG.enableLobby,
  donate: CFG.donateUrl ? { url: CFG.donateUrl, label: CFG.donateLabel } : null,
  sponsor: CFG.sponsorText ? { text: CFG.sponsorText, url: CFG.sponsorUrl } : null,
  ads: ADS_ON ? { client: CFG.adsenseClient, slotHome: CFG.adsenseSlotHome, slotChat: CFG.adsenseSlotChat } : null,
  github: CFG.githubUrl,
  version: VERSION,
});

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", ...SECURITY_HEADERS });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY_HEADERS); return res.end(); }
  if (url === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION });
  if (url === '/config.json') return sendJson(res, 200, PUBLIC_CONFIG);
  if (url === '/stats') return sendJson(res, 200, { lobby: rooms.get(LOBBY).clients.size, online: wss.clients.size });
  if (url === '/ads.txt' && ADS_ON) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`google.com, ${CFG.adsenseClient.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`);
  }
  if (url === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
  const entry = STATIC[url];
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS }); return res.end('Not found'); }
  const nonce = crypto.randomBytes(16).toString('base64');
  let body = FILES[entry[0]];
  if (entry[0] === 'index.html') body = body.toString().replace('<script src="/app.js">', `<script nonce="${nonce}" src="/app.js">`);
  res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache', 'Content-Security-Policy': buildCsp(nonce), ...SECURITY_HEADERS });
  res.end(req.method === 'HEAD' ? undefined : body);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clientIp(req) {
  if (CFG.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
// We never log raw IPs — only a salted hash that changes on every restart.
const IP_SALT = crypto.randomBytes(16);
const ipTag = (ip) => crypto.createHmac('sha256', IP_SALT).update(ip).digest('hex').slice(0, 10);

function newCode() {
  let code;
  do {
    const bytes = crypto.randomBytes(CODE_LEN);
    code = Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); // 256 % 32 == 0 → unbiased
  } while (rooms.has(code));
  return code;
}

const CTRL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g;
function cleanText(s) {
  if (typeof s !== 'string') return '';
  return s.replace(CTRL, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_MSG_LEN);
}
function cleanNick(s) {
  if (typeof s !== 'string') return null;
  const n = s.replace(CTRL, '').replace(/\s+/g, ' ').trim();
  if (!/^[\p{L}\p{N}_ .\-]{2,20}$/u.test(n)) return null;
  if (BLOCKED_RE && filterWords(n) !== n) return null;
  if (/^(admin|mod|moderator|system|server|owner)$/i.test(n)) return null;
  return n;
}
const normCode = (s) => (typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** rooms: code -> { private, clients:Set<ws>, history:[], owner:ws|null, locked, kicked:Set<ip> } */
const rooms = new Map();
const makeRoom = (isPrivate) => ({ private: isPrivate, clients: new Set(), history: [], owner: null, locked: false, kicked: new Set() });
rooms.set(LOBBY, makeRoom(false));
const connsPerIp = new Map();
const failedAttempts = new Map(); // ip -> { count, resetAt }
const bans = new Map();           // ip -> expiresAt

const isBanned = (ip) => { const t = bans.get(ip); if (!t) return false; if (t < Date.now()) { bans.delete(ip); return false; } return true; };

function userList(room) {
  return [...room.clients].map(c => ({ nick: c.nick, owner: room.owner === c, admin: !!c.isAdmin }));
}
function broadcast(room, obj, except) {
  const data = JSON.stringify(obj);
  for (const c of room.clients) if (c !== except && c.readyState === 1) c.send(data);
}
function sys(room, text) {
  const item = { t: 'sys', text, ts: Date.now() };
  broadcast(room, item);
}
function pushHistory(room, item) {
  if (room === rooms.get(LOBBY) && !CFG.lobbyHistory) return;
  room.history.push(item);
  if (room.history.length > HISTORY_LEN) room.history.shift();
}
function findInRoom(room, nick) {
  const n = String(nick || '').trim().toLowerCase();
  return [...room.clients].find(c => c.nick.toLowerCase() === n);
}

function leaveRoom(ws, quiet) {
  if (!ws.roomCode) return;
  const code = ws.roomCode;
  const room = rooms.get(code);
  ws.roomCode = null;
  if (!room) return;
  room.clients.delete(ws);
  if (room.private && room.clients.size === 0) { rooms.delete(code); return; } // private rooms vanish when empty
  if (room.owner === ws) {
    room.owner = room.clients.values().next().value || null; // hand ownership to the next person
    if (room.owner) sys(room, `${room.owner.nick} is now the room owner`);
  }
  if (!quiet) sys(room, `${ws.nick} left`);
  broadcast(room, { t: 'users', users: userList(room) });
}

function uniqueNick(room, nick) {
  const taken = new Set([...room.clients].map(c => c.nick.toLowerCase()));
  if (!taken.has(nick.toLowerCase())) return nick;
  for (let i = 2; i < 1000; i++) {
    const cand = `${nick.slice(0, 16)}-${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return `${nick.slice(0, 12)}-${crypto.randomInt(1e6)}`;
}

function joinRoom(ws, code, nick) {
  const room = rooms.get(code);
  const cap = room.private ? CFG.maxPrivateRoomSize : CFG.maxLobbySize;
  if (room.clients.size >= cap) return send(ws, { t: 'error', text: 'Room is full.' });
  if (room.locked && !ws.isAdmin) return send(ws, { t: 'error', text: 'This room is locked by its owner.' });
  if (room.kicked.has(ws.ip) && !ws.isAdmin) return send(ws, { t: 'error', text: 'You were removed from this room.' });
  leaveRoom(ws);
  ws.nick = uniqueNick(room, nick);
  ws.roomCode = code;
  room.clients.add(ws);
  if (room.private && !room.owner) room.owner = ws;
  send(ws, {
    t: 'joined', room: code, private: room.private, nick: ws.nick, owner: room.owner === ws,
    admin: !!ws.isAdmin, locked: room.locked, linksAllowed: room.private || CFG.lobbyLinks,
    users: userList(room), history: room.history,
  });
  broadcast(room, { t: 'sys', text: `${ws.nick} joined`, ts: Date.now() }, ws);
  broadcast(room, { t: 'users', users: userList(room) }, ws);
}

function tooManyFailures(ip) {
  const f = failedAttempts.get(ip);
  return f && f.resetAt > Date.now() && f.count >= 10;
}
function recordFailure(ip) {
  const now = Date.now();
  const f = failedAttempts.get(ip);
  if (!f || f.resetAt <= now) failedAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
  else f.count++;
}
setInterval(() => {
  const n = Date.now();
  for (const [k, v] of failedAttempts) if (v.resetAt <= n) failedAttempts.delete(k);
  for (const [k, v] of bans) if (v <= n) bans.delete(k);
}, 60_000).unref();

// token bucket: 5 burst, 1 msg/sec refill
function allowMessage(ws) {
  const now = Date.now();
  const b = ws.bucket;
  b.tokens = Math.min(5, b.tokens + (now - b.last) / 1000);
  b.last = now;
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
const HELP = [
  '/me <action>      — say an action (e.g. /me waves)',
  '/nick <name>      — change your nickname',
  '/report <nick>    — report someone to the site admin',
  'Room owner:  /kick <nick> · /lock · /unlock',
  'Admin:       /admin <key> · /ban <nick> · /clear · /announce <text>',
].join('\n');

function command(ws, room, text) {
  const [cmdRaw, ...rest] = text.slice(1).split(' ');
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(' ').trim();
  const reply = (t) => send(ws, { t: 'sys', text: t, ts: Date.now() });
  const canModerate = ws.isAdmin || room.owner === ws;

  switch (cmd) {
    case 'help': return reply(HELP);
    case 'me': {
      const body = filterWords(cleanText(arg));
      if (!body) return;
      const item = { t: 'msg', nick: ws.nick, text: body, me: true, ts: Date.now() };
      pushHistory(room, item); return broadcast(room, item);
    }
    case 'nick': {
      const n = cleanNick(arg);
      if (!n) return reply('Nickname: 2–20 letters, numbers, space, _ . -');
      const old = ws.nick; ws.nick = '\u0000'; ws.nick = uniqueNick(room, n);
      send(ws, { t: 'renamed', nick: ws.nick });
      sys(room, `${old} is now ${ws.nick}`);
      return broadcast(room, { t: 'users', users: userList(room) });
    }
    case 'report': {
      const target = findInRoom(room, arg);
      if (!target) return reply('No one with that nickname here.');
      const recent = room.history.filter(h => h.nick === target.nick).slice(-5).map(h => h.text);
      console.log(JSON.stringify({ event: 'report', at: new Date().toISOString(), room: room.private ? 'private' : 'lobby',
        reporter: ipTag(ws.ip), target: target.nick, targetTag: ipTag(target.ip), recent }));
      return reply(`Thanks — ${target.nick} was reported to the admin.`);
    }
    case 'admin': {
      if (!CFG.adminKey) return reply('Admin mode is not enabled on this server.');
      if (tooManyFailures(ws.ip)) return reply('Too many attempts. Wait a minute.');
      if (!safeEqual(arg, CFG.adminKey)) { recordFailure(ws.ip); return reply('Wrong key.'); }
      ws.isAdmin = true;
      broadcast(room, { t: 'users', users: userList(room) });
      return send(ws, { t: 'role', admin: true, owner: room.owner === ws });
    }
    case 'kick': {
      if (!canModerate) return reply('Only the room owner or an admin can kick.');
      const target = findInRoom(room, arg);
      if (!target || target === ws) return reply('No one with that nickname here.');
      if (target.isAdmin) return reply('You can\'t kick an admin.');
      room.kicked.add(target.ip);
      send(target, { t: 'kicked', text: 'You were removed from the room.' });
      leaveRoom(target, true);
      return sys(room, `${target.nick} was removed`);
    }
    case 'ban': {
      if (!ws.isAdmin) return reply('Admins only.');
      const target = findInRoom(room, arg);
      if (!target || target === ws) return reply('No one with that nickname here.');
      bans.set(target.ip, Date.now() + CFG.banHours * 3600_000);
      console.log(JSON.stringify({ event: 'ban', at: new Date().toISOString(), target: target.nick, targetTag: ipTag(target.ip), hours: CFG.banHours }));
      sys(room, `${target.nick} was banned`);
      for (const c of wss.clients) if (c.ip === target.ip) { send(c, { t: 'kicked', text: 'You have been banned.' }); c.close(1008, 'banned'); }
      return;
    }
    case 'clear': {
      if (!canModerate) return reply('Only the room owner or an admin can clear.');
      room.history = [];
      return broadcast(room, { t: 'clear' });
    }
    case 'lock': case 'unlock': {
      if (!room.private) return reply('The public lobby can\'t be locked.');
      if (!canModerate) return reply('Only the room owner can do that.');
      room.locked = cmd === 'lock';
      broadcast(room, { t: 'locked', locked: room.locked });
      return sys(room, room.locked ? '🔒 Room locked — no new people can join' : '🔓 Room unlocked');
    }
    case 'announce': {
      if (!ws.isAdmin) return reply('Admins only.');
      const body = cleanText(arg);
      if (!body) return;
      for (const r of rooms.values()) broadcast(r, { t: 'announce', text: body, ts: Date.now() });
      return;
    }
    default: return reply('Unknown command. Type /help');
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 2048,
  perMessageDeflate: false,
  verifyClient: ({ origin, req }, done) => {
    if (CFG.allowedOrigins.length && !CFG.allowedOrigins.includes(origin)) return done(false, 403, 'Forbidden origin');
    const ip = clientIp(req);
    if (isBanned(ip)) return done(false, 403, 'Banned');
    if ((connsPerIp.get(ip) || 0) >= CFG.maxConnPerIp) return done(false, 429, 'Too many connections');
    done(true);
  },
});

wss.on('connection', (ws, req) => {
  ws.ip = clientIp(req);
  connsPerIp.set(ws.ip, (connsPerIp.get(ws.ip) || 0) + 1);
  ws.alive = true;
  ws.nick = null;
  ws.roomCode = null;
  ws.isAdmin = false;
  ws.bucket = { tokens: 5, last: Date.now() };
  ws.lastTyping = 0;
  ws.strikes = 0;

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return ws.close(1003, 'text only');
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;

    // typing pings are cheap and throttled separately
    if (m.t === 'typing') {
      const now = Date.now();
      if (!ws.roomCode || now - ws.lastTyping < 2000) return;
      ws.lastTyping = now;
      const room = rooms.get(ws.roomCode);
      return room && broadcast(room, { t: 'typing', nick: ws.nick }, ws);
    }

    if (!allowMessage(ws)) {
      if (++ws.strikes > 20) return ws.close(1008, 'rate limit');
      return send(ws, { t: 'error', text: 'Slow down a little.' });
    }

    switch (m.t) {
      case 'create': {
        const nick = cleanNick(m.nick);
        if (!nick) return send(ws, { t: 'error', text: 'Pick a different nickname (2–20 letters, numbers, space, _ . -).' });
        if (rooms.size >= CFG.maxRooms) return send(ws, { t: 'error', text: 'Server is busy, try again later.' });
        const code = newCode();
        rooms.set(code, makeRoom(true));
        return joinRoom(ws, code, nick);
      }
      case 'join': {
        const nick = cleanNick(m.nick);
        if (!nick) return send(ws, { t: 'error', text: 'Pick a different nickname (2–20 letters, numbers, space, _ . -).' });
        if (m.room === LOBBY) {
          if (!CFG.enableLobby) return send(ws, { t: 'error', text: 'The public lobby is disabled on this server.' });
          return joinRoom(ws, LOBBY, nick);
        }
        const code = normCode(m.room);
        if (tooManyFailures(ws.ip)) return send(ws, { t: 'error', text: 'Too many wrong codes. Wait a minute.' });
        if (code.length !== CODE_LEN || !rooms.has(code)) {
          recordFailure(ws.ip);
          return send(ws, { t: 'error', text: 'No room with that code (it may have closed).' });
        }
        return joinRoom(ws, code, nick);
      }
      case 'msg': {
        if (!ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        let text = cleanText(m.text);
        if (!text) return;
        if (text.startsWith('/')) return command(ws, room, text);
        text = filterWords(text);
        if (!room.private && !CFG.lobbyLinks && !ws.isAdmin) {
          URL_RE.lastIndex = 0;
          if (URL_RE.test(text)) return send(ws, { t: 'error', text: 'Links aren\'t allowed in the public lobby.' });
        }
        const item = { t: 'msg', nick: ws.nick, text, ts: Date.now() };
        if (ws.isAdmin) item.admin = true;
        ws.lastTyping = 0; // next keystroke after sending shows "typing…" again right away
        pushHistory(room, item);
        return broadcast(room, item);
      }
      case 'leave':
        leaveRoom(ws);
        return send(ws, { t: 'left' });
      default:
        return;
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    const n = (connsPerIp.get(ws.ip) || 1) - 1;
    if (n <= 0) connsPerIp.delete(ws.ip); else connsPerIp.set(ws.ip, n);
  });
  ws.on('error', () => {});
});

// heartbeat: drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000).unref();

server.listen(CFG.port, () => {
  console.log(`${CFG.siteName} v${VERSION} listening on :${CFG.port}` +
    ` | lobby:${CFG.enableLobby} ads:${ADS_ON} admin:${!!CFG.adminKey} filter:${!!BLOCKED_RE}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { wss.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}

module.exports = { server, CFG };
