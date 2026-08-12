-- Covering index for the archive OCR statistics aggregates.
--
-- Those aggregates read only join keys and locators from `ocr_chunks`, but they
-- restrict to chunks that hold text. With no partial index carrying that
-- predicate, SQLite evaluates `length(trim(text)) > 0` by reading the `text`
-- column of every row — 151k rows and about 83 MB when this index was added,
-- and once per aggregate. This index repeats the predicate and holds every
-- column the aggregates project, so both the restriction and the projection are
-- answered from the index and the text column stays untouched.
CREATE INDEX `ocr_chunks_nonempty_text_idx` ON `ocr_chunks` (`revision_id`,`variant`,`ingest_generation`,`page`,`chunk_id`) WHERE length(trim(`text`)) > 0;
