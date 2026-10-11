// Marker, die die App kennt. Die IDs stammen aus dem ArUco-Wörterbuch ARUCO_MIP_36h12.
export const MARKER_DICTIONARY = 'ARUCO_MIP_36h12';

// Feuer 1–10 haben die IDs 1–10, Personen die IDs 11 und 12.
export const MARKERS = [
  ...Array.from({ length: 10 }, (_, i) => ({ id: i + 1, kind: 'fire', num: i + 1, label: `Feuer ${i + 1}` })),
  { id: 11, kind: 'person', num: 1, label: 'Person 1' },
  { id: 12, kind: 'person', num: 2, label: 'Person 2' },
];

export const markerById = new Map(MARKERS.map((m) => [m.id, m]));
