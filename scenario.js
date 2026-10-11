import * as THREE from './vendor/three.module.min.js';
import { markerById } from './markers.js';

const GROWTH = { langsam: 0.6, mittel: 1, schnell: 1.8 };
const DEG = Math.PI / 180;

// Strahlarten wie am Hohlstrahlrohr. cone: halber Öffnungswinkel, reach in m,
// rate: Löschwirkung, falloff: Abnahme mit der Entfernung, cooling: Wirkung beim Kühlen der Rauchgase.
export const NOZZLES = {
  jet: { label: 'Vollstrahl', cone: 2 * DEG, reach: 16, rate: 0.32, falloff: 0.004, cooling: 0.25 },
  fog: { label: 'Sprühstrahl', cone: 12 * DEG, reach: 6, rate: 0.3, falloff: 0.05, cooling: 1 },
};

const UP = new THREE.Vector3(0, 1, 0);
const HEAT_WARNING = 0.6;

// Zustand einer Übung: Feuer, Personen, Rauchgas-Hitze, Wasserverbrauch, Protokoll.
// Die Kamera steht immer im Ursprung; Positionen sind relativ zum Kopf.
export class Scenario {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.reset();
  }

  reset() {
    this.fires = new Map();
    this.persons = new Map();
    this.time = 0;
    this.heat = 0;
    this.maxHeat = 0;
    this.heatWarned = false;
    this.water = 0;
    this.sprayTime = 0;
    this.sprayTimeJet = 0;
    this.sprayTimeFog = 0;
    this.jetCooling = 0;
    this.jetHintShown = false;
    // Rauchgaskühlung: Zeitpunkte der Kühlstöße, Anhebung der Rauchschicht (m), Tropfen von der Decke (0..1)
    this.coolPulses = [];
    this.coolPulseCount = 0;
    this.pressCooled = false;
    this.coolLift = 0;
    this.drip = 0;
    this.dripAt = null;
    this.pulses = 0;
    this.longSprays = 0;
    this.clearCount = 0;
    this.log = [];
    this.flashover = false;
    this.eyeEstimate = null;
  }

  note(text) {
    this.log.push({ t: this.time, text });
  }

  // Ein Marker wurde gesehen. center: Markermitte relativ zum Kopf (Welt, m).
  // mount: 'floor', 'wall' oder null (unklar), weight: wie verlässlich diese Einschätzung ist.
  // place.wallHeight: Höhe der Mitte senkrechter Marker über dem Boden (m), wenn Feuer am Boden
  // vor der Wand erscheinen sollen; sonst null (Feuer direkt am Marker).
  // place.eyeH: aktuelle Augenhöhe (m), für Personen an senkrechten Markern.
  observe(id, center, mount, weight, { wallHeight = null, eyeH = 1.6 } = {}) {
    const info = markerById.get(id);
    const dist = center.length();
    if (!info || !(dist > 0.2 && dist < 25)) return;

    const list = info.kind === 'fire' ? this.fires : this.persons;
    let o = list.get(id);
    // Boden oder Wand wird über mehrere Beobachtungen entschieden, damit nichts hin und her springt.
    const vote = mount === 'wall' ? weight : mount === 'floor' ? -weight : 0;
    const wallVotes = Math.max(-6, Math.min(6, (o ? o.wallVotes : 0) + vote));
    const onWall = wallVotes > 0;

    const toward = new THREE.Vector3(-center.x, 0, -center.z).normalize();
    let pos;
    let eye = null;
    if (!onWall) {
      // Marker liegt flach (Boden, Tisch): Objekt sitzt direkt darauf.
      pos = center.clone();
      eye = -center.y;
    } else if (wallHeight != null) {
      // Senkrechter Marker in bekannter Höhe: Objekt 40 cm vor der Wand am Boden.
      pos = new THREE.Vector3(center.x, center.y - wallHeight, center.z).addScaledVector(toward, 0.4);
      eye = wallHeight - center.y;
    } else if (info.kind === 'fire') {
      // Senkrechter Marker (Wand, Bildschirm): Feuer direkt am Marker, knapp davor.
      pos = center.clone().addScaledVector(toward, 0.05);
    } else {
      // Person an senkrechtem Marker: liegt am Boden davor, sonst würde sie schweben.
      pos = new THREE.Vector3(center.x, -eyeH, center.z).addScaledVector(toward, 0.4);
    }

    // Augenhöhe schätzen (stehen, knien, kriechen).
    if (eye != null && mount != null && dist < 8 && eye > 0.15 && eye < 2.4) {
      this.eyeEstimate = this.eyeEstimate == null ? eye : this.eyeEstimate + (eye - this.eyeEstimate) * 0.25;
    }

    if (!o) {
      o = { id, info, pos, lastSeen: this.time, dist, wallVotes };
      if (info.kind === 'fire') {
        Object.assign(o, { intensity: 0.45, out: false, cooldown: 0, steam: 0, hit: false });
        this.note(`${info.label} entdeckt`);
      } else {
        // Person liegt quer zur Blickrichtung bzw. parallel zur Wand.
        const yaw = onWall ? Math.atan2(toward.x, toward.z) : Math.atan2(center.x, center.z);
        Object.assign(o, { yaw, found: false });
      }
      list.set(id, o);
      this.hooks.onNew?.(o);
    } else {
      // Nach dem Gehen ohne Marker im Bild liegt die alte Position weit daneben: schnell nachziehen.
      o.pos.lerp(pos, o.pos.distanceTo(pos) > 0.6 ? 0.75 : 0.4);
      o.wallVotes = wallVotes;
    }
    o.lastSeen = this.time;
    o.dist = dist;

    if (info.kind === 'person' && !o.found && o.pos.length() < 1.6) {
      o.found = true;
      o.foundAt = this.time;
      this.note(`${info.label} gefunden`);
      this.hooks.onFound?.(o);
    }
  }

  // camDir: Blickrichtung (Welt), pitch: Blickneigung in rad (positiv = nach oben),
  // nozzle: 'jet' (Vollstrahl) oder 'fog' (Sprühstrahl).
  update(dt, { spraying, nozzle, camDir, pitch, settings }) {
    if (this.flashover) return;
    this.time += dt;
    const g = GROWTH[settings.growth] ?? 1;
    const n = NOZZLES[nozzle] || NOZZLES.fog;
    let total = 0;

    for (const f of this.fires.values()) {
      if (f.out) {
        f.steam = Math.max(0, f.steam - dt * 0.3);
        continue;
      }
      f.hit = false;
      if (spraying) {
        const center = f.pos.clone().addScaledVector(UP, 0.35 * f.intensity);
        const d = center.length();
        const radius = Math.atan2(0.25 + 0.45 * f.intensity, d) + n.cone;
        if (d < n.reach && camDir.angleTo(center) < radius) {
          f.hit = true;
          f.intensity -= (dt * n.rate) / (1 + n.falloff * d * d);
          f.cooldown = 2.5;
          f.steam = Math.min(1, f.steam + dt * 2);
        }
      }
      if (!f.hit) {
        f.cooldown -= dt;
        if (f.cooldown <= 0) f.intensity = Math.min(1, f.intensity + dt * 0.02 * g);
        f.steam = Math.max(0, f.steam - dt * 0.5);
      }
      if (f.intensity <= 0) {
        f.intensity = 0;
        f.out = true;
        f.steam = 1;
        f.outAt = this.time;
        this.note(`${f.info.label} gelöscht`);
        this.hooks.onOut?.(f);
      }
      total += f.intensity;
    }

    // Rauchgase heizen sich auf; Wasser nach oben in die Rauchschicht kühlt sie.
    this.heat += dt * 0.0022 * g * total;
    const coolingUp = spraying && pitch > 0.26;
    if (coolingUp) this.heat -= dt * 0.15 * n.cooling;
    // Gekühlte Rauchgase ziehen sich zusammen, die Schicht hebt sich. Vollstrahl in heiße Gase
    // stört die Schichtung und drückt den Rauch nach unten.
    if (coolingUp && nozzle !== 'jet') {
      this.pressCooled = true;
      this.coolLift = Math.min(0.45, this.coolLift + dt * 0.12);
    }
    if (coolingUp && nozzle === 'jet' && this.heat > 0.3) this.coolLift = Math.max(-0.45, this.coolLift - dt * 0.15);
    this.coolLift *= Math.exp(-dt / 25);
    // Hinweis, wenn mit Vollstrahl in heiße Rauchgase gespritzt wird.
    if (coolingUp && nozzle === 'jet' && this.heat > 0.45) this.jetCooling += dt;
    if (this.jetCooling > 1 && !this.jetHintShown) {
      this.jetHintShown = true;
      this.note('Rauchgaskühlung mit Vollstrahl versucht');
      this.hooks.onJetCoolingHint?.();
    }
    if (total === 0) this.heat -= dt * 0.01;
    this.heat = Math.min(1, Math.max(0, this.heat));
    this.maxHeat = Math.max(this.maxHeat, this.heat);

    if (this.heat > HEAT_WARNING && !this.heatWarned) {
      this.heatWarned = true;
      this.note('Rauchgase sehr heiß');
      this.hooks.onHeatWarning?.();
    }
    if (this.heat < HEAT_WARNING - 0.15) this.heatWarned = false;

    if (settings.flashover && this.heat >= 1) {
      this.flashover = true;
      this.note('Durchzündung');
      this.hooks.onFlashover?.();
    }

    // Wasser tropft von der Decke, wenn nach mehreren Kühlstößen die Rauchgase kühl genug sind
    // (das Wasser verdampft dann nicht mehr vollständig).
    this.coolPulses = this.coolPulses.filter((t) => this.time - t < 40);
    const last = this.coolPulses.length ? this.time - this.coolPulses[this.coolPulses.length - 1] : Infinity;
    const dripTarget = this.coolPulses.length >= 3 && this.heat < 0.4 && last < 20 ? 1 : 0;
    this.drip += (dripTarget - this.drip) * Math.min(1, dt * (dripTarget ? 0.6 : 0.12));
    if (this.drip > 0.5 && this.dripAt == null) {
      this.dripAt = this.time;
      this.note('Wasser tropft von der Decke – Rauchgase gekühlt');
      this.hooks.onDrip?.();
    }

    if (spraying) {
      this.water += (dt * settings.flow) / 60;
      this.sprayTime += dt;
      if (nozzle === 'jet') this.sprayTimeJet += dt;
      else this.sprayTimeFog += dt;
    }
  }

  // Wird beim Loslassen der Wasser-Taste aufgerufen.
  sprayReleased(duration) {
    if (duration < 1.2) this.pulses++;
    else this.longSprays++;
    if (this.pressCooled) {
      this.coolPulses.push(this.time);
      this.coolPulseCount++;
    }
    this.pressCooled = false;
  }

  // Einzelne Flammenzungen in der Rauchschicht ab mittlerer Hitze.
  get tongues() {
    const t = Math.min(1, Math.max(0, (this.heat - 0.3) / 0.25));
    return t * t * (3 - 2 * t);
  }

  get rollover() {
    return Math.min(1, Math.max(0, (this.heat - 0.55) / 0.4));
  }

  get allDone() {
    if (this.fires.size === 0) return false;
    for (const f of this.fires.values()) if (!f.out) return false;
    for (const p of this.persons.values()) if (!p.found) return false;
    return true;
  }
}
