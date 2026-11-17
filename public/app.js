'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const home = $('home'), chat = $('chat');
  const nickIn = $('nick'), codeIn = $('code'), homeErr = $('homeErr');
  const messages = $('messages'), textIn = $('text'), banner = $('banner');
  const userList = $('userList'), userPanel = $('userPanel'), typingEl = $('typing');

  let ws = null;
  let me = null;            // my nick in current room
  let current = null;       // current room code ('lobby' or private code)
  let pending = null;       // action to send once socket opens
  let isOwner = false, isAdmin = false, isPrivate = false, locked = false;
  let unread = 0;
  let cfg = { siteName: 'OpenTalk' };
  const baseTitle = () => `${cfg.siteName} — free open chat`;

  // ---------------------------------------------------------------- config / branding / monetization
  fetch('/config.json').then(r => r.json()).then((c) => {
    cfg = c;
    document.title = baseTitle();
    $('siteName').textContent = c.siteName;
    $('tagline').textContent = c.tagline;
    if (c.github) { $('githubLink').href = c.github; } else { $('githubLink').classList.add('hidden'); }
    if (!c.enableLobby) { $('btnLobby').classList.add('hidden'); document.querySelector('.online').classList.add('hidden'); }
    if (c.donate) {
      for (const id of ['donateHome', 'donateChat']) {
        const a = $(id); a.href = c.donate.url; a.textContent = c.donate.label; a.classList.remove('hidden');
      }
    }
    if (c.sponsor) {
      const s = $('sponsor'); s.textContent = c.sponsor.text;
      if (c.sponsor.url) s.href = c.sponsor.url;
      s.classList.remove('hidden');
    }
    if (c.ads) loadAds(c.ads);
  }).catch(() => {});

  function loadAds(ads) {
    const sc = document.createElement('script');
    sc.async = true; sc.crossOrigin = 'anonymous';
    sc.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads.client)}`;
    document.head.append(sc);
    const place = (slotId, slot) => {
      if (!slot) return;
      const box = $(slotId);
      const ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.style.display = 'block';
      ins.dataset.adClient = ads.client; ins.dataset.adSlot = slot;
      ins.dataset.adFormat = 'auto'; ins.dataset.fullWidthResponsive = 'true';
      box.append(ins); box.classList.remove('hidden');
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch {}
    };
    place('adHome', ads.slotHome);
    place('adChat', ads.slotChat);
  }

  // live "people online" counter on the landing page
  async function refreshStats() {
    if (!home.classList.contains('hidden')) {
      try { const s = await (await fetch('/stats')).json(); $('onlineCount').textContent = s.lobby; } catch {}
    }
  }
  refreshStats(); setInterval(refreshStats, 15000);

  // ---------------------------------------------------------------- nickname persistence (never messages)
  try { nickIn.value = localStorage.getItem('opentalk.nick') || ''; } catch {}
  const saveNick = (n) => { try { localStorage.setItem('opentalk.nick', n); } catch {} };

  // invite link: #CODE in URL fragment (never sent to the server / logs)
  const hashCode = location.hash.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (hashCode) { codeIn.value = hashCode; }

  // ---------------------------------------------------------------- socket
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { if (pending) { ws.send(JSON.stringify(pending)); pending = null; } hideBanner(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
    ws.onclose = () => {
      ws = null;
      if (current) {
        showBanner('Disconnected. Reconnecting…');
        const room = current; current = null;
        setTimeout(() => sendAction({ t: 'join', room, nick: me || nickIn.value }), 1500);
      }
    };
  }
  function sendAction(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    else { pending = obj; if (!ws) connect(); }
  }

  function handle(m) {
    switch (m.t) {
      case 'joined':
        me = m.nick; current = m.room; isOwner = m.owner; isAdmin = m.admin; isPrivate = m.private; locked = m.locked;
        enterChat(m); break;
      case 'msg': addMsg(m); notify(); clearTyping(m.nick); break;
      case 'sys': addSys(m.text, m.ts); break;
      case 'announce': addAnnounce(m.text, m.ts); notify(); break;
      case 'users': renderUsers(m.users); break;
      case 'typing': showTyping(m.nick); break;
      case 'renamed': me = m.nick; saveNick(m.nick); updateMeta(); break;
      case 'role': isAdmin = m.admin; isOwner = m.owner; updateControls(); addSys('You are now an admin.', Date.now()); break;
      case 'locked': locked = m.locked; updateControls(); break;
      case 'clear': messages.textContent = ''; addSys('Chat was cleared.', Date.now()); break;
      case 'kicked':
        current = null; goHome(); homeErr.textContent = m.text; break;
      case 'error':
        if (current) showBanner(m.text, 4000); else homeErr.textContent = m.text;
        break;
    }
  }

  // ---------------------------------------------------------------- landing actions
  function nickOk() {
    const n = nickIn.value.trim();
    if (!/^[\p{L}\p{N}_ .\-]{2,20}$/u.test(n)) { homeErr.textContent = 'Nickname: 2–20 letters, numbers, space, _ . -'; nickIn.focus(); return false; }
    homeErr.textContent = ''; saveNick(n); return true;
  }
  $('btnLobby').onclick = () => { if (nickOk()) sendAction({ t: 'join', room: 'lobby', nick: nickIn.value }); };
  $('btnCreate').onclick = () => { if (nickOk()) sendAction({ t: 'create', nick: nickIn.value }); };
  $('btnJoin').onclick = () => {
    if (!nickOk()) return;
    const c = codeIn.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (c.length !== 8) { homeErr.textContent = 'Room codes are 8 characters.'; return; }
    sendAction({ t: 'join', room: c, nick: nickIn.value });
  };
  codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });
  nickIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') (codeIn.value ? $('btnJoin') : $('btnLobby')).click(); });

  // ---------------------------------------------------------------- chat UI
  function updateMeta() {
    $('roomMeta').textContent = isPrivate
      ? `You are ${me}${isOwner ? ' (owner)' : ''} · share the code to invite · closes when everyone leaves`
      : `You are ${me} · public — anyone can read this`;
  }
  function updateControls() {
    const lock = $('btnLock');
    lock.classList.toggle('hidden', !(isPrivate && (isOwner || isAdmin)));
    lock.textContent = locked ? '🔒' : '🔓';
    lock.title = locked ? 'Unlock room' : 'Lock room (no new joins)';
    $('modHint').classList.toggle('hidden', !(isOwner || isAdmin));
    updateMeta();
  }

  function enterChat(m) {
    home.classList.add('hidden'); chat.classList.remove('hidden');
    messages.textContent = '';
    const rn = $('roomName'); rn.textContent = '';
    if (m.private) {
      rn.append('Private room ');
      const s = document.createElement('span'); s.className = 'code'; s.textContent = m.room; rn.append(s);
      $('btnInvite').classList.remove('hidden');
      history.replaceState(null, '', '#' + m.room);
    } else {
      rn.textContent = 'Public lobby';
      $('btnInvite').classList.add('hidden');
      history.replaceState(null, '', location.pathname);
    }
    updateControls();
    (m.history || []).forEach(addMsg);
    addSys(m.private && m.owner ? 'Room created. Click "Copy invite" and send the link to your friends.' : 'You joined. Say hi 👋  (type /help for commands)', Date.now());
    renderUsers(m.users);
    textIn.focus();
  }

  const fmt = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const atBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
  function append(li) {
    const stick = atBottom();
    messages.append(li);
    while (messages.children.length > 500) messages.firstChild.remove();
    if (stick) messages.scrollTop = messages.scrollHeight;
  }

  // Turn http(s) URLs into safe links. Built with DOM nodes — never innerHTML.
  const LINK = /\bhttps?:\/\/[^\s<>"']+/g;
  function renderText(el, text) {
    let last = 0;
    for (const match of text.matchAll(LINK)) {
      let url = match[0].replace(/[.,!?;:)\]]+$/, '');
      if (match.index > last) el.append(text.slice(last, match.index));
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw 0;
        const a = document.createElement('a');
        a.href = u.href; a.textContent = url; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow ugc';
        el.append(a);
      } catch { el.append(url); }
      last = match.index + url.length;
    }
    if (last < text.length) el.append(text.slice(last));
  }

  function addMsg(m) {
    const li = document.createElement('li');
    if (m.nick === me) li.classList.add('me');
    if (m.admin) li.classList.add('admin');
    const t = document.createElement('span'); t.className = 'time'; t.textContent = fmt(m.ts);
    const n = document.createElement('span'); n.className = 'nick'; n.textContent = m.me ? `* ${m.nick}` : m.nick;
    const b = document.createElement('span'); b.className = 'text'; renderText(b, m.text);
    if (m.me) li.classList.add('action');
    li.append(t, n, b); append(li);
  }
  function addSys(text, ts) {
    const li = document.createElement('li'); li.className = 'sys';
    li.textContent = `${fmt(ts || Date.now())}  ${text}`; append(li);
  }
  function addAnnounce(text, ts) {
    const li = document.createElement('li'); li.className = 'announce';
    li.textContent = `📣 ${text}`; li.title = fmt(ts); append(li);
  }
  function renderUsers(users) {
    $('userCount').textContent = users.length;
    userList.textContent = '';
    users.forEach((u) => {
      const li = document.createElement('li');
      li.textContent = u.nick + (u.owner ? ' ★' : '') + (u.admin ? ' ⚑' : '') + (u.nick === me ? ' (you)' : '');
      if ((isOwner || isAdmin) && u.nick !== me && !u.admin) {
        li.classList.add('kickable');
        li.title = `Remove ${u.nick}`;
        li.onclick = () => { if (confirmKick(u.nick)) ws && ws.send(JSON.stringify({ t: 'msg', text: `/kick ${u.nick}` })); };
      }
      userList.append(li);
    });
  }
  // inline confirm without blocking dialogs
  let kickArm = null;
  function confirmKick(nick) {
    if (kickArm === nick) { kickArm = null; return true; }
    kickArm = nick; showBanner(`Click ${nick} again to remove them.`, 3000);
    setTimeout(() => { if (kickArm === nick) kickArm = null; }, 3000);
    return false;
  }

  // typing indicator
  const typers = new Map();
  function showTyping(nick) {
    clearTimeout(typers.get(nick));
    typers.set(nick, setTimeout(() => clearTyping(nick), 3500));
    paintTyping();
  }
  function clearTyping(nick) { clearTimeout(typers.get(nick)); typers.delete(nick); paintTyping(); }
  function paintTyping() {
    const names = [...typers.keys()];
    typingEl.textContent = !names.length ? '' :
      names.length === 1 ? `${names[0]} is typing…` :
      names.length <= 3 ? `${names.join(', ')} are typing…` : 'Several people are typing…';
  }

  // unread count in tab title
  function notify() { if (document.hidden) { unread++; document.title = `(${unread}) ${baseTitle()}`; } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { unread = 0; document.title = baseTitle(); } });

  let bannerTimer;
  function showBanner(text, ms) {
    banner.textContent = text; banner.classList.remove('hidden');
    clearTimeout(bannerTimer); if (ms) bannerTimer = setTimeout(hideBanner, ms);
  }
  function hideBanner() { banner.classList.add('hidden'); }

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = textIn.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ t: 'msg', text }));
    textIn.value = ''; autosize();
  });
  textIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  function autosize() { textIn.style.height = 'auto'; textIn.style.height = Math.min(textIn.scrollHeight, 140) + 'px'; }
  textIn.addEventListener('input', () => {
    autosize();
    if (ws && ws.readyState === 1 && textIn.value && !textIn.value.startsWith('/')) ws.send('{"t":"typing"}');
  });

  function goHome() {
    chat.classList.add('hidden'); home.classList.remove('hidden');
    history.replaceState(null, '', location.pathname);
    codeIn.value = ''; typers.clear(); paintTyping(); refreshStats();
  }
  $('btnBack').onclick = () => { current = null; sendAction({ t: 'leave' }); goHome(); };
  $('btnUsers').onclick = () => userPanel.classList.toggle('hidden');
  $('btnLock').onclick = () => ws && ws.send(JSON.stringify({ t: 'msg', text: locked ? '/unlock' : '/lock' }));
  $('btnInvite').onclick = async () => {
    const link = `${location.origin}${location.pathname}#${current}`;
    try { await navigator.clipboard.writeText(link); showBanner('Invite link copied: ' + link, 3000); }
    catch { showBanner('Invite link: ' + link); }
  };
})();
