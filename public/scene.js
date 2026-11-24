// 3D dice on a felt table. The server decides every roll, so there is no
// physics: each die tumbles through the air and settles with the right face up.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const N = 6;
// Which die face points where on an unrotated cube (opposite faces sum to 7).
const NORMAL = { 3: [1, 0, 0], 4: [-1, 0, 0], 1: [0, 1, 0], 6: [0, -1, 0], 2: [0, 0, 1], 5: [0, 0, -1] };
const GROUP_FACE = [3, 4, 1, 6, 2, 5]; // BoxGeometry material order: +x -x +y -y +z -z
const PIPS = {
  1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]], 4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]], 6: [[0, 0], [0, 1], [0, 2], [2, 0], [2, 1], [2, 2]],
};
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(0xffffff);
const DIM = new THREE.Color(0x6e6a60);
const KEPT = new THREE.Color(0xe9dfc2);

// Small deterministic generator so every client lays out a roll identically.
function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function faceTexture(v) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const bg = g.createRadialGradient(100, 90, 20, 128, 128, 190);
  bg.addColorStop(0, '#fffaf0');
  bg.addColorStop(1, '#e9dcc0');
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 256);
  const r = v === 1 ? 40 : 25;
  for (const [x, y] of PIPS[v]) {
    const px = 64 + x * 64, py = 64 + y * 64;
    const grad = g.createRadialGradient(px - 6, py - 6, 2, px, py, r);
    if (v === 1) { grad.addColorStop(0, '#e24b3c'); grad.addColorStop(1, '#a31d14'); }
    else { grad.addColorStop(0, '#3a332c'); grad.addColorStop(1, '#0d0b09'); }
    g.fillStyle = grad;
    g.beginPath();
    g.arc(v === 1 ? 128 : px, v === 1 ? 128 : py, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function feltTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#1f6b43';
  g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 22;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(14, 14);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const quatFor = (v, yaw) => {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...NORMAL[v]), UP);
  return new THREE.Quaternion().setFromAxisAngle(UP, yaw).multiply(q);
};

export class DiceView {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.append(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f2a1c);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    this.insets = { top: 0, bottom: 0 };
    this.zoom = 1; // viewer's dice-size preference (1 = default)

    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    sun.position.set(-3, 9, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 25 });
    sun.shadow.bias = -0.0005;
    sun.shadow.radius = 4;
    this.scene.add(sun);

    const felt = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.95, metalness: 0 }),
    );
    felt.rotation.x = -Math.PI / 2;
    felt.receiveShadow = true;
    this.scene.add(felt);

    const geo = new RoundedBoxGeometry(1, 1, 1, 5, 0.13);
    const faces = [1, 2, 3, 4, 5, 6].map((v) => [v, faceTexture(v)]);
    const texOf = Object.fromEntries(faces);
    this.dice = Array.from({ length: N }, (_, slot) => {
      const mats = GROUP_FACE.map((v) => new THREE.MeshStandardMaterial({ map: texOf[v], roughness: 0.32, metalness: 0, emissive: 0x000000 }));
      const mesh = new THREE.Mesh(geo, mats);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.slot = slot;
      this.scene.add(mesh);
      return {
        mesh, mats, slot,
        target: { pos: new THREE.Vector3(0, 0.5, 0), quat: new THREE.Quaternion(), scale: 1, lift: 0 },
        tint: WHITE.clone(), tintTo: WHITE, glow: 0, glowTo: 0, anim: null,
      };
    });

    this.onDieClick = null;
    this.state = { slots: Array.from({ length: N }, () => ({ v: 0, kept: false })), rollId: 0, selected: new Set(), usable: null, interactive: false };
    this.clock = new THREE.Clock();
    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.#bindPointer();
    this.resize();
    this.layout(this.state.slots, 0);
    for (const d of this.dice) { d.mesh.position.copy(d.target.pos); d.mesh.quaternion.copy(d.target.quat); }
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  setInsets(top, bottom) {
    this.insets = { top, bottom };
    this.resize();
  }

  /** Make the whole table (dice and spacing) larger or smaller, e.g. 0.8 or 1.1. */
  setZoom(z) {
    this.zoom = z;
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    const { top, bottom } = this.insets;
    const effH = Math.max(120, h - top - bottom);
    const aspect = w / h;
    this.camera.aspect = aspect;
    const vf = THREE.MathUtils.degToRad(this.camera.fov);
    const tanV = Math.tan(vf / 2);
    const halfW = 3.7, halfD = 3.6;
    const distW = halfW / (tanV * aspect);
    const distH = (halfD * 0.78) / (tanV * (effH / h));
    const dist = Math.max(distW, distH) / this.zoom;
    const dir = new THREE.Vector3(0, 1, 0.5).normalize();
    const look = new THREE.Vector3(0, 0, 0.55);
    this.camera.position.copy(look).addScaledVector(dir, dist);
    this.camera.lookAt(look);
    const centre = top + effH / 2;
    this.camera.setViewOffset(w, h, 0, -(centre - h / 2), w, h);
    this.camera.updateProjectionMatrix();
  }

  /** Where each slot rests: free dice in a 3x2 grid, kept dice in a row below. */
  layout(slots, rollId) {
    const rand = rng(rollId * 31 + 7);
    let k = 0;
    const keptCount = slots.filter((s) => s.kept).length;
    slots.forEach((s, i) => {
      const d = this.dice[i];
      const t = d.target;
      if (s.kept) {
        t.pos.set((k - (keptCount - 1) / 2) * 1.02, 0.39, 3.25);
        t.scale = 0.78;
        k++;
      } else {
        const col = i % 3, row = Math.floor(i / 3);
        t.pos.set((col - 1) * 1.85 + (rand() - 0.5) * 0.5, 0.5, -1.35 + row * 1.9 + (rand() - 0.5) * 0.5);
        t.scale = 1;
      }
      const v = s.v || 1 + Math.floor(rand() * 6);
      t.quat.copy(quatFor(v, rand() * Math.PI * 2));
    });
  }

  /** Show a state without animating. */
  set(slots, rollId) {
    this.state.slots = slots.map((s) => ({ ...s }));
    this.state.rollId = rollId;
    this.layout(this.state.slots, rollId);
    for (const d of this.dice) {
      d.anim = null;
      d.mesh.position.copy(d.target.pos);
      d.mesh.quaternion.copy(d.target.quat);
      d.mesh.scale.setScalar(d.target.scale);
    }
    this.#restyle();
  }

  /** Throw the free dice; resolves when they have all landed. */
  roll(slots, rollId, sound) {
    this.state.slots = slots.map((s) => ({ ...s }));
    this.state.rollId = rollId;
    const before = this.dice.map((d) => d.mesh.position.clone());
    this.layout(this.state.slots, rollId);
    const rand = rng(rollId * 17 + 3);
    const jobs = [];
    this.state.slots.forEach((s, i) => {
      const d = this.dice[i];
      if (s.kept) { d.anim = null; return; } // kept dice glide to the row via easing
      const dur = 0.85 + rand() * 0.25;
      const delay = i * 0.04;
      d.anim = {
        t: -delay, dur,
        from: new THREE.Vector3((rand() - 0.5) * 2, 0.8, 5.2 + rand()),
        axis: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
        spin: (3 + rand() * 3) * Math.PI * (rand() < 0.5 ? -1 : 1),
        arc: 1.9 + rand() * 0.8,
      };
      jobs.push(new Promise((res) => { d.anim.done = res; }));
      void before;
    });
    sound?.();
    this.#restyle();
    return Promise.all(jobs);
  }

  /** selected: Set of slots; usable: bool[] or null; interactive: whether taps count. */
  setSelection(selected, usable, interactive) {
    Object.assign(this.state, { selected, usable, interactive });
    this.#restyle();
  }

  #restyle() {
    const { slots, selected, usable, interactive } = this.state;
    slots.forEach((s, i) => {
      const d = this.dice[i];
      const sel = selected.has(i);
      d.tintTo = s.kept ? KEPT : !s.v ? DIM : usable && !usable[i] ? DIM : WHITE;
      d.glowTo = sel ? 1 : s.kept ? 0.18 : 0;
      d.target.lift = sel ? 0.5 : 0;
      d.mesh.userData.clickable = interactive && !s.kept && !!s.v;
    });
  }

  #bindPointer() {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) return;
      const r = el.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(p, this.camera);
      const hit = ray.intersectObjects(this.dice.map((d) => d.mesh), false)[0];
      if (hit?.object.userData.clickable) this.onDieClick?.(hit.object.userData.slot);
      down = null;
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(p, this.camera);
      const hit = ray.intersectObjects(this.dice.map((d) => d.mesh), false)[0];
      el.style.cursor = hit?.object.userData.clickable ? 'pointer' : '';
    });
  }

  #frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const ease = 1 - Math.exp(-dt * 11);
    for (const d of this.dice) {
      const m = d.mesh, t = d.target;
      if (d.anim) {
        const a = d.anim;
        a.t += dt;
        const u = Math.min(Math.max(a.t / a.dur, 0), 1);
        const e = 1 - (1 - u) ** 3;
        m.position.lerpVectors(a.from, t.pos, e);
        m.position.y += Math.sin(Math.PI * u) * a.arc + Math.abs(Math.sin(u * Math.PI * 3)) * 0.22 * (1 - u) ** 2;
        m.quaternion.copy(t.quat).multiply(new THREE.Quaternion().setFromAxisAngle(a.axis, a.spin * (1 - e)));
        m.scale.setScalar(t.scale);
        if (u >= 1) { d.anim = null; a.done?.(); }
        continue;
      }
      const goal = t.pos.clone();
      goal.y += t.lift;
      m.position.lerp(goal, ease);
      m.quaternion.slerp(t.quat, ease);
      m.scale.setScalar(m.scale.x + (t.scale - m.scale.x) * ease);
      d.tint.lerp(d.tintTo, ease);
      d.glow += (d.glowTo - d.glow) * ease;
      for (const mat of d.mats) {
        mat.color.copy(d.tint);
        mat.emissive.setRGB(0.28 * d.glow, 0.18 * d.glow, 0.01 * d.glow);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }
}
