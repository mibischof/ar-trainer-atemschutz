import * as THREE from './vendor/three.module.min.js';
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

// Verhältnis Höhe zu Breite des Markers im Bild, gemessen entlang der Senkrechten der Welt
// (upX/upY: Richtung „oben“ im Bild in Pixelkoordinaten, y nach unten).
export function markerUprightRatio(c, upX, upY) {
  let minU = Infinity;
  let maxU = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  for (const p of c) {
    const u = p.x * upX + p.y * upY;
    const r = -p.x * upY + p.y * upX;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
  }
  return (maxU - minU) / Math.max(maxR - minR, 1e-6);
}

// Lage eines quadratischen Markers aus seinen 4 Bildecken (über die Homographie).
// Nur bei großen Markern verlässlich; kleine Marker liefern eine sehr ungenaue Lage.
// f, cx, cy: Brennweite und Bildmitte in Pixeln, size: Kantenlänge des schwarzen Quadrats in m.
// Ergebnis im Kamerasystem (x rechts, y oben, Blick entlang -z): Mittelpunkt in m und
// Flächennormale, die zur Kamera zeigt. null, wenn sich keine Lage bestimmen lässt.
export function markerPose(corners, f, cx, cy, size) {
  const h = size / 2;
  const model = [
    [-h, h],
    [h, h],
    [h, -h],
    [-h, -h],
  ];
  // Bildpunkte als normierte Kamerakoordinaten (y nach unten, Blick entlang +z)
  const image = corners.map((c) => [(c.x - cx) / f, (c.y - cy) / f]);
  const H = homography(model, image);
  if (!H) return null;
  const c1 = [H[0], H[3], H[6]];
  const c2 = [H[1], H[4], H[7]];
  const c3 = [H[2], H[5], H[8]];
  const n1 = Math.hypot(...c1);
  const n2 = Math.hypot(...c2);
  if (n1 < 1e-9 || n2 < 1e-9) return null;
  let s = 2 / (n1 + n2);
  if (c3[2] * s < 0) s = -s; // Marker liegt vor der Kamera
  const r1 = c1.map((v) => v * s);
  const r2 = c2.map((v) => v * s);
  const t = c3.map((v) => v * s);
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  // Umrechnen in das Koordinatensystem von three.js (y nach oben, Blick entlang -z)
  const center = new THREE.Vector3(t[0], -t[1], -t[2]);
  const normal = new THREE.Vector3(r3[0], -r3[1], -r3[2]).normalize();
  if (normal.dot(center) > 0) normal.negate();
  return { center, normal };
}

// Homographie aus 4 Punktpaaren (H[8] = 1), Zeilen zuerst.
function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [X, Y] = src[i];
    const [x, y] = dst[i];
    A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]);
    b.push(x);
    A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]);
    b.push(y);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

// Gauß-Elimination mit Pivotsuche.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
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
