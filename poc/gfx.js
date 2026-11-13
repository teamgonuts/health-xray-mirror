// The shared material for anatomy layers.
//   mode 0 = x-ray glow (additive: bright edges, faint fill)      mode 1 = solid, lit
//   mode 2 = veil (flat colour that dims the real face)           mode 3 = flowing dashes along a tube
import * as THREE from "three";

const VERT = `
uniform float uOrtho;
varying vec3 vN; varying vec3 vV; varying vec3 vL; varying vec2 vUv;
void main() {
  vL = position; vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = uOrtho > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform vec3 uColor; uniform vec3 uFill;
uniform float uOpacity, uGain, uMode, uRimPow, uFillAmt, uFeather, uTime;
uniform vec4 uBand;                 // veil band: y from, y to, soft edge, on
uniform vec3 uBoxMin; uniform vec3 uBoxMax; uniform float uBoxOn;   // keep only a box (mirrored in x)
uniform vec4 uCut;                  // cutting plane (normal, offset) in head coordinates; w > 900 = off
uniform vec3 uCutColor;
uniform float uEdge;                // > 0: the rim of the cut glows, over this distance (used for broken bones)
uniform vec3 uEdgeColor;
uniform vec4 uJag;                  // a ragged cut instead of a flat one: xyz = direction across the bone times teeth per unit, w = depth of the teeth

varying vec3 vN; varying vec3 vV; varying vec3 vL; varying vec2 vUv;
void main() {
  if (uBoxOn > 0.5) {
    vec3 q = vec3(abs(vL.x), vL.y, vL.z);
    if (any(lessThan(q, uBoxMin)) || any(greaterThan(q, uBoxMax))) discard;
  }
  bool cutOn = uCut.w < 900.0;
  float cutD = dot(uCut.xyz, vL) - uCut.w;                    // distance past the cutting plane
  if (cutOn && uJag.w != 0.0) { float t = dot(uJag.xyz, vL); cutD -= uJag.w * (0.62 * (abs(fract(t) * 2.0 - 1.0) - 0.5) + 0.38 * (abs(fract(t * 2.3 + 0.37) * 2.0 - 1.0) - 0.5)); }
  if (cutOn && cutD > 0.0) discard;                           // everything in front of the cutting plane is removed
  float edge = (cutOn && uEdge > 0.0) ? exp(cutD / uEdge) : 0.0;
  vec3 n = normalize(vN);
  float ndv = abs(dot(n, normalize(vV)));
  float band = 1.0;
  if (uBand.w > 0.5) band = smoothstep(uBand.x - uBand.z, uBand.x, vL.y) * (1.0 - smoothstep(uBand.y, uBand.y + uBand.z, vL.y));
  if (uMode > 2.5) {                       // flowing dashes along a tube (drainage paths)
    float dash = step(0.45, fract(vUv.x * 9.0 - uTime * 0.9));
    float rim = pow(1.0 - ndv, 1.4);
    gl_FragColor = vec4(uColor, (0.25 + 0.75 * dash) * (0.45 + 0.55 * rim) * uGain * uOpacity);
    return;
  }
  if (uMode > 1.5) {                       // flat veil that dims the real face behind the anatomy
    float soft = uFeather > 0.001 ? smoothstep(0.0, uFeather, ndv) : 1.0;
    gl_FragColor = vec4(uColor, uOpacity * soft * band);
    return;
  }
  float rim = pow(1.0 - ndv, uRimPow);
  if (uMode > 0.5) {                       // solid, lit
    if (cutOn && !gl_FrontFacing) { gl_FragColor = vec4(uCutColor * uGain, uOpacity); return; }   // inside seen through the cut
    vec3 fn = gl_FrontFacing ? n : -n;
    float d = max(dot(fn, normalize(vec3(0.35, 0.55, 0.76))), 0.0);
    float d2 = max(dot(fn, normalize(vec3(-0.6, 0.1, 0.5))), 0.0);
    vec3 c = uFill * (0.30 + 0.62 * d + 0.18 * d2) + uColor * rim * 0.55;
    gl_FragColor = vec4(mix(c * uGain, uEdgeColor, clamp(edge * 1.15, 0.0, 1.0)), uOpacity);
    return;
  }
  // x-ray: glowing edges plus a faint fill so cavities read as volumes
  float a = clamp((uFillAmt + 0.95 * rim) * uGain * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(mix(mix(uFill, uColor, clamp(rim * 1.6, 0.0, 1.0)), uEdgeColor, clamp(edge * 1.2, 0.0, 1.0)), clamp(a + edge * 0.95 * uOpacity, 0.0, 1.0));
}`;

export function makeMat({ color = 0xbfe3ff, fill, gain = 1, opacity = 1, mode = 0, rimPow = 2.1, fillAmt = 0.035, ortho = false } = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uFill: { value: new THREE.Color(fill ?? color) },
      uOpacity: { value: opacity }, uGain: { value: gain }, uMode: { value: -1 }, uRimPow: { value: rimPow },
      uFillAmt: { value: fillAmt }, uFeather: { value: 0.18 }, uOrtho: { value: ortho ? 1 : 0 }, uTime: { value: 0 },
      uBand: { value: new THREE.Vector4(0, 0, 0, 0) },
      uBoxMin: { value: new THREE.Vector3() }, uBoxMax: { value: new THREE.Vector3() }, uBoxOn: { value: 0 },
      uCut: { value: new THREE.Vector4(0, 0, 1, 999) }, uCutColor: { value: new THREE.Color(0x101826) }, uEdge: { value: 0 },
      uEdgeColor: { value: new THREE.Color(0xfff0cc) }, uJag: { value: new THREE.Vector4(0, 0, 0, 0) },

    },
    vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, transparent: true,
  });
  setStyle(m, { mode });
  return m;
}

// Every layer stays in three.js's "transparent" list so that renderOrder alone decides what is drawn over what
// (the veil that dims the face must come before the anatomy, solid or not).
export function setStyle(mat, { color, fill, gain, opacity, mode, fillAmt, rimPow, cutColor } = {}) {
  const u = mat.uniforms;
  if (color !== undefined) u.uColor.value.set(color);
  if (fill !== undefined) u.uFill.value.set(fill);
  if (gain !== undefined) u.uGain.value = gain;
  if (opacity !== undefined) u.uOpacity.value = opacity;
  if (fillAmt !== undefined) u.uFillAmt.value = fillAmt;
  if (rimPow !== undefined) u.uRimPow.value = rimPow;
  if (cutColor !== undefined) u.uCutColor.value.set(cutColor);
  if (mode !== undefined && mode !== u.uMode.value) {
    u.uMode.value = mode;
    mat.blending = mode === 0 || mode === 3 ? THREE.AdditiveBlending : THREE.NormalBlending;
    mat.depthTest = mat.depthWrite = mode === 1;
    mat.needsUpdate = true;
  }

}

// A flat "cut surface" for a closed shape sliced by the cutting plane (the usual stencil technique):
// count the shape's back faces up and its front faces down behind the plane; wherever the count is not zero the
// plane is inside the shape there, so a quad lying in the plane is drawn in the cut colour.
// Returns a group to add next to the shape; call set(cutZ, color) when the plane or colour changes.
export function makeCap(geometry, order, { ortho = false, lift = 0 } = {}) {
  const group = new THREE.Group();
  const counter = (side, op) => { const m = makeMat({ ortho, mode: 1 }); m.side = side; m.colorWrite = false; m.depthWrite = false; m.depthTest = false;
    m.stencilWrite = true; m.stencilFunc = THREE.AlwaysStencilFunc; m.stencilFail = m.stencilZFail = m.stencilZPass = op;
    const mesh = new THREE.Mesh(geometry, m); mesh.frustumCulled = false; group.add(mesh); return mesh; };
  const back = counter(THREE.BackSide, THREE.IncrementWrapStencilOp), front = counter(THREE.FrontSide, THREE.DecrementWrapStencilOp);
  back.renderOrder = order; front.renderOrder = order + 0.1;
  const capMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, depthFunc: THREE.LessEqualDepth,
    stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.ZeroStencilOp, stencilZPass: THREE.ZeroStencilOp });
  const cap = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), capMat); cap.frustumCulled = false; cap.renderOrder = order + 0.2; group.add(cap);
  return { group, set(cutZ, color) { back.material.uniforms.uCut.value.set(0, 0, 1, cutZ); front.material.uniforms.uCut.value.set(0, 0, 1, cutZ); cap.position.z = cutZ + lift; if (color !== undefined) capMat.color.set(color); } };
}
