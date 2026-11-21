# Lifeline

SOS messages that travel phone to phone by sound when there's no cell signal.
A phone chirps a short coded SOS, nearby phones hear it and chirp it again, and the
message hops along until it reaches a rescue post, which chirps a reply back down the chain.
No server, no Wi-Fi, no internet once it's installed.

Built for HackJam 2026 (Home Turf track). Sound is sent and decoded with
[ggwave](https://github.com/ggerganov/ggwave) (MIT license), bundled in `vendor/ggwave.js`.

## Structure

```
index.html              the whole UI shell, all screens
sw.js                   offline caching (must stay at the root)
manifest.webmanifest    makes it installable as an app
src/
  mesh.js               message format, relay rules, urgency scoring
  sound.js              audio: chirp encoding, decoding, channel timing
  watch.js              Home Watch: the flood simulator, fall detection, automatic SOS
  app.js                phone screens and the rescue post
scene/
  scene3d.src.js        the 3D flood diorama (Three.js), source for vendor/scene3d.js
  entry.js              build entry
styles/
  style.css             design tokens and every screen's layout
vendor/
  ggwave.js             data-over-sound library (MIT)
  scene3d.js            built from scene/ with Three.js (MIT), loaded only when Home Watch opens
assets/
  icon-192.png  icon-512.png
  fonts/
tests/
  mesh.test.js          relay simulation
```

`sw.js` and `index.html` have to sit at the root. A service worker can only
control pages in its own folder and below, and GitHub Pages serves `index.html`
from the root.

## Put it online with GitHub Pages (no command line needed)

Phones only allow the microphone on `https://` pages, and GitHub Pages gives you that for free.

1. Sign in to GitHub and click **New repository**. Name it `lifeline`, set it to **Public**, and create it.
2. On the new repository page, click **uploading an existing file**.
3. Drag in **every file from this folder** (not the folder itself) and click **Commit changes**.
4. Go to **Settings → Pages**. Under **Branch**, pick `main` and `/ (root)`, then **Save**.
5. Wait a minute or two. Your app is live at `https://YOUR-USERNAME.github.io/lifeline/`.

To update it later, upload the changed files the same way; they replace the old ones.

## Install on each phone

1. Open the link in **Safari** (iPhone) or **Chrome** (Android).
2. Install it: iPhone: **Share → Add to Home Screen**. Android: **⋮ → Add to Home screen / Install app**.
3. Open it from the home screen, tap **Start listening**, and allow the microphone and location.
4. Pick **A phone** and tap **Save**. Each phone gets its own random 3-character ID automatically.
5. Turn the volume up and (iPhone) turn silent mode off.

For the rescue post, open the same link on the laptop and pick **A rescue post**. On a small table, tick **Relay demo** so the laptop only accepts messages another phone has passed on.

To prove it's offline: after installing, switch to airplane mode, then open LIFELINE from the home screen.

## Sound settings (gear icon → Sound settings)

- **Chirp style:** dual-tone fast is the default. If the room is noisy, try "Dual-tone, sturdier". All phones understand every style, so they don't have to match.
- **Chirp loudness:** lower it to shorten how far chirps carry, which is how you force messages to hop through the line instead of jumping straight to the rescue post.
- **Chime:** the short two-note sound before each chirp. Turn it off if you prefer.
- **Send a sound check:** every LIFELINE device that hears it shows "Sound check heard". Use it to find the right spacing.

## Demo tips

- Spread phones in a line a few meters apart with the rescue laptop at the far end. Turn loudness down until each phone only reaches its neighbor.
- One SOS at a time.
- The screen tints **red** while a device is sending and the live line across the top traces every sound it hears, so judges can see each hop.
- Keep phone screens on (the app asks the phone to stay awake, but also set auto-lock to Never for the demo).
- **Backup:** on the rescue post, pressing **D** plays a sample SOS arrival (labelled "(replay)" in the log) if the room is too loud for a live run. Also record a backup video.

## How it works

Message format (8 fields, `|`-separated), for example `S|7KQ07|W|2|K|4wsD45nw|5|X9F`:

| Field | Example | Meaning |
| --- | --- | --- |
| Type | `S` | `S` SOS, `R` reply, `K` I'm safe, `Q` question from the rescue post, `D` the phone's automatic answer |
| ID | `7KQ07` | sender's random 3-character phone ID + counter |
| A | `W` | SOS: problem (`P` medical device, `I` injured, `W` trapped by water, `M` medication, `X` other). Reply: `H` help coming, `B` a boat is coming, `A` medics are coming. Question: what is asked (`W` water level, `M` can you move). Answer: the same code |
| B | `2` | SOS: people (5 = 5+). Reply: arrival minutes. Question: which try (1 to 3). Answer: the value (inches, or `Y` / `N`) |
| Flags | `K` | `K` kids, `E` elderly, `P` pets, `-` none. `A` also marks an SOS sent automatically by Home Watch. On an answer it is the try number being answered |
| Location | `4wsD45nw` | GPS latitude and longitude to 4 decimals (about 11 m), packed into 8 characters, or `-` |
| Hops left | `5` | starts at 6, each relay subtracts 1 |
| Path | `X9F` | IDs of the phones that relayed it, 3 characters each |

Relay rules: every phone ignores messages it has seen in the last 60 seconds, waits a random 0.5 to 3 s
before relaying, waits for quiet before any chirp, and cancels its relay if a phone at the same distance
(or farther) already passed the message on. The SOS phone repeats after 10, 20, 40 s and then every
minute until a reply arrives, and skips a repeat if it just heard a neighbor relay its SOS.

## Home Watch (the flood simulator)

A full-screen 3D scene on the phone: a house surrounded by rising flood water, a stick figure already on the second
floor, a water gauge and a clock that runs six hours of storm in 20 seconds ("Simulate flood"). The power fails, then
the cell towers. When the water reaches the person's floor, or the phone is shaken hard (or falls and goes still), a
4 second countdown starts. If nobody taps "I'm OK" the phone sends an SOS by itself, flagged `A`. The rescue post sees
the flag and asks, by sound, "Can you move?". The phone
answers each question by itself, and the answers appear on the request card. All of it travels through the relay
phone in both directions. There is no manual SOS button: Home Watch is the way a phone asks for help. Chirps are quieter and shorter, and the sender stops repeating while the post is asking questions so devices do not talk over each other.

- The water depth is simulated (a phone cannot feel water). Shake and fall detection use the real accelerometer (press F on a laptop). Battery is real on Android; iPhones do not share it.
- Everything runs on the device. The only file Home Watch loads late is `vendor/scene3d.js`, which the service worker caches.
- If a phone struggles to hear while the 3D scene is open, turn off "3D scene in Home Watch" in settings. The simulator
  still works as a flat screen. After the SOS is sent the scene drops to a low-power mode so the phone can listen.
- Rebuild the scene after editing it: `npm i three esbuild`, then
  `npx esbuild scene/entry.js --bundle --minify --format=iife --outfile=vendor/scene3d.js`.

## Tested

- `mesh.js`: relay through a line of phones and through a crowded cluster (50 of 50 delivered, fewer chirps than flooding), hop limits, duplicate expiry, urgency order.
- Sound: encode and decode of every message type in Node, including recordings at 44.1 kHz and 48 kHz.
- In Chrome (with a recording standing in for the microphone): the rescue post decoded two SOS messages, ranked them and sent a reply; a phone relayed an SOS; a phone sent an SOS, saw a neighbor relay it, then received "Help is coming".
- Home Watch: countdown and automatic SOS, the phone answering two questions through a relayed recording, the rescue post asking and showing the answers, the boat arriving on a reply (all in Chrome, with the 3D scene running in software, which is far slower than a phone GPU).
- **Not yet tested on real phones in a real room. Test iPhone and Android first thing, including hearing while the 3D scene is open.**


## Who talks, who listens (stop-and-wait)

Every message is chirped exactly once, so devices never talk over each other. The table shows who waits for whom.

| Step | Speaker | Repeats until it hears |
| --- | --- | --- |
| 1 | Source phone sends the SOS | the relay phone pass it on |
| 2 | Relay phone passes the SOS on | the post's question or reply |
| 3 | Post asks a question | the relay pass the question on |
| 4 | Relay passes the question on | the source's answer |
| 5 | Source phone answers | the relay pass the answer on |
| 6 | Relay passes the answer on | the post's reply (limited to 3 tries) |
| 7 | Post sends its reply | the relay passing the reply on |

Direction is enforced: a phone ignores any question or reply it hears straight from the post (no relay in the path),
and the post ignores any SOS, answer or safe message it hears straight from a phone. Only relayed copies count.
