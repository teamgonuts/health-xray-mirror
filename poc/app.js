// Health Mirror proof of concept: sinus and dental records pinned to the live face.
//
// How a frame is made (the short version of what keeps this fast):
//   camera frame -> tracking worker (poc/tracker.js) -> result + that same frame come back together
//   -> one WebGL canvas draws the frame as its background and the anatomy on top, already zoomed on the face
//   -> a small 2D canvas draws the labels.
// Nothing is drawn unless something changed, the 3D canvas is never larger than the stage, and the whole mouth
// is two draw calls (poc/teeth.js).
import * as THREE from "three";
import { loadHead } from "./head.js";
import { makeMat, setStyle, makeCap } from "./gfx.js";
import { buildSinuses, LEVELS, SINUSES, EXTRAS, NAMES, WHERE, ABOUT, INFLAMED, STATES, colorFor, LOOKS } from "./sinuses.js";
import { buildTeeth, toothName, TOOTH_LOOKS, ARCH_ORDER } from "./teeth.js";
import { createTracker, FIT_IDS } from "./tracker.js";

const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const DEMO = q.has("demo"), STILL = q.has("still");
const stage = $("stage"), video = $("video");
const setStatus = (t, c) => { $("status").textContent = t; $("status").className = c || ""; };

// ------------------------------------------------------------------ settings
// which layers of the sinus view are drawn: the four sinus pairs and their drainage are on, the rest is optional
const SHOW_DEF = { frontal: true, ethmoid: true, sphenoid: true, maxillary: true, drainage: true, nasal: false, adenoids: false, mastoid: false, bones: false };
const DEF = { mode: "sinus", period: "2020", focus: "all", slook: "glow", cut: 2.2, asOf: null, tooth: null, arch: "all", tlook: "clean",
              dim: 0.55, show: SHOW_DEF, point: true, muscles: false, zoomSinus: 1.7, zoomTeeth: 2.6, showspeed: false };
const S = { ...DEF };
try { Object.assign(S, JSON.parse(localStorage.getItem("hm_settings2") || "{}")); } catch (e) {}
S.show = { ...SHOW_DEF, ...(S.show && typeof S.show === "object" ? S.show : {}) }; delete S.skull;
if (q.has("show")) { const want = q.get("show").split(","); for (const k in S.show) S.show[k] = want.includes("all") || want.includes(k); }
for (const [k, key] of [["mode", "mode"], ["period", "period"], ["focus", "focus"], ["look", "slook"], ["tlook", "tlook"], ["tooth", "tooth"], ["arch", "arch"], ["asof", "asOf"], ["cut", "cut"]]) if (q.has(k)) S[key] = q.get(k);
if (q.has("perf")) S.showspeed = true;
if (q.has("point")) S.point = q.get("point") !== "0";        // ?point=0 switches finger pointing off (for speed tests)
if (!["sinus", "teeth"].includes(S.mode)) S.mode = "sinus";
if (!["child", "2020"].includes(S.period)) S.period = "2020";
if (S.focus !== "all" && !LEVELS.includes(S.focus)) S.focus = "all";
if (q.has("focus") && S.focus !== "all") S.show[S.focus] = true;          // a view opened by URL shows what it points at
if (S.focus !== "all" && !S.show[S.focus]) S.focus = "all";
if (!LOOKS[S.slook]) S.slook = "glow";
if (!TOOTH_LOOKS[S.tlook]) S.tlook = "clean";
if (!["all", "upper", "lower"].includes(S.arch)) S.arch = "all";
S.cut = +S.cut; S.tooth = q.has("tooth") ? +q.get("tooth") || null : null;   // no tooth is picked until you point at one (a link may name one)
const save = () => { try { localStorage.setItem("hm_settings2", JSON.stringify(S)); } catch (e) {} };

// ------------------------------------------------------------------ data
async function loadRecords() {
  // your own records in ./data/ win; ?data=example forces the bundled sample (the only one a public copy has)
  for (const base of q.get("data") === "example" ? ["./data.example/"] : ["./data/", "./data.example/"]) {
    try { const r = await fetch(base + "records.json", { cache: "no-cache" }); if (r.ok) return Object.assign(await r.json(), { base }); } catch (e) {}
  }
  throw new Error("no records file found");
}
const [head, REC] = await Promise.all([loadHead(), loadRecords()]);
const meta = head.meta;
$("sample").hidden = !REC.sample;
// what a record says about one structure on one date: { state, short, text } (see STATES in sinuses.js)
const finding = (k, p = S.period) => { const f = REC.sinuses.structures[k]?.[p];
  return typeof f === "string" ? { text: f, short: f.split(/(?<=[.;])\s/)[0] } : f || { state: "none", short: "no record", text: "No record." }; };
// a sinus has a left and a right one, and a record may say something different about each: finding.sides = { L, R }
const sides = (k, p = S.period) => { const f = finding(k, p); return { L: f.sides?.L ?? f.state, R: f.sides?.R ?? f.state }; };
const worst = (k, p = S.period) => { const s = sides(k, p); return s.L === "inflamed" || s.R === "inflamed" ? "inflamed" : s.L; };   // the state that sets the colour
const stateText = (k, p = S.period) => { const s = sides(k, p); return s.L === s.R ? STATES[s.L] || "" : `left ${STATES[s.L]}, right ${STATES[s.R]}`; };
const part = k => k === "sphenoid" ? "half" : "one";             // the sphenoid is one sinus with two halves
const levelsOn = () => LEVELS.filter(k => S.show[k]);          // the ticked structures, top to bottom
const months = [];
{ let [y, m] = (REC.teeth.start || "2019-08").split("-").map(Number); const [ty, tm] = (REC.teeth.today || "2026-11").split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) { months.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } } }
if (!S.asOf || !months.includes(S.asOf)) S.asOf = months[months.length - 1];
const fmtMonth = d => { const [y, m] = d.split("-"); return new Date(+y, +m - 1, 1).toLocaleString("en-GB", { month: "short", year: "numeric" }); };
const fmtDate = d => d.length > 7 ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : fmtMonth(d);
const asOfEnd = () => S.asOf + "-31";            // events dated within the month count as done

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ canvas: $("gl"), alpha: false, antialias: true, powerPreference: "high-performance" });
const gl = renderer.getContext();
const gpuName = (() => { const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : ""; })();
const SOFTWARE = q.has("software") || /Basic Render|SwiftShader|llvmpipe|Software/i.test(gpuName);   // no graphics chip: everything is drawn on the CPU
$("slow").hidden = !SOFTWARE;
renderer.setClearColor(0x070a11, 1); renderer.autoClear = false;
const scene = new THREE.Scene(), bgScene = new THREE.Scene(), bgCam = new THREE.Camera();
let W = 640, H = 480;
const cam = new THREE.PerspectiveCamera(63, W / H, 1, 10000);   // MediaPipe's face geometry assumes a 63 degree camera
let baseProj = cam.projectionMatrix.clone();
const rawProj = new THREE.Matrix4(), zoomM = new THREE.Matrix4();

// the camera frame, drawn as the background of the same canvas so picture and anatomy never drift apart
const bgTex = new THREE.Texture(); bgTex.minFilter = bgTex.magFilter = THREE.LinearFilter; bgTex.generateMipmaps = false;
const bgMat = new THREE.ShaderMaterial({ uniforms: { uTex: { value: bgTex }, uZ: { value: new THREE.Vector3(1, 0, 0) } }, depthTest: false, depthWrite: false,
  vertexShader: `uniform vec3 uZ; varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy * uZ.x + uZ.yz, 0.0, 1.0); }`,
  fragmentShader: `uniform sampler2D uTex; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(uTex, vec2(vUv.x, 1.0 - vUv.y)).rgb, 1.0); }` });
const bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat); bgQuad.frustumCulled = false; bgQuad.visible = false; bgScene.add(bgQuad);

const headGroup = new THREE.Group(); headGroup.matrixAutoUpdate = false; headGroup.visible = false; scene.add(headGroup);
const jawPivot = new THREE.Group(); jawPivot.position.fromArray(meta.jawPivot); headGroup.add(jawPivot);
const jawHolder = new THREE.Group(); jawHolder.position.fromArray(meta.jawPivot).multiplyScalar(-1); jawPivot.add(jawHolder);
const mk = (name, opts, order) => { const m = new THREE.Mesh(head.geometry(name), makeMat(opts)); m.frustumCulled = false; m.renderOrder = order; return m; };
const veil = mk("skin", { mode: 2, color: 0x04070d }, -10); headGroup.add(veil);
const skull = mk("skull", { color: 0x9fc4ff, fill: 0x22324f, gain: 0.17, fillAmt: 0.0 }, 0); headGroup.add(skull);
const sin = buildSinuses(head); headGroup.add(sin.group);
const teeth = buildTeeth(head); teeth.upper.renderOrder = teeth.lower.renderOrder = 4; headGroup.add(teeth.upper); jawHolder.add(teeth.lower);
const muscles = mk("masseter", { color: 0xff6b5e, fill: 0x8a2a20, gain: 0.5, fillAmt: 0.05 }, 3); headGroup.add(muscles);
teeth.setRecords(REC.teeth.events || {});
let skullCap = null;

function applyMode() {
  const sinus = S.mode === "sinus";
  veil.material.uniforms.uBand.value.set(...(sinus ? [-1.8, 6.6, 3.0, 1] : [-7.2, -1.6, 1.8, 1]));   // dim only the part of the face that matters
  setStyle(veil.material, { opacity: S.mode === "sinus" && S.slook === "slice" ? Math.max(S.dim, 0.75) : S.dim });
  const slice = sinus && S.slook === "slice";
  skull.visible = sinus && (S.show.bones || slice);
  if (slice) setStyle(skull.material, { color: 0xffffff, fill: 0xb9b3a4, gain: 0.9, mode: 1, cutColor: 0xf3efe4 });
  else setStyle(skull.material, { color: 0x9fc4ff, fill: 0x22324f, gain: 0.17, fillAmt: 0.0, mode: 0 });
  skull.material.uniforms.uCut.value.set(0, 0, 1, slice ? S.cut : 999); skull.renderOrder = slice ? 30 : 0;
  if (slice && !skullCap) { skullCap = makeCap(skull.geometry, 1); headGroup.add(skullCap.group); }      // bone is cut first; the sinus cuts are drawn over it
  if (skullCap) { skullCap.group.visible = slice; skullCap.set(S.cut, 0xf3efe4); }
  sin.group.visible = sinus;
  sin.update({ states: Object.fromEntries(LEVELS.map(k => [k, SINUSES.includes(k) ? sides(k) : finding(k).state])), drainage: REC.sinuses.periods[S.period].drainage || "",
               shown: S.show, focus: S.focus, look: S.slook, cut: S.cut });
  teeth.upper.visible = teeth.lower.visible = !sinus;
  teeth.setAsOf(asOfEnd()); teeth.select(S.tooth); teeth.setFocus(S.arch); teeth.setLook(S.tlook);
  muscles.visible = !sinus && S.muscles;
  dirty = true;
}

// ------------------------------------------------------------------ head pose + fit (as in the original X-Ray Mirror)
const pose = { found: false, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scl: new THREE.Vector3(1, 1, 1), fitS: 1, fitX: 0, fitY: 0, jaw: 0 };
const tmpM = new THREE.Matrix4(), tmpP = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpV = new THREE.Vector3(), corr = new THREE.Matrix4();
// The face points the head model is fitted to. The tracker returns them in exactly this order (FIT_IDS), so the two
// lists must come from the same place: object keys like "33" would be re-sorted numerically and silently mismatch.
const FIT = FIT_IDS, FIT_PTS = FIT.map(id => new THREE.Vector3(...meta.fit[id]));
// lms: Float32Array of x,y pairs (0..1 in the camera picture) for the FIT points, in FIT_IDS order
function updateHead(matrixData, lms, jawOpen) {
  tmpM.fromArray(matrixData);
  const e = tmpM.elements;
  if (Math.abs(e[12]) + Math.abs(e[13]) + Math.abs(e[14]) < 1e-6 && Math.abs(e[3]) + Math.abs(e[7]) + Math.abs(e[11]) > 1e-3) tmpM.transpose();
  tmpM.decompose(tmpP, tmpQ, tmpS);
  if (!pose.found) { pose.pos.copy(tmpP); pose.quat.copy(tmpQ); pose.scl.copy(tmpS); pose.fitS = 1; pose.fitX = pose.fitY = 0; }
  else { pose.pos.lerp(tmpP, 0.6); pose.quat.slerp(tmpQ, 0.55); pose.scl.lerp(tmpS, 0.5); }
  pose.found = true;
  pose.jaw += (jawOpen - pose.jaw) * 0.6;
  tmpM.compose(pose.pos, pose.quat, pose.scl);
  // pin the model to the face on screen: least-squares scale + shift of key face points onto the tracker's landmarks
  let pmx = 0, pmy = 0, qmx = 0, qmy = 0, num = 0, den = 0; const n = FIT.length, P = [];
  for (let i = 0; i < n; i++) { tmpV.copy(FIT_PTS[i]).applyMatrix4(tmpM).applyMatrix4(baseProj); P.push(tmpV.x, tmpV.y); pmx += tmpV.x; pmy += tmpV.y; qmx += lms[i * 2] * 2 - 1; qmy += 1 - lms[i * 2 + 1] * 2; }
  pmx /= n; pmy /= n; qmx /= n; qmy /= n;
  for (let i = 0; i < n; i++) { const ax = P[i * 2] - pmx, ay = P[i * 2 + 1] - pmy; num += ax * (lms[i * 2] * 2 - 1 - qmx) + ay * (1 - lms[i * 2 + 1] * 2 - qmy); den += ax * ax + ay * ay; }
  const s = Math.max(0.6, Math.min(1.6, den > 1e-9 ? num / den : 1));
  pose.fitS += (s - pose.fitS) * 0.5; pose.fitX += (qmx - pose.fitS * pmx - pose.fitX) * 0.7; pose.fitY += (qmy - pose.fitS * pmy - pose.fitY) * 0.7;
  corr.set(pose.fitS, 0, 0, pose.fitX, 0, pose.fitS, 0, pose.fitY, 0, 0, 1, 0, 0, 0, 0, 1);
  rawProj.copy(baseProj).premultiply(corr);
  headGroup.matrix.copy(tmpM); headGroup.matrixWorldNeedsUpdate = true; headGroup.visible = true;
  jawPivot.rotation.x = Math.min(1, Math.max(0, pose.jaw)) * 0.36;
  updateMouth(performance.now());
}

// ------------------------------------------------------------------ size, zoom, coordinates
const zoomSet = () => S.mode === "sinus" ? S.zoomSinus : S.zoomTeeth;      // what the Zoom slider is set to for this view
// Teeth: the picture stays whole until the mouth opens, then it closes in on the teeth. It backs out again a moment
// after the mouth shuts, so talking doesn't make it bounce.
let mouthOpen = false, mouthShutAt = 0;
function updateMouth(now) {
  const was = mouthOpen;
  if (pose.jaw > 0.25) { mouthOpen = true; mouthShutAt = 0; }
  else if (mouthOpen && pose.jaw < 0.12) { if (!mouthShutAt) mouthShutAt = now; else if (now - mouthShutAt > 700) mouthOpen = false; }
  else mouthShutAt = 0;
  if (was !== mouthOpen) setHint();                            // the hint under the picture says what to do next
}
const zoomOf = () => S.mode === "sinus" ? S.zoomSinus : mouthOpen ? S.zoomTeeth : 1;
const QUALITY = q.has("quality") ? +q.get("quality") : SOFTWARE ? 0.6 : 1;   // drawing resolution relative to the stage
function resize() {
  const r = stage.getBoundingClientRect();
  W = Math.max(2, Math.round(r.width)); H = Math.max(2, Math.round(r.height));
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5) * QUALITY); renderer.setSize(W, H, false);
  cam.aspect = W / H; cam.updateProjectionMatrix(); baseProj = cam.projectionMatrix.clone(); rawProj.copy(baseProj).premultiply(corr);
  $("hud").width = W; $("hud").height = H;
  dirty = true;
}
let dirty = true;
// head-space point -> pixel on the (mirrored) camera picture, then -> stage pixel after the face zoom
const lp = new THREE.Vector3(), jawM = new THREE.Matrix4();
function toRaw(v, onJaw = false) {
  lp.copy(v); if (onJaw) lp.applyMatrix4(jawM);
  lp.applyMatrix4(headGroup.matrix).applyMatrix4(rawProj);
  return { x: W - (lp.x + 1) / 2 * W, y: (1 - lp.y) / 2 * H };
}
const Z = { z: 1, tx: 0, ty: 0, fx: null, fy: null };
const rawToStage = p => ({ x: Z.tx + Z.z * p.x, y: Z.ty + Z.z * p.y });
const toScreen = (v, onJaw) => rawToStage(toRaw(v, onJaw));
const FACE_C = { sinus: new THREE.Vector3(0, 1.6, 3), teeth: new THREE.Vector3(0, -3.9, 3.5) };
// digital zoom that keeps the face centred; applied inside the projection, so nothing is ever drawn larger than the stage
function updateZoom(snap) {
  const target = headGroup.visible ? zoomOf() : 1;
  if (headGroup.visible) { const f = toRaw(FACE_C[S.mode]);
    if (Z.fx === null || snap) { Z.fx = f.x; Z.fy = f.y; } else { Z.fx += (f.x - Z.fx) * 0.3; Z.fy += (f.y - Z.fy) * 0.3; } }
  const before = Z.z;
  Z.z = snap ? target : Z.z + (target - Z.z) * 0.18; if (Math.abs(target - Z.z) < 0.002) Z.z = target;
  const fx = Z.fx ?? W / 2, fy = Z.fy ?? H / 2;
  Z.tx = Math.min(0, Math.max(W - Z.z * W, W / 2 - Z.z * fx)); Z.ty = Math.min(0, Math.max(H - Z.z * H, H / 2 - Z.z * fy));
  const ox = 1 - Z.z - 2 * Z.tx / W, oy = 1 - Z.z - 2 * Z.ty / H;
  zoomM.set(Z.z, 0, 0, ox, 0, Z.z, 0, oy, 0, 0, 1, 0, 0, 0, 0, 1);
  cam.projectionMatrix.copy(rawProj).premultiply(zoomM); cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  bgMat.uniforms.uZ.value.set(Z.z, ox, oy);
  return Z.z !== before;                           // still easing toward the target
}

// ------------------------------------------------------------------ UI: tabs, sinus panel, teeth panel
const seg = (el, map, get, set) => { el.innerHTML = Object.entries(map).map(([k, v]) => `<button data-k="${k}">${v}</button>`).join("");
  for (const b of el.children) b.onclick = () => { set(b.dataset.k); save(); syncUI(); }; return () => { for (const b of el.children) b.classList.toggle("on", b.dataset.k === get()); }; };
for (const b of $("tabs").children) b.onclick = () => { if (b.dataset.href) { location.href = b.dataset.href; return; } S.mode = b.dataset.mode; save(); syncUI(); };   // the hand view is its own page
for (const b of $("period").children) b.onclick = () => { S.period = b.dataset.p; save(); syncUI(); };
const syncSLook = seg($("slook"), LOOKS, () => S.slook, v => { S.slook = v; if (v === "slice" && S.focus !== "all") S.cut = cutFor(S.focus); });
const syncTLook = seg($("tlook"), TOOTH_LOOKS, () => S.tlook, v => { S.tlook = v; });
const lvRow = k => `<div class="lv" data-k="${k}"><input type="checkbox" data-show="${k}" aria-label="Show ${NAMES[k]}"><button data-k="${k}"><i></i><span>${NAMES[k]}</span><small></small></button></div>`;
const ckRow = (k, name) => `<label class="lv plain" data-k="${k}"><input type="checkbox" data-show="${k}"><span>${name}</span><small></small></label>`;
$("levels").innerHTML = `<button class="lvall" data-k="all"><span>Overview</span><small>everything that is ticked</small></button>
  <div class="grp">Sinuses</div>${SINUSES.map(lvRow).join("")}${ckRow("drainage", "Drainage channels")}
  <div class="grp">Also in the records, not sinuses</div>${EXTRAS.map(lvRow).join("")}${ckRow("bones", "Skull bones")}`;
for (const b of $("levels").querySelectorAll("button")) b.onclick = () => { const k = b.dataset.k; if (k !== "all") S.show[k] = true; setFocus(k); };
for (const c of $("levels").querySelectorAll("input")) c.onchange = () => { const k = c.dataset.show; S.show[k] = c.checked; if (!c.checked && S.focus === k) S.focus = "all"; save(); syncUI(); };
for (const b of $("arch").children) b.onclick = () => setArch(b.dataset.a);
$("finger").onchange = e => { S.point = e.target.checked; save(); tracker?.setHands(S.point); syncUI(); };
$("muscles").onchange = e => { S.muscles = e.target.checked; save(); syncUI(); };
$("showspeed").onchange = e => { S.showspeed = e.target.checked; save(); syncUI(); };
$("dim").oninput = e => { S.dim = +e.target.value; save(); applyMode(); };
$("zoom").oninput = e => { S[S.mode === "sinus" ? "zoomSinus" : "zoomTeeth"] = +e.target.value; save(); syncUI(); };
$("cut").oninput = e => { S.cut = +e.target.value; save(); applyMode(); };
$("asof").max = months.length - 1;
$("asof").oninput = e => { S.asOf = months[+e.target.value]; save(); syncUI(); };

$("chart").innerHTML = [...ARCH_ORDER.upper.slice(0, 8), 0, ...ARCH_ORDER.upper.slice(8), ...ARCH_ORDER.lower.slice(0, 8), 0, ...ARCH_ORDER.lower.slice(8)]
  .map(n => n ? `<button data-t="${n}" title="${n} · ${toothName(n)}">${n}</button>` : `<span class="gap"></span>`).join("");
for (const b of $("chart").querySelectorAll("button")) b.onclick = () => selectTooth(+b.dataset.t === S.tooth ? null : +b.dataset.t);

const XR = (REC.teeth.xrays || []).map(x => ({ ...x, url: REC.base + x.file }));
$("xcount").textContent = XR.length ? "· " + XR.length : "· none";
$("thumbs").innerHTML = XR.map((x, i) => `<button data-i="${i}" title="${x.kind} · ${fmtDate(x.date)} · ${x.note}"><img src="${x.url}" alt="" loading="lazy"><span>${x.date.slice(0, 7)}</span></button>`).join("");
for (const b of $("thumbs").children) b.onclick = () => { shownX = { list: [XR[+b.dataset.i]], i: 0, free: true }; showXray(); };

const cutFor = k => Math.max(...sin.anchors[k].map(a => a.z)) + 0.1;          // a slice through the middle of that structure
function setFocus(k) { S.focus = k; if (S.slook === "slice" && k !== "all") S.cut = cutFor(k); save(); syncUI(); }
function setArch(a) { S.arch = a; if (S.tooth && a !== "all" && teeth.teeth[S.tooth].upper !== (a === "upper")) { S.tooth = null; shownX = null; } save(); syncUI(); }
function selectTooth(n) { S.tooth = n; shownX = null; if (n && S.arch !== "all" && teeth.teeth[n].upper !== (S.arch === "upper")) S.arch = teeth.teeth[n].upper ? "upper" : "lower"; save(); syncUI(); }
const toothX = n => XR.filter(x => x.teeth.includes(String(n)) && x.date <= asOfEnd());

// The detail card: what each of the two records says about the selected structure, then background, then the gaps in the record.
const cardOpen = { about: true, inflamed: false, unknown: false, next: false };
let cardSig = "";
function sinusCard() {
  const R = REC.sinuses, P = R.periods, k = S.focus === "all" ? null : S.focus;
  const sig = [k, S.period, JSON.stringify(cardOpen)].join("|"); if (sig === cardSig) return; cardSig = sig;
  const det = (id, title, body) => body ? `<details data-d="${id}"${cardOpen[id] ? " open" : ""}><summary>${title}</summary>${body}</details>` : "";
  const list = a => a?.length ? `<ul>${a.map(t => `<li>${t}</li>`).join("")}</ul>` : "";
  const row = p => { const f = k ? finding(k, p) : null;
    return `<button data-p="${p}" class="${p === S.period ? "on" : ""}"><b>${P[p].label}</b><span>${P[p].age || ""}</span>${f ? `<em style="color:${colorFor(k, worst(k, p))}">${stateText(k, p)}</em><p>${f.text}</p>` : `<p>${P[p].kind || ""}</p>`}</button>`; };
  const cmp = `<div class="cmp">${["child", "2020"].map(row).join("")}</div>`;
  $("scard").innerHTML = k
    ? `<h4>${NAMES[k]}</h4><p class="where">${WHERE[k]}${R.structures[k]?.note ? `. In this view: ${R.structures[k].note}.` : ""}</p>${cmp}
       ${det("about", SINUSES.includes(k) ? "About this sinus" : "What this is", `<p>${ABOUT[k]}</p>`)}
       ${SINUSES.includes(k) ? det("inflamed", "What “inflamed” means", `<p>${INFLAMED}</p>`) : ""}
       ${det("unknown", "What the records don't say", list(R.unknown))}${det("next", "How to find out more", list(R.next))}`
    : `<h4>Then and now</h4><p class="where">Tick what to show in the list above. Step through with ↑ ↓ or the scroll wheel, or click a sinus on your face, to read what each record says about it.</p>${cmp}
       ${R.unknown?.length ? `<details open><summary>What the records don't say</summary>${list(R.unknown)}</details>` : ""}${R.next?.length ? `<details open><summary>How to find out more</summary>${list(R.next)}</details>` : ""}`;
  for (const b of $("scard").querySelectorAll(".cmp button")) b.onclick = () => { S.period = b.dataset.p; save(); syncUI(); };
  for (const d of $("scard").querySelectorAll("details[data-d]")) d.ontoggle = () => { cardOpen[d.dataset.d] = d.open; };
}

function syncUI() {
  for (const b of $("tabs").children) b.classList.toggle("on", b.dataset.mode === S.mode);
  $("p-sinus").hidden = S.mode !== "sinus"; $("p-teeth").hidden = S.mode !== "teeth";
  $("dim").value = S.dim; $("zoom").value = zoomSet(); $("zoomv").textContent = zoomSet().toFixed(1) + "×";
  $("zooml").textContent = S.mode === "sinus" ? "Zoom on my face" : "Zoom when my mouth opens";
  $("finger").checked = S.point; $("muscles").checked = S.muscles; $("showspeed").checked = S.showspeed; $("speed").hidden = !S.showspeed;
  // sinus panel
  const per = REC.sinuses.periods[S.period];
  for (const b of $("period").children) b.classList.toggle("on", b.dataset.p === S.period);
  for (const b of $("period").children) { const p = REC.sinuses.periods[b.dataset.p]; b.innerHTML = `<b>${p.label}</b>${p.age ? `<small>${p.age}</small>` : ""}`; }   // two dates, ages underneath
  $("pkind").textContent = per.kind || per.years || "";
  $("psum").textContent = per.summary; $("psrc").textContent = "Source: " + per.source;
  $("pnote").textContent = per.example || ""; $("pnote").hidden = !per.example;
  { const seen = new Set(levelsOn().flatMap(k => Object.values(sides(k))));
    $("slegend").innerHTML = [seen.has("clear") && `<span><i style="background:#67dcff"></i>full of air, clear</span>`,
      seen.has("inflamed") && `<span><i style="background:#ffb35c"></i>inflamed</span>`, seen.has("surgery") && `<span><i style="background:#ffe066"></i>operated on</span>`,
      S.show.drainage && per.drainage === "open" && `<span><i style="background:#5dff9c"></i>drainage channel, open</span>`,
      S.show.drainage && per.drainage === "unknown" && `<span><i style="background:#fff1c4"></i>drainage channel (the record doesn't describe it)</span>`].filter(Boolean).join(""); }
  syncSLook(); $("cutrow").hidden = S.slook !== "slice"; $("cut").value = S.cut;
  for (const row of $("levels").children) { const k = row.dataset.k; if (!k) continue;
    if (k === "all") { row.classList.toggle("on", S.focus === "all"); continue; }
    const ck = row.querySelector("input"), small = row.querySelector("small"), slice = S.slook === "slice";
    ck.checked = k === "bones" ? S.show.bones || slice : !!S.show[k]; ck.disabled = k === "bones" && slice; row.classList.toggle("off", !ck.checked);
    if (LEVELS.includes(k)) { const sd = sides(k), dot = row.querySelector("i"); row.querySelector("button").classList.toggle("on", k === S.focus);
      // a dot split down the middle when the two sides differ (your left is on the left, as in a mirror)
      dot.style.background = sd.L === sd.R ? colorFor(k, sd.L) : `linear-gradient(90deg, ${colorFor(k, sd.L)} 50%, ${colorFor(k, sd.R)} 50%)`;
      small.textContent = sd.L === sd.R ? STATES[sd.L] || "" : sd.L === "clear" ? `left ${part(k)} clear` : sd.R === "clear" ? `right ${part(k)} clear` : stateText(k); }
    else small.textContent = k === "drainage" ? (per.drainage === "open" ? "open on the CT" : per.drainage === "unknown" ? "not in this record" : "not shown for this date") : slice ? "always on in Slice" : "for orientation"; }
  sinusCard();
  // teeth panel
  teeth.setAsOf(asOfEnd());
  syncTLook(); for (const b of $("arch").children) b.classList.toggle("on", b.dataset.a === S.arch);
  $("asof").value = months.indexOf(S.asOf); $("asofv").textContent = fmtMonth(S.asOf);
  for (const b of $("chart").querySelectorAll("button")) { const n = +b.dataset.t, st = teeth.state(n), inArch = S.arch === "all" || teeth.teeth[n].upper === (S.arch === "upper");
    b.className = (st.extracted ? "extracted" : st.chipped ? "chipped" : st.filled || st.sensitive ? "treated" : "") + (inArch ? "" : " off") + (n === S.tooth ? " on" : ""); }
  $("tnotes").innerHTML = (REC.teeth.notes || []).map(n => `<li class="${n.date > S.asOf ? "future" : ""}"><span class="card"><span class="when">${fmtMonth(n.date)}</span></span>${n.text}</li>`).join("");
  if (!S.tooth) $("tcard").innerHTML = `<h4>Pick a tooth</h4><p class="where">Open your mouth and the picture closes in on your teeth. Point at a tooth with your finger to read its record, or click it on your face or on the chart. ← → walk along the teeth, ↑ ↓ switch between upper and lower.</p>
      <p class="src">${REC.teeth.source}</p>`;
  else { const n = S.tooth, ev = REC.teeth.events[n] || [], xs = XR.filter(x => x.teeth.includes(String(n)));
    $("tcard").innerHTML = `<h4>${n} · ${toothName(n)}</h4><p class="where">${describe(n)}</p>
      ${ev.length ? `<ul>${ev.map(e => `<li class="${e.date > asOfEnd() ? "future" : ""}"><span class="when">${fmtDate(e.date)}</span>${e.text}</li>`).join("")}</ul>` : `<p>No treatment recorded on this tooth since 2019.</p>`}
      ${xs.length ? `<div class="xlinks">${xs.map(x => `<button data-f="${x.file}">X-ray ${fmtDate(x.date)}</button>`).join("")}</div>` : ""}`;
    for (const b of $("tcard").querySelectorAll("[data-f]")) b.onclick = () => { shownX = { list: xs, i: xs.findIndex(x => x.file === b.dataset.f), free: false }; showXray(); }; }
  if (S.mode === "teeth" && S.tooth && !shownX) { const l = toothX(S.tooth); shownX = l.length ? { list: l, i: l.length - 1, free: false } : null; }
  if (S.mode !== "teeth") shownX = null;
  showXray();
  setHint();
  applyMode();
}
function setHint() {
  $("hint").textContent = S.mode === "sinus" ? (S.slook === "slice" ? "Scroll to move the slice front to back · ↑ ↓ jump to a sinus" : S.point ? "Point at a sinus · ↑ ↓ or scroll to move" : "↑ ↓ or scroll to move up and down through the sinuses")
                                              : !mouthOpen ? "Open your mouth to close in on your teeth" : S.point ? "Point at a tooth · ← → tooth by tooth · ↑ ↓ upper or lower" : "← → tooth by tooth · ↑ ↓ upper or lower teeth";
}
function describe(n) {
  const st = teeth.state(n);
  if (st.extracted) return "Removed.";
  const bits = [];
  if (st.filled) bits.push(st.filled >= 3 ? "three-surface filling" : "filling");
  if (st.chipped) bits.push("chipped");
  if (st.sensitive) bits.push("sensitive neck treated");
  if (st.planned && st.chipped) bits.push("repair planned");
  return bits.length ? `As of ${fmtMonth(S.asOf)}: ${bits.join(", ")}.` : `As of ${fmtMonth(S.asOf)}: nothing recorded.`;
}

// X-ray card on the stage: it sits on the side of the picture away from the selected tooth
let shownX = null;
function showXray() {
  const el = $("xray");
  if (!shownX || !shownX.list.length || S.mode !== "teeth") { el.hidden = true; return; }
  const x = shownX.list[shownX.i];
  el.hidden = false; if ($("xrayimg").getAttribute("src") !== x.url) $("xrayimg").src = x.url;
  // the picture is mirrored: the person's right teeth (quadrants 1 and 4) are on the right, so the card goes left
  const q = S.tooth ? Math.floor(S.tooth / 10) : 1; el.classList.toggle("right", !shownX.free && (q === 2 || q === 3));
  $("xraycap").textContent = [x.kind, fmtDate(x.date), x.note, x.credit && "Picture: " + x.credit].filter(Boolean).join(" · ");
  $("xraynext").hidden = shownX.list.length < 2;
  for (const b of $("thumbs").children) b.classList.toggle("on", XR[+b.dataset.i] === x);
  dirty = true;
}
$("xraynext").onclick = () => { if (shownX) { shownX.i = (shownX.i + 1) % shownX.list.length; showXray(); } };
$("xrayimg").onclick = () => { shownX = null; showXray(); };

// keyboard, wheel and clicks on the picture
addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" && e.target.type === "range") return;
  const up = e.key === "ArrowUp", down = e.key === "ArrowDown", left = e.key === "ArrowLeft", right = e.key === "ArrowRight";
  if (S.mode === "sinus" && (up || down)) { e.preventDefault(); stepLevel(down ? 1 : -1); }
  if (S.mode === "teeth" && (up || down)) { e.preventDefault(); const order = ["upper", "all", "lower"]; setArch(order[Math.max(0, Math.min(2, order.indexOf(S.arch) + (down ? 1 : -1)))]); }
  if (S.mode === "teeth" && (left || right)) { e.preventDefault(); stepTooth(right ? 1 : -1); }
  if (e.key === "Escape") { if (S.mode === "sinus") setFocus("all"); else selectTooth(null); }
});
let wheelAt = 0;
stage.addEventListener("wheel", e => {
  if (S.mode !== "sinus") return; e.preventDefault();
  if (S.slook === "slice") { S.cut = Math.max(-4.5, Math.min(6, S.cut - Math.sign(e.deltaY) * 0.15)); $("cut").value = S.cut; save(); applyMode(); return; }
  const now = performance.now(); if (now - wheelAt < 220) return; wheelAt = now; stepLevel(e.deltaY > 0 ? 1 : -1);
}, { passive: false });
function stepLevel(d) { const list = ["all", ...levelsOn()]; setFocus(list[Math.max(0, Math.min(list.length - 1, list.indexOf(S.focus) + d))]); }
function stepTooth(d) {      // walk along the focused arch, tooth by tooth, in mirror order (→ moves toward your right)
  const upper = S.tooth ? teeth.teeth[S.tooth].upper : S.arch !== "lower", order = ARCH_ORDER[upper ? "upper" : "lower"];
  const i = S.tooth ? order.indexOf(S.tooth) : (d > 0 ? -1 : order.length);
  selectTooth(order[(i + d + order.length) % order.length]);
}
stage.addEventListener("click", e => {
  if (!headGroup.visible || e.target.closest(".xray") || e.target.closest("#intro")) return;
  const r = stage.getBoundingClientRect(), hit = pick({ x: e.clientX - r.left, y: e.clientY - r.top }, S.mode === "sinus" ? 90 : 34);
  if (S.mode === "sinus") setFocus(hit || "all"); else selectTooth(hit);
});
function pick(p, maxD) {
  let best = null, bd = maxD;
  if (S.mode === "sinus") { for (const k of levelsOn()) for (const a of sin.anchors[k]) { const s = toScreen(a), d = Math.hypot(s.x - p.x, s.y - p.y); if (d < bd) { bd = d; best = k; } } }
  else for (const n in teeth.teeth) { const T = teeth.teeth[n]; if (S.arch !== "all" && T.upper !== (S.arch === "upper")) continue;
    const s = toScreen(T.face, !T.upper), d = Math.hypot(s.x - p.x, s.y - p.y); if (d < bd) { bd = d; best = +n; } }
  return best;
}

// ------------------------------------------------------------------ heads-up layer: labels, scan line, fingertip
const hud = $("hud").getContext("2d"), FONT = "system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
let scanY = null, fingerPt = null, lastLms = null;
const DEBUG = q.has("debug");
function wrap(g, text, maxW, maxLines = 4) {
  const words = text.split(" "), lines = []; let cur = "";
  for (const w of words) { const t = cur ? cur + " " + w : w;
    if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; if (lines.length === maxLines) break; } else cur = t; }
  if (lines.length < maxLines && cur) lines.push(cur);
  else if (cur && lines.length === maxLines) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  return lines;
}
// a label with a leader line; sub is a wrapped description. It flips to the other side when there's no room.
function label(g, text, sub, ax, ay, tx, ty, color, align, big, alt) {
  const SUBW = 250;
  if (alt !== undefined && big && sub) { const room = align === "left" ? W - 8 - tx : tx - 8, altRoom = align === "left" ? alt - 8 : W - 8 - alt;
    if (room < SUBW && altRoom > room) { tx = alt; align = align === "left" ? "right" : "left"; } }
  g.font = `${big ? 700 : 600} ${big ? 16 : 13}px ${FONT}`;
  let need = g.measureText(text).width;
  if (sub) { g.font = `500 12.5px ${FONT}`; need = Math.max(need, Math.min(SUBW, g.measureText(sub).width)); }
  if (align === "right") tx = Math.max(tx, need + 8); else tx = Math.min(tx, W - need - 8);       // keep the whole label inside the picture
  const maxW = Math.max(120, Math.min(SUBW, align === "left" ? W - 8 - tx : tx - 8));
  g.strokeStyle = color; g.globalAlpha = 0.8; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(ax, ay); g.lineTo(tx + (align === "right" ? 6 : -6), ty); g.stroke();
  g.globalAlpha = 1; g.fillStyle = color; g.beginPath(); g.arc(ax, ay, 3, 0, 6.3); g.fill();
  g.textAlign = align; g.textBaseline = "middle"; g.lineJoin = "round";
  g.font = `${big ? 700 : 600} ${big ? 16 : 13}px ${FONT}`;
  g.strokeStyle = "rgba(4,7,13,.92)"; g.lineWidth = 4; g.strokeText(text, tx, ty); g.fillText(text, tx, ty);
  if (sub) { g.font = `500 12.5px ${FONT}`; g.fillStyle = "#dfe6f5";
    wrap(g, sub, maxW).forEach((l, i) => { g.strokeText(l, tx, ty + 19 + i * 16); g.fillText(l, tx, ty + 19 + i * 16); }); }
  return { tx, align };
}
const shortStatus = key => finding(key).short || "";
function drawHud() {
  const g = hud; g.clearRect(0, 0, W, H);
  $("xray").style.visibility = headGroup.visible || shownX?.free ? "visible" : "hidden";   // no floating X-ray without a face
  if (!headGroup.visible) return;
  jawPivot.updateMatrix(); jawHolder.updateMatrix(); jawM.copy(jawPivot.matrix).multiply(jawHolder.matrix);
  const face = toScreen(FACE_C.sinus), side = toScreen(tmpV.set(7.5, 1.5, 3)), halfW = Math.abs(side.x - face.x);
  const colL = Math.max(10, face.x - halfW - 14), colR = Math.min(W - 10, face.x + halfW + 14);
  if (S.mode === "sinus") {
    if (S.focus === "all") {       // one label per structure, alternating sides, spread so none overlap
      const cols = { left: [], right: [] };
      levelsOn().forEach((k, i) => { const right = i % 2 === 0, pts = sin.anchors[k].map(a => toScreen(a)), a = pts.reduce((b, p) => (right ? p.x > b.x : p.x < b.x) ? p : b, pts[0]);
        cols[right ? "right" : "left"].push({ k, ax: a.x, ay: a.y }); });
      for (const sd of ["left", "right"]) { const list = cols[sd].sort((a, b) => a.ay - b.ay); let prev = -1e9;
        for (const it of list) { it.ty = Math.max(it.ay, prev + 24); prev = it.ty; }
        const over = prev - (H - 16); if (over > 0) for (const it of list) it.ty -= over;
        for (const it of list) { const st = sides(it.k), note = st.L === "removed" ? " (removed)" : st.L === st.R ? "" : st.L === "clear" ? ` (left ${part(it.k)} clear)` : st.R === "clear" ? ` (right ${part(it.k)} clear)` : "";
          label(g, NAMES[it.k] + note, null, it.ax, it.ay, sd === "right" ? colR : colL, it.ty, colorFor(it.k, worst(it.k)), sd === "right" ? "left" : "right", false); } }
      scanY = null;
    } else {
      const pts = sin.anchors[S.focus].map(a => toScreen(a)), cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      scanY = scanY === null ? cy : scanY + (cy - scanY) * 0.35;
      const grad = g.createLinearGradient(colL, 0, colR, 0);                 // scan line across the face at the selected level
      grad.addColorStop(0, "rgba(127,209,255,0)"); grad.addColorStop(0.2, "rgba(127,209,255,.5)"); grad.addColorStop(0.8, "rgba(127,209,255,.5)"); grad.addColorStop(1, "rgba(127,209,255,0)");
      g.strokeStyle = grad; g.lineWidth = 1.5; g.setLineDash([6, 5]); g.beginPath(); g.moveTo(colL, scanY); g.lineTo(colR, scanY); g.stroke(); g.setLineDash([]);
      const col = colorFor(S.focus, worst(S.focus)), ty = Math.max(24, Math.min(H - 70, scanY - 10));
      const placed = label(g, NAMES[S.focus], shortStatus(S.focus), pts[0].x, pts[0].y, colR, ty, col, "left", true, colL);
      g.strokeStyle = col; g.globalAlpha = 0.65; g.lineWidth = 1;
      for (const p of pts.slice(1)) { g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(placed.tx + (placed.align === "left" ? -6 : 6), ty); g.stroke(); g.beginPath(); g.arc(p.x, p.y, 3, 0, 6.3); g.fillStyle = col; g.fill(); }
      g.globalAlpha = 1;
    }
  } else if (S.tooth && teeth.teeth[S.tooth]) {      // teeth: only the selected tooth is labelled, so the picture stays clean
    const T = teeth.teeth[S.tooth], p = toScreen(T.face, !T.upper), mouth = toScreen(FACE_C.teeth), st = teeth.state(S.tooth);
    const right = p.x > mouth.x, sub = st.extracted ? "removed" : [st.filled ? (st.filled >= 3 ? "3-surface filling" : "filling") : null, st.chipped ? "chipped" : null, st.sensitive ? "sensitive neck" : null].filter(Boolean).join(" · ") || "nothing recorded";
    label(g, `${S.tooth} · ${toothName(S.tooth)}`, sub, p.x, p.y, right ? colR : colL, T.upper ? p.y - 46 : p.y + 46, "#ffffff", right ? "left" : "right", true);
  }
  if (fingerPt) { g.strokeStyle = "#ffb703"; g.lineWidth = 2; g.beginPath(); g.arc(fingerPt.x, fingerPt.y, 9, 0, 6.3); g.stroke(); }
  if (DEBUG && lastLms) {            // ?debug: where the tracker saw the face points (yellow) and where the model puts them (green)
    for (let i = 0; i < FIT.length; i++) {
      const a = rawToStage({ x: (1 - lastLms[i * 2]) * W, y: lastLms[i * 2 + 1] * H }), b = toScreen(FIT_PTS[i]);
      g.fillStyle = "#ffe600"; g.fillRect(a.x - 3, a.y - 3, 6, 6); g.strokeStyle = "#39ff88"; g.lineWidth = 2; g.strokeRect(b.x - 5, b.y - 5, 10, 10);
    }
  }
}
// finger picking needs a steady pick for a moment so it doesn't flicker
let fingerPick = null, fingerSince = 0;
function handleFinger(now) {
  if (!fingerPt || (S.mode === "teeth" && !mouthOpen)) { fingerPick = null; return; }
  const hit = pick(fingerPt, S.mode === "sinus" ? 70 : 30);
  if (hit !== fingerPick) { fingerPick = hit; fingerSince = now; return; }
  if (hit && now - fingerSince > 300) { if (S.mode === "sinus" && S.focus !== hit) setFocus(hit); if (S.mode === "teeth" && S.tooth !== hit) selectTooth(hit); }
}

// ------------------------------------------------------------------ drawing, only when something changed
const perf = { frames: 0, results: 0, fps: 0, tps: 0, drawMs: 0, at: performance.now() };
function draw(now, snap) {
  const t0 = performance.now();
  sin.tick(now / 1000);
  const easing = updateZoom(snap || STILL);
  renderer.clear(); renderer.render(bgScene, bgCam); renderer.render(scene, cam);
  drawHud();
  perf.frames++; perf.drawMs += (performance.now() - t0 - perf.drawMs) * 0.1;
  return easing;
}
function loop(now) {
  requestAnimationFrame(loop);
  if (dirty) { dirty = false; if (draw(now)) dirty = true; }       // nothing changed, nothing drawn (the camera sets the pace)
  if (now - perf.at >= 1000) {
    perf.fps = Math.round(perf.frames * 1000 / (now - perf.at)); perf.tps = Math.round(perf.results * 1000 / (now - perf.at)); perf.frames = perf.results = 0; perf.at = now;
    if (S.showspeed) $("speed").textContent = tracker ? `Tracking ${perf.tps} times a second (${tracker.stats.ms.toFixed(0)} ms each, ${tracker.stats.delegate === "GPU" ? "graphics chip" : "processor"}${tracker.stats.mode === "main" ? ", main thread" : ""}) · drawing ${perf.fps} frames a second`
                                                      : `Drawing ${perf.fps} frames a second`;
  }
}
new ResizeObserver(resize).observe(stage); resize();

// ------------------------------------------------------------------ camera + tracker
let tracker = null, shown = null, lostAt = 0, said = "";
const say = (t, c) => { if (said !== t) { said = t; setStatus(t, c); } };
function onResult(r) {
  const now = performance.now(); perf.results++;
  if (r.found) { updateHead(r.matrix, r.lms, r.jaw); lostAt = 0; lastLms = r.lms; }
  else { if (!lostAt) lostAt = now; if (now - lostAt > 250) { pose.found = false; headGroup.visible = false; if (mouthOpen) { mouthOpen = false; setHint(); } } }
  if (shown) shown.close();                                  // the previous frame is already on the graphics card
  shown = r.bitmap; bgTex.image = shown; bgTex.needsUpdate = true; bgQuad.visible = true;
  fingerPt = r.finger && S.point ? rawToStage({ x: (1 - r.finger[0]) * W, y: r.finger[1] * H }) : null;
  handleFinger(now);
  say(pose.found ? (S.mode === "sinus" ? "Tracking your face. Showing your sinus records." : "Tracking your face. Showing your dental records.")
                 : "No face found. Face the camera, with light on your face.", pose.found ? "ok" : "bad");
  $("hint").hidden = !pose.found;
  dirty = true;
}

// Built-in test scene (?demo): a pretend head turning slowly, no camera. &still freezes it; &yaw=0.4 &pitch=0.1 &jaw=0.5 set the pose.
function demoLoop() {
  $("intro").hidden = true; $("hint").hidden = false;
  setStatus("Demo scene (no camera).", "ok");
  const yaw0 = q.has("yaw") ? +q.get("yaw") : null, pitch0 = q.has("pitch") ? +q.get("pitch") : null, jaw0 = q.has("jaw") ? +q.get("jaw") : null;
  const lms = new Float32Array(FIT.length * 2), m = new THREE.Matrix4(), v = new THREE.Vector3();
  function tick() {
    if (!STILL) requestAnimationFrame(tick);
    const t = STILL ? 1.2 : performance.now() / 1000;
    m.makeRotationFromEuler(new THREE.Euler(pitch0 ?? (-0.05 + 0.08 * Math.sin(t * 0.6)), yaw0 ?? 0.45 * Math.sin(t * 0.45), 0.02, "YXZ")); m.setPosition(0, 0.5, -31);
    FIT_PTS.forEach((p, i) => { v.copy(p).applyMatrix4(m).applyMatrix4(baseProj); lms[i * 2] = (v.x + 1) / 2; lms[i * 2 + 1] = (1 - v.y) / 2; });
    updateHead(m.elements, lms, jaw0 ?? (S.mode === "teeth" ? Math.max(0, Math.sin(t * 1.1)) * 0.8 : 0));
    perf.results++; dirty = true;
  }
  if (STILL) { tick(); tick(); tick(); new ResizeObserver(() => { tick(); }).observe(stage); } else tick();
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
    what = "face tracker"; setStatus("Loading the face tracker (first time takes a few seconds)…");
    // ?delegate=CPU|GPU, ?tscale=0.5 and ?mainthread override the automatic choices (for testing)
    tracker = await createTracker({ video, onResult, software: SOFTWARE, forceMain: q.has("mainthread"), delegate: q.get("delegate"), scale: q.has("tscale") ? +q.get("tscale") : null });
    if (S.point) tracker.setHands(true);
    resize(); tracker.start();
  } catch (err) {
    $("start").disabled = false; $("intro").hidden = false;
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    setStatus(denied ? "Camera blocked. Allow camera access for this page and click Start again." : `Could not load the ${what}: ${err.message || err}`, "bad");
  }
};

if (S.slook === "slice" && S.focus !== "all" && !q.has("cut")) S.cut = cutFor(S.focus);
syncUI();
$("start").disabled = false; $("start").textContent = "Start camera"; setStatus("Click Start camera, then allow the camera.");
requestAnimationFrame(loop);
if (DEMO) demoLoop();
// Self-test for checking a real browser without driving it: ?autostart presses Start; ?report=N posts N speed
// samples (2 s apart) to the dev server, which appends them to tools/cache/report.jsonl, then turns the camera
// off and closes the tab.
if (q.has("autostart") && !DEMO) $("start").click();
if (q.has("report")) {
  let left = +q.get("report") || 5, waited = 0;
  const iv = setInterval(async () => {
    if (!tracker && !DEMO && ++waited < 30) return;                 // still loading the camera or tracker
    const sample = { at: new Date().toISOString(), tag: q.get("tag") || "", gpu: gpuName, software: SOFTWARE, status: $("status").textContent,
      tracker: tracker ? `${tracker.stats.mode}/${tracker.stats.delegate}` : null, trackMs: tracker ? +tracker.stats.ms.toFixed(1) : null,
      trackedPerSec: perf.tps, drawnPerSec: perf.fps, offered: tracker?.stats.offered, sent: tracker?.stats.sent, done: tracker?.stats.done, grabMs: tracker ? +tracker.stats.grabMs.toFixed(1) : null, t: Math.round(performance.now()), drawMs: +perf.drawMs.toFixed(2), found: pose.found, fitErrorPx: window.__hm.fitError() && +window.__hm.fitError().toFixed(1),
      video: [video.videoWidth, video.videoHeight], canvas: [$("gl").width, $("gl").height], mode: S.mode, left: left - 1 };
    try { await fetch("/__report", { method: "POST", body: JSON.stringify(sample) }); } catch (e) {}
    if (--left <= 0) { clearInterval(iv); tracker?.stop(); video.srcObject?.getTracks().forEach(t => t.stop()); video.pause(); window.close(); }
  }, 2000);
}
window.__hm = { fitError: () => lastLms ? FIT.reduce((s, _, i) => { const a = rawToStage({ x: (1 - lastLms[i * 2]) * W, y: lastLms[i * 2 + 1] * H }), b = toScreen(FIT_PTS[i]); return s + Math.hypot(a.x - b.x, a.y - b.y); }, 0) / FIT.length : null,
  S, pose, sin, teeth, finding, sides, get mouthOpen() { return mouthOpen; }, setFocus, selectTooth, setArch, syncUI, renderer, scene, cam, perf, gpuName, SOFTWARE, get tracker() { return tracker; }, forceDraw: () => draw(performance.now(), true) };   // for QA
