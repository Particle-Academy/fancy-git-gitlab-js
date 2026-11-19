import { afterEach, describe, expect, it, vi } from "vitest";
import { GitError } from "@particle-academy/fancy-git";
import { GitLabClient, GitLabProvider } from "../src/index.js";
import { FakeGitLab, TOKEN } from "./support/fake-gitlab.js";

/**
 * A transient 5xx on a GET is retried, a bounded number of times; a POST is
 * never replayed, because GitLab may already hold what the first one created.
 * Found by the fancy-labs git-adapter test (`get-503-once`, `post-502`); the
 * PHP twin holds the same rule.
 */

const REF = { provider: "gitlab" as const, owner: "acme", name: "app" };
const PROJECT = { id: 42, name: "app", description: null, default_branch: "main", visibility: "private", web_url: "https://gitlab.com/acme/app" };

afterEach(() => {
  vi.unstubAllGlobals();
});

async function caught(call: () => Promise<unknown>): Promise<GitError> {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    return error as GitError;
  }
  throw new Error("Expected a GitError.");
}

describe("GET retry on a transient 5xx", () => {
  it.each([500, 502, 503, 504])("retries a GET that answered %i, and returns the retry's answer", async (status) => {
    const gitlab = new FakeGitLab([FakeGitLab.json({ message: `${status}` }, status), FakeGitLab.json(PROJECT)]).install();

    const repository = await new GitLabProvider({ token: TOKEN }).repository(REF);

    expect(repository.id).toBe("42");
    expect(gitlab.count).toBe(2);
    expect(gitlab.request(1).method).toBe("GET");
  });

  it("gives up after a bounded number of retries, with the last 5xx", async () => {
    const gitlab = new FakeGitLab(Array.from({ length: 10 }, () => FakeGitLab.json({ message: "503 Service Unavailable" }, 503))).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).repository(REF));

    expect(gitlab.count).toBe(1 + GitLabClient.GET_RETRIES);
    expect(e.code).toBe("unknown");
    expect(e.exitCode).toBe(503);
  });

  it("retries each page of a walk on its own", async () => {
    const gitlab = new FakeGitLab([
      FakeGitLab.json([{ id: 1 }], 200, { "x-next-page": "2" }),
      FakeGitLab.json({ message: "502 Bad Gateway" }, 502),
      FakeGitLab.json([{ id: 2 }]),
    ]).install();

    const items = await new GitLabClient({ token: TOKEN }).getAll("projects/acme%2Fapp/pipelines");

    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(gitlab.count).toBe(3);
  });

  it("never replays a POST that answered 5xx", async () => {
    const gitlab = new FakeGitLab([FakeGitLab.json({ message: "502 Bad Gateway" }, 502), FakeGitLab.json({ iid: 7 }, 201)]).install();

    const e = await caught(() => new GitLabProvider({ token: TOKEN }).createReview(REF, { title: "T", sourceBranch: "f", targetBranch: "main" }));

    expect(gitlab.count).toBe(1);
    expect(e.code).toBe("unknown");
    expect(e.exitCode).toBe(502);
  });

  it.each([400, 401, 404, 429])("does not retry a %i", async (status) => {
    const gitlab = new FakeGitLab([FakeGitLab.json({ message: `${status}` }, status), FakeGitLab.json(PROJECT)]).install();

    await caught(() => new GitLabProvider({ token: TOKEN }).repository(REF));

    expect(gitlab.count).toBe(1);
  });
});
