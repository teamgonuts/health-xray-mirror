// The sinus view's anatomy, built from poc/assets/head.* (see tools/build-anatomy.mjs for where each shape comes from:
// the nose structures are real BodyParts3D meshes; the sinus cavities are reconstructed inside the real bones).
import * as THREE from "three";
import { makeMat, setStyle, makeCap } from "./gfx.js";

// top-to-bottom order used when stepping up and down through the structures
export const LEVELS = ["frontal", "ethmoid", "sphenoid", "maxillary", "nasal", "adenoids", "mastoid"];
export const SINUSES = ["frontal", "ethmoid", "sphenoid", "maxillary"];    // four pairs, left and right: "the 8 sinuses"
export const EXTRAS = ["nasal", "adenoids", "mastoid"];                    // mentioned in sinus records, but not sinuses
export const NAMES = {
  frontal: "Frontal sinuses", ethmoid: "Ethmoid sinuses", sphenoid: "Sphenoid sinus", maxillary: "Maxillary sinuses",
  nasal: "Septum and turbinates", adenoids: "Adenoids", mastoid: "Mastoid air cells",
};
export const WHERE = {
  frontal: "in the forehead, above the eyebrows", ethmoid: "between the eyes, a honeycomb of small cells",
  sphenoid: "deep in the middle of the head, behind the nose", maxillary: "in the cheekbones, below the eyes",
  nasal: "the wall down the middle of the nose and the scroll-shaped turbinates on each side",
  adenoids: "at the back of the nose, above the throat", mastoid: "in the bone behind each ear",
};
// General anatomy, the same for everyone. Nothing in ABOUT or INFLAMED comes from a person's records.
export const ABOUT = {
  frontal: "Two air spaces in the forehead bone, one above each eyebrow. Each drains straight down into the nose through a narrow channel, the frontal recess. They are the last sinuses to grow: they start to show on scans around age 6 and only reach full size in the late teens. When the lining swells, that narrow channel blocks easily; the usual feeling is pressure or an ache in the forehead that gets worse when you bend forward.",
  ethmoid: "A honeycomb of small air cells in the thin bone between the eyes, several on each side. The front cells sit at the crossroads where the frontal and maxillary sinuses also drain (the osteomeatal complex), so swelling here tends to block those as well. The usual feeling when inflamed is a blocked nose and pressure between or behind the eyes.",
  sphenoid: "An air space deep in the centre of the head, behind the nose and just below the pituitary gland. A thin wall usually splits it into a left and a right half, which is why it counts as two of the eight sinuses. It drains forward into the back of the nose. When it is inflamed the feeling is a deep headache behind the eyes or at the top of the head, with mucus running down the back of the throat.",
  maxillary: "The largest sinuses, one in each cheekbone under the eye. The roots of the upper back teeth sit just under their floor. The drain opening is high up on the inner wall, so mucus has to be carried uphill by tiny hairs on the lining to get out, which is why these sinuses clog easily. The usual feeling when inflamed is pressure in the cheeks and an ache that can pass for toothache in the upper teeth.",
  nasal: "The septum is the wall of bone and cartilage that divides the nose into left and right. The turbinates are scroll-shaped shelves on the side walls that warm and moisten the air you breathe. Neither is a sinus, but all the sinuses drain into the passages around them: a bent septum or swollen turbinates narrow those passages. Straightening the septum and shrinking the turbinates are standard operations for long-running sinus trouble.",
  adenoids: "A pad of immune tissue at the very back of the nose, above the throat. Not a sinus. In children it can swell, block the nose and hold on to bacteria that keep re-infecting the sinuses, so removing it is often the first operation tried for a child with repeated sinus infections. It shrinks away on its own in most adults.",
  mastoid: "A honeycomb of air cells in the bone behind each ear. They connect to the middle ear, not to the nose, so they are not sinuses. They turn up in sinus records only because a sinus CT also covers them, and the radiologist notes whether they hold air (normal) or fluid.",
};
export const INFLAMED = "A sinus is a hollow in the bone, lined with a thin moist skin and normally full of air. Inflamed (sinusitis) means that lining is swollen. The swelling narrows or shuts the small drain opening, mucus stays behind, and that causes the pressure and pain. On a CT, air is black: a swollen lining shows as a grey rim along the walls, trapped fluid as a flat level line, and a fully blocked sinus is grey all the way through. A record that only says \"inflamed\" does not tell you which of those it was; this view draws an inflamed sinus in orange with a filled centre.";
// What a record can say about a structure on one date, and the words shown for it.
export const STATES = { clear: "clear", inflamed: "inflamed", surgery: "operated on", removed: "removed", normal: "normal", none: "no record" };
export function colorFor(key, state) {
  if (state === "inflamed") return "#ffb35c";
  if (state === "surgery") return "#ffe066";
  if (state === "removed" || state === "none") return "#8b95b2";
  return key === "nasal" ? "#ff9fb6" : key === "mastoid" ? "#c8a8ff" : key === "adenoids" ? "#ff8a5c" : "#67dcff";
}
export const LOOKS = { glow: "Glow", solid: "Solid", slice: "Slice" };

const C = {
  clear: { color: 0x67dcff, fill: 0x1b6d8c, solid: 0x9ad8ee },      // air-filled, well aerated
  inflamed: { color: 0xffb35c, fill: 0x8a4512, solid: 0xe8743c },   // inflamed: orange, with a filled centre
  unknown: { color: 0x9aa6c0, fill: 0x3a4460, solid: 0x8892aa },    // no record for this date
  core: { color: 0xff6a3d, fill: 0xff5a2a },
  septum: { color: 0xe4ecff, fill: 0x8aa0c8, solid: 0xd9dfec },
  concha: { color: 0xff9fb6, fill: 0x9a4a5c, solid: 0xe79aa8 },
  adenoid: { color: 0xff8a5c, fill: 0x9a3a1c, solid: 0xd9764f },
  mastoid: { color: 0xc8a8ff, fill: 0x5a3a9a, solid: 0xbba6e8 },
  path: { color: 0x5dff9c },                                        // drainage channel recorded as open
  pathQuiet: { color: 0xfff1c4 },                                   // drainage channel the record says nothing about
  surgery: { color: 0xffe066, fill: 0xb08a1a, solid: 0xf0d264 },
};

export function buildSinuses(head, { ortho = false } = {}) {
  const group = new THREE.Group(), parts = [];
  const add = (names, key, kind, order = 0, side = null) => {
    names = [].concat(names).filter(n => head.info.has(n)); if (!names.length) return null;
    const mesh = new THREE.Mesh(names[0] instanceof THREE.BufferGeometry ? names[0] : head.geometry(names), makeMat({ ortho }));
    mesh.frustumCulled = false; mesh.renderOrder = order; group.add(mesh); parts.push({ mesh, key, kind, order, side }); return mesh;
  };
  const anchors = {};
  const centers = names => names.filter(n => head.info.has(n)).map(n => new THREE.Vector3(...head.info.get(n).center));
  for (const key of SINUSES) {               // left and right are separate shapes: a record can differ per side
    for (const side of ["R", "L"]) { add([`${key}_${side}`], key, "cavity", 2, side); add([`${key}_${side}_air`], key, "core", 3, side); }
    anchors[key] = centers([key + "_L", key + "_R"]);
  }
  anchors.sphenoid = [anchors.sphenoid.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / anchors.sphenoid.length)];
  add(["mastoid_R", "mastoid_L"], "mastoid", "cells", 2); anchors.mastoid = centers(["mastoid_L", "mastoid_R"]);
  add(["adenoids"], "adenoids", "adenoid", 2); anchors.adenoids = centers(["adenoids"]);
  add(["vomer", "septal_cartilage", "ethmoid_plate"], "nasal", "septum", 1);
  add(["concha_inferior_R", "concha_inferior_L"], "nasal", "concha-inferior", 2);
  add(["concha_middle_R", "concha_middle_L"], "nasal", "concha", 2);
  { const sc = head.info.get("septal_cartilage"); anchors.nasal = [new THREE.Vector3(0, sc.center[1], sc.min[2] + sc.size[2] * 0.75), ...centers(["concha_inferior_L", "concha_inferior_R"])]; }

  // drainage pathways: maxillary sinus -> middle meatus, and frontal sinus -> frontal recess
  const tubes = pts => { const gs = pts.map(p => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(p.map(q => new THREE.Vector3(...q)), false, "centripetal"), 48, 0.05, 8, false));
    const nv = gs.reduce((s, g) => s + g.attributes.position.count, 0), pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = []; let o = 0;
    for (const g of gs) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); uv.set(g.attributes.uv.array, o * 2); for (const i of g.index.array) idx.push(i + o); o += g.attributes.position.count; }
    const out = new THREE.BufferGeometry(); out.setAttribute("position", new THREE.BufferAttribute(pos, 3)); out.setAttribute("normal", new THREE.BufferAttribute(nor, 3)); out.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); out.setIndex(idx); return out; };
  const mxPaths = [], frPaths = [];
  for (const [side, s] of [["L", 1], ["R", -1]]) {
    const mx = head.info.get("maxillary_" + side), fr = head.info.get("frontal_" + side), top = mx.min[1] + mx.size[1], medial = s > 0 ? mx.min[0] : mx.min[0] + mx.size[0];
    mxPaths.push([[medial + s * 0.5, top - 0.55, mx.center[2] + 0.2], [medial + s * 0.05, top - 0.1, mx.center[2] + 0.45], [medial - s * 0.3, top - 0.25, mx.center[2] + 0.75], [medial - s * 0.4, top - 1.2, mx.center[2] + 0.5], [medial - s * 0.45, top - 2.3, mx.center[2] - 0.3]]);
    const fx = s * Math.min(Math.abs(fr.center[0]), 0.9);
    frPaths.push([[fx, fr.min[1] + 0.35, fr.center[2] - 0.1], [s * 0.85, fr.min[1] - 0.5, fr.center[2] - 0.7], [s * 0.95, fr.min[1] - 1.5, fr.center[2] - 1.1], [medial - s * 0.3, top - 0.15, mx.center[2] + 0.85]]);
  }
  const pMx = new THREE.Mesh(tubes(mxPaths), makeMat({ ortho, mode: 3 })), pFr = new THREE.Mesh(tubes(frPaths), makeMat({ ortho, mode: 3 }));
  for (const [m, f] of [[pMx, "maxillary"], [pFr, "frontal ethmoid"]]) { m.frustumCulled = false; m.renderOrder = 5; m.userData.for = f; group.add(m); parts.push({ mesh: m, key: "drainage", kind: "path", order: 5 }); }

  // ---------------------------------------------------------------- styling
  let focus = "all", look = "glow", cut = 3.0, drainage = "open";   // drainage: "open" (recorded), "unknown" (not in the record) or "" (hidden)
  let states = {};                           // per structure: what the record says for the date being shown (see STATES); a sinus may give { L, R }
  const shown = { frontal: true, ethmoid: true, sphenoid: true, maxillary: true, drainage: true, nasal: true, adenoids: true, mastoid: true };
  function style() {
    const solid = look !== "glow", slice = look === "slice";
    for (const part of parts) {
      const { mesh, key, kind } = part;
      if (kind === "path") {                 // a drainage channel: green and flowing where the record says open, pale and still where it says nothing
        const mine = mesh.userData.for.split(" ").filter(k => shown[k]), open = drainage === "open";
        mesh.visible = !!drainage && shown.drainage && !slice && (focus === "all" ? mine.length > 0 : mine.includes(focus));
        setStyle(mesh.material, { ...(open ? C.path : C.pathQuiet), gain: (focus === "all" ? 0.7 : 1.2) * (open ? 1 : 0.75), mode: 3 }); continue;
      }
      const raw = states[key], st = raw && typeof raw === "object" ? raw[part.side] ?? raw.L : raw;
      const layer = shown[key] !== false, bad = st === "inflamed", op = st === "surgery", gone = st === "removed";
      const on = focus === "all" || focus === key, g = focus === "all" ? 0.9 : on ? 1.3 : 0.14;
      let vis = layer, c, extra = {};
      switch (kind) {
        case "cavity": c = bad ? C.inflamed : st === "none" ? C.unknown : C.clear; extra = { fillAmt: on ? 0.13 : 0.05 }; break;
        case "core": vis = layer && bad && !solid; c = C.core; extra = { fillAmt: on ? 0.3 : 0.1, rimPow: 1.2, gainMul: 0.85 }; break;   // the filled centre of an inflamed sinus
        case "septum": c = op ? C.surgery : C.septum; extra = { fillAmt: 0.03, gainMul: op ? 0.55 : 0.5 }; break;
        case "concha-inferior": c = op ? C.surgery : C.concha; extra = { fillAmt: 0.07 }; break;
        case "concha": c = C.concha; extra = { fillAmt: 0.07, gainMul: 0.9 }; break;
        case "adenoid": c = op ? C.surgery : C.adenoid; extra = { fillAmt: gone ? 0.02 : 0.1, gainMul: gone ? 0.35 : 0.85 }; break;
        case "cells": c = C.mastoid; extra = { fillAmt: 0.1, gainMul: st === "none" ? 0.4 : 1 }; break;
      }
      const u = mesh.material.uniforms;
      if (slice) {
        // slice look: everything is solid and cut by one plane. Air shows dark, like on a CT; an inflamed sinus shows filled.
        const air = kind === "cavity" || kind === "cells", filled = kind === "cavity" && bad, inSlice = layer && kind !== "core" && !(kind === "adenoid" && gone);
        const capColor = air ? (filled ? 0xe8743c : 0x05080d) : kind === "septum" ? (op ? 0xf0d264 : 0xe9edf5) : kind === "adenoid" ? (op ? 0xf0d264 : 0xd9764f) : (op && kind === "concha-inferior" ? 0xf0d264 : 0xd98a98);
        mesh.visible = inSlice;
        setStyle(mesh.material, { color: 0xffffff, fill: air ? (filled ? 0xd9683a : 0x3d6f86) : c.solid ?? c.fill, gain: 1, opacity: 1, mode: 1, cutColor: capColor });
        if (inSlice && !part.cap) { part.cap = makeCap(mesh.geometry, 6 + parts.indexOf(part), { ortho, lift: 0.004 }); group.add(part.cap.group); }
        if (part.cap) { part.cap.group.visible = inSlice; part.cap.set(cut, capColor); }
      } else if (solid) {
        // solid look: opaque, lit shapes; things out of focus (and things that were removed) are drawn as a faint glow instead
        mesh.visible = vis;
        if (on && !gone) setStyle(mesh.material, { color: 0xffffff, fill: c.solid ?? c.fill, gain: 1, opacity: 1, mode: 1 });
        else setStyle(mesh.material, { color: c.color, fill: c.fill, gain: on ? 0.5 : 0.12, opacity: 1, fillAmt: 0.03, rimPow: 2.1, mode: 0 });
      } else { mesh.visible = vis; setStyle(mesh.material, { color: c.color, fill: c.fill, gain: g * (extra.gainMul ?? 1), opacity: 1, fillAmt: extra.fillAmt ?? 0.05, rimPow: extra.rimPow ?? 2.1, mode: 0 }); }
      if (!slice && part.cap) part.cap.group.visible = false;
      mesh.renderOrder = slice ? 30 : part.order;
      u.uCut.value.set(0, 0, 1, slice ? cut : 999);
    }
  }
  style();

  return {
    group, anchors, LEVELS,
    // states: { frontal: "clear" | "inflamed" | { L, R } ... }, drainage: "open" | "unknown" | "",
    // shown: which layers are ticked, focus: "all" or one structure, look: glow | solid | slice
    update(o) {
      if (o.states) states = o.states; if (o.drainage !== undefined) drainage = o.drainage || ""; if (o.shown) Object.assign(shown, o.shown);
      if (o.focus !== undefined) focus = o.focus; if (o.look) look = o.look; if (o.cut !== undefined) cut = o.cut; style();
    },
    setCut(z) { cut = z; for (const p of parts) { p.mesh.material.uniforms.uCut.value.w = look === "slice" ? cut : 999; if (p.cap && look === "slice") p.cap.set(cut); } },
    get cut() { return cut; },
    tick(t) { if (drainage !== "open") t = 0; pMx.material.uniforms.uTime.value = t; pFr.material.uniforms.uTime.value = t; },   // only an open channel flows
    get animated() { return drainage === "open" && (pMx.visible || pFr.visible); },
  };
}
