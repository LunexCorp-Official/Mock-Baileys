'use strict';
const EventEmitter = require('events');
const config = require('./config.js');
const server = require('./server.js');

const { BOT_JID, BOT_NUMBER_JID } = config;
let idCounter = 1;
const newId = () => 'MOCK' + Date.now().toString(36).toUpperCase() + (idCounter++);
const msgStore = new Map(); // id -> full message (both directions), for store.loadMessage

function dataUrl(src, mime) {
  try {
    if (Buffer.isBuffer(src)) return 'data:' + mime + ';base64,' + src.toString('base64');
    if (src && typeof src.url === 'string') return src.url.startsWith(config.ORIGIN) ? src.url.slice(config.ORIGIN.length) : src.url;
  } catch (e) {}
  return null;
}

function unwrap(m) {
  let cur = m;
  for (let i = 0; i < 6 && cur; i++) {
    const inner = cur.viewOnceMessage || cur.viewOnceMessageV2 || cur.viewOnceMessageV2Extension ||
      cur.ephemeralMessage || cur.documentWithCaptionMessage || cur.editedMessage;
    if (!inner) break;
    cur = inner.message || inner;
  }
  return cur;
}

function nativeButtons(list) {
  return list.map(b => {
    let p = {};
    try { p = JSON.parse(b.buttonParamsJson || '{}'); } catch (e) {}
    return { id: p.id || b.name, label: p.display_text || p.title || b.name, native: true, name: b.name, url: p.url };
  });
}

// Describe a RAW protobuf-style message (what relayMessage receives).
function describeRaw(raw) {
  const m = unwrap(raw);
  if (!m || typeof m !== 'object') return { type: 'unsupported' };
  if (m.conversation) return { type: 'text', text: m.conversation };
  if (m.extendedTextMessage) return { type: 'text', text: m.extendedTextMessage.text, mentions: (m.extendedTextMessage.contextInfo && m.extendedTextMessage.contextInfo.mentionedJid) || [] };
  if (m.reactionMessage) return { type: 'reaction', emoji: m.reactionMessage.text, target: m.reactionMessage.key };
  if (m.interactiveMessage) {
    const im = m.interactiveMessage;
    const text = [im.header && im.header.title, im.body && im.body.text, im.footer && im.footer.text].filter(Boolean).join('\n');
    const nf = im.nativeFlowMessage;
    if (nf && Array.isArray(nf.buttons)) return { type: 'buttons', text, buttons: nativeButtons(nf.buttons) };
    return { type: 'unsupported', note: 'interactive message' };
  }
  if (m.buttonsMessage) {
    const b = m.buttonsMessage;
    return { type: 'buttons', text: b.contentText || b.text, buttons: (b.buttons || []).map(x => ({ id: x.buttonId, label: x.buttonText && x.buttonText.displayText })) };
  }
  if (m.listMessage) {
    const l = m.listMessage;
    return { type: 'list', text: l.description, title: l.title, buttonText: l.buttonText, sections: (l.sections || []).map(s => ({ title: s.title, rows: s.rows })) };
  }
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
  if (poll) return { type: 'poll', name: poll.name, options: (poll.options || []).map(o => o.optionName), selectable: poll.selectableOptionsCount };
  if (m.imageMessage) return { type: 'image', caption: m.imageMessage.caption, url: null };
  return { type: 'unsupported' };
}

// Describe a sendMessage() content object for the UI.
function describe(content) {
  if (content == null || typeof content !== 'object') return { type: 'unsupported' };
  if (content.delete) return { type: 'delete', target: content.delete };
  if (content.edit) return { type: 'edit', text: content.text, target: content.edit };
  if (content.react) return { type: 'reaction', emoji: content.react.text, target: content.react.key };
  if (content.poll) return { type: 'poll', name: content.poll.name, options: content.poll.values, selectable: content.poll.selectableCount };
  if (content.buttons) return { type: 'buttons', text: content.text || content.caption, buttons: content.buttons.map(b => ({ id: b.buttonId, label: (b.buttonText && b.buttonText.displayText) || b.buttonId })) };
  if (content.interactiveButtons) return { type: 'buttons', text: content.text || content.caption, buttons: nativeButtons(content.interactiveButtons) };
  if (content.sections) return { type: 'list', text: content.text, title: content.title, buttonText: content.buttonText, sections: content.sections };
  if (content.image) return { type: 'image', caption: content.caption, viewOnce: !!content.viewOnce, url: dataUrl(content.image, 'image/jpeg') };
  if (content.video) return { type: 'video', caption: content.caption, viewOnce: !!content.viewOnce };
  if (content.audio) return { type: 'audio', ptt: !!content.ptt };
  if (content.sticker) return { type: 'sticker' };
  if (content.document) return { type: 'document', fileName: content.fileName, caption: content.caption };
  if (content.location) return { type: 'location', lat: content.location.degreesLatitude, lng: content.location.degreesLongitude };
  if (content.contacts) return { type: 'contacts', name: content.contacts.displayName };
  if (typeof content.text === 'string') return { type: 'text', text: content.text, mentions: content.mentions || (content.contextInfo && content.contextInfo.mentionedJid) || [] };
  const raw = describeRaw(content);
  return raw;
}

function pollOptionsOf(msg) {
  const c = msg && msg.message;
  if (!c) return [];
  if (c.__mockPoll) return c.__mockPoll;
  if (c.poll) return c.poll.values || [];
  const p = c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3;
  return p ? (p.options || []).map(o => o.optionName) : [];
}

function makeWASocket(config_ = {}) {
  const ev = new EventEmitter();
  ev.setMaxListeners(0);
  ev.process = (handler) => {
    const names = ['connection.update', 'creds.update', 'messages.upsert', 'messages.update', 'messages.reaction', 'presence.update', 'groups.update', 'group-participants.update', 'call', 'messaging-history.set', 'chats.upsert', 'contacts.upsert', 'contacts.update', 'groups.upsert'];
    for (const n of names) ev.on(n, (data) => handler({ [n]: data }));
  };

  const record = (msg) => { if (msg && msg.key && msg.key.id) msgStore.set(msg.key.id, msg); };

  const sock = {
    ev,
    user: { id: BOT_JID, name: 'Mock Bot', lid: BOT_JID },
    authState: { creds: { me: { id: BOT_JID, name: 'Mock Bot' }, registered: true }, keys: {} },
    ws: new EventEmitter(),

    async sendMessage(jid, content, options = {}) {
      const id = (options && options.messageId) || newId();
      const key = { remoteJid: jid, fromMe: true, id };
      const info = describe(content);
      const msg = { key, message: content, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Bot', status: 1 };
      record(msg);
      const quoted = options.quoted && options.quoted.key && options.quoted.key.id;
      server.toUI({ kind: 'message', jid, id, fromMe: true, quotedId: quoted, content: info });
      return msg;
    },

    // Button libraries often call this directly with a raw protobuf-style message.
    async relayMessage(jid, message, options = {}) {
      const id = (options && options.messageId) || newId();
      record({ key: { remoteJid: jid, fromMe: true, id }, message });
      server.toUI({ kind: 'message', jid, id, fromMe: true, content: describeRaw(message) });
      return id;
    },

    async sendPresenceUpdate(type, jid) { server.toUI({ kind: 'presence', jid, type }); },
    async presenceSubscribe() {},
    async readMessages(keys) { server.toUI({ kind: 'read', keys }); },
    async sendReceipt() {},
    async updateMediaMessage(m) { return m; },
    async waitForMessage() { return null; },
    async onWhatsApp(...jids) { return jids.flat().map(j => ({ jid: j, exists: true })); },
    async profilePictureUrl(jid) { return server.getPfpUrl(jid); },
    async fetchStatus() { return { status: 'mock' }; },
    async updateProfileStatus() {},
    async updateBlockStatus() {},
    async groupMetadata(jid) { return server.getGroup(jid); },
    async groupFetchAllParticipating() { return server.getAllGroups(); },
    async groupParticipantsUpdate(jid, ids, action) {
      server.updateGroupParticipants(jid, ids, action);
      server.toUI({ kind: 'system', jid, text: 'Group action: ' + action + ' ' + ids.map(i => i.split('@')[0]).join(', ') });
      return ids.map(id => ({ status: '200', jid: id }));
    },
    async groupUpdateSubject(jid, s) { server.updateGroup(jid, { subject: String(s) }); server.toUI({ kind: 'system', jid, text: 'Group subject changed to: ' + s }); },
    async groupUpdateDescription(jid, s) { server.updateGroup(jid, { desc: String(s || '') }); server.toUI({ kind: 'system', jid, text: 'Group description changed' }); },
    async groupSettingUpdate(jid, s) {
      const map = { announcement: { announce: true }, not_announcement: { announce: false }, locked: { restrict: true }, unlocked: { restrict: false } };
      if (map[s]) server.updateGroup(jid, map[s]);
      server.toUI({ kind: 'system', jid, text: 'Group setting: ' + s });
    },
    async groupInviteCode() { return 'MOCKINVITE'; },
    async rejectCall(callId, from) { server.toUI({ kind: 'system', jid: from, text: 'Bot rejected the call' }); },
    async offerCall(jid, isVideo) { server.toUI({ kind: 'system', jid, text: 'Bot started a ' + (isVideo ? 'video ' : '') + 'call' }); },
    async query() { return {}; },
    async logout() { server.toUI({ kind: 'system', text: 'Bot called logout()' }); },
    end() { unsubscribe(); unsubscribeBot(); }
  };

  // Any socket method that isn't implemented gets a harmless stub plus a note in the UI.
  const proxy = new Proxy(sock, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      return async () => {
        server.toUI({ kind: 'system', text: 'Unsupported content for now: sock.' + String(prop) + '()' });
        return {};
      };
    }
  });

  // Admin panel -> bot events (group promote/demote/add/remove, new groups ...).
  const unsubscribeBot = server.onBotEvent((name, data) => ev.emit(name, data));

  // Browser -> bot events, turned into Baileys-shaped events.
  const unsubscribe = server.onUIEvent((e) => {
    const ts = Math.floor(Date.now() / 1000);
    const pushName = e.pushName || 'Tester';
    const base = (id) => ({ remoteJid: e.jid, fromMe: false, id, participant: e.jid.endsWith('@g.us') ? e.sender : undefined });
    const upsert = (message) => {
      const id = (e.localId && ['text', 'image', 'viewonce', 'poll'].includes(e.kind)) ? e.localId : newId();
      const msg = { key: base(id), message, messageTimestamp: ts, pushName };
      record(msg);
      ev.emit('messages.upsert', { messages: [msg], type: 'notify' });
      return msg;
    };
    const ctx = e.quotedId ? { stanzaId: e.quotedId, participant: e.quotedSender || BOT_NUMBER_JID, quotedMessage: { conversation: e.quotedText || '' } } : undefined;
    const mentions = Array.isArray(e.mentions) ? e.mentions.filter(x => typeof x === 'string') : [];
    const ctxM = (ctx || mentions.length) ? Object.assign({}, ctx, mentions.length ? { mentionedJid: mentions } : {}) : undefined;

    switch (e.kind) {
      case 'text':
        upsert(ctxM ? { extendedTextMessage: { text: e.text, contextInfo: ctxM } } : { conversation: e.text });
        break;
      case 'image':
        upsert({ imageMessage: { caption: e.text || '', mimetype: 'image/jpeg', url: 'mock://image', _mockData: e.data, contextInfo: ctxM } });
        break;
      case 'viewonce':
        upsert({ viewOnceMessageV2: { message: { imageMessage: { caption: e.text || '', mimetype: 'image/jpeg', viewOnce: true, url: 'mock://image', _mockData: e.data } } } });
        break;
      case 'poll':
        upsert({ pollCreationMessage: { name: e.name, options: e.options.map(o => ({ optionName: o })), selectableOptionsCount: e.selectable || 1 } });
        break;
      case 'reaction': {
        ev.emit('messages.reaction', [{ key: { remoteJid: e.jid, fromMe: !!e.targetFromMe, id: e.targetId }, reaction: { text: e.emoji, key: base(newId()) } }]);
        upsert({ reactionMessage: { text: e.emoji, key: { remoteJid: e.jid, fromMe: !!e.targetFromMe, id: e.targetId } } });
        break;
      }
      case 'pollVote': {
        const pollMsg = msgStore.get(e.targetId);
        ev.emit('messages.update', [{
          key: { remoteJid: e.jid, fromMe: true, id: e.targetId },
          update: { pollUpdates: [{ pollUpdateMessageKey: base(newId()), vote: { selectedOptions: e.selected }, senderTimestampMs: Date.now() }] }
        }]);
        if (!pollMsg) server.toUI({ kind: 'system', jid: e.jid, text: 'Poll vote sent (poll message not found in mock store)' });
        break;
      }
      case 'buttonClick':
        if (e.native) {
          upsert({ interactiveResponseMessage: { body: { text: e.label }, nativeFlowResponseMessage: { name: e.name || 'quick_reply', paramsJson: JSON.stringify({ id: e.buttonId, display_text: e.label }), version: 3 }, contextInfo: ctx } });
        } else {
          upsert({ buttonsResponseMessage: { selectedButtonId: e.buttonId, selectedDisplayText: e.label, type: 1, contextInfo: ctx } });
        }
        break;
      case 'listClick':
        upsert({ listResponseMessage: { title: e.title, description: e.description || '', singleSelectReply: { selectedRowId: e.rowId }, listType: 1 } });
        break;
      case 'call':
        ev.emit('call', [{ id: newId(), from: e.sender, chatId: e.jid, status: 'offer', isVideo: !!e.video, isGroup: false, date: new Date() }]);
        break;
      default:
        break;
    }
  });

  // Pretend to connect once the bot has attached its listeners.
  setTimeout(() => {
    ev.emit('connection.update', { connection: 'connecting' });
    setTimeout(() => {
      ev.emit('connection.update', { connection: 'open', receivedPendingNotifications: true, qr: undefined });
      server.toUI({ kind: 'system', text: 'Bot connected (mock)' });
    }, 300);
  }, 500);

  return proxy;
}

// ---- Other Baileys exports ----
async function useMultiFileAuthState() {
  const state = { creds: { me: { id: BOT_JID, name: 'Mock Bot' }, registered: true }, keys: { get: async () => ({}), set: async () => {} } };
  return { state, saveCreds: async () => {} };
}

function makeInMemoryStore() {
  return {
    messages: {}, chats: {}, contacts: {},
    bind(ev) { if (ev && ev.on) ev.on('messages.upsert', ({ messages }) => messages.forEach(m => m.key && msgStore.set(m.key.id, m))); },
    async loadMessage(jid, id) { return msgStore.get(id) || undefined; },
    readFromFile() {}, writeToFile() {}
  };
}

function getAggregateVotesInPollMessage({ message, pollUpdates } = {}) {
  const opts = pollOptionsOf({ message });
  const votes = opts.map(name => ({ name, voters: [] }));
  const latest = new Map(); // voter -> selected
  for (const u of pollUpdates || []) {
    const voter = (u.pollUpdateMessageKey && (u.pollUpdateMessageKey.participant || u.pollUpdateMessageKey.remoteJid)) || 'unknown';
    latest.set(voter, (u.vote && u.vote.selectedOptions) || []);
  }
  for (const [voter, sel] of latest) for (const v of votes) if (sel.includes(v.name)) v.voters.push(voter);
  return votes;
}

const jidDecode = (jid) => {
  const m = /^(\d+)(?::(\d+))?@(.+)$/.exec(jid || '');
  return m ? { user: m[1], device: m[2] ? Number(m[2]) : undefined, server: m[3] } : { user: (jid || '').split('@')[0], server: (jid || '').split('@')[1] };
};
const jidNormalizedUser = (jid) => (jid || '').replace(/:\d+@/, '@');

module.exports = {
  makeWASocket,
  useMultiFileAuthState,
  makeInMemoryStore,
  getAggregateVotesInPollMessage,
  DisconnectReason: { connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, timedOut: 408, loggedOut: 401, badSession: 500, restartRequired: 515, multideviceMismatch: 411, forbidden: 403, unavailableService: 503 },
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
  makeCacheableSignalKeyStore: (keys) => keys,
  Browsers: { macOS: (b) => ['Mac OS', b, '14.4.1'], ubuntu: (b) => ['Ubuntu', b, '22.04.4'], windows: (b) => ['Windows', b, '10.0.22631'], baileys: (b) => ['Baileys', b, '6.5.0'], appropriate: (b) => ['Mac OS', b, '14.4.1'] },
  jidDecode,
  jidEncode: (user, server, device) => user + (device ? ':' + device : '') + '@' + server,
  jidNormalizedUser,
  areJidsSameUser: (a, b) => jidNormalizedUser(a) === jidNormalizedUser(b),
  isJidGroup: (jid) => (jid || '').endsWith('@g.us'),
  isJidBroadcast: (jid) => (jid || '').endsWith('@broadcast'),
  isJidUser: (jid) => (jid || '').endsWith('@s.whatsapp.net'),
  S_WHATSAPP_NET: '@s.whatsapp.net',
  generateMessageID: newId,
  downloadMediaMessage: async (msg) => {
    const m = unwrap(msg && msg.message) || {};
    const inner = m.imageMessage || m.videoMessage || m.stickerMessage || m.documentMessage || {};
    const d = inner._mockData;
    return d ? Buffer.from(String(d).split(',').pop(), 'base64') : Buffer.alloc(0);
  },
  downloadContentFromMessage: async function* (content) {
    const d = content && content._mockData;
    yield d ? Buffer.from(String(d).split(',').pop(), 'base64') : Buffer.alloc(0);
  },
  getContentType: (m) => m ? Object.keys(m).find(k => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage') : undefined,
  normalizeMessageContent: (m) => unwrap(m),
  extractMessageContent: (m) => unwrap(m),
  proto: { Message: { fromObject: (o) => o, create: (o) => o } },
  generateWAMessageFromContent: (jid, content) => ({ key: { remoteJid: jid, fromMe: true, id: newId() }, message: content }),
  generateWAMessageContent: async (content) => content,
  prepareWAMessageMedia: async (m) => m,
  WAMessageStubType: {},
  delay: (ms) => new Promise(r => setTimeout(r, ms))
};
module.exports.default = makeWASocket;
