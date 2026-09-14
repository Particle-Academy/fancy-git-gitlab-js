# Fancy Git — GitLab adapter

[![Fancified](art/fancified.svg)](https://particle.academy)

GitLab.com and GitLab Self-Managed implementation of the Fancy Git provider
contract, over a small first-party GitLab REST v4 client. No runtime
dependencies beyond `@particle-academy/fancy-git`.

```ts
import { GitLabClient, GitLabProvider } from "@particle-academy/fancy-git-gitlab";

// GitLab.com, or a self-managed instance by its https URL.
const gitlab = new GitLabProvider({ token: process.env.GITLAB_TOKEN });
const selfManaged = new GitLabProvider({ token, baseUrl: "https://gitlab.example.com" });

// OAuth or CI job tokens, or your own fetch (proxy agent, private CA, timeouts).
const oauth = new GitLabProvider({ client: new GitLabClient({ baseUrl: "https://gitlab.example.com", token, tokenType: "oauth", fetch: myFetch }) });
```

- The base URL is the **instance** URL (a relative URL root such as
  `https://example.com/gitlab` works); `/api/v4` is added for you. It must be
  `https`, with no credentials, query or fragment.
- The base URL is **trusted configuration**. Private and loopback addresses are
  allowed on purpose, because that is where most self-managed instances live — so
  if end users can supply it, check the host against your own allowlist first.
- Requests only ever go to that instance. Redirects are not followed, and a
  pagination link pointing anywhere else is refused, because every request
  carries the token.
- Failures are `GitError` from `@particle-academy/fancy-git`, with a `code`
  (`auth`, `not_found`, `conflict`, `invalid_argument`, `rate_limited`, …); the
  HTTP status is `exitCode`, and a 429 message says when to retry.
- `createReview({ draft: true })` opens the merge request as a draft by prefixing
  its title with `Draft: `, which is the only way GitLab's API offers.

The PHP twin is [`particle-academy/fancy-git-gitlab`](https://github.com/Particle-Academy/fancy-git-gitlab-php):
the same rules, messages and error codes.
