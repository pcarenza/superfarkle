# Super Farkle

A real-time multiplayer Farkle dice game with 3D dice, for the browser and
Android. Same stack as [Aggravation](https://github.com/pcarenza/aggravation):
a Node/socket.io server that owns the rules, a three.js client, and a
[Capacitor](https://capacitorjs.com) wrapper for the Android app.

- 2–6 players per room, with a 4-letter room code or invite link
- Computer players can fill empty seats. If someone disconnects, a computer
  plays for them until they come back (refreshing the page reconnects you).
- The server is authoritative: it rolls the dice and validates every selection.
  Clients only animate the result, so everyone sees the same roll.
- Pick your own color from 11 in the lobby (no two players can share one); your choice is remembered. The dice take the color of whoever is rolling, and White gives the classic ivory dice.
- Chat with quick reactions in the lobby and during the game.
- Optional **voice chat** (🎤 button): players opt in, the microphone stays off until
  they tap Join, and audio goes peer-to-peer (WebRTC); the server only relays the
  connection setup. Works in the lobby and in games, with mute, per-player mute and
  a speaking indicator. See "Voice chat setup" below.

## Running it

```bash
npm install
npm start          # http://localhost:3000  (set PORT to change)
npm test           # rules engine tests
```

## Hosting it on Render (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/pcarenza/superfarkle)

1. Click the button above (or in Render: **New → Blueprint** and pick this repo).
2. Click **Deploy Blueprint**. `render.yaml` sets up Node 22, `npm ci`,
   `npm start` and the free plan.
3. Open the `https://superfarkle-xxxx.onrender.com` URL Render shows you. If it
   is not exactly `https://superfarkle.onrender.com`, build the Android app
   with `FARKLE_SERVER=<your url>` (see below).

Free-plan notes: the server sleeps after ~15 minutes without visitors and the
first visit afterwards can take up to a minute. Games live in memory, so a
redeploy or restart ends games in progress.

## Android app

Every push builds an APK with GitHub Actions (`.github/workflows/android.yml`)
and publishes it as **superfarkle.apk** on the `android-latest` release, together
with **superfarkle.aab**, the app bundle that Google Play Console asks for (upload
it only from a build signed with your real keystore).

- The app bundles the client and plays on the hosted server
  (`https://superfarkle.onrender.com`, override with `FARKLE_SERVER` when
  building). App and website players share the same rooms.
- Extras in the app: the screen stays awake during a game and the phone buzzes
  on your turn and on a farkle.
- Signing: add repository secrets `ANDROID_KEYSTORE_BASE64` and
  `ANDROID_KEYSTORE_PASSWORD` (key alias `superfarkle`) so every build is signed
  with the same key and installs over the last one. Without them a throwaway key
  is used. Never commit keystores.
- Build locally (Android SDK + JDK 21): `npm run build:app`, then
  `cd android && ./gradlew assembleRelease`.
- Rule changes only need a server deploy; client changes (`public/`, `shared/`)
  need a new APK. Icons and splash screens: `python3 scripts/make-icons.py` (needs Pillow) regenerates them from the artwork in `store/`.

## How to play

- On your turn roll six dice. Tap the dice that score to keep them, then
  **roll the rest** or **bank** your turn total.
- **Farkle:** a roll with no scoring dice loses everything from that turn.
- **Hot dice:** score with all six and roll all six again.
- By default your first banked turn needs at least **500** to get on the board (the host can switch this off in the lobby).
- **High Stakes mode** (a host option): once every player is on the board, whenever
  someone banks, the next player may roll the dice that player left behind (all six
  after hot dice). If the roll scores they add the previous player's whole turn
  total to their own and can bank or keep rolling; if not, it's a farkle and they
  lose their turn. They can also pass and play a normal turn. Stakes can chain.
- First to the target (10,000 or 5,000, chosen by the host) triggers a final
  round: everyone else gets one more turn to beat them.

The host picks the scoring rules in the lobby. Everything below is shared:
single 1 = 100, single 5 = 50, straight 1–6 = 1,500, three pairs = 1,500,
four of a kind + a pair = 1,500, two triplets = 2,500, three 2s–6s = 200–600.

| Rule set | Three 1s | Four / five / six of a kind |
|---|---|---|
| **Hybrid** (default) | 1,000 | 1,000 / 2,000 / 3,000 |
| **Classic** | 1,000 | 2x / 3x / 4x the triple (four 1s = 2,000, four 4s = 800) |
| **Farkle 2.0** | 300 | 1,000 / 2,000 / 3,000 |

Rule sets live in `shared/config.js` (`SCORING`); the engine is `shared/rules.js`.

## Moderation: block and report

Players can tap a name in the chat, the voice list or the lobby to **block** (hides their chat,
mutes their voice, remembered on the device by an anonymous player ID) or **report** them.
Reports are written to the server log as a single `[REPORT]` line (reason, optional note,
the last 10 chat messages, and both players' names and anonymous IDs). Read them in Render:
your service -> Logs -> search for `REPORT`. Nothing is stored in a database, so Render's
log retention applies. The rules players agree to are in `public/terms.html`
(`/terms.html`).

## Store assets

`store/` holds the Google Play artwork: the 512px icon, feature graphic, adaptive-icon
layers and phone screenshots. The privacy policy page is `public/privacy.html`
(served at `/privacy.html`).

## Voice chat setup

Voice works out of the box between most players using a free public STUN server.
Players on strict networks (some mobile carriers, offices, schools) also need a TURN
relay. Any TURN provider works. Set `ICE_SERVERS` in Render (your service ->
Environment, never in the repo) to a one-line JSON list. For example with Metered
(use the exact server URLs and the username/credential from your Metered dashboard):

```
ICE_SERVERS=[{"urls":["turn:global.relay.metered.ca:80","turn:global.relay.metered.ca:80?transport=tcp","turn:global.relay.metered.ca:443","turns:global.relay.metered.ca:443?transport=tcp"],"username":"USER","credential":"SECRET"}]
```

Notes: TURN credentials are sent to every player's browser (that is how TURN works),
so use a credential dedicated to this game that you can revoke, and watch your
provider's usage. Relay traffic counts against your provider plan.

Alternatively, **Cloudflare Realtime TURN** is supported without static credentials:
set `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` and the server fetches short-lived ones
(`POST /v1/turn/keys/<key id>/credentials/generate-ice-servers`, cached for 6 hours).
Check Cloudflare's current pricing and plan requirements first. If a relay is
unreachable the server falls back to STUN only and logs why.

Up to 8 people can be in a room's voice chat at once (a full mesh: each device connects
to every other, which is fine for audio).

The Android app declares the `RECORD_AUDIO` permission and asks for it only when a
player taps Join voice. The privacy policy (`public/privacy.html`) describes voice
chat; update your Google Play Data safety answers to match.
