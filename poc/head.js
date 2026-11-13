// Loads the head anatomy built by tools/build-anatomy.mjs (poc/assets/head.json + head.bin). The hand view loads
// poc/assets/hand.* (tools/build-hand.mjs) through the same function, by passing "hand" as the second argument.
// Head coordinates are MediaPipe's canonical face space in centimetres:
// +x = the person's LEFT, +y = up, +z = forward (out of the face).
import * as THREE from "three";

export async function loadHead(base = new URL("./assets/", import.meta.url), file = "head") {
  const [meta, buf] = await Promise.all([
    fetch(new URL(file + ".json", base)).then(r => r.json()),
    fetch(new URL(file + ".bin", base)).then(r => r.arrayBuffer()),
  ]);
  const info = new Map(meta.meshes.map(m => [m.name, m]));
  const raw = name => {                                   // { pos: Float32Array, idx: Uint32Array } in head coordinates
    const m = info.get(name); if (!m) throw new Error("no mesh named " + name);
    const q = new Uint16Array(buf, m.offV, m.nv * 3), pos = new Float32Array(m.nv * 3);
    for (let i = 0; i < q.length; i++) pos[i] = m.min[i % 3] + q[i] / 65535 * m.size[i % 3];
    const idx = m.index32 ? new Uint32Array(buf, m.offI, m.ni) : Uint32Array.from(new Uint16Array(buf, m.offI, m.ni));
    return { pos, idx };
  };
  // one BufferGeometry made of several meshes; `part` is an optional per-vertex number (the mesh's place in the list)
  const geometry = (names, { part = false } = {}) => {
    names = [].concat(names);
    const parts = names.map(raw), nv = parts.reduce((s, p) => s + p.pos.length / 3, 0), ni = parts.reduce((s, p) => s + p.idx.length, 0);
    const pos = new Float32Array(nv * 3), idx = new Uint32Array(ni), tag = part ? new Float32Array(nv) : null;
    let vo = 0, io = 0;
    parts.forEach((p, n) => { pos.set(p.pos, vo * 3); for (let i = 0; i < p.idx.length; i++) idx[io + i] = p.idx[i] + vo; if (tag) tag.fill(n, vo, vo + p.pos.length / 3); vo += p.pos.length / 3; io += p.idx.length; });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    if (tag) g.setAttribute("aPart", new THREE.BufferAttribute(tag, 1));
    g.computeVertexNormals();
    return g;
  };
  const names = filter => meta.meshes.filter(filter).map(m => m.name);
  return { meta, info, raw, geometry, names };
}
