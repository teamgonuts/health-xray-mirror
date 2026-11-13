// Pulls the BodyParts3D head meshes out of the original single-file app (../index.html)
// for the anatomy build (tools/build-anatomy.mjs uses the skin, the face-fit points and the jaw pivot,
// and tools/fit-transform.mjs uses the skull and jaw to line the BodyParts3D bones up with them).
//   node tools/extract-anatomy.mjs
// Writes tools/cache/original.json (metadata) and tools/cache/original.bin (quantised vertices + indices).
// The meshes are BodyParts3D, (c) The Database Center for Life Science, CC BY-SA 2.1 Japan.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const grab = id => {
  const m = html.match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) throw new Error("missing <script id=" + id + ">");
  return m[1].trim();
};
const meta = JSON.parse(grab("meshmeta"));
const bin = Buffer.from(grab("meshdata"), "base64");

const KEEP = ["skin", "cranium", "jaw", "eyes", "muscles"];
const parts = [], meshes = [];
let offset = 0;
for (const m of meta.meshes.filter(m => KEEP.includes(m.name))) {
  const v = bin.subarray(m.offV, m.offV + m.nv * 3 * 2);
  const i = bin.subarray(m.offI, m.offI + m.ni * 2);
  const offV = offset; parts.push(v); offset += v.length;
  const offI = offset; parts.push(i); offset += i.length;
  meshes.push({ name: m.name, nv: m.nv, ni: m.ni, min: m.min, size: m.size, offV, offI });
}
mkdirSync(join(root, "tools", "cache"), { recursive: true });
writeFileSync(join(root, "tools", "cache", "original.bin"), Buffer.concat(parts));
writeFileSync(join(root, "tools", "cache", "original.json"),
  JSON.stringify({ source: "BodyParts3D via MasterOfVFX2070/xray-mirror index.html", license: "CC BY-SA 2.1 JP",
                   meshes, jawPivot: meta.jawPivot, fit: meta.fit, labels: meta.labels }, null, 1));
console.log("wrote", meshes.map(m => m.name).join(", "), "-", offset, "bytes");
