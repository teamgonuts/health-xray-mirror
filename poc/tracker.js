// Feeds camera frames to the tracking worker and hands back results together with the exact frame they belong to,
// so the page can draw the picture and the anatomy from the same moment (no overlay lagging behind the face).
// Falls back to tracking on the main thread if the worker can't start.
const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODELS = "https://storage.googleapis.com/mediapipe-models/";
const FACE_MODEL = MODELS + "face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const HAND_MODEL = MODELS + "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FIT_IDS = [33, 263, 133, 362, 1, 2, 168, 10, 152, 234, 454, 61, 291];

// mode "face" (default) tracks the face, plus one fingertip on request; mode "hand" tracks both hands and nothing else.
export async function createTracker({ video, onResult, software = false, forceMain = false, delegate = null, scale = null, mode = "face" }) {
  const cfg = { type: "init", mp: MP, faceModel: FACE_MODEL, handModel: HAND_MODEL, fitIds: FIT_IDS, mode,
                delegate: delegate || (software ? "CPU" : "GPU"),     // without a graphics chip the "GPU" path is the slow one
                scale: scale || (software ? 0.5 : 1) };
  const stats = { mode: "worker", delegate: cfg.delegate, ms: 0, offered: 0, sent: 0, done: 0, skipped: 0, grabMs: 0 };   // offered = camera frames seen
  let inFlight = 0, nextId = 1, lastDone = 0, running = false, handsOn = false;
  let worker = null, main = null;

  const deliver = r => {
    inFlight--;
    if (r.skipped || r.id < lastDone) { stats.skipped++; r.bitmap.close(); return; }
    lastDone = r.id; stats.done++; stats.ms += (r.ms - stats.ms) * 0.2;
    onResult(r);                                              // the receiver owns r.bitmap and must close it
  };

  if (!forceMain) try {
    worker = new Worker(new URL("./tracker-worker.js", import.meta.url));
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("tracking worker timed out")), 30000);
      worker.onmessage = e => { if (e.data.type === "ready") { clearTimeout(to); stats.delegate = e.data.delegate; res(); } else if (e.data.type === "error") { clearTimeout(to); rej(new Error(e.data.message)); } };
      worker.onerror = e => { clearTimeout(to); rej(new Error(e.message || "tracking worker failed")); };
      worker.postMessage(cfg);
    });
    worker.onmessage = e => { if (e.data.type === "result") deliver(e.data); };
  } catch (err) { console.warn("Tracking worker unavailable, tracking on the main thread instead:", err.message); if (worker) worker.terminate(); worker = null; }

  if (!worker && mode === "hand") {                           // hand view, on the main thread
    stats.mode = "main";
    const vision = await import(MP + "/vision_bundle.mjs"), files = await vision.FilesetResolver.forVisionTasks(MP + "/wasm");
    const mk = d => vision.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: HAND_MODEL, delegate: d }, runningMode: "VIDEO", numHands: 2 });
    let hl; try { hl = await mk(cfg.delegate); } catch (e) { stats.delegate = "CPU"; hl = await mk("CPU"); }
    main = {
      setHands() {},
      detect(job) {
        const t0 = performance.now(), hr = hl.detectForVideo(job.bitmap, job.t), hd = hr.handedness || hr.handednesses || [];
        const hands = (hr.landmarks || []).map((h, i) => { const a = new Float32Array(63); h.forEach((p, k) => { a[k * 3] = p.x; a[k * 3 + 1] = p.y; a[k * 3 + 2] = p.z; });
        return { lms: a, right: !!(hd[i] && hd[i][0] && hd[i][0].categoryName === "Left") }; });
        return { id: job.id, found: hands.length > 0, hands, bitmap: job.bitmap, ms: performance.now() - t0 };
      },
    };
  }
  if (!worker && !main) {                                     // same work, on the main thread
    stats.mode = "main";
    const vision = await import(MP + "/vision_bundle.mjs"), files = await vision.FilesetResolver.forVisionTasks(MP + "/wasm");
    const mk = d => vision.FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: FACE_MODEL, delegate: d }, runningMode: "VIDEO", numFaces: 1,
      outputFacialTransformationMatrixes: true, outputFaceBlendshapes: true });
    let face; try { face = await mk(cfg.delegate); } catch (e) { stats.delegate = "CPU"; face = await mk("CPU"); }
    let hands = null;
    main = {
      async setHands(on) { if (on && !hands) try { hands = await vision.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: HAND_MODEL, delegate: stats.delegate }, runningMode: "VIDEO", numHands: 1 }); } catch (e) {} },
      detect(job) {
        const t0 = performance.now(), out = { id: job.id, found: false, jaw: 0, finger: null, bitmap: job.bitmap };
        const fr = face.detectForVideo(job.bitmap, job.t), lms = fr.faceLandmarks && fr.faceLandmarks[0], mat = fr.facialTransformationMatrixes && fr.facialTransformationMatrixes[0];
        if (lms && mat) { out.found = true; out.matrix = Float32Array.from(mat.data); out.lms = new Float32Array(FIT_IDS.length * 2);
          FIT_IDS.forEach((id, i) => { out.lms[i * 2] = lms[id].x; out.lms[i * 2 + 1] = lms[id].y; });
          const bs = fr.faceBlendshapes && fr.faceBlendshapes[0]; if (bs) for (const c of bs.categories) if (c.categoryName === "jawOpen") out.jaw = c.score; }
        if (hands && handsOn) { const h = hands.detectForVideo(job.bitmap, job.t).landmarks?.[0]; if (h) out.finger = [h[8].x, h[8].y]; }
        out.ms = performance.now() - t0; return out;
      },
    };
  }

  async function onFrame() {
    if (!running) return;
    schedule(); stats.offered++;
    if (inFlight >= (worker ? 2 : 1) || video.readyState < 2) return;
    inFlight++; const id = nextId++, t0 = performance.now();
    let bitmap; try { bitmap = await createImageBitmap(video); } catch (e) { inFlight--; return; }
    stats.sent++; stats.grabMs += (performance.now() - t0 - stats.grabMs) * 0.2;
    const job = { type: "frame", id, t: performance.now(), bitmap };
    if (worker) worker.postMessage(job, [bitmap]); else deliver(main.detect(job));
  }
  const schedule = () => { if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame); else requestAnimationFrame(onFrame); };

  return {
    stats,
    start() { if (!running) { running = true; schedule(); } },
    stop() { running = false; },
    setHands(on) { handsOn = on; if (worker) worker.postMessage({ type: "hands", on }); else main.setHands(on); },
  };
}
export { FIT_IDS };
