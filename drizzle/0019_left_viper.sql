-- Library sorting can rank works by how central they are to the citation
-- network. The score is PageRank over the accepted cites edges, normalized
-- so the top work is 1, refreshed by scripts/archive/refresh-significance.ts.
-- null means the work has never been scored.
ALTER TABLE `sources` ADD `significance` real;
