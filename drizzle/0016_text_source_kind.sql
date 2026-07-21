-- Text in this archive comes from several sources and recognition is only one
-- of them: most of the collection carries a publisher text layer, some is
-- converted from another format, some is transcribed by hand. Recording which
-- is which lets the reader say where a passage came from, and lets a citation
-- rest on something firmer than "OCR".
ALTER TABLE `revision_ocr_coverage` ADD `source_kind` text DEFAULT 'recognized' NOT NULL;--> statement-breakpoint
UPDATE `revision_ocr_coverage` SET `source_kind` = 'extracted' WHERE `tool` = 'pdftotext' OR `variant` = 'pdftotext';--> statement-breakpoint
UPDATE `revision_ocr_coverage` SET `source_kind` = 'converted' WHERE `tool` = 'pandoc' OR `variant` = 'pandoc';--> statement-breakpoint
UPDATE `revision_ocr_coverage` SET `source_kind` = 'edited' WHERE `variant` IN ('edited', 'manual');
