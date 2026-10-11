import { MARKERS, MARKER_DICTIONARY } from './markers.js';

// Holt Einzelbilder aus dem Kamerabild und schickt sie an den Erkennungs-Worker.
export class Tracker {
  constructor(video, maxSize = 640) {
    this.video = video;
    this.maxSize = maxSize;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.busy = false;
    this.frameId = 0;
    this.pending = new Map();
    this.onResult = null;
    this.lastMs = 0;
    this.lastCount = 0;
    this.worker = new Worker('tracker-worker.js');
    this.worker.postMessage({ type: 'init', dictionary: MARKER_DICTIONARY, ids: MARKERS.map((m) => m.id) });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = () => {
      this.busy = false;
    };
  }

  // meta wird unverändert an onResult zurückgegeben (z. B. Ausrichtung beim Aufnehmen).
  tick(meta) {
    const v = this.video;
    if (this.busy || !v.videoWidth || v.readyState < 2) return false;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const scale = Math.min(1, this.maxSize / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(v, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    const frameId = ++this.frameId;
    this.pending.set(frameId, { ...meta, scale, vw, vh, t0: performance.now() });
    this.busy = true;
    this.worker.postMessage({ type: 'frame', frameId, w, h, buf: img.data.buffer }, [img.data.buffer]);
    return true;
  }

  _onMessage(data) {
    this.busy = false;
    const meta = this.pending.get(data.frameId);
    this.pending.delete(data.frameId);
    if (!meta) return;
    this.lastMs = performance.now() - meta.t0;
    this.lastCount = data.markers.length;
    // Ecken zurück in Kamerabild-Pixel umrechnen.
    const markers = data.markers.map((m) => ({
      id: m.id,
      corners: m.corners.map((c) => ({ x: c.x / meta.scale, y: c.y / meta.scale })),
    }));
    if (this.onResult) this.onResult(markers, meta);
  }
}

// Mittelpunkt als Schnittpunkt der Diagonalen (perspektivisch korrekt).
export function markerCenter(c) {
  const [p0, p1, p2, p3] = c;
  const d1x = p2.x - p0.x;
  const d1y = p2.y - p0.y;
  const d2x = p3.x - p1.x;
  const d2y = p3.y - p1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-6) {
    return { x: (p0.x + p1.x + p2.x + p3.x) / 4, y: (p0.y + p1.y + p2.y + p3.y) / 4 };
  }
  const t = ((p1.x - p0.x) * d2y - (p1.y - p0.y) * d2x) / den;
  return { x: p0.x + t * d1x, y: p0.y + t * d1y };
}

// Längste Kante in Pixeln: am wenigsten verkürzt, daher gute Basis für die Entfernung.
export function markerEdge(c) {
  let best = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    best = Math.max(best, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return best;
}
