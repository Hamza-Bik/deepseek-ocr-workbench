#!/usr/bin/env node
/**
 * cdp-shots.js — drive the workbench in headless Chrome over CDP.
 * Usage: node tools/cdp-shots.js [baseUrl] [outDir]
 * Produces screenshots for each UI state and prints console errors + assertions.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const BASE = process.argv[2] || "http://127.0.0.1:4180";
const OUT = process.argv[3] || "/tmp/shots";
const CHROME = process.env.CHROME_BIN ||
  path.join(os.homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-x64/chrome-headless-shell");
const PORT = 9330;

fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, "run.log");
try { fs.unlinkSync(LOG); } catch (_) {}
const log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  fs.appendFileSync(LOG, line + "\n");
  try { fs.writeSync(1, line + "\n"); } catch (_) {}
};
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ocrw-prof-"));

const chrome = spawn(CHROME, [
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-crash-reporter",
  "--disable-extensions",
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + profile,
  "--window-size=1440,1000",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: "/tmp" } });

chrome.stderr.on("data", () => {});
let exited = false;
chrome.on("exit", () => { exited = true; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const json = await res.json();
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(120);
  }
  throw new Error("Chrome did not expose a debugging websocket");
}

async function pageTargetWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(120);
  }
  throw new Error("no page target");
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
  static async connect(url) {
    const WebSocket = globalThis.WebSocket;
    const socket = new WebSocket(url);
    await new Promise((res, rej) => {
      socket.addEventListener("open", res, { once: true });
      socket.addEventListener("error", rej, { once: true });
    });
    const cdp = new CDP(socket);
    socket.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const list = cdp.listeners.get(msg.method) || [];
        list.forEach((fn) => fn(msg.params));
      }
    });
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
}

async function main() {
  const wsUrl = await getWsUrl();
  const browser = await CDP.connect(wsUrl);

  // Attach directly to the page websocket: simpler than flat browser sessions.
  await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`).catch(() => {});
  let pageWs = await pageTargetWs();
  const page = await CDP.connect(pageWs);
  const send = (method, params = {}) => page.send(method, params);
  browser.on && void browser;

  const consoleErrors = [];
  const netErrors = [];
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Network.enable");

  page.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error") {
      consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
    }
  });
  page.on("Runtime.exceptionThrown", (p) => {
    consoleErrors.push("EXCEPTION " + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  });
  page.on("Network.loadingFailed", (p) => {
    if (!/favicon/.test(p.type)) netErrors.push(p.type + " " + p.errorText);
  });

  async function goto(url) {
    await send("Page.navigate", { url });
    await sleep(900);
  }
  async function evalJs(expression) {
    const res = await send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result?.value;
  }
  async function shot(name, opts = {}) {
    const { fullPage = false } = opts;
    let clip;
    if (fullPage) {
      const metrics = await send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize || metrics.contentSize;
      clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      await send("Emulation.setDeviceMetricsOverride", {
        width: Math.ceil(size.width), height: Math.ceil(size.height), deviceScaleFactor: 2, mobile: false,
      });
      await sleep(250);
    }
    const res = await send("Page.captureScreenshot", {
      format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}),
    });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(res.data, "base64"));
    if (fullPage) {
      await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
    }
    log("  shot →", name + ".png");
  }
  async function setViewport(width, height, mobile = false) {
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 2, mobile,
    });
    await sleep(320);
  }

  const results = { consoleErrors, netErrors, checks: {} };
  const check = (name, value) => { results.checks[name] = value; };
  const assertNoOverflow = async (label) => {
    const overflow = await evalJs(`(() => {
      const de = document.documentElement;
      const bad = [];
      if (de.scrollWidth > de.clientWidth + 1) bad.push('document scrollWidth ' + de.scrollWidth + ' > ' + de.clientWidth);
      document.querySelectorAll('*').forEach((n) => {
        if (n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX === 'visible' && n.clientWidth > 0) {
          bad.push(n.tagName + '.' + (n.className || '').toString().slice(0,40) + ' ' + n.scrollWidth + '>' + n.clientWidth);
        }
      });
      return bad.slice(0, 6);
    })()`);
    if (overflow.length) log("  ⚠ overflow", label, overflow);
    return overflow;
  };

  log("→ loading app");
  await goto(BASE + "/index.html");
  await evalJs(`localStorage.clear()`);
  await goto(BASE + "/index.html?demo=1");
  await sleep(600);
  await shot("01-empty-light");

  check("title", await evalJs(`document.title`));
  check("demoOn", await evalJs(`document.getElementById('demoToggle').getAttribute('aria-pressed')`));
  check("purposeCount", await evalJs(`document.querySelectorAll('.purpose-opt').length`));

  // Run a demo recognition
  log("→ demo run (success)");
  await evalJs(`document.getElementById('runBtn').click()`);
  await sleep(400);
  await shot("02-progress");
  await sleep(2600);
  check("state", await evalJs(`
    [...document.querySelectorAll('.state')].filter(n => !n.hidden).map(n => n.id).join(',')
  `));
  // text_recognition returns markdown with no tokens: verify the renderer produced real nodes.
  check("mdNodes", await evalJs(`document.querySelectorAll('#proseText .md-table, #proseText .md-h, #proseText .md-p').length`));
  check("mdTableCells", await evalJs(`document.querySelectorAll('#proseText .md-table td, #proseText .md-table th').length`));
  check("mdNoRawHtml", await evalJs(`document.querySelectorAll('#proseText table table, #proseText td td').length`));
  // then switch to rich layout and run again for boxes
  await evalJs(`document.querySelector('[data-purpose="rich_layout_recognition"]').click()`);
  await sleep(150);
  await evalJs(`document.getElementById('retryBtn')?.click() || document.getElementById('runBtn').click()`);
  await sleep(2600);
  check("blockCount", await evalJs(`document.querySelectorAll('.block-item').length`));
  check("boxCount", await evalJs(`document.querySelectorAll('.ocr-box').length`));
  check("blockTypes", await evalJs(`
    [...document.querySelectorAll('.block-type')].map(n => n.textContent).slice(0,6).join(',')
  `));
  check("metrics", await evalJs(`
    ['mPages','mTokens','mElapsed','mBilled'].map(id => document.getElementById(id).textContent).join(' | ')
  `));
  await shot("03-result-document", { fullPage: false });
  await assertNoOverflow("document view");

  // Other views
  for (const [view, name] of [["text", "04-result-text"], ["tokens", "05-result-tokens"], ["json", "06-result-json"]]) {
    await evalJs(`document.querySelector('[data-view="${view}"]').click()`);
    await sleep(320);
    await shot(name);
  }
  await evalJs(`document.querySelector('[data-view="document"]').click()`);
  await sleep(200);

  // Hover a block → box highlight
  const hovered = await evalJs(`(() => {
    const b = document.querySelector('.block-item'); if (!b) return false;
    b.dispatchEvent(new MouseEvent('mouseenter'));
    const active = document.querySelectorAll('.ocr-box[data-active="true"]').length;
    return active === 1 && !document.getElementById('inspect').hidden;
  })()`);
  check("boxHoverSync", hovered);
  check("inspectorVisible", await evalJs(`!document.getElementById('inspect').hidden`));
  await shot("07-block-hover");

  // 429 error scenario
  log("→ demo run (429)");
  await evalJs(`document.querySelector('[data-scenario="busy"]').click(); document.getElementById('runBtn').click();`);
  await sleep(2400);
  check("errTitle429", await evalJs(`document.getElementById('errTitle').textContent`));
  check("errChip429", await evalJs(`document.getElementById('errStatus').textContent`));
  await shot("08-error-429");

  // Timeout scenario
  await evalJs(`document.querySelector('[data-scenario="timeout"]').click(); document.getElementById('retryBtn').click();`);
  await sleep(2400);
  check("errTitleTimeout", await evalJs(`document.getElementById('errTitle').textContent`));
  await shot("09-error-timeout");

  // Key dialog
  await evalJs(`document.querySelector('[data-scenario="success"]').click(); document.getElementById('keyBtn').click();`);
  await sleep(400);
  await shot("10-key-dialog");
  const dialogFocus = await evalJs(`document.activeElement.id`);
  check("dialogAutofocus", dialogFocus);
  await evalJs(`document.getElementById('keyCancelBtn').click()`);
  await sleep(250);

  // Dark theme
  log("→ dark theme");
  await evalJs(`document.getElementById('themeBtn').click(); document.getElementById('retryBtn')?.click();`);
  await sleep(2600);
  await shot("11-result-dark");
  check("theme", await evalJs(`document.documentElement.dataset.theme`));

  // Mobile
  log("→ mobile 390x844");
  await setViewport(390, 844, true);
  await evalJs(`document.getElementById('themeBtn').click()`);
  await sleep(500);
  await shot("12-mobile-result");
  const mobileOverflow = await assertNoOverflow("mobile result");
  check("mobileOverflow", mobileOverflow);
  await setViewport(1440, 1000, false);

  // Cold mobile empty state
  await goto(BASE + "/index.html");
  await evalJs(`localStorage.clear()`);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await goto(BASE + "/index.html");
  await setViewport(390, 844, true);
  await shot("13-mobile-empty");
  await assertNoOverflow("mobile empty");

  // Reduced motion + dark empty
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await goto(BASE + "/index.html");
  await sleep(500);
  await shot("14-empty-dark");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await goto(BASE + "/index.html?demo=1");
  await sleep(600);

  // A11y sanity: labelled controls, focusable actions, no console errors
  check("unlabeledInputs", await evalJs(`
    [...document.querySelectorAll('input')].filter(i => i.type !== 'hidden' && !i.labels?.length && !i.getAttribute('aria-label')).map(i => i.id || i.name).join(',') || 'none'
  `));
  check("buttonsWithoutText", await evalJs(`
    [...document.querySelectorAll('button')].filter(b => !b.textContent.trim() && !b.getAttribute('aria-label')).length
  `));
  check("tabbables", await evalJs(`
    [...document.querySelectorAll('button,input,[href],[tabindex="0"]')].filter(n => !n.disabled).length
  `));

  // Contrast audit over the live DOM (WCAG 2.1 relative luminance, alpha-composited).
  check("contrast", await evalJs(`(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    const rgb = (col) => {
      if (!col || col === 'transparent') return null;
      ctx.fillStyle = '#010203'; ctx.fillStyle = col;
      const norm = ctx.fillStyle;
      if (norm.startsWith('#')) {
        const h = norm.slice(1);
        if (h.length === 6) return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16), a: 1 };
        return null;
      }
      const m = norm.match(/-?[\d.]+/g);
      if (!m || m.length < 3) return null;
      const [r,g,b,a] = m.map(Number);
      return { r, g, b, a: a == null ? 1 : a };
    };
    const over = (fg, bg) => {
      const a = fg.a;
      return { r: fg.r*a + bg.r*(1-a), g: fg.g*a + bg.g*(1-a), b: fg.b*a + bg.b*(1-a), a: 1 };
    };
    const lum = ({r,g,b}) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
      return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b);
    };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
    const rootBg = rgb(getComputedStyle(document.documentElement).backgroundColor) || { r:255,g:255,b:255,a:1 };
    const bgChain = (el) => {
      const layers = [];
      let n = el;
      while (n && n.nodeType === 1) {
        const c = rgb(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0.004) layers.push(c);
        n = n.parentElement;
      }
      let base = rootBg;
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
      return base;
    };
    const fails = [];
    const seen = new Set();
    document.querySelectorAll('p,span,dt,dd,h1,h2,h3,h4,li,summary,label,button,a,code,pre,td,th,b,strong,em').forEach((el) => {
      const txt = (el.textContent || '').trim();
      if (!txt || el.children.length > 0) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      if (el.getClientRects().length === 0) return;
      const fgRaw = rgb(cs.color); if (!fgRaw) return;
      // Gradient text (e.g. nothing currently) and disabled controls are exempt
      if (el.closest('[disabled], .is-decorative')) return;
      const bg = bgChain(el);
      const fg = fgRaw.a < 0.999 ? over(fgRaw, bg) : fgRaw;
      const size = parseFloat(cs.fontSize);
      const large = size >= 18.66 || (size >= 14 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      const r = ratio(fg, bg);
      if (r + 0.01 < need) {
        const key = cs.color + '|' + Math.round(r*20) + '|' + cs.fontSize;
        if (!seen.has(key)) {
          seen.add(key);
          fails.push(txt.slice(0,24) + ' [' + cs.fontSize + '] ' + r.toFixed(2) + '<' + need);
        }
      }
    });
    return fails.length ? fails.slice(0, 12).join(' | ') : 'pass';
  })()`));

  // Parse-layer unit assertions in the page
  check("parser", await evalJs(`(() => {
    const P = window.OCRParse;
    const page = P.parsePage('<｜ref｜>A<｜/ref｜><｜box｜>[[10, 20, 30, 40]]<｜/box｜> tail');
    const out = {
      blocks: page.blocks.length,
      box: page.blocks[0]?.box,
      text: page.text,
      hasTokens: page.hasTokens,
    };
    out.reversed = P.parseCoords('[[90, 80, 10, 5]]');
    out.clamped = P.parseCoords('[[-40, -5, 1200, 9999]]');
    out.noTokens = P.parsePage('plain text only').blocks.length;
    out.malformed = P.parsePage('<｜ref｜>x<｜/ref｜>').blocks.length;
    out.empty = P.parsePage('').text;
    return JSON.stringify(out);
  })()`));

  results.consoleErrors = consoleErrors;
  results.netErrors = netErrors.filter((e) => !/favicon/.test(e));
  log("\n=== CHECKS ===");
  for (const [k, v] of Object.entries(results.checks)) log(k + ":", v);
  if (consoleErrors.length) log("\nCONSOLE ERRORS:\n" + consoleErrors.join("\n"));
  else log("\nno console errors");
  if (results.netErrors.length) log("NET FAILURES:", results.netErrors);

  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
  chrome.kill("SIGTERM");
  await sleep(300);
  if (!exited) chrome.kill("SIGKILL");
  process.exitCode = consoleErrors.length ? 1 : 0;
}

main().catch((err) => {
  log("FAILED:", err.stack || err.message);
  chrome.kill("SIGKILL");
  process.exitCode = 2;
});
