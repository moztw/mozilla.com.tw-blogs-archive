# Workflow Refactor Plan

## Summary

Refactor the archive pipeline into four explicit stages:

1. `archive`: fetch source material and assets.
2. `parse`: convert raw material into canonical JSON, Markdown, and metadata.
3. `build`: compile parsed content into static site output.
4. `deploy`: publish build output only.

The refactor also merges duplicated blog and tech behavior behind shared site
profiles and shared workflow tools. Every stage must target one explicit site.
There is no `--all` option for any stage.

## CLI Contract

Single-site stages:

```sh
node scripts/workflow.js archive --site blog
node scripts/workflow.js archive --site tech
node scripts/workflow.js parse --site blog
node scripts/workflow.js parse --site tech
node scripts/workflow.js build --site blog
node scripts/workflow.js build --site tech
node scripts/workflow.js deploy --site blog
node scripts/workflow.js deploy --site tech
node scripts/workflow.js recover-assets --site blog
node scripts/workflow.js recover-assets --site tech
node scripts/workflow.js report --site blog
node scripts/workflow.js report --site tech
```

Explicit two-site orchestration commands:

```sh
node scripts/workflow.js build-both
node scripts/workflow.js deploy-both
node scripts/workflow.js report-both
```

Rules:

- Do not implement `--all`.
- A normal stage command without `--site` must fail with a clear error.
- Two-site commands must be named explicitly with `-both`.
- Existing npm scripts may remain as compatibility wrappers, but should route
  through `scripts/workflow.js` where practical.

## Shared Site Profiles

Create a shared profile module for site-specific values:

- `siteKey`: `blog` or `tech`
- `siteHost`
- `siteOrigin`
- `archiveDir`
- `buildDir`
- `timemapPath`
- `wpContentPath`
- `siteTitle`
- `siteSubtitle`
- `siteDescription`
- theme assets and background settings
- deploy path under the `gh-pages` worktree
- feature flags:
  - `hasEvents`
  - `hasAuthors`
  - `hasAuthorCardAliases`

The profile module becomes the source of truth for values currently repeated
across archive, build, and deploy scripts.

## Stage Responsibilities

### archive

Purpose: fetch external source material and record recovery status.

Responsibilities:

- Fetch Wayback HTML snapshots.
- Fetch assets and retry recoverable missing assets.
- Produce raw HTML, local asset files, and recovery reports.
- Use shared fetch, retry, timeout, URL normalization, and Wayback fallback
  helpers.
- Keep blog events and tech authors as site feature workers.

Non-responsibilities:

- Do not generate final site pages.
- Do not modify deploy output.

### parse

Purpose: convert raw material into canonical build input.

Responsibilities:

- Convert raw HTML into `articles-json`, `articles-md`, and metadata.
- Convert blog event raw HTML into `events-json` and `events-md`.
- Convert tech author raw HTML into `authors-json` and `authors-md`.
- Resolve content image URLs to local asset paths when local assets exist.
- Write canonical content references that build can consume without guessing.

Non-responsibilities:

- Do not fetch new network resources.
- Do not write build output.

### build

Purpose: compile parsed content into static site trees.

Responsibilities:

- Read canonical parse output only.
- Copy already-localized assets.
- Build posts, category pages, month pages, event pages, author pages, and
  compatibility aliases according to the site profile.
- Keep defensive URL rewriting only as a fallback.

Non-responsibilities:

- Do not repair archive data.
- Do not fetch network resources.
- Do not re-parse raw HTML as the primary source of truth.

### deploy

Purpose: publish build output.

Responsibilities:

- Sync build output to a `gh-pages` worktree.
- Generate the root index and merged sitemap.
- Commit and push to the configured remote and branch.
- Support explicit single-site deploy and explicit `deploy-both`.

Non-responsibilities:

- Do not archive, parse, or repair content.

## Refactor Targets

1. Add `scripts/lib/site-profiles.js`.
2. Add `scripts/workflow.js` as the single user-facing entry point.
3. Move duplicated helpers into shared modules:
   - fetch and retry
   - Wayback URL candidates
   - asset URL normalization
   - report writing
   - JSON and Markdown output helpers
4. Convert existing scripts into workers or compatibility wrappers:
   - `archive-wayback.js`
   - `archive-authors.js`
   - `archive-events.js`
   - `archive-event-assets.js`
   - `recover-event-wp-content.js`
   - `build-site.js`
   - `deploy-gh-pages.js`
5. Fix localized asset source of truth:
   - parse output must reference local assets when present
   - build output must not regress localized assets back to remote URLs

## Acceptance Checks

- `node --check` passes for all new and changed scripts.
- `node scripts/workflow.js build --site blog` builds the blog site only.
- `node scripts/workflow.js build --site tech` builds the tech site only.
- `node scripts/workflow.js build-both` builds both sites explicitly.
- `node scripts/workflow.js build --all` fails because `--all` is unsupported.
- `node scripts/workflow.js build` fails because `--site` is required.
- Blog event pages still build:
  - `/events/`
  - `/events-list/`
  - all event detail pages
- Tech author pages still build:
  - `/authors/`
  - `/author-card`
  - `/author-card/<id>`
  - author detail pages
- A post with localized assets, such as blog post `1521`, keeps local image
  URLs in both post content and listing thumbnails after rebuild.
- Deploy no longer assumes the remote is named `origin`.

## Implementation Order

1. Add shared site profiles and workflow CLI.
2. Route build and deploy through the workflow CLI first.
3. Refactor build/deploy scripts to consume site profiles.
4. Move parse-time localized asset rewriting into the canonical parse output.
5. Route archive and recover commands through workflow workers.
6. Update npm scripts and README after the CLI is stable.

