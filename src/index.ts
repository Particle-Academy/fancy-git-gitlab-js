import { GitError } from "@particle-academy/fancy-git";
import type { CheckState, CheckSummary, Comparison, CreateReviewInput, GitProvider, GitRemote, HostedRepository, Page, ProviderRepositoryRef, Review, ReviewDetails, ReviewQuery } from "@particle-academy/fancy-git";
import { GitLabClient } from "./client.js";
import type { GitLabClientOptions } from "./client.js";

export { GitLabClient } from "./client.js";
export type { GitLabClientOptions, GitLabQuery, GitLabResponse, GitLabTokenType } from "./client.js";

export interface GitLabProviderOptions extends GitLabClientOptions {
  /** A client you built yourself. When given, the other options are ignored. */
  client?: GitLabClient;
}

function invalid(message: string): GitError {
  return new GitError("invalid_argument", message);
}

/** GitLab marks a merge request as a draft by its title, and only by its title. */
const DRAFT_TITLE = /^\s*(?:\[draft\]|\(draft\)|draft:)/i;

export class GitLabProvider implements GitProvider {
  readonly kind = "gitlab" as const;
  readonly #client: GitLabClient;

  constructor(options: GitLabProviderOptions = {}) {
    if (options.client !== undefined && !(options.client instanceof GitLabClient)) {
      throw invalid("options.client must be a GitLabClient from @particle-academy/fancy-git-gitlab. Since 0.3.0 this adapter no longer uses @gitbeaker/rest; pass { token, baseUrl } instead, or new GitLabClient({ token, baseUrl }).");
    }
    this.#client = options.client ?? new GitLabClient(options);
  }

  identify(remote: GitRemote): ProviderRepositoryRef | null {
    const baseUrl = this.#client.baseUrl;
    const base = /^https:\/\/([^/:]+|\[[^\]]+\])(?::\d+)?(\/.*)?$/.exec(baseUrl)!;
    const match = /^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/](.+?)\/([^/]+?)(?:\.git)?$/.exec(remote.fetchUrl);
    if (!match || match[1] !== base[1]) return null;

    let owner = match[2]!;

    // Under a relative URL root (https://example.com/gitlab) an https remote
    // carries the root in its path and an ssh remote does not. The root is part
    // of the instance, not of the namespace.
    const root = (base[2] ?? "").replace(/^\/+/, "");
    if (root !== "" && /^https?:\/\//i.test(remote.fetchUrl)) {
      if (!owner.startsWith(`${root}/`)) return null;
      owner = owner.slice(root.length + 1);
    }

    return { provider: this.kind, owner, name: match[3]!, ...(baseUrl === GitLabClient.GITLAB_COM ? {} : { baseUrl }) };
  }

  async repository(ref: ProviderRepositoryRef): Promise<HostedRepository> {
    const data = (await this.#client.get(this.#project(ref))).data as Record<string, any>;
    return { provider: this.kind, owner: ref.owner, name: ref.name, id: String(data.id), webUrl: data.web_url, defaultBranch: data.default_branch, private: data.visibility !== "public", ...(data.description != null ? { description: data.description } : {}), ...(ref.baseUrl ? { baseUrl: ref.baseUrl } : {}) };
  }

  async listReviews(ref: ProviderRepositoryRef, query: ReviewQuery = {}): Promise<Page<Review>> {
    const path = `${this.#project(ref)}/merge_requests`;
    // GitLab has no "draft" state to filter on; drafts are opened MRs. No state
    // means no filter, which GitLab reads as `all`.
    const state = query.state === "merged" ? "merged" : query.state === "closed" ? "closed" : query.state ? "opened" : undefined;
    const limit = Math.max(1, Math.min(GitLabClient.MAX_PER_PAGE, Math.trunc(Number(query.limit ?? 30)) || 1));
    const page = query.cursor === undefined ? undefined : GitLabProvider.#cursor(query.cursor);

    const response = await this.#client.get(path, { state, per_page: limit, page });

    return {
      items: GitLabClient.items(response.data, `GET ${path}`, response.status).map((item) => this.#mapReview(item)),
      ...(response.nextPage ? { nextCursor: response.nextPage } : {}),
      ...(response.total !== undefined ? { total: response.total } : {}),
    };
  }

  async getReview(ref: ProviderRepositoryRef, number: number): Promise<ReviewDetails> {
    if (!Number.isInteger(number) || number < 1) throw invalid(`A merge request number is a positive integer; got ${number}.`);

    const data = (await this.#client.get(`${this.#project(ref)}/merge_requests/${number}`)).data as Record<string, any>;
    return { ...this.#mapReview(data), ...(data.description != null ? { body: data.description } : {}), mergeable: data.merge_status === "can_be_merged", createdAt: data.created_at, updatedAt: data.updated_at };
  }

  async createReview(ref: ProviderRepositoryRef, input: CreateReviewInput): Promise<Review> {
    const sourceBranch = GitLabProvider.#required(input, "sourceBranch");
    const targetBranch = GitLabProvider.#required(input, "targetBranch");
    let title = GitLabProvider.#required(input, "title");

    // The create endpoint has no `draft` attribute: GitLab decides draft status
    // from the title alone. Sending `draft: true` is silently ignored, and the
    // merge request opens ready to merge.
    if (input.draft === true && !DRAFT_TITLE.test(title)) title = `Draft: ${title}`;

    const body: Record<string, unknown> = { source_branch: sourceBranch, target_branch: targetBranch, title };
    if (input.body !== undefined && input.body !== null) body.description = String(input.body);

    return this.#mapReview((await this.#client.post(`${this.#project(ref)}/merge_requests`, body)).data as Record<string, any>);
  }

  async compare(ref: ProviderRepositoryRef, base: string, head: string): Promise<Comparison> {
    if (typeof base !== "string" || typeof head !== "string" || base.trim() === "" || head.trim() === "") {
      throw invalid("compare needs a non-empty base and head.");
    }

    const data = (await this.#client.get(`${this.#project(ref)}/repository/compare`, { from: base, to: head, straight: "false" })).data as Record<string, any>;
    const commits: any[] = Array.isArray(data?.commits) ? data.commits : [];
    return {
      aheadBy: commits.length,
      behindBy: 0,
      commits: commits.map((commit) => ({ id: commit.id, shortId: commit.short_id, parents: commit.parent_ids ?? [], authorName: commit.author_name, authorEmail: commit.author_email, authoredAt: commit.authored_date, subject: commit.title })),
    };
  }

  async checks(ref: ProviderRepositoryRef, revision: string): Promise<CheckSummary[]> {
    if (typeof revision !== "string" || revision.trim() === "") throw invalid("checks needs a non-empty revision.");

    const pipelines = (await this.#client.getAll(`${this.#project(ref)}/pipelines`, { sha: revision })) as Record<string, any>[];
    return pipelines.map((pipeline) => ({
      id: String(pipeline.id),
      name: `Pipeline #${pipeline.id}`,
      state: GitLabProvider.#checkState(pipeline.status),
      ...(pipeline.web_url != null ? { webUrl: pipeline.web_url } : {}),
      ...(pipeline.created_at != null ? { startedAt: pipeline.created_at } : {}),
      ...(pipeline.updated_at != null ? { completedAt: pipeline.updated_at } : {}),
    }));
  }

  toJSON(): Record<string, unknown> {
    return { kind: this.kind, client: this.#client.toJSON() };
  }

  /**
   * The project path for a ref — refusing a ref that belongs to another instance.
   *
   * Without that check, a ref identified against gitlab.example.com and handed
   * to the gitlab.com provider would send THIS instance's credentials to
   * whatever project has the same path here, and createReview would open a
   * merge request on it.
   */
  #project(ref: ProviderRepositoryRef): string {
    if (ref.baseUrl !== undefined && ref.baseUrl !== "") {
      const theirs = GitLabClient.normalizeBaseUrl(String(ref.baseUrl));
      if (theirs !== this.#client.baseUrl) {
        throw invalid(`This ref belongs to ${theirs}, but this GitLabProvider talks to ${this.#client.baseUrl}. Use a provider configured for that instance.`);
      }
    }
    return GitLabClient.projectPath(ref.owner, ref.name);
  }

  static #cursor(cursor: unknown): string {
    if ((typeof cursor !== "string" && typeof cursor !== "number") || !/^[1-9][0-9]{0,9}$/.test(String(cursor))) {
      throw invalid("A GitLab review cursor is the page number returned as nextCursor.");
    }
    return String(cursor);
  }

  static #required(input: CreateReviewInput, key: "sourceBranch" | "targetBranch" | "title"): string {
    const value = input?.[key];
    if (typeof value !== "string" || value.trim() === "") throw invalid(`createReview needs a non-empty ${key}.`);
    return value;
  }

  #mapReview(item: Record<string, any>): Review {
    return { id: String(item.id), number: item.iid, title: item.title, state: item.state === "merged" ? "merged" : item.state === "opened" ? (item.draft ? "draft" : "open") : "closed", webUrl: item.web_url, sourceBranch: item.source_branch, targetBranch: item.target_branch, author: item.author?.username ?? "unknown" };
  }

  static #checkState(status: string): CheckState {
    if (["created", "pending", "waiting_for_resource", "preparing"].includes(status)) return "queued";
    if (status === "running") return "running";
    if (status === "success") return "passed";
    if (status === "canceled") return "cancelled";
    if (status === "skipped") return "skipped";
    return status === "failed" ? "failed" : "unknown";
  }
}
