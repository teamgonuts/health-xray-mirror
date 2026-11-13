// Finds the affine transform from BodyParts3D coordinates (mm; +x = left, -y = front, +z = up) to the head
// coordinates used by the app (cm; +x = left, +y = up, +z = front), by fitting the original bones onto the
// simplified skull and jaw meshes that the original X-Ray Mirror ships (tools/cache/original.*, made by
// tools/extract-anatomy.mjs).
//   node tools/fit-transform.mjs      -> writes tools/cache/transform.json
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSTL, merge, bbox } from "./meshlib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stl = id => loadSTL(join(root, "tools", "cache", "bp3d", id + ".stl"));
const meta = JSON.parse(readFileSync(join(root, "tools", "cache", "original.json"), "utf8"));
const bin = readFileSync(join(root, "tools", "cache", "original.bin"));
const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length);
function appMesh(name) {
  const m = meta.meshes.find(m => m.name === name), q = new Uint16Array(ab, m.offV, m.nv * 3), pos = new Float32Array(m.nv * 3);
  for (let i = 0; i < q.length; i++) pos[i] = m.min[i % 3] + q[i] / 65535 * m.size[i % 3];
  return pos;
}

// nearest-neighbour search with a hash grid
function makeGrid(pts, cell) {
  const map = new Map();
  for (let i = 0; i < pts.length; i += 3) { const k = Math.floor(pts[i] / cell) + "," + Math.floor(pts[i + 1] / cell) + "," + Math.floor(pts[i + 2] / cell); let a = map.get(k); if (!a) map.set(k, a = []); a.push(i); }
  return (x, y, z) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell); let best = -1, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const a = map.get((cx + dx) + "," + (cy + dy) + "," + (cz + dz)); if (!a) continue;
      for (const i of a) { const d = (pts[i] - x) ** 2 + (pts[i + 1] - y) ** 2 + (pts[i + 2] - z) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    return [best, Math.sqrt(bd)];
  };
}
const apply = (T, p, i) => [T.A[0] * p[i] + T.A[1] * p[i + 1] + T.A[2] * p[i + 2] + T.t[0], T.A[3] * p[i] + T.A[4] * p[i + 1] + T.A[5] * p[i + 2] + T.t[1], T.A[6] * p[i] + T.A[7] * p[i + 1] + T.A[8] * p[i + 2] + T.t[2]];

// solve a 4x4 linear system (Gaussian elimination)
function solve4(M, b) {
  const a = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 4; c++) { let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r; [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 4; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k < 5; k++) a[r][k] -= f * a[c][k]; } }
  return a.map((r, i) => r[4] / r[i]);
}

function fit(name, src, dst) {            // src: BodyParts3D points (mm), dst: app points (cm)
  const sb = bbox(src), db = bbox(dst);
  // start: axis swap + mm -> cm, centred on the bounding boxes
  let T = { A: [0.1, 0, 0, 0, 0, 0.1, 0, -0.1, 0], t: [0, 0, 0] };
  const c0 = apply(T, sb.center, 0); T.t = [db.center[0] - c0[0], db.center[1] - c0[1], db.center[2] - c0[2]];
  let rms = 0, kept = 0;
  for (let it = 0; it < 40; it++) {
    const moved = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) { const p = apply(T, src, i); moved[i] = p[0]; moved[i + 1] = p[1]; moved[i + 2] = p[2]; }
    const near = makeGrid(moved, it < 8 ? 1.2 : 0.5);
    const pairs = [];
    for (let j = 0; j < dst.length; j += 3) { const [i, d] = near(dst[j], dst[j + 1], dst[j + 2]); if (i >= 0) pairs.push([i, j, d]); }
    pairs.sort((a, b) => a[2] - b[2]);
    const use = pairs.slice(0, Math.floor(pairs.length * 0.85));          // drop the worst matches (parts missing on one side)
    rms = Math.sqrt(use.reduce((s, p) => s + p[2] * p[2], 0) / use.length); kept = use.length;
    // least squares for each output coordinate: dst = A * src + t
    const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], B = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (const [i, j] of use) {
      const v = [src[i] - sb.center[0], src[i + 1] - sb.center[1], src[i + 2] - sb.center[2], 1];
      for (let r = 0; r < 4; r++) { for (let c = 0; c < 4; c++) M[r][c] += v[r] * v[c]; for (let o = 0; o < 3; o++) B[o][r] += v[r] * dst[j + o]; }
    }
    const rows = B.map(b => solve4(M.map(r => [...r]), b));
    const A = [...rows[0].slice(0, 3), ...rows[1].slice(0, 3), ...rows[2].slice(0, 3)];
    T = { A, t: rows.map((r, o) => r[3] - (A[o * 3] * sb.center[0] + A[o * 3 + 1] * sb.center[1] + A[o * 3 + 2] * sb.center[2])) };
  }
  console.log(`${name}: rms ${(rms * 10).toFixed(2)} mm over ${kept} points`);
  console.log("   A =", T.A.map(v => v.toFixed(5)).join(" "), "\n   t =", T.t.map(v => v.toFixed(4)).join(" "));
  return { ...T, rmsMm: +(rms * 10).toFixed(3) };
}

const SKULL = ["FMA52734", "FMA52736", "FMA52740", "FMA9710", "FMA53649", "FMA53650", "FMA53655", "FMA53656", "FMA54737", "FMA54738", "FMA53645", "FMA53646",
               "FMA53647", "FMA53648", "FMA52892", "FMA52893", "FMA52738", "FMA52739", "FMA52735", "FMA52788", "FMA52789"];
const UPPER_TEETH = ["FMA55680", "FMA55681", "FMA55682", "FMA55683", "FMA55688", "FMA55689", "FMA55690", "FMA55691", "FMA55697", "FMA55698", "FMA55699", "FMA55700", "FMA55798", "FMA55799"];
const LOWER_TEETH = ["FMA55686", "FMA55687", "FMA55692", "FMA55693", "FMA55694", "FMA55695", "FMA55703", "FMA55704", "FMA55705", "FMA55706", "FMA57140", "FMA57141", "FMA57142", "FMA57143"];
const skull = fit("skull", merge([...SKULL, ...UPPER_TEETH].map(stl)).pos, appMesh("cranium"));
const jaw = fit("jaw", merge(["FMA52748", ...LOWER_TEETH].map(stl)).pos, appMesh("jaw"));
writeFileSync(join(root, "tools", "cache", "transform.json"), JSON.stringify({ skull, jaw }, null, 1));
