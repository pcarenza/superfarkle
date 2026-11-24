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
- Chat with quick reactions in the lobby and during the game.

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
and publishes it as **superfarkle.apk** on the `android-latest` release.

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
  need a new APK. Icons: `python3 scripts/make-icons.py` (needs Pillow).

## How to play

- On your turn roll six dice. Tap the dice that score to keep them, then
  **roll the rest** or **bank** your turn total.
- **Farkle:** a roll with no scoring dice loses everything from that turn.
- **Hot dice:** score with all six and roll all six again.
- Your first banked turn needs at least **500** to get on the board.
- First to the target (10,000 or 5,000, chosen by the host) triggers a final
  round: everyone else gets one more turn to beat them.

| Dice | Points | Dice | Points |
|---|---|---|---|
| Single 1 | 100 | Straight 1–6 | 1,500 |
| Single 5 | 50 | Three pairs | 1,500 |
| Three 1s | 1,000 | Four of a kind + pair | 1,500 |
| Three 2s–6s | 200–600 | Two triplets | 2,500 |
| Four of a kind | 1,000 | Five of a kind | 2,000 |
| Six of a kind | 3,000 | | |

Scoring and options live in `shared/rules.js` and `shared/config.js`.
