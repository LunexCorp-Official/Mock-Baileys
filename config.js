// Settings for the mock. Override with environment variables if you like.
const path = require('path');
const BOT_NUMBER = process.env.MOCK_BOT_NUMBER || '27000000000';   // the number your bot runs on
const USER_NUMBER = process.env.MOCK_USER_NUMBER || '27111111111'; // YOU in the mock (set this as owner in your bot)
const PORT = Number(process.env.MOCK_PORT || 3000);

module.exports = {
  PORT,
  // Address the BOT uses to reach the mock's own web server (profile pictures are served from here).
  ORIGIN: 'http://127.0.0.1:' + PORT,
  // Where the admin panel saves users / groups / pictures so they survive restarts.
  DATA_DIR: process.env.MOCK_DATA_DIR || path.join(__dirname, 'data'),
  BOT_NUMBER,
  USER_NUMBER,
  BOT_JID: BOT_NUMBER + ':1@s.whatsapp.net',
  BOT_NUMBER_JID: BOT_NUMBER + '@s.whatsapp.net',
  USER_JID: USER_NUMBER + '@s.whatsapp.net',
  GROUP_JID: '120363000000000001@g.us',
  // Extra package names to intercept (comma separated), e.g. your Baileys fork
  EXTRA_TARGETS: (process.env.MOCK_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean)
};
