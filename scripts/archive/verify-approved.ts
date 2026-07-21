#!/usr/bin/env bun
import path from 'node:path';
import { parseImporterCli } from '../import/lib/run';
import { verifyApprovedSnapshots } from './approved-snapshot';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
	const equals = process.argv.find((value) => value.startsWith(`${flag}=`));
	return equals?.slice(flag.length + 1);
}

if (import.meta.main) {
	const root = path.resolve(argValue('--root') ?? process.cwd());
	const { db } = parseImporterCli();
	verifyApprovedSnapshots(db, root)
		.then((summary) => {
			console.log(`approved snapshots verified manifests=${summary.manifests} pages=${summary.pages}`);
		})
		.catch((error) => {
			console.error(error);
			process.exit(1);
		});
}
