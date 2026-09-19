import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TTFLoader } from 'three/addons/loaders/TTFLoader.js';

const POPPINS_TTF = 'https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-SemiBold.ttf';

async function loadPoppins() {
  try {
    const json = await new TTFLoader().loadAsync(POPPINS_TTF);
    return new FontLoader().parse(json);
  } catch (e) {
    console.warn('Poppins unavailable, using built-in geometric glyphs.', e.message);
    return null;
  }
}

const D = d => (d * Math.PI) / 180;

/* ---------- shape helpers ---------- */

function circleShape(cx, cy, r) {
  const s = new THREE.Shape();
  s.absarc(cx, cy, r, 0, Math.PI * 2, false);
  return s;
}

function ringShape(cx, cy, rMid, stroke) {
  const s = circleShape(cx, cy, rMid + stroke / 2);
  const h = new THREE.Path();
  h.absarc(cx, cy, rMid - stroke / 2, 0, Math.PI * 2, true);
  s.holes.push(h);
  return s;
}

// open ring segment with round terminals, returned as an array of shapes
function arcShapes(cx, cy, rMid, stroke, a0, a1) {
  const ro = rMid + stroke / 2;
  const ri = rMid - stroke / 2;
  const s = new THREE.Shape();
  s.absarc(cx, cy, ro, a0, a1, false);
  s.lineTo(cx + ri * Math.cos(a1), cy + ri * Math.sin(a1));
  s.absarc(cx, cy, ri, a1, a0, true);
  s.closePath();
  const cap = a => circleShape(cx + rMid * Math.cos(a), cy + rMid * Math.sin(a), stroke / 2);
  return [s, cap(a0), cap(a1)];
}

function bar(x, y, w, h) {
  const s = new THREE.Shape();
  s.moveTo(x, y);
  s.lineTo(x + w, y);
  s.lineTo(x + w, y + h);
  s.lineTo(x, y + h);
  s.closePath();
  return s;
}

function poly(pts) {
  const s = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return s;
}

/* ---------- lowercase geometric alphabet (only what "chunguza" needs) ----------
   x-height 0.50, ascender 0.72, descender -0.20, stroke 0.115, bowl width 0.485 */

const S = 0.115;          // stroke
const XH = 0.5;           // x-height
const W = 0.485;          // bowl width
const CX = W / 2;         // bowl centre x
const CY = XH / 2;        // bowl centre y
const R = CX - S / 2;     // bowl mid radius
const ADV = W + 0.135;    // advance width

const GLYPHS = {
  c: () => arcShapes(CX, CY, R, S, D(42), D(318)),
  h: () => [bar(0, 0, S, 0.72), ...arcShapes(CX, CY, R, S, D(0), D(180)), bar(W - S, 0, S, CY)],
  n: () => [bar(0, 0, S, XH), ...arcShapes(CX, CY, R, S, D(0), D(180)), bar(W - S, 0, S, CY)],
  u: () => [bar(0, CY, S, CY), ...arcShapes(CX, CY, R, S, D(180), D(360)), bar(W - S, 0, S, XH)],
  g: () => [ringShape(CX, CY, R, S), bar(W - S, -0.145, S, CY + 0.145), bar(0.03, -0.2, W - S - 0.03, S)],
  a: () => [ringShape(CX, CY, R, S), bar(W - S, 0, S, XH)],
  z: () => [
    bar(0, XH - S, W, S),
    bar(0, 0, W, S),
    poly([[0.02, S], [W - S - 0.02, XH - S], [W - 0.02, XH - S], [S + 0.02, S]]),
  ],
};

/* ---------- build ---------- */

const accent = new THREE.MeshStandardMaterial({ name: 'chunguza-blurple', color: 0x9184d9, roughness: 0.32, metalness: 0.25 });
const pale = new THREE.MeshStandardMaterial({ name: 'signal-white', color: 0xe9e9ed, roughness: 0.45, metalness: 0.1 });
const inkMat = new THREE.MeshStandardMaterial({ name: 'wordmark-ink', color: 0xdcdce4, roughness: 0.55, metalness: 0.05 });

function extrude(shapes, depth, bevel) {
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth,
    curveSegments: bevel ? 64 : 24,
    bevelEnabled: !!bevel,
    bevelThickness: bevel || 0,
    bevelSize: bevel || 0,
    bevelOffset: 0,
    bevelSegments: bevel ? 4 : 0,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

// Poppins wordmark: one mesh, shapes from the real font outlines
function poppinsWord(font, text) {
  const size = 1;
  const shapes = font.generateShapes(text, size);
  const g = extrude(shapes, 0.05, 0);
  g.computeBoundingBox();
  const bb = g.boundingBox;
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, 0);
  const mesh = new THREE.Mesh(g, inkMat);
  mesh.name = 'wordmark-chunguza';
  mesh.castShadow = true;
  const group = new THREE.Group();
  group.name = 'wordmark';
  group.add(mesh);
  return { group, width: bb.max.x - bb.min.x, top: bb.max.y, desc: 0 };
}

export async function buildLogo(opts = {}) {
  const logo = new THREE.Group();
  logo.name = 'chunguza-logo';

  /* --- the C mark: a thick open ring, the scan arc of the tool --- */
  const markR = 0.78;
  const markStroke = 0.3;
  const cMesh = new THREE.Mesh(extrude(arcShapes(0, 0, markR, markStroke, D(40), D(320)), 0.34, 0.035), accent);
  cMesh.name = 'letter-C';
  cMesh.castShadow = true;

  // the lead caught in the C's mouth
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.185, 48, 32), pale);
  dot.name = 'lead-dot';
  dot.castShadow = true;
  dot.position.set(markR * 0.52, 0, 0);

  const mark = new THREE.Group();
  mark.name = 'mark';
  mark.add(cMesh, dot);

  /* --- flat wordmark --- */
  const font = opts.markOnly ? null : await loadPoppins();
  if (font) {
    const { group, width, top, desc } = poppinsWord(font, 'chunguza');
    const scale = (markR * 2 + markStroke) * 1.32 / width;
    group.scale.setScalar(scale);
    group.position.y = desc * scale;
    mark.position.y = (desc + top) * scale + 0.3 + markR + markStroke / 2 + 0.035;
    logo.add(mark, group);
    return logo;
  }

  const word = new THREE.Group();
  word.name = 'wordmark';
  let x = 0;
  for (const ch of 'chunguza') {
    const shapes = GLYPHS[ch]();
    const m = new THREE.Mesh(extrude(shapes, 0.05, 0), inkMat);
    m.name = 'wordmark-' + ch + '-' + Math.round(x * 1000);
    m.castShadow = true;
    m.position.x = x;
    word.add(m);
    x += ADV;
  }
  const wordWidth = x - 0.135;
  word.children.forEach(c => (c.position.x -= wordWidth / 2));

  const wordScale = (markR * 2 + markStroke) * 1.32 / wordWidth;
  word.scale.setScalar(wordScale);

  /* --- stack: mark above, wordmark below, base resting at y = 0 --- */
  const markOuter = markR + markStroke / 2 + 0.035;
  const wordTop = XH * wordScale;
  const wordDesc = 0.2 * wordScale;
  word.position.y = wordDesc;
  mark.position.y = wordDesc + wordTop + 0.28 + markOuter;

  if (opts.markOnly) {
    logo.add(mark);
    mark.position.y = markOuter;
  } else {
    logo.add(mark, word);
  }
  return logo;
}
