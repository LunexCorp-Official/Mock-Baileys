import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const config = require('./config.js');

const TARGETS = [
  '@whiskeysockets/baileys', '@adiwajshing/baileys', '@itsukichan/baileys',
  'baileys', 'baileys-mod', ...config.EXTRA_TARGETS
];

export async function resolve(specifier, context, nextResolve) {
  if (TARGETS.some(t => specifier === t || specifier.startsWith(t + '/'))) {
    return { url: new URL('./fake-esm.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
