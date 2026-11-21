/*
 * LIFELINE sound engine.
 *
 * Turns a message into a chirp the speaker can play, and turns what the
 * microphone hears back into a message. All of the audio lives here: ggwave
 * setup, the 48 kHz resampling the decoder needs, busy-channel detection so
 * two phones don't talk over each other, and the transmit queue.
 *
 * Exposed as window.LifelineSound. The relay rules live in mesh.js and the
 * screens live in app.js; neither of those touches audio directly.
 */
(() => {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let S = null;  // settings, handed over by app.js via Sound.useSettings

  const PROTOCOLS = {
    DT_FASTEST: { label: 'Dual tone, quick', id: 'GGWAVE_PROTOCOL_DT_FASTEST' },
    DT_FAST: { label: 'Dual tone, steadier in noisy rooms', id: 'GGWAVE_PROTOCOL_DT_FAST' },
    AUDIBLE_FAST: { label: 'Classic, quick', id: 'GGWAVE_PROTOCOL_AUDIBLE_FAST' },
    AUDIBLE_NORMAL: { label: 'Classic, steadier', id: 'GGWAVE_PROTOCOL_AUDIBLE_NORMAL' },
  };

  // ------------------------------------------------------------------
  // Sound engine (ggwave)
  // ------------------------------------------------------------------
  function convertTypedArray(src, type) {
    const buffer = new ArrayBuffer(src.byteLength);
    new src.constructor(buffer).set(src);
    return new type(buffer);
  }

  // ggwave decodes reliably only at 48,000 samples per second. If the device records at
  // another rate (many laptops use 44,100), convert the stream before decoding.
  const RX_RATE = 48000;
  function makeResampler(inRate, outRate) {
    const ratio = inRate / outRate;
    let pos = 0;
    let prev = 0;
    return (input) => {
      const out = [];
      while (pos < input.length - 1) {
        const i = Math.floor(pos);
        const t = pos - i;
        const a = i < 0 ? prev : input[i];
        const b = input[i + 1];
        out.push(a * (1 - t) + b * t);
        pos += ratio;
      }
      pos -= input.length;
      prev = input[input.length - 1];
      return out;
    };
  }

  const Sound = {
    // app.js hands over the saved settings once, at startup.
    useSettings(settings) { S = settings; },
    PROTOCOLS,

    ready: false,
    ctx: null, gg: null, tx: null, rx: null, analyser: null, proc: null, stream: null,
    level: 0, noiseFloor: 0.004, lastBusy: 0, muteUntil: 0, transmitting: false,
    chain: Promise.resolve(),
    onDecoded: null, onTxStart: null, onTxEnd: null,

    async start() {
      if (!window.isSecureContext) throw new Error('This page must be opened over https:// (or localhost) to use the microphone.');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot use the microphone.');
      const AC = window.AudioContext || window.webkitAudioContext;
      try { this.ctx = new AC({ sampleRate: RX_RATE }); } catch (e) { this.ctx = new AC(); }
      // Ask for the mic with the phone's call "cleanup" turned off: it treats chirps as noise.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      await this.ctx.resume();

      this.gg = await window.ggwave_factory();
      try { this.gg.disableLog(); } catch (e) { /* older builds */ }
      // Dual-tone modes are off for receiving by default; switch every mode on so any phone can hear any style.
      Object.values(PROTOCOLS).forEach((p) => {
        try { this.gg.rxToggleProtocol(this.gg.ProtocolId[p.id], 1); } catch (e) { /* ignore */ }
      });
      ['GGWAVE_PROTOCOL_DT_NORMAL'].forEach((k) => { try { this.gg.rxToggleProtocol(this.gg.ProtocolId[k], 1); } catch (e) { /* ignore */ } });

      // Separate instances so sending never disturbs listening.
      const txParams = this.gg.getDefaultParameters();
      txParams.sampleRateInp = this.ctx.sampleRate;
      txParams.sampleRateOut = this.ctx.sampleRate;
      this.tx = this.gg.init(txParams);
      const rxParams = this.gg.getDefaultParameters();
      rxParams.sampleRateInp = RX_RATE;
      rxParams.sampleRateOut = RX_RATE;
      this.rxParams = rxParams;
      this.rx = this.gg.init(rxParams);
      this.burstSinceReset = false;
      this.resample = this.ctx.sampleRate === RX_RATE ? null : makeResampler(this.ctx.sampleRate, RX_RATE);
      this.rxBuf = new Float32Array(1024);
      this.rxFill = 0;

      const source = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0.2;
      source.connect(this.analyser);

      this.proc = this.ctx.createScriptProcessor(1024, 1, 1);
      const silent = this.ctx.createGain();
      silent.gain.value = 0;
      source.connect(this.proc);
      this.proc.connect(silent);
      silent.connect(this.ctx.destination);
      this.proc.onaudioprocess = (e) => this._onAudio(e.inputBuffer.getChannelData(0));
      this.ready = true;
    },

    _onAudio(data) {
      const now = performance.now();
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const muted = this.transmitting || now < this.muteUntil;
      if (!muted) {
        this.level = rms;
        // Simple "is someone talking?" detector used before relaying.
        if (rms > Math.max(0.012, this.noiseFloor * 4)) { this.lastBusy = now; this.burstSinceReset = true; }
        else this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
        // A burst of sound ended 3 s ago without producing a message (cut off, collided or garbled).
        // Reset the decoder so it isn't left waiting for the end of that message.
        if (this.burstSinceReset && now - this.lastBusy > 3000) this.resetDecoder();
      } else {
        this.level = 0;
      }
      // While this phone is chirping, feed the decoder silence so it never decodes itself.
      const input = muted ? new Float32Array(data.length) : data;
      const samples = this.resample ? this.resample(input) : input;
      // Hand the decoder exact 1024-sample frames.
      for (let i = 0; i < samples.length; i++) {
        this.rxBuf[this.rxFill++] = samples[i];
        if (this.rxFill === 1024) {
          this.rxFill = 0;
          const res = this.gg.decode(this.rx, convertTypedArray(this.rxBuf, Int8Array));
          if (!muted && res && res.length > 0) {
            this.burstSinceReset = false;
            let text = '';
            try { text = new TextDecoder('utf-8').decode(res); } catch (e) { continue; }
            if (this.onDecoded) setTimeout(() => this.onDecoded(text), 0);
          }
        }
      }
    },

    // Start a fresh decoder. Needed after this phone stops listening partway through
    // someone else's chirp, otherwise it keeps waiting for the end of that message.
    resetDecoder() {
      try { this.gg.free(this.rx); } catch (e) { /* ignore */ }
      this.rx = this.gg.init(this.rxParams);
      this.rxFill = 0;
      this.burstSinceReset = false;
    },

    channelBusy() {
      return this.transmitting || performance.now() - this.lastBusy < 450;
    },

    async _chime() {
      const t0 = this.ctx.currentTime + 0.02;
      const notes = [[659.25, 0], [987.77, 0.13]];
      for (const [freq, at] of notes) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + at + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.32);
        osc.connect(g).connect(this.ctx.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + 0.35);
      }
      await sleep(560);
    },

    // Short bell-like ping for "a request just arrived", played when a phone or the
    // rescue post receives someone's SOS. Quiet and brief; the mic is muted for its length.
    async ping() {
      if (!S.chime || !this.ctx || this.transmitting) return;
      if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { /* ignore */ } }
      const t0 = this.ctx.currentTime + 0.02;
      const partials = [[1318.5, 0.30], [2637, 0.10], [3951, 0.04]];
      const out = this.ctx.createGain();
      out.gain.value = 0.5;
      out.connect(this.ctx.destination);
      for (const [freq, amp] of partials) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(amp, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
        osc.connect(g).connect(out);
        osc.start(t0);
        osc.stop(t0 + 0.6);
      }
      this.muteUntil = Math.max(this.muteUntil || 0, performance.now() + 650);
    },

    _play(buffer) {
      return new Promise((resolve) => {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.ctx.destination);
        src.onended = resolve;
        src.start();
      });
    },

    // Queue a transmission. Returns a promise that resolves when the chirp has finished playing.
    // shouldSend (optional) is checked right before chirping, so a send that became
    // unnecessary while waiting for quiet can be dropped.
    send(text, shouldSend) {
      const run = async () => {
        if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { /* ignore */ } }
        // Listen before talking: if someone else is chirping, wait (up to about 6 s) for quiet.
        for (let i = 0; i < 10 && performance.now() - this.lastBusy < 450; i++) await sleep(450 + Math.random() * 300);
        if (shouldSend && !shouldSend()) return;
        this.transmitting = true;
        if (this.onTxStart) this.onTxStart(text);
        try {
          const proto = this.gg.ProtocolId[(PROTOCOLS[S.protocol] || PROTOCOLS.DT_FASTEST).id];
          const waveform = this.gg.encode(this.tx, text, proto, S.volume);
          const samples = convertTypedArray(new Int8Array(waveform), Float32Array);
          // Half a second of silence first: laptop and Bluetooth speakers wake up slowly and
          // swallow the start of a chirp, which is the part the listener needs to lock on to.
          const lead = Math.round(this.ctx.sampleRate * 0.5), tail = Math.round(this.ctx.sampleRate * 0.15);
          const buf = this.ctx.createBuffer(1, lead + samples.length + tail, this.ctx.sampleRate);
          buf.getChannelData(0).set(samples, lead);
          await this._play(buf);
        } finally {
          this.transmitting = false;
          this.muteUntil = performance.now() + 300;
          this.resetDecoder();
          if (this.onTxEnd) this.onTxEnd(text);
        }
      };
      this.chain = this.chain.then(run, run);
      return this.chain;
    },
  };

  window.LifelineSound = Sound;
})();
