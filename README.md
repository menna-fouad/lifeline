# 📡 Lifeline

Send an SOS by sound when cell service goes down.

---

## What is Lifeline?

Lifeline is an offline emergency messaging prototype built for Tampa Bay storm outages. A phone turns an SOS into an audible chirp, nearby phones pick it up and pass it along, and a laptop running as a rescue post can reply through the same relay. Once the app is installed and cached, the entire exchange can run in airplane mode.

---

## ✨ Features

- **Phone-to-phone relay** — Each phone uses its microphone to decode incoming messages and its speaker to forward them. An SOS can carry the emergency type, the number of people affected, and GPS coordinates when available.
- **Two-way messaging** — The rescue post can ask follow-up questions and send replies like “Help is coming.”
- **Rescue post dashboard** — Requests are ranked by emergency type, time spent waiting, and whether children or older adults are present.
- **Home Watch** — A 3D flood demo shows the water rising around a house as power and cell service fail. When the simulated water reaches the occupant’s floor, a four-second countdown starts. The phone sends an SOS unless someone taps **I’m OK**.
- **Offline installation** — Lifeline runs as a Progressive Web App. A service worker caches the app files before the device goes offline.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend and relay logic | JavaScript, HTML, CSS |
| Audio encoding and decoding | ggwave |
| Audio playback and microphone input | Web Audio API, MediaDevices API |
| Offline installation | Service Worker, Web App Manifest |
| 3D flood simulation | Three.js |
| Location and motion | Geolocation API, Device Motion API |

---

## Getting Started

1. Open Lifeline over HTTPS on two phones and a laptop. Choose **A phone** on both phones and **A rescue post** on the laptop. Tap **Start listening** and allow microphone access.
2. Enable **Relay demo** on the laptop. Place one phone between the other phone and the laptop.
3. On the first phone, open **Home Watch → Simulate flood**. Let the countdown finish, then send **Help is coming** from the rescue post once the SOS arrives.

To try it offline, install and open the app on each device while online, then reopen it in airplane mode.

---

## How It Works

The source phone encodes the SOS with ggwave and plays it through its speaker. A relay decodes the chirp, checks the message ID and hop limit, then waits for a quiet moment to send it again. Relays stagger their transmissions so they’re less likely to chirp over each other. When a device hears the next hop forward its message, it can stop repeating it.

The same process carries questions and replies in the other direction. We tested the relay logic in simulation and ran the full SOS exchange in Chrome using recorded audio. Live range and reliability across iPhone and Android still need testing.

---

## What Does Lifeline Solve?

During a Tampa Bay flood, someone can be stuck upstairs with a charged phone and no cell signal. Their phone’s speaker may reach a nearby device even when the rescue post is out of earshot. Lifeline uses those nearby devices to carry the request farther and bring a reply back, using the speakers and microphones people already have.

---

## Built At

Built at **HackJam 2026** for **Best Overall** and **Home Turf**.
