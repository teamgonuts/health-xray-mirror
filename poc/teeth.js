// The teeth view: the 28 real tooth meshes from BodyParts3D (plus wisdom teeth copied from the second molars),
// merged into one mesh per arch so the whole mouth is two draw calls. Each tooth's look comes from small uniform
// arrays, so changing the date, the selection or the focused arch never rebuilds geometry.
// FDI numbering: quadrant 1 upper right, 2 upper left, 3 lower left, 4 lower right; tooth 1 = central incisor ... 8 = wisdom.
import * as THREE from "three";

export const TOOTH_NAMES = ["central incisor", "lateral incisor", "canine", "first premolar", "second premolar", "first molar", "second molar", "wisdom tooth"];
export const QUAD_NAMES = { 1: "upper right", 2: "upper left", 3: "lower left", 4: "lower right" };
export const toothName = fdi => `${QUAD_NAMES[Math.floor(fdi / 10)]} ${TOOTH_NAMES[(fdi % 10) - 1]}`;
export const TOOTH_LOOKS = { clean: "Clean", records: "Records only", xray: "X-ray" };
// teeth in the order you meet them going around each arch, as you see yourself in a mirror (your right on the right)
export const ARCH_ORDER = { upper: [28, 27, 26, 25, 24, 23, 22, 21, 11, 12, 13, 14, 15, 16, 17, 18], lower: [38, 37, 36, 35, 34, 33, 32, 31, 41, 42, 43, 44, 45, 46, 47, 48] };

const VERT = `
attribute float aTooth, aU, aR, aB, aM;
uniform vec4 uA[32]; uniform vec4 uB[32]; uniform vec4 uC[32];
uniform float uOrtho;
varying vec3 vN; varying vec3 vV; varying vec4 vA; varying vec4 vB; varying vec4 vC; varying float vU, vR, vBu, vM;
void main() {
  int i = int(aTooth + 0.5);
  vA = uA[i]; vB = uB[i]; vC = uC[i]; vU = aU; vR = aR; vBu = aB; vM = aM;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = uOrtho > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform float uLook;      // 0 = solid teeth, 1 = x-ray glow
varying vec3 vN; varying vec3 vV; varying vec4 vA; varying vec4 vB; varying vec4 vC; varying float vU, vR, vBu, vM;
const vec3 FILLING = vec3(0.30, 0.78, 1.0), CHIP = vec3(1.0, 0.55, 0.12), NECK = vec3(1.0, 0.45, 0.78), ROOT = vec3(0.86, 0.74, 0.58);
void main() {
  float emph = vA.a;                                   // 0 hidden, 0.3 faded, 1 normal, 2 selected
  if (emph < 0.05) discard;
  float crown = vC.x; bool isRoot = vU > crown;
  bool ghost = vB.w > 0.5;                             // tooth that has been removed
  vec3 n = normalize(vN); float ndv = abs(dot(n, normalize(vV)));
  // what the record says about this tooth, painted where it is
  float bite = 1.0 - smoothstep(crown * 0.34, crown * 0.5, vU);
  // a filling: the middle of the biting surface, running over one edge (two surfaces) or both edges (three surfaces)
  float edge = (1.0 - smoothstep(crown * 0.42, crown * 0.58, vU)) * smoothstep(0.62, 0.86, vB.x > 2.5 ? abs(vM) : vM);
  float filling = vB.x > 0.5 ? max(bite * (1.0 - smoothstep(0.5, 0.64, vR)), edge) : 0.0;
  float chip = vB.y > 0.5 ? (1.0 - smoothstep(crown * 0.3, crown * 0.48, vU)) * smoothstep(0.1, 0.45, vBu) : 0.0;
  float neck = vB.z > 0.5 ? 1.0 - smoothstep(0.0, crown * 0.11, abs(vU - crown * 0.93)) : 0.0;
  if (uLook > 0.5) {                                   // x-ray glow: every tooth with its root, like a dental film
    if (ghost && mod(floor(gl_FragCoord.x * 0.5) + floor(gl_FragCoord.y * 0.5), 2.0) < 0.5) discard;
    float rim = pow(1.0 - ndv, 1.9);
    vec3 c = mix(vec3(0.82, 0.90, 1.0), vA.rgb, 0.55);
    c = mix(c, FILLING * 1.6, filling); c = mix(c, CHIP * 1.6, chip); c = mix(c, NECK * 1.5, neck);
    float a = (0.05 + 0.95 * rim + 0.6 * max(filling, max(chip, neck))) * (ghost ? 0.35 : 1.0) * min(emph, 1.3) * (isRoot ? 0.7 : 1.0);
    gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
    return;
  }
  if (isRoot && vC.y < 0.5) discard;                   // roots stay hidden in the gum unless this tooth is opened up
  if (ghost) {                                         // removed teeth: a stippled ghost
    if (mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 3.0) > 0.5) discard;
    gl_FragColor = vec4(vec3(0.55, 0.62, 0.80) * (0.5 + 0.5 * (1.0 - ndv)), 1.0); return;
  }
  if (emph < 0.6 && mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) > 0.5) discard;   // faded teeth are see-through
  vec3 base = isRoot ? ROOT : vA.rgb;
  if (!isRoot) { base = mix(base, FILLING, filling * 0.95); base = mix(base, CHIP, chip); base = mix(base, NECK, neck * 0.9); }
  vec3 fn = gl_FrontFacing ? n : -n;
  // light from the camera side (upper and lower teeth both face it), plus a soft fill from above and below
  float d = max(dot(fn, normalize(vec3(0.15, 0.25, 0.95))), 0.0), d2 = max(dot(fn, normalize(vec3(-0.4, 0.8, 0.3))), 0.0), d3 = max(dot(fn, normalize(vec3(0.3, -0.8, 0.4))), 0.0);
  vec3 col = base * (0.42 + 0.50 * d + 0.14 * d2 + 0.12 * d3);
  col *= mix(0.5, 1.0, smoothstep(0.0, 0.42, ndv));    // dark edges keep neighbouring teeth apart
  col += pow(max(dot(reflect(-normalize(vec3(0.15, 0.25, 0.95)), fn), normalize(vV)), 0.0), 28.0) * 0.18 * (isRoot ? 0.0 : 1.0);
  if (emph > 1.5) col = col * 1.12 + 0.06;
  else if (emph < 0.6) col = mix(vec3(dot(col, vec3(0.33))), col, 0.35) * 0.55;
  else if (emph < 0.95) col *= 0.62;                   // the other teeth step back when one is selected
  gl_FragColor = vec4(col, 1.0);
}`;

export function buildTeeth(head, { ortho = false } = {}) {
  const info = head.meta.meshes.filter(m => m.group === "teeth").sort((a, b) => a.fdi - b.fdi);
  const slot = Object.fromEntries(info.map((m, i) => [m.fdi, i]));           // fdi -> index into the uniform arrays
  const uA = info.map(() => new THREE.Vector4(1, 1, 1, 1)), uB = info.map(() => new THREE.Vector4()), uC = info.map(m => new THREE.Vector4(m.crown, 0, 0, 0));
  const material = new THREE.ShaderMaterial({ uniforms: { uA: { value: uA }, uB: { value: uB }, uC: { value: uC }, uLook: { value: 0 }, uOrtho: { value: ortho ? 1 : 0 } },
    vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, transparent: true });      // "transparent" only so renderOrder puts it after the veil
  const teeth = {};
  const arch = upper => {
    const list = info.filter(m => m.upper === upper), raws = list.map(m => head.raw(m.name));
    const nv = raws.reduce((s, r) => s + r.pos.length / 3, 0), ni = raws.reduce((s, r) => s + r.idx.length, 0);
    const pos = new Float32Array(nv * 3), idx = new Uint32Array(ni), aTooth = new Float32Array(nv), aU = new Float32Array(nv), aR = new Float32Array(nv), aB = new Float32Array(nv), aM = new Float32Array(nv);
    const midZ = list.reduce((s, m) => s + m.tip[2], 0) / list.length;           // middle of the arch, for "which way is the cheek side"
    let vo = 0, io = 0;
    list.forEach((m, n) => {
      const r = raws[n], cnt = r.pos.length / 3, ax = new THREE.Vector3(...m.axis), tip = new THREE.Vector3(...m.tip);
      const out = new THREE.Vector3(tip.x, 0, tip.z - midZ + 1.2); out.addScaledVector(ax, -out.dot(ax)).normalize();        // toward the lip or cheek
      const along = new THREE.Vector3().crossVectors(ax, out).normalize();                                                    // along the arch
      const p = new THREE.Vector3(), rad = new THREE.Vector3(); let rmax = 1e-6;
      for (let i = 0; i < cnt; i++) { p.fromArray(r.pos, i * 3).sub(tip); const u = p.dot(ax) / m.length; rad.copy(p).addScaledVector(ax, -p.dot(ax));
        const rr = rad.length(); if (u < m.crown && rr > rmax) rmax = rr;
        aU[vo + i] = u; aR[vo + i] = rr; aB[vo + i] = rr > 1e-6 ? rad.dot(out) / rr : 0; aM[vo + i] = rr > 1e-6 ? rad.dot(along) / rr : 0; }
      for (let i = 0; i < cnt; i++) aR[vo + i] /= rmax;
      pos.set(r.pos, vo * 3); aTooth.fill(slot[m.fdi], vo, vo + cnt);
      for (let i = 0; i < r.idx.length; i++) idx[io + i] = r.idx[i] + vo;
      teeth[m.fdi] = { fdi: m.fdi, name: toothName(m.fdi), upper, tip, center: new THREE.Vector3(...m.center),
                       face: tip.clone().addScaledVector(ax, m.length * m.crown * 0.5).addScaledVector(out, 0.35), real: m.real };
      vo += cnt; io += r.idx.length;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    for (const [k, a] of Object.entries({ aTooth, aU, aR, aB, aM })) g.setAttribute(k, new THREE.BufferAttribute(a, 1));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, material); mesh.frustumCulled = false; return mesh;
  };
  const upper = arch(true), lower = arch(false);

  // ------------------------------------------------------------ records + styling
  let recs = {}, asOf = "9999", selected = null, focus = "all", look = "clean";
  const IVORY = [1.0, 0.97, 0.9];
  const state = fdi => {                       // the tooth's state on the "as of" date
    const ev = (recs[fdi] || []).filter(e => e.date <= asOf), st = { extracted: false, filled: 0, chipped: false, sensitive: false, planned: false, events: ev };
    for (const e of ev) {
      if (e.type === "extracted") st.extracted = true;
      if (e.type === "filling") { st.filled = Math.max(st.filled, e.surfaces || 2); st.chipped = false; }   // a later filling repairs a chip
      if (e.type === "chipped") st.chipped = true;
      if (e.type === "sensitive") st.sensitive = true;
      if (e.type === "planned") st.planned = true;
    }
    return st;
  };
  function style() {
    for (const m of info) {
      const i = slot[m.fdi], st = state(m.fdi), sel = selected === m.fdi, treated = st.filled || st.chipped || st.sensitive;
      const inFocus = focus === "all" || (focus === "upper") === m.upper;
      let emph = sel ? 2 : !inFocus ? (look === "xray" ? 0.25 : 0.3) : selected !== null ? 0.85 : 1;
      if (look === "records" && !treated && !st.extracted && !sel) emph = Math.min(emph, 0.3);
      const c = st.chipped ? [1.0, 0.84, 0.62] : treated ? [0.84, 0.95, 1.0] : IVORY;
      uA[i].set(c[0], c[1], c[2], emph);
      uB[i].set(st.extracted ? 0 : st.filled, !st.extracted && st.chipped ? 1 : 0, !st.extracted && st.sensitive ? 1 : 0, st.extracted ? 1 : 0);
      uC[i].set(m.crown, sel && !st.extracted ? 1 : 0, 0, 0);
    }
    const xr = look === "xray";
    material.uniforms.uLook.value = xr ? 1 : 0;
    if (material.depthTest === xr) { material.blending = xr ? THREE.AdditiveBlending : THREE.NormalBlending; material.depthTest = material.depthWrite = !xr; material.needsUpdate = true; }
  }
  style();
  return {
    upper, lower, teeth, state,
    setRecords(r) { recs = r || {}; style(); },
    setAsOf(d) { asOf = d; style(); },
    select(fdi) { selected = fdi === null || fdi === undefined || fdi === "" ? null : +fdi; style(); },
    setFocus(f) { focus = f; style(); },
    setLook(l) { look = l; style(); },
  };
}
