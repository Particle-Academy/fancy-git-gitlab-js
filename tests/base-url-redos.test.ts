import { describe, expect, it } from "vitest";
import { GitLabClient } from "../src/index.js";

/**
 * `normalizeBaseUrl` must be LINEAR in the length of the URL it is handed.
 *
 * 0.3.0 stripped the trailing slash with `rawPath.replace(/\/+$/, "")`, which is
 * polynomial: `\/+$` is unanchored at the start, so the engine retries the run
 * of slashes from every position and each attempt scans to the end. Measured on
 * the shipped regex, with the slashes NOT at the end of the string:
 *
 *   20,000 slashes ->   288 ms
 *   60,000 slashes -> 2,194 ms
 *  120,000 slashes -> 9,358 ms
 *
 * Quadratic, and reachable from outside: the strip happens BEFORE the path is
 * validated, so a hostile base URL burns the time on the way in and is only
 * rejected afterwards. A host that takes its instance URL from a database, an
 * env var or a form is handing this library attacker-influenced input.
 * (CodeQL js/polynomial-redos, fancy-git-gitlab-js alert #1, HIGH.)
 *
 * ## Why a clock appears in a test, when a clock is usually the wrong tool
 *
 * A ReDoS fix has no observable output to assert — the function already returned
 * the right answer, it just took nine seconds to do it. The only property that
 * changed is the TIME, so the time is what has to be asserted. The bound below
 * is deliberately ~19x the fixed cost and ~1/19th of the broken one, which is
 * wide enough that a loaded CI box cannot flip it and narrow enough that a
 * reintroduced quadratic cannot pass.
 */

/** Many slashes, with a non-slash after them — the shape that backtracks. */
function hostileUrl(slashes: number): string {
  return `https://gitlab.example.com/x${"/".repeat(slashes)}a`;
}

describe("normalizeBaseUrl, on a path of many slashes", () => {
  it("rejects it in linear time", () => {
    const url = hostileUrl(120_000);

    const started = performance.now();
    // Still rejected: `//` is an empty segment, which this normaliser refuses.
    // The fix changes how long the refusal takes, not the refusal.
    expect(() => GitLabClient.normalizeBaseUrl(url)).toThrow(/relative URL root|valid host name/);
    const elapsed = performance.now() - started;

    expect(elapsed, `took ${elapsed.toFixed(0)}ms — the quadratic strip is back`).toBeLessThan(500);
  });

  it("stays linear as the input grows", () => {
    // Doubling the input must not quadruple the cost. Asserted as a RATIO
    // rather than an absolute, because the absolute is what varies by machine
    // while the growth curve is the actual property.
    const time = (slashes: number): number => {
      const url = hostileUrl(slashes);
      const started = performance.now();
      try {
        GitLabClient.normalizeBaseUrl(url);
      } catch {
        // Expected; the cost is what is being measured.
      }
      return performance.now() - started;
    };

    // Warm the JIT, or the first measurement carries compilation with it.
    time(10_000);

    const small = Math.max(time(40_000), 0.5);
    const large = time(160_000);

    // 4x the input. Linear predicts ~4x, quadratic predicts ~16x.
    expect(large / small, `4x the input cost ${(large / small).toFixed(1)}x the time`).toBeLessThan(8);
  });
});

describe("normalizeBaseUrl trailing-slash handling is unchanged", () => {
  // The fix replaces a regex with a character scan, so every behaviour the
  // regex produced is pinned here first. Without these the suite would be
  // asserting speed and nothing else — and a trim that strips the wrong number
  // of slashes is a WRONG BASE URL, which is worse than a slow one.
  it.each([
    ["https://gitlab.example.com", "https://gitlab.example.com"],
    ["https://gitlab.example.com/", "https://gitlab.example.com"],
    ["https://gitlab.example.com///", "https://gitlab.example.com"],
    ["https://gitlab.example.com/gitlab", "https://gitlab.example.com/gitlab"],
    ["https://gitlab.example.com/gitlab/", "https://gitlab.example.com/gitlab"],
    ["https://gitlab.example.com/gitlab////", "https://gitlab.example.com/gitlab"],
    ["https://gitlab.example.com/a/b/", "https://gitlab.example.com/a/b"],
    ["https://gitlab.example.com:8443/gitlab/", "https://gitlab.example.com:8443/gitlab"],
  ])("%s -> %s", (input, expected) => {
    expect(GitLabClient.normalizeBaseUrl(input)).toBe(expected);
  });

  it("still refuses an empty segment in the middle", () => {
    // Only the TRAILING run is stripped. An interior `//` must stay a rejection
    // — collapsing it would silently change which path a request is sent to.
    expect(() => GitLabClient.normalizeBaseUrl("https://gitlab.example.com/a//b")).toThrow(/relative URL root/);
  });
});
