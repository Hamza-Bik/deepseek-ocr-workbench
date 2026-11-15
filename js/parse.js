/* ============================================================
   parse.js — DeepSeek OCR token parsing
   Contract (api-docs.deepseek.com/guides/ocr):

     <｜ref｜>label<｜/ref｜><｜box｜>[[x1, y1, x2, y2]]<｜/box｜>

   Two shapes occur in the wild, and both are supported:

   1. inline  — the recognized text sits inside the ref, and nothing
      follows the box (the shape shown in the API guide):
        <｜ref｜>Revenue<｜/ref｜><｜box｜>[[62,289,300,330]]<｜/box｜>

   2. typed   — the ref holds the element type and the recognized
      content follows the box until the next ref token (what the
      live API returns today for rich_layout_recognition):
        <｜ref｜>sub_title<｜/ref｜><｜box｜>[[63,87,551,146]]<｜/box｜> # Quarterly Report

   The discriminator is purely structural: non-whitespace after the
   box means shape 2, whitespace only means shape 1.

   Coordinates are normalized 0–1000 by page width/height, origin
   top-left. A labelled `text_recognition` result can contain no
   tokens at all — it returns Markdown/HTML instead.
   ============================================================ */
(function () {
  "use strict";

  const BAR = "\uFF5C";
  const REF_OPEN = `<${BAR}ref${BAR}>`;
  const REF_CLOSE = `<${BAR}/ref${BAR}>`;
  const BOX_OPEN = `<${BAR}box${BAR}>`;
  const BOX_CLOSE = `<${BAR}/box${BAR}>`;

  const BLOCK_RE = new RegExp(
    "<\\uFF5Cref\\uFF5C>([\\s\\S]*?)<\\uFF5C/ref\\uFF5C>\\s*<\\uFF5Cbox\\uFF5C>\\s*(\\[\\s*\\[[\\s\\S]*?\\]\\s*\\])\\s*<\\uFF5C/box\\uFF5C>",
    "g"
  );

  // Element labels the service emits inside a typed ref.
  const TYPE_LABELS = new Set([
    "text", "title", "sub_title", "section_title", "heading", "header", "footer",
    "table", "table_caption", "table_footnote", "figure", "figure_caption",
    "image", "chart", "formula", "code", "list", "list_item", "footnote",
    "page_number", "page_footer", "page_header", "caption", "abstract",
    "reference", "equation", "paragraph", "ocr_text",
  ]);

  const MARKDOWN_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|> )|<\/?table\b|<\/?[a-z][a-z0-9]*\b[^>]*>/i;

  function parseCoords(raw) {
    if (!raw) return null;
    const nums = String(raw).match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 4) return null;
    const [x1, y1, x2, y2] = nums.slice(0, 4).map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return normalizeBox({ x1, y1, x2, y2 });
  }

  function normalizeBox(b) {
    const clamp = (n) => Math.min(1000, Math.max(0, n));
    let x1 = clamp(b.x1), y1 = clamp(b.y1), x2 = clamp(b.x2), y2 = clamp(b.y2);
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];
    if (x2 - x1 < 1) x2 = Math.min(1000, x1 + 1);
    if (y2 - y1 < 1) y2 = Math.min(1000, y1 + 1);
    return { x1, y1, x2, y2 };
  }

  const tidy = (text) => String(text).replace(/\s+/g, " ").trim();
  const isTypeLabel = (value) => {
    const v = tidy(value);
    return v.length > 0 && v.length <= 24 && !/\s/.test(v) && TYPE_LABELS.has(v.toLowerCase());
  };

  /**
   * @returns {{blocks:Array, hasTokens:boolean, plainText:string,
   *            kind:"rich"|"plain", format:"typed"|"inline"|"none", looksMarkup:boolean}}
   */
  function parsePage(raw) {
    const source = typeof raw === "string" ? raw : "";
    const blocks = [];
    let last = 0;
    let match;
    let typed = 0;
    let inline = 0;
    BLOCK_RE.lastIndex = 0;

    while ((match = BLOCK_RE.exec(source)) !== null) {
      const [whole, label, coordsRaw] = match;
      const start = match.index;
      const end = start + whole.length;

      // Content after the box, up to the next ref token.
      const nextRef = source.indexOf(REF_OPEN, end);
      const lookahead = source.slice(end, nextRef === -1 ? source.length : nextRef);
      const isTyped = lookahead.trim().length > 0;

      const box = parseCoords(coordsRaw);
      let text;
      let type = null;

      if (isTyped) {
        typed++;
        type = isTypeLabel(label) ? tidy(label).toLowerCase() : null;
        text = isTableContent(type, lookahead) ? tidyTableHtml(lookahead) : stripMarkupPrefix(lookahead);
        last = nextRef === -1 ? source.length : nextRef;
        // Skip ahead past the consumed content so the scan resumes at the next ref.
        BLOCK_RE.lastIndex = last;
      } else {
        inline++;
        text = tidy(label.replace(/<\/?[^>]*>/g, " "));
        last = end;
      }

      const block = { text, type, box, index: blocks.length };
      block.prose = isTableContent(type, text) ? tableToProse(text) : text;
      if (isTableContent(type, text)) block.tableRows = tableRowsOf(text);
      blocks.push(block);
    }

    const hasTokens = blocks.length > 0;
    const plainText = hasTokens
      ? blocks
          .map((b) => {
            // Emit a clean <table> for tabular blocks so the renderer builds cells;
            // everything else is plain prose.
            if (b.type === "table" && b.tableRows && b.tableRows.length) {
              return rebuildTable(b.tableRows);
            }
            return b.prose || b.text;
          })
          .filter(Boolean)
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
      : source.trim();

    return {
      blocks,
      hasTokens,
      plainText,
      kind: hasTokens ? "rich" : "plain",
      format: !hasTokens ? "none" : typed >= inline ? "typed" : "inline",
      looksMarkup: MARKDOWN_HINT.test(plainText),
    };
  }

  /**
   * Typed-ref content is Markdown, and for tables it is raw HTML — including
   * <table><table> with cells repeated twice (<td>CODE</td><td>CODE</td>).
   * `text` keeps the markup (the renderer needs it); `prose` is the readable form.
   */
  function stripMarkupPrefix(raw) {
    return String(raw)
      .replace(/<\/?(table|tr|td|th|thead|tbody)[^>]*>/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** "TITULAIRE DU COMPTETITULAIRE DU COMPTE" → "TITULAIRE DU COMPTE". */
  function collapseDoubled(value) {
    const s = value.trim();
    if (s.length < 6 || s.length % 2 !== 0) return s;
    const half = s.length / 2;
    if (s.slice(0, half) === s.slice(half)) return s.slice(0, half).trim();
    // Word-level: "a a b b" or "a b a b"
    const words = s.split(" ");
    if (words.length >= 4 && words.length % 2 === 0) {
      const h = words.length / 2;
      if (words.slice(0, h).join(" ") === words.slice(h).join(" ")) return words.slice(0, h).join(" ");
    }
    return s;
  }

  /** HTML table → rows of cleaned cell strings. */
  function tableRowsOf(html) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(html)) !== null) {
      const cells = [];
      const cellRe = /<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const value = collapseDoubled(
          cm[2]
            .replace(/<br\s*\/?>/gi, " · ")
            .replace(/<\/?[a-z][^>]*>/gi, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/\s+/g, " ")
            .trim()
        );
        if (!value) continue;
        if (cells.length && cells[cells.length - 1] === value) continue;
        cells.push(value);
      }
      if (cells.length) rows.push(cells);
    }
    return rows;
  }

  function rebuildTable(rows) {
    const esc = (v) => String(v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return "<table>" + rows
      .map((cells) => "<tr>" + cells.map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>")
      .join("") + "</table>";
  }

  function tableToProse(html) {
    return tableRowsOf(html).map((cells) => cells.join(" · ")).join("\n");
  }

  const isTableContent = (type, value) =>
    type === "table" || type === "table_caption" || /<table\b/i.test(String(value || ""));

  /** Keep the table markup so the renderer can build cells, but normalise it. */
  function tidyTableHtml(raw) {
    return String(raw).replace(/\s+/g, " ").trim();
  }

  /** Messages API / Files API answer → a single pseudo-page of text. */
  function parseAnswer(json) {
    const content = Array.isArray(json?.content) ? json.content : [];
    const text = content
      .filter((part) => part && part.type !== "thinking")
      .map((part) => (part.type === "text" ? part.text : part.type === "json" ? JSON.stringify(part.json) : ""))
      .filter(Boolean)
      .join("\n\n");
    const thinking = content.filter((part) => part?.type === "thinking").map((p) => p.thinking).join("\n\n");
    if (!text) return null;
    const usage = json?.usage || null;
    const page = {
      index: 0, finishReason: json?.stop_reason || "stop", blocks: [], annotated: [],
      hasTokens: false, plainText: text, kind: "plain", format: "none",
      looksMarkup: MARKDOWN_HINT.test(text), strayTokens: 0, answer: text, thinking,
    };
    return {
      pages: [page], pageCount: 1, boxCount: 0, purpose: "answer",
      id: json?.id || "", created: null, hasAnyTokens: false, usage, raw: json, isAnswer: true,
    };
  }

  function parseResponse(json) {
    if (json && !Array.isArray(json.pages) && Array.isArray(json.content)) {
      const answer = parseAnswer(json);
      if (answer) return answer;
    }
    const pages = Array.isArray(json?.pages) ? json.pages : [];
    const parsed = pages.map((page, i) => {
      const p = parsePage(page?.text);
      return {
        index: Number.isInteger(page?.index) ? page.index : i,
        finishReason: page?.finish_reason || "stop",
        ...p,
      };
    });
    const boxCount = parsed.reduce((sum, p) => sum + p.blocks.length, 0);
    return {
      pages: parsed,
      pageCount: Number.isFinite(json?.page_count) ? json.page_count : parsed.length,
      boxCount,
      purpose: json?.purpose || "",
      id: json?.id || "",
      created: json?.created || null,
      hasAnyTokens: boxCount > 0,
      usage: json?.usage || null,
      raw: json, isAnswer: false,
    };
  }

  function formatCreated(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  window.OCRParse = {
    BAR, REF_OPEN, REF_CLOSE, BOX_OPEN, BOX_CLOSE, TYPE_LABELS,
    parsePage, parseResponse, parseCoords, normalizeBox, formatCreated,
  };
})();
