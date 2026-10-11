// Marker-Erkennung im Hintergrund-Thread, damit die Darstellung flüssig bleibt.
importScripts('vendor/cv.js', 'vendor/aruco.js');

let detector = null;
let allowed = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    // Niedrige Hamming-Distanz: lieber einen Marker verpassen als einen falschen erkennen.
    detector = new AR.Detector({ dictionaryName: msg.dictionary, maxHammingDistance: 6 });
    allowed = new Set(msg.ids);
    return;
  }
  const image = { width: msg.w, height: msg.h, data: new Uint8ClampedArray(msg.buf) };
  let markers = [];
  try {
    markers = detector
      .detect(image)
      .filter((m) => allowed.has(m.id))
      .map((m) => ({ id: m.id, corners: m.corners.map((c) => ({ x: c.x, y: c.y })) }));
  } catch (err) {
    markers = [];
  }
  self.postMessage({ frameId: msg.frameId, markers, buf: msg.buf }, [msg.buf]);
};
