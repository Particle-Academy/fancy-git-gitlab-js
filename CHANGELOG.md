# Changelog

All notable changes to `@particle-academy/fancy-git-gitlab` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Pre-1.0:** breaking changes land in MINOR releases. Until 1.0 the minor
> number is not a compatibility promise — read the entry, not the version.

> This file starts here. Earlier releases predate it and were never written up;
> `git log` is the record for those. It is not backfilled rather than
> guessed-at, because a changelog that invents its own history is worse than one
> that admits where it begins.

## [Unreleased]

## 0.3.0 — 2026-09-13

### Fixed

- **Every GitLab call now works. In 0.1.0–0.2.0 none of them did.** The project
  path was encoded twice — once by the adapter and again by `@gitbeaker/rest` —
  so `repository()`, `listReviews()`, `getReview()`, `createReview()`, `compare()`
  and `checks()` all asked for `projects/group%252Fapp`, which GitLab answers with
  a 404 (checked against gitlab.com). Only `identify()` ever worked.

  **What you must do:** nothing, unless you worked around it.

- **Anonymous requests work.** Without a token, 0.2.0 sent `PRIVATE-TOKEN: undefined`,
  which GitLab answers with a 401 even for a public project. No credential header
  is sent now.
- **`createReview({ draft: true })` opens a draft.** GitLab's create endpoint has
  no `draft` attribute, so it was ignored and the merge request opened ready to
  merge. The title is now prefixed with `Draft: ` (unless it already carries
  `Draft:`, `[Draft]` or `(Draft)`), which is how GitLab marks drafts.
- **`listReviews()` reports the next page from GitLab's `X-Next-Page`** instead of
  guessing from the page length, and returns `total` from `X-Total` when GitLab
  sends it. `limit` is kept within GitLab's 1–100: a `limit` above 100 used to
  make the next page undiscoverable, because GitLab serves 100 and 100 never
  equalled the limit.
- **A self-managed instance under a relative URL root** (`https://example.com/gitlab`)
  is identified correctly: `identify()` strips the root from https remotes, so the
  owner is the namespace rather than `gitlab/group`, and a same-host remote outside
  the root is not claimed.
- `checks()` reads every page of pipelines for the revision, up to 10 pages of 100,
  and fails rather than returning a list that reads as complete past that.

### Changed

- **BREAKING — `@gitbeaker/rest` is gone**, replaced by `GitLabClient`, a small
  first-party REST v4 client over `fetch` (exported). Its request layer could not
  be configured to stop following redirects (see Security), re-sent a 429 ten
  times within a few hundred milliseconds while ignoring `Retry-After`, and put
  the request — token header included — on its errors' `cause`.

  **What you must do:** if you construct the provider with
  `new GitLabProvider({ token, baseUrl })`, nothing. If you passed a Gitbeaker
  instance as `client`, pass `{ token, baseUrl }` instead, or
  `client: new GitLabClient({ token, baseUrl, tokenType, fetch })` — the
  constructor now throws `invalid_argument` on anything else, rather than failing
  on first use. Because no network method worked before, the only code this can
  break is code that used `identify()` on a hand-built client.

- **BREAKING — failures are `GitError` from `@particle-academy/fancy-git`**, not
  Gitbeaker's errors: 401/403 → `auth`, 404 → `not_found`, 405 → `unsupported`,
  409 → `conflict`, 400/422 → `invalid_argument` (with GitLab's field messages),
  429 → `rate_limited` with "Retry after N seconds", anything else → `unknown`.
  `exitCode` is the HTTP status. Invalid inputs (an empty owner, a merge request
  number below 1, a cursor that is not a page number, an empty branch or title)
  are `invalid_argument` before any request is sent.

  **What you must do:** if you caught `GitbeakerRequestError`, catch `GitError`
  and branch on `code`.

- **BREAKING — the base URL and token are validated at construction.** The base
  URL must be an `https` instance URL with no credentials, query, fragment or dot
  segments, and not the `/api/v4` URL. A token must be visible ASCII: an empty
  string (a blank env var) or one containing whitespace or CR/LF throws
  `invalid_argument` without being echoed.

  **What you must do:** if you pass `http://…`, move the instance to https. If
  you pass `…/api/v4`, drop that suffix. If you pass `token: ""` for anonymous
  access, omit `token`.

- `@particle-academy/fancy-git` peer floor raised from `>=0.1` to `>=0.1.2 <2.0`:
  `invalid_argument` is not in 0.1.0/0.1.1's `GitErrorCode`, and both lack
  0.1.2's security fix. **No action needed** unless you pinned fancy-git below
  0.1.2.

### Added

- `tokenType: "oauth" | "ci_job"` for OAuth access tokens (`Authorization: Bearer`)
  and CI/CD job tokens (`JOB-TOKEN`); the default stays `PRIVATE-TOKEN`.
- `fetch` and `timeoutMs` options, for a proxy agent, a private CA or
  instrumentation.

### Security

- **Redirects are never followed.** `fetch` strips `Authorization` on a
  cross-origin redirect but forwards GitLab's `PRIVATE-TOKEN` (verified on Node
  22), so a redirect from the instance — an SSO proxy in front of it, say — sent
  the token to wherever it pointed. A 3xx is now an error.
- **A pagination link is followed only inside the instance's `/api/v4/`**, on
  the same scheme, host and port.
- **A ref from another instance is refused before any request.** A ref whose
  `baseUrl` differs from the provider's would otherwise have sent this instance's
  token to whatever project has the same path here, and `createReview()` would
  have opened a merge request on it. Refs without a `baseUrl` are unaffected.
- **The token stays out of messages, `inspect` and JSON.** It is held in a
  private field, errors are built from GitLab's response, and nothing holding the
  request is attached as a `cause`.

### Removed

- The `@gitbeaker/rest` dependency, and with it `@gitbeaker/core`,
  `@gitbeaker/requester-utils` and their transitive packages. **No action needed.**

## 0.2.0 — 2026-08-07

### Changed

- **BREAKING — Node 20 is no longer supported.** `engines.node` moves from `>=20` to `>=22`.

  **What you must do:** on Node 22 or newer, nothing. Note npm only *warns* on an `engines` mismatch while **pnpm fails the install**, so this surfaces differently depending on your package manager. Node 18 is end-of-life and 20 is maintenance-only.

### Why

These are the kit 0.5 platform floors, applied across every package at once so a consumer never has to resolve a mix. **No API changed, nothing was removed, nothing was renamed** — only what the package requires.


## 0.1.1 — 2026-07-17

- Maintenance only (2 internal commits).

## 0.1.0 — 2026-07-17

### Fixed

- install core package in isolated builds

### Changed

- Add first-publish workflow
- Resolve esbuild security advisory
- Build GitLab provider adapter

### Changed

- Widened the `@particle-academy/fancy-git` requirement from `^0.1.0` to `>=0.1 <2.0`, so a
  sibling minor release is an upgrade and not a resolver conflict. **No action
  needed** — widening a range only adds candidates; the version you have today
  still resolves.

  A caret on a `0.x` range locks the MINOR, so this pinned a sibling at
  whatever it happened to be on the day it was written, and each sibling
  release then read as a conflict to the resolver rather than an upgrade.
  Nothing here was using an API the newer minors removed — the range was the
  whole problem.
