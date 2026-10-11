import * as THREE from './vendor/three.module.min.js';

const DEG = Math.PI / 180;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// Dreht das Geräte-Koordinatensystem so, dass die Kamera aus der Rückseite schaut.
const BACK_CAMERA = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

// Kopfausrichtung aus dem Lagesensor. Hält einen kurzen Verlauf, damit die
// virtuellen Objekte mit derselben Verzögerung wie das Kamerabild laufen können.
export class Orientation {
  constructor() {
    this.samples = [];
    this.hasSensor = false;
    // Ersatz ohne Sensor (PC): Blickrichtung per Maus/Finger ziehen.
    this.yaw = 0;
    this.pitch = 0;
    this._euler = new THREE.Euler();
    this._tmp = new THREE.Quaternion();
    this._handler = (e) => this._onEvent(e);
  }

  // iOS fragt nach Erlaubnis; muss direkt aus einem Tippen heraus aufgerufen werden.
  static requestPermission() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      return DOE.requestPermission().then((r) => r === 'granted').catch(() => false);
    }
    return Promise.resolve(!!DOE);
  }

  start() {
    window.addEventListener('deviceorientation', this._handler);
  }

  stop() {
    window.removeEventListener('deviceorientation', this._handler);
  }

  _screenAngle() {
    const so = screen.orientation;
    const a = so && typeof so.angle === 'number' ? so.angle : window.orientation || 0;
    return a * DEG;
  }

  _onEvent(e) {
    if (e.beta == null && e.gamma == null) return;
    this.hasSensor = true;
    const q = new THREE.Quaternion();
    this._euler.set((e.beta || 0) * DEG, (e.alpha || 0) * DEG, -(e.gamma || 0) * DEG, 'YXZ');
    q.setFromEuler(this._euler);
    q.multiply(BACK_CAMERA);
    q.multiply(this._tmp.setFromAxisAngle(Z_AXIS, -this._screenAngle()));
    this.samples.push({ t: performance.now(), q });
    if (this.samples.length > 90) this.samples.shift();
  }

  // Schreibt die Ausrichtung zum Zeitpunkt t (performance.now, ms) nach out.
  at(t, out) {
    const s = this.samples;
    if (!this.hasSensor || s.length === 0) {
      this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
      return out.setFromEuler(this._euler);
    }
    if (t >= s[s.length - 1].t) return out.copy(s[s.length - 1].q);
    if (t <= s[0].t) return out.copy(s[0].q);
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      if (a.t <= t) {
        const b = s[i];
        const k = (t - a.t) / Math.max(b.t - a.t, 1e-3);
        return out.copy(a.q).slerp(b.q, k);
      }
    }
    return out.copy(s[0].q);
  }
}
