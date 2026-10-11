// Marker-Erkennung im Hintergrund-Thread, damit die Darstellung flüssig bleibt.
importScripts('vendor/cv.js', 'vendor/aruco.js');

let detector = null;
let allowed = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    // Niedrige Hamming-Distanz: lieber einen Marker verpassen als einen falschen erkennen.
    detector = new AR.Detector({ dictionaryName: msg.dictionary, maxHammingDistance: 6 });
    // Fast deckungsgleiche Vierecke nicht vorab aussortieren: Bei kleinen Markern liegen der
    // Rand des weißen Papiers und das schwarze Quadrat eng beieinander, und die Bibliothek würde
    // das richtige, kleinere Viereck verwerfen. Doppelte Treffer werden unten nach ID bereinigt.
    detector.notTooNear = (candidates) => candidates;
    allowed = new Set(msg.ids);
    return;
  }
  const image = { width: msg.w, height: msg.h, data: new Uint8ClampedArray(msg.buf) };
  let markers = [];
  try {
    const best = new Map();
    for (const m of detector.detect(image)) {
      if (!allowed.has(m.id)) continue;
      const prev = best.get(m.id);
      if (!prev || m.hammingDistance < prev.hammingDistance) best.set(m.id, m);
    }
    markers = [...best.values()].map((m) => ({ id: m.id, corners: m.corners.map((c) => ({ x: c.x, y: c.y })) }));
  } catch (err) {
    markers = [];
  }
  self.postMessage({ frameId: msg.frameId, markers, buf: msg.buf }, [msg.buf]);
};
