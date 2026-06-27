# アイヌ語文献資料データベース · Ainu Textual Sources Database

An open philological knowledge base for the Ainu language, deployed at **db.aynu.org**.
It aggregates historical documents, dictionaries, wordlists, oral-literature records and
secondary research, and links their bibliographic data, holdings, digital images,
geographic and chronological information — so a linguist can see at a glance *where the
sources are, what they contain, who recorded them, and what research surrounds them*.

Part of the [Aynu.org](https://aynu.org) family.

## Stack

- **SvelteKit 2 + Svelte 5** (runes), **Tailwind CSS v4**
- **Cloudflare Workers** (`@sveltejs/adapter-cloudflare`)
- **Drizzle ORM + libSQL/Turso** (SQLite)
- **better-auth** (email + GitHub) for collaborative wiki-style editing
- **Paraglide** i18n — English / 日本語 / Русский
- **Leaflet** map; custom SVG timeline

## Data model

The central entity is the **Source** (`資料`). Around it: `source_links`, `persons` +
`source_persons`, `places` + `source_places` (geocoded for the map), `institutions` +
`source_institutions`, `source_relations`, `tags` + `source_tags`, and `source_revisions`
(full edit history). See `src/lib/server/db/schema.ts`.

## Seed data

`scripts/seed.ts` builds the database from three sibling repositories under `AINU_ROOT`
(default: two levels up):

| Repo | → | Sources |
|------|---|---------|
| `ainu-dictionaries/catalog.json` | dictionaries, wordlists, old documents | 78 |
| `ainu-grammar/{books,articles}` | secondary research literature | 122 |
| `ainu-corpora/data.jsonl` | aligned Ainu/Japanese corpus collections | 37 |

It parses dates, extracts persons, maps dialects → geocoded places, derives
languages/scripts, and links holding institutions from corpus URIs. Idempotent
(wipes the domain tables — not auth — and rebuilds; manual edits are not preserved,
so run it for initial population only).

## Local development

```sh
bun install
cp .env.example .env          # the defaults use a local file:local.db
bun run db:migrate            # apply migrations to local.db
ALLOW_LEGACY_WIPE=1 bun run seed  # populate from the sibling data repos (wipes + rebuilds; gated)
bun run dev                   # http://localhost:5173
```

`bun run auth:schema` regenerates the better-auth Drizzle tables (already committed).

## Deployment (Cloudflare Workers · db.aynu.org)

1. Create a Turso database and apply the schema:
   ```sh
   turso db create ainu-sources
   DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… bun run db:migrate
   DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… ALLOW_LEGACY_WIPE=1 bun run seed
   ```
2. Set Worker secrets:
   ```sh
   wrangler secret put DATABASE_URL
   wrangler secret put DATABASE_AUTH_TOKEN
   wrangler secret put BETTER_AUTH_SECRET      # 32+ random chars
   wrangler secret put GITHUB_CLIENT_ID        # optional
   wrangler secret put GITHUB_CLIENT_SECRET     # optional
   ```
   `ORIGIN` is set as a plain var in `wrangler.jsonc` (`https://db.aynu.org`).
3. Deploy (the `db.aynu.org` custom-domain route is in `wrangler.jsonc`; the
   `aynu.org` zone must be on the same Cloudflare account):
   ```sh
   bun run deploy
   ```

## Project layout

```
src/
  lib/
    components/      Header, Footer, SourceCard, Facets, Pagination, Timeline, MapView, SourceForm, …
    server/
      db/            schema.ts, auth.schema.ts, index.ts (drizzle client)
      queries.ts     all data access + create/update with revisions
      auth.ts        better-auth config
      form.ts        SourceForm parsing + open-redirect guard
    constants.ts     controlled vocabularies + localized labels
    format.ts        year / century / count formatting, slugify
    filters.ts       URL searchParams ↔ SourceFilters
  routes/
    sources/         list, [slug] detail, new, [slug]/edit, [slug]/history, [slug]/cite.{bib,json}
    people|places|institutions/   directory + [slug]
    timeline/ map/ about/ login/ register/ account/
    api/search/      JSON quick-search
scripts/seed.ts      ETL from the three data repos
messages/{en,ja,ru}.json
```

> Note: `bun run check` reports 2 type errors inside the generated
> `src/lib/paraglide/server.js` (a known `@cloudflare/workers-types` global-`Request`
> vs DOM-`Request` clash in generated code). They do not affect `vite build` or runtime.
