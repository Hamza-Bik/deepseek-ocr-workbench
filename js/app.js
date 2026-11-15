/* ============================================================
   app.js — OCR Workbench behaviour
   ============================================================ */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ── config ─────────────────────────────────────────────────────────────
     No key is shipped with the page. Each visitor pastes their own, and it is
     kept in this browser's localStorage only. Demo mode needs no key at all.
     ─────────────────────────────────────────────────────────────────────── */
  const ENDPOINT = "https://api.deepseek.com/v1/tools/ocr";
  const LS_KEY = "ocrw.key";
  const LS_THEME = "ocrw.theme";
  const MAX_BYTES = 100 * 1024 * 1024;
  const PRICE_PER_PAGE = 0.225 / 1000;
  const WATCHDOG_MS = 195_000;

  const IMAGE_RE = /^image\/(png|jpeg|webp|gif|bmp|tiff)$/i;
  const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

  /* ── state ─────────────────────────────────────────────── */
  const state = {
    file: null,
    purpose: "text_recognition",
    demo: false,
    scenario: "success",
    key: "",
    keySource: "none", // "user" | "none"
    view: "document",
    page: 0,
    result: null,
    xhr: null,
    running: false,
    startedAt: 0,
    elapsed: 0,
    pdfDoc: null,
    zoom: 1,
    blockIndex: -1,
    blockScope: "block",
  };

  /* ── utils ─────────────────────────────────────────────── */
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return (value < 10 ? value.toFixed(1) : Math.round(value)) + " " + units[i];
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return "—";
    if (ms < 1000) return Math.round(ms) + " ms";
    const s = ms / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 2 : 1) + " s";
    const m = Math.floor(s / 60);
    return m + "m " + Math.round(s % 60) + "s";
  }

  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function extensionOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  function kindOf(file) {
    const ext = extensionOf(file.name);
    if (IMAGE_RE.test(file.type) || IMAGE_EXT.test(file.name)) return "image";
    if (ext === "pdf") return "pdf";
    if (["doc", "docx", "ppt", "pptx"].includes(ext)) return "office";
    return "other";
  }

  /* ── theme ─────────────────────────────────────────────── */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const btn = $("#themeBtn");
    btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    try { localStorage.setItem(LS_THEME, theme); } catch (_) {}
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(LS_THEME); } catch (_) {}
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(saved || (prefersDark ? "dark" : "light"));
    $("#themeBtn").addEventListener("click", () => {
      applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  }

  /* ── toasts ────────────────────────────────────────────── */
  const toastHost = $("#toastHost");
  const activeToasts = new Set();

  function toast(message, opts = {}) {
    const { kind = "ok", action = null, duration = 4200 } = opts;
    // Keep the stack short: never more than 3 at once.
    if (activeToasts.size >= 3) {
      const oldest = activeToasts.values().next().value;
      dismissToast(oldest);
    }
    const node = el("div", "toast");
    node.dataset.kind = kind;
    node.appendChild(el("span", "toast-dot"));
    node.appendChild(el("span", "toast-msg", message));
    if (action) {
      const btn = el("button", "toast-act", action.label);
      btn.type = "button";
      btn.addEventListener("click", () => {
        action.onClick();
        dismissToast(node);
      });
      node.appendChild(btn);
    }
    toastHost.appendChild(node);
    activeToasts.add(node);
    const timer = setTimeout(() => dismissToast(node), duration);
    node._timer = timer;
    return node;
  }

  function dismissToast(node) {
    if (!node || !node.isConnected || node.dataset.leaving === "true") return;
    node.dataset.leaving = "true";
    activeToasts.delete(node);
    clearTimeout(node._timer);
    setTimeout(() => node.remove(), 420);
  }

  /* ── key dialog ────────────────────────────────────────── */
  const keyScrim = $("#keyScrim");
  const keyInput = $("#keyInput");
  let keyReturnFocus = null;

  function readKey() {
    try { return localStorage.getItem(LS_KEY) || ""; } catch (_) { return ""; }
  }

  /** The visitor's own key, or none. There is no shipped fallback key. */
  function setKey(value, status) {
    const typed = value || "";
    state.key = typed;
    state.keySource = typed ? "user" : "none";

    try {
      if (typed) localStorage.setItem(LS_KEY, typed);
      else localStorage.removeItem(LS_KEY);
    } catch (_) {}

    const pill = $("#keyBtn");
    const label = $("#keyState");
    if (!state.key) {
      pill.dataset.key = "missing";
      label.textContent = "missing";
    } else {
      pill.dataset.key = status || "set";
      label.textContent = status === "invalid" ? "rejected" : "saved";
    }
    $("#keyForgetBtn").hidden = !typed;
    updateRunButton();
  }

  function openKeyDialog() {
    const active = document.activeElement;
    keyReturnFocus = active && active !== document.body ? active : $("#keyBtn");
    keyScrim.hidden = false;
    keyInput.value = state.keySource === "user" ? state.key : "";
    keyInput.type = "password";
    $("#keyRevealBtn").textContent = "Show";
    $("#keyRevealBtn").setAttribute("aria-pressed", "false");
    requestAnimationFrame(() => {
      keyInput.focus();
      keyInput.select();
    });
  }

  function closeKeyDialog() {
    keyScrim.hidden = true;
    if (keyReturnFocus && keyReturnFocus.isConnected) keyReturnFocus.focus();
  }

  async function verifyKey(key) {
    // There is no dedicated auth-check endpoint; /models is the cheapest valid call.
    try {
      const res = await fetch("https://api.deepseek.com/models", {
        headers: { Authorization: "Bearer " + key },
      });
      if (res.ok) return { ok: true };
      let message = "HTTP " + res.status;
      try {
        const body = await res.json();
        if (body?.error?.message) message = body.error.message;
      } catch (_) {}
      return { ok: false, message, status: res.status };
    } catch (err) {
      return { ok: false, message: "Network error — " + err.message, network: true };
    }
  }

  /** Keep Tab inside a modal dialog while it is open. */
  function trapFocus(scrim, dialog) {
    scrim.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || scrim.hidden) return;
      const items = $$(
        'button:not([hidden]):not([disabled]), input:not([hidden]):not([disabled]), a[href]',
        dialog
      ).filter((n) => n.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  function initKeyDialog() {
    $("#keyBtn").addEventListener("click", openKeyDialog);
    $("#emptyKeyBtn").addEventListener("click", openKeyDialog);
    $("#keyCloseBtn").addEventListener("click", closeKeyDialog);
    $("#keyCancelBtn").addEventListener("click", closeKeyDialog);
    keyScrim.addEventListener("click", (e) => {
      if (e.target === keyScrim) closeKeyDialog();
    });

    $("#keyRevealBtn").addEventListener("click", (e) => {
      const showing = keyInput.type === "text";
      keyInput.type = showing ? "password" : "text";
      e.currentTarget.textContent = showing ? "Show" : "Hide";
      e.currentTarget.setAttribute("aria-pressed", String(!showing));
      keyInput.focus();
    });

    $("#keyForgetBtn").addEventListener("click", () => {
      setKey("", null);
      keyInput.value = "";
      toast("API key removed from this browser", { kind: "info" });
    });

    $("#keySaveBtn").addEventListener("click", async () => {
      const value = keyInput.value.trim();
      if (!value) {
        keyInput.focus();
        toast("Paste a key first", { kind: "err" });
        return;
      }
      const btn = $("#keySaveBtn");
      btn.disabled = true;
      btn.textContent = "Checking…";
      const check = await verifyKey(value);
      btn.disabled = false;
      btn.textContent = "Save & test";
      if (check.ok) {
        setKey(value, "set");
        closeKeyDialog();
        toast("Key verified — live requests enabled", { kind: "ok" });
      } else if (check.network) {
        setKey(value, "set");
        toast("Couldn’t reach the API — key saved without verifying", { kind: "info" });
      } else {
        setKey(value, "invalid");
        keyInput.focus();
        toast("Key rejected: " + check.message, { kind: "err", duration: 7000 });
      }
    });

    keyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); $("#keySaveBtn").click(); }
    });

    trapFocus(keyScrim, $("#keyDialog"));
  }

  /* ── purpose ───────────────────────────────────────────── */
  function setPurpose(purpose) {
    state.purpose = purpose;
    $$(".purpose-opt").forEach((btn) => {
      btn.setAttribute("aria-checked", String(btn.dataset.purpose === purpose));
    });
    renderCurl();
    updateRunButton();
  }

  function initPurpose() {
    $("#purposeGroup").addEventListener("click", (e) => {
      const btn = e.target.closest(".purpose-opt");
      if (btn) setPurpose(btn.dataset.purpose);
    });
    $("#purposeGroup").addEventListener("keydown", (e) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      const opts = $$(".purpose-opt");
      const i = opts.findIndex((b) => b.dataset.purpose === state.purpose);
      const next = (i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + opts.length) % opts.length;
      setPurpose(opts[next].dataset.purpose);
      opts[next].focus();
    });
  }

  /* ── demo mode ─────────────────────────────────────────── */
  function setDemo(on) {
    state.demo = on;
    const btn = $("#demoToggle");
    btn.setAttribute("aria-pressed", String(on));
    $("#demoRow").hidden = !on;
    updateRunButton();
    renderCurl();
    if (on) {
      if (!state.file) loadSample("samples/report.png", { quiet: true });
      toast("Demo mode — results come from demo/recorded/*.json", { kind: "info" });
    }
  }

  function initDemo() {
    $("#demoToggle").addEventListener("click", () => setDemo(!state.demo));
    $("#demoScenarios").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      state.scenario = chip.dataset.scenario;
      $$("#demoScenarios .chip").forEach((c) => {
        c.setAttribute("aria-pressed", String(c === chip));
      });
    });
  }

  /* ── source file ───────────────────────────────────────── */
  const fileInput = $("#fileInput");
  const dropzone = $("#dropzone");

  function setFile(file) {
    state.file = file;
    state.pdfDoc = null;
    if (file) {
      if (file.size > MAX_BYTES) {
        toast("File is larger than 100 MiB — the API would reject it", { kind: "err" });
      }
      dropzone.dataset.hasFile = "true";
      $("#dzEmpty").hidden = true;
      $("#dzPreview").hidden = false;
      $("#dzFilename").textContent = file.name;
      $("#clearFileBtn").hidden = false;
      $("#fileMeta").hidden = false;
      $("#metaFormat").textContent = (extensionOf(file.name) || "unknown").toUpperCase();
      $("#metaSize").textContent = formatBytes(file.size);
      $("#metaPages").textContent = "…";
      $("#sourceSub").textContent = file.name;
      renderSourcePreview();
      inspectPages(file);
      autoSuggestPurpose(file);
    } else {
      dropzone.dataset.hasFile = "false";
      $("#dzEmpty").hidden = false;
      $("#dzPreview").hidden = true;
      $("#clearFileBtn").hidden = true;
      $("#fileMeta").hidden = true;
      $("#sourceSub").textContent = "no file";
      const img = $("#previewImg");
      if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
      img.hidden = true;
      img.removeAttribute("src");
      $("#previewCanvas").hidden = true;
    }
    updateRunButton();
  }

  function autoSuggestPurpose(file) {
    // Docs: Word/PowerPoint files without images have text extracted directly.
    // That only works under text_recognition, so surface it without overriding a choice.
    const note = $("#purposeFileNote");
    const isOffice = /^(doc|docx|ppt|pptx)$/i.test(extensionOf(file.name));
    if (isOffice) {
      note.hidden = false;
      note.textContent = "Word file without images → text extracted directly (text_recognition only).";
    } else {
      note.hidden = true;
      note.textContent = "";
    }
  }

  function renderSourcePreview() {
    const file = state.file;
    if (!file) return;
    const kind = kindOf(file);
    const img = $("#previewImg");
    const canvas = $("#previewCanvas");
    const fallback = $("#previewFallback");

    img.hidden = true;
    canvas.hidden = true;
    fallback.hidden = true;
    if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
    img.removeAttribute("src");

    if (kind === "image") {
      img.src = URL.createObjectURL(file);
      img.alt = "Preview of " + file.name;
      img.hidden = false;
    } else if (kind === "pdf") {
      canvas.hidden = false;
      renderPdfThumb(file, canvas).catch(() => {
        canvas.hidden = true;
        fallback.hidden = false;
      });
    } else {
      fallback.hidden = false;
    }
  }

  /* pdf.js from a CDN: the page preview is decoration, so a failure is caught
     by the caller and the sheet falls back to a plain file icon. */
  const PDFJS_VERSION = "4.8.69";
  const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;
  let pdfjsPromise = null;

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = (async () => {
      const mod = await import(`${PDFJS_CDN}/pdf.min.mjs`);
      const lib = mod.default && mod.default.getDocument ? mod.default : mod;
      if (!lib.getDocument) throw new Error("pdf.js export shape unexpected");
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
      window.pdfjsLib = lib;
      return lib;
    })().catch((err) => {
      pdfjsPromise = null;
      throw err;
    });
    return pdfjsPromise;
  }

  async function renderPdfThumb(file, canvas) {
    const pdfjs = await loadPdfJs();
    const data = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data }).promise;
    state.pdfDoc = doc;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 360 / viewport.width);
    const scaled = page.getViewport({ scale });
    canvas.width = Math.ceil(scaled.width);
    canvas.height = Math.ceil(scaled.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: scaled }).promise;
  }

  async function inspectPages(file) {
    const kind = kindOf(file);
    const dd = $("#metaPages");
    if (kind === "pdf") {
      try {
        const pdfjs = await loadPdfJs();
        const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        state.pdfDoc = doc;
        dd.textContent = String(doc.numPages);
      } catch (_) {
        dd.textContent = "—";
      }
    } else if (kind === "image") {
      dd.textContent = "1";
    } else {
      dd.textContent = "—";
    }
  }

  function initDropzone() {
    const browse = () => fileInput.click();
    $("#browseBtn").addEventListener("click", browse);
    $("#replaceBtn").addEventListener("click", browse);
    dropzone.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (e.target.closest("figure")) return;
      browse();
    });
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        if (e.target.closest("button")) return;
        e.preventDefault();
        browse();
      }
    });
    fileInput.setAttribute("aria-labelledby", "dzTitle browseBtn");
    dropzone.tabIndex = 0;
    dropzone.addEventListener("focus", () => { dropzone.dataset.focus = "true"; });
    dropzone.addEventListener("blur", () => { dropzone.dataset.focus = "false"; });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) setFile(file);
      fileInput.value = "";
    });

    let depth = 0;
    const isFileDrag = (e) =>
      Array.from(e.dataTransfer?.types || []).includes("Files");

    dropzone.addEventListener("dragenter", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth++;
      dropzone.dataset.drag = "true";
    });
    dropzone.addEventListener("dragover", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    dropzone.addEventListener("dragleave", (e) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) dropzone.dataset.drag = "false";
    });
    dropzone.addEventListener("drop", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      dropzone.dataset.drag = "false";
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        setFile(file);
        toast("Loaded " + file.name, { kind: "ok", duration: 2200 });
      }
    });
    // Dropping anywhere else shouldn't navigate away.
    window.addEventListener("dragover", (e) => { if (isFileDrag(e)) e.preventDefault(); });
    window.addEventListener("drop", (e) => { if (isFileDrag(e)) e.preventDefault(); });

    $("#clearFileBtn").addEventListener("click", () => setFile(null));
    $("#emptySampleBtn").addEventListener("click", () => openSampleMenu($("#emptySampleBtn")));
    $("#sampleBtn").addEventListener("click", (e) => openSampleMenu(e.currentTarget));
  }

  /* ── sample menu ───────────────────────────────────────── */
  const SAMPLES = [
    { path: "samples/bank-statement.pdf", name: "bank-statement.pdf", note: "dense table · PDF" },
    { path: "samples/report.png", name: "report.png", note: "page · PNG" },
    { path: "samples/contract.pdf", name: "contract.pdf", note: "2 pages · PDF" },
    { path: "samples/memo.docx", name: "memo.docx", note: "1 page · DOCX" },
  ];
  let sampleMenu = null;

  function openSampleMenu(anchor) {
    closeSampleMenu();
    const menu = el("div", "menu");
    menu.setAttribute("role", "menu");
    SAMPLES.forEach((sample) => {
      const item = el("button", "menu-item");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.dataset.path = sample.path;
      item.appendChild(el("span", "menu-name", sample.name));
      item.appendChild(el("span", "menu-note", sample.note));
      item.addEventListener("click", () => {
        closeSampleMenu();
        loadSample(sample.path);
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    sampleMenu = menu;

    const rect = anchor.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.left = "0px";
    menu.style.top = "0px";
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.min(window.innerWidth - mw - 8, Math.max(8, rect.left));
    const below = rect.bottom + 6;
    const top = below + mh > window.innerHeight - 8 ? rect.top - mh - 6 : below;
    menu.style.left = left + "px";
    menu.style.top = Math.max(8, top) + "px";
    menu.style.transformOrigin = `${Math.round(rect.left - left + rect.width / 2)}px ${top < rect.top ? "100%" : "0%"}`;
    menu.classList.add("menu--in");

    const items = $$(".menu-item", menu);
    items[0].focus();
    menu.addEventListener("keydown", (e) => {
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      if (e.key === "Escape") { e.preventDefault(); closeSampleMenu(); anchor.focus(); }
    });
    setTimeout(() => {
      window.addEventListener("click", onDocClickForMenu, true);
      window.addEventListener("keydown", onKeyForMenu, true);
    }, 0);
  }

  function onDocClickForMenu(e) {
    if (sampleMenu && !sampleMenu.contains(e.target)) closeSampleMenu();
  }
  function onKeyForMenu(e) {
    if (e.key === "Escape") closeSampleMenu();
  }

  function closeSampleMenu() {
    if (!sampleMenu) return;
    sampleMenu.remove();
    sampleMenu = null;
    window.removeEventListener("click", onDocClickForMenu, true);
    window.removeEventListener("keydown", onKeyForMenu, true);
  }

  async function loadSample(path, opts = {}) {
    try {
      const res = await fetch(path, { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      const blob = await res.blob();
      const name = path.split("/").pop();
      setFile(new File([blob], name, { type: blob.type || guessType(name) }));
      if (!opts.quiet) toast("Loaded sample " + name, { kind: "ok", duration: 2400 });
    } catch (err) {
      toast("Couldn’t load " + path + " — " + err.message, { kind: "err" });
    }
  }

  function guessType(name) {
    const ext = extensionOf(name);
    return {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
      gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
    }[ext] || "application/octet-stream";
  }

  /* ── curl ──────────────────────────────────────────────── */
  function renderCurl() {
    const name = state.file ? state.file.name : "document.pdf";
    const lines = [
      "curl " + ENDPOINT + " \\",
      '  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \\',
      '  -F purpose="' + state.purpose + '" \\',
      '  -F file="@' + name + '"',
    ];
    $("#curlBlock").textContent = lines.join("\n");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (e) {
        return false;
      }
    }
  }

  /* ── run ───────────────────────────────────────────────── */
  function updateRunButton() {
    const btn = $("#runBtn");
    const needsKey = !!state.file && !state.demo && !state.key;
    // "Add API key" has to stay clickable: the label promises an action, so the
    // button opens the key dialog instead of sitting there disabled. Without a
    // file there is nothing to run yet, so it stays disabled in that case.
    btn.disabled = !state.file || state.running;
    const label = $(".btn-label", btn);
    if (!state.file) label.textContent = "Recognize";
    else if (needsKey) label.textContent = "Add API key";
    else label.textContent = "Recognize";
  }

  function setRunning(running) {
    state.running = running;
    $("#runBtn").hidden = running;
    $("#cancelBtn").hidden = !running;
    $("#demoToggle").disabled = running;
  }

  function showState(name) {
    ["Empty", "Progress", "Error", "Result"].forEach((key) => {
      $("#state" + key).hidden = key.toLowerCase() !== name.toLowerCase();
    });
    const isResult = name === "Result";
    $("#viewTabs").hidden = !isResult;
    $("#toolActions").hidden = !isResult;
    if (!isResult) {
      $("#statusChip").hidden = true;
      $("#pageStrip").hidden = true;
    }
  }

  function startTicker() {
    state.startedAt = performance.now();
    $("#progElapsed").textContent = "0.0s";
    const tick = () => {
      if (!state.running) return;
      $("#progElapsed").textContent = ((performance.now() - state.startedAt) / 1000).toFixed(1) + "s";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function setProgress({ title, note, ratio, indeterminate }) {
    if (title) $("#progTitle").textContent = title;
    if (note) $("#progNote").textContent = note;
    const fill = $("#progFill");
    if (indeterminate) {
      fill.dataset.indeterminate = "true";
      fill.style.transform = "";
      $("#progMeter").removeAttribute("aria-valuenow");
    } else {
      fill.dataset.indeterminate = "false";
      fill.style.transform = `scaleX(${Math.max(0.004, Math.min(1, ratio || 0))})`;
      $("#progMeter").setAttribute("aria-valuenow", String(Math.round((ratio || 0) * 100)));
    }
  }

  async function run() {
    if (!state.file || state.running) return;
    if (!state.demo && !state.key) {
      openKeyDialog();
      return;
    }
    closeSampleMenu();
    setRunning(true);
    showState("Progress");
    setProgress({ title: "Prepare", note: "Reading the file and building the multipart body.", ratio: 0.02 });
    startTicker();

    try {
      const payload = state.demo ? await demoResponse() : await liveRequest(state.file, state.purpose);
      finishSuccess(payload);
    } catch (err) {
      finishError(err);
    } finally {
      setRunning(false);
      state.xhr = null;
    }
  }

  function finishSuccess(json) {
    const parsed = window.OCRParse.parseResponse(json);
    state.result = parsed;
    state.page = 0;
    state.elapsed = performance.now() - state.startedAt;
    if (state.zoom !== 1) applyZoom(1);
    const empty = parsed.pages.length > 0 && parsed.pages.every((p) => !(p.plainText || "").trim());
    renderResult();
    showState("Result");
    $("#statusChip").hidden = false;
    $("#statusChip").dataset.kind = empty ? "warn" : "ok";
    $("#statusChip").textContent = empty ? "200 · empty" : "200 · stop";
    if (empty) {
      toast("The service returned an empty page with 200 OK. This happens intermittently — run it again.", {
        kind: "info", duration: 7000,
        action: { label: "Run again", onClick: () => run() },
      });
    } else if (parsed.pages.some((p) => p.finishReason === "length")) {
      toast("Some pages hit the output limit — text may be incomplete", { kind: "info", duration: 6000 });
    }
  }

  function finishError(err) {
    const info = describeError(err);
    renderError(info);
    showState("Error");
    $("#statusChip").hidden = false;
    $("#statusChip").dataset.kind = "err";
    $("#statusChip").textContent = info.status ? info.status + (info.statusText ? " " + info.statusText : "") : "error";
  }

  /** Recorded responses live in demo/recorded/<name>.<text|rich>.json. */
  function demoPathFor() {
    const file = state.file;
    const ext = file ? extensionOf(file.name) : "";
    const name = (file?.name || "").toLowerCase();
    const base = name.includes("bank") ? "bank-statement"
      : ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"].includes(ext) ? "report"
      : ext === "pdf" ? "contract"
      : ["docx", "doc"].includes(ext) ? "memo"
      : "report";
    const shaped = state.purpose === "rich_layout_recognition" ? "rich" : "text";
    return "demo/recorded/" + base + "." + shaped + ".json";
  }

  function demoResponse() {
    return new Promise((resolve, reject) => {
      const delay = 700 + Math.random() * 700;
      const scenario = state.scenario;
      const path = demoPathFor();
      setTimeout(async () => {
        try {
          if (scenario === "busy") {
            const res = await fetch("demo/error-429.json");
            const body = await res.json();
            reject({ kind: "http", status: 429, body });
            return;
          }
          if (scenario === "timeout") {
            const res = await fetch("demo/error-timeout.json");
            const body = await res.json();
            reject({ kind: "http", status: 200, body });
            return;
          }
          const res = await fetch(path, { cache: "no-cache" });
          if (!res.ok) throw new Error(path + " missing (" + res.status + ")");
          resolve(await res.json());
        } catch (err) {
          reject({ kind: "client", message: err.message });
        }
      }, delay);
    });
  }

  /** Real multipart POST with upload progress and streaming-response awareness. */
  function liveRequest(file, purpose) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      state.xhr = xhr;
      xhr.open("POST", ENDPOINT, true);
      xhr.setRequestHeader("Authorization", "Bearer " + state.key);
      xhr.responseType = "text";
      xhr.timeout = WATCHDOG_MS;

      let received = 0;
      let uploaded = false;

      setProgress({
        title: "Upload",
        note: "Sending the file as multipart/form-data. Max 100 MiB.",
        ratio: 0,
      });

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const ratio = e.total ? e.loaded / e.total : 0;
        setProgress({ ratio: ratio * 0.85 });
        if (ratio >= 1 && !uploaded) {
          uploaded = true;
          setProgress({
            title: "Recognize",
            note: "Keep-alive newlines until the result is ready. Recognition can take up to 180s.",
            indeterminate: true,
          });
          $("#heartbeat").setAttribute("data-active", "true");
        }
      };

      xhr.onprogress = (e) => {
        const chunk = xhr.responseText || "";
        received = chunk.length;
        if (!chunk.trim()) {
          // Keep-alive newlines: the job is accepted but not finished.
          $("#heartbeat").setAttribute("data-active", "true");
          setProgress({ indeterminate: true, note: "Recognize — connection alive, result still being built." });
        }
      };

      xhr.onload = () => {
        $("#heartbeat").setAttribute("data-active", "false");
        const text = xhr.responseText || "";
        let body = null;
        try {
          body = JSON.parse(text.trim());
        } catch (_) {
          reject({
            kind: "http",
            status: xhr.status,
            statusText: xhr.statusText,
            raw: text.slice(0, 4000),
            message: "Response was not valid JSON",
          });
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300 && !body?.error) {
          resolve(body);
        } else {
          reject({
            kind: "http",
            status: xhr.status,
            statusText: xhr.statusText,
            body,
            message: body?.error?.message,
          });
        }
      };

      xhr.onerror = () => {
        $("#heartbeat").setAttribute("data-active", "false");
        reject({
          kind: "network",
          message:
            "The browser could not complete the request. Often this is CORS or an offline connection — " +
            "serve this page over http://localhost rather than opening the file directly.",
        });
      };
      xhr.ontimeout = () => {
        $("#heartbeat").setAttribute("data-active", "false");
        reject({
          kind: "timeout",
          message:
            "No response within " + Math.round(WATCHDOG_MS / 1000) + " s. The service caps recognition at 180 s total.",
        });
      };
      xhr.onabort = () => {
        $("#heartbeat").setAttribute("data-active", "false");
        reject({ kind: "abort" });
      };

      const form = new FormData();
      form.append("purpose", purpose);
      form.append("file", file, file.name);
      xhr.send(form);
    });
  }

  /* ── error copy ────────────────────────────────────────── */
  function describeError(err) {
    const out = { title: "Request failed", why: "", message: "", todo: [], status: null, statusText: "", raw: "" };

    if (err.kind === "abort") {
      out.title = "Request cancelled";
      out.why = "The browser closed the request before the result arrived.";
      out.message = "Cancelled by the user";
      out.todo = [
        "A recognition that already started is still billed if it completes.",
        "Running it again counts as a second in-progress recognition.",
      ];
      return out;
    }
    if (err.kind === "network" || err.kind === "timeout") {
      out.title = err.kind === "timeout" ? "Request timed out" : "Couldn’t reach the API";
      out.why = err.message;
      out.message = err.message;
      out.todo = [
        "Serve this UI over http://localhost — file:// origins are blocked by CORS.",
        "Check connectivity to api.deepseek.com.",
        "Large files need up to 180 s; try a smaller file.",
      ];
      return out;
    }

    const status = err.status;
    const body = err.body || null;
    const message = body?.error?.message || err.message || (body ? JSON.stringify(body) : "");
    out.status = status;
    out.statusText = err.kind === "http" ? err.statusText || httpText(status) : "";
    out.message = message || "No message returned";
    out.raw = body ? JSON.stringify(body, null, 2) : err.raw || "";

    switch (status) {
      case 400:
        out.title = "Bad request";
        out.why = "Malformed request: check `purpose` and that the file is readable. 400 is never retried.";
        out.todo = [
          "Send exactly two fields: `file` and `purpose`.",
          "`purpose` must be text_recognition or rich_layout_recognition.",
          "Convert the file to a supported format (PDF, DOCX, PPTX, PNG, JPEG, WebP, GIF, BMP, TIFF).",
        ];
        break;
      case 401:
        out.title = "Key rejected";
        out.why = "DeepSeek did not accept the API key sent in the Authorization header.";
        out.todo = [
          "Paste a valid key from platform.deepseek.com (API key button, top right).",
          "The key is sent straight from this browser — no proxy involved.",
          "Press “Save & test” to verify it before retrying.",
        ];
        break;
      case 402:
        out.title = "Insufficient balance";
        out.why = "The account behind this key has no balance left for OCR.";
        out.todo = [
          "Top up the account on platform.deepseek.com.",
          "OCR bills $0.225 per 1,000 successful pages.",
        ];
        break;
      case 408:
        out.title = "Upload too slow";
        out.why = "The upload has to finish within 120 s, with no pause longer than 30 s.";
        out.todo = ["Use a smaller file or a faster connection.", "Uploads over 100 MiB are rejected with 413."];
        break;
      case 413:
        out.title = "File too large";
        out.why = "The API accepts files of at most 100 MiB.";
        out.todo = ["Split the document or downsample the image.", "The limit is checked on the actual file, not its extension."];
        break;
      case 429:
        out.title = "Too many recognitions";
        out.why = "Concurrency limit: 15 recognitions already in progress for this account.";
        out.todo = [
          "Wait for running jobs to finish before sending more.",
          "Counts are separate from chat-model requests and include disconnected jobs.",
        ];
        break;
      case 500:
        out.title = "Server error";
        out.why = "The file could not be uploaded or submitted for recognition.";
        out.todo = ["Retry once — this is sometimes transient.", "If it persists, the file may be unreadable."];
        break;
      case 503:
        out.title = "Service busy";
        out.why = "The OCR service is temporarily unavailable.";
        out.todo = ["Retry in a moment.", "This is transient and safe to retry."];
        break;
      case 504:
        out.title = "Timed out upstream";
        out.why = "The upload and submission took longer than the total time budget.";
        out.todo = ["Send a smaller file.", "Retry once the service is less busy."];
        break;
      case 200:
        out.title = body?.error?.code === "gateway_timeout_error" ? "Recognition timed out" : "Recognition failed";
        out.why = "The status is 200 because recognition had already started, but the body is an error object instead of a result.";
        out.todo = [
          "Send a smaller file — recognition is capped at 180 s.",
          "Check the message for password protection or unreadable pages.",
        ];
        break;
      default:
        out.why = "Unexpected response from the OCR service.";
        out.todo = ["Raw response is below.", "Check api-docs.deepseek.com for the current contract."];
    }

    const code = body?.error?.code || "";
    if (code) out.todo.unshift("`code`: " + code);
    return out;
  }

  function httpText(status) {
    return {
      400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 408: "Request Timeout",
      413: "Content Too Large", 429: "Too Many Requests", 500: "Internal Server Error",
      503: "Service Unavailable", 504: "Gateway Timeout",
    }[status] || "";
  }

  function renderError(info) {
    $("#errTitle").textContent = info.title;
    $("#errWhy").textContent = info.why;
    $("#errMsg").textContent = info.message;
    const chip = $("#errStatus");
    if (info.status) {
      chip.hidden = false;
      chip.textContent = String(info.status) + (info.statusText ? " " + info.statusText : "");
    } else {
      chip.hidden = true;
    }
    const todo = $("#errTodo");
    todo.innerHTML = "";
    info.todo.forEach((line) => todo.appendChild(el("li", null, line)));
    const raw = $("#errRaw");
    raw.textContent = info.raw || info.message;
    $("#stateError").dataset.status = info.status || "";
  }

  /* ── rendering the result ──────────────────────────────── */
  function renderResult() {
    const r = state.result;
    if (!r) return;
    pageBaseSize = null;
    const page = r.pages[state.page] || r.pages[0] || null;

    $("#mPages").textContent = r.isAnswer ? "—" : String(r.pageCount || r.pages.length);
    const usage = r.usage || {};
    const total = usage.total_tokens ?? ((usage.input_tokens || 0) + (usage.output_tokens || 0));
    $("#mTokens").textContent = Number.isFinite(total) && total ? Number(total).toLocaleString() : "—";
    $("#mTokens").title = usage
      ? `in ${usage.input_tokens ?? "—"} · out ${usage.output_tokens ?? "—"}`
      : "not reported";
    $("#mElapsed").textContent = formatDuration(state.elapsed);
    $("#mBilled").textContent = "$" + ((r.pageCount || 0) * PRICE_PER_PAGE).toFixed(5);

    const warn = $("#warnBanner");
    const truncated = r.pages.filter((p) => p.finishReason === "length").length;
    const dup = detectTableDuplication(r.raw);
    if (truncated) {
      warn.hidden = false;
      $("#warnText").textContent =
        truncated + " of " + r.pages.length + " pages hit the output limit, so their text is incomplete.";
    } else if (dup.cells >= 3) {
      warn.hidden = false;
      $("#warnText").textContent =
        "This page has " + dup.cells + " duplicated table cell" + (dup.cells === 1 ? "" : "s") +
        (dup.nested ? " and nested tables" : "") +
        ". Dense tabular documents like statements often read more cleanly with text_recognition.";
    } else if (r.pages.length && r.pages.every((p) => !(p.plainText || "").trim())) {
      warn.hidden = false;
      $("#warnText").textContent =
        "200 OK with empty page text. The service intermittently returns a blank result — running the same file again usually fixes it.";
    } else if (r.purpose === "rich_layout_recognition" && !r.hasAnyTokens) {
      warn.hidden = false;
      $("#warnText").textContent =
        "rich_layout_recognition normally returns ｜ref｜/｜box｜ tokens, but this response has none — the layout may have been extracted as plain text.";
    } else {
      warn.hidden = true;
    }

    const tabs = $("#viewTabs");
    if (r.isAnswer) {
      const docTab = tabs.querySelector('[data-view="document"]');
      const tokTab = tabs.querySelector('[data-view="tokens"]');
      if (docTab) docTab.hidden = true;
      if (tokTab) tokTab.hidden = true;
      if (state.view === "document" || state.view === "tokens") state.view = "text";
      $("#boxesToggle").closest(".switch").hidden = true;
    } else {
      tabs.querySelectorAll(".tab").forEach((t) => { t.hidden = false; });
      $("#boxesToggle").closest(".switch").hidden = false;
    }
    renderPageStrip();
    if (!r.isAnswer) renderDocumentView(page);
    renderTextView();
    if (!r.isAnswer) renderTokensView();
    renderJsonView();

    const fmt = page ? page.format : "none";
    // Lead with what a human reads; the UUID goes in the title attribute.
    const meta = r.isAnswer
      ? [r.raw?.model, r.raw?.stop_reason]
      : [
          r.purpose || null,
          r.hasAnyTokens ? (fmt === "typed" ? "typed tokens" : "inline tokens") : "no tokens",
          window.OCRParse.formatCreated(r.created) || null,
        ];
    const metaText = meta.filter(Boolean).join("  ·  ");
    $("#stageMeta").textContent = metaText;
    $("#stageMeta").title = r.isAnswer
      ? [r.raw?.id].filter(Boolean).join("  ·  ")
      : [r.id, r.purpose].filter(Boolean).join("  ·  ");
    setView(state.view);
  }

  /** rich_layout can emit <table><table> with each cell repeated twice on dense grids. */
  function detectTableDuplication(json) {
    const pages = json?.pages || [];
    let cells = 0;
    let nested = false;
    pages.forEach((page) => {
      const text = page?.text || "";
      if (/<table\b[^>]*>\s*<table\b/i.test(text)) nested = true;
      // "TITULAIRE DU COMPTETITULAIRE DU COMPTE" — same string twice in one cell
      const re = /<td>([^<]{2,80}?)\1<\/td>/g;
      let m;
      while ((m = re.exec(text)) !== null) cells++;
    });
    return { cells, nested };
  }

  function renderPageStrip() {
    const strip = $("#pageStrip");
    const r = state.result;
    strip.innerHTML = "";
    if (!r || r.pages.length <= 1) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    r.pages.forEach((page, i) => {
      const btn = el("button", "page-tab", String(i + 1));
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(i === state.page));
      if (page.finishReason === "length") btn.title = "Output truncated on this page";
      if (page.finishReason === "length") btn.dataset.truncated = "true";
      btn.addEventListener("click", () => {
        state.page = i;
        renderResult();
      });
      strip.appendChild(btn);
    });
  }

  /**
   * Human-readable one-liner for a block. The service returns Markdown and, for
   * tables, raw (sometimes nested and duplicated) HTML — that belongs in the
   * Tokens/JSON views, not on a card or in the inspector.
   */
  function blockPreview(block) {
    if (!block) return "(empty)";
    const isTable = block.type === "table" || /<table\b/i.test(block.text || "");

    if (isTable) {
      // Prefer the structured rows so a table reads as a table: its header row
      // and how big it is, not a wall of HTML or of joined cells.
      const rows = block.tableRows?.length
        ? block.tableRows
        : String(block.prose ?? "")
            .split("\n")
            .map((line) => line.split(" · ").filter(Boolean))
            .filter((cells) => cells.length);
      if (!rows.length) return "(empty table)";
      const header = rows[0].join(" · ");
      const rest = rows.length - 1;
      return rest > 0 ? `${header}  +${rest} row${rest === 1 ? "" : "s"}` : header;
    }

    const text = String(block.prose ?? block.text ?? "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/?[a-z][^>]*>/gi, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();

    return text || "(empty)";
  }

  function renderDocumentView(page) {
    const sheet = $("#resultSheet");
    const layer = $("#boxLayer");
    const img = $("#resultImg");
    const canvas = $("#resultCanvas");
    const fallback = $("#resultFallback");
    layer.innerHTML = "";
    sheet.style.aspectRatio = "";

    img.hidden = true;
    canvas.hidden = true;
    fallback.hidden = true;
    if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
    img.removeAttribute("src");

    const file = state.file;
    const kind = file ? kindOf(file) : "none";

    if (kind === "image" && file) {
      img.src = URL.createObjectURL(file);
      img.alt = "Page preview";
      img.hidden = false;
      img.onload = () => {
        positionBoxes(page.blocks, sheet);
        settleZoom();
      };
    } else if (kind === "pdf" && file) {
      canvas.hidden = false;
      sheet.style.aspectRatio = "0.7071";
      renderPdfPage(file, state.page, canvas)
        .then(() => {
          positionBoxes(page.blocks, sheet);
          settleZoom();
        })
        .catch(() => {
          canvas.hidden = true;
          sheet.style.aspectRatio = "0.7071";
          positionBoxes(page.blocks, sheet);
          settleZoom();
        });
    } else {
      fallback.hidden = false;
      sheet.style.aspectRatio = "0.7071";
      positionBoxes(page.blocks, sheet);
      settleZoom();
    }

    const list = $("#blocksList");
    list.innerHTML = "";
    resetInspector();
    if (!page.blocks.length) {
      const note = el("p", "blocks-empty");
      note.innerHTML = page.hasTokens
        ? "Tokens came back but no boxes could be parsed."
        : "No box tokens on this page — the response is plain text. See the Text tab.";
      list.appendChild(note);
      return;
    }
    page.blocks.forEach((block, i) => {
      const btn = el("button", "block-item");
      btn.type = "button";
      btn.style.setProperty("--i", String(Math.min(i, 12)));
      const isTable = block.type === "table";
      if (page.format === "typed") {
        const top = el("span", "block-top");
        top.appendChild(el("span", "block-type", block.type || "block"));
        if (block.box) {
          const { x1, y1, x2, y2 } = block.box;
          const meta = isTable && block.tableRows?.length
            ? `[[${x1}, ${y1}, ${x2}, ${y2}]] · ${block.tableRows.length} rows`
            : `[[${x1}, ${y1}, ${x2}, ${y2}]]`;
          top.appendChild(el("span", "block-coords", meta));
        }
        btn.appendChild(top);
      }
      // Show the readable form, never the raw <table> markup: the Tokens and
      // JSON tabs are where the unmodified service output belongs.
      btn.appendChild(el("span", "block-text", blockPreview(block)));
      if (page.format !== "typed") {
        if (block.box) {
          const { x1, y1, x2, y2 } = block.box;
          btn.appendChild(el("span", "block-coords", `[[${x1}, ${y1}, ${x2}, ${y2}]]`));
        } else {
          btn.appendChild(el("span", "block-coords", "no box"));
        }
      }
      btn.title = blockIsTable(block) ? "Open table preview" : "Open full text";
      btn.addEventListener("click", () => {
        state.blockIndex = i;
        activateBlock(i);
        openBlockDialog(block);
      });
      btn.addEventListener("mouseenter", () => hoverBlock(i, true));
      btn.addEventListener("mouseleave", () => hoverBlock(i, false));
      btn.addEventListener("focus", () => activateBlock(i));
      list.appendChild(btn);
    });
  }

  function settleZoom() {
    requestAnimationFrame(() => {
      capturePageBase();
      applyZoom(state.zoom);
    });
  }

  async function renderPdfPage(file, index, canvas) {
    const pdfjs = await loadPdfJs();
    const doc = state.pdfDoc && state.pdfDoc.numPages ? state.pdfDoc : await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    state.pdfDoc = doc;
    const page = await doc.getPage(Math.min(index + 1, doc.numPages));
    const base = page.getViewport({ scale: 1 });
    const targetWidth = 1000;
    const viewport = page.getViewport({ scale: targetWidth / base.width });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  }

  function positionBoxes(blocks, sheet) {
    const layer = $("#boxLayer");
    layer.innerHTML = "";
    const boxed = blocks.filter((b) => b.box);
    boxed.forEach((block) => {
      const { x1, y1, x2, y2 } = block.box;
      const node = el("div", "ocr-box");
      node.dataset.index = String(block.index);
      node.style.left = x1 / 10 + "%";
      node.style.top = y1 / 10 + "%";
      node.style.width = (x2 - x1) / 10 + "%";
      node.style.height = (y2 - y1) / 10 + "%";
      layer.appendChild(node);
    });
    layer.dataset.hidden = $("#boxesToggle").checked ? "false" : "true";
  }

  /* ── block detail: full text, or the parsed table ─────────────────────── */
  const blockScrim = $("#blockScrim");
  let blockReturnFocus = null;
  let blockRefUrl = null;
  let blockRefToken = 0;
  let openBlockCtx = null;

  function blockIsTable(block) {
    return block?.type === "table" || /<table\b/i.test(block?.text || "");
  }

  function blockRows(block) {
    if (block?.tableRows?.length) return block.tableRows;
    return String(block?.prose || "")
      .split("\n")
      .map((line) => line.split(" · ").filter(Boolean))
      .filter((cells) => cells.length);
  }

  function renderBlockTable(rows, target) {
    if (!rows.length) {
      target.appendChild(el("p", "block-empty", "No table rows could be parsed from this block."));
      return;
    }
    const table = el("table", "md-table");
    const head = el("thead");
    const body = el("tbody");
    rows.forEach((cells, r) => {
      const tr = el("tr");
      cells.forEach((cell) => {
        const node = el(r === 0 ? "th" : "td", null, cell);
        if (r === 0) node.setAttribute("scope", "col");
        tr.appendChild(node);
      });
      (r === 0 ? head : body).appendChild(tr);
    });
    table.appendChild(head);
    table.appendChild(body);
    target.appendChild(table);
  }

  /**
   * The page the block was read from, shown beside the extracted result so the
   * two can be compared without closing the dialog and losing your place.
   */
  async function renderBlockRef(block) {
    const stage = $("#blockRefStage");
    const meta = $("#blockRefMeta");
    const token = String(++blockRefToken);
    stage.innerHTML = "";
    meta.textContent = "";

    if (blockRefUrl) { URL.revokeObjectURL(blockRefUrl); blockRefUrl = null; }

    const file = state.file;
    const kind = file ? kindOf(file) : "none";
    const sheet = el("div", "block-ref-sheet");

    if (kind === "image" && file) {
      const url = URL.createObjectURL(file);
      blockRefUrl = url;
      const img = el("img");
      img.alt = "Source page";
      img.src = url;
      img.addEventListener("load", () => {
        if (token !== String(blockRefToken)) return;
        sheet.style.setProperty("--ref-ratio", img.naturalWidth / img.naturalHeight);
        meta.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
      });
      sheet.appendChild(img);
    } else if (kind === "pdf" && file) {
      const canvas = el("canvas");
      sheet.appendChild(canvas);
      meta.textContent = `page ${state.page + 1}`;
      try {
        await renderPdfPage(file, state.page, canvas);
        if (token !== String(blockRefToken)) return;
        sheet.style.setProperty("--ref-ratio", canvas.width / canvas.height);
      } catch (_) {
        if (token !== String(blockRefToken)) return;
        stage.innerHTML = "";
        stage.appendChild(el("p", "block-ref-empty",
          "The page preview could not be rendered. Use the Document tab to inspect it."));
        return;
      }
    } else {
      // Word/PowerPoint and other types have no client-side renderer: say so
      // instead of showing an empty pane that looks broken.
      stage.appendChild(el("p", "block-ref-empty",
        "No page preview for this file type — see the Document tab for the page."));
      return;
    }

    stage.appendChild(sheet);
    requestAnimationFrame(() => {
      if (token !== String(blockRefToken)) return;
      drawRefBox(sheet, block);
      captureRefBase();
      applyRefZoom(refZoom);
    });
  }

  /**
   * The selected block's box on the page. Only ever one, and only when the
   * "Box" switch is on — the pane is for reading the page, not for a second
   * overlay.
   */
  function drawRefBox(sheet, block) {
    const existing = sheet.querySelector(".block-ref-box");
    if (existing) existing.remove();
    const box = block?.box;
    if (!box) return;
    const { x1, y1, x2, y2 } = box;
    const node = el("div", "block-ref-box");
    node.style.left = x1 / 10 + "%";
    node.style.top = y1 / 10 + "%";
    node.style.width = (x2 - x1) / 10 + "%";
    // A flat box would be invisible; keep a hairline minimum.
    node.style.height = Math.max(0.6, (y2 - y1) / 10) + "%";
    sheet.appendChild(node);
    setRefBoxes($("#refBoxesToggle").checked);
  }

  const LS_REF_BOXES = "ocrw.refBoxes";

  function setRefBoxes(on) {
    const sheet = $("#blockRefStage .block-ref-sheet");
    if (sheet) sheet.dataset.boxes = String(on);
    $("#refBoxesToggle").checked = on;
    try { localStorage.setItem(LS_REF_BOXES, on ? "1" : "0"); } catch (_) {}
  }

  function setBlockRefVisible(on) {
    $("#blockRef").hidden = !on;
    const toggle = $("#blockRefToggle");
    toggle.setAttribute("aria-pressed", String(on));
    toggle.textContent = on ? "Hide" : "Show";
  }

  /* Page zoom inside the block dialog. `zoom` (not transform: scale) is used so
     the sheet keeps its own layout width and simply grows or shrinks, which is
     what makes the stage scroll to the zoomed size. */
  const REF_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  let refZoom = 1;
  let refBaseW = null; // the sheet's fitted width at 100%

  /** Measure the fitted sheet so zoom scales the real rendered size. */
  function captureRefBase() {
    const sheet = $("#blockRefStage .block-ref-sheet");
    if (!sheet) return;
    sheet.style.width = "";
    sheet.style.maxWidth = "";
    const w = sheet.getBoundingClientRect().width;
    if (w > 20) refBaseW = Math.round(w);
  }

  function applyRefZoom(zoom) {
    refZoom = zoom;
    const sheet = $("#blockRefStage .block-ref-sheet");
    if (sheet && refBaseW && Math.abs(zoom - 1) > 0.001) {
      // Explicit width, not max-width, so a zoomed page overflows and the
      // stage can scroll to the part you want to read.
      sheet.style.width = Math.round(refBaseW * zoom) + "px";
      sheet.style.maxWidth = "none";
    } else if (sheet) {
      sheet.style.width = "";
      sheet.style.maxWidth = "";
    }
    $("#refZoomValue").textContent = Math.round(zoom * 100) + "%";
    $("#refZoomOut").disabled = zoom <= REF_ZOOM_STEPS[0];
    $("#refZoomIn").disabled = zoom >= REF_ZOOM_STEPS[REF_ZOOM_STEPS.length - 1];
  }

  function stepRefZoom(direction) {
    const i = REF_ZOOM_STEPS.indexOf(
      REF_ZOOM_STEPS.reduce(
        (best, step) => (Math.abs(step - refZoom) < Math.abs(best - refZoom) ? step : best), 1)
    );
    const next = Math.min(REF_ZOOM_STEPS.length - 1, Math.max(0, i + direction));
    applyRefZoom(REF_ZOOM_STEPS[next]);
  }

  function setBlockView(view) {
    $$("#blockTabs .tab").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.blockView === view));
    });
    $("#blockRendered").hidden = view !== "rendered";
    $("#blockRaw").hidden = view !== "raw";
    // Raw always shows the opened block, so it switches the scope back.
    if (view === "raw" && state.blockScope === "document") {
      setBlockScope("block", openBlockCtx);
    }
  }

  function openBlockDialog(block) {
    if (!block) return;
    blockReturnFocus = document.activeElement;
    const isTable = blockIsTable(block);
    const rows = isTable ? blockRows(block) : [];
    openBlockCtx = { block, rows, isTable };

    $("#blockKind").textContent = block.type || "block";
    $("#blockTitle").textContent = isTable ? "Table preview" : "Block text";

    const meta = [];
    if (block.box) {
      meta.push(`[[${block.box.x1}, ${block.box.y1}, ${block.box.x2}, ${block.box.y2}]]`);
    }
    if (isTable) {
      const cols = rows.reduce((max, cells) => Math.max(max, cells.length), 0);
      meta.push(`${rows.length} row${rows.length === 1 ? "" : "s"} × ${cols} col${cols === 1 ? "" : "s"}`);
    } else {
      const chars = (block.prose || block.text || "").length;
      meta.push(`${chars.toLocaleString()} characters`);
    }
    $("#blockMeta").textContent = meta.join("  ·  ");

    $("#blockRaw").textContent = block.text || "(empty)";
    // Scope starts on the opened block every time; the button is only useful
    // when the response actually has pages to show.
    setBlockScope("block", { block, rows, isTable });
    $("#blockScopeBtn").hidden = !state.result || state.result.isAnswer;
    setBlockView("rendered");
    // The page pane is open by default; it collapses below the stack
    // breakpoint so the result is not squeezed on a narrow screen.
    setBlockRefVisible(!window.matchMedia("(max-width: 860px)").matches);
    refBaseW = null;
    applyRefZoom(1);
    renderBlockRef(block);
    blockScrim.hidden = false;
    requestAnimationFrame(() => $("#blockDialog").focus());
  }

  /* The result pane shows either the single block that was opened or the OCR of
     the whole document. `state.blockScope` is the source of truth so a tab
     switch or a re-render does not lose it. */
  function setBlockScope(scope, ctx) {
    state.blockScope = scope;
    const btn = $("#blockScopeBtn");
    btn.setAttribute("aria-pressed", String(scope === "document"));
    btn.textContent = scope === "document" ? "This block" : "Whole document";
    btn.title = scope === "document"
      ? "Back to the block you opened"
      : "Show the OCR of every page, not just this block";

    if (scope === "document") {
      renderBlockDoc();
    } else {
      const { block, rows, isTable } = ctx || {};
      if (!block) return;
      const rendered = $("#blockRendered");
      rendered.innerHTML = "";
      if (isTable) {
        renderBlockTable(rows, rendered);
        rendered.appendChild(el("p", "block-dialog-note",
          "Rendered from the parsed cells. The Raw tab shows exactly what the service returned."));
      } else {
        rendered.appendChild(el("div", "block-text-full", block.prose || block.text || "(empty)"));
      }
    }
    // The Raw tab only describes the opened block, so it cannot inherit the
    // document scope — fall back to Rendered when leaving the block view.
    if (scope === "document" && !$("#blockRaw").hidden) setBlockView("rendered");
  }

  function closeBlockDialog() {
    blockScrim.hidden = true;
    if (blockRefUrl) { URL.revokeObjectURL(blockRefUrl); blockRefUrl = null; }
    blockRefToken++;
    $("#blockRefStage").innerHTML = "";
    openBlockCtx = null;
    state.blockScope = "block";
    const index = state.blockIndex;
    state.blockIndex = -1;
    if (blockReturnFocus && blockReturnFocus.isConnected && blockReturnFocus !== document.body) {
      blockReturnFocus.focus();
      return;
    }
    const card = $$(".block-item")[index];
    if (card) card.focus();
  }

  function initBlockDialog() {
    let boxesOn = false;
    try { boxesOn = localStorage.getItem(LS_REF_BOXES) === "1"; } catch (_) {}
    $("#refBoxesToggle").checked = boxesOn;

    blockScrim.addEventListener("click", (e) => {
      if (e.target === blockScrim) closeBlockDialog();
    });
    $("#blockCloseBtn").addEventListener("click", closeBlockDialog);
    $("#blockDoneBtn").addEventListener("click", closeBlockDialog);
    $("#blockRefToggle").addEventListener("click", () => {
      setBlockRefVisible($("#blockRef").hidden);
    });
    $("#blockScopeBtn").addEventListener("click", () => {
      setBlockScope(state.blockScope === "document" ? "block" : "document", openBlockCtx);
    });
    $("#refBoxesToggle").addEventListener("change", (e) => {
      setRefBoxes(e.target.checked);
    });
    $("#refZoomOut").addEventListener("click", () => stepRefZoom(-1));
    $("#refZoomIn").addEventListener("click", () => stepRefZoom(1));
    $("#refZoomValue").addEventListener("click", () => applyRefZoom(1));
    $("#blockTabs").addEventListener("click", (e) => {
      const tab = e.target.closest(".tab");
      if (tab) setBlockView(tab.dataset.blockView);
    });
    $("#blockTabs").addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      const tabs = $$("#blockTabs .tab");
      const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
      const next = (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      setBlockView(tabs[next].dataset.blockView);
    });
    $("#blockCopyBtn").addEventListener("click", async () => {
      // Copy what is actually on screen: the whole document when that scope is
      // selected, otherwise the block that was opened.
      if (state.blockScope === "document") {
        const pages = state.result?.pages || [];
        const text = pages
          .map((page) => state.result?.isAnswer
            ? rawPageText(state.result.raw, page.index)
            : page.plainText)
          .join("\n\n");
        const okDoc = await copyText(text);
        toast(okDoc ? "Whole document text copied" : "Copy failed",
          { kind: okDoc ? "ok" : "err", duration: 2200 });
        return;
      }
      const block = state.result?.pages[state.page]?.blocks[state.blockIndex];
      if (!block) return;
      const text = blockIsTable(block)
        ? blockRows(block).map((cells) => cells.join("\t")).join("\n")
        : (block.prose || block.text || "");
      const ok = await copyText(text);
      toast(ok ? (blockIsTable(block) ? "Table copied as TSV" : "Block text copied") : "Copy failed",
        { kind: ok ? "ok" : "err", duration: 2200 });
    });
    $("#blockCopyJsonBtn").addEventListener("click", async () => {
      if (state.blockScope === "document") {
        const payloadDoc = {
          page_count: state.result?.pageCount ?? state.result?.pages?.length ?? 0,
          purpose: state.result?.purpose || null,
          pages: (state.result?.pages || []).map((page) => ({
            index: page.index,
            finish_reason: page.finishReason || null,
            text: rawPageText(state.result.raw, page.index),
            plainText: page.plainText || null,
          })),
        };
        const okDoc = await copyText(JSON.stringify(payloadDoc, null, 2));
        toast(okDoc ? "Whole document JSON copied" : "Copy failed",
          { kind: okDoc ? "ok" : "err", duration: 2200 });
        return;
      }
      const block = state.result?.pages[state.page]?.blocks[state.blockIndex];
      if (!block) return;
      const payload = {
        index: block.index,
        type: block.type || null,
        box: block.box || null,
        text: block.text || "",
        prose: block.prose || null,
        tableRows: block.tableRows || null,
      };
      const ok = await copyText(JSON.stringify(payload, null, 2));
      toast(ok ? "Block JSON copied" : "Copy failed", { kind: ok ? "ok" : "err", duration: 2200 });
    });
    trapFocus(blockScrim, $("#blockDialog"));
  }

  const INSPECT_HINT = "Hover or focus a block to inspect it";

  /** The inspector row is always on screen; idle shows a hint, never a stale block. */
  function resetInspector() {
    const node = $("#inspect");
    node.dataset.empty = "true";
    $("#inspectType").hidden = true;
    const text = $("#inspectText");
    text.textContent = INSPECT_HINT;
    text.removeAttribute("title");
    const coords = $("#inspectCoords");
    coords.textContent = "";
    coords.removeAttribute("title");
  }

  function inspectBlock(index) {
    const page = state.result?.pages[state.page];
    const block = page?.blocks[index];
    if (!block) {
      resetInspector();
      return;
    }
    $("#inspect").dataset.empty = "false";
    $("#inspectType").textContent = block.type || (page.format === "typed" ? "block" : "text");
    $("#inspectType").hidden = !block.type;
    // Full text goes in the DOM; the fixed single-line row ellipsises it in CSS.
    const text = $("#inspectText");
    text.textContent = blockPreview(block);
    text.title = text.textContent;
    const boxText = block.box
      ? `[[${block.box.x1}, ${block.box.y1}, ${block.box.x2}, ${block.box.y2}]]`
      : "no box";
    const rows = block.type === "table" && block.tableRows?.length ? ` · ${block.tableRows.length} rows` : "";
    const coords = $("#inspectCoords");
    coords.textContent = boxText + rows;
    coords.title = coords.textContent;
  }

  function highlightBlock(index) {
    $$(".block-item").forEach((btn, i) => { btn.dataset.active = String(i === index); });
    $$(".ocr-box").forEach((box) => {
      box.dataset.active = String(Number(box.dataset.index) === index);
    });
  }

  function activateBlock(index) {
    highlightBlock(index);
    inspectBlock(index);
    const box = $$(".ocr-box").find((b) => Number(b.dataset.index) === index);
    if (box) box.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function hoverBlock(index, on) {
    if (on) {
      highlightBlock(index);
      inspectBlock(index);
    } else {
      highlightBlock(-1);
    }
  }

  function renderTextView() {
    const root = $("#proseText");
    root.innerHTML = "";
    const pages = state.result.pages;
    if (!pages.length) {
      root.appendChild(el("p", "prose-page-body is-empty", "The response contained no pages."));
      return;
    }
    pages.forEach((page) => {
      const wrap = el("div", "prose-page");
      const head = el("div", "prose-page-head");
      head.appendChild(el("span", null, "Page " + (page.index + 1)));
      const meta = el("span", null,
        (page.looksMarkup ? "markdown" : "plain text") +
        " · " + (page.finishReason === "length" ? "truncated" : "complete"));
      head.appendChild(meta);
      wrap.appendChild(head);

      const body = el("div", "prose-page-body");
      // For token responses use the parsed, token-free text — the Tokens tab exists
      // precisely to show the raw form.
      const raw = rawPageText(state.result.raw, page.index);
      const clean = state.result?.isAnswer ? raw : page.plainText;
      if (!clean || !clean.trim()) {
        body.classList.add("is-empty");
        body.textContent = "This page came back empty.";
      } else if (window.OCRRender) {
        window.OCRRender.render(clean, body);
        body.classList.add(state.result?.isAnswer ? "prose-page-body--answer" : "prose-page-body--md");
      } else {
        body.textContent = clean;
      }
      wrap.appendChild(body);
      root.appendChild(wrap);
    });
  }

  function renderTokensView() {
    const root = $("#tokensText");
    root.innerHTML = "";
    const pages = state.result.pages;
    if (!pages.length) {
      root.appendChild(el("p", "prose-page-body is-empty", "The response contained no pages."));
      return;
    }
    pages.forEach((page) => {
      const wrap = el("div", "prose-page");
      const head = el("div", "prose-page-head");
      head.appendChild(el("span", null, "Page " + (page.index + 1)));
      head.appendChild(el("span", null, page.blocks.length + " boxes"));
      wrap.appendChild(head);
      const body = el("div", "prose-page-body");
      const raw = rawPageText(state.result.raw, page.index);
      body.innerHTML = raw ? highlightTokens(raw) : '<span class="tok-special">empty page</span>';
      wrap.appendChild(body);
      root.appendChild(wrap);
    });
  }

  /**
   * The whole document's OCR, page by page, inside the block dialog — so you can
   * read the full extraction next to the page instead of leaving for the Text
   * tab. The page the open block belongs to is marked.
   */
  function renderBlockDoc() {
    const rendered = $("#blockRendered");
    rendered.innerHTML = "";
    const wrap = el("div", "block-doc");
    const pages = state.result?.pages || [];
    if (!pages.length) {
      wrap.appendChild(el("p", "block-doc-body is-empty", "The response contained no pages."));
      rendered.appendChild(wrap);
      return;
    }
    pages.forEach((page) => {
      const section = el("section", "block-doc-page");
      const head = el("div", "block-doc-head");
      const isCurrent = page.index === state.page;
      head.appendChild(el("span", isCurrent ? "block-doc-current" : null, "Page " + (page.index + 1)));
      head.appendChild(el("span", null,
        (page.looksMarkup ? "markdown" : "plain text") +
        " · " + (page.finishReason === "length" ? "truncated" : "complete")));
      section.appendChild(head);

      const body = el("div", "block-doc-body");
      const raw = rawPageText(state.result.raw, page.index);
      const clean = state.result?.isAnswer ? raw : page.plainText;
      if (!clean || !clean.trim()) {
        body.classList.add("is-empty");
        body.textContent = "This page came back empty.";
      } else if (window.OCRRender) {
        window.OCRRender.render(clean, body);
      } else {
        body.textContent = clean;
      }
      section.appendChild(body);
      wrap.appendChild(section);
    });
    rendered.appendChild(wrap);
  }

  function rawPageText(json, index) {
    const pages = json?.pages || [];
    const page = pages.find((p) => p && Number(p.index) === index) || pages[index];
    return page?.text || "";
  }

  function highlightTokens(raw) {
    return escapeHTML(raw).replace(
      /(&lt;｜\/?ref｜&gt;)|(&lt;｜box｜&gt;)([\s\S]*?)(&lt;｜\/box｜&gt;)/g,
      (match, ref, boxOpen, inner, boxClose) => {
        if (ref) return '<span class="tok tok-special">' + ref + "</span>";
        return (
          '<span class="tok tok-special">' + boxOpen + "</span>" +
          '<span class="tok tok-box">' + inner + "</span>" +
          '<span class="tok tok-special">' + boxClose + "</span>"
        );
      }
    );
  }

  function renderJsonView() {
    const pre = $("#jsonPre");
    pre.innerHTML = highlightJSON(JSON.stringify(state.result.raw, null, 2));
  }

  function highlightJSON(text) {
    // Tokenize first, escape per-token: escaping before matching turns every
    // quote into &quot; and no string literal can ever match.
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}\[\],])/g;
    const out = [];
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(escapeHTML(text.slice(last, m.index)));
      const [whole, str, colon, num, bool, punct] = m;
      if (str) {
        out.push('<span class="' + (colon ? "k" : "s") + '">' + escapeHTML(str) + "</span>");
        if (colon) out.push(escapeHTML(colon));
      } else if (num) {
        out.push('<span class="n">' + escapeHTML(num) + "</span>");
      } else if (bool) {
        out.push('<span class="n">' + escapeHTML(bool) + "</span>");
      } else if (punct) {
        out.push('<span class="p">' + escapeHTML(punct) + "</span>");
      } else {
        out.push(escapeHTML(whole));
      }
      last = re.lastIndex;
    }
    if (last < text.length) out.push(escapeHTML(text.slice(last)));
    return out.join("");
  }

  /* Page zoom. Sizes are driven by a CSS variable rather than transform: scale(),
     so the percentage-positioned box overlay stays registered at every level. */
  const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
  let pageBaseSize = null; // natural "fit" size of the sheet at 100%

  function zoomTargets() {
    return [$("#resultSheet"), $("#resultImg"), $("#resultCanvas")];
  }

  /** Measure the fitted page so zoom multiplies the real rendered size. */
  function capturePageBase() {
    const sheet = $("#resultSheet");
    if (!sheet) return;
    clearPageZoom();
    const rect = sheet.getBoundingClientRect();
    if (rect.width > 4 && rect.height > 4) {
      pageBaseSize = { w: Math.round(rect.width), h: Math.round(rect.height) };
    }
  }

  function clearPageZoom() {
    zoomTargets().forEach((node) => {
      if (!node) return;
      node.style.maxWidth = "";
      node.style.maxHeight = "";
      node.style.width = "";
    });
  }

  function applyZoom(zoom) {
    state.zoom = zoom;
    const stage = $("#stage");
    const sheet = $("#resultSheet");
    const img = $("#resultImg");
    const canvas = $("#resultCanvas");
    const zoomed = zoom > 1.001;
    stage.dataset.zoom = String(zoomed);

    if (!pageBaseSize || Math.abs(zoom - 1) < 0.001) {
      clearPageZoom();
    } else {
      const w = Math.max(40, Math.round(pageBaseSize.w * zoom));
      const h = Math.max(40, Math.round(pageBaseSize.h * zoom));
      // An explicit width (not max-width) lets a zoomed page overflow the stage.
      sheet.style.width = w + "px";
      sheet.style.maxWidth = "none";
      sheet.style.maxHeight = zoomed ? "none" : h + "px";
      [img, canvas].forEach((node) => {
        if (!node) return;
        node.style.width = "100%";
        node.style.maxWidth = "none";
        node.style.maxHeight = zoomed ? "none" : h + "px";
        node.style.height = "auto";
      });
    }

    $("#zoomValue").textContent = Math.round(zoom * 100) + "%";
    $("#zoomOutBtn").disabled = zoom <= ZOOM_STEPS[0];
    $("#zoomInBtn").disabled = zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }

  function stepZoom(direction) {
    const current = ZOOM_STEPS.reduce(
      (best, step) => (Math.abs(step - state.zoom) < Math.abs(best - state.zoom) ? step : best),
      1
    );
    const i = Math.min(ZOOM_STEPS.length - 1, Math.max(0, ZOOM_STEPS.indexOf(current) + direction));
    applyZoom(ZOOM_STEPS[i]);
  }

  function initZoom() {
    $("#zoomOutBtn").addEventListener("click", () => stepZoom(-1));
    $("#zoomInBtn").addEventListener("click", () => stepZoom(1));
    $("#zoomValue").addEventListener("click", () => applyZoom(1));
    applyZoom(1);
  }

  function setView(view) {
    state.view = view;
    $$("#viewTabs .tab").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.view === view));
    });
    ["document", "text", "tokens", "json"].forEach((name) => {
      const node = $("#view" + name.charAt(0).toUpperCase() + name.slice(1));
      if (node) node.hidden = name !== view;
    });
  }

  function initTabs() {
    $("#viewTabs").addEventListener("click", (e) => {
      const tab = e.target.closest(".tab");
      if (tab) setView(tab.dataset.view);
    });
    $("#viewTabs").addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      const tabs = $$("#viewTabs .tab");
      const i = tabs.findIndex((t) => t.dataset.view === state.view);
      const next = (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      setView(tabs[next].dataset.view);
    });
    $("#boxesToggle").addEventListener("change", (e) => {
      $("#boxLayer").dataset.hidden = e.target.checked ? "false" : "true";
    });

    const list = $("#blocksList");
    list.addEventListener("mouseleave", () => {
      if (!document.activeElement?.closest?.(".block-item")) resetInspector();
    });
    list.addEventListener("focusout", (e) => {
      if (e.relatedTarget?.closest?.(".block-item")) return;
      if (list.matches(":hover")) return;
      resetInspector();
    });
  }

  /* ── copy / download ──────────────────────────────────── */
  function initResultActions() {
    $("#copyResultBtn").addEventListener("click", async () => {
      const json = state.result?.raw;
      if (!json) return;
      const ok = await copyText(JSON.stringify(json, null, 2));
      toast(ok ? "Result JSON copied" : "Copy failed — select the JSON view manually", { kind: ok ? "ok" : "err" });
    });
    $("#downloadBtn").addEventListener("click", () => {
      const json = state.result?.raw;
      if (!json) return;
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ocr-" + (json.id || Date.now()) + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("JSON downloaded", { kind: "ok", duration: 2200 });
    });
    $("#copyCurlBtn").addEventListener("click", async () => {
      const ok = await copyText($("#curlBlock").textContent);
      toast(ok ? "curl copied" : "Copy failed", { kind: ok ? "ok" : "err", duration: 2000 });
    });
    $("#copyErrBtn").addEventListener("click", async () => {
      const info = $("#errRaw").textContent;
      const ok = await copyText(info);
      toast(ok ? "Error copied" : "Copy failed", { kind: ok ? "ok" : "err", duration: 2000 });
    });
    $("#retryBtn").addEventListener("click", () => run());
  }

  function initRun() {
    $("#runBtn").addEventListener("click", () => run());
    $("#cancelBtn").addEventListener("click", cancelRun);
    $("#cancelRunBtn").addEventListener("click", cancelRun);
    $("#clearFileBtn").addEventListener("click", () => setFile(null));
  }

  function cancelRun() {
    if (state.xhr) {
      state.xhr.abort();
      state.xhr = null;
    } else {
      // Demo mode has no socket; drop the result by flagging the promise path.
      finishError({ kind: "abort" });
      setRunning(false);
    }
  }

  /* ── keyboard ─────────────────────────────────────────── */
  function initShortcuts() {
    window.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        if (!state.running) run();
        return;
      }
      if (e.key === "Escape") {
        if (!blockScrim.hidden) { closeBlockDialog(); return; }
        if (!keyScrim.hidden) { closeKeyDialog(); return; }
        if (sampleMenu) { closeSampleMenu(); return; }
        if (state.running) { cancelRun(); }
        return;
      }
      if (mod && (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4") && state.result) {
        const views = ["document", "text", "tokens", "json"];
        e.preventDefault();
        setView(views[Number(e.key) - 1]);
      }
    });
  }

  function initZoomResize() {
    let timer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!state.result) return;
        capturePageBase();
        applyZoom(state.zoom);
      }, 140);
    });
  }

  function initScrollShade() {
    const header = $(".app-header");
    const onScroll = () => { header.dataset.scrolled = String(window.scrollY > 4); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ── init ─────────────────────────────────────────────── */
  function init() {
    initTheme();
    const stored = readKey();
    setKey(stored, stored ? "set" : null);
    initKeyDialog();
    initPurpose();
    initDemo();
    initDropzone();
    initTabs();
    initZoom();
    initZoomResize();
    initBlockDialog();
    initResultActions();
    initRun();
    initShortcuts();
    initScrollShade();

    renderCurl();
    updateRunButton();
    showState("Empty");

    // Deep link: ?key=… or ?purpose=…
    const params = new URLSearchParams(window.location.search);
    if (params.get("purpose") === "rich_layout_recognition") setPurpose("rich_layout_recognition");
    if (params.get("demo") === "1") setDemo(true);
    if (!state.file && location.protocol !== "file:") {
      // A sample on first load makes the empty state runnable in one click.
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
