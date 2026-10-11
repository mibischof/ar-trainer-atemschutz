import * as THREE from './vendor/three.module.min.js';

// Alles bleibt in Bildschirm-Farbwerten; keine Farbraum-Umrechnung.
THREE.ColorManagement.enabled = false;

const DEG = Math.PI / 180;
const MAX_FIRES = 4;
const MAX_PUFFS = 6;
const MAX_VISOR = 8;
// Rauch wird als Volumen in reduzierter Auflösung berechnet (smokeScale) und dann hochskaliert.
const QUALITY = {
  niedrig: { height: 480, smokeScale: 0.25, steps: 4 },
  mittel: { height: 720, smokeScale: 0.4, steps: 6 },
  hoch: { height: 1080, smokeScale: 0.5, steps: 8 },
};

// Weiches, periodisches 3D-Rauschen als Textur (Periode 1, zwei Oktaven).
// Eine Texturabfrage ist auf Handys viel billiger als Rauschen im Shader.
function makeNoiseTexture(size = 64) {
  const acc = new Float32Array(size ** 3);
  const smooth = (t) => t * t * (3 - 2 * t);
  for (const [cells, weight] of [
    [8, 0.68],
    [16, 0.32],
  ]) {
    const lat = new Float32Array(cells ** 3);
    for (let i = 0; i < lat.length; i++) lat[i] = Math.random();
    // Gitterzellen und Gewichte je Koordinate vorab berechnen (gilt für x, y und z gleich).
    const c0 = new Int32Array(size);
    const c1 = new Int32Array(size);
    const w = new Float32Array(size);
    for (let k = 0; k < size; k++) {
      const f = (k / size) * cells;
      c0[k] = Math.floor(f);
      c1[k] = (c0[k] + 1) % cells;
      w[k] = smooth(f - c0[k]);
    }
    const cc = cells * cells;
    let i = 0;
    for (let z = 0; z < size; z++) {
      const z0 = c0[z] * cc;
      const z1 = c1[z] * cc;
      const tz = w[z];
      for (let y = 0; y < size; y++) {
        const y0 = c0[y] * cells;
        const y1 = c1[y] * cells;
        const ty = w[y];
        for (let x = 0; x < size; x++) {
          const x0 = c0[x];
          const x1 = c1[x];
          const tx = w[x];
          const a = lat[z0 + y0 + x0] + (lat[z0 + y0 + x1] - lat[z0 + y0 + x0]) * tx;
          const b = lat[z0 + y1 + x0] + (lat[z0 + y1 + x1] - lat[z0 + y1 + x0]) * tx;
          const c = lat[z1 + y0 + x0] + (lat[z1 + y0 + x1] - lat[z1 + y0 + x0]) * tx;
          const d = lat[z1 + y1 + x0] + (lat[z1 + y1 + x1] - lat[z1 + y1 + x0]) * tx;
          const ab = a + (b - a) * ty;
          const cd = c + (d - c) * ty;
          acc[i++] += weight * (ab + (cd - ab) * tz);
        }
      }
    }
  }
  const data = new Uint8Array(size ** 3);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(acc[i] * 255);
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// Gemeinsames Rauchmodell: Rauchschicht ab uSmokeBase (m über Boden) bis zur Decke,
// dazu leichter Rauch im ganzen Raum. Kamera steht im Ursprung, Boden bei y = -uEyeH.
const COMMON_GLSL = /* glsl */ `
uniform float uTime;
uniform float uEyeH;
uniform float uSmokeBase;
uniform float uCeil;
uniform float uSigma;
uniform float uHaze;
uniform float uDark;
uniform float uRealDist;
uniform vec3 uSmokeCol;
uniform vec4 uFires[${MAX_FIRES}];
uniform sampler3D uNoise;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

// Rauschen aus der 3D-Textur; ein Kästchen entspricht 1/8 Einheit.
float n3(vec3 p) {
  return texture(uNoise, p).r;
}

float fbm3(vec3 p) {
  return n3(p) * 0.6 + n3(p * 2.03 + 0.37) * 0.28 + n3(p * 4.07 + 0.71) * 0.12;
}

// Länge des Strahlabschnitts [0, L], der in der Rauchschicht liegt.
float smokePath(vec3 dir, float L) {
  if (abs(dir.y) < 1e-4) return uEyeH > uSmokeBase ? L : 0.0;
  float tc = (uSmokeBase - uEyeH) / dir.y;
  if (dir.y > 0.0) return L - clamp(tc, 0.0, L);
  return clamp(tc, 0.0, L);
}

float transmittance(vec3 dir, float L) {
  return exp(-(uSigma * smokePath(dir, L) + uHaze * L));
}

float lightLevel() {
  return 1.0 - uDark * 0.92;
}

vec3 smokeColor(float lum) {
  return uSmokeCol * (0.2 + 0.8 * lum);
}

// Entfernung zur echten Umgebung (Boden, Decke oder angenommene Wand) und deren Normale.
float surfaceDist(vec3 dir, out vec3 n) {
  float L = uRealDist;
  n = -vec3(dir.x, 0.0, dir.z) / max(length(dir.xz), 1e-3);
  if (dir.y < -1e-3) {
    float tf = uEyeH / -dir.y;
    if (tf < L) { L = tf; n = vec3(0.0, 1.0, 0.0); }
  }
  if (dir.y > 1e-3) {
    float tc = max(uCeil - uEyeH, 0.05) / dir.y;
    if (tc < L) { L = tc; n = vec3(0.0, -1.0, 0.0); }
  }
  return L;
}

// Licht der Feuer auf eine Oberfläche bei pos mit Normale n.
vec3 fireLight(vec3 pos, vec3 n) {
  vec3 g = vec3(0.0);
  for (int i = 0; i < ${MAX_FIRES}; i++) {
    vec4 f = uFires[i];
    if (f.w <= 0.0) continue;
    vec3 l = f.xyz + vec3(0.0, 0.4 * f.w, 0.0) - pos;
    float d2 = dot(l, l);
    g += f.w * max(dot(n, l * inversesqrt(max(d2, 1e-4))), 0.0) / (1.0 + 0.6 * d2);
  }
  return g * vec3(1.0, 0.5, 0.18);
}

// Feuerschein im Rauch (ohne Richtung).
vec3 fireGlowAt(vec3 pos) {
  vec3 g = vec3(0.0);
  for (int i = 0; i < ${MAX_FIRES}; i++) {
    vec4 f = uFires[i];
    if (f.w <= 0.0) continue;
    vec3 l = f.xyz + vec3(0.0, 0.5 * f.w, 0.0) - pos;
    g += f.w / (1.0 + 0.9 * dot(l, l));
  }
  return g * vec3(1.0, 0.42, 0.12) * 0.7;
}
`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Rauchschicht als Volumen: Strahl wird in uSteps Schritten durch die Schicht verfolgt.
// Ausgabe: rgb = Licht aus dem Rauch, a = wie viel vom Hintergrund noch durchscheint.
const SMOKE_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform float uRoll;
uniform float uTongue;
uniform int uSteps;
uniform vec4 uPuffs[${MAX_PUFFS}];
varying vec2 vUv;

// Wogende Unterkante der Rauchschicht (Höhe über Boden) an der Stelle xz.
float smokeBaseAt(vec2 xz) {
  return uSmokeBase + (n3(vec3(xz * 0.04, uTime * 0.004)) - 0.5) * 0.45;
}

void main() {
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(mat3(uCamWorld) * normalize(v.xyz / v.w));
  vec3 nrm;
  float L = surfaceDist(dir, nrm);
  float lum = lightLevel();
  float hHi = uCeil;

  // Abschnitt des Strahls, der in der Rauchschicht liegt. Ein- und Austritt werden genau
  // berechnet (zwei Schritte wegen der wogenden Unterkante), damit keine Flecken entstehen.
  float t0 = L;
  float t1 = L;
  bool inside = uEyeH >= smokeBaseAt(vec2(0.0));
  if (inside) {
    t0 = 0.0;
    if (dir.y < -1e-4) {
      float te = (smokeBaseAt(vec2(0.0)) - uEyeH) / dir.y;
      te = (smokeBaseAt((dir * te).xz) - uEyeH) / dir.y;
      t1 = clamp(te, 0.0, L);
    }
  } else if (dir.y > 1e-4) {
    float te = (smokeBaseAt(vec2(0.0)) - uEyeH) / dir.y;
    te = (smokeBaseAt((dir * te).xz) - uEyeH) / dir.y;
    t0 = clamp(te, 0.0, L);
  }

  vec3 acc = vec3(0.0);
  vec3 glowAcc = vec3(0.0);
  float T = 1.0;
  if (t1 > t0 + 1e-3 && uSigma > 0.0) {
    float dt = (t1 - t0) / float(uSteps);
    // Weicher Versatz der Abtastpunkte gegen Streifen, ohne grobes Pixelmuster beim Hochskalieren
    float jit = clamp(0.5 + (n3(vec3(vUv * 2.0, uTime * 0.3)) - 0.5) * 1.6, 0.0, 1.0);
    vec3 flow = vec3(uTime * 0.012, uTime * -0.004, uTime * 0.007);
    for (int i = 0; i < 10; i++) {
      if (i >= uSteps) break;
      float t = t0 + (float(i) + jit) * dt;
      vec3 p = dir * t;
      float h = p.y + uEyeH;
      vec3 q = vec3(p.x, h, p.z);
      float base = smokeBaseAt(q.xz);
      // Weicher Übergang an der Unterkante (die ersten bzw. letzten 30 cm des Abschnitts)
      float layer = inside ? smoothstep(0.0, 0.3, t1 - t) + step(L - 1e-3, t1) : smoothstep(0.0, 0.3, t - t0);
      layer = min(layer, 1.0);
      float depth = clamp((h - base) / max(hHi - base, 0.3), 0.0, 1.0);
      // Rauchwalzen, die langsam unter der Decke ziehen; zur Decke hin dichter
      float b = fbm3(q * 0.06 + flow);
      float dens = uSigma * layer * (0.5 + 1.1 * b) * (0.75 + 0.7 * depth);

      // Wasserdampf aus der Rauchgaskühlung
      float steam = 0.0;
      for (int k = 0; k < ${MAX_PUFFS}; k++) {
        vec4 pf = uPuffs[k];
        if (pf.w <= 0.0) continue;
        float r = 0.35 + 1.4 * pf.w;
        vec3 d3 = p - pf.xyz;
        steam += (1.0 - pf.w) * (1.0 - pf.w) * exp(-dot(d3, d3) / (r * r));
      }
      steam = min(steam, 1.5);

      vec3 glow = fireGlowAt(p);
      vec3 soot = uSmokeCol * (0.18 + 0.82 * lum) * (0.8 + 0.4 * b) + glow * (0.5 + 0.5 * (1.0 - depth));
      vec3 vapour = vec3(0.86, 0.87, 0.88) * (0.55 + 0.45 * lum) + glow * 0.35;
      float sd = steam * 3.2;
      float ext = dens + sd;
      vec3 col = (soot * dens + vapour * sd) / max(ext, 1e-4);

      // Flammenzungen im oberen, heißen Teil der Schicht; Dampf löscht sie örtlich
      vec3 emit = vec3(0.0);
      if (uTongue > 0.001) {
        vec3 fq = q * vec3(0.09, 0.3, 0.09) + vec3(uTime * 0.09, uTime * -0.16, uTime * 0.05) + b * 0.35;
        float fl = fbm3(fq);
        float thr = mix(0.62, 0.52, uRoll);
        float flick = 0.55 + 0.9 * n3(vec3(q.xz * 0.06, uTime * 1.3));
        float detail = n3(q * vec3(0.3, 0.8, 0.3) + vec3(0.0, -uTime * 0.6, uTime * 0.2));
        float tg = smoothstep(thr, thr + 0.1, fl + (detail - 0.5) * 0.08) * smoothstep(0.0, 0.3, depth) * uTongue
                 * max(0.0, 1.0 - steam * 1.5) * min(1.0, uSigma * 0.8) * flick;
        float core = smoothstep(thr + 0.05, thr + 0.14, fl + (detail - 0.5) * 0.1);
        emit = tg * mix(vec3(0.95, 0.25, 0.03), vec3(1.0, 0.7, 0.3), core) * 6.0;
      }

      float a = 1.0 - exp(-ext * dt);
      acc += T * a * col;
      glowAcc += T * emit * dt;
      T *= 1.0 - a;
      if (T < 0.01) break;
    }
  }

  // Flammen sanft begrenzen, damit sie nicht zu einer gelben Fläche überstrahlen
  acc += glowAcc / (1.0 + 0.8 * glowAcc);

  // Leichter Rauch im ganzen Raum
  float hz = exp(-uHaze * L);
  acc += T * (1.0 - hz) * uSmokeCol * (0.25 + 0.75 * lum);
  T *= hz;
  gl_FragColor = vec4(acc, T);
}
`;

// Kamerabild mit Dunkelheit, Feuerschein auf Boden und Wänden, Hitzeflimmern; darüber der Rauch.
const BG_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform sampler2D uVideo;
uniform sampler2D uSmokeTex;
uniform float uHasVideo;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform float uClear;
varying vec2 vUv;

vec3 video(vec2 uv) {
  return uHasVideo > 0.5 ? texture2D(uVideo, uv).rgb : vec3(0.30, 0.31, 0.33) * (0.6 + 0.4 * uv.y);
}

void main() {
  if (uClear > 0.5) {
    gl_FragColor = vec4(video(vUv), 1.0);
    return;
  }
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(mat3(uCamWorld) * normalize(v.xyz / v.w));

  // Hitzeflimmern über den Flammen
  vec2 uv = vUv;
  float shimmer = 0.0;
  for (int i = 0; i < ${MAX_FIRES}; i++) {
    vec4 f = uFires[i];
    if (f.w <= 0.0) continue;
    vec3 fp = f.xyz + vec3(0.0, 0.3 + 1.1 * f.w, 0.0);
    float d = max(length(fp), 0.3);
    shimmer += f.w * (1.0 - smoothstep(0.0, 0.8 / d, length(dir - fp / d)));
  }
  if (shimmer > 0.001) {
    vec2 w = vec2(n3(vec3(vUv * 3.0, uTime * 0.7)), n3(vec3(vUv * 3.0 + 0.5, uTime * 0.7))) - 0.5;
    uv += w * 0.014 * min(shimmer, 1.0);
  }

  vec3 nrm;
  float L = surfaceDist(dir, nrm);
  vec3 sp = dir * L;
  float lum = lightLevel();
  float flicker = 0.82 + 0.18 * n3(vec3(uTime * 1.7, 0.3, 0.6));
  vec3 lit = video(uv) * (lum + fireLight(sp, nrm) * 1.5 * flicker);

  vec4 smoke = texture2D(uSmokeTex, vUv);
  vec3 col = lit * smoke.a + smoke.rgb;
  // Bildrauschen wie bei einer Kamera im Dunkeln.
  col += (hash13(vec3(gl_FragCoord.xy, uTime * 60.0)) - 0.5) * 0.06 * uDark;
  gl_FragColor = vec4(col, 1.0);
}
`;

const FLAME_VERT = /* glsl */ `
${COMMON_GLSL}
attribute vec4 aSeed;
uniform vec3 uBase;
uniform float uInt;
uniform float uPx;
varying float vLife;
varying float vT;
varying float vSeed;
void main() {
  float life = fract(uTime * (0.8 + aSeed.x * 0.7) + aSeed.y);
  float height = 0.25 + 1.0 * uInt;
  float ang = aSeed.z * 6.2831853;
  float rad = (0.05 + 0.3 * uInt) * sqrt(aSeed.w) * (1.0 - life * 0.8);
  vec3 p = uBase + vec3(cos(ang) * rad, life * height, sin(ang) * rad);
  p.x += sin(uTime * 6.0 + aSeed.y * 30.0) * 0.05 * life;
  p.z += cos(uTime * 5.0 + aSeed.x * 30.0) * 0.05 * life;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = (0.07 + 0.17 * uInt) * (1.0 - life * 0.5);
  gl_PointSize = clamp(size * uPx / max(-mv.z, 0.05), 1.0, 300.0);
  vLife = life;
  vSeed = aSeed.w;
  float L = max(length(p), 1e-3);
  vT = transmittance(p / L, L);
}
`;

// Flammen: länglich, ausgefranst und flackernd statt runder Kreise.
const FLAME_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform float uInt;
varying float vLife;
varying float vT;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  vec2 e = c * vec2(2.4, 1.7);
  float d = dot(e, e);
  if (d > 1.0 || uInt <= 0.001) discard;
  float n = n3(vec3(c * 0.6 + vSeed * 3.7, uTime * 0.35 + vSeed));
  float shape = (1.0 - d) * (0.35 + 1.3 * n);
  float a = smoothstep(0.2, 0.8, shape) * pow(1.0 - vLife, 1.2) * min(1.0, uInt * 1.5) * 0.55;
  vec3 col = mix(vec3(1.0, 0.86, 0.5), vec3(1.0, 0.45, 0.08), smoothstep(0.0, 0.35, vLife));
  col = mix(col, vec3(0.62, 0.1, 0.02), smoothstep(0.35, 1.0, vLife));
  gl_FragColor = vec4(col * (0.3 + 0.7 * vT), a);
}
`;

// Funkenflug über dem Feuer.
const EMBER_VERT = /* glsl */ `
${COMMON_GLSL}
attribute vec4 aSeed;
uniform vec3 uBase;
uniform float uInt;
uniform float uPx;
varying float vA;
void main() {
  float life = fract(uTime * (0.3 + aSeed.x * 0.3) + aSeed.y);
  float h = life * (0.8 + 1.6 * uInt) * (0.7 + aSeed.z * 0.6);
  vec3 p = uBase + vec3(sin(aSeed.w * 40.0 + uTime * 1.5 + life * 6.0) * 0.3 * life, h + 0.2,
                        cos(aSeed.z * 30.0 + uTime * 1.2 + life * 5.0) * 0.3 * life);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(0.014 * uPx / max(-mv.z, 0.05), 1.0, 24.0);
  float L = max(length(p), 1e-3);
  float on = step(aSeed.x, 0.25 + 0.75 * uInt);
  vA = on * uInt * (1.0 - life) * (0.6 + 0.4 * sin(uTime * 20.0 + aSeed.y * 50.0)) * transmittance(p / L, L);
}
`;

const EMBER_FRAG = /* glsl */ `
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0 || vA <= 0.001) discard;
  gl_FragColor = vec4(1.0, 0.62, 0.18, vA * (1.0 - d));
}
`;

// Rauchsäule über dem Feuer bzw. Wasserdampf beim Löschen.
const PUFF_VERT = /* glsl */ `
${COMMON_GLSL}
attribute vec4 aSeed;
uniform vec3 uBase;
uniform float uRise;
uniform float uSpread;
uniform float uSize;
uniform float uSpeed;
uniform float uPx;
varying float vLife;
varying float vT;
varying float vSeed;
void main() {
  float life = fract(uTime * uSpeed * (0.7 + aSeed.x * 0.6) + aSeed.y);
  float ang = aSeed.z * 6.2831853;
  float rad = uSpread * (0.15 + life) * sqrt(aSeed.w);
  vec3 p = uBase + vec3(cos(ang) * rad, life * uRise, sin(ang) * rad);
  p.x += sin(uTime * 0.7 + aSeed.y * 12.0) * 0.15 * life;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * (0.35 + life) * uPx / max(-mv.z, 0.05), 1.0, 300.0);
  vLife = life;
  vSeed = aSeed.w;
  float L = max(length(p), 1e-3);
  vT = transmittance(p / L, L);
}
`;

const PUFF_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform vec3 uColor;
uniform float uAmount;
varying float vLife;
varying float vT;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0 || uAmount <= 0.001) discard;
  float n = n3(vec3(c * 0.5 + vSeed * 5.1, uTime * 0.05 + vSeed));
  float a = (1.0 - d) * (0.4 + 1.2 * n) * (1.0 - vLife) * smoothstep(0.0, 0.15, vLife) * uAmount;
  gl_FragColor = vec4(uColor * (0.85 + 0.3 * n), clamp(a, 0.0, 1.0) * (0.4 + 0.6 * vT));
}
`;

const BODY_VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const BODY_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform vec3 uColor;
varying vec3 vW;
varying vec3 vN;
void main() {
  float L = max(length(vW), 1e-3);
  vec3 dir = vW / L;
  vec3 n = normalize(vN);
  float lum = lightLevel();
  float lamp = max(dot(n, -dir), 0.0) / (1.0 + 0.3 * L * L); // Helmlampe
  float amb = (0.2 + 0.8 * lum) * (0.55 + 0.45 * max(n.y, 0.0));
  vec3 c = uColor * (amb + lamp * 0.9) + uColor * fireLight(vW, n);
  gl_FragColor = vec4(mix(smokeColor(lum), c, transmittance(dir, L)), 1.0);
}
`;

// Tropfen, die nach erfolgreicher Rauchgaskühlung von der Decke fallen. Jeder Tropfen
// fällt in jedem Durchgang an einer neuen Stelle; uDrip bestimmt, wie viele fallen.
const DRIP_VERT = /* glsl */ `
${COMMON_GLSL}
attribute vec4 aSeed;
uniform float uDrip;
uniform float uPx;
varying float vA;
varying float vT;
void main() {
  float period = 1.6 + aSeed.x * 2.4;
  float cyc = uTime / period + aSeed.y;
  float k = floor(cyc);
  float tfall = fract(cyc) * period;
  float ang = hash13(vec3(aSeed.z * 91.0, k, 1.7)) * 6.2831853;
  float rad = 0.35 + 3.2 * sqrt(hash13(vec3(aSeed.w * 57.0, k, 4.1)));
  float ceilY = uCeil - uEyeH - 0.02;
  float y = ceilY - 4.905 * tfall * tfall;
  bool falling = hash13(vec3(aSeed.w * 13.0, aSeed.z * 7.0, 2.3)) < uDrip && y > -uEyeH;
  vec3 p = vec3(cos(ang) * rad, y, sin(ang) * rad);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = falling ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  // Länge der Spur wächst mit der Fallgeschwindigkeit
  gl_PointSize = clamp((0.02 + 9.81 * tfall * 0.012) * uPx / max(-mv.z, 0.05), 1.0, 120.0);
  vA = falling ? 0.85 : 0.0;
  float L = max(length(p), 1e-3);
  vT = transmittance(p / L, L);
}
`;

const DRIP_FRAG = /* glsl */ `
uniform float uLight;
varying float vA;
varying float vT;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = c.x * c.x * 196.0 + c.y * c.y * 4.0;
  if (d > 1.0 || vA <= 0.0) discard;
  gl_FragColor = vec4(vec3(0.82, 0.9, 0.97) * uLight, vA * (1.0 - d) * (0.35 + 0.65 * vT));
}
`;

// Wasserstrahl aus dem Strahlrohr; liegt im Kamera-Koordinatensystem.
// Die Form kommt aus SPRAY_SHAPES (Vollstrahl oder Sprühstrahl).
const SPRAY_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uOpen;
uniform float uPx;
uniform float uRate;
uniform float uSpread;
uniform float uReach;
uniform float uLift;
uniform float uDrop;
uniform float uSize0;
uniform float uSize1;
uniform float uAlpha;
uniform float uFade;
varying float vA;
void main() {
  float life = fract(uTime * uRate + aSeed.x);
  float a = aSeed.y * 6.2831853;
  float r = sqrt(aSeed.z) * uSpread;
  vec3 dir = normalize(vec3(cos(a) * r, sin(a) * r + uLift, -1.0));
  vec3 p = vec3(0.10, -0.22, -0.3) + dir * life * uReach + vec3(0.0, -uDrop * life * life, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp((uSize0 + uSize1 * life * life) * uPx / max(-mv.z, 0.05), 1.0, 200.0);
  vA = uOpen * pow(1.0 - life, uFade) * uAlpha;
}
`;

// Vollstrahl: dünn, weit, leichter Bogen. Sprühstrahl: breiter Nebelkegel, kurze Reichweite.
const SPRAY_SHAPES = {
  jet: { uRate: 1.1, uSpread: 0.025, uReach: 13, uLift: 0.07, uDrop: 1.1, uSize0: 0.018, uSize1: 0.07, uAlpha: 0.8, uFade: 0.8 },
  fog: { uRate: 1.4, uSpread: 0.3, uReach: 5, uLift: 0.04, uDrop: 0.4, uSize0: 0.015, uSize1: 0.2, uAlpha: 0.45, uFade: 2 },
};

const SPRAY_FRAG = /* glsl */ `
uniform float uLight;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0 || vA <= 0.001) discard;
  gl_FragColor = vec4(vec3(0.82, 0.9, 0.97) * uLight, vA * (1.0 - d) * (1.0 - d));
}
`;

// Endbild: Hand (bildschirmfüllend), 1 Linse oder 2 Linsen mit Vorverzerrung.
// Wassertropfen auf dem Maskenvisier verzerren das Bild dahinter.
const FINAL_FRAG = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uHud;
uniform vec2 uScreen;
uniform float uAspect;
uniform int uMode;
uniform float uZoom;
uniform float uK1;
uniform float uK2;
uniform float uSep;
uniform float uOffY;
uniform float uFlash;
uniform vec4 uVisor[${MAX_VISOR}];
varying vec2 vUv;

vec3 sceneAt(vec2 s) {
  vec2 uv = vec2(0.5 + s.x / (2.0 * uAspect), 0.5 + s.y * 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  vec2 look = uv;
  float rim = 0.0;
  for (int i = 0; i < ${MAX_VISOR}; i++) {
    vec4 d = uVisor[i];
    if (d.w <= 0.0) continue;
    vec2 o = (uv - d.xy) * vec2(uAspect, 1.0);
    float r = length(o) / d.z;
    if (r < 1.0) {
      look -= (uv - d.xy) * 0.7 * (1.0 - r * r) * d.w;
      rim += smoothstep(0.7, 1.0, r) * (1.0 - smoothstep(0.98, 1.0, r)) * d.w;
    }
  }
  vec3 c = texture2D(uScene, look).rgb + rim * 0.12;
  vec4 h = texture2D(uHud, uv);
  c = mix(c, h.rgb, h.a);
  return mix(c, vec3(1.0, 0.62, 0.25), uFlash);
}

vec2 distort(vec2 q) {
  float r2 = dot(q, q);
  return q * (1.0 + uK1 * r2 + uK2 * r2 * r2);
}

void main() {
  vec2 p = vUv * uScreen;
  float W = uScreen.x;
  float H = uScreen.y;
  vec3 col;
  if (uMode == 0) {
    vec2 s = (p - 0.5 * uScreen) / (0.5 * H);
    float sa = W / H;
    if (sa > uAspect) s *= uAspect / sa;
    col = sceneAt(s);
  } else if (uMode == 1) {
    vec2 c = vec2(0.5 * W, H * (0.5 + uOffY));
    vec2 q = (p - c) / (0.5 * H);
    col = sceneAt(distort(q) / uZoom);
  } else {
    bool left = p.x < 0.5 * W;
    vec2 c = vec2(0.5 * W + (left ? -0.5 : 0.5) * uSep * W, H * (0.5 + uOffY));
    float R = min(0.25 * W, 0.5 * H);
    vec2 q = (p - c) / R;
    float edge = 1.0 - smoothstep(0.96, 1.04, length(q));
    col = sceneAt(distort(q) / uZoom) * edge;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

function seedGeometry(count) {
  const g = new THREE.BufferGeometry();
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  return g;
}

function points(geometry, material) {
  const p = new THREE.Points(geometry, material);
  p.frustumCulled = false;
  return p;
}

function fullscreenQuad(material) {
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  return quad;
}

export class Renderer {
  constructor(canvas, video) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.video = video;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 60);
    this.scene.add(this.camera);

    this.common = {
      uTime: { value: 0 },
      uEyeH: { value: 1.6 },
      uSmokeBase: { value: 1.2 },
      uCeil: { value: 2.6 },
      uSigma: { value: 1.5 },
      uHaze: { value: 0.1 },
      uDark: { value: 0.5 },
      uRealDist: { value: 4 },
      uSmokeCol: { value: new THREE.Vector3(0.17, 0.16, 0.15) },
      uFires: { value: Array.from({ length: MAX_FIRES }, () => new THREE.Vector4()) },
      uNoise: { value: makeNoiseTexture() },
    };
    this.uPx = { value: 800 };
    this.invProj = { value: new THREE.Matrix4() };
    this.camWorld = { value: new THREE.Matrix4() };

    this.videoTex = new THREE.VideoTexture(video);
    this.videoTex.minFilter = THREE.LinearFilter;
    this.videoTex.magFilter = THREE.LinearFilter;
    this.videoTex.generateMipmaps = false;

    this.rt = new THREE.WebGLRenderTarget(16, 9, { depthBuffer: true });
    this.smokeRT = new THREE.WebGLRenderTarget(8, 8, { depthBuffer: false });
    this.hudCanvas = document.createElement('canvas');
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.minFilter = THREE.LinearFilter;
    this.hudTex.generateMipmaps = false;

    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._buildSmoke();
    this._buildBackground();
    this._buildSpray();
    this._buildDrips();
    this._buildFinal();

    this.fireViews = new Map();
    this.personViews = new Map();
    this.sceneAspect = 16 / 9;
  }

  _buildSmoke() {
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.common,
        uInvProj: this.invProj,
        uCamWorld: this.camWorld,
        uRoll: { value: 0 },
        uTongue: { value: 0 },
        uSteps: { value: 6 },
        uPuffs: { value: Array.from({ length: MAX_PUFFS }, () => new THREE.Vector4()) },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: SMOKE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.smokeScene = new THREE.Scene();
    this.smokeScene.add(fullscreenQuad(this.smokeMat));
  }

  _buildBackground() {
    this.bgMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.common,
        uVideo: { value: this.videoTex },
        uSmokeTex: { value: this.smokeRT.texture },
        uHasVideo: { value: 0 },
        uInvProj: this.invProj,
        uCamWorld: this.camWorld,
        uClear: { value: 0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: BG_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const bg = fullscreenQuad(this.bgMat);
    bg.renderOrder = -1000;
    this.scene.add(bg);
  }

  _buildSpray() {
    this.sprayMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.common.uTime,
        uOpen: { value: 0 },
        uPx: this.uPx,
        uLight: { value: 1 },
        ...Object.fromEntries(Object.entries(SPRAY_SHAPES.fog).map(([k, v]) => [k, { value: v }])),
      },
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.spray = points(seedGeometry(500), this.sprayMat);
    this.spray.renderOrder = 10;
    this.camera.add(this.spray);
  }

  _buildDrips() {
    this.dripMat = new THREE.ShaderMaterial({
      uniforms: { ...this.common, uDrip: { value: 0 }, uPx: this.uPx, uLight: { value: 1 } },
      vertexShader: DRIP_VERT,
      fragmentShader: DRIP_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.drips = points(seedGeometry(260), this.dripMat);
    this.drips.renderOrder = 5;
    this.scene.add(this.drips);
  }

  _buildFinal() {
    this.finalMat = new THREE.ShaderMaterial({
      uniforms: {
        uScene: { value: this.rt.texture },
        uHud: { value: this.hudTex },
        uScreen: { value: new THREE.Vector2(1, 1) },
        uAspect: { value: 16 / 9 },
        uMode: { value: 0 },
        uZoom: { value: 1 },
        uK1: { value: 0 },
        uK2: { value: 0 },
        uSep: { value: 0.5 },
        uOffY: { value: 0 },
        uFlash: { value: 0 },
        uVisor: { value: Array.from({ length: MAX_VISOR }, () => new THREE.Vector4()) },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: FINAL_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.finalScene = new THREE.Scene();
    this.finalScene.add(fullscreenQuad(this.finalMat));
  }

  _addFire(fire) {
    const own = (extra) => ({ ...this.common, uPx: this.uPx, uBase: { value: new THREE.Vector3() }, ...extra });
    const additive = (vertexShader, fragmentShader) =>
      new THREE.ShaderMaterial({
        uniforms: own({ uInt: { value: 0 } }),
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    const flameMat = additive(FLAME_VERT, FLAME_FRAG);
    const emberMat = additive(EMBER_VERT, EMBER_FRAG);
    const puff = (color, extra) =>
      new THREE.ShaderMaterial({
        uniforms: own({
          uColor: { value: color },
          uAmount: { value: 0 },
          uRise: { value: 1.5 },
          uSpread: { value: 0.4 },
          uSize: { value: 0.5 },
          uSpeed: { value: 0.25 },
          ...extra,
        }),
        vertexShader: PUFF_VERT,
        fragmentShader: PUFF_FRAG,
        transparent: true,
        depthWrite: false,
      });
    const plumeMat = puff(new THREE.Vector3(0.1, 0.1, 0.1), { uSpread: { value: 0.7 }, uSize: { value: 0.9 }, uSpeed: { value: 0.16 } });
    const steamMat = puff(new THREE.Vector3(0.8, 0.8, 0.8), { uRise: { value: 1.6 }, uSpread: { value: 0.35 }, uSize: { value: 0.45 }, uSpeed: { value: 0.45 } });

    const group = new THREE.Group();
    const plume = points(seedGeometry(180), plumeMat);
    const steam = points(seedGeometry(110), steamMat);
    const flames = points(seedGeometry(340), flameMat);
    const embers = points(seedGeometry(60), emberMat);
    plume.renderOrder = 1;
    steam.renderOrder = 2;
    flames.renderOrder = 3;
    embers.renderOrder = 4;
    group.add(plume, steam, flames, embers);
    this.scene.add(group);
    const view = { group, flameMat, emberMat, plumeMat, steamMat };
    this.fireViews.set(fire.id, view);
    return view;
  }

  _addPerson(person) {
    const mat = (r, g, b) =>
      new THREE.ShaderMaterial({
        uniforms: { ...this.common, uColor: { value: new THREE.Vector3(r, g, b) } },
        vertexShader: BODY_VERT,
        fragmentShader: BODY_FRAG,
      });
    const jacket = mat(0.62, 0.16, 0.12);
    const jeans = mat(0.16, 0.22, 0.38);
    const skin = mat(0.78, 0.6, 0.48);
    const group = new THREE.Group();
    const part = (geo, m, x, y, z, rotZ = Math.PI / 2) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.rotation.z = rotZ;
      group.add(mesh);
    };
    // Liegt am Boden, Körperachse entlang x.
    part(new THREE.CapsuleGeometry(0.16, 0.5, 4, 10), jacket, 0.2, 0.16, 0);
    part(new THREE.SphereGeometry(0.11, 14, 10), skin, 0.68, 0.13, 0, 0);
    part(new THREE.CapsuleGeometry(0.075, 0.72, 4, 8), jeans, -0.45, 0.08, 0.1);
    part(new THREE.CapsuleGeometry(0.075, 0.72, 4, 8), jeans, -0.45, 0.08, -0.1);
    part(new THREE.CapsuleGeometry(0.055, 0.5, 4, 8), jacket, 0.22, 0.07, 0.25);
    part(new THREE.CapsuleGeometry(0.055, 0.5, 4, 8), jacket, 0.22, 0.07, -0.25);
    this.scene.add(group);
    const view = { group };
    this.personViews.set(person.id, view);
    return view;
  }

  resize(cssW, cssH, sceneAspect, quality) {
    const q = QUALITY[quality] || QUALITY.mittel;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.finalMat.uniforms.uScreen.value.copy(buf);
    const h = Math.round(Math.min(q.height, Math.max(buf.y, buf.x / sceneAspect, 360)));
    const w = Math.round(h * sceneAspect);
    if (this.rt.width !== w || this.rt.height !== h) {
      this.rt.setSize(w, h);
      this.hudCanvas.width = w;
      this.hudCanvas.height = h;
      this.hudTex.dispose();
    }
    const sw = Math.max(16, Math.round(w * q.smokeScale));
    const sh = Math.max(16, Math.round(h * q.smokeScale));
    if (this.smokeRT.width !== sw || this.smokeRT.height !== sh) this.smokeRT.setSize(sw, sh);
    this.smokeMat.uniforms.uSteps.value = q.steps;
    this.sceneAspect = sceneAspect;
    this.finalMat.uniforms.uAspect.value = sceneAspect;
  }

  get sceneSize() {
    return { w: this.rt.width, h: this.rt.height };
  }

  setView(quaternion, vfovDeg, aspect) {
    const cam = this.camera;
    cam.quaternion.copy(quaternion);
    cam.fov = vfovDeg;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    this.invProj.value.copy(cam.projectionMatrixInverse);
    this.camWorld.value.copy(cam.matrixWorld);
    this.uPx.value = this.rt.height / (2 * Math.tan((vfovDeg * DEG) / 2));
  }

  // Überträgt den Übungszustand in die Grafik.
  // puffs: [{ pos: Vector3, age: 0..1 }], visor: [{ x, y, r, a }] in Bildkoordinaten 0..1.
  sync({ time, scenario, settings, eyeH, smokeBase, clear, spray, nozzle, flash, hasVideo, puffs = [], visor = [] }) {
    const u = this.common;
    const lum = 1 - settings.darkness * 0.92;
    u.uTime.value = time;
    u.uEyeH.value = eyeH;
    u.uSmokeBase.value = smokeBase;
    u.uCeil.value = Math.max(settings.ceiling, eyeH + 0.1);
    u.uSigma.value = settings.smokeDensity * 2.5;
    u.uHaze.value = settings.haze * 0.6;
    u.uDark.value = settings.darkness;
    u.uRealDist.value = settings.roomDepth;
    this.smokeMat.uniforms.uRoll.value = scenario.rollover;
    this.smokeMat.uniforms.uTongue.value = scenario.tongues;
    this.smokeMat.uniforms.uPuffs.value.forEach((v, i) => {
      const p = puffs[i];
      if (p && !clear) v.set(p.pos.x, p.pos.y, p.pos.z, Math.min(Math.max(p.age, 0.001), 0.999));
      else v.set(0, 0, 0, 0);
    });
    this.bgMat.uniforms.uClear.value = clear ? 1 : 0;
    this.bgMat.uniforms.uHasVideo.value = hasVideo ? 1 : 0;
    this.sprayMat.uniforms.uOpen.value = clear ? 0 : spray;
    this.sprayMat.uniforms.uLight.value = 0.35 + 0.65 * lum;
    for (const [k, v] of Object.entries(SPRAY_SHAPES[nozzle] || SPRAY_SHAPES.fog)) this.sprayMat.uniforms[k].value = v;
    this.dripMat.uniforms.uDrip.value = clear ? 0 : scenario.drip;
    this.dripMat.uniforms.uLight.value = 0.4 + 0.6 * lum;
    this.finalMat.uniforms.uFlash.value = flash;
    this.finalMat.uniforms.uVisor.value.forEach((v, i) => {
      const d = visor[i];
      if (d && !clear) v.set(d.x, d.y, d.r, d.a);
      else v.set(0, 0, 0, 0);
    });

    // Hellste Feuer für Feuerschein und Beleuchtung.
    const lit = [...scenario.fires.values()]
      .filter((f) => !f.out && !clear)
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, MAX_FIRES);
    u.uFires.value.forEach((v, i) => {
      const f = lit[i];
      if (f) v.set(f.pos.x, f.pos.y, f.pos.z, f.intensity);
      else v.set(0, 0, 0, 0);
    });

    for (const f of scenario.fires.values()) {
      const view = this.fireViews.get(f.id) || this._addFire(f);
      view.group.visible = !clear;
      const ceilingY = u.uCeil.value - eyeH;
      for (const m of [view.flameMat, view.emberMat, view.plumeMat, view.steamMat]) m.uniforms.uBase.value.copy(f.pos);
      view.flameMat.uniforms.uInt.value = f.out ? 0 : f.intensity;
      view.emberMat.uniforms.uInt.value = f.out ? 0 : f.intensity;
      view.plumeMat.uniforms.uBase.value.y += 0.3 + 0.6 * f.intensity;
      view.plumeMat.uniforms.uRise.value = Math.max(0.3, ceilingY - view.plumeMat.uniforms.uBase.value.y);
      view.plumeMat.uniforms.uAmount.value = f.out ? f.steam * 0.3 : 0.5 * f.intensity;
      view.plumeMat.uniforms.uColor.value.set(0.11, 0.105, 0.1).multiplyScalar(0.4 + 0.6 * lum);
      view.steamMat.uniforms.uBase.value.y += 0.15;
      view.steamMat.uniforms.uAmount.value = f.steam * 0.6;
      view.steamMat.uniforms.uColor.value.set(0.85, 0.86, 0.88).multiplyScalar(0.35 + 0.65 * lum);
    }

    for (const p of scenario.persons.values()) {
      const view = this.personViews.get(p.id) || this._addPerson(p);
      view.group.visible = !clear;
      view.group.position.copy(p.pos);
      view.group.rotation.y = p.yaw;
    }

    const fu = this.finalMat.uniforms;
    fu.uMode.value = settings.viewMode === 'stereo' ? 2 : settings.viewMode === 'mono' ? 1 : 0;
    fu.uZoom.value = settings.lensZoom;
    fu.uK1.value = settings.lensK1;
    fu.uK2.value = settings.lensK2;
    fu.uSep.value = settings.lensSep;
    fu.uOffY.value = settings.lensOffsetY;
  }

  // Entfernt alle Feuer und Personen (neue Übung).
  clearObjects() {
    for (const v of [...this.fireViews.values(), ...this.personViews.values()]) {
      this.scene.remove(v.group);
      v.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    this.fireViews.clear();
    this.personViews.clear();
  }

  hudChanged() {
    this.hudTex.needsUpdate = true;
  }

  render() {
    const r = this.renderer;
    if (!this.bgMat.uniforms.uClear.value) {
      r.setRenderTarget(this.smokeRT);
      r.render(this.smokeScene, this.quadCam);
    }
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    r.render(this.finalScene, this.quadCam);
  }
}
