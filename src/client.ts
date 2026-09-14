import { GitError } from "@particle-academy/fancy-git";
import type { GitErrorCode } from "@particle-academy/fancy-git";

/**
 * How a GitLab credential is presented. Each kind has its own header, and
 * GitLab rejects a token sent under the wrong one.
 *
 * - `access_token` — personal, project and group access tokens (`glpat-…`), sent as `PRIVATE-TOKEN`
 * - `oauth` — an OAuth 2.0 access token, sent as `Authorization: Bearer`
 * - `ci_job` — a CI/CD job token (`CI_JOB_TOKEN`), sent as `JOB-TOKEN`. GitLab
 *   accepts it on a small subset of endpoints only, so most provider calls will
 *   answer 401 or 403 — GitLab's policy, not a fault here.
 */
export type GitLabTokenType = "access_token" | "oauth" | "ci_job";

export interface GitLabClientOptions {
  /** The INSTANCE URL (`https://gitlab.example.com`, or `https://example.com/gitlab` under a relative URL root) — not the `/api/v4` URL. */
  baseUrl?: string;
  /** Omit for anonymous requests, which GitLab answers for public projects only. */
  token?: string;
  tokenType?: GitLabTokenType;
  /** Bring your own fetch (a proxy agent, a private CA, instrumentation). It is always called with `redirect: "manual"`. */
  fetch?: typeof fetch;
  /** Per request. Default 30 000. */
  timeoutMs?: number;
}

export type GitLabQuery = Record<string, string | number | boolean | null | undefined>;

/** One decoded GitLab REST response. Pagination is a page NUMBER, never a URL. */
export interface GitLabResponse {
  status: number;
  data: unknown;
  /** `X-Next-Page`, or undefined on the last page. */
  nextPage?: string;
  /** `X-Total`, which GitLab omits for large collections. */
  total?: number;
}

const API_ROOT = "/api/v4/";
const USER_AGENT = "particle-academy/fancy-git-gitlab";
const SEGMENT = "(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+";
const API_PATH = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`);

function invalid(message: string): GitError {
  return new GitError("invalid_argument", message);
}

/** RFC 3986 unreserved characters stay; everything else is percent-encoded, as PHP's rawurlencode does. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Checked on the DECODED path, so `%2e%2e` and `..%2F..` are caught too. */
function hasDotSegment(path: string): boolean {
  const decoded = path.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return decoded.split("/").some((segment) => segment === "." || segment === "..");
}

function isApiPath(path: string): boolean {
  return API_PATH.test(path) && !hasDotSegment(path);
}

/** `{"title": ["can't be blank"]}` → `"title" can't be blank` */
function flatten(messages: unknown): string {
  const out: string[] = [];
  const entries = Array.isArray(messages) ? messages.map((value) => [null, value] as const) : Object.entries(messages as Record<string, unknown>);
  for (const [field, value] of entries) {
    for (const text of Array.isArray(value) ? value : [value]) {
      if (["string", "number", "boolean"].includes(typeof text)) out.push(field === null ? String(text) : `"${field}" ${String(text)}`);
    }
  }
  return [...new Set(out)].join(", ");
}

/**
 * A small first-party client for GitLab's REST API v4 — the endpoints the
 * provider needs, over `fetch`, and nothing else.
 *
 * Three rules hold for every request, because every request carries a
 * credential:
 *
 * 1. **It only goes to the configured instance.** The base URL is validated
 *    once (https, no userinfo, no query, no dot segments) and every path is
 *    checked before it is appended, so neither a caller-supplied project name
 *    nor a server-supplied pagination link can point a token somewhere else.
 * 2. **Redirects are never followed.** `fetch` strips `Authorization` on a
 *    cross-origin redirect, but it does not know GitLab's `PRIVATE-TOKEN` and
 *    `JOB-TOKEN` headers are credentials, and forwards them.
 * 3. **The token never appears in a message.** It lives in a private field,
 *    errors are built from GitLab's response rather than from the request, and
 *    nothing carrying the request is attached as an error's `cause`.
 *
 * The same rules, messages and error codes as `FancyGit\GitLab\GitLabClient`
 * in the PHP adapter.
 */
export class GitLabClient {
  static readonly GITLAB_COM = "https://gitlab.com";
  /** GitLab's own ceiling; it silently serves 100 for anything larger. */
  static readonly MAX_PER_PAGE = 100;

  readonly baseUrl: string;
  readonly tokenType: GitLabTokenType;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: GitLabClientOptions = {}) {
    this.baseUrl = GitLabClient.normalizeBaseUrl(options.baseUrl ?? GitLabClient.GITLAB_COM);

    // Visible ASCII only. GitLab tokens are all of that shape, and it rules out
    // both a blank env var — which would otherwise send anonymous requests that
    // a private project answers with a misleading 404 — and a CR/LF.
    if (options.token !== undefined && !/^[\x21-\x7E]+$/.test(options.token)) {
      throw invalid("The GitLab token is blank or contains whitespace or control characters, which no GitLab token does. Nothing was sent.");
    }
    const tokenType = options.tokenType ?? "access_token";
    if (!["access_token", "oauth", "ci_job"].includes(tokenType)) {
      throw invalid('The GitLab token type must be "access_token", "oauth" or "ci_job".');
    }

    this.tokenType = tokenType;
    this.#token = options.token;
    // Resolved per call, so a fetch installed after construction is the one used.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Validate an instance URL and return its canonical form.
   *
   * The URL is deliberately NOT echoed in the error, because a rejected URL may
   * be one carrying a password.
   */
  static normalizeBaseUrl(url: string): string {
    // Control characters, whitespace and backslashes first: parsers disagree
    // about all three, and a URL two parsers read differently is how a request
    // reaches a host other than the one that was checked.
    if (url === "" || /[\x00-\x20\x7F\\]/.test(url)) {
      throw invalid("The GitLab base URL is empty or contains whitespace, control characters or a backslash.");
    }

    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s.exec(url);
    if (!scheme || scheme[2] === "" || scheme[2]!.startsWith("/")) {
      throw invalid("The GitLab base URL must be an absolute https URL, such as https://gitlab.example.com.");
    }
    if (scheme[1]!.toLowerCase() !== "https") {
      throw invalid("The GitLab base URL must use https. Over plain http the access token is readable by anything on the network path.");
    }
    if (url.includes("?") || url.includes("#")) {
      throw invalid("The GitLab base URL must not contain a query string or fragment.");
    }

    const [, authority = "", rawPath = ""] = /^([^/]*)(.*)$/s.exec(scheme[2]!)!;
    if (authority.includes("@")) {
      throw invalid("The GitLab base URL must not contain credentials. Pass the token as the token option.");
    }

    const hostPort = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(authority);
    const host = (hostPort?.[1] ?? "").toLowerCase();
    const isHostname = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$/.test(host);
    const isIpv6 = /^\[[0-9a-f:.]+\]$/.test(host) && GitLabClient.#parsesAsHost(host);
    if (!hostPort || (!isHostname && !isIpv6)) {
      throw invalid("The GitLab base URL does not have a valid host name.");
    }
    const port = hostPort[2] === undefined || hostPort[2] === "" ? undefined : Number(hostPort[2]);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw invalid("The GitLab base URL does not have a valid port.");
    }

    const path = rawPath.replace(/\/+$/, "");
    if (path !== "") {
      // Plain segments only: no percent-encoding, no empty or dot segments.
      if (!/^(?:\/[A-Za-z0-9._~-]+)+$/.test(path) || hasDotSegment(path.slice(1))) {
        throw invalid("The GitLab base URL path may only be a relative URL root made of plain segments, such as /gitlab.");
      }
      if (/\/api\/v\d+$/i.test(path)) {
        throw invalid("Pass the GitLab INSTANCE URL (https://gitlab.example.com), not its API URL; /api/v4 is added for you.");
      }
    }

    return `https://${host}${port !== undefined && port !== 443 ? `:${port}` : ""}${path}`;
  }

  static #parsesAsHost(host: string): boolean {
    try {
      return new URL(`https://${host}/`).host === host;
    } catch {
      return false;
    }
  }

  /**
   * The API path of a project, with its full namespace encoded as ONE segment
   * (`projects/group%2Fsub%2Fapp`), which is how GitLab addresses a project by
   * path. Encode it exactly once: a second pass yields `%252F`, which GitLab
   * answers with a 404 indistinguishable from a permissions problem.
   */
  static projectPath(owner: string, name: string): string {
    if (typeof owner !== "string" || typeof name !== "string" || owner.trim() === "" || name.trim() === "") {
      throw invalid("A GitLab project needs a non-empty owner (namespace) and name.");
    }
    return `projects/${encode(`${owner}/${name}`)}`;
  }

  async get(path: string, query: GitLabQuery = {}): Promise<GitLabResponse> {
    const { response, data } = await this.#exchange("GET", this.#url(path, query));
    const next = GitLabClient.#nextPageNumber(response);
    const total = response.headers.get("x-total")?.trim() ?? "";
    return { status: response.status, data, ...(next ? { nextPage: next } : {}), ...(/^\d+$/.test(total) ? { total: Number(total) } : {}) };
  }

  /** `body` is sent as JSON. */
  async post(path: string, body: Record<string, unknown>): Promise<GitLabResponse> {
    const { response, data } = await this.#exchange("POST", this.#url(path), body);
    return { status: response.status, data };
  }

  /**
   * Every item of a paginated collection.
   *
   * Follows `X-Next-Page` (offset pagination), rebuilding the request against
   * this instance from the page number; otherwise a `Link: rel="next"` (keyset
   * pagination), which must point back inside this instance's API before it is
   * followed. Stops with an error past `maxPages` rather than returning a
   * truncated list that reads as complete.
   */
  async getAll(path: string, query: GitLabQuery = {}, maxPages = 10): Promise<unknown[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1) throw invalid("getAll needs a page limit of at least 1.");

    const fullQuery: GitLabQuery = { ...query, per_page: query.per_page ?? GitLabClient.MAX_PER_PAGE };
    let url = this.#url(path, fullQuery);
    const items: unknown[] = [];

    for (let page = 1; ; page++) {
      const { response, data } = await this.#exchange("GET", url);
      items.push(...GitLabClient.items(data, `GET ${path}`, response.status));

      let nextUrl: string;
      const next = GitLabClient.#nextPageNumber(response);
      const link = next ? undefined : GitLabClient.#nextLink(response);
      if (next) nextUrl = this.#url(path, { ...fullQuery, page: next });
      else if (link !== undefined) nextUrl = this.#ownLink(link, `GET ${path}`);
      else return items;

      if (page >= maxPages) {
        throw new GitError("unknown", `GitLab has more than ${maxPages} pages of GET ${path}. Stopped there rather than return a list that reads as complete.`);
      }
      url = nextUrl;
    }
  }

  /** A decoded body as a list, or an error saying GitLab answered with something else. */
  static items(data: unknown, what = "the request", status?: number): Record<string, any>[] {
    if (data === undefined) return [];
    if (!Array.isArray(data)) throw new GitError("unknown", `GitLab answered ${what} with a JSON object where a list was expected.`, status);
    return data;
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, tokenType: this.tokenType, token: this.#token === undefined ? null : "[REDACTED]" };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `GitLabClient ${JSON.stringify(this.toJSON())}`;
  }

  // -------------------------------------------------------------------------

  #url(path: string, query: GitLabQuery = {}): string {
    if (typeof path !== "string" || !isApiPath(path)) {
      throw invalid("A GitLab API path must be relative to /api/v4/, made of plain or percent-encoded segments, with no dot segments, query or fragment.");
    }
    const queryString = Object.entries(query)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${encode(key)}=${encode(String(value))}`)
      .join("&");
    return `${this.baseUrl}${API_ROOT}${path}${queryString === "" ? "" : `?${queryString}`}`;
  }

  #headers(): Record<string, string> {
    if (this.#token === undefined) return {};
    if (this.tokenType === "oauth") return { Authorization: `Bearer ${this.#token}` };
    if (this.tokenType === "ci_job") return { "JOB-TOKEN": this.#token };
    return { "PRIVATE-TOKEN": this.#token };
  }

  async #exchange(method: "GET" | "POST", url: string, json?: Record<string, unknown>): Promise<{ response: Response; data: unknown }> {
    const what = `${method} ${this.#describe(url)}`;
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT, ...this.#headers() };
    let body: string | undefined;
    if (json !== undefined) {
      try {
        body = JSON.stringify(json);
      } catch (error) {
        throw invalid(`The body for ${what} cannot be encoded as JSON: ${(error as Error).message}.`);
      }
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.#fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      // Message only. Nothing that holds the request — and so the credential
      // header — is attached as a cause a logger could serialize.
      const e = error as Error & { cause?: { message?: unknown } };
      const reason = e.name === "TimeoutError" ? `timed out after ${this.#timeoutMs} ms` : [e.message, typeof e.cause?.message === "string" ? e.cause.message : ""].filter(Boolean).join(": ");
      throw new GitError("unknown", `GitLab request ${what} could not be completed: ${reason}`);
    }

    const status = response.status;
    if ((status >= 300 && status < 400) || response.type === "opaqueredirect") {
      // A browser reports a manual redirect as an opaque response with status 0.
      const described = status ? `a ${status} redirect` : "a redirect";
      throw new GitError("unknown", `GitLab answered ${what} with ${described}. It was not followed, because the request carries a credential and a redirect can lead anywhere. Set the base URL to the instance's canonical https address.`, status || undefined);
    }
    if (status >= 400) throw await GitLabClient.#httpError(what, response);

    const raw = await response.text();
    if (raw.trim() === "") return { response, data: undefined };

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      const type = response.headers.get("content-type") || "none";
      throw new GitError("unknown", `GitLab answered ${what} with a ${status} that is not JSON (Content-Type: ${type}). Check that the base URL is the GitLab instance itself, not a sign-in page or a proxy in front of it.`, status);
    }
    if (data === null || typeof data !== "object") {
      throw new GitError("unknown", `GitLab answered ${what} with JSON that is neither an object nor a list.`, status);
    }
    return { response, data };
  }

  static async #httpError(what: string, response: Response): Promise<GitError> {
    const status = response.status;
    const code: GitErrorCode =
      status === 401 || status === 403 ? "auth"
      : status === 404 ? "not_found"
      : status === 405 ? "unsupported"
      : status === 409 ? "conflict"
      : status === 400 || status === 422 ? "invalid_argument"
      : status === 429 ? "rate_limited"
      : "unknown";

    let message = `GitLab answered ${what} with ${status}: ${await GitLabClient.#errorMessage(response)}`;
    if (status === 429) {
      const retry = GitLabClient.#retryAfter(response);
      message += retry === undefined ? ". GitLab did not say when to retry." : `. Retry after ${retry} seconds.`;
    }
    return new GitError(code, message, status);
  }

  /** GitLab's error body, in the three shapes it uses. */
  static async #errorMessage(response: Response): Promise<string> {
    const fallback = response.statusText || "no reason given";
    let content: any;
    try {
      content = JSON.parse(await response.text());
    } catch {
      return fallback;
    }
    if (content === null || typeof content !== "object") return fallback;

    const message =
      typeof content.message === "string" ? content.message
      : content.message !== null && typeof content.message === "object" ? flatten(content.message)
      : typeof content.error_description === "string" ? content.error_description
      : typeof content.error === "string" ? content.error
      : fallback;

    // Bounded and single-line: this ends up in logs.
    const line = message.replace(/[\x00-\x1F\x7F]+/g, " ");
    return line.length > 500 ? `${line.slice(0, 500)}…` : line;
  }

  static #retryAfter(response: Response): number | undefined {
    const value = response.headers.get("retry-after")?.trim() ?? "";
    if (value === "") return undefined;
    if (/^\d+$/.test(value)) return Number(value);
    const at = Date.parse(value);
    return Number.isNaN(at) ? undefined : Math.max(0, Math.round((at - Date.now()) / 1000));
  }

  static #nextPageNumber(response: Response): string | undefined {
    const next = response.headers.get("x-next-page")?.trim() ?? "";
    return /^[1-9][0-9]{0,9}$/.test(next) ? next : undefined;
  }

  static #nextLink(response: Response): string | undefined {
    const header = response.headers.get("link");
    if (!header) return undefined;
    for (const [, target, params] of header.matchAll(/<([^>]*)>((?:\s*;\s*[^;,]+)*)/g)) {
      const rel = /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(params ?? "");
      if (rel && rel[1]!.trim().toLowerCase().split(/\s+/).includes("next")) return target;
    }
    return undefined;
  }

  /** A server-supplied link, accepted only if it points back inside this instance's API. */
  #ownLink(link: string, what: string): string {
    const mine = /^https:\/\/([^/:]+|\[[^\]]+\])(?::(\d+))?(\/.*)?$/.exec(this.baseUrl)!;
    const theirs = /[\x00-\x20\x7F\\]/.test(link) ? null : /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?$/.exec(link);
    const authority = theirs ? /^(\[[^\]]*\]|[^:@]*)(?::(\d+))?$/.exec(theirs[2]!) : null;
    const prefix = `${mine[3] ?? ""}${API_ROOT}`;
    const path = theirs?.[3] ?? "";

    const own =
      theirs !== null &&
      authority !== null &&
      theirs[1]!.toLowerCase() === "https" &&
      authority[1]!.toLowerCase() === mine[1] &&
      Number(authority[2] ?? 443) === Number(mine[2] ?? 443) &&
      path.startsWith(prefix) &&
      isApiPath(path.slice(prefix.length));

    if (!own) {
      throw new GitError("unknown", `GitLab's pagination link for ${what} points outside ${this.baseUrl}/api/v4/. It was not followed, because the request carries a credential.`);
    }
    return link;
  }

  #describe(url: string): string {
    const withoutQuery = url.split("?", 1)[0]!;
    const prefix = `${this.baseUrl}${API_ROOT}`;
    return withoutQuery.startsWith(prefix) ? withoutQuery.slice(prefix.length) : withoutQuery;
  }
}
