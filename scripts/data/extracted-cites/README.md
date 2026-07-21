# Extracted citation datasets

Each file records the reference list of one work, taken from that work's printed
bibliography (its scanned pages in the archive), together with the catalogue
records those references resolve to. The `extracted-cites` importer
(`scripts/import/extracted-cites.ts`, run via `bun run import:extracted-cites`)
reads every `*.json` file here and writes the corresponding `cites` edges into
`source_relations`, so a scanned work connects to the works it cites and the
significance PageRank (`bun run archive:refresh-significance`) can see them.

## File shape (`schema: "extracted-cites/v1"`)

- `citingWork` — the work whose bibliography this is: its catalogue `slug` plus
  display metadata used to create the record if it does not exist yet.
- `extraction` — where the list came from (text source, page range, count).
- `verified` — `true` for a hand-checked transcription; `false` for the automated
  sweep output under `generated/`.
- `references[]` — one entry per printed reference, numbered from 1:
  - bibliographic fields (`authors`, `year`, `title`, `container`, `volume`,
    `pages`, `publisher`, `place`, `type`, …);
  - `ainuRelated` — whether the work belongs in this Ainu-focused catalogue;
  - `match` — the resolved catalogue record: `{ slug, confidence, note }` with
    confidence `exact` | `probable` | `candidate` | `none`.
- `citesEdges[]` — the resolved citing → cited edges, mirroring the `match`
  slugs at `exact`/`probable` confidence, for quick review.

## Confidence and what the importer does

- Hand-checked files create missing bibliographic records, then write accepted
  citation edges.
- Generated files link existing source records. `probable` matches become accepted
  edges; `candidate` matches remain candidate edges for review.

Every write is existence-checked and additive: a re-run over an unchanged file
inserts nothing.

## Regenerating the swept network

`generated/` holds the automated sweep output, one file per citing work. Rebuild
it against a database and refresh the derived scores with:

```
DATABASE_URL=file:./local.db bun run sweep:references
DATABASE_URL=file:./local.db bun run import:extracted-cites
DATABASE_URL=file:./local.db bun run archive:refresh-significance
```

`sweep:references` reads the OCR text shipped alongside the scanned works
(`../ainu-grammar`, located via `--ocr-root` or `AINU_ROOT`), finds each work's
bibliography, and links catalogue titles that appear in it. Only titles that
already exist in the catalogue are linked; unmatched references are left out.
