#!/usr/bin/env bun
import path from 'node:path';
import { parseImporterCli } from '../import/lib/run';
import { exportApprovedSnapshot } from './approved-snapshot';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
	const equals = process.argv.find((value) => value.startsWith(`${flag}=`));
	return equals?.slice(flag.length + 1);
}

if (import.meta.main) {
	const revisionId = argValue('--revision');
	if (!revisionId) {
		console.error('Pass --revision <revision-id>.');
		process.exit(1);
	}
	const outputRoot = path.resolve(argValue('--output-root') ?? process.cwd());
	const { db } = parseImporterCli();
	exportApprovedSnapshot(db, revisionId, outputRoot, { resultingCommit: argValue('--commit') ?? null })
		.then((result) => {
			console.log(
				`approved snapshot ${result.manifest.publication_snapshot} pages=${result.manifest.pages.length} manifest=${path.relative(outputRoot, result.manifestPath)}`
			);
		})
		.catch((error) => {
			console.error(error);
			process.exit(1);
		});
}
