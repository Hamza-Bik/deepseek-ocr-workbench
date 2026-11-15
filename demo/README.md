# Demo fixtures

Used by the header's **Demo** toggle, so every scenario is reproducible with no API key.

Read `demoPathFor()` in `js/app.js` to see how a file name and purpose map to a fixture.

## `demo/recorded/` — real captured responses

Verbatim `POST /v1/tools/ocr` responses from the live API (`object: "ocr.result"`),
one pair per sample document, `<name>.text.json` and `<name>.rich.json`:

| file | sample | notes |
| --- | --- | --- |
| `bank-statement.*.json` | `samples/bank-statement.pdf` | dense 8-row transaction table; the `rich` capture shows the duplicated-cell `<table><table>` defect |
| `report.*.json` | `samples/report.png` | heading, paragraph, HTML table, notes |
| `contract.*.json` | `samples/contract.pdf` | 2 pages, so the page strip is exercised |
| `memo.*.json` | `samples/memo.docx` | Word file, extracted as plain text, no tokens |
| `ask-bank-statement.json` | — | Messages-API answer: a `document` block plus a prompt, returning extracted JSON |
| `empty-result.json` | `samples/report.png` | a hand-edited copy of `report.text.json` with the page text blanked, to reproduce the intermittent `200 OK` + empty page |

The `text` captures are the important ones for the UI: `text_recognition` returns
**Markdown and HTML tables with no `｜ref｜`/`｜box｜` tokens**, so "no boxes" is a
normal result. The `rich` captures use the typed-token shape the live service
actually emits (`<｜ref｜>type<｜/ref｜><｜box｜>[[…]]<｜/box｜> content`), which
differs from the example in the API guide.

## `demo/`

- `error-429.json` — error envelope for HTTP 429, account concurrency limit.
- `error-timeout.json` — error envelope for a 200 response whose body carries a gateway timeout.

Fixtures are committed as data, not generated: each recorded file is a verbatim
capture, so a change in them means the API's output changed.
