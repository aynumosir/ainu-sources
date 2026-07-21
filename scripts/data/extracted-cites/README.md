# Extracted citation datasets

Each file records the reference list of one work, transcribed from that work's
own printed bibliography (its scanned pages in the archive), together with the
catalogue records those references resolve to. The `extracted-cites` importer
(`scripts/import/extracted-cites.ts`, run via `bun run import:extracted-cites`)
reads every `*.json` file here and writes the corresponding `cites` edges into
`source_relations`, so a scanned work connects to the works it cites and the
significance PageRank (`bun run archive:refresh-significance`) can see them.

## File shape (`schema: "extracted-cites/v1"`)

- `citingWork` — the work whose bibliography this is: its catalogue `slug` plus
  display metadata used to create the record if it does not exist yet.
- `extraction` — where the list came from (text source, page range, count).
- `references[]` — one entry per printed reference, numbered from 1:
  - bibliographic fields (`authors`, `year`, `title`, `container`, `volume`,
    `pages`, `publisher`, `place`, `type`, …);
  - `ainuRelated` — whether the work belongs in this Ainu-focused catalogue;
  - `match` — the resolved catalogue record: `{ slug, confidence, note }` with
    confidence `exact` | `probable` | `candidate` | `none`.
- `citesEdges[]` — the resolved citing → cited edges, mirroring the `match`
  slugs at `exact`/`probable` confidence, for quick review.

## Confidence and what the importer does

- `exact` / `probable` — the reference is the catalogued work; the importer draws
  the edge to that existing record.
- `candidate` / `none` — no confirmed catalogue record; the importer creates a
  bibliographic source record from the reference fields (a stable
  `<year>-<surname>-<title>` slug) and draws the edge to it.

Every write is existence-checked and additive: a re-run over an unchanged file
inserts nothing.
