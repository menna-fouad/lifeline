/* Home Watch: a flood simulator that watches over the person. When the water
   reaches their floor (or they fall) and they do not answer a short countdown,
   the phone sends the SOS by itself, then answers the rescue post's questions by
   itself. Everything runs on the phone, so it works with no signal.

   The water depth here is simulated. A real phone cannot feel water, so it stands in
   for a home flood sensor; the fall detection uses the phone's real accelerometer. */
(function () {
  'use strict';

  const STORM_MS = 20000, START_HOUR = 17, SPAN_H = 6;       // 20 s of demo = 6 hours of storm
  const D0 = 4, RISE = 200, SLAB_IN = 120;                    // inches over the ground floor; the person is upstairs
  const COUNTDOWN = 4, SNOOZE_MS = 30000;
  const POWER_OUT_AT = 0.12, SIGNAL_OUT_AT = 0.18;

  const depthAt = (t) => D0 + RISE * t;                       // steady rise
  const rateAt = () => RISE / SPAN_H;                         // inches per hour

  const $ = (s) => document.querySelector(s);
  const M = window.Mesh;
  let app = null, scene = null, sceneLoading = null;
  let t = 0, running = false, last = 0, raf = 0, fired = false, fallen = false;
  let snoozeUntil = 0, countdown = null, lastLevel = -1, lastLine = '';
  let powerOut = false, signalOut = false, rescued = false;
  let impactAt = 0, quietFrom = 0;
  const chat = [];
  const chain = { sent: false, relay: false, post: false };

  // The person is on the upper floor, so what matters is how far the water is from it.
  const base = () => SLAB_IN;
  const gapNow = () => depthAt(t) - base();
  const levelOf = () => {
    const gap = gapNow();
    if (gap >= 12) return 3;
    if (gap >= 0) return 2;
    if (gap >= -40) return 1;
    return 0;
  };
  const sc = (m, ...a) => { if (scene) scene[m](...a); };

  function clock(tt) {
    const mins = Math.round(START_HOUR * 60 + tt * SPAN_H * 60);
    const h = Math.floor(mins / 60) % 24, m = mins % 60;
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }

  // ---- 3D scene: loaded the first time Home Watch opens --------------------------
  function ensureScene() {
    if (scene) return Promise.resolve();
    if (sceneLoading) return sceneLoading;
    sceneLoading = new Promise((resolve) => {
      if (!app.use3d()) { resolve(); return; }
      const done = () => {
        try { scene = window.LifelineScene.create($('#game-canvas')); }
        catch (e) { scene = null; app.toast('3D is not available on this phone'); }
        resolve();
      };
      if (window.LifelineScene) { done(); return; }
      const s = document.createElement('script');
      s.src = 'vendor/scene3d.js';
      s.onload = done;
      s.onerror = () => { app.toast('Could not load the 3D scene'); resolve(); };
      document.head.appendChild(s);
    });
    return sceneLoading;
  }

  // ---- HUD ------------------------------------------------------------------------
  function feed(text) {
    const el = document.createElement('div');
    el.className = 'g-toast';
    el.textContent = text;
    $('#g-feed').appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  function chips() {
    const box = $('#g-chips');
    const items = [];
    if (powerOut) items.push('<span class="g-chip"><svg viewBox="0 0 24 24"><path d="M13 3L5 14h6l-1 7 8-11h-6z"/><path d="M4 4l16 16"/></svg>Power out</span>');
    if (signalOut) items.push('<span class="g-chip"><svg viewBox="0 0 24 24"><path d="M5 20v-4M10 20v-8M15 20V8M20 20V4"/><path d="M3 3l18 18"/></svg>No signal</span>');
    const html = items.join('');
    if (box.innerHTML !== html) box.innerHTML = html;
  }

  function say(side, text, tag) {
    chat.push({ side, text, tag });
    renderChat();
  }
  function renderChat() {
    const box = $('#g-chat');
    box.hidden = chat.length === 0;
    box.innerHTML = chat.map((c) => c.side === 'sys'
      ? `<p class="b-sys">${c.text}</p>`
      : `<p class="b-${c.side}">${c.text}${c.tag ? `<small>${c.tag}</small>` : ''}</p>`).join('');
    box.scrollTop = box.scrollHeight;
  }
  function renderChain() {
    const box = $('#g-chain');
    box.hidden = !chain.sent;
    $('#gc-sent').className = chain.sent ? 'done' : '';
    $('#gc-relay').className = chain.relay ? 'done' : (chain.sent ? 'active' : '');
    $('#gc-post').className = chain.post ? 'done' : (chain.relay ? 'active' : '');
  }

  function render() {
    const depth = depthAt(t);
    const lv = running || t > 0 ? levelOf() : 0;
    $('#g-time').textContent = clock(t);
    $('#g-depth').textContent = `${Math.round(depth)} in`;
    $('#g-rate').textContent = running && t < 1 ? `Rising ${Math.round(rateAt(t))} in/hr` : '';
    // Gauge: 0 to 210 in, floors marked at 0 and 120.
    const f = (v) => Math.max(0, Math.min(1, v / 210));
    $('#g-fill').style.height = `${f(depth) * 100}%`;
    $('#g-mark-ground').style.bottom = `${f(0) * 100}%`;
    $('#g-mark-up').style.bottom = `${f(SLAB_IN) * 100}%`;
    $('#g-you').style.bottom = `${f(base()) * 100}%`;

    let line;
    if (rescued) line = 'Help is on the way.';
    else if (fired) line = 'SOS sent. Keep this phone on.';
    else if (!running && t === 0) line = 'Watching your home.';
    else if (lv === 0) line = 'Water is rising around the house.';
    else if (lv === 1) line = 'Water is getting close to your floor.';
    else if (lv === 2) line = 'Water is reaching your floor.';
    else line = `Water is ${Math.round(gapNow())} in deep on your floor.`;
    if (line !== lastLine) { $('#g-line').textContent = line; lastLine = line; }

    const state = rescued ? 4 : (fired ? 5 : lv);
    if (state !== lastLevel) {
      lastLevel = state;
      const pill = $('#g-pill');
      pill.className = 'pill' + (state === 3 || state === 5 ? ' danger' : state === 4 ? ' ok' : state >= 1 ? ' warn' : '');
      pill.textContent = ['Watching', 'Water close', 'Water rising', 'Emergency', 'Help coming', 'SOS sent'][state];
      $('#game-edge').classList.toggle('danger', state === 3);
    }
    chips();
  }

  function pushToScene() {
    if (!scene) return;
    scene.setStorm(t);
    scene.setWaterInches(depthAt(t));
  }

  function frame(ts) {
    if (!running) return;
    const dt = ts - last; last = ts;
    t = Math.min(1, t + dt / STORM_MS);
    if (!powerOut && t >= POWER_OUT_AT) { powerOut = true; sc('setPower', false); feed('Power is out'); app.vibrate(80); }
    if (!signalOut && t >= SIGNAL_OUT_AT) { signalOut = true; feed('Cell towers are down'); app.vibrate(80); }
    pushToScene();
    render();
    if (!fired && levelOf() === 3) trigger('water');
    raf = requestAnimationFrame(frame);
  }

  function startStorm() {
    resetState(false);
    running = true; last = performance.now();
    $('#g-start').textContent = 'Reset';
    feed('Flood water is rising');
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  function resetState(clearSos) {
    stopAlert();
    cancelAnimationFrame(raf);
    running = false; t = 0; fired = false; fallen = false; rescued = false; powerOut = false; signalOut = false;
    snoozeUntil = 0; lastLevel = -1; lastLine = '';
    chat.length = 0; chain.sent = chain.relay = chain.post = false;
    renderChat(); renderChain();
    if (clearSos && app.hasSos()) app.imSafe();
    if (scene) scene.reset();
    $('#g-start').textContent = 'Simulate flood';
    $('#g-feed').innerHTML = '';
    pushToScene();
    render();
  }

  // ---- The countdown ---------------------------------------------------------------
  function trigger(kind) {
    if (countdown || fired || app.hasSos() || performance.now() < snoozeUntil) return;
    const gap = Math.max(0, Math.round(gapNow()));
    const reason = kind === 'fall'
      ? 'Home Watch felt a hard shake or fall.'
      : `Water is ${gap} in deep on your floor and rising ${Math.round(rateAt(t))} in/hr.`;
    const problem = kind === 'fall' ? 'I' : 'W';
    const note = kind === 'fall' ? 'Sent automatically by Home Watch after a hard shake or fall' : `Sent automatically by Home Watch: water ${gap} in over the floor`;
    if (kind === 'fall') { fallen = true; sc('setFallen', true); }
    let left = COUNTDOWN;
    $('#watch-alert-reason').textContent = reason;
    $('#watch-alert').hidden = false;
    const tick = () => {
      $('#watch-count').textContent = left;
      $('#watch-ring').style.strokeDashoffset = String(289 * (1 - left / COUNTDOWN));
      if (left > 0) { app.ping(); app.vibrate(120); }
    };
    tick();
    countdown = setInterval(() => {
      left -= 1;
      if (left > 0) { tick(); return; }
      stopAlert();
      fire(problem, note, kind);
    }, 1000);
  }

  function stopAlert() {
    if (countdown) { clearInterval(countdown); countdown = null; }
    $('#watch-alert').hidden = true;
  }

  function fire(problem, note, kind) {
    fired = true;
    chain.sent = true;
    app.vibrate([300, 120, 300]);
    sc('setBeacon', true); sc('setWaving', kind !== 'fall'); sc('setFocus', 1); sc('setLowPower', true); sc('packet', 'out');
    feed('Home Watch is sending an SOS');
    say('sys', 'Home Watch sent an SOS on its own');
    renderChain(); render();
    app.sendSos(problem, { auto: true, note });
  }

  // ---- The rescue post talking back ---------------------------------------------------
  function answerFor(code) {
    const gap = Math.max(0, Math.round(gapNow()));
    if (code === 'W') return Promise.resolve(String(gap));
    if (code === 'M') return Promise.resolve('N');   // the demo person cannot move
    // Battery: real on Android Chrome. iPhones do not share it with web pages.
    if (navigator.getBattery) return navigator.getBattery().then((b) => String(Math.round(b.level * 100))).catch(() => '-');
    return Promise.resolve('-');
  }
  function onQuestion(msg) {
    if (!fired) return;
    chain.post = true; chain.relay = true; renderChain();
    sc('packet', 'in');
    say('post', M.QUESTIONS[msg.a]);
    answerFor(msg.a).then((value) => {
      let words;
      if (msg.a === 'W') words = value === '0' ? 'No water on my floor' : `${value} in`;
      else if (msg.a === 'M') words = value === 'Y' ? 'Yes' : 'No, I cannot';
      else words = value === '-' ? 'Battery unknown' : `${value}%`;
      setTimeout(() => { say('me', words, 'Answered automatically'); sc('packet', 'out'); }, 900);
      app.sendAnswer({ type: 'D', id: msg.id, a: msg.a, b: value, flags: String(msg.b || '1'), loc: '-', ttl: M.DEFAULT_TTL, path: '' });
    });
  }
  function onRelayed() {
    if (!fired || chain.relay) return;
    chain.relay = true; renderChain();
    say('sys', 'A nearby phone passed it on');
  }
  function onReply(msg) {
    if (!fired || rescued) return;
    rescued = true; chain.post = true; chain.relay = true; renderChain();
    say('post', app.replyText(msg.a, msg.b));
    sc('packet', 'in'); sc('rescue');
    app.vibrate([200, 100, 200, 100, 400]);
    $('#g-start').textContent = 'Play again';
    render();
  }
  function onSafe() { sc('setBeacon', false); sc('setWaving', false); }

  // ---- Shake or fall: three violent jolts within 1.5 s, or a hard impact then stillness ----
  let peaks = [];
  function onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    const m = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    const now = performance.now();
    if (Math.abs(m - 9.8) > 14 && (!peaks.length || now - peaks[peaks.length - 1] > 120)) {
      peaks.push(now);
      peaks = peaks.filter((p) => now - p < 1500);
      if (peaks.length >= 3) { peaks = []; impactAt = 0; trigger('fall'); return; }
    }
    if (m > 30 && !impactAt) { impactAt = now; quietFrom = 0; }
    if (!impactAt) return;
    if (Math.abs(m - 9.8) > 3) quietFrom = 0; else if (!quietFrom) quietFrom = now;
    if (now - impactAt > 5000) impactAt = 0;
    else if (quietFrom && now - quietFrom > 1800 && now - impactAt > 2000) { impactAt = 0; trigger('fall'); }
  }
  let motionOn = false;
  // iPhones ask permission, and only inside a tap, so this runs straight from the Home Watch button.
  async function enableMotion() {
    if (motionOn || typeof DeviceMotionEvent === 'undefined') return;
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try { if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return; } catch (e) { return; }
    }
    window.addEventListener('devicemotion', onMotion);
    motionOn = true;
  }

  // ---- Open and close ---------------------------------------------------------------
  async function open() {
    enableMotion();
    $('#watch-game').hidden = false;
    document.body.classList.add('in-game');
    await ensureScene();
    if (!scene && app.use3d()) { sceneLoading = null; await ensureScene(); }
    if (scene) { scene.resize(); scene.start(); pushToScene(); }
    $('#game-canvas').hidden = !scene;
    render();
    renderChat(); renderChain();
  }
  function close() {
    stopAlert();
    if (!fired) resetState(false);
    else { cancelAnimationFrame(raf); running = false; }
    if (scene) scene.stop();
    $('#watch-game').hidden = true;
    document.body.classList.remove('in-game');
  }

  function init(ctx) {
    app = ctx;
    $('#g-close').onclick = close;
    $('#g-start').onclick = () => { if (rescued || fired) resetState(true); else if (running) resetState(false); else startStorm(); };
    $('#watch-cancel').onclick = () => {
      stopAlert();
      snoozeUntil = performance.now() + SNOOZE_MS;
      if (fallen) { fallen = false; sc('setFallen', false); }
      app.toast('Okay. Home Watch will keep watching.');
    };
    // Hidden shortcut for testing on a laptop, like D and R on the rescue post.
    document.addEventListener('keydown', (e) => { if ((e.key === 'f' || e.key === 'F') && !$('#watch-game').hidden && !app.hasSos() && !fired) trigger('fall'); });
    window.addEventListener('resize', () => { if (scene && !$('#watch-game').hidden) scene.resize(); });
    document.addEventListener('visibilitychange', () => {
      if (!scene || $('#watch-game').hidden) return;
      if (document.hidden) scene.stop(); else scene.start();
    });
    render();
  }

  window.LifelineWatch = { init, open, onQuestion, onRelayed, onReply, onSafe };
})();
