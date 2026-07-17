import { describe, expect, it } from "vitest";
import { GitLabProvider } from "../src/index.js";

describe("GitLabProvider", () => {
  it("identifies nested GitLab namespaces", () => {
    expect(new GitLabProvider().identify({ name: "origin", fetchUrl: "git@gitlab.com:group/team/app.git" })).toEqual({ provider: "gitlab", owner: "group/team", name: "app" });
  });
  it("supports self-managed hosts", () => {
    expect(new GitLabProvider({ baseUrl: "https://git.example.test" }).identify({ name: "origin", fetchUrl: "https://git.example.test/acme/app.git" })).toMatchObject({ provider: "gitlab", baseUrl: "https://git.example.test" });
  });
});
