// Builds poc/assets/hand.json + hand.bin: the bones of the hand and wrist that the Hand X-ray view draws.
//
//   node tools/build-hand.mjs
//
// Source: BodyParts3D, (c) The Database Center for Life Science, CC BY-SA 2.1 Japan (STL files from the
// Kevin-Mattheus-Moerman/BodyParts3D mirror, downloaded into tools/cache/bp3d). Every bone is the dataset's
// real mesh of the right hand and forearm, simplified. The 21 hand points that the tracker reports were placed
// on this same hand by the original X-Ray Mirror (they are read from its index.html), which is what lets a bone
// be hung between two tracked points.
//
// Two kinds of mesh are written:
//   group "palm": carpal bones, metacarpals 2-5, and the wrist end of radius and ulna. One rigid block, in the
//                 "palm frame": origin at the wrist point, millimetres, x toward the index knuckle,
//                 z out of the palm, y toward the little-finger side.
//   group "bone": the thumb metacarpal and the 14 finger bones, each in its own frame: x runs from tracked
//                 point a to point b (1 unit = that distance, or 0.8 of it for fingertips, which sit past the
//                 end of the bone), y toward the little-finger side, z out of the palm.
// Each mesh also gets the two ends of its long axis (p0 -> p1 points toward the fingertips), the direction of
// the back of the hand (up) and of the thumb side (side), and how many millimetres one unit is, so the page can
// break a bone at a given place and tilt the far piece.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSTL, bbox, merge, simplify, transform } from "./meshlib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, "tools", "cache", "bp3d");
mkdirSync(cache, { recursive: true });
const MIRROR = "https://raw.githubusercontent.com/Kevin-Mattheus-Moerman/BodyParts3D/main/assets/BodyParts3D_data/stl/";
function stl(id) {
  const p = join(cache, id + ".stl");
  if (!existsSync(p)) { console.log("downloading", id); execFileSync("curl", ["-s", "-L", "-f", MIRROR + id + ".stl", "-o", p]); }
  return loadSTL(p);
}
const html = readFileSync(join(root, "index.html"), "utf8");
const P = JSON.parse(html.match(/<script id="meshmeta"[^>]*>([\s\S]*?)<\/script>/)[1]).demoHand;   // 21 hand points, dataset millimetres
if (!P || P.length !== 21) throw new Error("the original app's hand points were not found in index.html");

// ---- small vector helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]), norm = a => mul(a, 1 / (len(a) || 1));
const r4 = v => v.map(x => +x.toFixed(4));
// rows -> { A, t } that maps a dataset point X to rows * (X - origin)
const frame = (rows, origin) => ({ A: rows.flat(), t: rows.map(r => -dot(r, origin)) });
const apply = (f, p) => [0, 1, 2].map(k => f.A[k * 3] * p[0] + f.A[k * 3 + 1] * p[1] + f.A[k * 3 + 2] * p[2] + f.t[k]);
const rotate = (f, v) => [0, 1, 2].map(k => f.A[k * 3] * v[0] + f.A[k * 3 + 1] * v[1] + f.A[k * 3 + 2] * v[2]);
function inv3(m) {                                              // inverse of a 3x3 given as rows
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

// ---- the palm frame
const e1 = sub(P[5], P[0]), e2 = sub(P[17], P[0]);
const xh = norm(e1), zh = norm(cross(e1, e2)), yh = cross(zh, xh);
const PALM = frame([xh, yh, zh], P[0]);
// The page moves the palm block with the three tracked points (wrist, index knuckle, little-finger knuckle):
// world = wrist + c0*E1 + c1*E2 + c2*E3. palmB turns palm-frame millimetres into those three coefficients.
const e3 = mul(zh, Math.sqrt(len(e1) * len(e2)));
const Minv = inv3([[e1[0], e2[0], e3[0]], [e1[1], e2[1], e3[1]], [e1[2], e2[2], e3[2]]]);     // dataset offset -> coefficients
const palmB = [0, 1, 2].map(r => [xh, yh, zh].map(axis => dot(Minv[r], axis)));              // palm-frame mm -> coefficients (rows)
const toFingers = norm(rotate(PALM, sub(P[9], P[0])));                                       // "toward the fingertips" in the palm frame

// ---- the frame of one finger bone, exactly as the page rebuilds it from the tracked points
const vC = norm(sub(P[17], P[5]));
function boneFrame(a, b) {
  const d = sub(P[b], P[a]), L0 = len(d), vA = mul(d, 1 / L0);
  const vB = norm(sub(vC, mul(vA, dot(vC, vA)))), vN = cross(vA, vB), L = L0 * (b % 4 === 0 ? 0.8 : 1);
  return { f: frame([vA, vB, vN].map(r => mul(r, 1 / L)), P[a]), unit: L };
}

// long axis of a mesh by principal component analysis; returns its two ends, ordered toward `toward`
function longAxis(pos, toward) {
  const n = pos.length / 3, c = [0, 0, 0];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) c[k] += pos[i + k] / n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += (pos[i + a] - c[a]) * (pos[i + b] - c[b]);
  let ax = toward.slice();
  for (let it = 0; it < 80; it++) { const w = C.map(r => dot(r, ax)), l = len(w); ax = mul(w, 1 / l); }
  if (dot(ax, toward) < 0) ax = mul(ax, -1);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.length; i += 3) { const t = dot(sub([pos[i], pos[i + 1], pos[i + 2]], c), ax); if (t < lo) lo = t; if (t > hi) hi = t; }
  return { p0: add(c, mul(ax, lo)), p1: add(c, mul(ax, hi)), ax };
}

const out = [];
function put(name, group, label, mesh, f, unit, extra = {}) {
  const m = transform(mesh, f), b = bbox(m.pos);
  const { p0, p1, ax } = longAxis(m.pos, group === "palm" ? toFingers : [1, 0, 0]);
  // back of the hand is -z in both kinds of frame, the thumb side is -y; make both square to the bone's axis
  const up = norm(sub([0, 0, -1], mul(ax, -ax[2]))), side0 = [0, -1, 0], side = norm(sub(sub(side0, mul(ax, dot(side0, ax))), mul(up, dot(side0, up))));
  out.push({ name, group, label, unit: +unit.toFixed(3), lengthMm: +(len(sub(p1, p0)) * unit).toFixed(1), p0: r4(p0), p1: r4(p1), up: r4(up), side: r4(side), ...extra, mesh: m, min: b.min, size: b.size });
  console.log(`  ${name.padEnd(9)} ${label.padEnd(34)} ${String(m.pos.length / 3).padStart(5)} points  ${(len(sub(p1, p0)) * unit).toFixed(0).padStart(4)} mm long`);
}

console.log("palm block (carpals, metacarpals 2-5, wrist end of radius and ulna)");
const CARPALS = { FMA24435: "scaphoid", FMA24437: "lunate", FMA24439: "triquetral", FMA24441: "pisiform", FMA24443: "trapezium", FMA23725: "trapezoid", FMA24446: "capitate", FMA24448: "hamate" };
put("carpals", "palm", "Carpal bones (wrist)", simplify(merge(Object.keys(CARPALS).map(stl)), 1.0), PALM, 1);
[["mc2", "FMA24466", "Metacarpal of the index finger", 5], ["mc3", "FMA24468", "Metacarpal of the middle finger", 9],
 ["mc4", "FMA24470", "Metacarpal of the ring finger", 13], ["mc5", "FMA24472", "Metacarpal of the little finger", 17]]
  .forEach(([name, id, label, knuckle]) => put(name, "palm", label, simplify(stl(id), 0.9), PALM, 1, { knuckle }));
// forearm: keep the 15 cm nearest the wrist (the arm hangs down in the dataset, so "above the wrist" is +z)
const KEEP = 150;
function wristEnd(id) {
  const m = stl(id), keep = [];
  for (let t = 0; t < m.idx.length; t += 3) { const [a, b, c] = [m.idx[t], m.idx[t + 1], m.idx[t + 2]]; if (Math.max(m.pos[a * 3 + 2], m.pos[b * 3 + 2], m.pos[c * 3 + 2]) < P[0][2] + KEEP) keep.push(a, b, c); }
  const remap = new Map(), pos = [], idx = keep.map(i => { let j = remap.get(i); if (j === undefined) { j = pos.length / 3; remap.set(i, j); pos.push(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]); } return j; });
  return simplify({ pos: new Float32Array(pos), idx: new Uint32Array(idx) }, 1.3);
}
put("radius", "palm", "Radius (thumb side of the forearm)", wristEnd("FMA23464"), PALM, 1);
put("ulna", "palm", "Ulna (little-finger side)", wristEnd("FMA23467"), PALM, 1);

console.log("finger bones");
const FINGER = ["thumb", "index finger", "middle finger", "ring finger", "little finger"];
[[1, 2, "FMA24464", "Metacarpal of the thumb"], [2, 3, "FMA24450", "Proximal phalanx"], [3, 4, "FMA24459", "Distal phalanx"],
 [5, 6, "FMA24451", "Proximal phalanx"], [6, 7, "FMA24455", "Middle phalanx"], [7, 8, "FMA24460", "Distal phalanx"],
 [9, 10, "FMA24452", "Proximal phalanx"], [10, 11, "FMA24456", "Middle phalanx"], [11, 12, "FMA24461", "Distal phalanx"],
 [13, 14, "FMA24453", "Proximal phalanx"], [14, 15, "FMA24457", "Middle phalanx"], [15, 16, "FMA24462", "Distal phalanx"],
 [17, 18, "FMA24454", "Proximal phalanx"], [18, 19, "FMA24458", "Middle phalanx"], [19, 20, "FMA24463", "Distal phalanx"]]
  .forEach(([a, b, id, kind]) => { const { f, unit } = boneFrame(a, b), finger = FINGER[Math.floor((a - 1) / 4)];
    put(`b_${a}_${b}`, "bone", a === 1 ? kind : `${kind} of the ${finger}`, simplify(stl(id), 0.7), f, unit, { a, b }); });

// ---- write (same layout as poc/assets/head.*: 16-bit positions inside each mesh's box, then the triangle list)
let bytes = 0; const chunks = [], meshes = [];
const pad = n => { const p = (n - (bytes % n)) % n; if (p) { chunks.push(Buffer.alloc(p)); bytes += p; } };
for (const o of out) {
  const { pos, idx } = o.mesh, nv = pos.length / 3, q = new Uint16Array(pos.length);
  for (let i = 0; i < pos.length; i++) q[i] = Math.round((pos[i] - o.min[i % 3]) / (o.size[i % 3] || 1) * 65535);
  pad(2); const offV = bytes; chunks.push(Buffer.from(q.buffer)); bytes += q.byteLength;
  const big = nv > 65535, ix = big ? idx : Uint16Array.from(idx);
  pad(big ? 4 : 2); const offI = bytes; chunks.push(Buffer.from(ix.buffer, ix.byteOffset, ix.byteLength)); bytes += ix.byteLength;
  const { mesh, ...rest } = o;
  meshes.push({ ...rest, min: r4(o.min), size: r4(o.size), nv, ni: idx.length, index32: big, offV, offI });
}
mkdirSync(join(root, "poc", "assets"), { recursive: true });
writeFileSync(join(root, "poc", "assets", "hand.bin"), Buffer.concat(chunks));
writeFileSync(join(root, "poc", "assets", "hand.json"), JSON.stringify({
  about: "Bones of the right hand and wrist for the Hand X-ray view. Palm-group meshes are in the palm frame (mm; origin at the wrist point, x toward the index knuckle, y toward the little-finger side, z out of the palm). Bone-group meshes are in their own frame (x from tracked point a to b).",
  source: "BodyParts3D, (c) The Database Center for Life Science, CC BY-SA 2.1 Japan. Real meshes of one adult's right hand, simplified. Hand points from MasterOfVFX2070/xray-mirror.",
  palmB: palmB.map(r4),                                             // rows; palm-frame mm -> coefficients of (E1, E2, E3)
  rest: P.map(p => r4(apply(PALM, p))),                             // the 21 hand points in the palm frame, for the test scene
  elbow: r4(norm(rotate(PALM, [0, 0, 1]))),                         // direction from the wrist toward the elbow, palm frame
  meshes }, null, 1));
console.log(`wrote ${meshes.length} meshes, ${(bytes / 1024).toFixed(0)} KB, ${out.reduce((s, o) => s + o.mesh.idx.length / 3, 0)} triangles`);
