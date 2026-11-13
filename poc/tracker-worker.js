// Face (and optional hand) tracking off the main thread, so the page keeps drawing smoothly while MediaPipe works.
// Classic worker on purpose: MediaPipe's wasm loader needs importScripts(), which module workers don't have.
//
// in:  { type: "init", mp, faceModel, handModel, fitIds, delegate: "GPU"|"CPU", scale, mode: "face"|"hand" }
//      { type: "frame", id, t, bitmap }            (bitmap is transferred in, and transferred back with the result)
//      { type: "hands", on }
// out: { type: "ready", delegate } | { type: "error", message }
//      { type: "result", id, found, matrix, lms, jaw, finger, ms, bitmap }
//      in hand mode the face is skipped and the result carries hands: [{ lms: Float32Array(63) x,y,z per point, right }]
let vision = null, files = null, face = null, hands = null, handsWanted = false, cfg = null, small = null, sctx = null;
let waiting = null, working = false, ready = false, frameNo = 0, lastFinger = null;

async function makeFace(delegate) {
  return vision.FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: cfg.faceModel, delegate },
    runningMode: "VIDEO", numFaces: 1, outputFacialTransformationMatrixes: true, outputFaceBlendshapes: true });
}
const makeHands = (delegate, n) => vision.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: cfg.handModel, delegate }, runningMode: "VIDEO", numHands: n });
async function ensureHands() {
  if (hands || !handsWanted) return;
  try { hands = await vision.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: cfg.handModel, delegate: cfg.delegate }, runningMode: "VIDEO", numHands: 1 }); }
  catch (e) { try { hands = await vision.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: cfg.handModel, delegate: "CPU" }, runningMode: "VIDEO", numHands: 1 }); } catch (e2) { handsWanted = false; } }
}

function detect(job) {
  const t0 = performance.now();
  let src = job.bitmap;
  if (cfg.scale < 1) {                                   // smaller picture for the tracker (much cheaper without a graphics chip)
    const w = Math.round(job.bitmap.width * cfg.scale), h = Math.round(job.bitmap.height * cfg.scale);
    if (!small || small.width !== w || small.height !== h) { small = new OffscreenCanvas(w, h); sctx = small.getContext("2d"); }
    sctx.drawImage(job.bitmap, 0, 0, w, h); src = small;
  }
  const out = { type: "result", id: job.id, found: false, matrix: null, lms: null, jaw: 0, finger: null, ms: 0, bitmap: job.bitmap };
  if (cfg.mode === "hand") {                             // hand view: both hands, all 21 points of each
    try {
      const hr = hands.detectForVideo(src, job.t), hd = hr.handedness || hr.handednesses || [];
      out.hands = (hr.landmarks || []).map((h, i) => { const a = new Float32Array(63); h.forEach((p, k) => { a[k * 3] = p.x; a[k * 3 + 1] = p.y; a[k * 3 + 2] = p.z; });
        return { lms: a, right: !!(hd[i] && hd[i][0] && hd[i][0].categoryName === "Left") }; });
      out.found = out.hands.length > 0;
    } catch (e) { out.error = String(e && e.message || e); }
    out.ms = performance.now() - t0;
    self.postMessage(out, [job.bitmap]); return;
  }
  try {
    const fr = face.detectForVideo(src, job.t);
    const lms = fr.faceLandmarks && fr.faceLandmarks[0], mat = fr.facialTransformationMatrixes && fr.facialTransformationMatrixes[0];
    if (lms && mat) {
      out.found = true; out.matrix = Float32Array.from(mat.data);
      out.lms = new Float32Array(cfg.fitIds.length * 2); cfg.fitIds.forEach((id, i) => { out.lms[i * 2] = lms[id].x; out.lms[i * 2 + 1] = lms[id].y; });   // the face points the page fits the head to
      const bs = fr.faceBlendshapes && fr.faceBlendshapes[0];
      if (bs) for (const c of bs.categories) if (c.categoryName === "jawOpen") out.jaw = c.score;
    }
    if (hands && handsWanted) {                          // the fingertip: looked for on every second frame, so the face stays fast
      if (frameNo++ % 2 === 0) { const hr = hands.detectForVideo(src, job.t), h = hr.landmarks && hr.landmarks[0]; lastFinger = h ? [h[8].x, h[8].y] : null; }
      out.finger = lastFinger;
    } else lastFinger = null;
  } catch (e) { out.error = String(e && e.message || e); }
  out.ms = performance.now() - t0;
  self.postMessage(out, [job.bitmap]);
}
function pump() {
  if (working || !waiting || !ready) return;
  working = true; const job = waiting; waiting = null;
  detect(job);
  working = false;
  if (waiting) setTimeout(pump, 0);
}

self.onmessage = async e => {
  const m = e.data;
  if (m.type === "init") {
    cfg = m;
    try {
      vision = await import(m.mp + "/vision_bundle.mjs");
      files = await vision.FilesetResolver.forVisionTasks(m.mp + "/wasm");
      if (m.mode === "hand") { try { hands = await makeHands(m.delegate, 2); } catch (err) { cfg.delegate = "CPU"; hands = await makeHands("CPU", 2); } }
      else { try { face = await makeFace(m.delegate); } catch (err) { cfg.delegate = "CPU"; face = await makeFace("CPU"); } }
      ready = true;
      self.postMessage({ type: "ready", delegate: cfg.delegate });
      await ensureHands(); pump();
    } catch (err) { self.postMessage({ type: "error", message: String(err && err.message || err) }); }
  } else if (m.type === "frame") {
    // The page never has more than two frames in flight, so at most one waits here; if a newer one arrives, it wins.
    if (waiting) self.postMessage({ type: "result", id: waiting.id, skipped: true, bitmap: waiting.bitmap }, [waiting.bitmap]);
    waiting = m; pump();
  } else if (m.type === "hands") { handsWanted = m.on; if (vision) await ensureHands(); }
};
