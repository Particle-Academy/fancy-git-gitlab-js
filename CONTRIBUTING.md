# Contributing to @particle-academy/fancy-git-gitlab

Notes for anyone, human or agent, working ON this package's code. How to USE the
package is in [AGENTS.md](./AGENTS.md); what it is, is in [README.md](./README.md).
`CLAUDE.md` is a symlink to this file, so Claude Code reads these notes when it
works in this repo.

## Layout

- `src/client.ts` — `GitLabClient`, the small first-party GitLab REST v4 client.
- `src/index.ts` — `GitLabProvider`, the fancy-git provider over that client.
- `tests/` — the vitest suite (`provider.test.ts`, `provider-contract.test.ts`,
  `security-and-errors.test.ts`, `base-url-redos.test.ts`,
  `link-header-redos.test.ts`, helpers in
  `support/`).

## Commands

```bash
npm run build   # tsup
npm run lint    # tsc --noEmit
npm test        # vitest run
```

`prepublishOnly` runs lint, test and build in that order.

## Parity

The PHP twin, [`particle-academy/fancy-git-gitlab`](https://github.com/Particle-Academy/fancy-git-gitlab-php),
promises the same rules, messages and error codes (see the README). A change to
either is a change to both.

## Changelog

Update `CHANGELOG.md` (Keep a Changelog) in the same commit as the change.
