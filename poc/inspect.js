// Dev tool: draws the built head anatomy (poc/assets/head.*) in orthographic views with a 1 cm grid, so shapes
// and positions can be checked before they are pinned to a live face.
//   ?show=skull,sinus,nose,teeth,lining,muscle,soft,skin,mandible  (group names or mesh-name prefixes)
//   &look=solid|xray  &views=front,side,top,back  &center=x,y,z  &span=cm
import * as THREE from "three";
import { loadHead } from "./head.js";
import { makeMat } from "./gfx.js";

const q = new URLSearchParams(location.search);
const show = (q.get("show") || "skull,sinus,nose").split(",");
const center = (q.get("center") || "0,0,0").split(",").map(Number);
const span = Number(q.get("span") || 24), solid = (q.get("look") || "solid") === "solid";
const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x05070c, 1); renderer.autoClear = false;
const scene = new THREE.Scene();
const head = await loadHead();

const COLOR = { frontal: 0x67dcff, ethmoid: 0x8be9c4, sphenoid: 0xb9a2ff, maxillary: 0x5fb6ff, mastoid: 0xc8a8ff, adenoids: 0xff8a5c, nasal: 0xff9fb6,
                skull: 0x8fb4e8, mandible: 0xd8a06f, skin: 0x5577aa, masseter: 0xff6b5e, lining: 0xffb35c };
const labels = [];
for (const m of head.meta.meshes) {
  if (!show.some(t => t === m.group || m.name.startsWith(t))) continue;
  const bone = m.group === "bone" || m.group === "skin";
  const color = m.group === "teeth" ? 0xf2efe4 : m.group === "lining" ? COLOR.lining : COLOR[m.key] ?? 0xdddddd;
  const mat = makeMat({ ortho: true, color, fill: color, mode: solid && !bone ? 1 : 0, gain: bone ? 0.45 : solid ? 1 : 0.9, fillAmt: bone ? 0.02 : 0.1 });
  const mesh = new THREE.Mesh(head.geometry(m.name), mat); mesh.frustumCulled = false; mesh.renderOrder = bone ? 2 : 1; scene.add(mesh);
  if (!bone) labels.push({ at: m.tip ?? m.center, text: m.fdi ? String(m.fdi) : m.name });
}
const dots = Object.entries(head.meta.fit).map(([id, p]) => new THREE.Vector3(...p));

const ALL_VIEWS = {
  front: { name: "FRONT (you see the face; screen-right = person's left, +x)", pos: [0, 0, 1], up: [0, 1, 0] },
  back: { name: "BACK (from behind)", pos: [0, 0, -1], up: [0, 1, 0] },
  side: { name: "SIDE (from the person's left; the face points screen-left)", pos: [1, 0, 0], up: [0, 1, 0] },
  right: { name: "SIDE (from the person's right; the face points screen-right)", pos: [-1, 0, 0], up: [0, 1, 0] },
  top: { name: "TOP (looking down; screen-up = back)", pos: [0, 1, 0], up: [0, 0, -1] },
  bottom: { name: "BOTTOM (looking up; screen-up = front)", pos: [0, -1, 0], up: [0, 0, 1] },
  quarter: { name: "THREE-QUARTER", pos: [0.6, 0.25, 1], up: [0, 1, 0] },
};
const VIEWS = (q.get("views") || "front,side,top").split(",").map(k => ALL_VIEWS[k]);
const hud = document.createElement("canvas"); hud.style.cssText = "position:fixed;inset:0;pointer-events:none;width:100vw;height:100vh";
document.body.appendChild(hud);

function render() {
  const W = innerWidth, H = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(W, H, false);
  hud.width = W; hud.height = H; const g = hud.getContext("2d");
  renderer.clear();
  const vw = W / VIEWS.length, c = new THREE.Vector3(...center);
  VIEWS.forEach((v, i) => {
    const hh = span / 2, hw = hh * vw / H, cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, -200, 200);
    cam.position.copy(c).add(new THREE.Vector3(...v.pos).normalize().multiplyScalar(60)); cam.up.set(...v.up); cam.lookAt(c);
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    renderer.setViewport(i * vw, 0, vw, H); renderer.setScissor(i * vw, 0, vw, H); renderer.setScissorTest(true);
    renderer.clearDepth(); renderer.render(scene, cam);
    const toPx = p => { const s = p.clone().project(cam); return [i * vw + (s.x + 1) / 2 * vw, (1 - s.y) / 2 * H]; };
    g.save(); g.beginPath(); g.rect(i * vw, 0, vw, H); g.clip();
    if (!q.has("nogrid")) for (const ax of ["x", "y", "z"]) for (let k = -20; k <= 20; k++) {
      // 1 cm grid lines through the centre plane, for the two axes that lie in this view
      for (const other of ["x", "y", "z"]) { if (other === ax) continue;
        const dir = new THREE.Vector3(...v.pos).normalize(); if (Math.abs(dir[ax]) > 0.9 || Math.abs(dir[other]) > 0.9) continue;
        const p0 = c.clone(), p1 = c.clone(); p0[ax] = k; p1[ax] = k; p0[other] = c[other] - 40; p1[other] = c[other] + 40;
        const [x0, y0] = toPx(p0), [x1, y1] = toPx(p1);
        g.strokeStyle = k === 0 ? "rgba(255,255,255,.4)" : k % 2 ? "rgba(120,140,180,.08)" : "rgba(120,140,180,.2)"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
    }
    g.fillStyle = "#ffb703"; for (const d of dots) { const [x, y] = toPx(d); g.fillRect(x - 2, y - 2, 4, 4); }
    if (q.has("labels")) { g.font = "11px system-ui"; g.fillStyle = "#9effc8"; for (const L of labels) { const [x, y] = toPx(new THREE.Vector3(...L.at)); g.fillText(L.text, x + 3, y - 3); } }
    g.fillStyle = "#c9d3ea"; g.font = "12px system-ui"; g.fillText(v.name, i * vw + 8, 16);
    g.restore();
  });
}
render(); addEventListener("resize", render);
window.__ready = true;
