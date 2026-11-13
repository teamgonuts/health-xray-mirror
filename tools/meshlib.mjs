// Small mesh utilities for the anatomy build scripts (no dependencies).
import { readFileSync } from "node:fs";

// binary STL -> welded indexed mesh { pos: Float32Array, idx: Uint32Array }
export function loadSTL(path) {
  const buf = readFileSync(path);
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 !== buf.length) throw new Error("not a binary STL: " + path);
  const map = new Map(), pos = [], idx = new Uint32Array(n * 3);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12;
    for (let k = 0; k < 3; k++) {
      const x = buf.readFloatLE(o), y = buf.readFloatLE(o + 4), z = buf.readFloatLE(o + 8); o += 12;
      const key = x + "," + y + "," + z;
      let i = map.get(key);
      if (i === undefined) { i = pos.length / 3; map.set(key, i); pos.push(x, y, z); }
      idx[t * 3 + k] = i;
    }
    o += 2;
  }
  return { pos: new Float32Array(pos), idx };
}

export function bbox(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max, size: max.map((v, k) => v - min[k]), center: max.map((v, k) => (v + min[k]) / 2) };
}

// signed volume (positive when triangles wind outward)
export function volume({ pos, idx }) {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
       - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
       + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v / 6;
}

// split into connected components (by shared vertices)
export function components({ pos, idx }) {
  const nv = pos.length / 3, parent = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let t = 0; t < idx.length; t += 3) { const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]); if (b !== a) parent[b] = a; if (c !== a) parent[find(c)] = a; }
  const groups = new Map();
  for (let t = 0; t < idx.length; t += 3) { const r = find(idx[t]); let g = groups.get(r); if (!g) groups.set(r, g = []); g.push(t); }
  const out = [];
  for (const tris of groups.values()) {
    const remap = new Map(), p = [], ix = new Uint32Array(tris.length * 3);
    tris.forEach((t, j) => { for (let k = 0; k < 3; k++) { const v = idx[t + k]; let m = remap.get(v); if (m === undefined) { m = p.length / 3; remap.set(v, m); p.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); } ix[j * 3 + k] = m; } });
    out.push({ pos: new Float32Array(p), idx: ix });
  }
  return out.sort((a, b) => b.idx.length - a.idx.length);
}

export function merge(meshes) {
  const nv = meshes.reduce((s, m) => s + m.pos.length, 0), ni = meshes.reduce((s, m) => s + m.idx.length, 0);
  const pos = new Float32Array(nv), idx = new Uint32Array(ni); let vo = 0, io = 0;
  for (const m of meshes) { pos.set(m.pos, vo); for (let i = 0; i < m.idx.length; i++) idx[io + i] = m.idx[i] + vo / 3; vo += m.pos.length; io += m.idx.length; }
  return { pos, idx };
}

// apply a 3x4 affine [m00..m02, tx; ...] given as { A: [9 numbers row-major], t: [3] }
export function transform({ pos, idx }, { A, t }) {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = A[0] * x + A[1] * y + A[2] * z + t[0];
    out[i + 1] = A[3] * x + A[4] * y + A[5] * z + t[1];
    out[i + 2] = A[6] * x + A[7] * y + A[8] * z + t[2];
  }
  const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
  let ix = idx;
  if (det < 0) { ix = new Uint32Array(idx.length); for (let k = 0; k < idx.length; k += 3) { ix[k] = idx[k]; ix[k + 1] = idx[k + 2]; ix[k + 2] = idx[k + 1]; } }   // keep winding outward after a mirror
  return { pos: out, idx: ix };
}

// Vertex-clustering simplification: snap vertices to a grid of the given cell size and drop collapsed triangles.
export function simplify({ pos, idx }, cell) {
  const map = new Map(), sum = [], cnt = [], remap = new Uint32Array(pos.length / 3);
  for (let i = 0; i < pos.length; i += 3) {
    const key = Math.round(pos[i] / cell) + "," + Math.round(pos[i + 1] / cell) + "," + Math.round(pos[i + 2] / cell);
    let j = map.get(key);
    if (j === undefined) { j = cnt.length; map.set(key, j); sum.push(0, 0, 0); cnt.push(0); }
    sum[j * 3] += pos[i]; sum[j * 3 + 1] += pos[i + 1]; sum[j * 3 + 2] += pos[i + 2]; cnt[j]++; remap[i / 3] = j;
  }
  const p = new Float32Array(cnt.length * 3);
  for (let j = 0; j < cnt.length; j++) { p[j * 3] = sum[j * 3] / cnt[j]; p[j * 3 + 1] = sum[j * 3 + 1] / cnt[j]; p[j * 3 + 2] = sum[j * 3 + 2] / cnt[j]; }
  // Keep every triangle that still has an area, including ones that now coincide with another: where two faces of
  // a thin wall collapse onto each other they face opposite ways and cancel out, so the mesh stays closed (the slice
  // look counts faces to find the inside of a shape, and a dropped face would leave a hole in that count).
  const out = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    out.push(a, b, c);
  }
  return { pos: p, idx: new Uint32Array(out) };
}

// ---- voxel helpers -------------------------------------------------------------------------------------------
// Solid voxelisation of a closed (or nearly closed) mesh by parity counting along x, on a grid
// { origin: [x,y,z], size: voxel edge, dims: [nx,ny,nz] }. Returns Uint8Array (1 = inside).
export function voxelize({ pos, idx }, grid, out = new Uint8Array(grid.dims[0] * grid.dims[1] * grid.dims[2])) {
  const [nx, ny, nz] = grid.dims, s = grid.size, [ox, oy, oz] = grid.origin;
  const hits = new Map();                                   // (j,k) -> sorted x crossings
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ay = pos[a + 1], az = pos[a + 2], by = pos[b + 1], bz = pos[b + 2], cy = pos[c + 1], cz = pos[c + 2];
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - oy) / s - 0.5)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - oy) / s - 0.5));
    const k0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) - oz) / s - 0.5)), k1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - oz) / s - 0.5));
    const d = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    if (Math.abs(d) < 1e-12) continue;
    for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const py = oy + (j + 0.5) * s + 1e-5, pz = oz + (k + 0.5) * s + 2e-5;      // tiny offsets avoid hitting edges exactly
      const u = ((py - ay) * (cz - az) - (pz - az) * (cy - ay)) / d, v = ((by - ay) * (pz - az) - (bz - az) * (py - ay)) / d;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const x = pos[a] + u * (pos[b] - pos[a]) + v * (pos[c] - pos[a]);
      const key = j * nz + k; let h = hits.get(key); if (!h) hits.set(key, h = []); h.push(x);
    }
  }
  for (const [key, h] of hits) {
    h.sort((p, q) => p - q);
    const j = Math.floor(key / nz), k = key % nz;
    for (let m = 0; m + 1 < h.length; m += 2) {
      const i0 = Math.max(0, Math.ceil((h[m] - ox) / s - 0.5)), i1 = Math.min(nx - 1, Math.floor((h[m + 1] - ox) / s - 0.5));
      for (let i = i0; i <= i1; i++) out[(i * ny + j) * nz + k] = 1;
    }
  }
  return out;
}

// 6-connected flood fill over voxels where pass(index) is true, starting from the given seed indices. Returns Uint8Array mask.
export function flood(grid, seeds, pass) {
  const [nx, ny, nz] = grid.dims, mask = new Uint8Array(nx * ny * nz), stack = [];
  for (const s of seeds) if (pass(s) && !mask[s]) { mask[s] = 1; stack.push(s); }
  while (stack.length) {
    const v = stack.pop(), k = v % nz, j = ((v - k) / nz) % ny, i = (v - k - j * nz) / (ny * nz);
    const tryv = n => { if (!mask[n] && pass(n)) { mask[n] = 1; stack.push(n); } };
    if (i > 0) tryv(v - ny * nz); if (i < nx - 1) tryv(v + ny * nz);
    if (j > 0) tryv(v - nz); if (j < ny - 1) tryv(v + nz);
    if (k > 0) tryv(v - 1); if (k < nz - 1) tryv(v + 1);
  }
  return mask;
}

// grow (dilate) or shrink (erode) a voxel mask by r voxels (6-neighbourhood, r passes)
export function morph(grid, mask, r, grow = true) {
  const [nx, ny, nz] = grid.dims; let cur = mask;
  for (let p = 0; p < r; p++) {
    const nxt = new Uint8Array(cur.length);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      const v = (i * ny + j) * nz + k, c = cur[v];
      const nb = (i > 0 && cur[v - ny * nz]) + (i < nx - 1 && cur[v + ny * nz]) + (j > 0 && cur[v - nz]) + (j < ny - 1 && cur[v + nz]) + (k > 0 && cur[v - 1]) + (k < nz - 1 && cur[v + 1]);
      const edge = (i === 0 || i === nx - 1 || j === 0 || j === ny - 1 || k === 0 || k === nz - 1);
      nxt[v] = grow ? (c || nb > 0 ? 1 : 0) : (c && nb === 6 && !edge ? 1 : 0);
    }
    cur = nxt;
  }
  return cur;
}

// label 6-connected regions of a mask; returns { labels: Int32Array (0 = none), regions: [{ id, count, min, max }] }
export function label(grid, mask) {
  const [nx, ny, nz] = grid.dims, labels = new Int32Array(mask.length), regions = [];
  for (let v0 = 0; v0 < mask.length; v0++) {
    if (!mask[v0] || labels[v0]) continue;
    const id = regions.length + 1, r = { id, count: 0, min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] }, stack = [v0]; labels[v0] = id;
    while (stack.length) {
      const v = stack.pop(), k = v % nz, j = ((v - k) / nz) % ny, i = (v - k - j * nz) / (ny * nz);
      r.count++; if (i < r.min[0]) r.min[0] = i; if (j < r.min[1]) r.min[1] = j; if (k < r.min[2]) r.min[2] = k; if (i > r.max[0]) r.max[0] = i; if (j > r.max[1]) r.max[1] = j; if (k > r.max[2]) r.max[2] = k;
      const tryv = n => { if (mask[n] && !labels[n]) { labels[n] = id; stack.push(n); } };
      if (i > 0) tryv(v - ny * nz); if (i < nx - 1) tryv(v + ny * nz);
      if (j > 0) tryv(v - nz); if (j < ny - 1) tryv(v + nz);
      if (k > 0) tryv(v - 1); if (k < nz - 1) tryv(v + 1);
    }
    regions.push(r);
  }
  return { labels, regions: regions.sort((a, b) => b.count - a.count) };
}
