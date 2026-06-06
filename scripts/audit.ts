#!/usr/bin/env bun
/**
 * Repo audit — security/quality smell checks for db.aynu.org.
 *
 * This tool encodes the project's DELIBERATE posture so re-audits don't re-flag
 * things that are intentional design:
 *
 *   • OPEN EDITING IS A FEATURE, not a gap. db.aynu.org is a collaborative
 *     scholarly catalogue: any signed-in account may create or edit any source,
 *     and every change is attributed and versioned in `sourceRevisions`. So the
 *     fact that the mutation routes check only `locals.user` (authentication),
 *     not ownership/roles (authorization), is BY DESIGN and is intentionally
 *     NOT reported here. Edits are wiki-style and auditable, not locked down.
 *   • The machine write API (POST/PATCH /api/sources) is gated by a shared
 *     bearer token (SOURCES_WRITE_TOKEN), not a session — also by design (it is
 *     driven by the Ainu MCP worker, which carries no auth cookie).
 *
 * What it DOES check:
 *   1. No secrets committed to git (.env tracked, key/cert files)      [fail]
 *   2. Dependency advisories via `bun audit`                            [warn]
 *   3. Risky code patterns (shell injection, raw-HTML XSS, eval)        [warn]
 *
 * Warnings are "a human should look", not necessarily bugs (many dep advisories
 * are transitive/dev-only and not immediately fixable). By default the tool
 * exits non-zero ONLY on hard failures — committed secrets — so it is safe to
 * run routinely. Pass `--strict` to make warnings fail too (for CI gating).
 *
 * Run: bun run audit          (fails only on committed secrets)
 *      bun run audit --strict (fails on any finding)
 */
import { execFileSync } from 'node:child_process';

type Finding = { level: 'fail' | 'warn'; rule: string; detail: string };
const findings: Finding[] = [];
const add = (level: Finding['level'], rule: string, detail: string) =>
	findings.push({ level, rule, detail });

/** Run a command, capturing output; never throws (returns exit code instead). */
function sh(cmd: string, args: string[]): { code: number; out: string } {
	try {
		const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		return { code: 0, out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
	}
}

// ── 1. Secrets must never be committed ──────────────────────────────────────
const SECRET_FILES = ['.env', '.env.local', '.env.production', '.dev.vars', 'id_rsa'];
for (const f of SECRET_FILES) {
	if (sh('git', ['ls-files', '--error-unmatch', f]).code === 0)
		add('fail', 'secret-committed', `${f} is tracked in git — untrack it and rotate the secret`);
}
for (const f of sh('git', ['ls-files']).out.split('\n')) {
	if (/\.(pem|key|p12|pfx)$/.test(f)) add('fail', 'secret-committed', `${f} looks like a private key/cert`);
}
if (!sh('git', ['check-ignore', '.env']).out.trim())
	add('fail', 'env-not-ignored', '.env is not covered by .gitignore');

// ── 2. Dependency advisories ────────────────────────────────────────────────
const audit = sh('bun', ['audit']);
if (audit.code !== 0 && /vulnerab/i.test(audit.out))
	add('warn', 'dependency-advisory', audit.out.trim().split('\n').slice(0, 15).join('\n'));
else if (audit.code !== 0)
	add('warn', 'audit-unavailable', `bun audit could not run (offline/unsupported): ${audit.out.trim().split('\n')[0] ?? ''}`);

// ── 3. Risky code patterns (warnings — each needs a human look) ─────────────
// Self-excluded via the `:!scripts/audit.ts` pathspec so the pattern table
// below doesn't match itself.
const PATTERNS: { rule: string; re: string; note: string }[] = [
	{ rule: 'shell-injection', re: 'execSync\\(`', note: 'shell string w/ interpolation — prefer execFileSync(argv)' },
	{ rule: 'raw-html', re: '\\{@html ', note: 'Svelte {@html} — confirm the value is not user-derived' },
	{ rule: 'map-popup-html', re: '(setHTML|bindPopup)\\(`', note: 'HTML-string popup — build DOM nodes instead' },
	{ rule: 'inner-html', re: '\\.innerHTML\\s*=', note: 'direct innerHTML write — verify no untrusted input' },
	{ rule: 'eval', re: '\\beval\\(', note: 'eval() — avoid' }
];
for (const p of PATTERNS) {
	const r = sh('git', ['grep', '-nE', p.re, '--', 'src', 'scripts', ':!scripts/audit.ts']);
	if (r.code === 0 && r.out.trim())
		for (const line of r.out.trim().split('\n')) add('warn', p.rule, `${line}  (${p.note})`);
}

// ── Report ──────────────────────────────────────────────────────────────────
const strict = process.argv.includes('--strict');
const fails = findings.filter((f) => f.level === 'fail');
const warns = findings.filter((f) => f.level === 'warn');
for (const f of findings) console.log(`${f.level === 'fail' ? '✗' : '⚠'} [${f.rule}] ${f.detail}`);
console.log(`\nAudit: ${fails.length} failure(s), ${warns.length} warning(s)${strict ? ' (strict)' : ''}.`);
if (!findings.length) console.log('✓ clean');
process.exit(fails.length || (strict && warns.length) ? 1 : 0);
