#!/usr/bin/env bun
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { user } from '../../src/lib/server/db/auth.schema';
import * as schema from '../../src/lib/server/db/schema';
import { replaceOcrPages, searchArchive } from '../../src/lib/server/archive/ocr';
import type { ArchivePrincipal } from '../../src/lib/server/archive/types';

type Db = LibSQLDatabase<typeof schema>;

/**
 * Documents are excerpts: one entry per work, carrying the scan pages the
 * queries are judged against. `source_ref` names the source slug on
 * db.aynu.org; gold documents copy their page text verbatim from the
 * archive's OCR chunks for that slug.
 */
type FixtureDocument = {
	id: string;
	slug: string;
	title: string;
	author: string;
	year: number | null;
	source_ref: string;
	pages: Array<{ page: number; text: string }>;
};

type ExpectedHit = { slug: string; page?: number };

/**
 * Query kinds separate what each query measures:
 * - normalization: script-crossing and diacritic handling on synthetic text
 * - exact: a literal phrase that occurs on a known real scan page
 * - variant: an orthographic or OCR-damaged form of text on a known page
 * - crosslingual: a query in one language for a passage in another; lexical
 *   modes are expected to miss these, and their score is the gap a semantic
 *   mode has to close
 */
type QueryKind = 'normalization' | 'exact' | 'variant' | 'crosslingual';

type FixtureQuery = { id: string; kind: QueryKind; q: string; expected: ExpectedHit[] };

type Fixture = {
	documents: FixtureDocument[];
	queries: FixtureQuery[];
	similar_queries: Array<{ id: string; reference: string; expected: string[] }>;
};

type KindScore = { queries: number; recall_at_10: number; mrr: number };

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(SCRIPT_DIR, '../../drizzle');
const DEFAULT_FIXTURE = path.join(SCRIPT_DIR, 'fixtures/search-eval.json');
const MODES = ['phrase', 'regex', 'soft'] as const;
const reader: ArchivePrincipal = {
	userId: 'eval-reader',
	role: 'archive_reader',
	identity: { kind: 'github_login', value: 'eval-reader' },
	authn: 'access_jwt'
};

export async function runSearchEvaluation(fixturePath = DEFAULT_FIXTURE) {
	const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture;
	const directory = await mkdtemp(path.join(tmpdir(), 'archive-search-eval-'));
	const client = createClient({ url: `file:${path.join(directory, 'eval.db')}` });
	const db = drizzle(client, { schema });
	try {
		await migrate(db, { migrationsFolder: MIGRATIONS });
		await seedFixture(db, fixture);

		const modes: Record<string, { kinds: Record<string, KindScore>; overall: KindScore }> = {};
		for (const mode of MODES) {
			const ranks = new Map<string, Array<number | null>>();
			for (const query of fixture.queries) {
				// A mode that rejects the query outright (regex refuses short
				// literals, for instance) scores it as a miss: the reader who
				// typed it got no results from that engine.
				const items = await searchArchive(db, reader, {
					q: query.q,
					mode,
					tolerance: 'normal',
					limit: 10
				}).then(
					(result) => result.items.slice(0, 10),
					() => []
				);
				const rank = items.findIndex((item) =>
					query.expected.some(
						(hit) => hit.slug === item.source.slug && (hit.page === undefined || hit.page === item.page)
					)
				);
				const list = ranks.get(query.kind) ?? [];
				list.push(rank === -1 ? null : rank + 1);
				ranks.set(query.kind, list);
			}
			const kinds: Record<string, KindScore> = {};
			for (const [kind, list] of ranks) kinds[kind] = score(list);
			modes[mode] = { kinds, overall: score([...ranks.values()].flat()) };
		}

		const similarRanks: Array<number | null> = [];
		for (const query of fixture.similar_queries) {
			const result = await searchArchive(db, reader, {
				q: `rev-${query.reference}:1`,
				mode: 'similar',
				limit: 10
			});
			const rank = result.items
				.slice(0, 10)
				.findIndex((item) => query.expected.includes(item.source.slug));
			similarRanks.push(rank === -1 ? null : rank + 1);
		}

		// Runs the reserved mode so the day it ships, this report scores it
		// against the same gold queries with no harness change.
		const semanticProbe = await searchArchive(db, reader, { q: fixture.queries[0]?.q ?? 'probe', mode: 'semantic', limit: 10 });

		return {
			fixture: path.basename(fixturePath),
			documents: fixture.documents.length,
			queries: fixture.queries.length,
			modes,
			similar: score(similarRanks),
			semantic: 'enabled' in semanticProbe && semanticProbe.enabled === false ? { enabled: false } : { enabled: true }
		};
	} finally {
		client.close();
		await rm(directory, { recursive: true, force: true });
	}
}

/** rank list → recall@10 (share of queries with a relevant hit) and MRR. */
function score(ranks: Array<number | null>): KindScore {
	if (ranks.length === 0) return { queries: 0, recall_at_10: 0, mrr: 0 };
	const hits = ranks.filter((rank): rank is number => rank !== null);
	const mrr = ranks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / ranks.length;
	return {
		queries: ranks.length,
		recall_at_10: round(hits.length / ranks.length),
		mrr: round(mrr)
	};
}

function round(value: number): number {
	return Number(value.toFixed(4));
}

async function seedFixture(db: Db, fixture: Fixture): Promise<void> {
	await db.insert(user).values([
		{ id: 'eval-reader', name: 'Evaluation Reader', email: 'eval-reader@example.test' },
		{ id: 'eval-contributor', name: 'Evaluation Contributor', email: 'eval-contributor@example.test' },
		{ id: 'eval-admin', name: 'Evaluation Admin', email: 'eval-admin@example.test' }
	]);
	await db.insert(schema.archiveRepositories).values({ id: 'eval-repo', name: 'search-eval' });
	for (const [index, document] of fixture.documents.entries()) {
		const hash = (index + 1).toString(16).padStart(64, '0');
		const bytes = document.pages.reduce((sum, page) => sum + new TextEncoder().encode(page.text).length, 0);
		await db.insert(schema.sources).values({
			id: `source-${document.id}`,
			slug: document.slug,
			title: document.title,
			author: document.author,
			yearStart: document.year,
			category: 'research',
			type: 'article',
			humanDownload: true
		});
		await db.insert(schema.sourceFiles).values({
			id: `file-${document.id}`,
			sourceId: `source-${document.id}`,
			role: 'scan',
			createdBy: 'eval-contributor'
		});
		await db.insert(schema.fileCheckouts).values({
			id: `checkout-${document.id}`,
			sourceFileId: `file-${document.id}`,
			repoId: 'eval-repo',
			path: `${document.source_ref.split(':')[0]}#${document.id}`,
			createdBy: 'eval-contributor'
		});
		await db.insert(schema.archiveBlobs).values({
			sha256: hash,
			bytes,
			detectedMediaType: 'text/plain',
			storageState: 'verified',
			verifiedAt: new Date(),
			createdBy: 'eval-contributor'
		});
		await db.insert(schema.fileRevisions).values({
			id: `rev-${document.id}`,
			sourceFileId: `file-${document.id}`,
			revisionNo: 1,
			blobSha256: hash,
			originalFilename: `${document.id}.txt`,
			declaredMediaType: 'text/plain',
			artifactKind: 'original',
			pageCount: Math.max(...document.pages.map((page) => page.page), 1),
			isCurrent: true,
			submittedBy: 'eval-contributor',
			submittedAt: new Date(0)
		});
		await replaceOcrPages(db, `rev-${document.id}`, 'fixture', document.pages);
	}
}

if (import.meta.main) {
	const fixtureArg = process.argv.find((arg) => arg.startsWith('--fixture='));
	runSearchEvaluation(fixtureArg?.slice('--fixture='.length))
		.then((result) => console.log(JSON.stringify(result, null, 2)))
		.catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
}
