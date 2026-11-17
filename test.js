// End-to-end tests. Run: npm test
const { spawn } = require('child_process');
const WebSocket = require('ws');
const assert = require('assert');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startServer(port, extraEnv = {}) {
  const srv = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), MAX_CONN_PER_IP: '50', ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  srv.logs = '';
  srv.stdout.on('data', d => { srv.logs += d; });
  return new Promise((res) => srv.stdout.once('data', () => res(srv)));
}

function client(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    ws.on('message', d => inbox.push(JSON.parse(d)));
    ws.on('error', rej);
    ws.on('open', () => res({
      ws, inbox,
      send: o => ws.send(JSON.stringify(o)),
      say: text => ws.send(JSON.stringify({ t: 'msg', text })),
      wait: async (t, pred = () => true) => {
        for (let i = 0; i < 100; i++) {
          const m = inbox.find(x => x.t === t && pred(x));
          if (m) { inbox.splice(inbox.indexOf(m), 1); return m; }
          await sleep(20);
        }
        throw new Error('timeout waiting for ' + t);
      },
    }));
  });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------------ default server
test('public lobby: join, duplicate nicks, plain-text messages', async ({ port }) => {
  const a = await client(port), b = await client(port);
  a.send({ t: 'join', room: 'lobby', nick: 'alice' }); assert.equal((await a.wait('joined')).room, 'lobby');
  b.send({ t: 'join', room: 'lobby', nick: 'Alice' }); assert.equal((await b.wait('joined')).nick, 'Alice-2');
  a.say('<img src=x onerror=alert(1)>');
  assert.equal((await b.wait('msg')).text, '<img src=x onerror=alert(1)>'); // passed as text; client renders via textContent
  a.ws.close(); b.ws.close();
});

test('lobby blocks links by default', async ({ port }) => {
  const a = await client(port);
  a.send({ t: 'join', room: 'lobby', nick: 'linky' }); await a.wait('joined');
  a.say('check https://spam.example now');
  assert.match((await a.wait('error')).text, /Links/);
  a.ws.close();
});

test('private rooms: create, join by code (case-insensitive), bad code, vanish when empty', async ({ port }) => {
  const a = await client(port), b = await client(port);
  a.send({ t: 'create', nick: 'host1' }); const pa = await a.wait('joined');
  assert.ok(pa.private && pa.owner && /^[A-Z2-9]{8}$/.test(pa.room));
  b.send({ t: 'join', room: pa.room.toLowerCase(), nick: 'bob' }); assert.equal((await b.wait('joined')).room, pa.room);
  b.say('see https://example.com'); assert.equal((await a.wait('msg')).text, 'see https://example.com'); // links OK in private
  b.send({ t: 'join', room: 'ZZZZZZZZ', nick: 'bob' }); assert.match((await b.wait('error')).text, /No room/);
  a.send({ t: 'leave' }); b.send({ t: 'leave' }); await sleep(100);
  const c = await client(port);
  c.send({ t: 'join', room: pa.room, nick: 'late' }); assert.match((await c.wait('error')).text, /No room/);
  a.ws.close(); b.ws.close(); c.ws.close();
});


test('owner can kick (and kicked user cannot rejoin) and lock the room', async ({ port }) => {
  const a = await client(port), b = await client(port), c = await client(port);
  a.send({ t: 'create', nick: 'boss' }); const { room } = await a.wait('joined');
  b.send({ t: 'join', room, nick: 'troll' }); await b.wait('joined');
  b.say('/kick boss'); assert.match((await b.wait('sys', m => /Only the room owner/.test(m.text))).text, /owner/);
  a.say('/kick troll'); await b.wait('kicked');
  b.send({ t: 'join', room, nick: 'troll2' }); assert.match((await b.wait('error')).text, /removed/);
  a.say('/lock'); await a.wait('locked', m => m.locked);
  c.send({ t: 'join', room, nick: 'newbie' }); assert.match((await c.wait('error')).text, /locked/);
  a.ws.close(); b.ws.close(); c.ws.close();
});

test('ownership passes to next person when owner leaves', async ({ port }) => {
  const a = await client(port), b = await client(port);
  a.send({ t: 'create', nick: 'first' }); const { room } = await a.wait('joined');
  b.send({ t: 'join', room, nick: 'second' }); await b.wait('joined');
  a.send({ t: 'leave' });
  await b.wait('sys', m => /second is now the room owner/.test(m.text));
  a.ws.close(); b.ws.close();
});

test('/me, /nick, /help, /report', async ({ port, srv }) => {
  const a = await client(port), b = await client(port);
  a.send({ t: 'create', nick: 'ann' }); const { room } = await a.wait('joined');
  b.send({ t: 'join', room, nick: 'ben' }); await b.wait('joined');
  a.say('/me waves'); const me = await b.wait('msg'); assert.ok(me.me && me.text === 'waves');
  a.say('/nick annie'); assert.equal((await a.wait('renamed')).nick, 'annie');
  a.say('/help'); assert.match((await a.wait('sys', m => m.text.includes('/kick'))).text, /kick/);
  a.say('/report ben'); await a.wait('sys', m => /reported/.test(m.text));
  await sleep(50); assert.match(srv.logs, /"event":"report"/);
  assert.doesNotMatch(srv.logs, /127\.0\.0\.1/); // raw IPs never logged
  a.ws.close(); b.ws.close();
});

test('reserved and invalid nicknames are rejected', async ({ port }) => {
  const a = await client(port);
  a.send({ t: 'join', room: 'lobby', nick: '<script>' }); assert.match((await a.wait('error')).text, /nickname/i);
  a.send({ t: 'join', room: 'lobby', nick: 'Admin' }); assert.match((await a.wait('error')).text, /nickname/i);
  a.ws.close();
});

test('rate limiting', async ({ port }) => {
  const a = await client(port);
  a.send({ t: 'join', room: 'lobby', nick: 'spammer' }); await a.wait('joined');
  for (let i = 0; i < 12; i++) a.say('x' + i);
  assert.match((await a.wait('error')).text, /Slow down/);
  a.ws.close();
});

test('HTTP: security headers, config, stats, no path traversal', async ({ port }) => {
  const r = await fetch(`http://127.0.0.1:${port}/`);
  assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const cfg = await (await fetch(`http://127.0.0.1:${port}/config.json`)).json();
  assert.equal(cfg.ads, null);
  assert.equal(typeof (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()).lobby, 'number');
  assert.equal((await fetch(`http://127.0.0.1:${port}/../server.js`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/ads.txt`)).status, 404);
});

// runs last on the default server: it locks this IP out of private codes for 60s
test('code brute-force lockout after 10 wrong codes', async ({ port }) => {
  const a = await client(port);
  for (let i = 0; i < 10; i++) { a.send({ t: 'join', room: 'AAAAAAA' + 'BCDEFGHJKL'[i], nick: 'guess' }); await a.wait('error'); await sleep(1000); }
  a.send({ t: 'join', room: 'QQQQQQQQ', nick: 'guess' });
  assert.match((await a.wait('error')).text, /Too many/);
  a.ws.close();
});

// ------------------------------------------------------------------ configured server
test('word filter, admin powers, ads + donate config', async ({ port2, srv2 }) => {
  const a = await client(port2), b = await client(port2);
  a.send({ t: 'join', room: 'lobby', nick: 'keeper' }); await a.wait('joined');
  b.send({ t: 'join', room: 'lobby', nick: 'rude' }); await b.wait('joined');
  b.say('you are a badword'); assert.equal((await a.wait('msg')).text, 'you are a *******');
  a.say('/admin wrong'); await a.wait('sys', m => /Wrong key/.test(m.text));
  a.say('/admin s3cret-key-for-tests'); assert.ok((await a.wait('role')).admin);
  a.say('/announce hello everyone'); assert.equal((await b.wait('announce')).text, 'hello everyone');
  a.say('/ban rude'); await b.wait('kicked');
  await sleep(100);
  await assert.rejects(client(port2)); // banned IP (all test clients share 127.0.0.1)… so ban is per-IP
  assert.match(srv2.logs, /"event":"ban"/);
  const cfg = await (await fetch(`http://127.0.0.1:${port2}/config.json`)).json();
  assert.equal(cfg.siteName, 'TestChat');
  assert.equal(cfg.donate.url, 'https://ko-fi.com/example');
  assert.equal(cfg.ads.client, 'ca-pub-123');
  const page = await fetch(`http://127.0.0.1:${port2}/`);
  const csp = page.headers.get('content-security-policy');
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.ok((await page.text()).includes(`nonce="${nonce}"`));
  assert.match(await (await fetch(`http://127.0.0.1:${port2}/ads.txt`)).text(), /pub-123, DIRECT/);
  a.ws.close();
});

(async () => {
  const port = 18080, port2 = 18081;
  const srv = await startServer(port);
  const srv2 = await startServer(port2, {
    BLOCKED_WORDS: 'badword', ADMIN_KEY: 's3cret-key-for-tests', SITE_NAME: 'TestChat',
    DONATE_URL: 'https://ko-fi.com/example', ADSENSE_CLIENT: 'ca-pub-123', ADSENSE_SLOT_HOME: '1',
  });
  let failed = 0;
  for (const t of tests) {
    try { await t.fn({ port, port2, srv, srv2 }); console.log('  ✔', t.name); }
    catch (e) { failed++; console.log('  ✘', t.name, '\n    ', e.message); }
  }
  srv.kill(); srv2.kill();
  console.log(failed ? `\n${failed} failed` : `\nAll ${tests.length} tests passed`);
  process.exit(failed ? 1 : 0);
})();
