// Speed check for the Health Mirror, run inside the page by:  node tools/testbrowser.mjs eval @tools/bench-live.js
// Starts the camera (the test browser's fake one), then reports for each view how often the face is tracked, how often
// the page gets to draw, and how much the main thread is blocked.
const b = document.getElementById('start');
for (let i = 0; i < 80 && b.disabled; i++) await new Promise(r => setTimeout(r, 100));
if (!document.getElementById('intro').hidden) b.click();
const h = window.__hm;
for (let i = 0; i < 120 && !h.pose.found; i++) await new Promise(r => setTimeout(r, 250));
await new Promise(r => setTimeout(r, 1500));
const c = document.getElementById('gl');
const measure = async (secs = 5) => {
  let raf = 0, done = false; const gaps = []; let last = performance.now();
  (function f() { if (done) return; const t = performance.now(); gaps.push(t - last); last = t; raf++; requestAnimationFrame(f); })();
  const long = []; const po = new PerformanceObserver(l => { for (const e of l.getEntries()) long.push(e.duration); }); po.observe({ type: 'longtask' });
  const s0 = { ...h.tracker.stats }, t0 = performance.now();
  await new Promise(r => setTimeout(r, secs * 1000)); done = true; po.disconnect();
  const s1 = h.tracker.stats, dt = (performance.now() - t0) / 1000; gaps.sort((a, b) => a - b);
  return { trackedPerSec: +((s1.done - s0.done) / dt).toFixed(1), trackMs: +s1.ms.toFixed(1), pageFps: +(raf / dt).toFixed(1), drawnPerSec: h.perf.fps, drawMs: +h.perf.drawMs.toFixed(2),
           worstFrameGapMs: +gaps[gaps.length - 1].toFixed(0), blockedMsPerSec: Math.round(long.reduce((a, b) => a + b, 0) / dt), canvas: c.width + "x" + c.height };
};
const out = { gpu: h.gpuName.replace(/ANGLE \(|, D3D11\)| Direct3D11.*/g, ""), software: h.SOFTWARE, tracker: h.tracker.stats.mode + "/" + h.tracker.stats.delegate, found: h.pose.found };
for (const [name, set] of [["sinus", () => { document.querySelector('#tabs [data-mode=sinus]').click(); h.setFocus('all'); }],
                           ["teeth", () => { document.querySelector('#tabs [data-mode=teeth]').click(); h.selectTooth(46); }]]) {
  set(); await new Promise(r => setTimeout(r, 1200)); out[name] = await measure();
}
return out;
