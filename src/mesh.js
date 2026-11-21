/*
    * Message Format:
    *   TYPE   S an SOS, R a reply from a rescue post, K "I am safe now"
    *   ID     who sent it: their 3-character phone ID, then a 2-digit counter
    *   A, B   meaning depends on TYPE:
    *            S   problem code (see PROBLEMS), number of people
    *            R   reply code (see REPLIES), minutes until help arrives
    *            K   both "-"
    *   FLAGS  who is with them: K kids, E elderly, P pets, or "-" for nobody
    *   LOC    the sender's GPS position packed into 8 characters, or "-"
    *   TTL    hops left before phones stop passing it on (0 to 9)
    *   PATH   the phones that already relayed it, 3 characters each, in order
    *
 */
(function (root) {
    'use strict';

    const DEFAULT_TTL = 6;
    const SEEN_TTL_MS = 60000;

    const PROBLEMS = {
        P: { label: 'Medical device has no power', short: 'Medical device', score: 100, icon: '🔌' },
        I: { label: 'Injured', short: 'Injured', score: 80, icon: '🩹' },
        W: { label: 'Trapped by water', short: 'Trapped by water', score: 70, icon: '🌊' },
        M: { label: 'Need medication', short: 'Medication', score: 50, icon: '💊' },
        X: { label: 'Other emergency', short: 'Other', score: 40, icon: '❗' },
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

    // Phone IDs use letters and digits that can't be mixed up (no 0/O, 1/I/L).
    const ID_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    const ID_LEN = 3;
    function randomId(rand) {
        rand = rand || Math.random;
        let id = '';
        for (let i = 0; i < ID_LEN; i++) id += ID_CHARS[Math.floor(rand() * ID_CHARS.length)];
        return id;
    }

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
        if (type !== 'S' && type !== 'R' && type !== 'K') return null;
        if (!new RegExp('^[' + ID_CHARS + ']{' + ID_LEN + '}[0-9]{2}$').test(id)) return null;
        if (!/^[0-9]$/.test(ttlStr)) return null;
        if (!new RegExp('^([' + ID_CHARS + ']{' + ID_LEN + '}){0,9}$').test(path)) return null;
        if (type === 'S' && !PROBLEMS[a]) return null;
        if (type === 'R' && !REPLIES[a]) return null;
        return { type, id, a, b, flags, loc, ttl: parseInt(ttlStr, 10), path };
    }

    function keyOf(msg) {
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

    class MeshNode {
        constructor(opts) {
            this.id = opts.id;                 // this phone's 3-character ID
            this.isRescue = !!opts.isRescue;   // rescue post handles SOS instead of relaying
            this.seenTtlMs = opts.seenTtlMs || SEEN_TTL_MS;
            this.seen = new Map();             // key -> last time seen
            this.pending = new Map();          // key -> relay waiting to be sent
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

        // Decide what to do with a decoded chirp.
        handleHeard(text, now, rand) {
            rand = rand || Math.random;
            const msg = decode(text);
            if (!msg) return { events: ['invalid'], msg: null, relay: null };
            const key = keyOf(msg);
            const events = [];
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

                if (mine && msg.type !== 'R' && msg.path.length > 0) events.push('neighborRelayedMine');
                if (this.isRescue && msg.type === 'S') events.push('sosRepeat');

                return { events, msg, key, relay: null };
            }

            this.seen.set(key, now);

            if (this.isRescue) {
                if (msg.type === 'S') events.push('sos');
                else if (msg.type === 'K') events.push('safe');
                else events.push('ignored');
                
                return { events, msg, key, relay: null };
            }

            if (mine) {
                if (msg.type === 'R') events.push('reply');
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
        DEFAULT_TTL, PROBLEMS, FLAGS, REPLIES, ID_CHARS, ID_LEN, encode, decode, keyOf, originOf, hopsOf, lastHopOf, randomId, MeshNode,
    };

    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.Mesh = api;
})(typeof self !== 'undefined' ? self : this);
