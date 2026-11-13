// Health Mirror, Hand X-ray view: the bones of the hand and wrist hung on the live hand, in the look of the original
// X-Ray Mirror, with example injuries that can be switched on and off next to the real X-ray of such an injury.
//
// A frame is made the same way as in the face views (poc/app.js): camera frame -> tracking worker -> the result and
// that same frame come back together -> one WebGL canvas draws the frame as its background and the bones on top.
// Bones: poc/assets/hand.* (tools/build-hand.mjs). Injuries and X-rays: poc/hand-cases.json, poc/assets/hand-xrays/.
import * as THREE from "three";
import { loadHead } from "./head.js";
import { makeMat, setStyle } from "./gfx.js";
import { createTracker } from "./tracker.js";

const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const DEMO = q.has("demo"), STILL = q.has("still");
const stage = $("stage"), video = $("video");
const setStatus = (t, c) => { $("status").textContent = t; $("status").className = c || ""; };

// ------------------------------------------------------------------ data and settings
const [hand, CASEFILE, CREDITS] = await Promise.all([loadHead(undefined, "hand"),
  fetch(new URL("./hand-cases.json", import.meta.url), { cache: "no-cache" }).then(r => r.json()),
  fetch(new URL("./assets/hand-xrays/credits.json", import.meta.url)).then(r => r.json())]);
const CASES = CASEFILE.cases, XR = new URL("./assets/hand-xrays/", import.meta.url);

// One injury at a time, or none (the normal hand). last is the injury Space flips back to.
const byId = id => CASES.find(c => c.id === id) || null;
const S = { pick: null, last: CASES[0].id, dim: 0.9, names: false, look: "glow", showspeed: false };
try { const o = JSON.parse(localStorage.getItem("hm_hand2") || "{}"); for (const k in S) if (k in o) S[k] = o[k]; } catch (e) {}
// URL: ?pick=wrist | knuckle | finger | none (?on= means the same) &look=solid &names &perf
{ const want = q.get("pick") ?? q.get("on"); if (want !== null) S.pick = want.split(",")[0]; }
if (q.has("look")) S.look = q.get("look"); if (q.has("names")) S.names = true; if (q.has("perf")) S.showspeed = true;
if (!byId(S.pick)) S.pick = null; if (!byId(S.last)) S.last = CASES[0].id;
if (S.pick) S.last = S.pick;
if (!["glow", "solid"].includes(S.look)) S.look = "glow";
const save = () => { try { localStorage.setItem("hm_hand2", JSON.stringify(S)); } catch (e) {} };
const current = () => byId(S.pick);

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ canvas: $("gl"), alpha: false, antialias: true, powerPreference: "high-performance" });
const gl = renderer.getContext();
const gpuName = (() => { const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : ""; })();
const SOFTWARE = q.has("software") || /Basic Render|SwiftShader|llvmpipe|Software/i.test(gpuName);   // no graphics chip: everything is drawn on the CPU
const QUALITY = q.has("quality") ? +q.get("quality") : SOFTWARE ? 0.6 : 1;
$("slow").hidden = !SOFTWARE;
renderer.setClearColor(0x070a11, 1); renderer.autoClear = false;
const scene = new THREE.Scene(), bgScene = new THREE.Scene(), bgCam = new THREE.Camera();
let W = 640, H = 480, dirty = true;
// Stage pixels, like the original: x to the right of the camera picture, y up, z toward the camera. The canvas is
// mirrored with CSS, so on screen a point (x, y) sits at (W - x, H - y).
const cam = new THREE.OrthographicCamera(0, W, H, 0, -8000, 8000);

const bgTex = new THREE.Texture(); bgTex.minFilter = bgTex.magFilter = THREE.LinearFilter; bgTex.generateMipmaps = false;
const bgMat = new THREE.ShaderMaterial({ uniforms: { uTex: { value: bgTex } }, depthTest: false, depthWrite: false,
  vertexShader: `varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `uniform sampler2D uTex; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(uTex, vec2(vUv.x, 1.0 - vUv.y)).rgb, 1.0); }` });
const bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat); bgQuad.frustumCulled = false; bgQuad.visible = false; bgScene.add(bgQuad);

// ------------------------------------------------------------------ the hand rigs
const INFO = hand.meta.meshes, GEO = Object.fromEntries(INFO.map(m => [m.name, hand.geometry(m.name)]));
const V = a => new THREE.Vector3(a[0], a[1], a[2]), rad = d => d * Math.PI / 180;
const palmB = new THREE.Matrix4(); { const r = hand.meta.palmB; palmB.set(r[0][0], r[0][1], r[0][2], 0, r[1][0], r[1][1], r[1][2], 0, r[2][0], r[2][1], r[2][2], 0, 0, 0, 0, 1); }
const radius = hand.info.get("radius"), ulna = hand.info.get("ulna");
const FOREARM = [V(radius.p1).add(V(ulna.p1)).multiplyScalar(0.5), V(radius.p0).add(V(ulna.p0)).multiplyScalar(0.5)];   // wrist end, elbow end (palm frame)

// Where a bone is cut and how the loose piece moves, worked out once in the bone's own coordinates (see hand-cases.json).
function prepBreak(b, c) {
  const info = hand.info.get(b.mesh); if (!info) throw new Error("hand-cases.json names an unknown bone: " + b.mesh);
  const u = info.unit, p0 = V(info.p0), p1 = V(info.p1), ax = p1.clone().sub(p0).normalize(), up = V(info.up), side = V(info.side);
  const mix = v => ax.clone().multiplyScalar(v[0]).addScaledVector(up, v[1]).addScaledVector(side, v[2]);
  const fromStart = b.fromEnd !== undefined ? p0.distanceTo(p1) * u - b.fromEnd : b.fromStart;       // mm from the wrist end
  const at = p0.clone().addScaledVector(ax, fromStart / u);
  const through = b.through ? at.clone().add(mix(b.through).multiplyScalar(1 / u)) : at;
  const n = mix(b.normal || [1, 0, 0]).normalize(), w = n.dot(through);
  // the break is a ragged line, not a clean saw cut: teeth run across the bone (as seen from the front or back of the hand)
  const across = side.clone().addScaledVector(n, -side.dot(n)).normalize().multiplyScalar(u / (b.tooth ?? 3));
  const pivot = b.pivot === "start" ? p0 : b.pivot === "end" ? p1 : at;
  const R = new THREE.Matrix4().makeRotationAxis(ax.clone().cross(up).normalize(), rad(b.tiltUp || 0))
    .multiply(new THREE.Matrix4().makeRotationAxis(ax.clone().cross(side).normalize(), rad(b.tiltSide || 0)));
  const sh = mix(b.shift || [0, 0, 0]).multiplyScalar(1 / u);
  const T = new THREE.Matrix4().makeTranslation(sh.x + pivot.x, sh.y + pivot.y, sh.z + pivot.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  return { mesh: b.mesh, label: b.label, at, n, w, T, c, first: b === c.breaks[0], moveNear: b.move === "near",
           gap: (b.gap ?? 1.3) / u / 2, jag: new THREE.Vector4(across.x, across.y, across.z, (b.jag ?? 1.4) / u) };
}
for (const c of CASES) c.prepared = c.breaks.map(b => prepBreak(b, c));

const BONE = { color: 0xd9f0ff, fill: 0x9bb6d6, solid: 0xe9e2cf };
const VEIL_FRAG = `
uniform vec2 uP[21]; uniform vec2 uA; uniform vec2 uB; uniform float uR, uRw, uOpacity, uFeather;
varying vec2 vPos;
float seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0); return length(pa - ba * h); }
void main() {
  float d = seg(vPos, uA, uB) - uRw;                                   // forearm
  for (int f = 0; f < 5; f++) for (int k = 0; k < 3; k++) { int i = 1 + f * 4 + k; d = min(d, seg(vPos, uP[i], uP[i + 1]) - uR); }
  const int IDX[7] = int[7](0, 1, 2, 5, 9, 13, 17);                    // the palm outline
  float dp = 1.0e6; bool inside = false;
  for (int i = 0; i < 7; i++) { vec2 a = uP[IDX[i]], b = uP[IDX[(i + 6) % 7]]; dp = min(dp, seg(vPos, a, b));
    if (((a.y > vPos.y) != (b.y > vPos.y)) && (vPos.x < (b.x - a.x) * (vPos.y - a.y) / (b.y - a.y) + a.x)) inside = !inside; }
  d = min(d, (inside ? -dp : dp) - uR * 1.5);                         // the palm is wider than the knuckle points
  gl_FragColor = vec4(0.016, 0.027, 0.051, uOpacity * (1.0 - smoothstep(-uFeather, uFeather, d)));
}`;
function makeRig() {
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  // the dark shape that hides the real hand and wrist so the bones read clearly (one quad, shaped in the shader)
  const veil = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uP: { value: Array.from({ length: 21 }, () => new THREE.Vector2()) }, uA: { value: new THREE.Vector2() }, uB: { value: new THREE.Vector2() },
                uR: { value: 10 }, uRw: { value: 20 }, uOpacity: { value: 0.9 }, uFeather: { value: 6 } },
    vertexShader: `varying vec2 vPos; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vPos = w.xy; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: VEIL_FRAG }));
  veil.frustumCulled = false; veil.renderOrder = -10; group.add(veil);
  const parts = INFO.map(info => {
    const mk = () => { const m = new THREE.Mesh(GEO[info.name], makeMat({ color: BONE.color, fill: BONE.fill, ortho: true })); m.matrixAutoUpdate = false; m.frustumCulled = false; m.renderOrder = 2; group.add(m); return m; };
    const far = mk(); far.visible = false;                              // the broken-off piece; only shown while this bone is broken
    return { info, mesh: mk(), far, base: new THREE.Matrix4(), brk: null };
  });
  return { group, veil, parts, byName: Object.fromEntries(parts.map(p => [p.info.name, p])), pts: null, right: true, lostAt: 0, a: new THREE.Vector3(), b: new THREE.Vector3() };
}
const rigs = [makeRig(), makeRig()];

// which bones are broken right now, and how every bone is drawn
function applyCases() {
  const solid = S.look === "solid", breaks = new Map(), c = current();
  if (c) for (const b of c.prepared) breaks.set(b.mesh, b);
  for (const rig of rigs) for (const p of rig.parts) {
    const b = p.brk = breaks.get(p.info.name) || null;
    // Both pieces of a broken bone keep the normal bone colour. What shows the break is the break itself: a dark,
    // ragged gap whose two edges glow in the injury's colour, and the loose piece sitting out of line.
    for (const m of [p.mesh, p.far]) {
      if (solid) setStyle(m.material, { color: 0xffffff, fill: BONE.solid, gain: 1, opacity: 1, mode: 1, cutColor: 0x7a2f22 });
      else setStyle(m.material, { color: BONE.color, fill: BONE.fill, gain: 1.05, opacity: 1, fillAmt: 0.07, rimPow: 1.9, mode: 0 });
      const u = m.material.uniforms, far = m === p.far;
      if (b) {      // the near piece keeps everything on the wrist side of the break, the far piece everything beyond it
        const k = far ? -1 : 1; u.uCut.value.set(k * b.n.x, k * b.n.y, k * b.n.z, k * b.w - b.gap);
        u.uJag.value.copy(b.jag); u.uJag.value.w *= k; u.uEdge.value = 1.1 / p.info.unit; u.uEdgeColor.value.set(b.c.color).lerp(WHITE, 0.25);
      } else { u.uCut.value.set(0, 0, 1, 999); u.uJag.value.w = 0; u.uEdge.value = 0; }
    }
    p.far.visible = !!b; setBase(p, p.base);
  }
  for (const rig of rigs) rig.veil.material.uniforms.uOpacity.value = S.dim;
  dirty = true;
}
const WHITE = new THREE.Color(0xffffff);
function setBase(p, m) {
  if (m !== p.base) p.base.copy(m);
  // the piece on the hand's side of a break stays on the hand; the other one is moved out of line
  const moved = p.brk ? (p.brk.moveNear ? p.mesh : p.far) : null;
  for (const x of p.brk ? [p.mesh, p.far] : [p.mesh]) { if (x === moved) x.matrix.multiplyMatrices(p.base, p.brk.T); else x.matrix.copy(p.base); x.matrixWorldNeedsUpdate = true; }
}

const tmpV = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), e3 = new THREE.Vector3(), vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
const palmM = new THREE.Matrix4(), hm = new THREE.Matrix4();
// lms: 63 numbers (x, y, z of the 21 tracked points, as fractions of the picture). Same placement rules as the original app.
function updateHand(rig, lms, isRight) {
  if (!rig.pts) rig.pts = Array.from({ length: 21 }, () => new THREE.Vector3());
  const fresh = !rig.group.visible || rig.right !== isRight, P = rig.pts, sign = isRight ? 1 : -1;
  for (let i = 0; i < 21; i++) { tmpV.set(lms[i * 3] * W, (1 - lms[i * 3 + 1]) * H, -lms[i * 3 + 2] * W); if (fresh) P[i].copy(tmpV); else P[i].lerp(tmpV, 0.65); }
  rig.right = isRight;
  // the palm block follows wrist, index knuckle and little-finger knuckle
  e1.subVectors(P[5], P[0]); e2.subVectors(P[17], P[0]);
  e3.crossVectors(e1, e2).normalize().multiplyScalar(sign * Math.sqrt(e1.length() * e2.length()));
  palmM.makeBasis(e1, e2, e3).setPosition(P[0]).multiply(palmB);
  // every finger bone spans two tracked points; its roll comes from the line across the knuckles
  vC.subVectors(P[17], P[5]).normalize();
  for (const p of rig.parts) {
    if (p.info.group === "palm") { setBase(p, palmM); continue; }
    const { a, b } = p.info;
    vA.subVectors(P[b], P[a]); let len = vA.length(); if (len < 1e-6) len = 1e-6; vA.divideScalar(len);
    vB.copy(vC).addScaledVector(vA, -vC.dot(vA)); if (vB.lengthSq() < 1e-6) vB.set(1, 0, 0); vB.normalize();
    e3.crossVectors(vA, vB).multiplyScalar(sign);
    const L = len * (b % 4 === 0 ? 0.8 : 1);                            // fingertip points sit past the end of the bone
    hm.makeBasis(e1.copy(vA).multiplyScalar(L), e2.copy(vB).multiplyScalar(L), e3.multiplyScalar(L)).setPosition(P[a]);
    setBase(p, hm);
  }
  // the veil: one quad around hand and forearm
  const u = rig.veil.material.uniforms, d = Math.hypot(P[5].x - P[17].x, P[5].y - P[17].y) || 1;
  rig.a.copy(FOREARM[0]).applyMatrix4(palmM); rig.b.copy(FOREARM[1]).applyMatrix4(palmM);
  let x0 = Math.min(rig.a.x, rig.b.x), x1 = Math.max(rig.a.x, rig.b.x), y0 = Math.min(rig.a.y, rig.b.y), y1 = Math.max(rig.a.y, rig.b.y);
  for (let i = 0; i < 21; i++) { u.uP.value[i].set(P[i].x, P[i].y); x0 = Math.min(x0, P[i].x); x1 = Math.max(x1, P[i].x); y0 = Math.min(y0, P[i].y); y1 = Math.max(y1, P[i].y); }
  u.uA.value.set(rig.a.x, rig.a.y); u.uB.value.set(rig.b.x, rig.b.y); u.uR.value = d * 0.2; u.uRw.value = d * 0.64; u.uFeather.value = Math.max(2, d * 0.07);
  const pad = d * 0.6; rig.veil.position.set((x0 + x1) / 2, (y0 + y1) / 2, -4000); rig.veil.scale.set(x1 - x0 + pad * 2, y1 - y0 + pad * 2, 1);
  rig.group.visible = true; rig.lostAt = 0;
}

function resize() {
  const r = stage.getBoundingClientRect();
  W = Math.max(2, Math.round(r.width)); H = Math.max(2, Math.round(r.height));
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5) * QUALITY); renderer.setSize(W, H, false);
  cam.right = W; cam.top = H; cam.updateProjectionMatrix();
  $("hud").width = W; $("hud").height = H;
  dirty = true;
}

// ------------------------------------------------------------------ side panel
$("cases").innerHTML = [`<button class="case" role="radio" data-c=""><b><i style="background:#d9f0ff"></i>Normal hand<kbd>0</kbd></b><small>No injury: the bones as they should be</small></button>`,
  ...CASES.map((c, i) => `<button class="case" role="radio" data-c="${c.id}"><b><i style="background:${c.color}"></i>${c.name}<kbd>${i + 1}</kbd></b><small>${c.term}</small></button>`)].join("");
for (const b of $("cases").children) b.onclick = () => pickCase(b.dataset.c || null);
function pickCase(id) { S.pick = byId(id) ? id : null; if (S.pick) S.last = S.pick; save(); syncUI(); }
// Space: straight from the injury to the normal hand and back, to compare
function flip() { pickCase(S.pick ? null : S.last); }
$("flip").onclick = flip;
for (const b of $("look").children) b.onclick = () => { S.look = b.dataset.k; save(); syncUI(); };
$("dim").oninput = e => { S.dim = +e.target.value; save(); applyCases(); };
$("names").onchange = e => { S.names = e.target.checked; save(); syncUI(); };
$("showspeed").onchange = e => { S.showspeed = e.target.checked; save(); syncUI(); };
const credit = f => { const c = CREDITS[f]; return c ? `${c.author}, ${c.licence}` : ""; };
$("credits").innerHTML = Object.entries(CREDITS).filter(([f]) => CASES.some(c => c.xray === f || c.normal === f))
  .map(([f, c]) => `<li><a href="${c.page}" target="_blank" rel="noopener">${c.title.replace(/\.[a-z]+$/i, "")}</a>, ${c.author}, ${c.licence}${c.change ? ". " + c.change : ""}</li>`).join("");
addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" && e.target.type === "range") return;
  if (e.key === " " || e.code === "Space") { e.preventDefault(); flip(); }
  const n = "123456789".indexOf(e.key); if (n >= 0 && CASES[n]) pickCase(CASES[n].id);
  if (e.key === "0") pickCase(null);
  if (e.key === "Escape") { if (!$("big").hidden) $("big").hidden = true; else pickCase(null); }
});

// ------------------------------------------------------------------ the real X-rays: normal next to broken
// Show one part of an X-ray in its frame (view = [left, top, right, bottom] as fractions of the picture). cover: that
// part fills the frame; otherwise all of that part is visible and the frame shows what is around it as well.
// Returns where the picture ended up, so the rings around the break can be laid over it.
function fitView(img, view, flipped, cover) {
  const fig = img.parentElement, bw = fig.clientWidth, bh = fig.clientHeight, nw = img.naturalWidth, nh = img.naturalHeight; if (!nw || !bw || !bh) return null;
  let [x0, y0, x1, y1] = view || [0, 0, 1, 1]; if (flipped) [x0, x1] = [1 - x1, 1 - x0];
  const k = (cover ? Math.max : Math.min)(bw / ((x1 - x0) * nw), bh / ((y1 - y0) * nh)), w = nw * k, h = nh * k;
  const pos = (frame, size, centre) => size <= frame ? (frame - size) / 2 : Math.min(0, Math.max(frame - size, frame / 2 - centre * size));
  const left = pos(bw, w, (x0 + x1) / 2), top = pos(bh, h, (y0 + y1) / 2);
  Object.assign(img.style, { width: w + "px", height: h + "px", left: left + "px", top: top + "px", transform: flipped ? "scaleX(-1)" : "" });
  return { w, h, left, top };
}
// lay out one normal/broken pair: the small card on the picture ("x") or the enlarged one ("b")
function placePair(pre) {
  const c = current(); if (!c) return;
  fitView($(pre + "imgN"), c.normalView, c.normalFlip, pre === "x");
  const f = fitView($(pre + "imgB"), c.view, false, pre === "x"); if (!f) return;
  $(pre + "marks").innerHTML = (c.marks || []).map(([x, y, r]) => `<i class="mark" style="left:${(f.left + (x - r) * f.w).toFixed(1)}px;top:${(f.top + y * f.h - r * f.w).toFixed(1)}px;width:${(2 * r * f.w).toFixed(1)}px;height:${(2 * r * f.w).toFixed(1)}px;--c:${c.color}"></i>`).join("");
}
for (const pre of ["x", "b"]) for (const k of ["imgN", "imgB"]) $(pre + k).onload = () => placePair(pre);
new ResizeObserver(() => { placePair("x"); if (!$("big").hidden) placePair("b"); }).observe(stage);
// click the card to see both pictures large
$("xcard").onclick = () => { const c = current(); if (!c) return; $("big").hidden = false; $("bimgN").src = new URL(c.normal, XR); $("bimgB").src = new URL(c.xray, XR);
  $("bigcap").textContent = `${c.name}: ${c.xrayNote} Broken: ${credit(c.xray)}. Normal${c.normalFlip ? " (mirrored to match)" : ""}: ${credit(c.normal)}. Click to close.`; placePair("b"); };
$("big").onclick = () => { $("big").hidden = true; };

function syncUI() {
  const c = current();
  for (const b of $("cases").children) { const on = (b.dataset.c || null) === S.pick; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); }
  $("flip").textContent = c ? "Back to the normal hand" : `Show the ${byId(S.last).name.toLowerCase()} again`;
  for (const b of $("look").children) b.classList.toggle("on", b.dataset.k === S.look);
  $("dim").value = S.dim; $("names").checked = S.names; $("showspeed").checked = S.showspeed; $("speed").hidden = !S.showspeed;
  // the real X-rays on the picture
  $("xcard").hidden = !c; if (!c) $("big").hidden = true;
  if (c) {
    for (const [id, file] of [["ximgN", c.normal], ["ximgB", c.xray]]) { const url = String(new URL(file, XR)); if ($(id).src !== url) $(id).src = url; }
    $("xcap").innerHTML = `<b>${c.name}.</b> ${c.xrayNote} Click to enlarge.`;
    placePair("x");
  }
  $("hcard").innerHTML = c
    ? `<h4>${c.name}</h4><p class="where">${c.term}</p><p>${c.what}</p><h5>What the X-ray shows</h5><ul>${c.shows.map(t => `<li>${t}</li>`).join("")}</ul><h5>On your hand</h5><p>${c.onHand}</p>
       <p class="src">X-ray: ${credit(c.xray)}. Normal X-ray: ${credit(c.normal)}.</p>`
    : `<h4>Your normal hand</h4><p class="where">27 bones in the hand, plus the ends of the two forearm bones</p>
       <p>Hold your hand up with the fingers spread. Each finger has three bones (the thumb two), each standing on a long bone in the palm; eight small bones make up the wrist, and they sit on the radius and the ulna.</p>
       <p>Pick an injury above, or press 1, 2 or 3, to see that break on your own hand next to the real X-ray. Space flips between the injury and the normal hand.</p>`;
  $("hint").textContent = c ? "Space: back to the normal hand · the close-up shows the break" : "Hold your hand up, fingers spread · 1 2 3 pick an injury";
  applyCases();
}

// ------------------------------------------------------------------ heads-up layer: break markers and bone names
const hud = $("hud").getContext("2d"), FONT = "system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
const scr = v => ({ x: W - v.x, y: H - v.y });
// a label on a dark plate (the camera picture behind it can be bright), with a line to the thing it names
function label(g, text, sub, ax, ay, tx, ty, color, align, big) {
  const f1 = `${big ? 700 : 600} ${big ? 15 : 12.5}px ${FONT}`, f2 = `500 12px ${FONT}`, padX = 8, h = sub ? 39 : 22;
  g.font = f1; let w = g.measureText(text).width; if (sub) { g.font = f2; w = Math.max(w, g.measureText(sub).width); }
  if (align === "right") tx = Math.max(tx, w + padX + 6); else tx = Math.min(tx, W - w - padX - 6);
  ty = Math.max(15, Math.min(H - h - 2, ty));
  g.strokeStyle = color; g.globalAlpha = 0.9; g.lineWidth = 1.3; g.beginPath(); g.moveTo(ax, ay); g.lineTo(align === "right" ? tx + padX : tx - padX, ty); g.stroke(); g.globalAlpha = 1;
  g.fillStyle = "rgba(9,12,19,.86)"; g.beginPath(); g.roundRect(align === "right" ? tx - w - padX : tx - padX, ty - 11, w + padX * 2, h, 7); g.fill();
  g.textAlign = align; g.textBaseline = "middle"; g.font = f1; g.fillStyle = color; g.fillText(text, tx, ty);
  if (sub) { g.font = f2; g.fillStyle = "#dfe6f5"; g.fillText(sub, tx, ty + 17); }
}
const NAMES = [["b_11_12", "Distal phalanx"], ["b_10_11", "Middle phalanx"], ["b_9_10", "Proximal phalanx"], ["mc3", "Metacarpal"], ["carpals", "Carpal bones (wrist)"], ["radius", "Radius"], ["ulna", "Ulna"]];
let handSide = "right";                                                  // which half of the picture the hand is in
// The close-up: the bones around the break drawn a second time, enlarged, in a square below the X-rays.
const lensCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -8000, 8000), lens = { on: false, x: 0, y: 0, s: 0, c: new THREE.Vector3(), r: 1, from: null };
function layout() {
  const seen = rigs.filter(r => r.group.visible), c = current(); lens.on = false;
  if (!seen.length) return seen;
  let cx = 0; for (const r of seen) cx += scr(r.pts[9]).x / seen.length;
  handSide = cx > W / 2 ? "right" : "left";
  $("xcard").classList.toggle("right", handSide === "left");             // the X-rays go on the other side
  if (!c) return seen;
  const rig = seen[0], p = rig.byName[c.prepared[0].mesh]; if (!p.brk) return seen;
  lens.c.set(0, 0, 0); for (const b of c.prepared) lens.c.add(tmpV.copy(b.at).applyMatrix4(rig.byName[b.mesh].base)); lens.c.multiplyScalar(1 / c.prepared.length);
  lens.r = (c.lens || 30) * tmpV.setFromMatrixColumn(p.base, 0).length() / p.info.unit;      // millimetres -> pixels on this hand
  const card = $("xcard"), below = card.hidden ? 12 : card.offsetTop + card.offsetHeight + 10;
  const foot = 48;                                                       // room for the hint along the bottom edge
  lens.s = Math.round(Math.min(W * 0.3, H - below - foot, 320)); if (lens.s < 90) return seen;
  lens.x = handSide === "right" ? 12 : W - 12 - lens.s; lens.y = H - foot - lens.s; lens.from = scr(lens.c); lens.on = true;
  return seen;
}
function drawLens() {
  if (!lens.on) return;
  lensCam.left = lens.c.x - lens.r; lensCam.right = lens.c.x + lens.r; lensCam.bottom = lens.c.y - lens.r; lensCam.top = lens.c.y + lens.r; lensCam.updateProjectionMatrix();
  const vx = W - lens.x - lens.s, vy = H - lens.y - lens.s;               // the canvas is mirrored, and WebGL counts from the bottom
  renderer.setViewport(vx, vy, lens.s, lens.s); renderer.setScissor(vx, vy, lens.s, lens.s); renderer.setScissorTest(true);
  renderer.setClearColor(0x04070d, 1); renderer.clear(); renderer.render(scene, lensCam);
  renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H); renderer.setClearColor(0x070a11, 1);
}
function drawHud(now, seen) {
  const g = hud; g.clearRect(0, 0, W, H);
  if (!seen.length) return;
  const pulse = 0.5 + 0.5 * Math.sin(now / 260), c = current();
  for (const rig of seen) {
    let lo = 1e9, hi = -1e9; for (const p of rig.pts) { const x = W - p.x; if (x < lo) lo = x; if (x > hi) hi = x; }
    const out = handSide === "right" ? Math.min(W - 12, hi + 26) : Math.max(12, lo - 26), align = handSide === "right" ? "left" : "right";
    const items = [];
    for (const p of rig.parts) if (p.brk) { const s = scr(tmpV.copy(p.brk.at).applyMatrix4(p.base)); items.push(p.brk.first ? { ...s, text: p.brk.c.name, sub: p.brk.label, color: p.brk.c.color, big: true, ring: true } : { ...s, text: p.brk.label, color: p.brk.c.color, ring: true }); }
    if (S.names) for (const [name, text] of NAMES) { const p = rig.byName[name], i = p.info; if (p.brk) continue;
      const s = scr(tmpV.set((i.p0[0] + i.p1[0]) / 2, (i.p0[1] + i.p1[1]) / 2, (i.p0[2] + i.p1[2]) / 2).applyMatrix4(p.base)); items.push({ ...s, text, color: "#d9f0ff" }); }
    items.sort((a, b) => a.y - b.y); let prev = -1e9;
    for (const it of items) { it.ty = Math.max(it.y, prev + 27); prev = it.ty + (it.sub ? 17 : 0); }
    for (const it of items) {
      if (it.ring) { g.strokeStyle = it.color; g.lineWidth = 2; g.globalAlpha = 0.55 + 0.45 * pulse; g.beginPath(); g.arc(it.x, it.y, 15 + 4 * pulse, 0, 6.3); g.stroke(); g.globalAlpha = 1; }
      else { g.fillStyle = it.color; g.beginPath(); g.arc(it.x, it.y, 2.5, 0, 6.3); g.fill(); }
      label(g, it.text, it.sub, it.x, it.y, out, it.ty, it.color, align, it.big);
    }
  }
  if (lens.on && c) {                                                     // frame and caption of the close-up, and a line to where it is on the hand
    const { x, y, s } = lens, ex = Math.max(x, Math.min(x + s, lens.from.x)), ey = Math.max(y, Math.min(y + s, lens.from.y));
    g.strokeStyle = c.color; g.globalAlpha = 0.55; g.lineWidth = 1.2; g.setLineDash([5, 5]); g.beginPath(); g.moveTo(lens.from.x, lens.from.y); g.lineTo(ex, ey); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    g.lineWidth = 2; g.beginPath(); g.roundRect(x, y, s, s, 10); g.stroke();
    g.font = `700 11.5px ${FONT}`; g.textAlign = "left"; g.textBaseline = "middle"; const t = "CLOSE-UP ON YOUR HAND", tw = g.measureText(t).width;
    g.fillStyle = "rgba(9,12,19,.86)"; g.beginPath(); g.roundRect(x + 7, y + 7, tw + 14, 20, 10); g.fill(); g.fillStyle = c.color; g.fillText(t, x + 14, y + 17.5);
  }
}

// ------------------------------------------------------------------ drawing loop
const perf = { frames: 0, results: 0, at: performance.now(), fps: 0, tps: 0, drawMs: 0 };
function draw(now) {
  const t0 = performance.now();
  const seen = layout();
  renderer.clear(); renderer.render(bgScene, bgCam); renderer.render(scene, cam);
  drawLens(); drawHud(now, seen);
  perf.frames++; perf.drawMs += (performance.now() - t0 - perf.drawMs) * 0.1;
}
function loop(now) {
  requestAnimationFrame(loop);
  if (dirty) { dirty = false; draw(now); }                           // nothing changed, nothing drawn (the camera sets the pace)
  if (now - perf.at >= 1000) {
    perf.fps = Math.round(perf.frames * 1000 / (now - perf.at)); perf.tps = Math.round(perf.results * 1000 / (now - perf.at)); perf.frames = perf.results = 0; perf.at = now;
    if (S.showspeed) $("speed").textContent = tracker ? `Tracking ${perf.tps} times a second (${tracker.stats.ms.toFixed(0)} ms each, ${tracker.stats.delegate === "GPU" ? "graphics chip" : "processor"}${tracker.stats.mode === "main" ? ", main thread" : ""}) · drawing ${perf.fps} frames a second`
                                                      : `Drawing ${perf.fps} frames a second`;
  }
}
new ResizeObserver(resize).observe(stage); resize();

// ------------------------------------------------------------------ camera + tracker
let tracker = null, shownFrame = null, said = "";
const say = (t, c) => { if (said !== t) { said = t; setStatus(t, c); } };
function place(hands) {
  // one rig for the right hand and one for the left, so a hand keeps its rig from frame to frame
  const now = performance.now(), used = [false, false];
  for (const h of hands.slice(0, 2)) { let k = h.right ? 0 : 1; if (used[k]) k = 1 - k; used[k] = true; updateHand(rigs[k], h.lms, h.right); }
  rigs.forEach((r, k) => { if (!used[k] && r.group.visible) { if (!r.lostAt) r.lostAt = now; if (now - r.lostAt > 200) r.group.visible = false; } });
  const n = rigs.filter(r => r.group.visible).length, c = current();
  say(n ? (c ? `Tracking your hand. Showing a ${c.name.toLowerCase()}.` : "Tracking your hand. Showing your normal bones.")
        : "No hand found. Hold your hand up to the camera, fingers spread.", n ? "ok" : "bad");
  $("hint").hidden = !n;
  perf.results++; dirty = true;
}
function onResult(r) {
  if (shownFrame) shownFrame.close();                         // the previous frame is already on the graphics card
  shownFrame = r.bitmap; bgTex.image = shownFrame; bgTex.needsUpdate = true; bgQuad.visible = true;
  place(r.hands || []);
}

// Built-in test scene (?demo): the dataset's own hand, turning slowly, no camera. ?demo=2 adds a left hand.
// &still freezes it; &yaw= &pitch= &roll= set the pose (radians).
function demoLoop() {
  $("intro").hidden = true;
  const rest = hand.meta.rest.map(V), f = rest[9].clone().normalize(), z = new THREE.Vector3(0, 0, 1); z.addScaledVector(f, -z.dot(f)).normalize();
  const x = f.clone().cross(z), M = new THREE.Matrix4().set(x.x, x.y, x.z, 0, f.x, f.y, f.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1);   // fingers up, palm toward the camera
  const num = k => q.has(k) ? +q.get(k) : null, yaw0 = num("yaw"), pitch0 = num("pitch"), roll0 = num("roll"), two = q.get("demo") === "2";
  const R = new THREE.Matrix4(), v = new THREE.Vector3(), a = new Float32Array(63), b = new Float32Array(63);
  function tick() {
    if (!STILL) requestAnimationFrame(tick);
    const t = STILL ? 1.2 : performance.now() / 1000, s = H * 0.0026;
    R.makeRotationFromEuler(new THREE.Euler(pitch0 ?? 0.12 * Math.sin(t * 0.5), yaw0 ?? 0.9 * Math.sin(t * 0.45), roll0 ?? 0.08 * Math.sin(t * 0.3), "YXZ")).multiply(M);
    const ox = two ? W * 0.3 : W * 0.38, oy = H * 0.4;
    rest.forEach((p, i) => { v.copy(p).applyMatrix4(R).multiplyScalar(s); a[i * 3] = (ox + v.x) / W; a[i * 3 + 1] = 1 - (oy + v.y) / H; a[i * 3 + 2] = -v.z / W;
      b[i * 3] = 1 - a[i * 3] + 0.02; b[i * 3 + 1] = a[i * 3 + 1]; b[i * 3 + 2] = a[i * 3 + 2]; });
    place(two ? [{ lms: a, right: true }, { lms: b, right: false }] : [{ lms: a, right: true }]);
  }
  if (STILL) { tick(); tick(); new ResizeObserver(() => { tick(); }).observe(stage); } else tick();
}

$("start").onclick = async () => {
  $("start").disabled = true;
  let what = "camera";
  try {
    if (q.get("video")) {                                            // test clip instead of the webcam: ?video=<url>
      video.crossOrigin = "anonymous"; video.src = q.get("video"); video.loop = true; await video.play();
    } else {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("this browser will not give this page a camera. Try Chrome or Edge.");
      setStatus("Asking for the camera…");
      video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
      await video.play();
    }
    if (video.videoWidth && video.videoHeight) stage.style.setProperty("--ar", (video.videoWidth / video.videoHeight).toFixed(4));
    $("intro").hidden = true;
    what = "hand tracker"; setStatus("Loading the hand tracker (first time takes a few seconds)…");
    tracker = await createTracker({ video, onResult, mode: "hand", software: SOFTWARE, forceMain: q.has("mainthread"), delegate: q.get("delegate"), scale: q.has("tscale") ? +q.get("tscale") : null });
    resize(); tracker.start();
  } catch (err) {
    $("start").disabled = false; $("intro").hidden = false;
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    setStatus(denied ? "Camera blocked. Allow camera access for this page and click Start again." : `Could not load the ${what}: ${err.message || err}`, "bad");
  }
};

syncUI();
$("start").disabled = false; $("start").textContent = "Start camera"; setStatus("Click Start camera, then hold your hand up.");
requestAnimationFrame(loop);
if (DEMO) { setStatus("Demo scene (no camera).", "ok"); demoLoop(); }
// Self-test, as in the face views: ?autostart presses Start; ?report=N posts N speed samples (2 s apart) to the dev
// server (tools/cache/report.jsonl), then turns the camera off and closes the tab.
if (q.has("autostart") && !DEMO) $("start").click();
if (q.has("report")) {
  let left = +q.get("report") || 5, waited = 0;
  const iv = setInterval(async () => {
    if (!tracker && !DEMO && ++waited < 30) return;                 // still loading the camera or tracker
    const sample = { at: new Date().toISOString(), tag: q.get("tag") || "", view: "hand", gpu: gpuName, software: SOFTWARE, status: $("status").textContent,
      tracker: tracker ? `${tracker.stats.mode}/${tracker.stats.delegate}` : null, trackMs: tracker ? +tracker.stats.ms.toFixed(1) : null, trackedPerSec: perf.tps, drawnPerSec: perf.fps,
      offered: tracker?.stats.offered, sent: tracker?.stats.sent, done: tracker?.stats.done, drawMs: +perf.drawMs.toFixed(2), found: rigs.some(r => r.group.visible),
      hands: rigs.filter(r => r.group.visible).length, video: [video.videoWidth, video.videoHeight], canvas: [$("gl").width, $("gl").height], pick: S.pick, left: left - 1 };
    try { await fetch("/__report", { method: "POST", body: JSON.stringify(sample) }); } catch (e) {}
    if (--left <= 0) { clearInterval(iv); tracker?.stop(); video.srcObject?.getTracks().forEach(t => t.stop()); video.pause(); window.close(); }
  }, 2000);
}
window.__hand = { S, rigs, hand, CASES, perf, gpuName, SOFTWARE, pickCase, flip, syncUI, lens, get tracker() { return tracker; }, forceDraw: () => draw(performance.now()) };   // for QA
