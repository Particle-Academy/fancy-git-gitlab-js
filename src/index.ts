import { Gitlab } from "@gitbeaker/rest";
import type { CheckSummary, Comparison, CreateReviewInput, GitProvider, GitRemote, HostedRepository, Page, ProviderRepositoryRef, Review, ReviewDetails, ReviewQuery } from "@particle-academy/fancy-git";

export interface GitLabProviderOptions {
  token?: string;
  baseUrl?: string;
  client?: any;
}

function parseRemote(url: string) {
  const match = url.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/](.+?)\/([^/]+?)(?:\.git)?$/);
  return match ? { host: match[1]!, owner: match[2]!, name: match[3]! } : null;
}

export class GitLabProvider implements GitProvider {
  readonly kind = "gitlab" as const;
  private readonly baseUrl: string;
  private readonly client: any;

  constructor(options: GitLabProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://gitlab.com").replace(/\/$/, "");
    this.client = options.client ?? new Gitlab({ host: this.baseUrl, token: options.token });
  }

  identify(remote: GitRemote): ProviderRepositoryRef | null {
    const parsed = parseRemote(remote.fetchUrl);
    if (!parsed || parsed.host !== new URL(this.baseUrl).hostname) return null;
    return { provider: this.kind, owner: parsed.owner, name: parsed.name, ...(this.baseUrl === "https://gitlab.com" ? {} : { baseUrl: this.baseUrl }) };
  }

  private project(ref: ProviderRepositoryRef): string {
    return encodeURIComponent(`${ref.owner}/${ref.name}`);
  }

  async repository(ref: ProviderRepositoryRef): Promise<HostedRepository> {
    const data = await this.client.Projects.show(this.project(ref));
    return { provider: this.kind, owner: ref.owner, name: ref.name, id: String(data.id), webUrl: data.web_url, defaultBranch: data.default_branch, private: data.visibility !== "public", description: data.description ?? undefined, ...(ref.baseUrl ? { baseUrl: ref.baseUrl } : {}) };
  }

  async listReviews(ref: ProviderRepositoryRef, query: ReviewQuery = {}): Promise<Page<Review>> {
    const page = Number(query.cursor ?? "1");
    const data = await this.client.MergeRequests.all({ projectId: this.project(ref), state: query.state === "merged" ? "merged" : query.state === "closed" ? "closed" : query.state ? "opened" : undefined, page, perPage: query.limit ?? 30 });
    return { items: data.map((item: any) => this.mapReview(item)), ...(data.length === (query.limit ?? 30) ? { nextCursor: String(page + 1) } : {}) };
  }

  async getReview(ref: ProviderRepositoryRef, number: number): Promise<ReviewDetails> {
    const data = await this.client.MergeRequests.show(this.project(ref), number);
    return { ...this.mapReview(data), body: data.description ?? undefined, mergeable: data.merge_status === "can_be_merged", createdAt: data.created_at, updatedAt: data.updated_at };
  }

  async createReview(ref: ProviderRepositoryRef, input: CreateReviewInput): Promise<Review> {
    const data = await this.client.MergeRequests.create(this.project(ref), input.sourceBranch, input.targetBranch, input.title, { description: input.body, draft: input.draft });
    return this.mapReview(data);
  }

  async compare(ref: ProviderRepositoryRef, base: string, head: string): Promise<Comparison> {
    const data = await this.client.Repositories.compare(this.project(ref), base, head);
    return { aheadBy: data.commits?.length ?? 0, behindBy: 0, commits: (data.commits ?? []).map((commit: any) => ({ id: commit.id, shortId: commit.short_id, parents: commit.parent_ids ?? [], authorName: commit.author_name, authorEmail: commit.author_email, authoredAt: commit.authored_date, subject: commit.title })) };
  }

  async checks(ref: ProviderRepositoryRef, revision: string): Promise<CheckSummary[]> {
    const pipelines = await this.client.Pipelines.all(this.project(ref), { sha: revision });
    return pipelines.map((pipeline: any) => ({ id: String(pipeline.id), name: `Pipeline #${pipeline.id}`, state: this.checkState(pipeline.status), webUrl: pipeline.web_url, startedAt: pipeline.created_at, completedAt: pipeline.updated_at }));
  }

  private mapReview(item: any): Review {
    return { id: String(item.id), number: item.iid, title: item.title, state: item.state === "merged" ? "merged" : item.state === "opened" ? (item.draft ? "draft" : "open") : "closed", webUrl: item.web_url, sourceBranch: item.source_branch, targetBranch: item.target_branch, author: item.author?.username ?? "unknown" };
  }

  private checkState(status: string) {
    if (["created", "pending", "waiting_for_resource", "preparing"].includes(status)) return "queued" as const;
    if (status === "running") return "running" as const;
    if (status === "success") return "passed" as const;
    if (status === "canceled") return "cancelled" as const;
    if (status === "skipped") return "skipped" as const;
    return status === "failed" ? "failed" as const : "unknown" as const;
  }
}
