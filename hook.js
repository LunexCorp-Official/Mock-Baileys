'use strict';
// Preloaded with:  node --require ./mock-baileys/hook.js main.js
const Module = require('module');
const config = require('./config.js');

const TARGETS = [
  '@whiskeysockets/baileys',
  '@adiwajshing/baileys',
  '@itsukichan/baileys',
  'baileys',
  'baileys-mod',
  ...config.EXTRA_TARGETS
];

function isTarget(request) {
  return typeof request === 'string' &&
    TARGETS.some(t => request === t || request.startsWith(t + '/'));
}

const origLoad = Module._load;
let fake = null;
Module._load = function (request, parent, isMain) {
  if (isTarget(request)) {
    if (!fake) fake = require('./fake.js');
    return fake;
  }
  return origLoad.apply(this, arguments);
};

if (require('worker_threads').isMainThread) console.log('[mock-baileys] Baileys intercepted. Open http://localhost:' + config.PORT);
