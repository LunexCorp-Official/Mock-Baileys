// Only needed if your bot uses `import ... from '@whiskeysockets/baileys'` (ESM).
// Run with:  node --require ./mock-baileys/hook.js --import ./mock-baileys/register.mjs main.js
import { register } from 'node:module';
register('./esm-loader.mjs', import.meta.url);
