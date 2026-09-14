import { afterEach, describe, expect, it, vi } from "vitest";
import { GitError } from "@particle-academy/fancy-git";
import { GitLabProvider } from "../src/index.js";
import { FakeGitLab, TOKEN } from "./support/fake-gitlab.js";

/**
 * Where a request may go, what it carries, how far a response may steer the
 * next one, and how GitLab's failures reach the caller.
 *
 * Every request carries a credential, so these are the properties that matter
 * most — and the ones 0.2.0 did not have. Built through the public constructor
 * against a fake global `fetch`, like the contract tests.
 */

const REF = { provider: "gitlab" as const, owner: "acme", name: "app" };

// Node's own inspect, as a logger would call it. Loaded through
// process.getBuiltinModule so the suite needs no @types/node.
declare const process: { getBuiltinModule(id: string): any };
const { inspect } = process.getBuiltinModule("node:util") as { inspect(value: unknown, options?: object): string };

afterEach(() => {
  vi.unstubAllGlobals();
});

async function caught(call: () => Promise<unknown>): Promise<GitError> {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    const e = error as GitError;
    expect(e.message).not.toContain(TOKEN);
    // Nothing that carries the request — and so the credential header — is
    // attached where a logger would serialize it.
    expect(inspect(e, { depth: 10, showHidden: true })).not.toContain(TOKEN);
    return e;
  }
  throw new Error("Expected a GitError.");
}

function invalid(call: () => unknown): GitError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe("invalid_argument");
    expect((error as GitError).message).not.toContain(TOKEN);
    return error as GitError;
  }
  throw new Error("Expected an invalid_argument GitError.");
}

describe("requests only go to the configured instance", () => {
  it("never follows a redirect, because fetch would forward PRIVATE-TOKEN to it", async () => {
    // Node's fetch strips `Authorization` on a cross-origin redirect but has
    // no idea GitLab's PRIVATE-TOKEN is a credential, and forwards it. 0.2.0
    // followed redirects, and gave no way to turn that off.
    const gitlab = new FakeGitLab([
      new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } }),
      FakeGitLab.json({ id: 1 }),
    ]).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).repository(REF));

    expect(gitlab.request().redirect).toBe("manual");
    expect(e.code).toBe("unknown");
    expect(e.exitCode).toBe(302);
    expect(e.message).toContain("redirect");
    expect(gitlab.count).toBe(1);
  });

  it("treats a browser's opaque redirect the same way", async () => {
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    Object.defineProperty(opaque, "status", { value: 0 });
    new FakeGitLab([opaque]).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).repository(REF));

    expect(e.message).toContain("redirect");
  });

  it("refuses a ref from another instance before any request", async () => {
    // Otherwise this instance's credentials would be used against whatever
    // project happens to have the same path here — and createReview would open
    // a merge request on it.
    const gitlab = new FakeGitLab([FakeGitLab.json({})]).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).repository({ ...REF, baseUrl: "https://git.example.test" }));

    expect(e.code).toBe("invalid_argument");
    expect(e.message).toContain("https://git.example.test");
    expect(gitlab.count).toBe(0);
  });

  it("accepts a ref naming this instance in another spelling", async () => {
    new FakeGitLab([FakeGitLab.json({ id: 1, web_url: "https://git.example.test/acme/app", default_branch: "main", visibility: "private" })]).install();

    const repository = await new GitLabProvider({ baseUrl: "https://git.example.test" }).repository({ ...REF, baseUrl: "https://GIT.example.test/" });

    expect(repository.id).toBe("1");
  });

  it("refuses malformed provider inputs before any request", async () => {
    const gitlab = new FakeGitLab([FakeGitLab.json({})]).install();
    const provider = new GitLabProvider({ token: TOKEN });

    for (const call of [
      () => provider.repository({ provider: "gitlab", owner: "", name: "app" }),
      () => provider.getReview(REF, 0),
      () => provider.getReview(REF, 1.5),
      () => provider.listReviews(REF, { cursor: "../2" }),
      () => provider.listReviews(REF, { cursor: "0" }),
      () => provider.createReview(REF, { title: "x", sourceBranch: "feature", targetBranch: "" }),
      () => provider.compare(REF, "", "feature"),
      () => provider.checks(REF, " "),
    ]) {
      expect((await caught(call)).code).toBe("invalid_argument");
    }

    expect(gitlab.count).toBe(0);
  });

  it.each([
    ["plain http sends the token in cleartext", "http://gitlab.com"],
    ["other scheme", "ftp://gitlab.com"],
    ["no scheme", "gitlab.com"],
    ["empty", ""],
    ["no host", "https:///gitlab"],
    ["credentials in the URL", "https://user:secret@gitlab.com"],
    ["userinfo disguising the host", "https://gitlab.com@attacker.example"],
    ["backslash host confusion", "https://gitlab.com\\@attacker.example"],
    ["query string", "https://gitlab.com/?private_token=x"],
    ["fragment", "https://gitlab.com/#x"],
    ["dot segment", "https://example.test/gitlab/../admin"],
    ["encoded dot segment", "https://example.test/%2e%2e/admin"],
    ["the API URL instead of the instance URL", "https://gitlab.com/api/v4"],
    ["leading whitespace", " https://gitlab.com"],
    ["embedded newline", "https://gitlab.com\r\nX-Injected: 1"],
    ["space in host", "https://git lab.com"],
    ["port out of range", "https://gitlab.com:70000"],
  ])("refuses an unsafe base URL: %s", (_, baseUrl) => {
    invalid(() => new GitLabProvider({ baseUrl, token: TOKEN }));
  });

  it("normalizes the base URL", () => {
    const base = (baseUrl?: string) => new GitLabProvider({ baseUrl }).identify({ name: "origin", fetchUrl: "git@nowhere.invalid:a/b.git" });
    expect(base()).toBeNull();
    expect(new GitLabProvider({ baseUrl: "https://GitLab.com/" }).identify({ name: "origin", fetchUrl: "git@gitlab.com:a/b.git" })).toEqual({ provider: "gitlab", owner: "a", name: "b" });
    expect(new GitLabProvider({ baseUrl: "https://example.test/tools/gitlab/" }).identify({ name: "origin", fetchUrl: "git@example.test:a/b.git" })).toEqual({ provider: "gitlab", owner: "a", name: "b", baseUrl: "https://example.test/tools/gitlab" });
    expect(new GitLabProvider({ baseUrl: "https://git.example.test:443" }).identify({ name: "origin", fetchUrl: "git@git.example.test:a/b.git" })).toEqual({ provider: "gitlab", owner: "a", name: "b", baseUrl: "https://git.example.test" });
  });

  it.each([
    ["another host", "https://gitlab.com", "https://attacker.example/api/v4/projects/acme%2Fapp/pipelines?page=2"],
    ["a lookalike host", "https://gitlab.com", "https://gitlab.com.attacker.example/api/v4/projects/acme%2Fapp/pipelines?page=2"],
    ["a downgrade to http", "https://gitlab.com", "http://gitlab.com/api/v4/projects/acme%2Fapp/pipelines?page=2"],
    ["another port", "https://gitlab.com", "https://gitlab.com:444/api/v4/projects/acme%2Fapp/pipelines?page=2"],
    ["outside the API", "https://gitlab.com", "https://gitlab.com/users/sign_in?page=2"],
    ["outside the relative root", "https://example.test/gitlab", "https://example.test/api/v4/projects/acme%2Fapp/pipelines?page=2"],
    ["userinfo", "https://gitlab.com", "https://gitlab.com@attacker.example/api/v4/projects/acme%2Fapp/pipelines?page=2"],
    ["a dot segment", "https://gitlab.com", "https://gitlab.com/api/v4/projects/%2e%2e/%2e%2e/users?page=2"],
    ["a relative reference", "https://gitlab.com", "/api/v4/projects/acme%2Fapp/pipelines?page=2"],
  ])("never follows a pagination link to %s", async (_, baseUrl, link) => {
    const gitlab = new FakeGitLab([
      FakeGitLab.json([{ id: 1, status: "success" }], 200, { link: `<${link}>; rel="next"` }),
      FakeGitLab.json([{ id: 2, status: "success" }]),
    ]).install();

    const e = await caught(() => new GitLabProvider({ baseUrl, token: TOKEN }).checks({ ...REF, baseUrl }, "abc"));

    expect(e.code).toBe("unknown");
    expect(e.message).toContain("pagination link");
    expect(gitlab.count).toBe(1);
  });

  it("follows a keyset pagination link that stays inside the instance's API", async () => {
    const next = "https://example.test/gitlab/api/v4/projects/acme%2Fapp/pipelines?id_after=10&pagination=keyset&per_page=100";
    const gitlab = new FakeGitLab([
      FakeGitLab.json([{ id: 9, status: "success" }], 200, { link: `<${next}>; rel="next", <https://example.test/gitlab/api/v4/projects/acme%2Fapp/pipelines>; rel="first"` }),
      FakeGitLab.json([{ id: 11, status: "failed" }]),
    ]).install();

    const checks = await new GitLabProvider({ baseUrl: "https://example.test/gitlab", token: TOKEN }).checks({ ...REF, baseUrl: "https://example.test/gitlab" }, "abc");

    expect(checks.map((check) => check.id)).toEqual(["9", "11"]);
    expect(gitlab.request(1).url.href).toBe(next);
  });

  it("stops a walk that does not end, rather than return a list that reads as complete", async () => {
    const gitlab = new FakeGitLab(Array.from({ length: 11 }, (_, i) => FakeGitLab.json([{ id: i, status: "success" }], 200, { "x-next-page": String(i + 2) }))).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).checks(REF, "abc"));

    expect(e.message).toContain("more than 10 pages");
    expect(gitlab.count).toBe(10);
  });
});

describe("credentials", () => {
  it("uses each token type's own header", async () => {
    const gitlab = new FakeGitLab([FakeGitLab.json({ id: 1 }), FakeGitLab.json({ id: 1 }), FakeGitLab.json({ id: 1 })]).install();

    await new GitLabProvider({ token: TOKEN }).repository(REF).catch(() => undefined);
    await new GitLabProvider({ token: "oauth-abc", tokenType: "oauth" }).repository(REF).catch(() => undefined);
    await new GitLabProvider({ token: "glcbt-job", tokenType: "ci_job" }).repository(REF).catch(() => undefined);

    expect(gitlab.request(0).headers.get("private-token")).toBe(TOKEN);
    expect(gitlab.request(1).headers.get("authorization")).toBe("Bearer oauth-abc");
    expect(gitlab.request(1).headers.has("private-token")).toBe(false);
    expect(gitlab.request(2).headers.get("job-token")).toBe("glcbt-job");
    for (const i of [0, 1, 2]) {
      expect(gitlab.request(i).headers.get("accept")).toBe("application/json");
    }
  });

  it("refuses a blank or malformed token without echoing it", () => {
    // A blank env var would otherwise send anonymous requests, and a private
    // project answers those with a 404 that looks like a typo in its path.
    invalid(() => new GitLabProvider({ token: "" }));
    invalid(() => new GitLabProvider({ token: "   " }));
    invalid(() => new GitLabProvider({ token: `${TOKEN}\r\nX-Injected: 1` }));
  });

  it("keeps the token out of inspect and JSON", () => {
    const provider = new GitLabProvider({ token: TOKEN });

    expect(inspect(provider, { depth: 10, showHidden: true })).not.toContain(TOKEN);
    expect(JSON.stringify(provider)).not.toContain(TOKEN);
  });

  it("refuses a client from the library 0.2.0 wrapped, instead of failing on first use", () => {
    const e = invalid(() => new GitLabProvider({ client: { Projects: {}, MergeRequests: {} } as never }));
    expect(e.message).toContain("GitLabClient");
  });
});

describe("GitLab's failures, as the contract's GitError", () => {
  it.each([
    [400, { message: "400 Bad request - state is invalid" }, "invalid_argument", "state is invalid"],
    [401, { message: "401 Unauthorized" }, "auth", "401 Unauthorized"],
    [401, { error: "invalid_token", error_description: "Token is expired. You can either do re-authorization or token refresh." }, "auth", "expired"],
    [403, { error: "insufficient_scope" }, "auth", "insufficient_scope"],
    [404, { message: "404 Project Not Found" }, "not_found", "404 Project Not Found"],
    [405, { message: "405 Method Not Allowed" }, "unsupported", "Method Not Allowed"],
    [409, { message: ["Another open merge request already exists for this source branch: !7"] }, "conflict", "Another open merge request already exists"],
    [422, { message: { title: ["can't be blank"], target_branch: ["is invalid"] } }, "invalid_argument", '"title" can\'t be blank, "target_branch" is invalid'],
    [500, { message: "500 Internal Server Error" }, "unknown", "500 Internal Server Error"],
  ])("maps %i to its contract code", async (status, body, code, needle) => {
    const gitlab = new FakeGitLab([FakeGitLab.json(body, status)]).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).repository(REF));

    expect(e.code).toBe(code);
    expect(e.exitCode).toBe(status);
    expect(e.message).toContain(needle);
    expect(gitlab.count).toBe(1);
  });

  it("maps a 502 that is not JSON", async () => {
    new FakeGitLab([new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } })]).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).repository(REF));

    expect(e.code).toBe("unknown");
    expect(e.exitCode).toBe(502);
  });

  it("reports a rate limit ONCE, with GitLab's Retry-After, instead of retrying into it", async () => {
    // 0.2.0 (through its client library) re-sent a 429 ten times within a few
    // hundred milliseconds, ignored Retry-After, and then threw an error that
    // carried neither.
    const gitlab = new FakeGitLab([
      FakeGitLab.json({ message: "429 Too Many Requests" }, 429, { "retry-after": "37" }),
      ...Array.from({ length: 12 }, () => FakeGitLab.json({ message: "429 Too Many Requests" }, 429, { "retry-after": "37" })),
    ]).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).getReview(REF, 1));

    expect(gitlab.count).toBe(1);
    expect(e.code).toBe("rate_limited");
    expect(e.exitCode).toBe(429);
    expect(e.message).toContain("Retry after 37 seconds");
  });

  it("reads an HTTP-date Retry-After", async () => {
    const when = new Date(Date.now() + 120_000).toUTCString();
    new FakeGitLab([new Response("Retry later", { status: 429, headers: { "retry-after": when } })]).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).repository(REF));

    expect(e.code).toBe("rate_limited");
    expect(e.message).toMatch(/Retry after 1[12]\d seconds/);
  });

  it("reports a transport failure without the token", async () => {
    const failure = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND gitlab.com") });
    new FakeGitLab([failure]).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).repository(REF));

    expect(e.code).toBe("unknown");
    expect(e.message).toContain("ENOTFOUND");
  });

  it("reports a success that is not JSON rather than mapping it", async () => {
    // What a base URL pointing at an SSO login page looks like from here.
    new FakeGitLab([new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } })]).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).repository(REF));

    expect(e.code).toBe("unknown");
    expect(e.message).toContain("not JSON");
  });

  it("redacts an error body that echoes the token", async () => {
    new FakeGitLab([FakeGitLab.json({ message: `token ${TOKEN} is expired` }, 401)]).install();

    expect((await caught(() => new GitLabProvider({ token: TOKEN }).repository(REF))).code).toBe("auth");
  });
});
