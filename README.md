# Mock Baileys

Test your WhatsApp bot fully offline.

Mock Baileys swaps the real [Baileys](https://github.com/WhiskeySockets/Baileys) library for a fake one **while you test**, and gives you a WhatsApp-style chat page in your browser. Your bot code is not changed at all, and nothing is sent to WhatsApp.

> Unofficial tool. Not affiliated with WhatsApp, Meta or the Baileys project.

## Features

- WhatsApp-style chat page served from inside your bot's process
- Private chats and groups, chat as any test user in a group
- Text, replies, reactions (both directions), edits, deletes, typing indicator
- @mentions with autocomplete (the bot receives a real `mentionedJid` list)
- Images, view-once images, polls (create and vote), buttons (classic and native-flow), list messages
- Call events (the bot's `call` handler fires)
- Profile pictures for users, groups and the bot (`sock.profilePictureUrl()` returns a downloadable URL)
- **Admin panel** to manage test users, groups and group admins (see below)
- Works with CommonJS and ES module bots
- Unsupported things never crash the bot: you get a visible "Unsupported content for now" note instead

## Requirements

- Node.js 18 or newer (Node 20.6+ if your bot uses `import` syntax)
- The `ws` package (`npm i ws`, usually already installed because Baileys depends on it)

## Install

1. Copy the `mock-baileys` folder into your bot's main folder, next to `main.js` and `node_modules`.
2. In your bot's folder run:
   ```
   npm i ws
   ```
3. Tell your bot who the owner is. In the mock, **you** are `27111111111` and the bot runs as `27000000000`. If any commands are owner-only, put `27111111111` in your bot's owner config while testing (or change it, see [Settings](#settings)).
4. Use a copy of your database / data folder if you can. Only WhatsApp is faked; your bot still reads and writes its own files.

## Run

**CommonJS bot (`require`):**
```
node --require ./mock-baileys/hook.js main.js
```

**ES module bot (`import`, `"type": "module"`):**
```
node --require ./mock-baileys/hook.js --import ./mock-baileys/register.mjs main.js
```

You should see:
```
[mock-baileys] Baileys intercepted. Open http://localhost:3000
[mock-baileys] Mock WhatsApp UI ready: http://localhost:3000
```

Open **http://localhost:3000**. The top left says "Connected to bot process". Pick a chat and type a command like on WhatsApp.

The page lives inside your bot's process, so it only works while the bot is running. If you restart the bot, the page reconnects by itself.

To go back to real WhatsApp, start the bot normally (`node main.js`). Nothing needs to be edited or uninstalled.

## Using the chat page

| Thing | How |
|---|---|
| Send a text / command | Type and press Enter |
| Switch chats | Click a chat on the left |
| Chat as a different person in a group | Dropdown beside the message box |
| Reply | Hover a bubble, click ↩ |
| React | Hover a bubble, click 😀. Reactions the bot sends appear as a green-outlined chip |
| Mention someone in a group | Type `@` and pick from the list, or press the **@** button |
| Send an image | 📎 then Send (type a caption first if you want) |
| Send a view-once image | 📎, click **👁 1×**, then Send |
| Create a poll | 📊 |
| Vote in the bot's poll | Click an option |
| Press a bot button / list row | Click it |
| Call the bot | 📞 |
| Open the admin panel | **⚙ Admin** |

## Admin panel

Click **⚙ Admin** (top left, or ⚙ in the chat header).

**Users**
- Add test users by name and number, or press **+ Quick add** for the next free number
- Rename or remove users (removing also takes them out of every group)
- Set or remove a profile picture for any user and for the bot

**Groups**
- Create, rename and delete groups, edit the description, set a group picture
- Toggle "Only admins can send messages" and "Only admins can edit group info"
- Set every member to **member / admin / superadmin**, or remove them
- Add one user or **Add everyone**. The bot is in the list too, so you can make it admin, demote it, or remove it to test "bot is not admin" paths

**Settings**
- **Tell the bot about changes made here** (on by default). When on, panel changes fire the same events real WhatsApp would:

  | Panel action | Event your bot receives |
  |---|---|
  | add / remove / promote / demote a member | `group-participants.update` |
  | rename, description, announce / restrict toggles | `groups.update` |
  | new group | `groups.upsert` |
  | new user | `contacts.upsert` |

  Turn it off to set things up silently.
- Reset everything to defaults

Everything you set up is saved in `mock-baileys/data/state.json` and restored the next time you start the bot. Add this to your `.gitignore`:
```
mock-baileys/data/
```

### Profile pictures

`sock.profilePictureUrl(jid)` returns a real URL such as `http://127.0.0.1:3000/pfp/27222222222.jpg?v=...` that your bot can download with `fetch`, `axios`, etc. If the user has no picture it returns `null`. Real WhatsApp throws an error in that case, so if your bot depends on that error it still needs its own try/catch.

## Settings

Set these as environment variables before the command.

| Variable | Default | Meaning |
|---|---|---|
| `MOCK_PORT` | `3000` | Port for the chat page |
| `MOCK_BOT_NUMBER` | `27000000000` | The bot's fake number |
| `MOCK_USER_NUMBER` | `27111111111` | Your fake number (set this as owner in your bot) |
| `MOCK_TARGETS` | (empty) | Extra package names to swap, comma separated, e.g. your Baileys fork |
| `MOCK_DATA_DIR` | `mock-baileys/data` | Where the admin panel saves users, groups and pictures |

Linux / macOS:
```
MOCK_USER_NUMBER=27821234567 node --require ./mock-baileys/hook.js main.js
```

Windows PowerShell:
```
$env:MOCK_USER_NUMBER="27821234567"; node --require ./mock-baileys/hook.js main.js
```

If you change the numbers later, saved users and groups are updated to match automatically.

## What the bot can send (and the page shows)

Text, replies, mentions, images, polls, buttons, list messages, reactions, edits, deletes, "typing…", group changes (add / remove / promote / demote, subject, description, settings), call-reject notes and more.

If the bot sends something the mock can't draw, the page shows **"⚠ Unsupported content for now"**. If the bot calls a Baileys function the mock doesn't have, it never crashes: you get a grey line such as `Unsupported content for now: sock.somethingNew()` and the bot carries on. Open an issue with what showed up and it can be added.

## What stays real

Only WhatsApp is faked. Web requests, APIs, databases and files still work normally. Turn those off or point them at test data if you don't want them running while you test.

## Project layout

```
mock-baileys/
  config.js        settings (numbers, port, data folder)
  hook.js          swaps Baileys for the fake (CommonJS bots)
  register.mjs     extra loader, only for bots that use `import`
  esm-loader.mjs   (used by register.mjs)
  fake-esm.mjs     (used by register.mjs)
  fake.js          the fake Baileys library
  server.js        local server: chat page, admin panel, saved state
  ui/index.html    the chat page and admin panel
  data/            created automatically (saved users, groups, pictures)
```

## Troubleshooting

- **"Missing dependency ws"**: run `npm i ws` in the bot folder.
- **"Port 3000 is busy"**: use `MOCK_PORT=3001` (or any free port) and open that port instead.
- **Page says "Waiting for the bot to start…"**: the bot isn't running with the mock flags, or it crashed. Check the terminal.
- **Bot starts but behaves like the real thing / tries to log in**: your Baileys package has a different name. Add it with `MOCK_TARGETS=your-package-name`.
- **`import` errors or the fake isn't picked up in an ES module bot**: add `--import ./mock-baileys/register.mjs` (needs Node 20.6+).
- **Commands say "owner only"**: set your owner number in the bot to the mock user number (default `27111111111`).
- **Admin panel changes don't reach the bot**: make sure "Tell the bot about changes made here" is ticked in Settings and your bot listens for `group-participants.update` / `groups.update`.
- **Messages from the bot don't appear**: look for a grey "Unsupported content" line, or check the terminal for errors from your own code.
