#!/usr/bin/env bun
/**
 * Generate reading derivatives for approved PDF scan revisions.
 *
 * The reader and the page-image endpoint serve pre-rendered objects out of R2
 * under `derivatives/<revision>/…`; nothing produces them at upload time, so a
 * freshly approved scan shows "page image unavailable" until this runs. This
 * script closes that gap: for every approved, current, PDF scan revision that
 * is missing its derivatives it renders each page to size-capped WebP at the
 * two widths the reader requests (300 and 1200), writes a linearized PDF, and
 * records the page count on the revision.
 *
 * It is resumable and idempotent: an object already present in R2 is skipped,
 * so an interrupted run resumes without re-rendering, and a re-run is a no-op.
 * Intended to run right after upload/approval (and can be scheduled as a
 * sweep), mirroring the other scripts/archive batch tools.
 *
 * Connection + R2 env mirror scripts/archive/recognize-pages.ts:
 *   DATABASE_URL (+ DATABASE_AUTH_TOKEN for remote)
 *   R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *
 * Flags: --revision <id> (one revision), --limit N, --dry-run,
 *        --assume-missing (skip R2 completeness probes; useful for CI smoke).
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
  archiveBlobs,
  fileRevisions,
  sourceFiles,
  sources,
} from "../../src/lib/server/db/schema";

// The two widths the reader and page-image endpoint ask for (w300 thumbnail,
// w1200 reading). Keep in sync with worker/src/derivatives.ts DerivativeWidth.
const WIDTHS = [300, 1200] as const;
const RENDER_DPI = Number(process.env.DERIVATIVE_DPI ?? 200);
const RENDER_WINDOW = Number(process.env.DERIVATIVE_RENDER_WINDOW ?? 24);
const WEBP_QUALITY = Number(process.env.DERIVATIVE_WEBP_QUALITY ?? 82);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eqForm = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eqForm ? eqForm.slice(flag.length + 1) : undefined;
}
const hasFlag = (flag: string) => process.argv.includes(flag);

/** Parse `--limit`: absent means no cap; anything that is not a positive,
 *  finite integer is rejected so `done >= limit` always terminates the run. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return Infinity;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--limit must be a positive integer, got "${raw}"`);
  }
  return value;
}

type Row = {
  revisionId: string;
  slug: string;
  blobSha256: string;
  pageCount: number | null;
};

function r2Configured(): boolean {
  return [
    "R2_BUCKET",
    "R2_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ].every((name) => !!process.env[name]);
}

function r2Env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: requireEnv("R2_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY: requireEnv("R2_SECRET_ACCESS_KEY"),
    AWS_DEFAULT_REGION: "auto",
  };
}

function blobKey(sha: string): string {
  return `blobs/sha256/${sha.slice(0, 2)}/${sha}`;
}

function pageDerivativeKey(
  revisionId: string,
  page: number,
  width: number,
): string {
  return `derivatives/${revisionId}/pages/${page}/w${width}.webp`;
}

function linearizedKey(revisionId: string): string {
  return `derivatives/${revisionId}/linearized.pdf`;
}

function r2ObjectExists(key: string): boolean {
  if (!r2Configured()) return false;
  try {
    execFileSync(
      "aws",
      [
        "s3api",
        "head-object",
        "--bucket",
        requireEnv("R2_BUCKET"),
        "--key",
        key,
        "--endpoint-url",
        requireEnv("R2_ENDPOINT"),
      ],
      { stdio: "ignore", env: r2Env() },
    );
    return true;
  } catch {
    return false;
  }
}

function r2Get(key: string, file: string): void {
  if (!r2Configured()) {
    throw new Error(
      "R2 credentials are required unless --dry-run is used with --assume-missing",
    );
  }
  execFileSync(
    "aws",
    [
      "s3api",
      "get-object",
      "--bucket",
      requireEnv("R2_BUCKET"),
      "--key",
      key,
      "--endpoint-url",
      requireEnv("R2_ENDPOINT"),
      file,
    ],
    { stdio: "ignore", env: r2Env() },
  );
}

function r2Put(key: string, file: string, contentType: string): void {
  if (!r2Configured()) throw new Error("R2 credentials are required");
  execFileSync(
    "aws",
    [
      "s3api",
      "put-object",
      "--bucket",
      requireEnv("R2_BUCKET"),
      "--key",
      key,
      "--body",
      file,
      "--content-type",
      contentType,
      "--endpoint-url",
      requireEnv("R2_ENDPOINT"),
    ],
    { stdio: "ignore", env: r2Env() },
  );
}

function pdfPageCount(pdf: string): number {
  const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
  return Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
}

/** Authoritative page count read from the source PDF in R2, or null when R2 is
 *  unavailable or the count cannot be read. The DB `page_count` is not trusted
 *  here: a stale low value would make the completeness check probe an earlier
 *  page as the "last" page and wrongly skip missing real final-page images. */
async function sourcePageCount(row: Row): Promise<number | null> {
  if (!r2Configured()) return null;
  const workDir = mkdtempSync(path.join(tmpdir(), "ainu-page-count-"));
  try {
    const pdf = path.join(workDir, "source.pdf");
    r2Get(blobKey(row.blobSha256), pdf);
    const total = pdfPageCount(pdf);
    return total > 0 ? total : null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function derivativesComplete(row: Row): Promise<boolean> {
  if (!r2Configured()) return false;
  if (!row.pageCount || row.pageCount <= 0) return false;
  // Cheap R2 probes first, keyed off the recorded page count. Only when the
  // linearized PDF and both edge pages are present do we pay for a source
  // download to confirm the recorded count is authoritative.
  const cheapComplete =
    r2ObjectExists(linearizedKey(row.revisionId)) &&
    WIDTHS.every((w) =>
      r2ObjectExists(pageDerivativeKey(row.revisionId, 1, w)),
    ) &&
    WIDTHS.every((w) =>
      r2ObjectExists(pageDerivativeKey(row.revisionId, row.pageCount!, w)),
    );
  if (!cheapComplete) return false;
  const total = await sourcePageCount(row);
  if (!total) return false;
  // A mismatch means the recorded count is stale, so the "last page" probed
  // above was not the real final page: treat the work as incomplete.
  return total === row.pageCount;
}

/** Render one page to a size-capped WebP at each width, uploading each object
 *  unless it already exists. Returns false only if the source render failed. */
function renderPageWebp(
  pdf: string,
  page: number,
  revisionId: string,
  renderDir: string,
  dryRun: boolean,
): boolean {
  const missing = WIDTHS.filter(
    (w) => !r2ObjectExists(pageDerivativeKey(revisionId, page, w)),
  );
  if (missing.length === 0) return true;
  if (dryRun) {
    for (const w of missing)
      console.log(`      would render page ${page} w${w}`);
    return true;
  }
  // One high-DPI PNG per page, then downscale to each target width. Rendering
  // once and resizing keeps the text crisp at both sizes.
  const pngPrefix = path.join(renderDir, `p${page}`);
  execFileSync(
    "pdftoppm",
    [
      "-f",
      String(page),
      "-l",
      String(page),
      "-r",
      String(RENDER_DPI),
      "-png",
      pdf,
      pngPrefix,
    ],
    {
      stdio: "ignore",
    },
  );
  const png = readdirSync(renderDir).find(
    (f) => f.startsWith(`p${page}`) && f.endsWith(".png"),
  );
  if (!png) return false;
  const pngPath = path.join(renderDir, png);
  for (const w of missing) {
    const webp = path.join(renderDir, `p${page}-w${w}.webp`);
    // `>` only shrinks: a page narrower than the target keeps its size
    // rather than being upscaled into a larger, blurrier object.
    execFileSync(
      "magick",
      [
        pngPath,
        "-resize",
        `${w}x>`,
        "-quality",
        String(WEBP_QUALITY),
        "-define",
        "webp:method=6",
        webp,
      ],
      { stdio: "ignore" },
    );
    r2Put(pageDerivativeKey(revisionId, page, w), webp, "image/webp");
    rmSync(webp, { force: true });
  }
  rmSync(pngPath, { force: true });
  return true;
}

function generateLinearized(
  pdf: string,
  revisionId: string,
  workDir: string,
  dryRun: boolean,
): void {
  if (r2ObjectExists(linearizedKey(revisionId))) return;
  if (dryRun) {
    console.log("      would write linearized.pdf");
    return;
  }
  const out = path.join(workDir, "linearized.pdf");
  // qpdf --linearize on failure exits 3 for warnings but still writes output;
  // treat a written file as success and fall back to the original otherwise.
  try {
    execFileSync("qpdf", ["--linearize", pdf, out], { stdio: "ignore" });
  } catch {
    if (!existsSync(out) || statSync(out).size === 0) {
      r2Put(linearizedKey(revisionId), pdf, "application/pdf");
      return;
    }
  }
  r2Put(
    linearizedKey(revisionId),
    existsSync(out) && statSync(out).size > 0 ? out : pdf,
    "application/pdf",
  );
  rmSync(out, { force: true });
}

async function generateForRevision(
  row: Row,
  workRoot: string,
  dryRun: boolean,
): Promise<void> {
  const workDir = mkdtempSync(path.join(workRoot, `${row.revisionId}-`));
  const renderDir = path.join(workDir, "pages");
  mkdirSync(renderDir, { recursive: true });
  const pdf = path.join(workDir, "source.pdf");
  try {
    r2Get(blobKey(row.blobSha256), pdf);
    const total = pdfPageCount(pdf);
    if (total <= 0) throw new Error("could not read page count");
    console.log(`  ${row.slug} (${row.revisionId}): ${total} pages`);

    let failures = 0;
    for (let first = 1; first <= total; first += RENDER_WINDOW) {
      const last = Math.min(first + RENDER_WINDOW - 1, total);
      for (let page = first; page <= last; page += 1) {
        if (!renderPageWebp(pdf, page, row.revisionId, renderDir, dryRun))
          failures += 1;
      }
      // Discard this window's PNGs before rendering the next so a large
      // book does not accumulate gigabytes on disk.
      for (const f of readdirSync(renderDir))
        rmSync(path.join(renderDir, f), { force: true });
      console.log(`    ${row.slug}: ${last}/${total} pages`);
    }
    if (total > 0 && failures / total > 0.1) {
      throw new Error(`${failures} of ${total} pages failed to render`);
    }

    generateLinearized(pdf, row.revisionId, workDir, dryRun);

    if (!dryRun && row.pageCount !== total) {
      await db
        .update(fileRevisions)
        .set({ pageCount: total })
        .where(eq(fileRevisions.id, row.revisionId));
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  requireEnv("DATABASE_URL");
  const dryRun = hasFlag("--dry-run");
  const assumeMissing = hasFlag("--assume-missing");
  const onlyRevision = argValue("--revision");
  const limit = parseLimit(argValue("--limit"));

  const clauses = [
    eq(fileRevisions.reviewStatus, "approved"),
    eq(fileRevisions.isCurrent, true),
    eq(sourceFiles.role, "scan"),
    eq(archiveBlobs.detectedMediaType, "application/pdf"),
  ];
  if (onlyRevision) clauses.push(eq(fileRevisions.id, onlyRevision));

  const rows = await db
    .select({
      revisionId: fileRevisions.id,
      slug: sources.slug,
      blobSha256: fileRevisions.blobSha256,
      pageCount: fileRevisions.pageCount,
    })
    .from(fileRevisions)
    .innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
    .innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
    .innerJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
    .where(and(...clauses));

  const candidates = rows.filter((row): row is Row => !!row.blobSha256);
  console.log(`${candidates.length} approved PDF scan revision(s) to consider`);

  const workRoot = mkdtempSync(path.join(tmpdir(), "ainu-derivatives-"));
  let done = 0;
  try {
    for (const row of candidates) {
      if (done >= limit) break;
      // Skip only when the linearized PDF, first page, last page, and DB page
      // count are all present. Checking the last page catches the most common
      // interrupted-run case: page 1 exists but later pages do not.
      const complete = !assumeMissing && (await derivativesComplete(row));
      if (complete && !onlyRevision) continue;
      if (dryRun && assumeMissing) {
        console.log(`  would generate ${row.slug} (${row.revisionId})`);
        done += 1;
        continue;
      }
      await generateForRevision(row, workRoot, dryRun);
      done += 1;
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
  console.log(
    `${dryRun ? "would generate" : "generated"} derivatives for ${done} revision(s)`,
  );
}

await main();
