/* ============================================================
   render-md.js — safe renderer for OCR text output
   The API returns Markdown, sometimes with raw <table> markup.
   Everything here builds DOM nodes: no innerHTML of API text,
   so hostile content cannot execute or restyle the page.
   Supports: #..###### headings, paragraphs, - / * lists,
   1. ordered lists, > quotes, --- rules, **bold**, *italic*,
   `code`, [link](url) (rendered as plain text + href), and
   a small <table>/<tr>/<td> HTML subset.
   ============================================================ */
(function () {
  "use strict";

  const INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]*\]\([^)\s]+\))/g;

  function appendInline(parent, text) {
    const parts = String(text).split(INLINE_RE);
    for (const part of parts) {
      if (!part) continue;
      let m;
      if ((m = /^\*\*([\s\S]+)\*\*$/.exec(part)) || (m = /^__([\s\S]+)__$/.exec(part))) {
        parent.appendChild(node("strong", null, m[1]));
      } else if ((m = /^\*([\s\S]+)\*$/.exec(part)) || (m = /^_([\s\S]+)_$/.exec(part))) {
        parent.appendChild(node("em", null, m[1]));
      } else if ((m = /^`([\s\S]+)`$/.exec(part))) {
        parent.appendChild(node("code", null, m[1]));
      } else if ((m = /^\[([\s\S]*)\]\(([^)\s]+)\)$/.exec(part))) {
        const a = node("a", null, m[1]);
        const href = m[2];
        if (/^https?:\/\//i.test(href)) {
          a.href = href;
          a.rel = "noreferrer noopener";
          a.target = "_blank";
        }
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    }
  }

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * Pull every <table> out of the text into row arrays.
   * The OCR service can emit nested <table><table> wrappers and duplicated
   * cells, so this collects all <tr> within a run rather than trusting nesting.
   */
  function extractTables(text) {
    const tables = [];
    const stripped = text.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (whole, inner) => {
      // Drop any nested openers; their rows are collected below.
      const body = inner.replace(/<\/?table\b[^>]*>/gi, " ");
      const rows = [];
      const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let rm;
      while ((rm = rowRe.exec(body)) !== null) {
        const cells = [];
        const cellRe = /<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi;
        let cm;
        while ((cm = cellRe.exec(rm[1])) !== null) {
          const raw = decodeEntities(cm[2].replace(/<br\s*\/?>/gi, " · ").replace(/<\/?[a-z][^>]*>/gi, " "))
            .replace(/\s+/g, " ")
            .trim();
          const text = collapseDoubled(raw);
          if (!text) continue;
          if (cells.length && cells[cells.length - 1].text === text) continue;
          cells.push({ header: cm[1].toLowerCase() === "h", text });
        }
        if (cells.length) rows.push(cells);
      }
      if (!rows.length) return "";
      tables.push(rows);
      return "\n\u0000TABLE" + (tables.length - 1) + "\u0000\n";
    });
    // Belt and braces: a swallowed closer would otherwise print as literal text.
    const cleaned = stripped
      .replace(/<\/?table\b[^>]*>/gi, "")
      .replace(/<\/?t[rhd]\b[^>]*>/gi, "");
    return { stripped: cleaned, tables };
  }

  /** "CODE" + "CODE" in one cell → "CODE". */
  function collapseDoubled(value) {
    const s = String(value).trim();
    if (s.length < 6 || s.length % 2 !== 0) return s;
    const half = s.length / 2;
    if (s.slice(0, half) === s.slice(half)) return s.slice(0, half).trim();
    const words = s.split(" ");
    if (words.length >= 4 && words.length % 2 === 0) {
      const h = words.length / 2;
      if (words.slice(0, h).join(" ") === words.slice(h).join(" ")) return words.slice(0, h).join(" ");
    }
    return s;
  }

  function decodeEntities(str) {
    return String(str)
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&amp;/gi, "&");
  }

  function buildTable(rows) {
    const table = node("table", "md-table");
    // The service emits header cells as <td>; the first row is the header row.
    const headerCells = rows[0] || [];
    const looksHeader = headerCells.some((c) => c.header) ||
      headerCells.every((c) => c.text && c.text.length <= 40 && !/^\s*[-–—]?\s*\d/.test(c.text));
    const head = node("thead");
    const body = node("tbody");
    rows.forEach((cells, r) => {
      const tr = node("tr");
      const useTh = cells.some((c) => c.header) || (r === 0 && looksHeader);
      cells.forEach((cell) => {
        const td = node(useTh ? "th" : "td");
        if (useTh) td.setAttribute("scope", "col");
        appendInline(td, cell.text);
        tr.appendChild(td);
      });
      (r === 0 && looksHeader ? head : body).appendChild(tr);
    });
    if (head.childElementCount) table.appendChild(head);
    table.appendChild(body);
    return table;
  }

  function render(rawText, target) {
    target.innerHTML = "";
    const text = String(rawText || "").replace(/\r\n/g, "\n");
    if (!text.trim()) {
      target.appendChild(node("p", "md-empty", "This page came back empty."));
      return target;
    }

    const { stripped, tables } = extractTables(text);
    const lines = stripped.split("\n");
    let i = 0;

    const flushList = (ordered) => {
      const list = node(ordered ? "ol" : "ul", "md-list");
      while (i < lines.length) {
        const m = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
          : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const li = node("li");
        appendInline(li, m[1]);
        list.appendChild(li);
        i++;
      }
      if (list.childElementCount) target.appendChild(list);
    };

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) { i++; continue; }

      const tableRef = /^\u0000TABLE(\d+)\u0000$/.exec(trimmed);
      if (tableRef) {
        const rows = tables[Number(tableRef[1])];
        if (rows) target.appendChild(buildTable(rows));
        i++;
        continue;
      }

      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(trimmed))) {
        const level = Math.min(6, m[1].length);
        const h = node("h" + Math.max(3, level + 2), "md-h md-h" + level);
        appendInline(h, m[2]);
        target.appendChild(h);
        i++;
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        target.appendChild(node("hr", "md-rule"));
        i++;
        continue;
      }
      if ((m = /^>\s?(.*)$/.exec(trimmed))) {
        const quote = node("blockquote", "md-quote");
        appendInline(quote, m[1]);
        target.appendChild(quote);
        i++;
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) { flushList(false); continue; }
      if (/^\s*\d+[.)]\s+/.test(line)) { flushList(true); continue; }

      // Paragraph: gather until a blank line or a new block starts.
      const para = [];
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trim();
        if (!t) break;
        if (/^(#{1,6})\s+/.test(t)) break;
        if (/^\u0000TABLE\d+\u0000$/.test(t)) break;
        if (/^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) break;
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) break;
        if (/^>\s?/.test(t)) break;
        para.push(t);
        i++;
      }
      if (para.length) {
        const p = node("p", "md-p");
        appendInline(p, para.join(" "));
        target.appendChild(p);
      } else {
        i++;
      }
    }
    return target;
  }

  window.OCRRender = { render };
})();
