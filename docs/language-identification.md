# Language identification for archive works

Status: scoped, not implemented. Written for a fresh implementation session.

## Problem

Every catalog card records a static `languages` tag list (`sources.languages`,
`src/lib/server/db/schema.ts:65`) such as `['ain', 'jpn']` or `['ain', 'eng']`.
Since virtually every work in this archive touches Ainu, that tag named the
collection, not the work — it never told one card apart from another. A
follow-up fix (`archiveCardLanguages`, `src/lib/archive/languages.ts`) already
drops the always-true Ainu tag from catalog cards; the full record still shows
on the work page's bibliographic detail.

What's still missing: an actual measurement of how much of a work's text is
Ainu versus Japanese versus English, rather than a hand-entered list of which
languages a work merely touches. This document scopes that measurement.

## Why the obvious approaches don't work

**Unicode script-range detection** (the existing `detectScripts()` in
`scripts/import/lib/derive.ts:65`, used only on title strings today) cannot
separate the languages that matter here. Ainu in this collection is written
in katakana or Latin transliteration — the same scripts Japanese (katakana)
and English (Latin) use. A script-composition ratio (% kana / % Latin / %
kanji) is buildable from this today, but it would answer "what script is
this," not "what language is this," and mislabeling one as the other would
overstate the confidence of the result.

**Dictionary/wordlist substring lookup** was tested empirically against the
Ainu MCP's real tooling before writing this doc, specifically to avoid
scoping around an untested assumption. Results:

| Test | Input | Result |
|---|---|---|
| Known Ainu word | `カムイ` (kamuy, "god/spirit") | Correct hit, but via substring match, not exact-lemma |
| Known Japanese loanword | `テレビ` (terebi, "television") | Correctly rejected |
| Ainu word, Latin script | `kamuy` | Correct hit |
| English word | `spirit` | **False positive** — dozens of hits, because the lookup full-text-searches dictionary *definition* columns, and Ainu-English dictionaries constantly use "spirit" in their English glosses |
| Topic-reference loanword | `アイヌ` ("Ainu") | Matches, but also surfaced a real sentence mixing scripts: "アイヌ語では usey" ("in the Ainu language, it's usey") — confirming `アイヌ` itself appears as a topic word *inside Japanese sentences about Ainu people*, not just inside Ainu text |
| Short grammatical particles | `ネ`, `アン` | Each returned 4–11 unrelated longer lemmas by substring match — noisy candidate lists, never a clean verdict |

Conclusion: dictionary lookup, as exposed by these tools, is a full-text
search over multi-column dictionary data, not a tokenized language-membership
test. It's fine for confirming a specific known content word in isolation. It
is not viable as a per-token classifier over running OCR text — real running
text is dominated by exactly the short particles and loanwords that produce
false positives and noise above.

## Recommended approach: sentence-level language identification, not word lookup

Classify by **span of text** (a sentence or an OCR block — see
"Classification unit" below), using a **character n-gram statistical model**
(the standard technique behind tools like fastText's langid — pick the
language whose character-sequence statistics best match the span), not a
per-word dictionary check.

This sidesteps every failure mode found above by construction:

- A single loanword or topic-reference token (`アイヌ` inside a Japanese
  sentence) doesn't flip the whole span's classification — it's one signal
  among the span's many characters, not a single deciding lookup.
- Short particles stop being a problem once there's enough surrounding
  context in the same span to score against.
- Out-of-vocabulary words (OCR misreads, rare forms) degrade gracefully —
  the model scores character shape, not vocabulary membership, so it never
  needs an exact-match fallback path the way dictionary lookup does.

### Classification unit

Classify by **OCR block**, not by word or by whole document. `ocr_chunks`
(`drizzle/0013_archive_search_substrate.sql`, columns `chunk_id, revision_id,
variant, page, block, text, text_norm, checksum, normalization_version,
ingest_generation`) already stores text split into blocks by
`splitPageBlocks()` (`src/lib/server/archive/ocr.ts:155`) — each block is
already roughly paragraph- or line-sized, which is enough context for an
n-gram model to score reliably without being so large that a single block
mixes multiple languages (e.g., an interlinear Ainu-line/Japanese-gloss-line
layout, common in this collection, should ideally split at the line, not
merge both languages into one verdict).

### Training data

- **Ainu vs. Japanese**: the Ainu MCP's `corpus_search`/`corpus_frequency_list`
  tools expose `aynumosir/ainu-corpora`, a ~195k-sentence corpus of **aligned**
  Ainu/Japanese sentence pairs. This is close to ideal training data — it
  gives matched positive (Ainu) and negative-but-topically-related (Japanese)
  examples without any manual labeling.
- **English**: needs a separate small reference corpus, or can lean on cheaper
  function-word statistics — English is already the easier case, since actual
  Ainu-in-Latin-transliteration has distinctive orthography (doubled vowels,
  apostrophes marking the glottal stop, consonant clusters not found in
  English) that a character n-gram model picks up easily; the ambiguous case
  this whole document is about is Ainu-vs-Japanese in katakana, not
  Ainu-vs-English in Latin.
- **Attribution**: `aynumosir/ainu-corpora` and `aynumosir/ainu-stopwords` are
  the data sources behind the trained model and must be cited in whatever
  code/doc explains the resulting numbers, per this project's source-fidelity
  standard — a reader should be able to see what the classifier was trained
  on, not just trust an unsourced percentage.

### Storage

New column or table (not yet designed in detail — a decision for the
implementing session, informed by the two existing analogous shapes in this
schema):

- `sources.significance` (`schema.ts:127`) is the simple-scalar-column
  pattern: one precomputed number per source, refreshed by a batch script
  (`scripts/archive/refresh-significance.ts`, invoked via `bun run
  archive:refresh-significance`, not a live cron — a manual/CI batch job).
- `revisionOcrCoverage` (`schema.ts:1075`) is the richer pattern: a per-variant
  row carrying not just a value but a `reliability` enum (`'unassessed' |
  'sound' | 'suspect'`, `schema.ts:1093`) and a `reliabilityNote`. Language
  composition should follow this second pattern, not the first — a source
  with too little classifiable text needs to say "insufficient text" rather
  than show a confident-looking wrong ratio. Also store the classifier
  version, mirroring `revisionOcrCoverage.toolVersion`, so a future
  re-training run can be told apart from the current one in stored data.

### Batch job shape

Mirror `scripts/archive/refresh-significance.ts`: a new script (name and
exact table/column shape are implementation decisions) that reads each
source's `ocr_chunks`, classifies each block, aggregates into a per-source
composition (e.g. `{ain: 0.62, jpn: 0.31, eng: 0.05, other: 0.02}` plus a
coverage/confidence flag and classifier version), and writes the result back.
Needs a migration for whatever storage shape is chosen.

## Validation required before shipping anything

Pull 5–10 real OCR blocks from actual archive documents — spanning different
works, OCR engines (the archive already distinguishes `gemini` vs `pdftotext`
per revision), and eras — and manually check classifier output against them
before committing to the approach. A clean training corpus (the aligned
195k-sentence corpus above) does not surface the noise this archive's own OCR
introduces: misreads, interlinear gloss layout splitting mid-sentence,
mixed-script running text within one block. Set a concrete accuracy bar
against this manually-labeled sample (e.g., "≥90% block-level accuracy")
before building the batch job and schema around it — if the spike doesn't
clear that bar, the approach needs rethinking before more engineering goes in,
not after.

## Non-goals

- Word-level tagging of which language each word is. Block-level only.
- Dialect classification (Saru vs. Chitose vs. Sakhalin, etc.) — a separate,
  harder problem, out of scope here.
- Real-time/on-demand classification. Batch job only, recomputed on a cadence,
  same operational shape as the significance refresh.
- Catalog/card UI for the resulting data — a follow-up PR once the data exists
  and has cleared the validation bar above, not part of this build.

## Open decisions for the implementing session

- Model choice: a from-scratch character n-gram classifier (e.g. naive Bayes
  over character n-grams, entirely buildable in-repo against the training
  data above with no new runtime dependency) versus an existing langid
  library. Leaning toward from-scratch, since this archive's register
  (historical dictionaries, wordlists, academic prose) differs from the
  modern web text most off-the-shelf langid models are trained on, and the
  aligned Ainu/Japanese training corpus is domain-specific in exactly the
  right way already.
- Where the trained model artifact lives: baked into the repo as a data file
  versus computed fresh from the corpus at batch-run time.
- Exact storage shape (scalar column vs. normalized table) — see "Storage"
  above; both existing patterns in this schema are viable, pick based on
  whether per-block detail (not just per-source aggregate) turns out to be
  worth keeping.
