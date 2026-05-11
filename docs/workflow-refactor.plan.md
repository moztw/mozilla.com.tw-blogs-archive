# Workflow Refactor Plan

## Summary

Refactor the archive pipeline into five explicit stages:

1. `archive`: fetch source material and assets.
2. `parse`: convert raw material into canonical JSON, Markdown, and metadata.
3. `localize`: rewrite parsed content to local assets when local files exist.
4. `build`: compile localized content into static site output.
5. `deploy`: publish build output only.

The refactor also merges duplicated blog and tech behavior behind shared site
profiles and shared workflow tools. Every stage must target one explicit site.
There is no `--all` option for any stage.

## Current Status

Implemented:

- Shared site profiles are the source of truth for archive/build/deploy paths,
  hosts, feature flags, and deploy paths.
- Shared workflow helpers now cover CLI arg parsing, JSON report writing,
  relative paths, sleep/delay, retry/404 behavior, Wayback URL construction,
  and URL normalization.
- `workflow.js` is the user-facing stage runner.
- `parse --site blog` rebuilds both articles and blog event JSON/Markdown from
  local raw HTML.
- `parse --site tech` rebuilds both articles and tech author JSON/Markdown from
  local raw HTML.
- `localize`, `build`, `report`, and `deploy` are routed through explicit site
  profiles.
- `build` now writes the merged root sitemap to `site-build/sitemap.xml`.
- `deploy` copies existing build output and `site-build/sitemap.xml`; it no
  longer rebuilds or regenerates the sitemap.
- `build-sitemaps.js` can be run directly when only the sitemap needs to be
  refreshed; it scans existing `blog/` and `tech/` build output and does not
  rebuild either site.
- Build output deploys under `taipei/` and `tech/`.
- `--all` is intentionally unsupported.

Remaining intentional compatibility surface:

- Low-level `archive-wayback.js` subcommands such as `scan`, `discover`,
  `media-recover`, and `wp-content-crosscheck` remain available for targeted
  recovery work. The workflow runner uses them as workers rather than deleting
  their direct CLI surface.
- `recover-assets` is an auxiliary recovery command after `parse`; it is kept
  outside the five-stage happy path so `archive` does not need to parse content
  just to discover media URLs.

## CLI Contract

Single-site stages:

```sh
node scripts/workflow.js archive --site blog
node scripts/workflow.js archive --site tech
node scripts/workflow.js parse --site blog
node scripts/workflow.js parse --site tech
node scripts/workflow.js localize --site blog
node scripts/workflow.js localize --site tech
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
node scripts/workflow.js localize-both
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
- Produce raw HTML and source/recovery reports.
- Use shared fetch, retry, timeout, URL normalization, and Wayback fallback
  helpers.
- Keep blog events and tech authors as site feature workers.

Non-responsibilities:

- Do not generate final site pages.
- Do not modify deploy output.
- Do not write canonical `articles-json`, `articles-md`, `events-json`,
  `events-md`, `authors-json`, or `authors-md`; that belongs to `parse`.

### parse

Purpose: convert raw material into canonical build input.

Responsibilities:

- Convert raw HTML into `articles-json`, `articles-md`, and metadata.
- Convert blog event raw HTML into `events-json` and `events-md`.
- Convert tech author raw HTML into `authors-json` and `authors-md`.
- Preserve parsed content and extracted metadata without doing asset repair.

Non-responsibilities:

- Do not fetch new network resources.
- Do not localize asset URLs.
- Do not write build output.

### localize

Purpose: make parsed content point at local files when those files exist.

Responsibilities:

- Read parsed content and asset mappings.
- Rewrite remote file URLs to `../assets/...` paths when a local asset exists.
- Handle all mapped remote file URLs, not just `wp-content/uploads`.
- Write a report describing how many references were localized.

Non-responsibilities:

- Do not fetch network resources.
- Do not re-parse raw HTML.
- Do not generate final site pages.

### build

Purpose: compile localized content into static site trees.

Responsibilities:

- Read canonical localized output only.
- Copy already-localized assets.
- Build posts, category pages, month pages, event pages, author pages, and
  compatibility aliases according to the site profile.
- Generate the merged root sitemap after every build, using the current build
  output trees for both sites.
- Allow direct sitemap refresh via `build-sitemaps.js` without rebuilding.
- Keep defensive URL rewriting only as a fallback.
- Sync the completed build output and existing `site-build/sitemap.xml` to the
  `gh-pages` worktree.

Non-responsibilities:

- Do not repair archive data.
- Do not fetch network resources.
- Do not re-parse raw HTML as the primary source of truth.

### deploy

Purpose: publish the prepared `gh-pages` worktree.

Responsibilities:

- Commit and push to the configured remote and branch.
- Remove the default temporary deploy worktree after a successful push, unless
  an explicit worktree was provided or `--keep-worktree` is used.
- Support explicit single-site deploy and explicit `deploy-both`.

Non-responsibilities:

- Do not archive, parse, or repair content.
- Do not build static pages, generate sitemap, or sync build output.

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
   - `localize` output must reference local assets when present
   - `build` output must not regress localized assets back to remote URLs

## Acceptance Checks

- `node --check` passes for all new and changed scripts.
- `node scripts/workflow.js build --site blog` builds the blog site and then
  writes the merged `site-build/sitemap.xml`.
- `node scripts/workflow.js build --site tech` builds the tech site and then
  writes the merged `site-build/sitemap.xml`.
- `node scripts/workflow.js localize --site blog` localizes blog content only.
- `node scripts/workflow.js localize --site tech` localizes tech content only.
- `node scripts/workflow.js localize-both` localizes both sites explicitly.
- `node scripts/workflow.js build-both` builds both sites explicitly and then
  writes the merged `site-build/sitemap.xml`.
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
4. Add the `localize` stage for canonical local asset rewriting.
5. Route archive and recover commands through workflow workers.
6. Update npm scripts and README after the CLI is stable.
