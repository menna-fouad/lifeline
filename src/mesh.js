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

    const api = {
        DEFAULT_TTL, PROBLEMS, FLAGS, REPLIES, ID_CHARS, ID_LEN, encode, decode, keyOf, originOf, hopsOf, lastHopOf, randomId,
    };

    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.Mesh = api;
})(typeof self !== 'undefined' ? self : this);
