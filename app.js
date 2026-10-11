import * as THREE from './vendor/three.module.min.js';
import { Orientation } from './sensors.js';
import { Tracker, markerCenter, markerEdge } from './tracker.js';
import { Scenario } from './scenario.js';
import { Renderer } from './render.js';
import { Hud } from './hud.js';
import { Sound } from './audio.js';
import { DEFAULTS, PRESETS, SCHEMA, loadSettings, saveSettings, applyPreset } from './settings.js';

const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);

// Fernbedienungen senden je nach Modell unterschiedliche Tasten.
const PRIMARY_KEYS = new Set(['Enter', 'NumpadEnter', ' ', 'Spacebar', 'ArrowRight', 'ArrowDown', 'PageDown', 'MediaPlayPause', 'AudioVolumeUp', 'AudioVolumeDown']);
const SECONDARY_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'c', 'C']);

// Lange Bildseite für die Marker-Erkennung: größer = Marker aus weiterer Entfernung, aber langsamer.
const DETECT_SIZE = { niedrig: 640, mittel: 960, hoch: 1280 };

const VIEW_MODES = [
  ['hand', 'In der Hand'],
  ['mono', '1 Linse'],
  ['stereo', '2 Linsen'],
];
const VIEW_HINTS = {
  hand: 'Zum Ausprobieren ohne Brille. Die Wasser-Taste unten rechts gedrückt halten.',
  mono: 'Für einen Adapter mit einer großen Lupe (Fresnel-Linse) vor beiden Augen. Tippen auf den Bildschirm öffnet das Menü.',
  stereo: 'Für Cardboard-Brillen mit zwei Linsen. Linsenabstand und Korrektur in den Einstellungen anpassen.',
};

const settings = loadSettings();
const video = $('cam');
const canvas = $('view');
const orientation = new Orientation();
const sound = new Sound();
let renderer = null;
let hud = null;
let tracker = null;
let startupError = null;

try {
  renderer = new Renderer(canvas, video);
  hud = new Hud(renderer.hudCanvas);
} catch (err) {
  startupError = 'Dieses Gerät unterstützt kein WebGL 2. Die Übung kann hier nicht laufen.';
}

const state = {
  running: false,
  paused: false,
  clear: false,
  stream: null,
  wakeLock: null,
  settingsReturn: 'start',
  toasts: [],
  flash: 0,
  flashoverAt: null,
  sprayOpen: 0,
  sprayStart: 0,
  wasSpraying: false,
  doneAnnounced: false,
  fps: 0,
  lastFrame: performance.now(),
  clock: 0,
  debugLines: [],
  debugAt: 0,
  uiAt: 0,
};

const input = { key: false, touch: false, pad: false, padPrev: {} };

const scenario = new Scenario({
  onNew: (o) => {
    if (o.info.kind === 'fire') toast(`${o.info.label} entdeckt`, 'warn');
  },
  onOut: (f) => {
    toast(`${f.info.label} gelöscht`, 'ok');
    sound.beep([660, 880], 0.12, settings.sound);
  },
  onFound: (p) => {
    toast(`${p.info.label} gefunden`, 'ok');
    sound.beep([520, 780, 1040], 0.1, settings.sound);
  },
  onHeatWarning: () => {
    toast('Rauchgase sehr heiß – kühlen!', 'warn', 4);
    sound.beep([300, 300], 0.18, settings.sound);
  },
  onFlashover: () => {
    state.flashoverAt = performance.now();
    sound.beep([200, 150], 0.4, settings.sound);
  },
});

function toast(text, kind = 'info', seconds = 2.6) {
  state.toasts.push({ text, kind, until: performance.now() + seconds * 1000 });
  if (state.toasts.length > 3) state.toasts.shift();
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Abbildung Kamerabild → Blickstrahlen. Das Sichtfeld gilt für die lange Bildseite.
function cameraModel(vw = video.videoWidth || 1280, vh = video.videoHeight || 720) {
  const f = Math.max(vw, vh) / 2 / Math.tan((settings.camFov * DEG) / 2);
  return { vw, vh, f, aspect: vw / vh, vfov: (2 * Math.atan(vh / 2 / f)) / DEG };
}

function resize() {
  if (!renderer) return;
  renderer.resize(window.innerWidth, window.innerHeight, cameraModel().aspect, settings.quality);
  hud.lastKey = '';
}

// ---------- Startseite ----------

function radioButton(className, checked, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(checked));
  b.addEventListener('click', onClick);
  return b;
}

function buildPresets() {
  const box = $('presets');
  box.textContent = '';
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = radioButton('preset', settings.preset === key, () => {
      applyPreset(settings, key);
      saveSettings(settings);
      buildPresets();
      buildSettings();
    });
    const title = document.createElement('strong');
    title.textContent = p.label;
    const desc = document.createElement('span');
    desc.textContent = p.desc;
    b.append(title, desc);
    box.append(b);
  }
}

function setViewMode(mode) {
  settings.viewMode = mode;
  saveSettings(settings);
  buildViewModes();
  buildSettings();
}

function buildViewModes() {
  const box = $('view-modes');
  box.textContent = '';
  for (const [key, label] of VIEW_MODES) {
    const b = radioButton('', settings.viewMode === key, () => setViewMode(key));
    b.textContent = label;
    box.append(b);
  }
  $('view-hint').textContent = VIEW_HINTS[settings.viewMode];
}

function runChecks() {
  const items = [];
  const secure = window.isSecureContext;
  items.push(secure ? ['ok', 'Sichere Verbindung (HTTPS)'] : ['bad', 'Keine sichere Verbindung: Die Kamera funktioniert nur über HTTPS.']);
  const cam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  items.push(cam ? ['ok', 'Kamera-Zugriff möglich'] : ['bad', 'Dieser Browser erlaubt keinen Kamera-Zugriff.']);
  items.push(renderer ? ['ok', 'Grafik (WebGL 2) verfügbar'] : ['bad', 'Grafik (WebGL 2) nicht verfügbar']);
  if (orientation.hasSensor) items.push(['ok', 'Bewegungssensor liefert Daten']);
  else items.push(['maybe', 'Bewegungssensor wird beim Start geprüft']);
  const installed = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone;
  items.push(installed ? ['ok', 'Als App installiert'] : ['maybe', 'Tipp: Im Browser-Menü „Zum Startbildschirm hinzufügen“, dann läuft die App im Vollbild.']);
  const list = $('checks');
  list.textContent = '';
  for (const [cls, text] of items) {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    list.append(li);
  }
  if (startupError) showError(startupError);
}

function showError(text) {
  const el = $('start-error');
  el.textContent = text;
  el.hidden = false;
}

function cameraErrorText(err) {
  if (!window.isSecureContext) return 'Die Seite muss über HTTPS geöffnet werden, sonst gibt der Browser die Kamera nicht frei.';
  switch (err && err.name) {
    case 'NotAllowedError':
      return 'Die Kamera wurde nicht erlaubt. In den Browser-Einstellungen für diese Seite die Kamera freigeben und die Seite neu laden.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Es wurde keine passende Kamera gefunden.';
    case 'NotReadableError':
      return 'Die Kamera wird gerade von einer anderen App benutzt. Diese App schließen und erneut versuchen.';
    default:
      return `Die Kamera konnte nicht gestartet werden (${(err && err.message) || 'unbekannter Fehler'}).`;
  }
}

// ---------- Einstellungen ----------

function buildSettings() {
  const form = $('settings-form');
  form.textContent = '';
  for (const group of SCHEMA) {
    const fs = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = group.group;
    fs.append(legend);
    if (group.note) {
      const p = document.createElement('p');
      p.className = 'note';
      p.textContent = group.note;
      fs.append(p);
    }
    for (const item of group.items) {
      if (item.show && !item.show(settings)) continue;
      fs.append(settingField(item));
    }
    form.append(fs);
  }
}

function settingField(item) {
  const id = `set-${item.key}`;
  const wrap = document.createElement('div');
  wrap.className = item.type === 'toggle' ? 'field toggle' : 'field';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = item.label;

  const changed = () => {
    saveSettings(settings);
    if (item.key === 'viewMode') {
      buildViewModes();
      buildSettings();
      $(id)?.focus();
    }
    if (['camFov', 'quality'].includes(item.key)) resize();
    if (['smokeBase', 'smokeDensity', 'haze', 'darkness', 'growth', 'flashover'].includes(item.key)) {
      settings.preset = 'eigene';
      buildPresets();
    }
  };

  if (item.type === 'toggle') {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = id;
    box.checked = !!settings[item.key];
    box.addEventListener('change', () => {
      settings[item.key] = box.checked;
      changed();
    });
    wrap.append(label, box);
    return wrap;
  }

  const head = document.createElement('div');
  head.className = 'field-head';
  head.append(label);
  wrap.append(head);

  if (item.type === 'select') {
    const sel = document.createElement('select');
    sel.id = id;
    for (const [value, text] of item.options) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      sel.append(o);
    }
    sel.value = settings[item.key];
    sel.addEventListener('change', () => {
      settings[item.key] = sel.value;
      changed();
    });
    wrap.append(sel);
    return wrap;
  }

  const out = document.createElement('output');
  out.htmlFor = id;
  const range = document.createElement('input');
  range.type = 'range';
  range.id = id;
  range.min = item.min;
  range.max = item.max;
  range.step = item.step;
  range.value = settings[item.key];
  const show = () => {
    out.textContent = item.fmt ? item.fmt(Number(settings[item.key])) : String(settings[item.key]);
  };
  range.addEventListener('input', () => {
    settings[item.key] = Number(range.value);
    show();
    changed();
  });
  show();
  head.append(out);
  wrap.append(range);
  return wrap;
}

function openSettings(returnTo) {
  state.settingsReturn = returnTo;
  buildSettings();
  $('pause').hidden = true;
  showScreen('settings');
}

function closeSettings() {
  if (state.settingsReturn === 'run' && state.running) {
    showScreen(null);
    openPause();
  } else {
    showScreen('start');
    runChecks();
  }
}

function showScreen(name) {
  for (const id of ['screen-start', 'screen-settings', 'screen-debrief']) $(id).hidden = id !== `screen-${name}`;
}

// ---------- Übung ----------

function requestFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return;
  try {
    const p = req.call(el, { navigationUI: 'hide' });
    if (p && p.then) {
      p.then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
        .catch(() => {});
    }
  } catch {
    // Vollbild ist optional.
  }
}

async function requestWakeLock() {
  try {
    if (navigator.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    state.wakeLock = null;
  }
}

async function startExercise() {
  if (!renderer) return;
  $('start-error').hidden = true;
  // Diese drei Aufrufe müssen direkt im Tippen passieren (iOS/Android-Regeln).
  sound.start();
  if (settings.viewMode !== 'hand') requestFullscreen();
  const sensorPermission = Orientation.requestPermission();

  const btn = $('btn-start');
  btn.disabled = true;
  btn.textContent = 'Kamera wird gestartet …';
  try {
    if (!state.stream) {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    }
  } catch (err) {
    showError(cameraErrorText(err));
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Übung starten';
  }
  video.srcObject = state.stream;
  try {
    await video.play();
  } catch {
    // Manche Browser starten das Video erst mit den Metadaten; der Ablauf geht trotzdem weiter.
  }
  const sensorOk = await sensorPermission;
  orientation.start();
  if (!sensorOk) toast('Bewegungssensor nicht erlaubt – Blick per Finger ziehen', 'warn', 4);

  if (!tracker) {
    try {
      tracker = new Tracker(video);
      tracker.onResult = onMarkers;
    } catch {
      toast('Marker-Erkennung nicht verfügbar', 'warn', 4);
    }
  }

  scenario.reset();
  renderer.clearObjects();
  Object.assign(state, { running: true, paused: false, clear: false, flash: 0, flashoverAt: null, doneAnnounced: false, toasts: [] });
  input.key = input.touch = input.pad = false;
  $('btn-toggle-clear').textContent = 'Sicht frei einschalten';
  requestWakeLock();
  showScreen(null);
  resize();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  toast('Übung läuft – Marker suchen', 'info', 3);
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
}

function endExercise() {
  state.running = false;
  state.paused = false;
  $('pause').hidden = true;
  $('run-ui').hidden = true;
  $('rotate-hint').hidden = true;
  stopCamera();
  orientation.stop();
  sound.update(0, { fire: 0, pan: 0, water: 0, heat: 0, enabled: false });
  if (state.wakeLock) state.wakeLock.release().catch(() => {});
  state.wakeLock = null;
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  showDebrief();
}

function onMarkers(markers, meta) {
  if (!state.running || state.paused) return;
  const { f } = cameraModel(meta.vw, meta.vh);
  const size = settings.markerSize / 100;
  for (const m of markers) {
    const edge = markerEdge(m.corners);
    if (edge < 8) continue;
    const c = markerCenter(m.corners);
    const ray = new THREE.Vector3((c.x - meta.vw / 2) / f, -(c.y - meta.vh / 2) / f, -1);
    const dist = ((f * size) / edge) * ray.length();
    scenario.observe(m.id, ray.normalize().applyQuaternion(meta.q), dist);
  }
}

function toggleClear() {
  if (!state.running) return;
  state.clear = !state.clear;
  if (state.clear) scenario.clearCount++;
  sound.beep(state.clear ? [1040] : [520], 0.12, settings.sound);
  $('btn-toggle-clear').textContent = state.clear ? 'Sicht frei ausschalten' : 'Sicht frei einschalten';
}

function openPause() {
  if (!state.running) return;
  state.paused = true;
  $('pause').hidden = false;
  $('pause-time').textContent = `Übungszeit ${fmtTime(scenario.time)}`;
  $('btn-resume').focus();
}

function closePause() {
  state.paused = false;
  $('pause').hidden = true;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

function togglePause() {
  if (state.paused) closePause();
  else openPause();
}

// ---------- Auswertung ----------

function showDebrief() {
  const s = scenario;
  const fires = [...s.fires.values()];
  const persons = [...s.persons.values()];
  const out = fires.filter((f) => f.out).length;
  const found = persons.filter((p) => p.found).length;

  let outcome;
  if (s.flashover) outcome = 'Durchzündung. Die Rauchgase wurden nicht rechtzeitig gekühlt.';
  else if (fires.length === 0 && persons.length === 0)
    outcome = 'Es wurde kein Marker erkannt. Liegen die Marker im Licht und stimmt die Markergröße in den Einstellungen?';
  else if (s.allDone) outcome = 'Alle Feuer gelöscht und alle Personen gefunden.';
  else outcome = `${out} von ${fires.length} Feuern gelöscht, ${found} von ${persons.length} Personen gefunden.`;
  $('debrief-outcome').textContent = outcome;

  const stats = [
    ['Übungsdauer', fmtTime(s.time)],
    ['Feuer gelöscht', `${out} / ${fires.length}`],
    ['Personen gefunden', `${found} / ${persons.length}`],
    ['Wasserverbrauch', `${Math.round(s.water)} l`],
    ['Strahlrohr offen', `${Math.round(s.sprayTime)} s`],
    ['Kurze Stöße / lange', `${s.pulses} / ${s.longSprays}`],
    ['Höchste Rauchgas-Hitze', `${Math.round(s.maxHeat * 100)} %`],
    ['„Sicht frei“ benutzt', `${s.clearCount}×`],
  ];
  const dl = $('debrief-stats');
  dl.textContent = '';
  for (const [k, v] of stats) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    div.append(dt, dd);
    dl.append(div);
  }

  const log = $('debrief-log');
  log.textContent = '';
  const entries = s.log.length ? s.log : [{ t: 0, text: 'Keine Ereignisse' }];
  for (const e of entries) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = fmtTime(e.t);
    const span = document.createElement('span');
    span.textContent = e.text;
    li.append(time, span);
    log.append(li);
  }
  showScreen('debrief');
}

// ---------- Eingabe ----------

window.addEventListener('keydown', (e) => {
  if (!state.running || !$('screen-settings').hidden) return;
  if (e.key === 'Escape') {
    togglePause();
    e.preventDefault();
    return;
  }
  if (state.paused) return;
  if (PRIMARY_KEYS.has(e.key)) {
    input.key = true;
    e.preventDefault();
  } else if (SECONDARY_KEYS.has(e.key)) {
    if (!e.repeat) toggleClear();
    e.preventDefault();
  }
});

window.addEventListener('keyup', (e) => {
  if (PRIMARY_KEYS.has(e.key)) {
    input.key = false;
    if (state.running) e.preventDefault();
  }
});

window.addEventListener('blur', () => {
  input.key = false;
  input.touch = false;
});

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let spray = false;
  let clearBtn = false;
  let menuBtn = false;
  for (const p of pads) {
    if (!p) continue;
    const b = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
    spray = spray || b(0) || b(5) || b(7);
    clearBtn = clearBtn || b(1);
    menuBtn = menuBtn || b(9);
  }
  input.pad = spray;
  if (clearBtn && !input.padPrev.clear && !state.paused) toggleClear();
  if (menuBtn && !input.padPrev.menu) togglePause();
  input.padPrev.clear = clearBtn;
  input.padPrev.menu = menuBtn;
}

// Tippen öffnet in der Brille das Menü; ohne Sensor dreht Ziehen den Blick.
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!orientation.hasSensor) {
    orientation.yaw += dx * 0.004;
    orientation.pitch = Math.max(-1.4, Math.min(1.4, orientation.pitch + dy * 0.004));
  }
});
canvas.addEventListener('pointerup', () => {
  if (drag && drag.moved < 10 && state.running && !state.paused && settings.viewMode !== 'hand') openPause();
  drag = null;
});
canvas.addEventListener('pointercancel', () => {
  drag = null;
});

const waterBtn = $('btn-water');
const waterOn = (e) => {
  input.touch = true;
  waterBtn.classList.add('on');
  if (e && waterBtn.setPointerCapture) waterBtn.setPointerCapture(e.pointerId);
  if (e) e.preventDefault();
};
const waterOff = () => {
  input.touch = false;
  waterBtn.classList.remove('on');
};
waterBtn.addEventListener('pointerdown', waterOn);
waterBtn.addEventListener('pointerup', waterOff);
waterBtn.addEventListener('pointercancel', waterOff);
waterBtn.addEventListener('lostpointercapture', waterOff);
waterBtn.addEventListener('contextmenu', (e) => e.preventDefault());

$('btn-start').addEventListener('click', startExercise);
$('btn-settings').addEventListener('click', () => openSettings('start'));
$('btn-settings-back').addEventListener('click', closeSettings);
$('btn-reset-settings').addEventListener('click', () => {
  Object.assign(settings, DEFAULTS);
  saveSettings(settings);
  buildSettings();
  buildPresets();
  buildViewModes();
  resize();
});
$('btn-clear').addEventListener('click', toggleClear);
$('btn-menu').addEventListener('click', openPause);
$('btn-resume').addEventListener('click', closePause);
$('btn-toggle-clear').addEventListener('click', toggleClear);
$('btn-pause-settings').addEventListener('click', () => openSettings('run'));
$('btn-end').addEventListener('click', endExercise);
$('btn-again').addEventListener('click', startExercise);
$('btn-home').addEventListener('click', () => {
  showScreen('start');
  runChecks();
});

window.addEventListener('resize', resize);
video.addEventListener('loadedmetadata', resize);
video.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) requestWakeLock();
  if (document.visibilityState === 'hidden' && state.running && !state.paused) openPause();
});

// ---------- Hauptschleife ----------

const camQ = new THREE.Quaternion();
const invQ = new THREE.Quaternion();
const camDir = new THREE.Vector3();
const tmp = new THREE.Vector3();

function updateDebug(now, eyeH, model, pitch) {
  if (!settings.debug) return null;
  if (now - state.debugAt > 250) {
    state.debugAt = now;
    const eyeSrc = settings.eyeMode === 'auto' ? (scenario.eyeEstimate != null ? 'geschätzt' : 'Startwert') : 'fest';
    state.debugLines = [
      `Bilder/s ${state.fps.toFixed(0)}   Erkennung ${tracker ? tracker.lastMs.toFixed(0) : '-'} ms`,
      `Marker im Bild ${tracker ? tracker.lastCount : 0}`,
      `Kamera ${model.vw}×${model.vh}   Sichtfeld ${settings.camFov}°`,
      `Lagesensor ${orientation.hasSensor ? 'ja' : 'nein (Blick per Ziehen)'}`,
      `Augenhöhe ${eyeH.toFixed(2)} m (${eyeSrc})`,
      `Blick ${Math.round(pitch / DEG)}°   Hitze ${Math.round(scenario.heat * 100)} %`,
    ];
  }
  return state.debugLines;
}

function updateRunUi(now) {
  const handMode = settings.viewMode === 'hand';
  $('run-ui').hidden = !(state.running && handMode && !state.paused);
  $('rotate-hint').hidden = !(state.running && !handMode && !state.paused && window.innerHeight > window.innerWidth);
  if (now - state.uiAt < 250) return;
  state.uiAt = now;
  $('run-time').textContent = fmtTime(scenario.time);
  const fires = [...scenario.fires.values()];
  const persons = [...scenario.persons.values()];
  let status = 'Marker suchen …';
  if (fires.length || persons.length) {
    const parts = [];
    if (fires.length) parts.push(`Feuer ${fires.filter((f) => f.out).length}/${fires.length} gelöscht`);
    if (persons.length) parts.push(`Personen ${persons.filter((p) => p.found).length}/${persons.length}`);
    status = parts.join(' · ');
  }
  $('run-status').textContent = state.clear ? 'Sicht frei' : status;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - state.lastFrame) / 1000));
  state.lastFrame = now;
  if (dt > 0) state.fps = state.fps ? state.fps * 0.95 + (1 / dt) * 0.05 : 1 / dt;
  state.clock += dt;
  if (!state.running || !renderer) return;

  pollGamepad();
  const model = cameraModel();
  orientation.at(now - settings.sensorDelay, camQ);
  renderer.setView(camQ, model.vfov, model.aspect);
  camDir.set(0, 0, -1).applyQuaternion(camQ);
  const pitch = Math.asin(Math.max(-1, Math.min(1, camDir.y)));

  if (!state.paused && tracker) {
    tracker.maxSize = DETECT_SIZE[settings.quality] || 960;
    tracker.tick({ q: camQ.clone() });
  }

  const active = !state.paused && !state.clear && !scenario.flashover;
  const spraying = active && (input.key || input.touch || input.pad);
  if (spraying && !state.wasSpraying) state.sprayStart = now;
  if (!spraying && state.wasSpraying) scenario.sprayReleased((now - state.sprayStart) / 1000);
  state.wasSpraying = spraying;
  state.sprayOpen += ((spraying ? 1 : 0) - state.sprayOpen) * Math.min(1, dt * (spraying ? 14 : 6));

  if (active) scenario.update(dt, { spraying, camDir, pitch, settings });

  if (state.flashoverAt) {
    const k = (now - state.flashoverAt) / 1000;
    state.flash = k < 0.35 ? k / 0.35 : Math.max(0.3, 1 - (k - 0.35) / 1.2);
    if (k > 3.5) {
      endExercise();
      return;
    }
  }
  if (!state.doneAnnounced && scenario.allDone) {
    state.doneAnnounced = true;
    toast(scenario.persons.size ? 'Alle Feuer gelöscht, alle Personen gefunden' : 'Alle entdeckten Feuer gelöscht', 'ok', 5);
    sound.beep([660, 880, 1100], 0.14, settings.sound);
  }

  const eyeH = settings.eyeMode === 'auto' && scenario.eyeEstimate != null ? scenario.eyeEstimate : settings.eyeHeight;
  renderer.sync({
    time: state.clock,
    scenario,
    settings,
    eyeH,
    clear: state.clear,
    spray: state.sprayOpen,
    flash: state.flash,
    hasVideo: video.readyState >= 2,
  });

  // Ton: lautestes Feuer bestimmt die Richtung.
  let fireLevel = 0;
  let loudest = 0;
  let pan = 0;
  invQ.copy(camQ).invert();
  for (const f of scenario.fires.values()) {
    if (f.out) continue;
    const d = f.pos.length();
    const lvl = f.intensity / (1 + 0.15 * d * d);
    fireLevel += lvl;
    if (lvl > loudest) {
      loudest = lvl;
      tmp.copy(f.pos).applyQuaternion(invQ);
      pan = Math.max(-1, Math.min(1, tmp.x / Math.max(tmp.length(), 1e-3)));
    }
  }
  const audible = settings.sound && !state.paused;
  sound.update(dt, {
    fire: state.clear ? 0 : Math.min(1, fireLevel * 1.5),
    pan,
    water: state.sprayOpen,
    heat: state.clear ? 0 : scenario.heat,
    enabled: audible,
  });

  state.toasts = state.toasts.filter((t) => t.until > now);
  const hudState = {
    grid: settings.grid,
    clear: state.clear,
    spraying,
    toasts: state.toasts.map((t) => ({ text: t.text, kind: t.kind })),
    headline: scenario.flashover ? 'DURCHZÜNDUNG – RÜCKZUG!' : null,
    debug: updateDebug(now, eyeH, model, pitch),
  };
  if (hud.draw(hudState)) renderer.hudChanged();
  updateRunUi(now);
  renderer.render();
}

// ---------- Start ----------

buildPresets();
buildViewModes();
buildSettings();
runChecks();
resize();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && window.isSecureContext && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Für automatische Tests und Fehlersuche.
window.__arTrainer = { state, scenario, settings, orientation, get tracker() { return tracker; } };
