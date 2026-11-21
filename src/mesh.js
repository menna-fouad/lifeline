/*
 * LIFELINE mesh logic.
 * Pure JavaScript with no browser APIs, so it runs in the browser
 * (as window.Mesh) and in Node for tests (via require).
 *
 * A message is 8 fields joined by "|". For example:
 *
 *   S|7KQ07|W|2|K|4wsD45nw|5|M3P
 *
 *   TYPE   S an SOS, R a reply from a rescue post, K "I am safe now",
 *          Q a question from the rescue post, D the phone's automatic answer
 *   ID     who sent it: their 3-character phone ID, then a 2-digit counter
 *   A, B   meaning depends on TYPE:
 *            S   problem code (see PROBLEMS), number of people
 *            R   reply code (see REPLIES), minutes until help arrives
 *            K   both "-"
 *            Q   what is asked (see QUESTIONS: W water, M can you move, B battery), which try this is (1 to 9)
 *            D   what is being answered, the answer (see describeAnswer)
 *   FLAGS  who is with them: K kids, E elderly, P pets, or "-" for nobody.
 *          A also means "sent automatically by Home Watch". On a D it is the
 *          try number of the question being answered.
 *   LOC    the sender's GPS position packed into 8 characters, or "-"
 *   TTL    hops left before phones stop passing it on (0 to 9)
 *   PATH   the phones that already relayed it, 3 characters each, in order
 *
 * So the example reads: phone 7KQ's 7th message, trapped by water, 2 people,
 * kids with them, 5 hops left, and M3P has already passed it on once.
 */
(function (root) {
  'use strict';

  const DEFAULT_TTL = 6;
  const SEEN_TTL_MS = 60000;
  // A phone that relays an SOS keeps a copy and chirps it again on this schedule,
  // in case nothing was in range the first time. Carried for 15 minutes, so someone
  // walking out of a dead zone takes the message with them.
  const CARRY_MS = 15 * 60000;
  const CARRY_SCHEDULE = [20000, 45000, 90000, 150000];
  const FAST_RETRY_MS = 12000;                               // questions, answers, replies: try again after about 12 to 15 s

  const PROBLEMS = {
    // rate is how fast this gets worse, in score per minute of waiting.
    P: { label: 'Medical device has no power', short: 'Medical device', score: 100, rate: 3, icon: '🔌' },
    I: { label: 'Injured', short: 'Injured', score: 80, rate: 2, icon: '🩹' },
    W: { label: 'Trapped by water', short: 'Trapped by water', score: 70, rate: 1.5, icon: '🌊' },
    M: { label: 'Need medication', short: 'Medication', score: 50, rate: 1, icon: '💊' },
    X: { label: 'Other emergency', short: 'Other', score: 40, rate: 1, icon: '❗' },
  };

  const FLAGS = {
    K: { label: 'Kids', score: 15, icon: '🧒' },
    E: { label: 'Elderly', score: 15, icon: '🧓' },
    P: { label: 'Pets', score: 0, icon: '🐾' },
  };

  const REPLIES = {
    H: 'Help is coming',
    B: 'A boat is coming',
    A: 'Medics are coming',
  };

  // What the rescue post can ask a phone that sent an automatic alert. The phone
  // answers from its own sensors, with nobody touching it.
  const QUESTIONS = {
    W: 'How high is the water?',
    M: 'Can you move?',
    B: 'How much battery is left?',
  };
  const AUTO_FLAG = 'A';
  const isAuto = (msg) => !!msg && typeof msg.flags === 'string' && msg.type === 'S' && msg.flags.includes(AUTO_FLAG);

  // An answer in words: W gives inches, M gives Y or N.
  function describeAnswer(code, b) {
    if (code === 'W') {
      const inches = parseInt(b, 10);
      if (isNaN(inches)) return 'Water level unknown';
      if (inches <= 0) return 'No water in the house yet';
      return `Water is ${inches} in deep`;
    }
    if (code === 'M') return b === 'Y' ? 'Can move' : b === 'N' ? 'Cannot move' : 'Movement unknown';
    if (code === 'B') return /^[0-9]{1,3}$/.test(b) ? `Battery at ${b}%` : 'Battery unknown';
    return '';
  }

  // Phone IDs use letters and digits that can't be mixed up (no 0/O, 1/I/L).
  const ID_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const ID_LEN = 3;
  function randomId(rand) {
    rand = rand || Math.random;
    let id = '';
    for (let i = 0; i < ID_LEN; i++) id += ID_CHARS[Math.floor(rand() * ID_CHARS.length)];
    return id;
  }

  // GPS position in 8 characters: latitude and longitude to 4 decimals (about 11 m),
  // each shifted to a positive whole number and written in base 62 (4 characters each).
  const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function toB62(n, len) {
    let out = '';
    for (let i = 0; i < len; i++) { out = B62[n % 62] + out; n = Math.floor(n / 62); }
    return out;
  }
  function fromB62(str) {
    let n = 0;
    for (const c of str) { const v = B62.indexOf(c); if (v < 0) return NaN; n = n * 62 + v; }
    return n;
  }
  function packLocation(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return '-';
    const a = Math.round((Math.max(-90, Math.min(90, lat)) + 90) * 1e4);
    const b = Math.round((Math.max(-180, Math.min(180, lon)) + 180) * 1e4);
    return toB62(a, 4) + toB62(b, 4);
  }
  function unpackLocation(loc) {
    if (!/^[0-9A-Za-z]{8}$/.test(loc || '')) return null;
    const a = fromB62(loc.slice(0, 4)), b = fromB62(loc.slice(4));
    const lat = a / 1e4 - 90, lon = b / 1e4 - 180;
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
    return { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 };
  }

  // Distance in meters between two points.
  function distanceM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Named areas, used only as reference points ("near Ybor City") and map labels.
  const NEIGHBORHOODS = {
    '1': { name: 'University Area (USF)', lat: 28.0587, lon: -82.4139 },
    '2': { name: 'Temple Terrace', lat: 28.0353, lon: -82.3893 },
    '3': { name: 'Seminole Heights', lat: 28.0050, lon: -82.4600 },
    '4': { name: 'Ybor City', lat: 27.9606, lon: -82.4410 },
    '5': { name: 'Davis Islands', lat: 27.9180, lon: -82.4530 },
    '6': { name: 'Westshore', lat: 27.9500, lon: -82.5250 },
    '7': { name: 'Brandon', lat: 27.9378, lon: -82.2859 },
    '8': { name: "Town 'n' Country", lat: 28.0106, lon: -82.5770 },
  };

  function encode(m) {
    return [
      m.type,
      m.id,
      m.a || '-',
      m.b === undefined || m.b === null || m.b === '' ? '-' : String(m.b),
      m.flags || '-',
      m.loc || '-',
      String(m.ttl),
      m.path || '',
    ].join('|');
  }

  function decode(text) {
    if (typeof text !== 'string') return null;
    const f = text.trim().split('|');
    if (f.length !== 8) return null;
    const [type, id, a, b, flags, loc, ttlStr, path] = f;
    if (type !== 'S' && type !== 'R' && type !== 'K' && type !== 'Q' && type !== 'D') return null;
    if (!new RegExp('^[' + ID_CHARS + ']{' + ID_LEN + '}[0-9]{2}$').test(id)) return null;
    if (!/^[0-9]$/.test(ttlStr)) return null;
    if (!new RegExp('^([' + ID_CHARS + ']{' + ID_LEN + '}){0,9}$').test(path)) return null;
    if (type === 'S' && !PROBLEMS[a]) return null;
    if (type === 'R' && !REPLIES[a]) return null;
    if ((type === 'Q' || type === 'D') && !QUESTIONS[a]) return null;
    return { type, id, a, b, flags, loc, ttl: parseInt(ttlStr, 10), path };
  }

  // A question or answer is told apart by what it asks and which try it is, so asking
  // again is not mistaken for a copy of the first ask.
  function keyOf(msg) {
    if (msg.type === 'Q') return 'Q' + msg.id + msg.a + msg.b;
    if (msg.type === 'D') return 'D' + msg.id + msg.a + msg.flags;
    return msg.type + msg.id;
  }

  function originOf(msg) {
    return msg.id.slice(0, ID_LEN);
  }

  // The phones a message passed through, as a list of IDs.
  function hopsOf(msg) {
    const out = [];
    for (let i = 0; i < msg.path.length; i += ID_LEN) out.push(msg.path.slice(i, i + ID_LEN));
    return out;
  }

  // The phone whose chirp was actually heard: the last relay, or the sender itself.
  function lastHopOf(msg) {
    const hops = hopsOf(msg);
    return hops.length ? hops[hops.length - 1] : originOf(msg);
  }

  function nearestArea(p) {
    let best = null;
    for (const h of Object.values(NEIGHBORHOODS)) {
      const d = distanceM(p, h);
      if (!best || d < best.d) best = { name: h.name, d };
    }
    return best;
  }

  // { lat, lon, near } or null. "near" is a named area within 6 km, if any.
  function locationOf(loc) {
    const p = unpackLocation(loc);
    if (!p) return null;
    const n = nearestArea(p);
    return Object.assign(p, { near: n && n.d < 6000 ? n.name : null });
  }

  // Requests close together are one job for one boat. Greedy clustering from the
  // most urgent outwards: items need { lat, lon, people, score }.
  function groupRequests(items, radiusM) {
    const r = radiusM || 400;
    const left = items.slice().sort((a, b) => b.score - a.score);
    const groups = [];
    while (left.length) {
      const lead = left.shift();
      const g = { lead, items: [lead], people: lead.people || 0 };
      for (let i = left.length - 1; i >= 0; i--) {
        if (distanceM(lead, left[i]) <= r) {
          g.items.push(left[i]);
          g.people += left[i].people || 0;
          left.splice(i, 1);
        }
      }
      g.items.sort((a, b) => b.score - a.score);
      g.score = g.items[0].score;
      g.spreadM = Math.max(0, ...g.items.map((x) => distanceM(lead, x)));
      groups.push(g);
    }
    return groups;
  }

  // Does this phone have a household profile worth sending?
  function hasProfile(profile) {
    return !!(profile && parseInt(profile.people, 10) >= 1);
  }

  // A saved household ("2 of us, kids and a dog") turned into the B and FLAGS
  // fields of an SOS, so nobody retypes it while water is coming in.
  function sosFromProfile(profile) {
    const p = profile || {};
    let people = parseInt(p.people, 10);
    if (!(people >= 1)) people = 1;
    if (people > 5) people = 5;
    const flags = String(p.flags || '').split('').filter((c) => FLAGS[c]).join('') || '-';
    return { b: String(people), flags };
  }

  function urgencyScore(msg, firstHeardMs, nowMs) {
    if (!msg || msg.type !== 'S') return 0;
    let s = (PROBLEMS[msg.a] || PROBLEMS.X).score;
    const flags = msg.flags && msg.flags !== '-' ? msg.flags : '';
    for (const c of flags) if (FLAGS[c]) s += FLAGS[c].score;
    const people = parseInt(msg.b, 10);
    if (!isNaN(people)) s += people * 5;
    // A dying medical device gets critical faster than someone waiting on a roof.
    const rate = (PROBLEMS[msg.a] || PROBLEMS.X).rate || 1;
    if (firstHeardMs && nowMs) s += Math.floor(((nowMs - firstHeardMs) / 60000) * rate);
    return s;
  }

  /*
   * One device in the mesh. The app feeds it every decoded chirp through
   * handleHeard(), and it answers with events plus, sometimes, a relay to send.
   */
  class MeshNode {
    constructor(opts) {
      this.id = opts.id;                 // this phone's 3-character ID
      this.isRescue = !!opts.isRescue;   // rescue post handles SOS instead of relaying
      this.seenTtlMs = opts.seenTtlMs || SEEN_TTL_MS;
      this.seen = new Map();             // key -> last time seen
      this.pending = new Map();          // key -> relay waiting to be sent
      this.carrying = new Map();         // key -> SOS this phone is still carrying
      this.counter = opts.counter || 0;
    }

    nextId() {
      this.counter = (this.counter % 99) + 1;
      return this.id + String(this.counter).padStart(2, '0');
    }

    isSeen(key, now) {
      const t = this.seen.get(key);
      if (t === undefined) return false;
      if (now - t > this.seenTtlMs) {
        this.seen.delete(key);
        return false;
      }
      return true;
    }

    // Call whenever this device sends its own message (first send or a repeat).
    noteSent(msg, now) {
      this.seen.set(keyOf(msg), now);
    }

    // Hold on to a message after relaying it and chirp it again until the next hop is heard
    // acting on it. An SOS is carried for a long time (the carrier may walk somewhere new);
    // a question or an answer only for a short while, because the conversation moves quickly.
    carry(msg, now) {
      if (this.isRescue || !msg || (msg.type !== 'S' && msg.type !== 'Q' && msg.type !== 'D' && msg.type !== 'R')) return;
      const key = keyOf(msg);
      if (this.carrying.has(key)) return;
      const fast = msg.type !== 'S';
      this.carrying.set(key, {
        msg, text: encode(msg), tries: 0, fast,
        sendAt: now + (fast ? FAST_RETRY_MS + Math.random() * 3000 : CARRY_SCHEDULE[0]),
        until: now + (msg.type === 'S' ? CARRY_MS : 45000),
      });
    }

    carriedCount() { return this.carrying.size; }
    carriedMessages() { return Array.from(this.carrying.values()).map((c) => c.msg); }
    dropCarried(key) { return this.carrying.delete(key); }

    // Carried messages due for another chirp. flushAll ignores the schedule, for
    // when the carrier has arrived somewhere new and wants to offload everything.
    takeCarried(now, flushAll) {
      const out = [];
      for (const [key, c] of this.carrying) {
        if (now > c.until || (c.fast && c.tries >= 3)) { this.carrying.delete(key); continue; }
        if (!flushAll && now < c.sendAt) continue;
        c.tries += 1;
        c.sendAt = now + (c.fast ? FAST_RETRY_MS + Math.random() * 3000 : CARRY_SCHEDULE[Math.min(c.tries, CARRY_SCHEDULE.length - 1)]);
        out.push({ key, text: c.text, msg: c.msg });
      }
      return out;
    }

    // Anything proving a carried message is still moving means we can let it go.
    _reviewCarried(msg, events) {
      if (!this.carrying.size) return;
      for (const [key, c] of this.carrying) {
        const sameCall = c.msg.id === msg.id;
        if (!sameCall) {
          if (msg.type === 'K' && originOf(msg) === originOf(c.msg)) { this.carrying.delete(key); events.push('carryDropped'); }
          continue;
        }
        if (c.msg.type === 'S') {
          // Going up to the post: the post asking a question or replying proves it got the SOS.
          if (msg.type === 'R' || msg.type === 'Q') { this.carrying.delete(key); events.push('carryDelivered'); }
          else if (msg.type === 'S' && msg.path.length > c.msg.path.length) { this.carrying.delete(key); events.push('carryPassedOn'); }
        } else if (c.msg.type === 'Q') {
          // Going down to the phone: its answer (or the post moving on) proves it got the question.
          if (msg.type === 'D' && msg.a === c.msg.a) { this.carrying.delete(key); events.push('carryDelivered'); }
          else if (msg.type === 'R' || (msg.type === 'Q' && msg.a !== c.msg.a)) { this.carrying.delete(key); events.push('carryDelivered'); }
          else if (msg.type === 'Q' && msg.a === c.msg.a && msg.b === c.msg.b && msg.path.length > c.msg.path.length) { this.carrying.delete(key); events.push('carryPassedOn'); }
        } else if (c.msg.type === 'D') {
          // Going up to the post: its next question or its reply proves it got the answer.
          if (msg.type === 'R' || (msg.type === 'Q' && msg.a !== c.msg.a)) { this.carrying.delete(key); events.push('carryDelivered'); }
          else if (msg.type === 'D' && msg.a === c.msg.a && msg.path.length > c.msg.path.length) { this.carrying.delete(key); events.push('carryPassedOn'); }
        }
      }
    }

    // Decide what to do with a decoded chirp.
    handleHeard(text, now, rand) {
      rand = rand || Math.random;
      const msg = decode(text);
      if (!msg) return { events: ['invalid'], msg: null, relay: null };
      const key = keyOf(msg);
      const events = [];
      this._reviewCarried(msg, events);
      const mine = !this.isRescue && originOf(msg) === this.id;

      if (this.isSeen(key, now)) {
        this.seen.set(key, now);
        events.push('duplicate');
        // A phone at the same distance (or farther) already passed it on, so this
        // phone doesn't need to. A copy from closer to the sender doesn't count:
        // it's behind us, and cancelling would break the chain.
        const waiting = this.pending.get(key);
        if (waiting && msg.path.length >= waiting.msg.path.length) {
          this.pending.delete(key);
          events.push('cancelRelay');
        }
        if (mine && msg.type !== 'R' && msg.type !== 'Q' && msg.path.length > 0) events.push('neighborRelayedMine');
        if (this.isRescue && msg.type === 'S') events.push('sosRepeat');
        if (this.isRescue && msg.type === 'Q' && msg.path.length > 0) events.push('questionRelayed');
        if (this.isRescue && msg.type === 'R' && msg.path.length > 0) events.push('replyRelayed');
        return { events, msg, key, relay: null };
      }

      this.seen.set(key, now);

      if (this.isRescue) {
        if (msg.type === 'S') events.push('sos');
        else if (msg.type === 'K') events.push('safe');
        else if (msg.type === 'D') events.push('answer');
        else events.push('ignored');
        return { events, msg, key, relay: null };
      }

      if (mine) {
        if (msg.type === 'R') events.push('reply');
        else if (msg.type === 'Q') events.push('question');
        else if (msg.path.length > 0) events.push('neighborRelayedMine');
        else events.push('ownEcho');
        return { events, msg, key, relay: null };
      }

      if (msg.ttl <= 0) {
        events.push('ttlExpired');
        return { events, msg, key, relay: null };
      }

      const out = Object.assign({}, msg, { ttl: msg.ttl - 1, path: msg.path + this.id });
      const delayMs = 500 + Math.floor(rand() * 2500);
      const relay = { key, text: encode(out), msg: out, delayMs };
      this.pending.set(key, relay);
      events.push('relayScheduled');
      return { events, msg, key, relay };
    }

    // Called when a relay's wait ends. Returns false if it was cancelled.
    takePending(key) {
      if (!this.pending.has(key)) return false;
      this.pending.delete(key);
      return true;
    }
  }

  const api = {
    DEFAULT_TTL, PROBLEMS, FLAGS, REPLIES, NEIGHBORHOODS, ID_CHARS, ID_LEN,
    encode, decode, keyOf, originOf, hopsOf, lastHopOf, randomId,
    packLocation, unpackLocation, locationOf, distanceM, urgencyScore, MeshNode,
    hasProfile, sosFromProfile, groupRequests,
    QUESTIONS, AUTO_FLAG, isAuto, describeAnswer,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Mesh = api;
})(typeof self !== 'undefined' ? self : this);
