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
type Fixture = {
	documents: Array<{
		id: string;
		slug: string;
		title: string;
		author: string;
		year: number | null;
		source_ref: string;
		text: string;
	}>;
	queries: Array<{ id: string; q: string; expected: string[] }>;
	similar_queries: Array<{ id: string; reference: string; expected: string[] }>;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(SCRIPT_DIR, '../../drizzle');
const DEFAULT_FIXTURE = path.join(SCRIPT_DIR, 'fixtures/search-eval.json');
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
		const results: Record<
			string,
			{ queries: number; relevant: number; retrieved: number; precision_at_10: number; precision_retrieved: number }
		> = {};
		for (const mode of ['phrase', 'regex', 'soft'] as const) {
			const scores = [];
			let relevant = 0;
			let retrieved = 0;
			for (const query of fixture.queries) {
				const result = await searchArchive(db, reader, {
					q: query.q,
					mode,
					tolerance: 'normal',
					limit: 10
				});
				const slugs = result.items.slice(0, 10).map((item) => item.source.slug);
				const judgedRelevant = slugs.filter((slug) => query.expected.includes(slug)).length;
				relevant += judgedRelevant;
				retrieved += slugs.length;
				scores.push(judgedRelevant / 10);
			}
			results[mode] = {
				queries: fixture.queries.length,
				relevant,
				retrieved,
				precision_at_10: mean(scores),
				precision_retrieved: retrieved === 0 ? 0 : Number((relevant / retrieved).toFixed(4))
			};
		}
		const similarScores = [];
		let similarRelevant = 0;
		let similarRetrieved = 0;
		for (const query of fixture.similar_queries) {
			const result = await searchArchive(db, reader, {
				q: `rev-${query.reference}:0`,
				mode: 'similar',
				limit: 10
			});
			const slugs = result.items.slice(0, 10).map((item) => item.source.slug);
			const judgedRelevant = slugs.filter((slug) => query.expected.includes(slug)).length;
			similarRelevant += judgedRelevant;
			similarRetrieved += slugs.length;
			similarScores.push(judgedRelevant / 10);
		}
		results.similar = {
			queries: fixture.similar_queries.length,
			relevant: similarRelevant,
			retrieved: similarRetrieved,
			precision_at_10: mean(similarScores),
			precision_retrieved:
				similarRetrieved === 0 ? 0 : Number((similarRelevant / similarRetrieved).toFixed(4))
		};
		return { fixture: path.basename(fixturePath), documents: fixture.documents.length, results };
	} finally {
		client.close();
		await rm(directory, { recursive: true, force: true });
	}
}

async function seedFixture(db: Db, fixture: Fixture): Promise<void> {
	await db.insert(user).values([
		{ id: 'eval-reader', name: 'Evaluation Reader', email: 'eval-reader@example.test' },
		{ id: 'eval-contributor', name: 'Evaluation Contributor', email: 'eval-contributor@example.test' },
		{ id: 'eval-reviewer', name: 'Evaluation Reviewer', email: 'eval-reviewer@example.test' }
	]);
	await db.insert(schema.archiveRepositories).values({ id: 'eval-repo', name: 'search-eval' });
	for (const [index, document] of fixture.documents.entries()) {
		const hash = (index + 1).toString(16).padStart(64, '0');
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
			checkoutRepoId: 'eval-repo',
			checkoutPath: `${document.source_ref.split(':')[0]}#${document.id}`,
			createdBy: 'eval-contributor'
		});
		await db.insert(schema.archiveBlobs).values({
			sha256: hash,
			bytes: new TextEncoder().encode(document.text).length,
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
			pageCount: 1,
			reviewStatus: 'approved',
			isCurrent: true,
			submittedBy: 'eval-contributor',
			submittedAt: new Date(0),
			reviewedBy: 'eval-reviewer',
			reviewedAt: new Date(1)
		});
		await replaceOcrPages(db, `rev-${document.id}`, 'fixture', [{ page: 0, text: document.text }]);
	}
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
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
