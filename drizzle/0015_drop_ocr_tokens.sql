-- The per-token index was never populated at scale and is read by nothing.
-- Building it starved live reads on the shared database, and search answers
-- fuzzy and similar-page queries from `ocr_chunks` and its FTS index instead.
DROP INDEX IF EXISTS `ocr_tokens_norm_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `ocr_tokens_chunk_idx`;--> statement-breakpoint
DROP TABLE IF EXISTS `ocr_tokens`;
