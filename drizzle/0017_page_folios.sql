-- The archive addresses a page by its position in the scan, which is
-- unambiguous but is not the number a reader cites. Front matter and
-- unnumbered plates push the printed folio out of step, and the offset can
-- change several times within one book. The folio is recorded per page where
-- it can be read from the page's own text and no competing numbering
-- contradicts it; where it cannot, the column stays null and the archive says
-- so rather than guessing.
CREATE TABLE `revision_page_folios` (
	`revision_id` text NOT NULL,
	`page` integer NOT NULL,
	`label` text NOT NULL,
	`value` integer,
	`derived_from` text NOT NULL,
	`detected_at` integer NOT NULL,
	PRIMARY KEY(`revision_id`, `page`),
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "revision_page_folios_page_check" CHECK(`page` >= 0)
);
