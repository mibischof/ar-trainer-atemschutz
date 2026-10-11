const STORAGE_KEY = 'ar-trainer-settings-v1';

export const DEFAULTS = {
  viewMode: 'hand', // hand | mono | stereo
  lensZoom: 0.8,
  lensK1: 0.22,
  lensK2: 0.05,
  lensSep: 0.5,
  lensOffsetY: 0,
  grid: false,
  preset: 'einstieg',
  smokeBase: 1.6,
  smokeDensity: 0.35,
  haze: 0.05,
  darkness: 0.25,
  growth: 'langsam',
  flashover: false,
  roomDepth: 4,
  ceiling: 2.6,
  flow: 130,
  eyeMode: 'auto',
  eyeHeight: 1.6,
  camFov: 65,
  markerSize: 15,
  sensorDelay: 60,
  screenRotation: 'auto',
  quality: 'mittel',
  sound: true,
  debug: false,
};

export const PRESETS = {
  einstieg: {
    label: 'Einstieg',
    desc: 'Leichter Rauch ab 1,6 m, wenig Dunkelheit, Feuer wachsen langsam.',
    values: { smokeBase: 1.6, smokeDensity: 0.35, haze: 0.05, darkness: 0.25, growth: 'langsam', flashover: false },
  },
  wohnung: {
    label: 'Wohnungsbrand',
    desc: 'Rauchschicht ab 1,1 m, dunkel. Tief bleiben, Person suchen, Rauchgase kühlen.',
    values: { smokeBase: 1.1, smokeDensity: 0.65, haze: 0.15, darkness: 0.55, growth: 'mittel', flashover: true },
  },
  nullsicht: {
    label: 'Nullsicht',
    desc: 'Rauch bis 0,5 m über dem Boden, fast dunkel. Durchzündung nach wenigen Minuten.',
    values: { smokeBase: 0.5, smokeDensity: 0.9, haze: 0.35, darkness: 0.8, growth: 'schnell', flashover: true },
  },
};

const pct = (v) => `${Math.round(v * 100)} %`;
const m = (v) => `${v.toFixed(1).replace('.', ',')} m`;
const isHeadset = (s) => s.viewMode !== 'hand';

export const SCHEMA = [
  {
    group: 'Ansicht & Linsen',
    note: 'Bei „Brille“ wird das Bild für die Linsen vorverzerrt. Mit dem Testgitter in der Brille nachjustieren.',
    items: [
      {
        key: 'viewMode',
        label: 'Darstellung',
        type: 'select',
        options: [
          ['hand', 'In der Hand (ohne Brille)'],
          ['mono', 'Brille mit 1 großer Linse'],
          ['stereo', 'Brille mit 2 Linsen (Cardboard)'],
        ],
      },
      { key: 'lensZoom', label: 'Bildgröße', type: 'range', min: 0.4, max: 1.6, step: 0.01, fmt: pct, show: isHeadset },
      { key: 'lensK1', label: 'Linsenkorrektur', type: 'range', min: 0, max: 0.6, step: 0.01, fmt: (v) => v.toFixed(2), show: isHeadset },
      {
        key: 'lensSep',
        label: 'Linsenabstand',
        type: 'range',
        min: 0.35,
        max: 0.65,
        step: 0.005,
        fmt: (v) => `${Math.round(v * 100)} % der Breite`,
        show: (s) => s.viewMode === 'stereo',
      },
      { key: 'lensOffsetY', label: 'Höhe der Bildmitte', type: 'range', min: -0.2, max: 0.2, step: 0.005, fmt: pct, show: isHeadset },
      { key: 'grid', label: 'Testgitter einblenden', type: 'toggle' },
    ],
  },
  {
    group: 'Szenario',
    items: [
      { key: 'smokeBase', label: 'Rauchgrenze über Boden', type: 'range', min: 0.2, max: 2.4, step: 0.05, fmt: m },
      { key: 'smokeDensity', label: 'Rauchdichte', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'haze', label: 'Rauch im ganzen Raum', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'darkness', label: 'Dunkelheit', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
      {
        key: 'growth',
        label: 'Brandausbreitung',
        type: 'select',
        options: [
          ['langsam', 'Langsam'],
          ['mittel', 'Mittel'],
          ['schnell', 'Schnell'],
        ],
      },
      { key: 'flashover', label: 'Durchzündung möglich', type: 'toggle' },
      { key: 'flow', label: 'Durchfluss Strahlrohr', type: 'range', min: 50, max: 400, step: 5, fmt: (v) => `${v} l/min` },
      { key: 'roomDepth', label: 'Abstand zu den Wänden', type: 'range', min: 1.5, max: 10, step: 0.5, fmt: m },
      { key: 'ceiling', label: 'Raumhöhe', type: 'range', min: 2.1, max: 4.5, step: 0.05, fmt: m },
    ],
  },
  {
    group: 'Kopfhöhe',
    note: 'Automatisch: Die App schätzt die Augenhöhe, sobald ein Marker am Boden im Bild ist. So merkt sie, ob der Trupp kriecht.',
    items: [
      {
        key: 'eyeMode',
        label: 'Augenhöhe',
        type: 'select',
        options: [
          ['auto', 'Automatisch über Bodenmarker'],
          ['manual', 'Fester Wert'],
        ],
      },
      { key: 'eyeHeight', label: 'Augenhöhe (Startwert)', type: 'range', min: 0.3, max: 2, step: 0.05, fmt: m },
    ],
  },
  {
    group: 'Kamera & Marker',
    note: 'Wenn Rauch und Feuer gegenüber dem Kamerabild um 90° gedreht sind, die Bildschirmdrehung von Hand festlegen.',
    items: [
      { key: 'markerSize', label: 'Markergröße (gedruckt)', type: 'range', min: 5, max: 60, step: 0.5, fmt: (v) => `${v} cm` },
      { key: 'camFov', label: 'Kamera-Sichtfeld', type: 'range', min: 40, max: 100, step: 1, fmt: (v) => `${v}°` },
      { key: 'sensorDelay', label: 'Sensor-Verzögerung', type: 'range', min: 0, max: 200, step: 5, fmt: (v) => `${v} ms` },
      {
        key: 'screenRotation',
        label: 'Bildschirmdrehung',
        type: 'select',
        options: [
          ['auto', 'Automatisch'],
          ['0', '0°'],
          ['90', '90°'],
          ['180', '180°'],
          ['270', '270°'],
        ],
      },
      {
        key: 'quality',
        label: 'Grafikqualität',
        type: 'select',
        options: [
          ['niedrig', 'Niedrig (schwache Geräte)'],
          ['mittel', 'Mittel'],
          ['hoch', 'Hoch'],
        ],
      },
      { key: 'sound', label: 'Ton', type: 'toggle' },
      { key: 'debug', label: 'Technische Anzeige', type: 'toggle' },
    ],
  },
];

export function loadSettings() {
  const s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(s, JSON.parse(raw));
  } catch {
    // Kein Speicher verfügbar: mit Standardwerten weiterarbeiten.
  }
  return s;
}

export function saveSettings(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Ignorieren: Einstellungen gelten dann nur bis zum Neuladen.
  }
}

export function applyPreset(s, key) {
  const p = PRESETS[key];
  if (!p) return;
  Object.assign(s, p.values);
  s.preset = key;
}
