import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitProvider } from "@particle-academy/fancy-git";
import { GitLabProvider } from "../src/index.js";
import { FakeGitLab, TOKEN } from "./support/fake-gitlab.js";

/**
 * What the adapter sends to GitLab, and what it hands back through the
 * `GitProvider` contract — pinned at the HTTP boundary.
 *
 * Every provider here is built the way a consumer builds one,
 * `new GitLabProvider({ token, baseUrl })`, against a fake global `fetch`. That
 * is what lets the same tests run against the adapter before and after its
 * GitLab client was replaced. Request shapes are GitLab REST v4 as documented,
 * and match the PHP adapter's `ProviderContractTest` case for case.
 */

const REF = { provider: "gitlab" as const, owner: "group/team", name: "app" };

/** Nested groups travel as ONE path segment with the slashes encoded. */
const PROJECT = "/api/v4/projects/group%2Fteam%2Fapp";

function mergeRequest(over: Record<string, unknown> = {}) {
  return {
    id: 9001,
    iid: 7,
    project_id: 42,
    title: "Add the thing",
    description: "Adds it.",
    state: "opened",
    draft: false,
    web_url: "https://gitlab.com/group/team/app/-/merge_requests/7",
    source_branch: "feature",
    target_branch: "main",
    author: { id: 1, username: "ada", name: "Ada" },
    merge_status: "can_be_merged",
    detailed_merge_status: "mergeable",
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-02T11:00:00.000Z",
    ...over,
  };
}

function pipeline(id: number, status: string) {
  return {
    id,
    iid: id - 100,
    project_id: 42,
    sha: "a1b2c3d",
    ref: "feature",
    status,
    source: "push",
    web_url: `https://gitlab.com/group/team/app/-/pipelines/${id}`,
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:05:00.000Z",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitLabProvider — the GitProvider contract over GitLab REST v4", () => {
  it("is a git provider of kind gitlab", () => {
    const provider: GitProvider = new GitLabProvider({ token: TOKEN });
    expect(provider.kind).toBe("gitlab");
  });

  it("reads a repository by its path, encoded exactly once", async () => {
    const gitlab = new FakeGitLab([
      FakeGitLab.json({ id: 42, name: "app", path_with_namespace: "group/team/app", description: null, default_branch: "main", visibility: "internal", web_url: "https://gitlab.com/group/team/app" }),
    ]).install();

    const repository = await new GitLabProvider({ token: TOKEN }).repository(REF);

    expect(gitlab.count).toBe(1);
    const request = gitlab.request();
    expect(request.method).toBe("GET");
    expect(request.url.origin).toBe("https://gitlab.com");
    // Encoded ONCE. `group%252Fteam%252Fapp` is what a second encoding
    // produces, and GitLab answers it with a 404 that reads like a
    // permissions problem. 0.1.0–0.2.0 sent exactly that.
    expect(request.url.pathname).toBe(PROJECT);
    expect(request.headers.get("private-token")).toBe(TOKEN);

    expect(repository).toEqual({
      provider: "gitlab",
      owner: "group/team",
      name: "app",
      id: "42",
      webUrl: "https://gitlab.com/group/team/app",
      defaultBranch: "main",
      private: true,
    });
  });

  it("sends no credential header at all when there is no token", async () => {
    // 0.2.0 sent `PRIVATE-TOKEN: undefined`, which GitLab answers with a 401 —
    // even for a public project that needs no token.
    const gitlab = new FakeGitLab([FakeGitLab.json({ id: 1, web_url: "w", default_branch: "main", visibility: "public" })]).install();

    await new GitLabProvider().repository(REF);

    const headers = gitlab.request().headers;
    expect(headers.has("private-token")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("job-token")).toBe(false);
  });

  it("lists merge requests unfiltered by default, mapping each state", async () => {
    const gitlab = new FakeGitLab([
      FakeGitLab.json(
        [
          mergeRequest(),
          mergeRequest({ id: 9002, iid: 8, draft: true }),
          mergeRequest({ id: 9003, iid: 9, state: "merged" }),
          mergeRequest({ id: 9004, iid: 10, state: "closed", author: null }),
        ],
        200,
        { "x-next-page": "", "x-page": "1", "x-per-page": "30" },
      ),
    ]).install();

    const page = await new GitLabProvider({ token: TOKEN }).listReviews(REF);

    expect(gitlab.request().method).toBe("GET");
    expect(gitlab.request().url.pathname).toBe(`${PROJECT}/merge_requests`);
    // No state means no filter, which GitLab reads as `all`.
    expect(gitlab.query()).toEqual({ per_page: "30" });

    expect(page.items[0]).toEqual({
      id: "9001",
      number: 7,
      title: "Add the thing",
      state: "open",
      webUrl: "https://gitlab.com/group/team/app/-/merge_requests/7",
      sourceBranch: "feature",
      targetBranch: "main",
      author: "ada",
    });
    expect(page.items.map((item) => item.state)).toEqual(["open", "draft", "merged", "closed"]);
    expect(page.items[3]!.author).toBe("unknown");
    // The last page says so with an EMPTY X-Next-Page, and must not be turned
    // into a cursor that loops back to page one.
    expect(page).not.toHaveProperty("nextCursor");
  });

  it("maps state and limit into the query, keeping the limit within what GitLab serves", async () => {
    const gitlab = new FakeGitLab([FakeGitLab.json([]), FakeGitLab.json([]), FakeGitLab.json([]), FakeGitLab.json([]), FakeGitLab.json([]), FakeGitLab.json([])]).install();
    const provider = new GitLabProvider({ token: TOKEN });

    await provider.listReviews(REF, { state: "merged", limit: 5 });
    await provider.listReviews(REF, { state: "closed" });
    await provider.listReviews(REF, { state: "draft" });
    await provider.listReviews(REF, { state: "open" });
    await provider.listReviews(REF, { limit: 500 });
    await provider.listReviews(REF, { limit: 0 });

    expect(gitlab.query(0)).toEqual({ state: "merged", per_page: "5" });
    expect(gitlab.query(1)).toEqual({ state: "closed", per_page: "30" });
    // GitLab has no "draft" state to filter on; drafts are opened MRs.
    expect(gitlab.query(2)).toEqual({ state: "opened", per_page: "30" });
    expect(gitlab.query(3)).toEqual({ state: "opened", per_page: "30" });
    // GitLab silently serves 100 for anything larger, so asking for 500 and
    // then comparing the page length to 500 could never find a next page.
    expect(gitlab.query(4)).toEqual({ per_page: "100" });
    expect(gitlab.query(5)).toEqual({ per_page: "1" });
  });

  it("pages with a cursor and reports the next one from X-Next-Page", async () => {
    const gitlab = new FakeGitLab([
      FakeGitLab.json([mergeRequest()], 200, { "x-page": "2", "x-next-page": "3", "x-total": "61", "x-per-page": "30" }),
    ]).install();

    const page = await new GitLabProvider({ token: TOKEN }).listReviews(REF, { cursor: "2" });

    expect(gitlab.query()).toEqual({ per_page: "30", page: "2" });
    expect(page.nextCursor).toBe("3");
    expect(page.total).toBe(61);
  });

  it("reports a next page even when the page is shorter than the limit", async () => {
    // 0.2.0 guessed from the length of the page. GitLab says outright.
    new FakeGitLab([FakeGitLab.json([mergeRequest()], 200, { "x-next-page": "2" })]).install();

    const page = await new GitLabProvider({ token: TOKEN }).listReviews(REF, { limit: 30 });

    expect(page.nextCursor).toBe("2");
  });

  it("adds the detail fields to a single merge request", async () => {
    const gitlab = new FakeGitLab([
      FakeGitLab.json(mergeRequest({ merge_status: "cannot_be_merged" })),
      FakeGitLab.json(mergeRequest()),
    ]).install();
    const provider = new GitLabProvider({ token: TOKEN });

    const review = await provider.getReview(REF, 7);

    expect(gitlab.request().method).toBe("GET");
    expect(gitlab.request().url.pathname).toBe(`${PROJECT}/merge_requests/7`);
    expect(review.body).toBe("Adds it.");
    expect(review.mergeable).toBe(false);
    expect(review.createdAt).toBe("2026-09-01T10:00:00.000Z");
    expect(review.updatedAt).toBe("2026-09-02T11:00:00.000Z");
    expect(review.number).toBe(7);
    expect((await provider.getReview(REF, 7)).mergeable).toBe(true);
  });

  it("creates a merge request as JSON", async () => {
    const gitlab = new FakeGitLab([
      FakeGitLab.json(mergeRequest(), 201),
      FakeGitLab.json(mergeRequest({ description: null }), 201),
    ]).install();
    const provider = new GitLabProvider({ token: TOKEN });

    const review = await provider.createReview(REF, { title: "Add the thing", body: "Adds it.", sourceBranch: "feature", targetBranch: "main" });
    await provider.createReview(REF, { title: "Add the thing", sourceBranch: "feature", targetBranch: "main" });

    const request = gitlab.request(0);
    expect(request.method).toBe("POST");
    expect(request.url.pathname).toBe(`${PROJECT}/merge_requests`);
    expect(request.headers.get("content-type")).toMatch(/^application\/json/);
    expect(JSON.parse(request.body)).toEqual({ source_branch: "feature", target_branch: "main", title: "Add the thing", description: "Adds it." });
    // No body means no description key at all.
    expect(JSON.parse(gitlab.request(1).body)).toEqual({ source_branch: "feature", target_branch: "main", title: "Add the thing" });
    expect(review.state).toBe("open");
    expect(review.number).toBe(7);
  });

  it("creates a DRAFT merge request the only way GitLab offers: a Draft: title", async () => {
    // GitLab's create-MR endpoint has no `draft` attribute. 0.2.0 sent
    // `draft: true`, GitLab ignored it, and a merge request a caller asked to
    // stage for review was opened ready to merge.
    const gitlab = new FakeGitLab([
      FakeGitLab.json(mergeRequest({ draft: true }), 201),
      FakeGitLab.json(mergeRequest({ draft: true }), 201),
      FakeGitLab.json(mergeRequest(), 201),
    ]).install();
    const provider = new GitLabProvider({ token: TOKEN });

    const review = await provider.createReview(REF, { title: "Add the thing", sourceBranch: "feature", targetBranch: "main", draft: true });
    await provider.createReview(REF, { title: "[Draft] Add the thing", sourceBranch: "feature", targetBranch: "main", draft: true });
    await provider.createReview(REF, { title: "Add the thing", sourceBranch: "feature", targetBranch: "main", draft: false });

    expect(JSON.parse(gitlab.request(0).body)).toEqual({ source_branch: "feature", target_branch: "main", title: "Draft: Add the thing" });
    // Already marked: not marked twice.
    expect(JSON.parse(gitlab.request(1).body).title).toBe("[Draft] Add the thing");
    expect(JSON.parse(gitlab.request(2).body)).toEqual({ source_branch: "feature", target_branch: "main", title: "Add the thing" });
    expect(review.state).toBe("draft");
  });

  it("compares two refs", async () => {
    const gitlab = new FakeGitLab([
      FakeGitLab.json({
        commit: { id: "b2" },
        commits: [
          {
            id: "b2c3d4e5f6",
            short_id: "b2c3d4e5",
            title: "Add the thing",
            message: "Add the thing\n\nLonger.",
            author_name: "Ada",
            author_email: "ada@example.test",
            authored_date: "2026-09-01T09:00:00.000Z",
            parent_ids: ["a1"],
          },
        ],
        diffs: [],
        compare_timeout: false,
        compare_same_ref: false,
      }),
    ]).install();

    const comparison = await new GitLabProvider({ token: TOKEN }).compare(REF, "main", "feature/x");

    expect(gitlab.request().url.pathname).toBe(`${PROJECT}/repository/compare`);
    expect(gitlab.query()).toEqual({ from: "main", to: "feature/x", straight: "false" });
    expect(comparison).toEqual({
      aheadBy: 1,
      behindBy: 0,
      commits: [
        { id: "b2c3d4e5f6", shortId: "b2c3d4e5", parents: ["a1"], authorName: "Ada", authorEmail: "ada@example.test", authoredAt: "2026-09-01T09:00:00.000Z", subject: "Add the thing" },
      ],
    });
  });

  it("reads every page of pipelines for a revision", async () => {
    const gitlab = new FakeGitLab([
      FakeGitLab.json([pipeline(301, "success"), pipeline(302, "running")], 200, { "x-page": "1", "x-next-page": "2" }),
      FakeGitLab.json([pipeline(303, "waiting_for_resource"), pipeline(304, "canceled"), pipeline(305, "manual")], 200, { "x-page": "2", "x-next-page": "" }),
    ]).install();

    const checks = await new GitLabProvider({ token: TOKEN }).checks(REF, "a1b2c3d");

    expect(gitlab.count).toBe(2);
    expect(gitlab.request(0).url.pathname).toBe(`${PROJECT}/pipelines`);
    expect(gitlab.query(0)).toEqual({ sha: "a1b2c3d", per_page: "100" });
    expect(gitlab.query(1)).toEqual({ sha: "a1b2c3d", per_page: "100", page: "2" });

    expect(checks[0]).toEqual({
      id: "301",
      name: "Pipeline #301",
      state: "passed",
      webUrl: "https://gitlab.com/group/team/app/-/pipelines/301",
      startedAt: "2026-09-01T10:00:00.000Z",
      completedAt: "2026-09-01T10:05:00.000Z",
    });
    expect(checks.map((check) => check.state)).toEqual(["passed", "running", "queued", "cancelled", "unknown"]);
  });

  it("addresses a self-managed instance under its own URL, including a relative root", async () => {
    const gitlab = new FakeGitLab([
      FakeGitLab.json({ id: 1, web_url: "https://git.example.test/acme/app", default_branch: "main", visibility: "public" }),
      FakeGitLab.json({ id: 1, web_url: "https://example.test/gitlab/acme/app", default_branch: "main", visibility: "public" }),
    ]).install();

    await new GitLabProvider({ baseUrl: "https://git.example.test:8443/" }).repository({ provider: "gitlab", owner: "acme", name: "app" });
    // GitLab supports installation under a relative URL root.
    await new GitLabProvider({ baseUrl: "https://example.test/gitlab" }).repository({ provider: "gitlab", owner: "acme", name: "app" });

    expect(gitlab.request(0).url.href).toBe("https://git.example.test:8443/api/v4/projects/acme%2Fapp");
    expect(gitlab.request(1).url.href).toBe("https://example.test/gitlab/api/v4/projects/acme%2Fapp");
  });

  it("strips a relative URL root from https remotes only when identifying", () => {
    const provider = new GitLabProvider({ baseUrl: "https://example.test/gitlab" });
    const expected = { provider: "gitlab", owner: "acme/tools", name: "app", baseUrl: "https://example.test/gitlab" };

    expect(provider.identify({ name: "origin", fetchUrl: "https://example.test/gitlab/acme/tools/app.git" })).toEqual(expected);
    expect(provider.identify({ name: "origin", fetchUrl: "git@example.test:acme/tools/app.git" })).toEqual(expected);
    // Same host, outside the root: another application, not this GitLab.
    expect(provider.identify({ name: "origin", fetchUrl: "https://example.test/other/acme/app.git" })).toBeNull();
  });

  it("identifies gitlab.com and self-managed remotes", () => {
    const com = new GitLabProvider();
    const managed = new GitLabProvider({ baseUrl: "https://git.example.test" });

    expect(com.identify({ name: "origin", fetchUrl: "https://gitlab.com/group/team/app.git" })).toEqual({ provider: "gitlab", owner: "group/team", name: "app" });
    expect(managed.identify({ name: "origin", fetchUrl: "git@git.example.test:acme/app.git" })).toEqual({ provider: "gitlab", owner: "acme", name: "app", baseUrl: "https://git.example.test" });
    expect(com.identify({ name: "origin", fetchUrl: "git@github.com:acme/app.git" })).toBeNull();
    expect(managed.identify({ name: "origin", fetchUrl: "git@gitlab.com:acme/app.git" })).toBeNull();
  });
});
