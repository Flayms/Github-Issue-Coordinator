/**
 * GitHub App authentication: an app JWT, exchanged for an installation token per repository
 * owner. The token is the Coordinator's only GitHub credential; agents never see it (REQ-001-15).
 */
import { createPrivateKey, sign } from "node:crypto";
import { API, baseHeaders, errorFrom, type Fetch } from "./http.ts";

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** App JWT: backdated 60s for clock drift, valid for 9 minutes (GitHub allows at most 10). */
export function createAppJwt(appId: number, privateKeyPem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const head = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: String(appId), iat, exp: iat + 600 }))}`;
  return `${head}.${b64url(sign("sha256", Buffer.from(head), createPrivateKey(privateKeyPem)))}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Tokens are renewed once less than this is left. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class AppAuth {
  private readonly installations = new Map<string, number>();
  private readonly tokens = new Map<number, CachedToken>();
  private readonly fetch: Fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: { appId: number; privateKey: string; fetch?: Fetch; now?: () => Date }) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** Installation token for the repository `owner/name`. */
  async tokenFor(repo: string): Promise<string> {
    const id = await this.installationId(repo);
    const cached = this.tokens.get(id);
    if (cached && cached.expiresAt - this.now().getTime() > REFRESH_MARGIN_MS) return cached.token;
    const path = `/app/installations/${id}/access_tokens`;
    const body = await this.appRequest<{ token: string; expires_at: string }>("POST", path);
    this.tokens.set(id, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  private async installationId(repo: string): Promise<number> {
    const owner = repo.split("/")[0]?.toLowerCase() ?? repo;
    let id = this.installations.get(owner);
    if (id === undefined) {
      id = (await this.appRequest<{ id: number }>("GET", `/repos/${repo}/installation`)).id;
      this.installations.set(owner, id);
    }
    return id;
  }

  private async appRequest<T>(method: string, path: string): Promise<T> {
    const jwt = createAppJwt(this.opts.appId, this.opts.privateKey, this.now());
    const res = await this.fetch(`${API}${path}`, {
      method,
      headers: { ...baseHeaders, authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) throw await errorFrom(res, method, path);
    return (await res.json()) as T;
  }
}
