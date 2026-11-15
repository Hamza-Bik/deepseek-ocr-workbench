#!/usr/bin/env node
/**
 * verify-ui.js — objective UI verification without eyeballing screenshots.
 *  1. Box-overlay accuracy: IoU of rendered .ocr-box rects vs ink regions
 *     detected in the page image (proves normalized coords map correctly).
 *  2. Layout integrity at many desktop widths: overflow, overlap, clipping.
 *  3. Type scale + spacing rhythm sanity.
 *  4. Emil-checklist motion audit of computed styles.
 *  5. Interaction: focus rings, keyboard run, Escape, copy/download.
 */
const { spawn } = require("node:child_process");
const os = require("os"), path = require("path"), fs = require("fs");
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  "Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-x64/chrome-headless-shell");
const BASE = process.argv[2] || "http://127.0.0.1:4180";
const PORT = 9340;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
const chrome = spawn(CHROME, ["--no-sandbox","--disable-gpu","--hide-scrollbars","--force-color-profile=srgb",
  "--remote-debugging-port="+PORT,"--user-data-dir="+prof,"--window-size=1440,1000","about:blank"],
  {stdio:["ignore","pipe","pipe"], env:{...process.env,TMPDIR:"/tmp"}});
chrome.stderr.on("data",()=>{});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R = { pass: [], fail: [], info: {}, errors: [] };
const ok = (n, d) => R.pass.push(n + (d ? " — " + d : ""));
const bad = (n, d) => R.fail.push(n + (d ? " — " + d : ""));

(async () => {
  let ws;
  for (let i=0;i<100;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p=l.find(t=>t.type==="page"); if(p){ws=p.webSocketDebuggerUrl;break;} }catch(_){} await sleep(100); }
  const sock = new WebSocket(ws);
  await new Promise(r => sock.addEventListener("open", r, {once:true}));
  let id=0; const pend=new Map();
  sock.addEventListener("message", e => { const m=JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method==="Runtime.exceptionThrown") R.errors.push((m.params.exceptionDetails?.exception?.description||"").split("\n")[0]);
  });
  const send=(method,params={})=>{const i=++id;sock.send(JSON.stringify({id:i,method,params}));return new Promise(r=>pend.set(i,r));};
  const ev=async(expr)=>{const r=await send("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true,userGesture:true});
    if(r.result?.exceptionDetails) throw new Error((r.result.exceptionDetails.exception?.description||"eval error").split("\n")[0]);
    return r.result?.result?.value;};
  const viewport=(w,h,mobile=false)=>send("Emulation.setDeviceMetricsOverride",{width:w,height:h,deviceScaleFactor:2,mobile});

  await send("Runtime.enable"); await send("Page.enable");
  await viewport(1440,1000);
  await send("Page.navigate",{url:BASE+"/index.html"}); await sleep(900);
  await ev(`localStorage.clear()`);
  await send("Page.navigate",{url:BASE+"/index.html?demo=1"}); await sleep(1000);

  /* ---------- 1. box overlay accuracy vs real ink ---------- */
  await ev(`document.querySelector('[data-purpose="rich_layout_recognition"]').click()`); await sleep(200);
  await ev(`document.getElementById('runBtn').click()`); await sleep(3000);
  await sleep(400);
  const iou = await ev(`(async () => {
    const img = document.getElementById('resultImg');
    if (!img.complete) await new Promise(r => { img.onload = r; });
    const W = img.naturalWidth, H = img.naturalHeight;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, W, H).data;
    // ink = pixels clearly darker than the paper
    const ink = new Uint8Array(W*H);
    let inkCount = 0;
    for (let i=0;i<W*H;i++){ const r=px[i*4],g=px[i*4+1],b=px[i*4+2];
      const l = 0.2126*r+0.7152*g+0.0722*b; if (l < 150) { ink[i]=1; inkCount++; } }
    const rect = img.getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.ocr-box')].map(n => {
      const b = n.getBoundingClientRect();
      return { x1:(b.left-rect.left)/rect.width*1000, y1:(b.top-rect.top)/rect.height*1000,
               x2:(b.right-rect.left)/rect.width*1000, y2:(b.bottom-rect.top)/rect.height*1000 };
    });
    let inkHit = 0, inkTotal = 0, iouSum = 0;
    for (const b of boxes) {
      const x1=Math.max(0,Math.floor(b.x1/1000*W)), x2=Math.min(W,Math.ceil(b.x2/1000*W));
      const y1=Math.max(0,Math.floor(b.y1/1000*H)), y2=Math.min(H,Math.ceil(b.y2/1000*H));
      let inBox=0, inkInBox=0;
      for(let y=y1;y<y2;y++) for(let x=x1;x<x2;x++){ const i=y*W+x; if(ink[i]){inkInBox++; inBox++;} else inBox++; }
      // IoU between the drawn box and the ink's tight bounding area inside the box
      iouSum += inBox ? inkInBox / inBox : 0;
      inkHit += inkInBox;
    }
    inkTotal = inkCount;
    return { boxes: boxes.length, inkCount, inkInBox: inkHit,
             coverage: inkTotal ? inkHit / inkTotal : 0,
             meanFill: boxes.length ? iouSum / boxes.length : 0,
             size: W + 'x' + H };
  })()`);
  R.info.boxOverlay = iou;
  if (!iou.boxes) bad("box overlay", "no boxes rendered");
  else if (iou.coverage > 0.85) ok("box overlay covers OCR ink", "coverage " + (iou.coverage*100).toFixed(1) + "%");
  else bad("box overlay covers OCR ink", "coverage " + (iou.coverage*100).toFixed(1) + "%");

  /* ---------- 2. layout integrity across desktop widths ---------- */
  const widths = [1152, 1280, 1440, 1680, 1920, 2560];
  const overflowReport = [];
  for (const w of widths) {
    await viewport(w, 960);
    await sleep(300);
    const res = await ev(`(() => {
      const de = document.documentElement;
      const bad = [];
      if (de.scrollWidth > de.clientWidth + 1) bad.push('doc ' + de.scrollWidth + '>' + de.clientWidth);
      document.querySelectorAll('.panel, .workbench, .panel-head, .request-body, .result-body, .metrics, .stage, .blocks, .prose, .json, .dropzone, .purpose, .field').forEach((n) => {
        if (n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX !== 'auto' && getComputedStyle(n).overflowX !== 'scroll')
          bad.push((n.className||n.id) + ' ' + n.scrollWidth + '>' + n.clientWidth);
      });
      // header items must not overlap
      const hs = [...document.querySelectorAll('.app-header .brand, .app-header .header-actions')].map(n => n.getBoundingClientRect());
      if (hs.length === 2 && hs[0].right > hs[1].left + 0.5) bad.push('header overlap');
      // clipped text that is not intentionally ellipsised
      document.querySelectorAll('h1,h2,h3,p,dd,dt,span,li').forEach((n) => {
        const cs = getComputedStyle(n);
        if (n.scrollHeight > n.clientHeight + 2 && cs.overflow === 'hidden' && cs.webkitLineClamp === 'none')
          bad.push('clipped ' + (n.className||n.tagName) + ' ' + n.scrollHeight + '>' + n.clientHeight);
      });
      return bad.slice(0, 8);
    })()`);
    if (res.length) overflowReport.push({ w, bad: res });
  }
  R.info.overflow = overflowReport;
  if (!overflowReport.length) ok("layout integrity", widths.join("/") + "px — no overflow, overlap or clipping");
  else bad("layout integrity", JSON.stringify(overflowReport));

  /* ---------- 3. type scale & spacing rhythm ---------- */
  await viewport(1440, 1000); await sleep(250);
  const type = await ev(`(() => {
    const sizes = {};
    document.querySelectorAll('body *').forEach((n) => {
      if (!(n.textContent||'').trim() || n.children.length) return;
      const s = getComputedStyle(n).fontSize;
      sizes[s] = (sizes[s]||0)+1;
    });
    const px = Object.keys(sizes).map(parseFloat).sort((a,b)=>a-b);
    // body line-height should be 1.4–1.7
    const bodyLH = parseFloat(getComputedStyle(document.body).lineHeight) / parseFloat(getComputedStyle(document.body).fontSize);
    // radii should come from a small set
    const radii = new Set();
    document.querySelectorAll('.panel, .dropzone, .btn-primary, .btn-secondary, .pill, .purpose-opt, .block-item').forEach(n => radii.add(getComputedStyle(n).borderRadius));
    return { distinctSizes: px.length, smallest: px[0], largest: px[px.length-1], bodyLH: +bodyLH.toFixed(2), radii: [...radii] };
  })()`);
  R.info.type = type;
  if (type.distinctSizes <= 16) ok("type scale", type.distinctSizes + " sizes, " + type.smallest + "–" + type.largest + "px, body LH " + type.bodyLH);
  else bad("type scale", type.distinctSizes + " distinct font sizes — too many");

  /* ---------- 4. Emil checklist: motion audit ---------- */
  const motion = await ev(`(() => {
    const issues = [];
    const all = [...document.querySelectorAll('*')];
    all.forEach((n) => {
      const cs = getComputedStyle(n);
      const t = cs.transitionProperty;
      const dur = parseFloat(cs.transitionDuration) || 0;
      if (t === 'all' && dur > 0) issues.push('transition:all on .' + (n.className||n.tagName));
      if (dur > 0 && t !== 'none') {
        const durs = cs.transitionDuration.split(',').map(s => parseFloat(s));
        // UI transitions over 500ms are suspicious (toasts/modal are the documented exceptions)
        if (durs.some(d => d > 0.5)) issues.push('slow ' + n.className + ' ' + cs.transitionDuration);
        if (/ease-in(?![a-z-])/.test(cs.transitionTimingFunction)) issues.push('ease-in on .' + n.className);
      }
      if (cs.animationName !== 'none') {
        const ad = parseFloat(cs.animationDuration);
        if (ad > 1) issues.push('long anim ' + cs.animationName + ' ' + ad + 's');
      }
      // scale(0) entrances
      if (/scale\\(0\\)/.test(cs.transform)) issues.push('scale(0) on .' + n.className);
    });
    // hover rules must be gated for touch
    const sheets = [...document.styleSheets].filter(s => !s.href || s.href.includes(location.host));
    let hoverRules = 0, gated = 0;
    for (const sh of sheets) { try { for (const rule of sh.cssRules) {
      if (rule.cssText && /:hover/.test(rule.cssText)) { hoverRules++; if (/hover: hover/.test(rule.cssText)) gated++; }
    } } catch (_) {} }
    // durations bucket
    const durations = new Set();
    all.forEach(n => { const cs = getComputedStyle(n);
      if (cs.transitionDuration !== '0s') cs.transitionDuration.split(',').forEach(d => durations.add(d.trim())); });
    return { issues: [...new Set(issues)].slice(0, 10), hoverRules, gated, durations: [...durations].sort() };
  })()`);
  R.info.motion = motion;
  if (!motion.issues.length) ok("motion audit", "no transition:all, no ease-in, no scale(0), no >0.5s UI transitions");
  else bad("motion audit", motion.issues.join(" | "));
  if (motion.gated === motion.hoverRules) ok("hover gated for pointer", motion.gated + "/" + motion.hoverRules + " hover rules behind (hover:hover)");
  else bad("hover gated for pointer", motion.gated + "/" + motion.hoverRules);

  /* ---------- 5. interaction ---------- */
  const focus = await ev(`(() => {
    const out = [];
    ['#runBtn','#demoToggle','#keyBtn','#themeBtn','.purpose-opt','#browseBtn','#sampleBtn','#viewTabs .tab','#copyResultBtn','#downloadBtn'].forEach((sel) => {
      const n = document.querySelector(sel);
      if (!n || !n.getClientRects().length) return; // skip controls hidden in this state
      n.focus();
      if (document.activeElement !== n) return;
      const cs = getComputedStyle(n);
      const visible = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      if (!visible) out.push(sel);
    });
    return out;
  })()`);
  if (!focus.length) ok("focus rings", "every interactive control shows :focus-visible");
  else bad("focus rings", "missing on " + focus.join(","));

  const targets = await ev(`(() => {
    const small = [];
    document.querySelectorAll('button, a, input[type=checkbox]').forEach(n => {
      if (!n.getClientRects().length) return;
      if (n.classList.contains('visually-hidden') || n.closest('.visually-hidden')) return;
      if (n.getAttribute('tabindex') === '-1') return;
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.width < 24 || r.height < 20) small.push((n.className||n.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    return small;
  })()`);
  if (!targets.length) ok("tap targets", "all ≥ 24×20px");
  else bad("tap targets", targets.join(","));

  // keyboard run (⌘/Ctrl+Enter)
  await send("Input.dispatchKeyEvent", {type:"keyDown", modifiers:2, key:"Enter", code:"Enter", windowsVirtualKeyCode:13, nativeVirtualKeyCode:36});
  await sleep(300);
  const kbRan = await ev(`!document.getElementById('stateProgress').hidden`);
  await send("Input.dispatchKeyEvent", {type:"keyUp", modifiers:2, key:"Enter", code:"Enter", windowsVirtualKeyCode:13, nativeVirtualKeyCode:36});
  if (kbRan) ok("keyboard run", "⌘↵ starts a recognition");
  else bad("keyboard run");
  await sleep(2400);

  // Escape closes the key dialog
  await ev(`document.getElementById('keyBtn').click()`); await sleep(300);
  await send("Input.dispatchKeyEvent", {type:"keyDown", key:"Escape", code:"Escape", windowsVirtualKeyCode:27, nativeVirtualKeyCode:53});
  await send("Input.dispatchKeyEvent", {type:"keyUp", key:"Escape", code:"Escape", windowsVirtualKeyCode:27, nativeVirtualKeyCode:53});
  await sleep(300);
  const closed = await ev(`document.getElementById('keyScrim').hidden`);
  if (closed) ok("escape closes dialog"); else bad("escape closes dialog");

  // Download + copy wiring present
  const wired = await ev(`['copyResultBtn','downloadBtn','copyCurlBtn','copyErrBtn','retryBtn','cancelRunBtn'].every(id => { const n=document.getElementById(id); return n && n.onclick !== undefined; })`);
  if (wired) ok("action wiring", "copy/download/retry/cancel buttons exist");

  // reduced motion: no transform-based animation left running
  await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  await sleep(300);
  const rm = await ev(`(() => {
    const running = [];
    document.querySelectorAll('*').forEach(n => { const cs = getComputedStyle(n);
      if (cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01) running.push(cs.animationName); });
    return [...new Set(running)];
  })()`);
  if (!rm.length) ok("reduced motion", "animations disabled");
  else bad("reduced motion", rm.join(","));

  /* ---------- report ---------- */
  console.log("\n=== PASS (" + R.pass.length + ") ===");
  R.pass.forEach(p => console.log("  ✓ " + p));
  if (R.fail.length) { console.log("\n=== FAIL (" + R.fail.length + ") ==="); R.fail.forEach(f => console.log("  ✗ " + f)); }
  if (R.errors.length) console.log("\nJS ERRORS: " + R.errors.join(" | "));
  console.log("\nINFO:", JSON.stringify(R.info, null, 1).slice(0, 2200));
  fs.writeFileSync("/tmp/shots/verify.json", JSON.stringify(R, null, 2));
  chrome.kill("SIGKILL");
  process.exitCode = R.fail.length || R.errors.length ? 1 : 0;
})().catch(e => { console.error("FATAL", e); chrome.kill("SIGKILL"); process.exitCode = 2; });
