// Marker, die die App kennt. Die IDs stammen aus dem ArUco-Wörterbuch ARUCO_MIP_36h12.
export const MARKER_DICTIONARY = 'ARUCO_MIP_36h12';

export const MARKERS = [
  { id: 1, kind: 'fire', num: 1, label: 'Feuer 1' },
  { id: 2, kind: 'fire', num: 2, label: 'Feuer 2' },
  { id: 3, kind: 'fire', num: 3, label: 'Feuer 3' },
  { id: 4, kind: 'fire', num: 4, label: 'Feuer 4' },
  { id: 11, kind: 'person', num: 1, label: 'Person 1' },
  { id: 12, kind: 'person', num: 2, label: 'Person 2' },
];

export const markerById = new Map(MARKERS.map((m) => [m.id, m]));
