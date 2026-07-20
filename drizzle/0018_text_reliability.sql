-- Text can be present and still be unusable. Some publisher text layers carry
-- one character per positioned fragment, which reassembles into nonsense, and
-- recognition of unfamiliar scripts can be little better. Recording a judgement
-- per variant lets the reader see that a passage is unreliable before quoting
-- it, and lets a later pass target what actually needs replacing.
ALTER TABLE `revision_ocr_coverage` ADD `reliability` text DEFAULT 'unassessed' NOT NULL;--> statement-breakpoint
ALTER TABLE `revision_ocr_coverage` ADD `reliability_note` text;
