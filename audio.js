// Erzeugte Geräusche (keine Audiodateien): Feuer, Knistern, Wasser, Grollen, Signaltöne.
export class Sound {
  constructor() {
    this.ctx = null;
  }

  // Muss aus einem Tippen heraus aufgerufen werden (Browser-Regel für Ton).
  start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) {
      this.ctx = new AC();
      this._build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _noise(seconds) {
    const c = this.ctx;
    const buf = c.createBuffer(1, Math.round(seconds * c.sampleRate), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _loop(buffer, ...chain) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    let node = src;
    for (const next of chain) {
      node.connect(next);
      node = next;
    }
    src.start();
    return node;
  }

  _filter(type, freq, q = 0.7) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  _gain(v = 0) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  _build() {
    const c = this.ctx;
    const noise = this._noise(2);
    this.master = this._gain(0.9);
    this.master.connect(c.destination);
    this.firePan = c.createStereoPanner ? c.createStereoPanner() : this._gain(1);
    this.firePan.connect(this.master);

    this.fireGain = this._gain();
    this._loop(noise, this._filter('bandpass', 600, 0.6), this.fireGain).connect(this.firePan);

    this.waterGain = this._gain();
    this._loop(noise, this._filter('highpass', 1200), this.waterGain).connect(this.master);

    this.rumbleGain = this._gain();
    this._loop(noise, this._filter('lowpass', 140), this.rumbleGain).connect(this.master);

    this.crackBuf = this._noise(0.06);
  }

  update(dt, { fire, pan, water, heat, enabled }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = enabled ? 1 : 0;
    this.fireGain.gain.setTargetAtTime(0.25 * fire * k, t, 0.1);
    if (this.firePan.pan) this.firePan.pan.setTargetAtTime(pan, t, 0.1);
    this.waterGain.gain.setTargetAtTime(0.35 * water * k, t, 0.05);
    this.rumbleGain.gain.setTargetAtTime(0.7 * heat * heat * k, t, 0.2);
    if (k && fire > 0.02 && Math.random() < dt * 25 * fire) this._crack(fire, t);
  }

  _crack(level, t) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.crackBuf;
    src.playbackRate.value = 0.6 + Math.random() * 1.4;
    const g = this._gain(0);
    g.gain.setValueAtTime(0.5 * level * (0.3 + Math.random() * 0.7), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04 + Math.random() * 0.05);
    const hp = this._filter('highpass', 1500);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.firePan);
    src.start(t);
    src.stop(t + 0.12);
  }

  // Kurze Tonfolge, z. B. [660, 880] für „gelöscht“.
  beep(freqs, duration = 0.12, enabled = true) {
    if (!this.ctx || !enabled) return;
    const c = this.ctx;
    let t = c.currentTime;
    for (const f of freqs) {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = this._gain(0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + duration + 0.02);
      t += duration * 0.9;
    }
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }
}
