import { afterEach, describe, expect, it, vi } from "vitest";
import { GitError } from "@particle-academy/fancy-git";
import { GitLabClient } from "../src/index.js";
import { FakeGitLab, TOKEN } from "./support/fake-gitlab.js";

/**
 * The keyset-pagination `Link` header must be parsed in LINEAR time.
 *
 * 0.3.0 and 0.3.1 matched it with `/<([^>]*)>((?:\s*;\s*[^;,]+)*)/g`. On a
 * header of 100,000 `<` and no `>`, every `<` starts a match attempt that scans
 * to the end of the string before failing: quadratic, measured at 5.5 s. The
 * header comes from whatever server `baseUrl` points at, so it is untrusted
 * input, and it is read on every page of every paginated call.
 *
 * The fix parses with indexOf / slice, and refuses a header over 8 KB with an
 * error rather than parsing it. Refusing rather than ignoring is deliberate:
 * ignoring an oversized header would end the walk early and hand back a list
 * that reads as complete, which `getAll` exists to never do.
 *
 * A clock is the only thing to assert here: the old code returned the right
 * answer, it just took seconds to do it.
 */

const BASE = "https://example.test/gitlab";
const API = `${BASE}/api/v4/projects/1/pipelines`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): GitLabClient {
  return new GitLabClient({ baseUrl: BASE, token: TOKEN });
}

async function settle(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    return error;
  }
}

describe("Link header parsing is linear", () => {
  it("refuses a 100k-character hostile header in under 50 ms, with an error rather than a short list", async () => {
    new FakeGitLab([FakeGitLab.json([{ id: 1 }], 200, { link: "<".repeat(100_000) })]).install();

    const started = performance.now();
    const outcome = await settle(() => client().getAll("projects/1/pipelines"));
    const elapsed = performance.now() - started;

    expect(outcome).toBeInstanceOf(GitError);
    expect((outcome as GitError).message).toContain("Link header");
    expect(elapsed, `took ${elapsed.toFixed(0)}ms; the quadratic Link parser is back`).toBeLessThan(50);
  });

  it("parses a hostile header just under the 8 KB cap in under 50 ms", async () => {
    // Under the cap the parser itself runs, so this is the test of the parser
    // rather than of the cap.
    new FakeGitLab([FakeGitLab.json([{ id: 1 }], 200, { link: "<".repeat(8 * 1024) })]).install();

    const started = performance.now();
    const items = await client().getAll("projects/1/pipelines");
    const elapsed = performance.now() - started;

    expect(items).toEqual([{ id: 1 }]);
    expect(elapsed, `took ${elapsed.toFixed(0)}ms`).toBeLessThan(50);
  });

  it("parses a hostile header of repeated parameters in under 50 ms", async () => {
    new FakeGitLab([FakeGitLab.json([{ id: 1 }], 200, { link: `<${API}>` + "; a".repeat(2_000) + "!" })]).install();

    const started = performance.now();
    const items = await client().getAll("projects/1/pipelines");
    const elapsed = performance.now() - started;

    expect(items).toEqual([{ id: 1 }]);
    expect(elapsed, `took ${elapsed.toFixed(0)}ms`).toBeLessThan(50);
  });
});

describe("a hostile next link, once parsed, is judged in linear time", () => {
  it("refuses a target just under the cap that backtracks the URL split, in under 50 ms", async () => {
    // `#ownLink` splits the target with `([^/?#]*)([^?#]*)`; a long slash-free
    // authority ending in `#` is the shape that would make it backtrack. The
    // cap bounds it; this pins that the bound is enough.
    const target = `https://${"a".repeat(8 * 1024 - 40)}#`;
    new FakeGitLab([FakeGitLab.json([{ id: 1 }], 200, { link: `<${target}>; rel="next"` })]).install();

    const started = performance.now();
    const outcome = await settle(() => client().getAll("projects/1/pipelines"));
    const elapsed = performance.now() - started;

    expect(outcome).toBeInstanceOf(GitError);
    expect((outcome as GitError).message).toContain("pagination link");
    expect(elapsed, `took ${elapsed.toFixed(0)}ms`).toBeLessThan(50);
  });
});

describe("Link header parsing is unchanged", () => {
  // The fix replaces a regex with a scan, so what the regex accepted is pinned
  // here. A parser that misses `next` ends pagination early, which is a wrong
  // answer rather than a slow one.
  const next = `${API}?id_after=10&pagination=keyset`;

  it.each([
    ["quoted rel", `<${next}>; rel="next"`],
    ["unquoted rel", `<${next}>; rel=next`],
    ["upper-case REL and NEXT", `<${next}>; REL="NEXT"`],
    ["spacing around the separators", `<${next}>  ;  rel = "next"`],
    ["next among several rels", `<${next}>; rel="next last"`],
    ["next after another link", `<${API}>; rel="first", <${next}>; rel="next"`],
    ["next before another link", `<${next}>; rel="next", <${API}>; rel="last"`],
    ["another parameter first", `<${next}>; type="application/json"; rel="next"`],
    ["a comma inside the target", `<${next}&x=a,b>; rel="next"`],
  ])("follows %s", async (_, link) => {
    const gitlab = new FakeGitLab([FakeGitLab.json([{ id: 1 }], 200, { link }), FakeGitLab.json([{ id: 2 }])]).install();

    expect(await client().getAll("projects/1/pipelines")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(gitlab.request(1).url.href).toBe(link.includes("a,b") ? `${next}&x=a,b` : next);
  });

  it.each([
    ["only prev and first", `<${API}>; rel="prev", <${API}>; rel="first"`],
    ["no rel at all", `<${next}>`],
    ["a rel that merely contains next", `<${next}>; rel="nextish"`],
    ["an unclosed target", `<${next}; rel="next"`],
  ])("stops on %s", async (_, link) => {
    const gitlab = new FakeGitLab([FakeGitLab.json([{ id: 1 }], 200, { link })]).install();

    expect(await client().getAll("projects/1/pipelines")).toEqual([{ id: 1 }]);
    expect(gitlab.count).toBe(1);
  });
});
