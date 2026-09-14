import { vi } from "vitest";

/**
 * A token of the real `glpat-` shape, so redaction is tested against what it
 * will actually meet. Assembled from two halves because GitHub push protection
 * rightly rejects a commit containing anything shaped like a GitLab token —
 * this one is fake.
 */
export const TOKEN = "glpat" + "-FAKEfakeFAKEfake1234";

export interface SentRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  redirect: RequestRedirect;
}

/**
 * A GitLab that answers from a queue and records every request it was sent.
 *
 * It replaces the global `fetch`, so the adapter is exercised through its
 * public constructor exactly as a consumer builds it — nothing is mocked above
 * the HTTP layer, and nothing leaves the machine. When the queue runs dry it
 * throws, so a test that sends one request more than it expects fails instead
 * of passing quietly.
 */
export class FakeGitLab {
  readonly requests: SentRequest[] = [];
  private readonly queue: (Response | Error)[];

  constructor(responses: (Response | Error)[] = []) {
    this.queue = [...responses];
  }

  static json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  /** Install as the global fetch. Undone by `vi.unstubAllGlobals()`. */
  install(): this {
    vi.stubGlobal("fetch", this.fetch);
    return this;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    this.requests.push({
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: request.body ? await request.clone().text() : "",
      redirect: request.redirect,
    });
    const next = this.queue.shift();
    if (next === undefined) throw new Error(`FakeGitLab: no response queued for request #${this.requests.length - 1} (${request.method} ${request.url})`);
    if (next instanceof Error) throw next;
    return next;
  };

  request(index = 0): SentRequest {
    const request = this.requests[index];
    if (!request) throw new Error(`No request #${index} was sent; ${this.requests.length} recorded.`);
    return request;
  }

  query(index = 0): Record<string, string> {
    return Object.fromEntries(this.request(index).url.searchParams.entries());
  }

  get count(): number {
    return this.requests.length;
  }
}
