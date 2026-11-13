// Builds poc/assets/head.json + head.bin: the anatomy the Health Mirror draws, in head coordinates (cm).
//
//   node tools/build-anatomy.mjs
//
// Sources (BodyParts3D, (c) The Database Center for Life Science, CC BY-SA 2.1 Japan; STL files from the
// Kevin-Mattheus-Moerman/BodyParts3D mirror, downloaded into tools/cache/bp3d by this script):
//   - REAL meshes: all 28 teeth, inferior nasal conchae, vomer, septal cartilage, masseter muscles.
//   - RECONSTRUCTED: the paranasal sinuses. BodyParts3D models the skull bones as solid, so there are no sinus
//     cavities in the data. They are rebuilt here by hollowing the real bones (maxilla, sphenoid, ethmoid,
//     temporal) to a typical wall thickness, and for the frontal sinus by following the real forehead surface.
//     The shapes therefore fit this skull, but they are not a scan of anyone's sinuses.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSTL, bbox, components, merge, transform, simplify, voxelize, morph, label, volume } from "./meshlib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, "tools", "cache", "bp3d");
mkdirSync(cache, { recursive: true });
const MIRROR = "https://raw.githubusercontent.com/Kevin-Mattheus-Moerman/BodyParts3D/main/assets/BodyParts3D_data/stl/";
function stl(id) {
  const p = join(cache, id + ".stl");
  if (!existsSync(p)) { console.log("downloading", id); execFileSync("curl", ["-s", "-L", "-f", MIRROR + id + ".stl", "-o", p]); }
  return loadSTL(p);
}
if (!existsSync(join(root, "tools", "cache", "transform.json"))) execFileSync(process.execPath, [join(root, "tools", "fit-transform.mjs")], { stdio: "inherit" });
const TF = JSON.parse(readFileSync(join(root, "tools", "cache", "transform.json"), "utf8"));
// the original app's skin mesh, face-fit points and jaw pivot (already in head coordinates)
if (!existsSync(join(root, "tools", "cache", "original.json"))) execFileSync(process.execPath, [join(root, "tools", "extract-anatomy.mjs")], { stdio: "inherit" });
const ORIG = JSON.parse(readFileSync(join(root, "tools", "cache", "original.json"), "utf8"));
function original(name) {
  const bin = readFileSync(join(root, "tools", "cache", "original.bin")), ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length);
  const m = ORIG.meshes.find(m => m.name === name), q = new Uint16Array(ab, m.offV, m.nv * 3), pos = new Float32Array(m.nv * 3);
  for (let i = 0; i < q.length; i++) pos[i] = m.min[i % 3] + q[i] / 65535 * m.size[i % 3];
  return { pos, idx: Uint32Array.from(new Uint16Array(ab, m.offI, m.ni)) };
}
const toHead = (m, jaw = false) => transform(m, jaw ? TF.jaw : TF.skull);
const headPt = (p, jaw = false) => Array.from(transform({ pos: new Float32Array(p), idx: new Uint32Array(0) }, jaw ? TF.jaw : TF.skull).pos);

// ------------------------------------------------------------------------------------------------ voxel tools
const makeGrid = (min, max, size) => ({ origin: min, size, dims: max.map((v, k) => Math.ceil((v - min[k]) / size)) });
const vox = (g, ids) => { const out = new Uint8Array(g.dims[0] * g.dims[1] * g.dims[2]); for (const id of [].concat(ids)) voxelize(typeof id === "string" ? stl(id) : id, g, out); return out; };
const each = (g, fn) => { const [nx, ny, nz] = g.dims; let v = 0; for (let i = 0; i < nx; i++) { const x = g.origin[0] + (i + 0.5) * g.size; for (let j = 0; j < ny; j++) { const y = g.origin[1] + (j + 0.5) * g.size; for (let k = 0; k < nz; k++, v++) fn(v, x, y, g.origin[2] + (k + 0.5) * g.size, i, j, k); } } };

// distance (mm) from each inside voxel to the nearest outside voxel (two-pass chamfer)
function insideDistance(g, mask) {
  const [nx, ny, nz] = g.dims, d = new Float32Array(mask.length), sy = nz, sx = ny * nz;
  for (let v = 0; v < d.length; v++) d[v] = mask[v] ? 1e6 : 0;
  const nb = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) if (a < 0 || (a === 0 && (b < 0 || (b === 0 && c < 0)))) nb.push([a, b, c, Math.hypot(a, b, c)]);
  const pass = sign => {
    const i0 = sign > 0 ? 0 : nx - 1, j0 = sign > 0 ? 0 : ny - 1, k0 = sign > 0 ? 0 : nz - 1;
    for (let i = i0; i >= 0 && i < nx; i += sign) for (let j = j0; j >= 0 && j < ny; j += sign) for (let k = k0; k >= 0 && k < nz; k += sign) {
      const v = (i * ny + j) * nz + k; if (!d[v]) continue; let m = d[v];
      for (const [a, b, c, w] of nb) {
        const ii = i + a * sign, jj = j + b * sign, kk = k + c * sign;
        const val = (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) ? w : d[v + (a * sx + b * sy + c) * sign] + w;
        if (val < m) m = val;
      }
      d[v] = m;
    }
  };
  pass(1); pass(-1);
  for (let v = 0; v < d.length; v++) d[v] *= g.size;
  return d;
}

// keep only the largest connected region of a mask
function largest(g, mask) { const { labels, regions } = label(g, mask); if (!regions.length) return mask; const id = regions[0].id, out = new Uint8Array(mask.length); for (let v = 0; v < mask.length; v++) out[v] = labels[v] === id ? 1 : 0; return out; }

// smooth scalar field (0..1) from a mask: box blur, n passes
function field(g, mask, passes = 2) {
  const [nx, ny, nz] = g.dims; let f = Float32Array.from(mask);
  const blur = (src, stride, n, total) => { const out = new Float32Array(src.length);
    for (let v = 0; v < total; v++) { const pos = Math.floor(v / stride) % n; const a = pos > 0 ? src[v - stride] : src[v], b = pos < n - 1 ? src[v + stride] : src[v]; out[v] = (a + src[v] * 2 + b) / 4; } return out; };
  for (let p = 0; p < passes; p++) { f = blur(f, ny * nz, nx, f.length); f = blur(f, nz, ny, f.length); f = blur(f, 1, nz, f.length); }
  return f;
}

// "surface nets": a smooth closed mesh of the iso-surface of a scalar field
function surfaceNets(g, f, iso = 0.5) {
  const [nx, ny, nz] = g.dims, s = g.size, [ox, oy, oz] = g.origin, cell = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const ci = (i, j, k) => (i * (ny - 1) + j) * (nz - 1) + k, F = (i, j, k) => f[(i * ny + j) * nz + k];
  const pos = [], idx = [];
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];   // corner = a*4 + b*2 + c  (offsets i,j,k)
  const c = new Float32Array(8);
  for (let i = 0; i < nx - 1; i++) for (let j = 0; j < ny - 1; j++) for (let k = 0; k < nz - 1; k++) {
    let m = 0;
    for (let q = 0; q < 8; q++) { c[q] = F(i + (q >> 2), j + ((q >> 1) & 1), k + (q & 1)); if (c[q] >= iso) m |= 1 << q; }
    if (m === 0 || m === 255) continue;
    let x = 0, y = 0, z = 0, n = 0;
    for (const [a, b] of E) { if (((m >> a) & 1) === ((m >> b) & 1)) continue; const t = (iso - c[a]) / (c[b] - c[a]);
      x += (a >> 2) + t * ((b >> 2) - (a >> 2)); y += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1)); z += (a & 1) + t * ((b & 1) - (a & 1)); n++; }
    cell[ci(i, j, k)] = pos.length / 3;
    pos.push(ox + (i + 0.5 + x / n) * s, oy + (j + 0.5 + y / n) * s, oz + (k + 0.5 + z / n) * s);
  }
  const quad = (a, b, cc, d, flip) => { if (a < 0 || b < 0 || cc < 0 || d < 0) return; if (flip) idx.push(a, cc, b, a, d, cc); else idx.push(a, b, cc, a, cc, d); };
  for (let i = 0; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) for (let k = 1; k < nz - 1; k++) {       // edges along x
    const a = F(i, j, k) >= iso, b = F(i + 1, j, k) >= iso; if (a !== b) quad(cell[ci(i, j - 1, k - 1)], cell[ci(i, j, k - 1)], cell[ci(i, j, k)], cell[ci(i, j - 1, k)], !a); }
  for (let i = 1; i < nx - 1; i++) for (let j = 0; j < ny - 1; j++) for (let k = 1; k < nz - 1; k++) {       // edges along y
    const a = F(i, j, k) >= iso, b = F(i, j + 1, k) >= iso; if (a !== b) quad(cell[ci(i - 1, j, k - 1)], cell[ci(i - 1, j, k)], cell[ci(i, j, k)], cell[ci(i, j, k - 1)], !a); }
  for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) for (let k = 0; k < nz - 1; k++) {       // edges along z
    const a = F(i, j, k) >= iso, b = F(i, j, k + 1) >= iso; if (a !== b) quad(cell[ci(i - 1, j - 1, k)], cell[ci(i, j - 1, k)], cell[ci(i, j, k)], cell[ci(i - 1, j, k)], !a); }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

// Taubin smoothing: removes the voxel staircase without shrinking the shape
function smoothMesh({ pos, idx }, iterations = 12) {
  const nv = pos.length / 3, nbr = Array.from({ length: nv }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) { const a = idx[t], b = idx[t + 1], c = idx[t + 2]; nbr[a].add(b).add(c); nbr[b].add(a).add(c); nbr[c].add(a).add(b); }
  let p = Float32Array.from(pos);
  const step = f => { const q = new Float32Array(p.length);
    for (let v = 0; v < nv; v++) { let x = 0, y = 0, z = 0; const n = nbr[v].size; if (!n) { q[v * 3] = p[v * 3]; q[v * 3 + 1] = p[v * 3 + 1]; q[v * 3 + 2] = p[v * 3 + 2]; continue; }
      for (const w of nbr[v]) { x += p[w * 3]; y += p[w * 3 + 1]; z += p[w * 3 + 2]; }
      q[v * 3] = p[v * 3] + f * (x / n - p[v * 3]); q[v * 3 + 1] = p[v * 3 + 1] + f * (y / n - p[v * 3 + 1]); q[v * 3 + 2] = p[v * 3 + 2] + f * (z / n - p[v * 3 + 2]); }
    p = q; };
  for (let i = 0; i < iterations; i++) { step(0.5); step(-0.53); }
  return { pos: p, idx };
}
const meshOf = (g, mask, { blur = 2, smooth = 12, cell = 0.7 } = {}) => { const m = smoothMesh(surfaceNets(g, field(g, mask, blur)), smooth); return cell ? simplify(m, cell) : m; };

// seeded random + smooth 3D value noise (for organic irregularity)
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function noise3(seed, scale) {
  const r = rng(seed), waves = Array.from({ length: 6 }, (_, i) => { const d = [r() - 0.5, r() - 0.5, r() - 0.5], n = Math.hypot(...d); return { d: d.map(v => v / n), f: (1 + i * 0.6) / scale, p: r() * 6.283, a: 1 / (1 + i * 0.7) }; });
  const norm = waves.reduce((s, w) => s + w.a, 0);
  return (x, y, z) => waves.reduce((s, w) => s + w.a * Math.sin(6.283 * w.f * (x * w.d[0] + y * w.d[1] + z * w.d[2]) + w.p), 0) / norm;
}

// ------------------------------------------------------------------------------------------------ outputs
const out = [];                                   // { name, group, key, side, mesh (head cm), ...extra }
const add = (name, group, key, side, mesh, extra = {}) => { const b = bbox(mesh.pos); out.push({ name, group, key, side, mesh, center: b.center.map(v => +v.toFixed(3)), min: b.min, size: b.size, ...extra });
  console.log(`  ${name.padEnd(26)} ${String(mesh.idx.length / 3).padStart(6)} tris   size ${b.size.map(v => v.toFixed(1)).join(" x ")} cm`); };
const S = 0.5;                                    // voxel size, mm

// ================================================================================================ SINUSES
console.log("sinuses (reconstructed inside the real bones)");
const MAX = { R: "FMA53649", L: "FMA53650" }, sgn = { R: -1, L: 1 };

// ---- maxillary: the hollow of each cheekbone. In the dataset the maxilla is a compact solid with an open pocket
//      on its nose side; the real sinus fills that pocket plus the body of the bone. So: close the pocket (air that
//      is walled in sideways, above, below, in front and behind), add it to the bone, cap it at the side wall of
//      the nose, and hollow the result out to a 2 mm wall.
const lining = {};                                // name -> mesh of the air left when the lining is swollen
function rayHit(g, wall, axis, dir) {             // for every voxel: steps to the next wall voxel along one axis direction
  const [nx, ny, nz] = g.dims, n = [nx, ny, nz][axis], stride = [ny * nz, nz, 1][axis], out = new Uint16Array(wall.length).fill(65535);
  for (let v = 0; v < wall.length; v++) {
    const pos = Math.floor(v / stride) % n; if (dir > 0 ? pos !== n - 1 : pos !== 0) continue;      // start at the far end of each line
    let run = 65535;
    for (let q = 0, w = v; q < n; q++, w -= dir * stride) { run = wall[w] ? 0 : Math.min(65535, run + 1); out[w] = run; }
  }
  return out;
}
for (const side of ["R", "L"]) {
  const sx = sgn[side], zyg = side === "R" ? "FMA52892" : "FMA52893", pal = side === "R" ? "FMA53655" : "FMA53656";
  const g = makeGrid([side === "R" ? -52 : 8, -192, 1484], [side === "R" ? -8 : 52, -132, 1526], S);
  const max = vox(g, MAX[side]), wall = vox(g, [MAX[side], zyg, pal, "FMA52736", "FMA52740"]);
  const mm = v => Math.round(v / S);
  const lat = rayHit(g, wall, 0, sx), up = rayHit(g, wall, 2, 1), down = rayHit(g, wall, 2, -1), fwd = rayHit(g, wall, 1, -1), back = rayHit(g, wall, 1, 1);
  const body = new Uint8Array(max.length);
  each(g, (v, x, y, z) => {
    if (x * sx < 15.5 || x * sx > 40 || y < -182 || z < 1490 || z > 1520) return;
    if (max[v]) body[v] = 1;
    else if (!wall[v] && lat[v] < mm(34) && up[v] < mm(26) && down[v] < mm(26) && fwd[v] < mm(44) && back[v] < mm(44)) body[v] = 1;
  });
  const solid = morph(g, morph(g, body, 3, true), 3, false), d = insideDistance(g, solid);          // close small gaps, then measure wall depth
  const nz1 = noise3(side === "R" ? 11 : 12, 14);
  const pick = (wallMm, extra = 0) => { const core = new Uint8Array(max.length);
    each(g, (v, x, y, z) => { if (d[v] > wallMm + 0.5 * nz1(x, y, z) && z > 1491.5 + extra && z < 1519 - extra) core[v] = 1; });
    const deep = new Uint8Array(max.length); for (let v = 0; v < max.length; v++) deep[v] = core[v] && d[v] > wallMm + 1.8 ? 1 : 0;
    let grown = largest(g, deep);                 // drop thin bridges into the processes: keep what stays connected to the deep core
    for (let p = 0; p < 5; p++) { const n = morph(g, grown, 1, true); for (let v = 0; v < n.length; v++) n[v] = n[v] && core[v] ? 1 : 0; grown = n; }
    return grown; };
  add("maxillary_" + side, "sinus", "maxillary", side, toHead(meshOf(g, pick(2.0))));
  lining["maxillary_" + side] = toHead(meshOf(g, pick(4.6, 1)));
}

// ---- sphenoid: the hollow body of the sphenoid, two chambers split by an off-centre septum
{
  const m = stl("FMA52736"), g = makeGrid([-24, -140, 1506], [24, -98, 1546], S), bone = vox(g, m), d = insideDistance(g, bone);
  const nz1 = noise3(21, 12);
  const pick = wall => { const core = new Uint8Array(bone.length);
    each(g, (v, x, y, z) => { const sept = 2.4 + 0.12 * (y + 120) + 0.8 * Math.sin((z - 1515) / 6);     // the septum wanders off the midline
      const top = y < -128 ? 1537.5 : 1531.8;                                              // stay under the saddle that holds the pituitary
      if (d[v] > wall + 0.5 * nz1(x, y, z) && Math.abs(x + 0.6) < 13.5 && Math.abs(x - sept) > 0.7 && z > 1513.5 && z < top && y > -139.5 && y < -108.5) core[v] = 1; });
    return core; };
  const parts = (mask) => { const { labels, regions } = label(g, mask); return regions.slice(0, 2).map(r => { const o = new Uint8Array(mask.length); for (let v = 0; v < o.length; v++) o[v] = labels[v] === r.id ? 1 : 0; return { o, x: g.origin[0] + (r.min[0] + r.max[0]) / 2 * S }; }).sort((a, b) => a.x - b.x); };
  const cav = parts(pick(2.2)), lin = parts(pick(5.0));
  ["R", "L"].forEach((side, i) => { if (cav[i]) add("sphenoid_" + side, "sinus", "sphenoid", side, toHead(meshOf(g, cav[i].o))); if (lin[i]) lining["sphenoid_" + side] = toHead(meshOf(g, lin[i].o)); });
}

// ---- ethmoid: a honeycomb of small air cells in each side of the ethmoid bone (thin bony walls between them)
{
  const m = stl("FMA52740"), b = bbox(m.pos), g = makeGrid(b.min.map(v => v - 2), b.max.map(v => v + 2), 0.4), bone = vox(g, m), d = insideDistance(g, bone);
  const mid = -1.6;
  for (const side of ["R", "L"]) {
    const r = rng(side === "R" ? 31 : 32), seeds = [];
    for (let y = -168; y < -134; y += 7.2) for (let z = 1512; z < 1534; z += 6.8) {
      const big = 1 + 0.35 * (y + 168) / 34;                                              // cells get larger toward the back
      seeds.push([mid + sgn[side] * (7.5 + (r() - 0.5) * 3), y + (r() - 0.5) * 4.5, z + (r() - 0.5) * 4, big]);
    }
    const cells = new Uint8Array(bone.length);
    each(g, (v, x, y, z) => {
      if (d[v] < 0.9 || (x - mid) * sgn[side] < 2.6 || z < 1511.5) return;
      let d1 = 1e9, d2 = 1e9;
      for (const sd of seeds) { const q = Math.hypot((x - sd[0]) * 0.75, y - sd[1], z - sd[2]) / sd[3]; if (q < d1) { d2 = d1; d1 = q; } else if (q < d2) d2 = q; }
      if (d2 - d1 > 1.15) cells[v] = 1;                                                    // thin walls where two cells meet
    });
    const { labels, regions } = label(g, cells), keep = regions.filter(q => q.count * 0.4 ** 3 > 25);
    const all = new Uint8Array(bone.length); for (let v = 0; v < all.length; v++) all[v] = cells[v] && keep.some(q => q.id === labels[v]) ? 1 : 0;
    add("ethmoid_" + side, "sinus", "ethmoid", side, toHead(meshOf(g, all, { blur: 1, smooth: 8, cell: 0.7 })), { cells: keep.length });
  }
}

// ---- frontal: follows the real forehead bone. Each side is a fan of scalloped lobes behind the brow, 2 mm behind
//      the outer surface, deepest at the bottom; the two sides differ and the septum between them is off-centre.
{
  const g = makeGrid([-40, -190, 1536], [40, -150, 1584], S), bone = vox(g, "FMA52734"), [nx, ny, nz] = g.dims;
  const front = new Float32Array(nx * nz).fill(NaN);                                       // y of the outer surface for each (x, z) column
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) if (bone[(i * ny + j) * nz + k]) { front[i * nz + k] = g.origin[1] + j * S; break; }
  const LOBES = {   // [x, z, rx, rz] in mm, relative to the midline and the floor of the sinus (z0)
    R: [[-6, 9, 6, 10], [-13, 13, 7, 12.5], [-19.5, 9, 6, 8], [-8.5, 3.8, 7, 4.6]],
    L: [[5.5, 10.5, 6, 12.5], [13, 9.5, 7, 10], [19, 5.5, 5, 5.5], [8, 3.8, 7, 4.6]] };
  const z0 = 1541.5, septum = -1.3;
  for (const side of ["R", "L"]) {
    const nz1 = noise3(side === "R" ? 41 : 42, 9);
    const build = shrink => { const mask = new Uint8Array(bone.length);
      each(g, (v, x, y, z, i, j, k) => {
        if ((x - septum) * sgn[side] < 0.8 + shrink) return;
        const f = front[i * nz + k]; if (Number.isNaN(f)) return;
        let e = 0;                                                                        // how deep inside the union of lobes (0 = edge, 1 = centre)
        for (const [lx, lz, rx, rz] of LOBES[side]) { const q = 1 - Math.hypot((x - lx) / (rx - shrink), (z - z0 - lz) / (rz - shrink)); if (q > e) e = q; }
        if (e <= 0) return;
        const depth = (4.2 + 7.5 * Math.max(0, 1 - (z - z0) / 26)) * Math.sqrt(Math.min(1, e * 2.2)) * (1 + 0.18 * nz1(x, y, z)) - shrink * 1.6;
        const behind = y - f;                                                              // mm behind the outer surface (y grows toward the back)
        if (behind > 2.0 + shrink * 0.7 && behind < 2.0 + depth) mask[v] = 1;
      });
      return largest(g, mask); };
    add("frontal_" + side, "sinus", "frontal", side, toHead(meshOf(g, build(0))));
    lining["frontal_" + side] = toHead(meshOf(g, build(2.2)));
  }
}

// ---- mastoid air cells: small cells inside the mastoid part of each temporal bone
for (const side of ["R", "L"]) {
  const m = stl(side === "R" ? "FMA52738" : "FMA52739"), g = makeGrid([side === "R" ? -72 : 36, -100, 1484], [side === "R" ? -36 : 72, -58, 1520], S), bone = vox(g, m), d = insideDistance(g, bone);
  const r = rng(side === "R" ? 51 : 52), seeds = [];
  for (let i = 0; i < 260; i++) seeds.push([g.origin[0] + r() * 36, -100 + r() * 42, 1484 + r() * 36, 0.8 + r() * 0.5]);
  const cells = new Uint8Array(bone.length);
  each(g, (v, x, y, z) => { if (d[v] < 1.3 || z > 1516) return; let d1 = 1e9, d2 = 1e9;
    for (const sd of seeds) { const q = Math.hypot(x - sd[0], y - sd[1], z - sd[2]) / sd[3]; if (q < d1) { d2 = d1; d1 = q; } else if (q < d2) d2 = q; }
    if (d2 - d1 > 1.0) cells[v] = 1; });
  const { labels, regions } = label(g, cells), keep = new Set(regions.filter(q => q.count * S ** 3 > 6).map(q => q.id));
  const all = new Uint8Array(bone.length); for (let v = 0; v < all.length; v++) all[v] = cells[v] && keep.has(labels[v]) ? 1 : 0;
  add("mastoid_" + side, "sinus", "mastoid", side, toHead(meshOf(g, all, { blur: 1, smooth: 8, cell: 0.95 })), { cells: keep.size });
}

// ---- adenoids: a ridged pad of tissue on the roof of the space behind the nose, under the sphenoid body
{
  const g = makeGrid([-14, -134, 1496], [14, -104, 1520], S), bone = vox(g, ["FMA52736", "FMA52735", "FMA9710"]), [nx, ny, nz] = g.dims, mask = new Uint8Array(bone.length);
  const nz1 = noise3(61, 5);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    let roof = -1; for (let k = nz - 1; k >= 0; k--) if (bone[(i * ny + j) * nz + k]) roof = k; else if (roof >= 0) break;     // underside of the bone above
    if (roof < 0) continue;
    const x = g.origin[0] + (i + 0.5) * S, y = g.origin[1] + (j + 0.5) * S;
    const e = 1 - Math.hypot((x + 0.6) / 10.5, (y + 119) / 11); if (e <= 0) continue;
    const thick = 6.5 * Math.sqrt(e) * (0.72 + 0.28 * Math.cos(x * 1.9)) * (1 + 0.2 * nz1(x, y, 0));                             // lengthwise ridges
    for (let k = roof - 1; k >= 0 && (roof - k) * S < thick; k--) mask[(i * ny + j) * nz + k] = 1;
  }
  add("adenoids", "soft", "adenoids", "M", toHead(meshOf(g, largest(g, mask), { blur: 1, smooth: 10, cell: 0.6 })));
}
for (const [name, mesh] of Object.entries(lining)) if (mesh.idx.length) add(name + "_air", "lining", name.split("_")[0], name.split("_")[1], mesh);

// ================================================================================================ NOSE (real meshes)
console.log("nose (real BodyParts3D meshes)");
add("concha_inferior_R", "nose", "nasal", "R", simplify(toHead(stl("FMA54737")), 0.035), { part: "inferior turbinate" });
add("concha_inferior_L", "nose", "nasal", "L", simplify(toHead(stl("FMA54738")), 0.035), { part: "inferior turbinate" });
add("vomer", "nose", "nasal", "M", simplify(toHead(stl("FMA9710")), 0.035), { part: "septum" });
add("septal_cartilage", "nose", "nasal", "M", simplify(toHead(components(stl("FMA71704"))[0]), 0.04), { part: "septum" });
{ // the lower ethmoid: the middle turbinates and the thin plate that forms the top of the septum
  const m = stl("FMA52740"), b = bbox(m.pos), g = makeGrid(b.min.map(v => v - 2), b.max.map(v => v + 2), 0.4), bone = vox(g, m);
  const turb = { R: new Uint8Array(bone.length), L: new Uint8Array(bone.length) }, plate = new Uint8Array(bone.length);
  each(g, (v, x, y, z) => { if (!bone[v]) return; if (Math.abs(x + 1.6) < 1.5) plate[v] = 1; else if (z < 1519.5) turb[x < -1.6 ? "R" : "L"][v] = 1; });
  for (const side of ["R", "L"]) add("concha_middle_" + side, "nose", "nasal", side, toHead(meshOf(g, largest(g, turb[side]), { blur: 1, smooth: 6, cell: 0.8 })), { part: "middle turbinate" });
  add("ethmoid_plate", "nose", "nasal", "M", toHead(meshOf(g, largest(g, plate), { blur: 1, smooth: 6, cell: 0.9 })), { part: "septum" });
}

// ================================================================================================ TEETH (real meshes)
console.log("teeth (real BodyParts3D meshes; wisdom teeth copied from the second molars)");
const TEETH = { 11: "FMA55681", 12: "FMA55680", 13: "FMA55798", 14: "FMA55689", 15: "FMA55688", 16: "FMA55698", 17: "FMA55697",
                21: "FMA55682", 22: "FMA55683", 23: "FMA55799", 24: "FMA55690", 25: "FMA55691", 26: "FMA55699", 27: "FMA55700",
                31: "FMA57143", 32: "FMA57141", 33: "FMA55687", 34: "FMA55693", 35: "FMA55692", 36: "FMA55704", 37: "FMA55703",
                41: "FMA57142", 42: "FMA57140", 43: "FMA55686", 44: "FMA55694", 45: "FMA55695", 46: "FMA55705", 47: "FMA55706" };
const CROWN = [0.47, 0.45, 0.40, 0.39, 0.38, 0.38, 0.37, 0.37];        // share of the tooth's length that is crown, by tooth number 1..8
const tooth = {};
for (const [fdi, id] of Object.entries(TEETH)) tooth[fdi] = simplify(toHead(stl(id), +fdi > 30), 0.07);
for (const q of [1, 2, 3, 4]) {                                        // wisdom teeth: the second molar, moved one place back and a little smaller
  const a = tooth[q * 10 + 7], b6 = bbox(tooth[q * 10 + 6].pos).center, b7 = bbox(a.pos).center, step = b7.map((v, k) => (v - b6[k]) * 0.96), pos = new Float32Array(a.pos.length);
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] = b7[k] + (a.pos[i + k] - b7[k]) * 0.93 + step[k];
  tooth[q * 10 + 8] = { pos, idx: a.idx };
}
for (const fdi of Object.keys(tooth).map(Number).sort((a, b) => a - b)) {
  const m = tooth[fdi], upper = fdi < 30, n = m.pos.length / 3;
  // long axis by principal component analysis, pointing from the biting end to the root tip
  const c = [0, 0, 0]; for (let i = 0; i < m.pos.length; i += 3) for (let k = 0; k < 3; k++) c[k] += m.pos[i + k] / n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let i = 0; i < m.pos.length; i += 3) for (let a = 0; a < 3; a++) for (let b2 = 0; b2 < 3; b2++) C[a][b2] += (m.pos[i + a] - c[a]) * (m.pos[i + b2] - c[b2]);
  let ax = [0.1, 1, 0.1]; for (let it = 0; it < 60; it++) { const w = C.map(r => r[0] * ax[0] + r[1] * ax[1] + r[2] * ax[2]), l = Math.hypot(...w); ax = w.map(v => v / l); }
  if ((ax[1] > 0) !== upper) ax = ax.map(v => -v);                      // upper roots point up, lower roots point down
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < m.pos.length; i += 3) { const t = (m.pos[i] - c[0]) * ax[0] + (m.pos[i + 1] - c[1]) * ax[1] + (m.pos[i + 2] - c[2]) * ax[2]; if (t < lo) lo = t; if (t > hi) hi = t; }
  const tip = c.map((v, k) => v + ax[k] * lo);
  add("tooth_" + fdi, "teeth", String(fdi), upper ? "U" : "L", m, { fdi, upper, axis: ax.map(v => +v.toFixed(4)), tip: tip.map(v => +v.toFixed(3)), length: +(hi - lo).toFixed(3), crown: CROWN[(fdi % 10) - 1], real: fdi % 10 !== 8 });
}

// ================================================================================================ MUSCLE + SKULL
console.log("jaw muscle and skull");
add("masseter", "muscle", "masseter", "B", simplify(toHead(merge(["FMA49001", "FMA49002", "FMA49004", "FMA49005"].map(stl))), 0.16));
const SKULL = ["FMA52734", "FMA52736", "FMA52740", "FMA9710", "FMA53649", "FMA53650", "FMA53655", "FMA53656", "FMA53645", "FMA53646", "FMA53647", "FMA53648", "FMA52892", "FMA52893", "FMA52738", "FMA52739", "FMA52735", "FMA52788", "FMA52789"];
add("skull", "bone", "skull", "B", simplify(toHead(merge(SKULL.map(stl))), 0.3));
add("mandible", "bone", "mandible", "B", simplify(toHead(stl("FMA52748"), true), 0.3));
add("skin", "skin", "skin", "B", original("skin"));

// ================================================================================================ write
let bytes = 0; const chunks = [], meshes = [];
const pad = n => { const p = (n - (bytes % n)) % n; if (p) { chunks.push(Buffer.alloc(p)); bytes += p; } };
for (const o of out) {
  const { pos, idx } = o.mesh, nv = pos.length / 3, q = new Uint16Array(pos.length);
  for (let i = 0; i < pos.length; i++) q[i] = Math.round((pos[i] - o.min[i % 3]) / (o.size[i % 3] || 1) * 65535);
  pad(2); const offV = bytes; chunks.push(Buffer.from(q.buffer)); bytes += q.byteLength;
  const big = nv > 65535, ix = big ? idx : Uint16Array.from(idx);
  pad(big ? 4 : 2); const offI = bytes; chunks.push(Buffer.from(ix.buffer, ix.byteOffset, ix.byteLength)); bytes += ix.byteLength;
  const { mesh, ...rest } = o;
  meshes.push({ ...rest, min: o.min.map(v => +v.toFixed(4)), size: o.size.map(v => +v.toFixed(4)), nv, ni: idx.length, index32: big, offV, offI });
}
mkdirSync(join(root, "poc", "assets"), { recursive: true });
writeFileSync(join(root, "poc", "assets", "head.bin"), Buffer.concat(chunks));
writeFileSync(join(root, "poc", "assets", "head.json"), JSON.stringify({
  about: "Head anatomy for the Health Mirror, in head coordinates (cm; +x = person's left, +y = up, +z = forward).",
  source: "BodyParts3D, (c) The Database Center for Life Science, CC BY-SA 2.1 Japan. Teeth, nasal conchae, vomer, septal cartilage, masseter and skull are the dataset's real meshes (simplified). The sinuses are reconstructed inside those bones, not scanned.",
  fit: ORIG.fit, jawPivot: ORIG.jawPivot, meshes }, null, 1));
console.log(`wrote ${meshes.length} meshes, ${(bytes / 1048576).toFixed(2)} MB, ${out.reduce((s, o) => s + o.mesh.idx.length / 3, 0)} triangles`);
