'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config.js');

let WebSocketServer;
try { ({ WebSocketServer } = require('ws')); }
catch (e) {
  try { ({ WebSocketServer } = require(path.join(process.cwd(), 'node_modules', 'ws'))); }
  catch (e2) {
    console.error('[mock-baileys] Missing dependency "ws". Run:  npm i ws');
    process.exit(1);
  }
}

const uiHandlers = [];     // browser -> bot
const botListeners = [];   // admin panel -> bot (group events etc.)
const clients = new Set();
const history = [];
const MAX_HISTORY = 500;

const idPart = (jid) => String(jid || '').split('@')[0].split(':')[0];

// ---------------------------------------------------------------------------
// World state (users, groups, pictures). Saved to mock-baileys/data/state.json
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(config.DATA_DIR, 'state.json');

function defaults() {
  const now = Math.floor(Date.now() / 1000);
  const t2 = '27222222222@s.whatsapp.net', t3 = '27333333333@s.whatsapp.net';
  return {
    notify: true,
    botJid: config.BOT_NUMBER_JID,
    contacts: [
      { jid: config.USER_JID, name: 'You', you: true },
      { jid: t2, name: 'Tester Two' },
      { jid: t3, name: 'Tester Three' }
    ],
    groups: [{
      id: config.GROUP_JID, subject: 'Mock Group', owner: config.USER_JID, creation: now,
      desc: 'A fake group for testing', announce: false, restrict: false,
      participants: [
        { id: config.USER_JID, admin: 'superadmin' },
        { id: t2, admin: null },
        { id: t3, admin: null },
        { id: config.BOT_NUMBER_JID, admin: 'admin' }
      ]
    }],
    pfps: {} // idPart -> { mime, b64, v }
  };
}

function renameJid(s, from, to) {
  for (const g of s.groups) {
    if (g.owner === from) g.owner = to;
    g.participants.forEach(p => { if (p.id === from) p.id = to; });
  }
  const a = idPart(from), b = idPart(to);
  if (s.pfps[a]) { s.pfps[b] = s.pfps[a]; delete s.pfps[a]; }
}

// Keeps a saved file valid if you changed MOCK_USER_NUMBER / MOCK_BOT_NUMBER since last run.
function normalise(s) {
  s.contacts = Array.isArray(s.contacts) ? s.contacts : [];
  s.groups = Array.isArray(s.groups) ? s.groups : [];
  s.pfps = s.pfps || {};
  const you = s.contacts.find(c => c.you);
  if (you && you.jid !== config.USER_JID) { renameJid(s, you.jid, config.USER_JID); you.jid = config.USER_JID; }
  if (!s.contacts.some(c => c.jid === config.USER_JID)) s.contacts.unshift({ jid: config.USER_JID, name: 'You', you: true });
  if (s.botJid && s.botJid !== config.BOT_NUMBER_JID) renameJid(s, s.botJid, config.BOT_NUMBER_JID);
  s.botJid = config.BOT_NUMBER_JID;
  s.notify = s.notify !== false;
  return s;
}

function loadState() {
  try { return normalise(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch (e) { return normalise(defaults()); }
}

let state = loadState();

function saveState() {
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('[mock-baileys] could not save state:', e.message); }
}

const findGroup = (jid) => state.groups.find(g => g.id === jid);
const botIn = (g) => g.participants.some(p => p.id === config.BOT_NUMBER_JID);

function groupMeta(g) {
  return {
    id: g.id, subject: g.subject, subjectOwner: g.owner, subjectTime: g.creation,
    owner: g.owner, creation: g.creation, desc: g.desc, descOwner: g.owner,
    size: g.participants.length, announce: !!g.announce, restrict: !!g.restrict, ephemeralDuration: 0,
    participants: g.participants.map(p => ({ id: p.id, admin: p.admin || null }))
  };
}

function publicState() {
  const pfps = {};
  for (const k of Object.keys(state.pfps)) pfps[k] = state.pfps[k].v;
  return {
    bot: config.BOT_NUMBER_JID, user: config.USER_JID, notify: state.notify,
    contacts: state.contacts.map(c => ({ jid: c.jid, name: c.name, you: !!c.you })),
    groups: state.groups.map(groupMeta),
    pfps
  };
}

// ---------------------------------------------------------------------------
// Talking to the browser(s)
// ---------------------------------------------------------------------------
function toUI(payload) {
  payload.ts = Date.now();
  if (payload.kind === 'message' || payload.kind === 'system') {
    history.push(payload);
    if (history.length > MAX_HISTORY) history.shift();
  }
  const data = JSON.stringify(payload);
  for (const c of clients) if (c.readyState === 1) c.send(data);
}

function broadcastState() {
  const data = JSON.stringify(Object.assign({ kind: 'state' }, publicState()));
  for (const c of clients) if (c.readyState === 1) c.send(data);
}

function onUIEvent(fn) {
  uiHandlers.push(fn);
  return () => { const i = uiHandlers.indexOf(fn); if (i >= 0) uiHandlers.splice(i, 1); };
}

function onBotEvent(fn) {
  botListeners.push(fn);
  return () => { const i = botListeners.indexOf(fn); if (i >= 0) botListeners.splice(i, 1); };
}

// ---------------------------------------------------------------------------
// API used by fake.js (things the BOT does)
// ---------------------------------------------------------------------------
function getGroup(jid) {
  const g = findGroup(jid);
  return g ? groupMeta(g) : { id: jid, subject: 'Unknown', participants: [] };
}

function getAllGroups() {
  const out = {};
  for (const g of state.groups) if (botIn(g)) out[g.id] = groupMeta(g);
  return out;
}

function updateGroupParticipants(jid, ids, action) {
  const g = findGroup(jid); if (!g) return;
  for (const id of ids) {
    const p = g.participants.find(x => x.id === id);
    if (action === 'add' && !p) g.participants.push({ id, admin: null });
    else if (action === 'remove') g.participants = g.participants.filter(x => x.id !== id);
    else if (action === 'promote' && p) p.admin = 'admin';
    else if (action === 'demote' && p) p.admin = null;
  }
  saveState(); broadcastState();
}

function updateGroup(jid, patch) {
  const g = findGroup(jid); if (!g) return;
  Object.assign(g, patch);
  saveState(); broadcastState();
}

function getPfpUrl(jid) {
  const key = idPart(jid), p = state.pfps[key];
  return p ? config.ORIGIN + '/pfp/' + key + '.jpg?v=' + p.v : null;
}

// ---------------------------------------------------------------------------
// Admin panel actions (things YOU do)
// ---------------------------------------------------------------------------
function fire(name, data) {
  if (!state.notify) return;
  for (const l of botListeners.slice()) {
    try { l(name, data); } catch (e) { console.error('[mock-baileys] bot listener error:', e); }
  }
}
function fireParticipants(g, ids, action, hadBot) {
  if (hadBot || botIn(g)) fire('group-participants.update', { id: g.id, author: config.USER_JID, participants: ids, action });
}
const note = (g, text) => toUI({ kind: 'system', jid: g.id, text });
const cleanName = (x, max) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, max || 40);
const nameFor = (jid) => {
  if (jid === config.BOT_NUMBER_JID) return 'Bot';
  const c = state.contacts.find(c => c.jid === jid);
  return c ? c.name : idPart(jid);
};
const needGroup = (jid) => { const g = findGroup(jid); if (!g) throw new Error('That group no longer exists.'); return g; };
const isKnownUser = (jid) => jid === config.BOT_NUMBER_JID || state.contacts.some(c => c.jid === jid);

function adminAction(e) {
  const res = {};
  switch (e.action) {
    case 'addContact': {
      const number = String(e.number || '').replace(/\D/g, '');
      if (number.length < 7 || number.length > 15) throw new Error('Number must be 7 to 15 digits including country code (e.g. 27821234567).');
      const jid = number + '@s.whatsapp.net';
      if (jid === config.BOT_NUMBER_JID) throw new Error("That is the bot's own number.");
      if (state.contacts.some(c => c.jid === jid)) throw new Error('That number is already a test user.');
      const name = cleanName(e.name) || ('Tester ' + number.slice(-4));
      state.contacts.push({ jid, name });
      fire('contacts.upsert', [{ id: jid, name, notify: name }]);
      break;
    }
    case 'updateContact': {
      const c = state.contacts.find(c => c.jid === e.jid); if (!c) throw new Error('Unknown user.');
      const name = cleanName(e.name); if (!name) throw new Error('Name cannot be empty.');
      c.name = name;
      break;
    }
    case 'removeContact': {
      const c = state.contacts.find(c => c.jid === e.jid); if (!c) throw new Error('Unknown user.');
      if (c.you) throw new Error('You cannot remove yourself.');
      for (const g of state.groups) {
        if (!g.participants.some(p => p.id === c.jid)) continue;
        const hadBot = botIn(g);
        g.participants = g.participants.filter(p => p.id !== c.jid);
        note(g, c.name + ' was removed');
        fireParticipants(g, [c.jid], 'remove', hadBot);
      }
      state.contacts = state.contacts.filter(x => x !== c);
      delete state.pfps[idPart(c.jid)];
      break;
    }
    case 'setPfp': {
      if (!isKnownUser(e.jid) && !findGroup(e.jid)) throw new Error('Unknown chat.');
      const key = idPart(e.jid);
      if (!e.data) { delete state.pfps[key]; break; }
      const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(e.data));
      if (!m) throw new Error('Unsupported image. Use JPG, PNG, WEBP or GIF.');
      if (m[2].length > 2800000) throw new Error('Image is too large.');
      state.pfps[key] = { mime: m[1], b64: m[2], v: Date.now() };
      break;
    }
    case 'createGroup': {
      const id = '120363' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0') + '@g.us';
      const g = {
        id, subject: cleanName(e.subject, 100) || ('Test Group ' + (state.groups.length + 1)),
        owner: config.USER_JID, creation: Math.floor(Date.now() / 1000), desc: '', announce: false, restrict: false,
        participants: [{ id: config.USER_JID, admin: 'superadmin' }, { id: config.BOT_NUMBER_JID, admin: 'admin' }]
      };
      state.groups.push(g);
      fire('groups.upsert', [groupMeta(g)]);
      res.groupId = id;
      break;
    }
    case 'updateGroup': {
      const g = needGroup(e.jid);
      if (e.subject !== undefined) {
        const s = cleanName(e.subject, 100); if (!s) throw new Error('Group name cannot be empty.');
        if (s !== g.subject) { g.subject = s; note(g, 'Group subject changed to: ' + s); fire('groups.update', [{ id: g.id, subject: s, author: config.USER_JID }]); }
      }
      if (e.desc !== undefined) {
        const d = String(e.desc).slice(0, 500);
        if (d !== g.desc) { g.desc = d; note(g, 'Group description changed'); fire('groups.update', [{ id: g.id, desc: d, author: config.USER_JID }]); }
      }
      if (typeof e.announce === 'boolean' && e.announce !== !!g.announce) {
        g.announce = e.announce; note(g, e.announce ? 'Only admins can send messages' : 'All members can send messages');
        fire('groups.update', [{ id: g.id, announce: g.announce, author: config.USER_JID }]);
      }
      if (typeof e.restrict === 'boolean' && e.restrict !== !!g.restrict) {
        g.restrict = e.restrict; note(g, e.restrict ? 'Only admins can edit group info' : 'All members can edit group info');
        fire('groups.update', [{ id: g.id, restrict: g.restrict, author: config.USER_JID }]);
      }
      break;
    }
    case 'deleteGroup': {
      const g = needGroup(e.jid);
      const hadBot = botIn(g);
      state.groups = state.groups.filter(x => x !== g);
      delete state.pfps[idPart(g.id)];
      if (hadBot) fire('group-participants.update', { id: g.id, author: config.USER_JID, participants: [config.BOT_NUMBER_JID], action: 'remove' });
      break;
    }
    case 'addMember': {
      const g = needGroup(e.jid);
      if (!isKnownUser(e.member)) throw new Error('Unknown user.');
      if (g.participants.some(p => p.id === e.member)) throw new Error('Already in the group.');
      g.participants.push({ id: e.member, admin: null });
      note(g, nameFor(e.member) + ' was added');
      fireParticipants(g, [e.member], 'add', false);
      break;
    }
    case 'removeMember': {
      const g = needGroup(e.jid);
      if (!g.participants.some(p => p.id === e.member)) throw new Error('Not in the group.');
      const hadBot = botIn(g);
      g.participants = g.participants.filter(p => p.id !== e.member);
      note(g, nameFor(e.member) + ' was removed');
      fireParticipants(g, [e.member], 'remove', hadBot);
      break;
    }
    case 'setRole': {
      const g = needGroup(e.jid);
      const p = g.participants.find(x => x.id === e.member); if (!p) throw new Error('Not in the group.');
      if (!['member', 'admin', 'superadmin'].includes(e.role)) throw new Error('Unknown role.');
      const wasAdmin = !!p.admin;
      if (e.role === 'superadmin') {
        const old = g.participants.find(x => x.admin === 'superadmin' && x !== p);
        if (old) old.admin = 'admin';
        g.owner = p.id; p.admin = 'superadmin';
      } else p.admin = e.role === 'admin' ? 'admin' : null;
      const isAdmin = !!p.admin;
      if (wasAdmin !== isAdmin) {
        note(g, nameFor(p.id) + (isAdmin ? ' is now an admin' : ' is no longer an admin'));
        fireParticipants(g, [p.id], isAdmin ? 'promote' : 'demote', false);
      }
      break;
    }
    case 'setNotify':
      state.notify = !!e.value;
      break;
    case 'reset':
      state = normalise(defaults());
      break;
    default:
      throw new Error('Unknown admin action: ' + e.action);
  }
  saveState();
  broadcastState();
  return res;
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------
const uiFile = path.join(__dirname, 'ui', 'index.html');
const httpServer = http.createServer((req, res) => {
  const pfp = /^\/pfp\/(\d+)(?:\.\w+)?(?:\?.*)?$/.exec(req.url);
  if (pfp) {
    const p = state.pfps[pfp[1]];
    if (!p) { res.writeHead(404); res.end('No picture'); return; }
    res.writeHead(200, { 'Content-Type': p.mime, 'Cache-Control': 'no-store' });
    res.end(Buffer.from(p.b64, 'base64'));
  } else if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(uiFile));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error('[mock-baileys] Port ' + config.PORT + ' is busy. Set MOCK_PORT=3001 (or another) and try again.');
  else console.error('[mock-baileys] server error', err);
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(Object.assign({ kind: 'init', history }, publicState())));
  ws.on('message', (raw) => {
    let e; try { e = JSON.parse(raw.toString()); } catch { return; }

    if (e.kind === 'admin') {
      let out;
      try { out = Object.assign({ ok: true }, adminAction(e)); }
      catch (err) { out = { ok: false, error: err.message || String(err) }; }
      out.kind = 'adminResult'; out.action = e.action;
      ws.send(JSON.stringify(out));
      return;
    }

    // Echo the tester's own bubble to every open tab.
    if (['text', 'image', 'viewonce', 'poll'].includes(e.kind)) {
      let content;
      if (e.kind === 'text') content = { type: 'text', text: e.text, mentions: e.mentions || [] };
      else if (e.kind === 'poll') content = { type: 'poll', name: e.name, options: e.options, selectable: e.selectable || 1 };
      else content = { type: 'image', caption: e.text, viewOnce: e.kind === 'viewonce', url: e.data };
      toUI({ kind: 'message', jid: e.jid, id: e.localId || ('U' + Date.now()), fromMe: false, sender: e.sender, quotedId: e.quotedId, content });
    }
    for (const h of uiHandlers.slice()) {
      try { h(e); } catch (err) { console.error('[mock-baileys] bot handler error:', err); }
    }
  });
  ws.on('close', () => clients.delete(ws));
});

httpServer.listen(config.PORT, '127.0.0.1', () => {
  console.log('[mock-baileys] Mock WhatsApp UI ready: http://localhost:' + config.PORT);
});

module.exports = { toUI, onUIEvent, onBotEvent, getGroup, getAllGroups, updateGroupParticipants, updateGroup, getPfpUrl };
