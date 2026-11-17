# Using @particle-academy/fancy-git-gitlab — guide for agents

How an agent installs and uses this package in a consumer app. What the package
is, is in [README.md](./README.md). Notes for working ON this repo's code are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Install

```bash
npm install @particle-academy/fancy-git @particle-academy/fancy-git-gitlab
```

- `@particle-academy/fancy-git` is a **peer** (`>=0.1.2 <2.0`); install it too.
- **Node:** `>=22`. No other runtime dependencies.

## Find it on the Fancy MCP server

The catalog server is `https://ui.particle.academy/mcp` (streamable HTTP, no API
key; MCP id `fancy-ui`). This package is the registry entry
`fancy-git-gitlab-js`. Server-side packages are found with
`search-backend-packages` (stack `node`); `install-instructions` gives the exact
commands for the slug.

## API essentials

```ts
import { ProviderRegistry } from "@particle-academy/fancy-git";
import { GitLabProvider } from "@particle-academy/fancy-git-gitlab";

const gitlab = new GitLabProvider({ token: process.env.GITLAB_TOKEN });
const providers = new ProviderRegistry().register(gitlab);
```

- `GitLabProviderOptions`: `baseUrl` (the instance URL), `token`, `tokenType`
  (`"access_token" | "oauth" | "ci_job"`), `fetch`, `timeoutMs` (per request,
  default 30000), or `client` (a `GitLabClient` you built; the other options are
  then ignored).
- `GitLabProvider` implements fancy-git's `GitProvider` (`kind` is `"gitlab"`):
  `identify`, `repository`, `listReviews`, `getReview`, `createReview`,
  `compare`, `checks`. It does not implement `IssueProvider`.
- Failures are fancy-git's `GitError` with a `code` (`auth`, `not_found`,
  `conflict`, `invalid_argument`, `rate_limited`, ...); the HTTP status is
  `exitCode`.

## Traps

- **`baseUrl` is the instance URL, not the `/api/v4` URL.** It must be `https`,
  with no credentials, query or fragment.
- **`baseUrl` is trusted configuration.** Private and loopback addresses are
  allowed. If end users can supply it, check the host against your own allowlist
  first.
- **`client` must be a `GitLabClient` from this package.** Since 0.3.0 the
  adapter no longer uses `@gitbeaker/rest`; passing anything else throws
  `invalid_argument`.
- Without a token, requests are anonymous and GitLab answers for public projects
  only.
- `createReview({ draft: true })` marks the merge request as a draft by
  prefixing its title with `Draft: `.
