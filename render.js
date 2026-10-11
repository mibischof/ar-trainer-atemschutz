import * as THREE from './vendor/three.module.min.js';

// Alles bleibt in Bildschirm-Farbwerten; keine Farbraum-Umrechnung.
THREE.ColorManagement.enabled = false;

const DEG = Math.PI / 180;
const MAX_FIRES = 4;
const QUALITY_HEIGHT = { niedrig: 480, mittel: 720, hoch: 1080 };

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
uniform vec3 uSmokeCol;
uniform vec4 uFires[${MAX_FIRES}];

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
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

// Feuerschein, gesehen in Blickrichtung dir.
vec3 fireGlow(vec3 dir) {
  vec3 g = vec3(0.0);
  for (int i = 0; i < ${MAX_FIRES}; i++) {
    vec4 f = uFires[i];
    if (f.w <= 0.0) continue;
    vec3 fp = f.xyz + vec3(0.0, 0.4 * f.w, 0.0);
    float d = max(length(fp), 0.3);
    float c = max(dot(dir, fp / d), 0.0);
    g += f.w * (pow(c, 60.0) * 1.4 + pow(c, 8.0) * 0.45) / (1.0 + 0.08 * d * d);
  }
  return g * vec3(1.0, 0.45, 0.12);
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
`;

const BG_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BG_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform sampler2D uVideo;
uniform float uHasVideo;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform float uRealDist;
uniform float uRoll;
uniform float uClear;
varying vec2 vUv;

void main() {
  vec3 cam = uHasVideo > 0.5 ? texture2D(uVideo, vUv).rgb : vec3(0.30, 0.31, 0.33) * (0.6 + 0.4 * vUv.y);
  if (uClear > 0.5) {
    gl_FragColor = vec4(cam, 1.0);
    return;
  }
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(mat3(uCamWorld) * normalize(v.xyz / v.w));

  // Entfernung zur echten Umgebung: Boden, Decke oder angenommene Wand.
  float L = uRealDist;
  if (dir.y < -1e-3) L = min(L, uEyeH / -dir.y);
  if (dir.y > 1e-3) L = min(L, max(uCeil - uEyeH, 0.05) / dir.y);

  float n = vnoise(dir * 2.5 + vec3(0.0, -uTime * 0.06, uTime * 0.03)) * 0.6
          + vnoise(dir * 7.0 + vec3(uTime * 0.09)) * 0.4;
  float tau = uSigma * smokePath(dir, L) * (0.6 + 0.8 * n) + uHaze * L * (0.8 + 0.4 * n);
  float T = exp(-tau);

  float lum = lightLevel();
  vec3 glow = fireGlow(dir) * (0.85 + 0.15 * vnoise(vec3(uTime * 7.0, 1.0, 2.0)));
  vec3 lit = cam * lum + cam * glow * 0.35;
  vec3 smoke = smokeColor(lum) * (0.7 + 0.6 * n) + glow * 0.9;
  vec3 col = mix(smoke, lit, T);

  // Rollover: Flammen in der heißen Rauchschicht unter der Decke.
  float hEnd = uEyeH + dir.y * L;
  float zone = smoothstep(uSmokeBase, max(uCeil - 0.3, uSmokeBase + 0.1), hEnd);
  float flame = smoothstep(0.45, 0.85,
      vnoise(dir * 5.0 + vec3(uTime * 0.7, uTime * 1.6, 0.0)) * 0.7
    + vnoise(dir * 13.0 + vec3(0.0, uTime * 2.5, uTime)) * 0.3);
  col += uRoll * zone * flame * vec3(1.3, 0.55, 0.12);

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
void main() {
  float life = fract(uTime * (0.8 + aSeed.x * 0.7) + aSeed.y);
  float height = 0.25 + 1.0 * uInt;
  float ang = aSeed.z * 6.2831853;
  float rad = (0.05 + 0.3 * uInt) * sqrt(aSeed.w) * (1.0 - life * 0.75);
  vec3 p = uBase + vec3(cos(ang) * rad, life * height, sin(ang) * rad);
  p.x += sin(uTime * 6.0 + aSeed.y * 30.0) * 0.04 * life;
  p.z += cos(uTime * 5.0 + aSeed.x * 30.0) * 0.04 * life;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = (0.06 + 0.15 * uInt) * (1.0 - life * 0.5);
  gl_PointSize = clamp(size * uPx / max(-mv.z, 0.05), 1.0, 300.0);
  vLife = life;
  float L = max(length(p), 1e-3);
  vT = transmittance(p / L, L);
}
`;

const FLAME_FRAG = /* glsl */ `
uniform float uInt;
varying float vLife;
varying float vT;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0 || uInt <= 0.001) discard;
  float a = pow(1.0 - d, 1.5) * pow(1.0 - vLife, 1.3) * min(1.0, uInt * 1.5) * 0.42;
  vec3 col = mix(vec3(1.0, 0.82, 0.42), vec3(1.0, 0.42, 0.08), smoothstep(0.0, 0.4, vLife));
  col = mix(col, vec3(0.6, 0.1, 0.03), smoothstep(0.4, 1.0, vLife));
  gl_FragColor = vec4(col * (0.3 + 0.7 * vT), a);
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
  float L = max(length(p), 1e-3);
  vT = transmittance(p / L, L);
}
`;

const PUFF_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
varying float vLife;
varying float vT;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0 || uAmount <= 0.001) discard;
  float a = (1.0 - d) * (1.0 - vLife) * smoothstep(0.0, 0.15, vLife) * uAmount;
  gl_FragColor = vec4(uColor, a * (0.4 + 0.6 * vT));
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

const FINAL_VERT = BG_VERT;

// Endbild: Hand (bildschirmfüllend), 1 Linse oder 2 Linsen mit Vorverzerrung.
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
varying vec2 vUv;

vec3 sceneAt(vec2 s) {
  vec2 uv = vec2(0.5 + s.x / (2.0 * uAspect), 0.5 + s.y * 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  vec3 c = texture2D(uScene, uv).rgb;
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
      uSmokeCol: { value: new THREE.Vector3(0.17, 0.16, 0.15) },
      uFires: { value: Array.from({ length: MAX_FIRES }, () => new THREE.Vector4()) },
    };
    this.uPx = { value: 800 };

    this.videoTex = new THREE.VideoTexture(video);
    this.videoTex.minFilter = THREE.LinearFilter;
    this.videoTex.magFilter = THREE.LinearFilter;
    this.videoTex.generateMipmaps = false;

    this.rt = new THREE.WebGLRenderTarget(16, 9, { depthBuffer: true });
    this.hudCanvas = document.createElement('canvas');
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.minFilter = THREE.LinearFilter;
    this.hudTex.generateMipmaps = false;

    this._buildBackground();
    this._buildSpray();
    this._buildFinal();

    this.fireViews = new Map();
    this.personViews = new Map();
    this.sceneAspect = 16 / 9;
  }

  _buildBackground() {
    this.bgMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.common,
        uVideo: { value: this.videoTex },
        uHasVideo: { value: 0 },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uRealDist: { value: 4 },
        uRoll: { value: 0 },
        uClear: { value: 0 },
      },
      vertexShader: BG_VERT,
      fragmentShader: BG_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMat);
    bg.frustumCulled = false;
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
      },
      vertexShader: FINAL_VERT,
      fragmentShader: FINAL_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.finalMat);
    quad.frustumCulled = false;
    this.finalScene = new THREE.Scene();
    this.finalScene.add(quad);
    this.finalCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  _addFire(fire) {
    const own = (extra) => ({ ...this.common, uPx: this.uPx, uBase: { value: new THREE.Vector3() }, ...extra });
    const flameMat = new THREE.ShaderMaterial({
      uniforms: own({ uInt: { value: 0 } }),
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
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
    const plumeMat = puff(new THREE.Vector3(0.1, 0.1, 0.1), { uSpread: { value: 0.6 }, uSize: { value: 0.8 }, uSpeed: { value: 0.18 } });
    const steamMat = puff(new THREE.Vector3(0.8, 0.8, 0.8), { uRise: { value: 1.6 }, uSpread: { value: 0.35 }, uSize: { value: 0.45 }, uSpeed: { value: 0.45 } });

    const group = new THREE.Group();
    const plume = points(seedGeometry(140), plumeMat);
    const steam = points(seedGeometry(110), steamMat);
    const flames = points(seedGeometry(320), flameMat);
    plume.renderOrder = 1;
    steam.renderOrder = 2;
    flames.renderOrder = 3;
    group.add(plume, steam, flames);
    this.scene.add(group);
    const view = { group, flameMat, plumeMat, steamMat };
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.finalMat.uniforms.uScreen.value.copy(buf);
    const h = Math.round(Math.min(QUALITY_HEIGHT[quality] || 720, Math.max(buf.y, buf.x / sceneAspect, 360)));
    const w = Math.round(h * sceneAspect);
    if (this.rt.width !== w || this.rt.height !== h) {
      this.rt.setSize(w, h);
      this.hudCanvas.width = w;
      this.hudCanvas.height = h;
      this.hudTex.dispose();
    }
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
    this.bgMat.uniforms.uInvProj.value.copy(cam.projectionMatrixInverse);
    this.bgMat.uniforms.uCamWorld.value.copy(cam.matrixWorld);
    this.uPx.value = this.rt.height / (2 * Math.tan((vfovDeg * DEG) / 2));
  }

  // Überträgt den Übungszustand in die Grafik.
  sync({ time, scenario, settings, eyeH, clear, spray, nozzle, flash, hasVideo }) {
    const u = this.common;
    const lum = 1 - settings.darkness * 0.92;
    u.uTime.value = time;
    u.uEyeH.value = eyeH;
    u.uSmokeBase.value = settings.smokeBase;
    u.uCeil.value = Math.max(settings.ceiling, eyeH + 0.1);
    u.uSigma.value = settings.smokeDensity * 2.5;
    u.uHaze.value = settings.haze * 0.6;
    u.uDark.value = settings.darkness;
    this.bgMat.uniforms.uRealDist.value = settings.roomDepth;
    this.bgMat.uniforms.uRoll.value = scenario.rollover;
    this.bgMat.uniforms.uClear.value = clear ? 1 : 0;
    this.bgMat.uniforms.uHasVideo.value = hasVideo ? 1 : 0;
    this.sprayMat.uniforms.uOpen.value = clear ? 0 : spray;
    this.sprayMat.uniforms.uLight.value = 0.35 + 0.65 * lum;
    for (const [k, v] of Object.entries(SPRAY_SHAPES[nozzle] || SPRAY_SHAPES.fog)) this.sprayMat.uniforms[k].value = v;
    this.finalMat.uniforms.uFlash.value = flash;

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
      for (const m of [view.flameMat, view.plumeMat, view.steamMat]) m.uniforms.uBase.value.copy(f.pos);
      view.flameMat.uniforms.uInt.value = f.out ? 0 : f.intensity;
      view.plumeMat.uniforms.uBase.value.y += 0.3 + 0.6 * f.intensity;
      view.plumeMat.uniforms.uRise.value = Math.max(0.3, ceilingY - view.plumeMat.uniforms.uBase.value.y);
      view.plumeMat.uniforms.uAmount.value = f.out ? f.steam * 0.3 : 0.45 * f.intensity;
      view.plumeMat.uniforms.uColor.value.set(0.12, 0.115, 0.11).multiplyScalar(0.4 + 0.6 * lum);
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
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    r.render(this.finalScene, this.finalCam);
  }
}
