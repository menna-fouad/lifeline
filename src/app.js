/*
 * LIFELINE app: phone screens, rescue post and relay scheduling.
 * The relay rules live in mesh.js, the audio lives in sound.js.
 */
(() => {
  'use strict';

  const M = window.Mesh;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const SOUND_CHECK = 'LL-CHECK';

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  const Sound = window.LifelineSound;
  const PROTOCOLS = Sound.PROTOCOLS;
  const DEFAULTS = {
    configured: false,
    role: 'phone',
    pid: '',
    protocol: 'DT_FAST',
    volume: 30,
    chime: true,
    twice: true,
    scene3d: true,
    household: { people: 0, flags: '' },
    counter: 0,
  };
  const S = loadSettings();
  Sound.useSettings(S);
  if (!S.pid || !new RegExp('^[' + M.ID_CHARS + ']{' + M.ID_LEN + '}$').test(S.pid)) { S.pid = M.randomId(); saveSettings(); }

  function loadSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('lifeline.settings') || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveSettings() {
    try { localStorage.setItem('lifeline.settings', JSON.stringify(S)); } catch (e) { /* storage may be blocked */ }
  }


  // ------------------------------------------------------------------
  // App state
  // ------------------------------------------------------------------
  const state = {
    node: null,
    relayed: 0,
    heardCount: 0,
    sos: null,          // phone: active SOS
    queue: new Map(),   // rescue: id -> entry
    nearby: new Map(),
    selected: null,     // rescue: request highlighted on the network picture
    acceptDirect: false,  // phone: id of a device heard directly -> { at, post }
    wakeLock: null,
  };

  function makeNode() {
    state.node = new M.MeshNode({ id: S.role === 'rescue' ? 'ZZZ' : S.pid, isRescue: S.role === 'rescue', counter: S.counter });
  }

  // ------------------------------------------------------------------
  // Words and small UI helpers
  // ------------------------------------------------------------------
  function show(id) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }
  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  let statusTimer = null;
  function setStatus(text, ms) {
    const el = $('#phone-status');
    if (!el || S.role === 'rescue') return;
    el.textContent = text;
    clearTimeout(statusTimer);
    if (ms) statusTimer = setTimeout(() => { el.textContent = 'Listening'; }, ms);
  }
  function flashRx() {
    document.body.classList.add('rx');
    setTimeout(() => document.body.classList.remove('rx'), 600);
  }
  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } }
  function clock(d = new Date()) { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function clockSec(d = new Date()) { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function peopleText(b) {
    if (b === '5') return '5 or more people';
    return b === '1' ? '1 person' : `${b} people`;
  }
  // "Trapped by water, 2 people"
  function problemText(msg) {
    return `${M.PROBLEMS[msg.a].label}, ${peopleText(msg.b)}`;
  }
  // "with kids and elderly people"
  function withText(flags) {
    if (!flags || flags === '-') return '';
    const words = { K: 'children', E: 'elderly people', P: 'pets' };
    const list = flags.split('').filter((c) => words[c]).map((c) => words[c]);
    if (!list.length) return '';
    if (list.length === 1) return `with ${list[0]}`;
    return `with ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  }
  function replyText(code, eta) {
    const base = M.REPLIES[code] || 'Help is coming';
    return eta && eta !== '-' ? `${base}, in about ${eta} minutes` : base;
  }
  const origin = (msg) => M.originOf(msg);
  // "28.0587° N, 82.4139° W"
  function coordText(lat, lon) {
    return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
  }
  function distText(m) {
    return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
  }
  // Short place line: "Near Ybor City" or the coordinates.
  function placeName(loc) {
    const l = M.locationOf(loc);
    if (!l) return 'No location';
    return l.near ? `Near ${l.near}` : coordText(l.lat, l.lon);
  }
  function routeWords(msg) {
    const hops = M.hopsOf(msg);
    if (!hops.length) return 'heard directly';
    if (hops.length === 1) return `passed on by phone ${hops[0]}`;
    return `passed on by phones ${hops.slice(0, -1).join(', ')} and ${hops[hops.length - 1]}`;
  }

  // ------------------------------------------------------------------
  // Location (GPS works without cell signal)
  // ------------------------------------------------------------------
  const geo = { fix: null, state: 'off', watch: null };
  function startGeo() {
    if (!('geolocation' in navigator)) { geo.state = 'unavailable'; renderGeo(); return; }
    if (geo.watch !== null) return;
    if (!geo.fix) geo.state = 'searching';
    renderGeo();
    geo.watch = navigator.geolocation.watchPosition((p) => {
      geo.fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
      geo.state = 'on';
      renderGeo();
      if (S.role === 'rescue' && !document.activeElement.closest('.card')) renderQueue();
    }, (err) => {
      if (err.code === 1) {
        geo.state = 'denied';
        navigator.geolocation.clearWatch(geo.watch);
        geo.watch = null;
      } else if (!geo.fix) geo.state = 'searching';
      renderGeo();
    }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 });
  }
  function geoWords() {
    if (geo.state === 'on' && geo.fix) return { main: coordText(geo.fix.lat, geo.fix.lon), sub: `within ${distText(geo.fix.acc)}`, ok: true };
    if (geo.state === 'searching') return { main: 'Finding your location', sub: '', ok: false };
    if (geo.state === 'denied') return { main: 'Location is off', sub: 'Allow it in your browser settings', ok: false };
    if (geo.state === 'unavailable') return { main: 'No GPS on this device', sub: '', ok: false };
    return { main: 'Location not shared yet', sub: '', ok: false };
  }
  function renderGeo() {
    const w = geoWords();
    const chip = $('#chip-loc');
    if (chip) {
      chip.classList.toggle('warn', !w.ok);
      $('.chip-text', chip).textContent = w.ok ? `${coordText(geo.fix.lat, geo.fix.lon)}` : w.main;
    }
    const st = $('#setup-loc');
    if (st) {
      st.innerHTML = `<span class="setup-value">${esc(w.main)}</span>${w.sub ? `<small>${esc(w.sub)}</small>` : ''}`;
      $('#btn-allow-loc').hidden = w.ok || geo.state === 'searching' || geo.state === 'unavailable';
    }
  }
  async function getLocationCode() {
    if (geo.fix && Date.now() - geo.fix.at < 5 * 60000) return M.packLocation(geo.fix.lat, geo.fix.lon);
    try {
      const p = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 6000, maximumAge: 300000, enableHighAccuracy: true }));
      geo.fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
      geo.state = 'on';
      renderGeo();
      return M.packLocation(geo.fix.lat, geo.fix.lon);
    } catch (e) {
      if (geo.fix) return M.packLocation(geo.fix.lat, geo.fix.lon);
      toast('No location yet. Sending your SOS without it.');
      return '-';
    }
  }

  // ------------------------------------------------------------------
  // The live line: a trace of what the microphone hears
  // ------------------------------------------------------------------
  const lineBuf = { data: null };
  function drawLine(canvas) {
    if (!canvas || !Sound.analyser) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (!lineBuf.data || lineBuf.data.length !== Sound.analyser.fftSize) lineBuf.data = new Float32Array(Sound.analyser.fftSize);
    const data = lineBuf.data;
    Sound.analyser.getFloatTimeDomainData(data);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const sending = Sound.transmitting;
    ctx.strokeStyle = sending ? '#d7261e' : '#1a1f29';
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const mid = h / 2;
    const gain = sending ? 0 : 3.2;
    const step = data.length / w;
    for (let x = 0; x < w; x++) {
      const v = data[Math.floor(x * step)] || 0;
      // Taper at both edges so the line settles into the margins.
      const edge = Math.min(1, x / (w * 0.08), (w - x) / (w * 0.08));
      let y = mid - v * gain * mid * edge;
      if (sending) y = mid - Math.sin((x / w) * Math.PI * 26 + performance.now() / 90) * mid * 0.55 * edge;
      y = Math.max(1, Math.min(h - 1, y));
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ------------------------------------------------------------------
  // Sending and relaying
  // ------------------------------------------------------------------
  // On-screen log of every chirp this device sends (TX) and decodes (RX), for testing.
  let lastTx = '';
  const dbgLines = [];
  function dbg(kind, text) {
    const el = document.getElementById('txlog'); if (!el) return;
    const d = new Date(), t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    dbgLines.push(`${t} ${kind} ${text}`); if (dbgLines.length > 8) dbgLines.shift();
    el.textContent = dbgLines.join('\n');
  }

  function sendOwn(msg, shouldSend) {
    state.node.noteSent(msg, Date.now());
    return Sound.send(M.encode(msg), shouldSend);
  }

  // The phone answers a question and keeps answering until it hears the relay pass the answer on.
  async function answerUntilRelayed(msg) {
    state.answerAck = state.answerAck || new Set();
    const k = msg.id + msg.a;
    state.answerAck.delete(k);
    for (let i = 0; i < 1; i++) {
      const sos = state.sos;
      if (!sos || sos.stage === 'answered' || state.answerAck.has(k)) return;
      await sendOwn(msg, () => !state.answerAck.has(k));
      const wait = 24 + Math.floor(Math.random() * 6);
      for (let w = 0; w < wait && !state.answerAck.has(k); w++) await new Promise((r) => setTimeout(r, 500));
    }
  }

  function scheduleRelay(relay) {
    setTimeout(() => attemptRelay(relay, 0), relay.delayMs);
  }

  function attemptRelay(relay, tries) {
    if (!state.node.pending.has(relay.key)) return; // a nearby phone already passed it on
    if (Sound.channelBusy() && tries < 6) {
      setTimeout(() => attemptRelay(relay, tries + 1), 600 + Math.random() * 1200);
      return;
    }
    if (!state.node.takePending(relay.key)) return;
    state.relayed += 1;
    addPhoneRow(relay.msg);
    vibrate(60);
    Sound.send(relay.text);
    // Hold on to it. If nothing else was in range, this phone carries it onward.
    renderCarrying();
  }

  // ------------------------------------------------------------------
  // Store and forward: a relayed SOS is kept and chirped again later, so a
  // person walking out of a dead zone takes other people's messages with them.
  // ------------------------------------------------------------------
  async function runCarried(flushAll) {
    const due = state.node.takeCarried(Date.now(), flushAll);
    renderCarrying();
    for (const c of due) {
      if (!state.node.carrying.has(c.key)) continue;
      await Sound.send(c.text, () => state.node.carrying.has(c.key));
    }
    renderCarrying();
  }

  function renderCarrying() {
    const box = $('#carrying');
    if (!box) return;
    const msgs = state.node ? state.node.carriedMessages() : [];
    box.hidden = msgs.length === 0;
    if (!msgs.length) return;
    const who = msgs.map((m) => origin(m));
    $('#carry-text').textContent = msgs.length === 1
      ? `Carrying an SOS from ${who[0]}`
      : `Carrying ${msgs.length} messages, from ${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`;
    $('#carry-sub').textContent = 'This phone keeps trying to pass it on. Take it somewhere else and it travels with you.';
  }

  function onDecoded(text) {
    if (text === SOUND_CHECK) {
      flashRx();
      if (S.role === 'rescue') markSound('plain', 'Sound check', '', chirpSeconds(text.length));
      toast('Sound check heard');
      return;
    }
    const now = Date.now();
    dbg('RX', text);
    // Relay demo: the rescue post pretends phones it hears directly are out of range.
    // Checked before the mesh logic so the direct copy isn't marked as seen.
    if (S.role === 'rescue' && !state.acceptDirect) {
      const m = M.decode(text);
      if (m && (m.type === 'S' || m.type === 'K' || m.type === 'D') && m.path === '') { dbg('--', 'ignored (direct from a phone)'); flashRx(); return; }
    }
    // Same rule on the way back: the phone that sent the SOS waits for a reply another phone has
    // passed on, unless the post marked it "D" (direct is fine, used when testing with one phone).
    // Checked before the mesh logic so the direct copy isn't marked as seen.
    if (S.role !== 'rescue' && state.sos) {
      const m = M.decode(text);
      if (m && (m.type === 'R' || m.type === 'Q') && m.id === state.sos.msg.id && m.path === '' && !(m.flags || '').includes('D')) { dbg('--', 'ignored (direct from the post)'); flashRx(); return; }
    }
    const r = state.node.handleHeard(text, now);
    if (r.events.includes('invalid')) return;
    state.heardCount += 1;
    flashRx();
    if (S.role !== 'rescue') noteNearby(r.msg, now);
    if (r.events.some((e) => e.startsWith('carry'))) renderCarrying();
    if (S.role === 'rescue') handleRescue(r, now);
    else handlePhone(r);
  }

  // ------------------------------------------------------------------
  // Phone mode
  // ------------------------------------------------------------------
  // Phones (and the rescue post) this phone has heard directly, for the radar.
  function noteNearby(msg, now) {
    if (!msg) return;
    const hops = M.hopsOf(msg);
    let from, post = false;
    if (hops.length) from = hops[hops.length - 1];
    else if (msg.type === 'R' || msg.type === 'Q') { from = 'POST'; post = true; }
    else from = origin(msg);
    if (from === S.pid) return;
    const prev = state.nearby.get(from);
    state.nearby.set(from, { at: now, post, first: prev ? prev.first : now });
    renderRadar(from);
  }

  // A stable angle for each ID, so a phone keeps its spot on the radar.
  function angleOf(id) {
    let h = 7;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 3600;
    return (h / 3600) * Math.PI * 2;
  }
  function renderRadar(pingId) {
    const box = $('#radar-dots');
    if (!box) return;
    const now = Date.now();
    let html = '';
    for (const [id, n] of state.nearby) {
      const age = now - n.at;
      if (age > 5 * 60000) { state.nearby.delete(id); continue; }
      // Recently heard phones sit on the inner ring and drift outward as time passes.
      const ring = 0.8;
      const a = n.post ? -Math.PI / 2 : angleOf(id);
      const x = 50 + Math.cos(a) * ring * 50, y = 50 + Math.sin(a) * ring * 50;
      const label = n.post ? 'Rescue post' : id;
      html += `<span class="blip${n.post ? ' post' : ''}${id === pingId ? ' ping' : ''}${age > 120000 ? ' old' : ''}" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%"><i></i><b>${esc(label)}</b></span>`;
    }
    box.innerHTML = html;
    const post = state.nearby.get('POST');
    $('#stat-post').textContent = post ? agoText(now - post.at) : 'Not yet';
  }
  function agoText(ms) {
    const m = Math.floor(ms / 60000);
    return m < 1 ? 'Just now' : `${m} min ago`;
  }

  function addPhoneRow(msg) {
    const ul = $('#phone-log');
    const placeholder = ul.querySelector('.placeholder');
    if (placeholder) placeholder.remove();
    let what = '';
    const from = origin(msg);
    if (msg.type === 'S') what = `SOS from ${esc(from)}<small>${esc(problemText(msg))}. ${esc(placeName(msg.loc))}</small>`;
    else if (msg.type === 'R') what = `Reply to ${esc(from)}<small>${esc(replyText(msg.a, msg.b))}</small>`;
    else if (msg.type === 'Q') what = `Question for ${esc(from)}<small>${esc(M.QUESTIONS[msg.a])}</small>`;
    else if (msg.type === 'D') what = `Answer from ${esc(from)}<small>${esc(M.describeAnswer(msg.a, msg.b))}</small>`;
    else what = `${esc(from)} is safe<small>Rescuers are being told</small>`;
    // The route so far: sender, earlier relays, then this phone.
    const before = M.hopsOf(msg).slice(0, -1);
    const start = msg.type === 'R' || msg.type === 'Q' ? 'Post' : from;
    const stops = [{ name: start, cls: msg.type === 'S' ? 'origin' : 'first' }].concat(before.map((h) => ({ name: h, cls: '' }))).concat([{ name: 'You', cls: 'me' }]);
    const li = document.createElement('li');
    li.className = `card ${msg.type === 'S' ? 'is-sos' : msg.type === 'R' || msg.type === 'Q' || msg.type === 'D' ? 'is-reply' : 'is-safe'}`;
    li.innerHTML = `<div class="card-head"><span class="what">${what}</span><span class="time">${clock()}</span></div>
      <ol class="route mini">${stops.map((st) => `<li class="${st.cls}"><i></i><span>${esc(st.name)}</span></li>`).join('')}</ol>`;
    ul.prepend(li);
    while (ul.children.length > 8) ul.lastChild.remove();
    $('#stat-relayed').textContent = state.relayed;
    setStatus(`Passing on a message from ${from}`, 4000);
  }

  function handlePhone(r) {
    const { msg, events } = r;
    if (events.includes('reply') && state.sos && msg.id === state.sos.msg.id) {
      onReply(msg);
      if (window.LifelineWatch) window.LifelineWatch.onReply(msg);
      return;
    }
    if (events.includes('question') && state.sos && msg.id === state.sos.msg.id) {
      if (state.sos.stage !== 'answered') { state.sos.heard = true; state.sos.heardAt = Date.now(); state.sos.qAt = Date.now(); }
      // A new question means the post got the previous answer, so stop repeating it.
      state.answerAck = state.answerAck || new Set();
      Object.keys(M.QUESTIONS).forEach((c) => { if (c !== msg.a) state.answerAck.add(msg.id + c); });
      if (window.LifelineWatch) window.LifelineWatch.onQuestion(msg);
      renderTracker();
      return;
    }
    if (events.includes('neighborRelayedMine') && state.sos && msg.id === state.sos.msg.id) {
      if (msg.type === 'D') { (state.answerAck = state.answerAck || new Set()).add(msg.id + msg.a); }
      if (state.sos.stage !== 'answered') { state.sos.heard = true; state.sos.heardAt = Date.now(); }
      if (window.LifelineWatch) window.LifelineWatch.onRelayed(msg);
      renderTracker();
      return;
    }
    if (events.includes('relayScheduled')) {
      Sound.ping();
      setStatus(`Heard a message from ${origin(msg)}`, 4000);
      scheduleRelay(r.relay);
    }
  }

  const REPEAT_DELAYS = [];   // every message is chirped exactly once

  const flow = { problem: null, people: null, flags: new Set() };

  function showPhonePanel(id) {
    ['#phone-home', '#phone-flow', '#phone-tracker'].forEach((p) => { $(p).hidden = p !== id; });
  }
  // With a household saved, the only thing left to ask is what's wrong.
  const profileReady = () => M.hasProfile(S.household);

  function startFlow() {
    // Everything is on one screen. A saved household fills in people and who is with you.
    const hh = profileReady() ? M.sosFromProfile(S.household) : null;
    flow.problem = null;
    flow.people = hh ? hh.b : null;
    flow.flags = new Set(hh && hh.flags !== '-' ? hh.flags.split('') : []);
    $$('#choices-problem button').forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-checked', 'false'); });
    $$('#choices-people button').forEach((b) => { const on = b.dataset.v === flow.people; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    $$('#choices-flags button').forEach((b) => { const on = flow.flags.has(b.dataset.v); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    updateSendButton();
    showPhonePanel('#phone-flow');
  }
  function updateSendButton() { $('#btn-send-sos').disabled = !(flow.problem && flow.people); }

  async function sendSos(problemOverride, opts) {
    opts = opts || {};
    const id = state.node.nextId();
    S.counter = state.node.counter;
    saveSettings();
    const loc = await getLocationCode();
    // Hold-to-send and automatic alerts use the saved household; the form uses what was filled in.
    const who = ((problemOverride || opts.auto) && profileReady()) ? M.sosFromProfile(S.household)
      : { b: flow.people || '1', flags: Array.from(flow.flags).join('') || '-' };
    const problem = M.PROBLEMS[problemOverride] ? problemOverride : (flow.problem || 'X');
    // An alert Home Watch sent by itself carries the A flag, so the rescue post knows to ask questions.
    const flags = opts.auto ? (who.flags === '-' ? M.AUTO_FLAG : who.flags + M.AUTO_FLAG) : who.flags;
    const msg = { type: 'S', id, a: problem, b: who.b, flags, loc, ttl: M.DEFAULT_TTL, path: '' };
    state.sos = { msg, attempts: 0, heard: false, heardAt: 0, stage: 'chirping', reply: null, timer: null, nextAt: 0, auto: opts.note || '' };
    showPhonePanel('#phone-tracker');
    chirpSos();
  }

  async function chirpSos() {
    const s = state.sos;
    if (!s || s.stage === 'answered') return;
    s.attempts += 1;
    s.chirping = true;
    renderTracker();
    // Skip this repeat if a neighbor just passed the SOS on: it's already traveling,
    // and staying quiet keeps this phone listening for the reply.
    await sendOwn(s.msg, () => state.sos === s && s.stage !== 'answered' && !s.heard);
    if (state.sos !== s) return;
    s.chirping = false;
    if (s.stage === 'chirping') s.stage = 'waiting';
    scheduleRepeat();
    renderTracker();
  }

  function scheduleRepeat() {
    const s = state.sos;
    if (!s || s.stage === 'answered') return;
    clearTimeout(s.timer);
    // Once a nearby phone has picked the SOS up and passed it on, this phone goes quiet for good.
    if (s.heard) { s.nextAt = 0; renderTracker(); return; }
    if (s.attempts > REPEAT_DELAYS.length) { s.nextAt = 0; renderTracker(); return; }   // never repeats
    const delay = REPEAT_DELAYS[s.attempts - 1] * 1000 + Math.random() * 3000;
    s.nextAt = Date.now() + delay;
    s.timer = setTimeout(chirpSos, delay);
  }

  function onReply(msg) {
    const s = state.sos;
    s.stage = 'answered';
    s.heard = true;
    s.reply = { code: msg.a, eta: msg.b };
    clearTimeout(s.timer);
    vibrate([300, 120, 300, 120, 300]);
    renderTracker();
  }

  async function imSafe() {
    const s = state.sos;
    if (!s) return;
    clearTimeout(s.timer);
    state.sos = null;
    if (window.LifelineWatch) window.LifelineWatch.onSafe();
    showPhonePanel('#phone-home');
    toast('Letting rescuers know you are safe');
    await sendOwn({ type: 'K', id: s.msg.id, a: '-', b: '-', flags: '-', loc: '-', ttl: M.DEFAULT_TTL, path: '' });
  }

  function renderTracker() {
    const s = state.sos;
    if (!s) return;
    const m = s.msg;
    const who = withText(m.flags);
    $('#tracker-summary').textContent = `${problemText(m)}${who ? ', ' + who : ''}.`;
    const l = M.locationOf(m.loc);
    $('#tracker-loc').textContent = (s.auto ? s.auto + '. ' : '') + (l ? `Location sent: ${coordText(l.lat, l.lon)}` : 'Sent without a location');
    $('#tracker-head').textContent = s.stage === 'answered' ? 'Rescuers have your SOS' : (s.heard ? 'Your SOS is on its way' : 'Sending your SOS');

    const set = (id, cls) => { const el = $(id); el.classList.remove('active', 'done'); if (cls) el.classList.add(cls); };
    set('#trk-chirp', s.chirping && s.attempts === 1 ? 'active' : 'done');
    set('#trk-heard', s.heard ? 'done' : (!s.chirping || s.attempts > 1 ? 'active' : ''));
    set('#trk-rescue', s.stage === 'answered' ? 'done' : (s.heard ? 'active' : ''));

    const reply = $('#tracker-reply');
    if (s.reply) {
      const main = M.REPLIES[s.reply.code] || 'Help is coming';
      const sub = s.reply.eta && s.reply.eta !== '-' ? `Arriving in about ${esc(s.reply.eta)} minutes. Keep this phone with you.` : 'Rescuers are on their way. Keep this phone with you.';
      reply.innerHTML = `${esc(main)}<small>${sub}</small>`;
      reply.hidden = false;
    } else {
      reply.hidden = true;
    }
    renderRetry();
  }

  function renderRetry() {
    const s = state.sos;
    const el = $('#tracker-retry');
    if (!s) { el.textContent = ''; return; }
    if (s.stage === 'answered') { el.textContent = 'Keep this phone with you and the volume up.'; return; }
    if (s.chirping) { el.textContent = 'Sending now'; return; }
    if (!s.nextAt) { el.textContent = 'Paused to save battery. Open SOS again if you still need help.'; return; }
    const secs = Math.max(0, Math.ceil((s.nextAt - Date.now()) / 1000));
    el.textContent = `Sending again in ${secs} seconds, until someone replies`;
  }

  // ------------------------------------------------------------------
  // Rescue post mode
  // ------------------------------------------------------------------
  function renderCounts() {
    const all = Array.from(state.queue.values());
    const waiting = all.filter((e) => !e.safe && !e.replied).length;
    const answered = all.filter((e) => !e.safe && e.replied).length;
    $('#req-count').textContent = waiting || '';
  }

  // ------------------------------------------------------------------
  // The network picture: every phone the post knows about, laid out by
  // how many hops it is from this post, with each request's route drawn in.
  // ------------------------------------------------------------------
  function openRequests() { return Array.from(state.queue.values()).filter((e) => !e.safe && !e.replied); }

  // ------------------------------------------------------------------
  // Distance radar: this post in the middle, north up, each open request
  // drawn at its real direction and distance (from the GPS inside its SOS).
  // ------------------------------------------------------------------
  // If the laptop can't get its own location (it needs internet for that), assume the post is at USF.
  const POST_DEFAULT = { lat: 28.0587, lon: -82.4139 };
  function postLoc() { return geo.fix ? { lat: geo.fix.lat, lon: geo.fix.lon } : POST_DEFAULT; }

  function bearingDeg(a, b) {
    const r = Math.PI / 180;
    const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
    const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }
  const DIRS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const dirWord = (deg) => DIRS[Math.round(deg / 45) % 8];

  // Ring spacing that reads well: the outer ring is a round number a little past the farthest request.
  const SCALES = [[0.5, [0.125, 0.25, 0.375, 0.5]], [1, [0.25, 0.5, 0.75, 1]], [2, [0.5, 1, 1.5, 2]], [4, [1, 2, 3, 4]], [8, [2, 4, 6, 8]], [12, [3, 6, 9, 12]], [15, [5, 10, 15]], [20, [5, 10, 15, 20]], [40, [10, 20, 30, 40]], [80, [20, 40, 60, 80]], [200, [50, 100, 150, 200]]];
  const kmText = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km % 1 ? km.toFixed(1) : km} km`);

  function renderRadar() {
    const box = $('#radar');
    if (!box) return;
    const home = postLoc();
    const reqs = openRequests().map((e) => {
      const l = M.locationOf(e.msg.loc);
      if (!l) return null;
      const km = M.distanceM(home, l) / 1000;
      return { e, l, km, deg: bearingDeg(home, l) };
    }).filter(Boolean);
    const far = Math.max(0.3, ...reqs.map((r) => r.km));
    const [maxKm, rings] = SCALES.find(([m]) => m >= far * 1.12) || SCALES[SCALES.length - 1];
    const C = 400, R = 330;
    let svg = '';
    rings.forEach((km, i) => {
      const r = (km / maxKm) * R;
      svg += `<circle class="rd-ring${i === rings.length - 1 ? ' outer' : ''}" cx="${C}" cy="${C}" r="${r.toFixed(1)}"/>`;
      svg += `<text class="rd-ring-label" x="${C + 6}" y="${(C - r + 15).toFixed(1)}">${kmText(km)}</text>`;
    });
    for (let d = 0; d < 360; d += 10) {
      const a = (d - 90) * Math.PI / 180, long = d % 90 === 0, r1 = R + 6, r2 = R + (long ? 18 : d % 30 === 0 ? 13 : 9);
      svg += `<line class="rd-tick${long ? ' long' : ''}" x1="${(C + Math.cos(a) * r1).toFixed(1)}" y1="${(C + Math.sin(a) * r1).toFixed(1)}" x2="${(C + Math.cos(a) * r2).toFixed(1)}" y2="${(C + Math.sin(a) * r2).toFixed(1)}"/>`;
    }
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([t, d]) => {
      const a = (d - 90) * Math.PI / 180;
      svg += `<text class="rd-dir${t === 'N' ? ' north' : ''}" x="${(C + Math.cos(a) * (R + 40)).toFixed(1)}" y="${(C + Math.sin(a) * (R + 40) + 6).toFixed(1)}">${t}</text>`;
    });
    svg += `<line class="rd-cross" x1="${C - R}" y1="${C}" x2="${C + R}" y2="${C}"/><line class="rd-cross" x1="${C}" y1="${C - R}" x2="${C}" y2="${C + R}"/>`;
    const sel = reqs.find((r) => r.e.msg.id === state.selected);
    const at = (r) => { const a = (r.deg - 90) * Math.PI / 180, rr = Math.max(62, Math.min(1, r.km / maxKm) * R); return { x: C + Math.cos(a) * rr, y: C + Math.sin(a) * rr }; };
    if (sel) { const p = at(sel); svg += `<line class="rd-path" x1="${C}" y1="${C}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}"/>`; }
    $('#radar-svg').innerHTML = svg;

    // Pins and their labels are HTML laid over the drawing, placed in percent so they scale with it.
    // Each label tries a few spots around its pin and takes the first one that overlaps nothing.
    const k = (box.clientWidth || 800) / 800;
    const taken = [{ x: (C - 55) * k, y: (C - 50) * k, w: 110 * k, h: 140 * k }];
    const hits = (a) => taken.some((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
    const order = reqs.slice().sort((a, b) => (b === sel) - (a === sel));
    let html = '';
    for (const r of order) {
      const p = at(r);
      const isSel = sel === r;
      const lines = [origin(r.e.msg), `${M.PROBLEMS[r.e.msg.a].short}, ${peopleText(r.e.msg.b)}`, `${distText(r.km * 1000)} ${dirWord(r.deg)}`];
      const w = Math.max(lines[0].length * 9.5, lines[1].length * 7.4, lines[2].length * 6.6, isSel ? 190 : 0) + 26;
      const h = isSel ? 84 : 68;
      const px = p.x * k, py = p.y * k;
      const spots = [[18, -22], [-18 - w, -22], [18, -h + 8], [18, 6], [-18 - w, -h + 8], [-18 - w, 6], [-w / 2, 16], [-w / 2, -h - 16]];
      let pick = spots[0];
      for (const [dx, dy] of spots) {
        const a = { x: px + dx, y: py + dy, w, h };
        if (a.x < -20 || a.x + a.w > 820 * k) continue;
        if (!hits(a)) { pick = [dx, dy]; break; }
      }
      taken.push({ x: px + pick[0], y: py + pick[1], w, h });
      taken.push({ x: px - 14, y: py - 14, w: 28, h: 28 });
      html += `<button type="button" class="rd-pin${isSel ? ' sel' : ''}" data-id="${esc(r.e.msg.id)}" style="left:${(p.x / 8).toFixed(2)}%;top:${(p.y / 8).toFixed(2)}%">
        <i></i><span class="tag" style="left:${pick[0].toFixed(0)}px;top:${pick[1].toFixed(0)}px"><b>${esc(lines[0])}</b><span>${esc(lines[1])}</span><small>${esc(lines[2])}</small>${isSel ? `<small>${esc(coordText(r.l.lat, r.l.lon))}</small>` : ''}</span></button>`;
    }
    $('#radar-pins').innerHTML = html;
    $$('#radar-pins .rd-pin').forEach((b) => { b.onclick = () => selectRequest(b.dataset.id); });
    $('#radar-empty').hidden = reqs.length > 0;
  }
  const renderMap = renderRadar;

  // ------------------------------------------------------------------
  // Sound waterfall: a live picture of what the post's microphone hears.
  // Pitch runs left to right, time runs downward (newest at the top).
  // Every decoded chirp gets a label pinned to the band of sound it came from.
  // ------------------------------------------------------------------
  const WF = { F_MIN: 500, F_MAX: 7500, PPS: 46, buf: null, bctx: null, row: null, data: null, acc: 0, last: 0, marks: [] };

  // How long a chirp of this many characters lasts, measured from ggwave (about 2.3 s for 16, 3.6 s for 31).
  const chirpSeconds = (len) => 0.8 + 0.09 * len;

  function markSound(kind, title, sub, durS, endAt) {
    WF.marks.push({ kind, title, sub: sub || '', dur: durS, at: endAt || performance.now() });
    if (WF.marks.length > 40) WF.marks.shift();
  }

  function drawWaterfall(now) {
    const c = $('#waterfall');
    if (!c || !Sound.analyser) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h || !WF.buf) {
      c.width = w; c.height = h;
      WF.buf = document.createElement('canvas'); WF.buf.width = w; WF.buf.height = h;
      WF.bctx = WF.buf.getContext('2d');
      WF.bctx.fillStyle = '#fff'; WF.bctx.fillRect(0, 0, w, h);
      WF.row = WF.bctx.createImageData(w, 1);
      WF.acc = 0;
    }
    const dt = WF.last ? Math.min(0.25, (now - WF.last) / 1000) : 0;
    WF.last = now;
    WF.acc += dt * WF.PPS * dpr;
    let shift = Math.floor(WF.acc);
    WF.acc -= shift;
    if (shift > 0) {
      shift = Math.min(shift, h);
      const an = Sound.analyser;
      if (!WF.data || WF.data.length !== an.frequencyBinCount) WF.data = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(WF.data);
      const binHz = Sound.ctx.sampleRate / an.fftSize;
      // Fit the view to the chirp style in use: dual-tone chirps sit around 1 to 3 kHz, classic ones higher.
      const classic = /^AUDIBLE/.test(S.protocol);
      WF.F_MIN = classic ? 1500 : 800; WF.F_MAX = classic ? 7500 : 3200;
      const px = WF.row.data;
      for (let x = 0; x < w; x++) {
        const f = WF.F_MIN + (x / (w - 1)) * (WF.F_MAX - WF.F_MIN);
        const fb = f / binHz, i0 = Math.floor(fb), fr = fb - i0;
        const v = (WF.data[i0] || 0) * (1 - fr) + (WF.data[i0 + 1] || 0) * fr;
        let t = (v - 95) / 120;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        t = t * t * (3 - 2 * t);
        // White paper to deep ink as the sound gets louder.
        px[x * 4] = 255 - t * (255 - 26);
        px[x * 4 + 1] = 255 - t * (255 - 31);
        px[x * 4 + 2] = 255 - t * (255 - 41);
        px[x * 4 + 3] = 255;
      }
      const b = WF.bctx;
      b.drawImage(WF.buf, 0, 0, w, h - shift, 0, shift, w, h - shift);
      b.putImageData(WF.row, 0, 0);
      if (shift > 1) b.drawImage(WF.buf, 0, 0, w, 1, 0, 1, w, shift - 1);
    }
    const g = c.getContext('2d');
    g.drawImage(WF.buf, 0, 0);

    // Faint pitch guides, one per kHz.
    g.font = `${11 * dpr}px 'Instrument Sans', sans-serif`;
    g.textBaseline = 'top';
    const step = WF.F_MAX - WF.F_MIN > 4000 ? 1000 : 500;
    for (let f = Math.ceil(WF.F_MIN / step) * step; f < WF.F_MAX; f += step) {
      const x = ((f - WF.F_MIN) / (WF.F_MAX - WF.F_MIN)) * w;
      const k = f / 1000;
      g.fillStyle = 'rgba(26,31,41,.06)';
      g.fillRect(Math.round(x), 0, Math.max(1, dpr), h);
      g.fillStyle = '#9aa0a8';
      g.fillText(`${k % 1 ? k.toFixed(1) : k} kHz`, x + 5 * dpr, 8 * dpr);
    }

    // Labels for decoded chirps, moving down with their sound.
    const pps = WF.PPS * dpr;
    WF.marks = WF.marks.filter((m) => (now - m.at) / 1000 * pps < h + 10);
    for (const m of WF.marks) {
      const yEnd = ((now - m.at) / 1000) * pps;
      const yStart = yEnd + m.dur * pps;
      const red = m.kind === 'sos';
      g.fillStyle = red ? 'rgba(215,38,30,.05)' : 'rgba(26,31,41,.025)';
      g.fillRect(0, yEnd, w, yStart - yEnd);
      g.fillStyle = red ? '#d7261e' : m.kind === 'you' ? '#1a1f29' : '#9aa0a8';
      g.fillRect(0, yEnd, 4 * dpr, yStart - yEnd);
      const lx = 20 * dpr, ly = yEnd + 12 * dpr;
      g.font = `600 ${14 * dpr}px 'Instrument Sans', sans-serif`;
      const tw = g.measureText(m.title).width;
      g.font = `${12 * dpr}px 'Instrument Sans', sans-serif`;
      const sw = m.sub ? g.measureText(m.sub).width : 0;
      const bw = Math.max(tw, sw) + 22 * dpr, bh = (m.sub ? 46 : 30) * dpr;
      g.fillStyle = red ? '#d7261e' : m.kind === 'you' ? '#1a1f29' : '#ffffff';
      g.beginPath();
      if (g.roundRect) g.roundRect(lx, ly, bw, bh, 10 * dpr); else g.rect(lx, ly, bw, bh);
      g.fill();
      if (m.kind === 'plain') { g.strokeStyle = '#e3e5e9'; g.lineWidth = dpr; g.stroke(); }
      const light = m.kind !== 'plain';
      g.fillStyle = light ? '#ffffff' : '#1a1f29';
      g.font = `600 ${14 * dpr}px 'Instrument Sans', sans-serif`;
      g.fillText(m.title, lx + 11 * dpr, ly + 7 * dpr);
      if (m.sub) {
        g.fillStyle = light ? 'rgba(255,255,255,.85)' : '#6b7079';
        g.font = `${12 * dpr}px 'Instrument Sans', sans-serif`;
        g.fillText(m.sub, lx + 11 * dpr, ly + 26 * dpr);
      }
    }
  }

  function selectRequest(id) {
    state.selected = id;
    renderQueue();

  }

  function tickClock() {
    const el = $('#post-clock');
    if (el) el.textContent = clock();
  }

  function handleRescue(r, now) {
    const { msg, events } = r;
    if (events.includes('sos')) {
      let e = state.queue.get(msg.id);
      if (!e) {
        e = { msg, first: now, last: now, replied: null, safe: false, fresh: true, eta: 20, asks: {}, answers: {}, auto: M.isAuto(msg) };
        state.queue.set(msg.id, e);
        vibrate(200);
        Sound.ping();
        // An alert a phone sent by itself gets questions straight away, and the phone answers by itself.
        if (e.auto) setTimeout(() => askQuestion(e, 'M'), 2500);
      } else {
        e.msg = msg; e.last = now; e.fresh = true;
      }
      if (!state.selected || !state.queue.has(state.selected)) state.selected = msg.id;
      maybeAutoResend(e, now);
      renderQueue();
      const hops = M.hopsOf(msg);
      markSound('sos', `SOS from ${origin(msg)}`, `${M.PROBLEMS[msg.a].label}, ${hops.length ? 'passed on by ' + hops.join(', ') : 'heard directly'}`, chirpSeconds(M.encode(msg).length));
    } else if (events.includes('answer')) {
      const e = state.queue.get(msg.id);
      if (e && e.asks) {
        e.answers[msg.a] = msg.b;
        if (e.asks[msg.a]) e.asks[msg.a].answered = true;
        e.last = now;
        renderQueue();
        // Next question once the first is answered.
      }
    } else if (events.includes('replyRelayed')) {
      const e = state.queue.get(msg.id);
      if (e && e.replied) e.replied.relayed = true;
    } else if (events.includes('questionRelayed')) {
      const e = state.queue.get(msg.id);
      if (e && e.asks && e.asks[msg.a]) e.asks[msg.a].relayed = true;
    } else if (events.includes('sosRepeat')) {
      const e = state.queue.get(msg.id);
      if (e) {
        e.last = now;
        if (msg.path.length < e.msg.path.length) e.msg = msg;
        markSound('plain', `${origin(msg)} sent their SOS again`, '', chirpSeconds(M.encode(msg).length));
        maybeAutoResend(e, now);
      }
    } else if (events.includes('safe')) {
      const e = state.queue.get(msg.id);
      if (e) { e.safe = true; if (state.selected === msg.id) state.selected = null; renderQueue(); }
      markSound('plain', `${origin(msg)} is safe`, '', chirpSeconds(M.encode(msg).length));
    }
    renderCounts();
  }

  // If someone keeps repeating after we answered, they didn't hear the reply: send it again.
  function maybeAutoResend(e, now) {
    if (e.replied && !e.safe && now - e.replied.lastSent > 15000) sendReply(e.msg.id, e.replied.code, e.replied.eta, true);
  }

  // The rescue post asks an automatic alert a question. If no answer comes back, ask again,
  // up to three times, since a chirp can be lost on the way.
  function askQuestion(e, code) {
    if (!e || e.replied || e.safe) return;
    const a = e.asks[code] || (e.asks[code] = { tries: 0, at: 0, answered: false, relayed: false });
    if (a.answered || a.tries >= 1) return;
    a.tries += 1; a.at = Date.now();
    // The same question is repeated under the same key so a relay that already has it does not pass it twice.
    sendOwn({ type: 'Q', id: e.msg.id, a: code, b: '1', flags: state.acceptDirect ? 'D' : '-', loc: '-', ttl: M.DEFAULT_TTL, path: '' });
    renderQueue();
  }
  // Keep asking until the relay is heard passing the question on; after that wait much longer for the answer.
  function retryQuestions() {
    return;   // no retries
    const now = Date.now();
    for (const e of state.queue.values()) {
      if (!e.asks) continue;
      for (const [code, a] of Object.entries(e.asks)) {
        if (a.answered || a.relayed || a.tries >= 4) continue;
        if (now - a.at > (a.gap || 13000)) { a.gap = 12000 + Math.random() * 4000; askQuestion(e, code); }
      }
    }
  }

  function sendReply(id, code, eta, auto) {
    const e = state.queue.get(id);
    if (!e) return;
    const msg = { type: 'R', id, a: code, b: String(eta || e.eta || 20), flags: state.acceptDirect ? 'D' : '-', loc: '-', ttl: M.DEFAULT_TTL, path: '' };
    const first = !e.replied;
    e.replied = { code, eta: msg.b, lastSent: Date.now() };
    if (!auto) toast(`Told ${id.slice(0, M.ID_LEN)}: ${replyText(code, msg.b).replace(/^./, (c) => c.toLowerCase())}`);
    // Answered requests leave the screen once the reply has travelled back out.
    if (first) {
      const ms = 700;
      if (state.selected === id) state.selected = null;
      const li = $(`#queue .card[data-id="${CSS.escape(id)}"]`);
      if (li) li.classList.add('leaving');
      setTimeout(renderQueue, ms);
    }
    sendOwn(msg);
  }
  function scheduleReplyRetry(id, n) {
    setTimeout(() => {
      const e = state.queue.get(id);
      if (!e || !e.replied || e.safe || e.replied.relayed || n >= 3) return;
      sendOwn({ type: 'R', id, a: e.replied.code, b: e.replied.eta, flags: state.acceptDirect ? 'D' : '-', loc: '-', ttl: M.DEFAULT_TTL, path: '' });
      scheduleReplyRetry(id, n + 1);
    }, 12000 + Math.random() * 3000);
  }

  // "28.0587° N, 82.4139° W, near Ybor City, 1.2 km away"
  function placeDetail(loc) {
    const l = M.locationOf(loc);
    if (!l) return 'Location not shared';
    let t = coordText(l.lat, l.lon);
    if (l.near) t += `, near ${l.near}`;
    if (geo.fix) t += `, ${distText(M.distanceM(geo.fix, l))} away`;
    return t;
  }
  // "Near Ybor City, 10.9 km away" (coordinates only when no named area is close)
  function placeShort(loc) {
    const l = M.locationOf(loc);
    if (!l) return 'Location not shared';
    let t = l.near ? `Near ${l.near}` : coordText(l.lat, l.lon);
    t += `, ${distText(M.distanceM(postLoc(), l))} ${dirWord(bearingDeg(postLoc(), l))}`;
    return t;
  }
  function priorityOf(score) {
    if (score >= 100) return { word: 'Critical', cls: 'p-critical' };
    if (score >= 80) return { word: 'High', cls: 'p-high' };
    return { word: 'Medium', cls: 'p-medium' };
  }

  // The path a request took: sender, each phone that passed it on, then this post.
  function routeHtml(msg, animate) {
    const stops = [{ name: origin(msg), cls: 'origin' }]
      .concat(M.hopsOf(msg).map((h) => ({ name: h, cls: '' })))
      .concat([{ name: 'You', cls: 'end' }]);
    return `<ol class="route${animate ? ' draw' : ''}" style="--n:${stops.length}">${stops.map((st, i) =>
      `<li class="${st.cls}" style="--i:${i}"><i></i><span>${esc(st.name)}</span></li>`).join('')}</ol>`;
  }

  function sortedRequests() {
    const now = Date.now();
    return Array.from(state.queue.values())
      .filter((e) => !e.safe && !e.replied)
      .map((e) => ({ e, score: M.urgencyScore(e.msg, e.first, now) }))
      .sort((a, b) => b.score - a.score);
  }

  // Requests within 400 m are shown as one job, because one boat can take them all.
  function clusters() {
    const items = sortedRequests();
    const placed = [], loose = [];
    for (const it of items) {
      const l = M.locationOf(it.e.msg.loc);
      if (l) placed.push({ e: it.e, score: it.score, lat: l.lat, lon: l.lon, people: parseInt(it.e.msg.b, 10) || 0 });
      else loose.push({ items: [{ e: it.e, score: it.score }], score: it.score, people: 0, spreadM: 0 });
    }
    return M.groupRequests(placed, 400).concat(loose).sort((a, b) => b.score - a.score);
  }

  // What the phone has answered so far, and what it is still being asked.
  function qaHtml(e) {
    if (!e.auto) return '';
    const rows = Object.keys(M.QUESTIONS).filter((c) => e.asks[c]).map((c) => {
      const a = e.asks[c];
      if (a.answered) return `<li class="done"><i></i><span>${esc(M.describeAnswer(c, e.answers[c]))}</span></li>`;
      return `<li class="wait"><i></i><span>${esc(M.QUESTIONS[c])}${a.tries > 1 ? ` (asked ${a.tries} times)` : ''}</span></li>`;
    });
    return rows.length ? `<ul class="qa">${rows.join('')}</ul>` : '';
  }
  // The answers point to a boat (deep water) or medics (hurt and cannot move).
  function suggestion(e) {
    if (!e.auto) return '';
    if (e.msg.a === 'I' && e.answers.M === 'N') return 'a-medic';
    if (e.msg.a === 'W') return 'a-boat';
    return '';
  }
  function replyRow(e, extra) {
    return `<div class="eta-row"><label>Arriving in</label><select class="a-eta" aria-label="Arrival time">${[5, 10, 15, 20, 30, 45, 60].map((v) => `<option value="${v}" ${v === (e.eta || 20) ? 'selected' : ''}>${v} min</option>`).join('')}</select></div>
      <div class="reply-row">
        <button type="button" class="a-help primary">Send help${extra || ''}</button>
        <button type="button" class="a-boat${suggestion(e) === 'a-boat' ? ' suggested' : ''}">Send a boat</button>
        <button type="button" class="a-medic${suggestion(e) === 'a-medic' ? ' suggested' : ''}">Send medics</button>
      </div>`;
  }
  function wireReplies(el, ids, lead) {
    const eta = () => $('.a-eta', el).value;
    $('.a-eta', el).onchange = (ev) => { lead.eta = parseInt(ev.target.value, 10); };
    $('.a-help', el).onclick = () => ids.forEach((id) => sendReply(id, 'H', eta()));
    $('.a-boat', el).onclick = () => ids.forEach((id) => sendReply(id, 'B', eta()));
    $('.a-medic', el).onclick = () => ids.forEach((id) => sendReply(id, 'A', eta()));
  }

  function requestCard(e, score, now, selected) {
    const m = e.msg;
    const mins = Math.floor((now - e.first) / 60000);
    const who = withText(m.flags);
    const li = document.createElement('li');
    li.dataset.id = m.id;
    li.className = `card is-sos${selected ? ' sel' : ''}${score >= 100 ? ' critical' : ''}${e.fresh ? ' fresh' : ''}`;
    e.fresh = false;
    const stops = [{ name: origin(m), cls: 'origin' }].concat(M.hopsOf(m).map((h) => ({ name: h, cls: '' }))).concat([{ name: 'You', cls: 'me' }]);
    li.innerHTML = `<div class="card-head"><span class="what">${e.auto ? 'Automatic alert from' : 'SOS from'} ${esc(origin(m))}<small>${esc(problemText(m))}${who ? ', ' + esc(who) : ''}</small><small class="where">${esc(placeShort(m.loc))}</small></span><span class="time">${mins < 1 ? 'Just now' : mins + ' min ago'}</span></div>
      <ol class="route mini">${stops.map((x) => `<li class="${x.cls}"><i></i><span>${esc(x.name)}</span></li>`).join('')}</ol>${qaHtml(e)}${selected ? replyRow(e) : ''}`;
    li.onclick = (ev) => { if (!ev.target.closest('button,select')) selectRequest(m.id); };
    if (selected) wireReplies(li, [m.id], e);
    return li;
  }

  function groupCard(g, now, selected) {
    const lead = g.items[0].e;
    const ids = g.items.map((x) => x.e.msg.id);
    const spread = g.spreadM < 100 ? 'same block' : `within ${distText(g.spreadM)}`;
    const li = document.createElement('li');
    li.dataset.id = lead.msg.id;
    li.className = `card group${selected ? ' sel' : ''}${g.score >= 100 ? ' critical' : ''}`;
    li.innerHTML = `<div class="card-head"><span class="what">One trip, ${g.items.length} calls<small>${g.people} ${g.people === 1 ? 'person' : 'people'}, ${esc(spread)}</small><small class="where">${esc(placeShort(lead.msg.loc))}</small></span><span class="time">${esc(priorityOf(g.score).word)}</span></div>
      <ul class="in-group">${g.items.map((x) => {
        const m = x.e.msg;
        const mins = Math.floor((now - x.e.first) / 60000);
        return `<li><b>${esc(origin(m))}</b><span>${esc(problemText(m))}</span><em>${mins < 1 ? 'now' : mins + 'm'}</em></li>`;
      }).join('')}</ul>
      ${selected ? replyRow(lead, ` to all ${g.items.length}`) : ''}`;
    li.onclick = (ev) => { if (!ev.target.closest('button,select')) selectRequest(lead.msg.id); };
    if (selected) wireReplies(li, ids, lead);
    return li;
  }

  function renderQueue() {
    const now = Date.now();
    const groups = clusters();
    const all = groups.flatMap((g) => g.items.map((x) => x.e.msg.id));
    if (all.length && !all.includes(state.selected)) state.selected = all[0];
    renderCounts();
    renderMap();
    $('#post-empty').hidden = all.length > 0;
    const box = $('#queue');
    box.innerHTML = '';
    for (const g of groups) {
      const selected = g.items.some((x) => x.e.msg.id === state.selected);
      box.appendChild(g.items.length > 1 ? groupCard(g, now, selected) : requestCard(g.items[0].e, g.score, now, selected));
    }
  }

  // Fallback for a noisy room: press D on the rescue post to replay a sample SOS arrival (marked as a replay in the log).
  function replayDemo() {
    const id = M.randomId() + String(Math.floor(Math.random() * 89) + 10);
    const h = M.NEIGHBORHOODS['3'];
    const text = M.encode({ type: 'S', id, a: 'W', b: 2, flags: 'K', loc: M.packLocation(h.lat + 0.0021, h.lon - 0.0013), ttl: 4, path: M.randomId() + M.randomId() });
    const now = Date.now();
    const r = state.node.handleHeard(text, now);
    state.heardCount += 1;
    handleRescue(r, now);
  }

  // ------------------------------------------------------------------
  // Setup screen
  // ------------------------------------------------------------------
  function fillSetup() {
    $('#setup-id').textContent = S.pid;
    renderGeo();
    const hh = S.household || {};
    $$('#setup-people button').forEach((b) => {
      const on = b.dataset.v === String(hh.people);
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    $$('#setup-flags button').forEach((b) => {
      const on = String(hh.flags || '').includes(b.dataset.v);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $('#sel-protocol').innerHTML = Object.entries(PROTOCOLS).map(([k, p]) => `<option value="${k}" ${k === S.protocol ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
    $('#rng-volume').value = S.volume;
    $('#lbl-volume').textContent = `${S.volume} of 80`;
    $('#chk-chime').checked = S.chime;
    $('#chk-twice').checked = S.twice !== false;
    $('#chk-3d').checked = S.scene3d !== false;
    setRole(S.role);
  }
  function setRole(role) {
    S.role = role;
    $$('#seg-role button').forEach((b) => { b.classList.toggle('on', b.dataset.value === role); b.setAttribute('aria-pressed', String(b.dataset.value === role)); });
    $('#phone-only').hidden = role !== 'phone';

  }
  function readSetup() {
    S.protocol = $('#sel-protocol').value;
    S.volume = parseInt($('#rng-volume').value, 10);
    S.chime = $('#chk-chime').checked;
    S.twice = $('#chk-twice').checked;
    S.scene3d = $('#chk-3d').checked;
    const picked = $('#setup-people button.on');
    S.household = {
      people: picked ? parseInt(picked.dataset.v, 10) : 0,
      flags: $$('#setup-flags button.on').map((b) => b.dataset.v).join(''),
    };
  }

  function enterMode() {
    makeNode();
    if (S.role === 'rescue') {
      show('screen-rescue');
      renderQueue();
      if (!state.askTimer) state.askTimer = setInterval(retryQuestions, 5000);
    } else {
      show('screen-phone');
      $('#chip-id-text').textContent = S.pid;
      $('#sos-hint').textContent = state.sos ? 'Tap to see your SOS' : 'Tap to open';
      $('#stat-relayed').textContent = state.relayed;
      renderCarrying();
      renderRadar();
      showPhonePanel(state.sos ? '#phone-tracker' : '#phone-home');
    }
    startGeo();
  }

  // ------------------------------------------------------------------
  // Wire everything up
  // ------------------------------------------------------------------
  async function keepAwake() {
    try { if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not supported */ }
  }

  function loop() {
    if ($('#screen-phone').classList.contains('active')) drawLine($('#line-phone'));
    requestAnimationFrame(loop);
  }

  function init() {
    // SOS flow choices.
    $('#choices-problem').innerHTML = Object.entries(M.PROBLEMS).map(([k, p]) => `<button type="button" role="radio" aria-checked="false" data-v="${k}">${esc(p.label)}</button>`).join('');
    $('#choices-people').innerHTML = ['1', '2', '3', '4', '5'].map((v) => `<button type="button" role="radio" aria-checked="false" data-v="${v}" aria-label="${esc(peopleText(v))}">${v === '5' ? '5+' : v}</button>`).join('');
    const flagWords = { K: 'Kids', E: 'Elderly', P: 'Pets' };
    $('#choices-flags').innerHTML = Object.keys(M.FLAGS).map((k) => `<button type="button" data-v="${k}" aria-pressed="false">${flagWords[k]}</button>`).join('');
    $('#setup-people').innerHTML = ['1', '2', '3', '4', '5'].map((v) => `<button type="button" role="radio" aria-checked="false" data-v="${v}" aria-label="${esc(peopleText(v))}">${v === '5' ? '5+' : v}</button>`).join('');
    const shortWords = { K: 'Kids', E: 'Elderly', P: 'Pets' };
    $('#setup-flags').innerHTML = Object.keys(M.FLAGS).map((k) => `<button type="button" data-v="${k}" aria-pressed="false">${shortWords[k]}</button>`).join('');
    $('#setup-people').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('#setup-people button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    };
    $('#setup-flags').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    };

    // Single-choice lists: tap to select. The Send button wakes up once the problem and people are set.
    const pickOne = (group, key) => (e) => {
      const b = e.target.closest('button'); if (!b) return;
      flow[key] = b.dataset.v;
      $$(`${group} button`).forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
      updateSendButton();
    };
    $('#choices-problem').onclick = pickOne('#choices-problem', 'problem');
    $('#choices-people').onclick = pickOne('#choices-people', 'people');
    $('#choices-flags').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const v = b.dataset.v;
      if (flow.flags.has(v)) flow.flags.delete(v); else flow.flags.add(v);
      b.classList.toggle('on', flow.flags.has(v));
      b.setAttribute('aria-pressed', String(flow.flags.has(v)));
    };
    // The big button opens Home Watch (the only way to send an SOS), or the tracker once one is out.
    $('#btn-sos').onclick = () => {
      if (state.sos) { showPhonePanel('#phone-tracker'); renderTracker(); }
      else if (window.LifelineWatch) window.LifelineWatch.open();
    };
    $('#btn-safe').onclick = imSafe;
    // Last resort for a lost chirp: play this device's last message again.
    $('#btn-again').onclick = () => { if (lastTx) { Sound.send(lastTx); toast('Sending the last message again'); } };
    if (window.LifelineWatch) window.LifelineWatch.init({
      sendSos, sendAnswer: answerUntilRelayed, imSafe, toast, vibrate,
      ping: () => Sound.ping(), hasSos: () => !!state.sos, replyText, use3d: () => S.scene3d !== false,
    });

    $('#seg-role').onclick = (e) => { const b = e.target.closest('button'); if (b) setRole(b.dataset.value); };
    $('#rng-volume').oninput = (e) => { $('#lbl-volume').textContent = `${e.target.value} of 80`; };
    $('#btn-new-id').onclick = () => { S.pid = M.randomId(); saveSettings(); $('#setup-id').textContent = S.pid; };
    $('#btn-allow-loc').onclick = () => {
      if (geo.watch !== null) { navigator.geolocation.clearWatch(geo.watch); geo.watch = null; }
      startGeo();
    };
    $('#chip-loc').onclick = () => { if (geo.state !== 'on') { fillSetup(); show('screen-setup'); } };
    $('#btn-carry-now').onclick = () => runCarried(true);
    $('#btn-soundcheck').onclick = () => { readSetup(); Sound.send(SOUND_CHECK); toast('Sending a sound check'); };
    $('#btn-setup-done').onclick = () => {
      readSetup();
      S.configured = true;
      saveSettings();
      enterMode();
    };
    $$('[data-open-setup]').forEach((b) => (b.onclick = () => { fillSetup(); show('screen-setup'); }));

    $('#btn-start').onclick = async () => {
      const btn = $('#btn-start');
      btn.disabled = true;
      btn.textContent = 'Starting';
      $('#start-error').hidden = true;
      try {
        await Sound.start();
        Sound.onDecoded = onDecoded;
        let txStart = 0;
        Sound.onTxStart = (t) => { lastTx = t; $('#btn-again').hidden = false; dbg('TX', t); txStart = performance.now(); document.body.classList.add('tx'); setStatus('Sending'); };
        Sound.onTxEnd = (text) => {
          document.body.classList.remove('tx');
          setStatus('Listening');
          // On the post, label its own replies in the waterfall too.
          const m = S.role === 'rescue' && M.decode(text || '');
          if (m && m.type === 'R') markSound('you', `You replied to ${origin(m)}`, replyText(m.a, m.b), (performance.now() - txStart) / 1000);
        };
        keepAwake();
        requestAnimationFrame(loop);
        setInterval(() => { if (state.sos) renderRetry(); }, 1000);
        tickClock();
        setInterval(tickClock, 10000);
        setInterval(() => { if (S.role !== 'rescue') renderRadar(); }, 5000);
        setInterval(() => { if (S.role !== 'rescue' && state.node && state.node.carriedCount()) runCarried(false); }, 5000);
        // Refresh "minutes ago" and urgency now and then (not every second, so menus stay usable).
        setInterval(() => { if (S.role === 'rescue' && state.queue.size && !document.activeElement.closest('.card')) renderQueue(); }, 30000);
        if (S.configured) enterMode();
        else { fillSetup(); show('screen-setup'); }
      } catch (err) {
        const name = err && err.name;
        const msg = name === 'NotAllowedError'
          ? 'The microphone is blocked. Allow it for this site in your browser settings, then reload the page.'
          : (err && err.message) || String(err);
        $('#start-error').textContent = msg;
        $('#start-error').hidden = false;
        btn.disabled = false;
        btn.textContent = 'Start listening';
      }
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Sound.ready) {
        keepAwake();
        if (Sound.ctx.state !== 'running') Sound.ctx.resume();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (S.role !== 'rescue' || !Sound.ready || e.target.closest('input,select')) return;
      if (e.key === 'd' || e.key === 'D') replayDemo();
      // Hidden switch for testing with a single phone: also accept phones heard directly.
      if (e.key === 'r' || e.key === 'R') { state.acceptDirect = !state.acceptDirect; toast(state.acceptDirect ? 'Accepting phones heard directly' : 'Only accepting relayed messages'); }
    });

    if ('serviceWorker' in navigator && window.isSecureContext) {
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').catch(() => {});
      // A newer version took over: reload once so this device is never left running an old one.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
    }
  }

  // Exposed for debugging from the browser console.
  window.LIFELINE = { Sound, state, settings: S };

  init();
})();
