import * as THREE from './vendor/three.module.min.js';

const DEG = Math.PI / 180;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// Dreht das Geräte-Koordinatensystem so, dass die Kamera aus der Rückseite schaut.
const BACK_CAMERA = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Rundet auf 0, 90, 180 oder 270 Grad.
function quarter(deg) {
  return (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
}

// Welche Geräteseite nach oben zeigt, als Bildschirmdrehung (0/90/180/270).
// null, wenn das Gerät fast flach liegt und die Richtung unklar ist.
function gravityAngle(beta, gamma) {
  const b = beta * DEG;
  const g = gamma * DEG;
  const upX = -Math.sin(g) * Math.cos(b);
  const upY = Math.sin(b);
  if (Math.hypot(upX, upY) < 0.5) return null;
  return quarter(Math.atan2(upX, upY) / DEG);
}

// Kopfausrichtung aus dem Lagesensor. Hält einen kurzen Verlauf, damit die
// virtuellen Objekte mit derselben Verzögerung wie das Kamerabild laufen können.
export class Orientation {
  constructor() {
    this.samples = [];
    this.hasSensor = false;
    // Ersatz ohne Sensor (PC): Blickrichtung per Maus/Finger ziehen.
    this.yaw = 0;
    this.pitch = 0;
    this.override = null;
    this.reportedAngle = 0;
    this.gravityAngle = null;
    this.usedAngle = 0;
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

  // Drehung des Bildschirminhalts gegenüber der natürlichen Haltung des Geräts (0/90/180/270 Grad).
  // Manche Geräte melden sie falsch (z. B. iPad im Querformat), daher Abgleich mit
  // Fensterform und Schwerkraft. Mit override lässt sie sich von Hand festlegen.
  screenAngle(beta, gamma) {
    const so = screen.orientation;
    const reported = quarter(so && typeof so.angle === 'number' ? so.angle : Number(window.orientation) || 0);
    const gravity = gravityAngle(beta, gamma);
    const landscape = window.innerWidth > window.innerHeight;
    // Bei Geräten mit natürlichem Hochformat passen 0/180 Grad nur zu einem hohen Fenster.
    const fitsPortraitDevice = (reported % 180 === 0) !== landscape;
    let angle = reported;
    if (this.override != null) {
      angle = this.override;
    } else if (!fitsPortraitDevice) {
      if (IS_IOS) {
        // iPhone und iPad haben immer natürliches Hochformat: der gemeldete Wert ist falsch.
        angle = gravity != null && (gravity % 180 === 0) !== landscape ? gravity : landscape ? 90 : 0;
      } else if (gravity != null && gravity % 180 !== reported % 180) {
        // Tablets mit natürlichem Querformat melden zu Recht 0; nur bei Widerspruch zur Schwerkraft korrigieren.
        angle = gravity;
      }
    }
    this.reportedAngle = reported;
    this.gravityAngle = gravity;
    this.usedAngle = angle;
    return angle;
  }

  _onEvent(e) {
    if (e.beta == null && e.gamma == null) return;
    this.hasSensor = true;
    const q = new THREE.Quaternion();
    this._euler.set((e.beta || 0) * DEG, (e.alpha || 0) * DEG, -(e.gamma || 0) * DEG, 'YXZ');
    q.setFromEuler(this._euler);
    q.multiply(BACK_CAMERA);
    q.multiply(this._tmp.setFromAxisAngle(Z_AXIS, -this.screenAngle(e.beta || 0, e.gamma || 0) * DEG));
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
