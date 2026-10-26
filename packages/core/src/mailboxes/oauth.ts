import crypto from 'node:crypto';
import { env } from '../config/env';
import { decrypt, encrypt } from '../lib/crypto';
import type { MailboxDoc } from '../models/Mailbox';

/*
 * OAuth 2.0 authorization-code flow with PKCE for Microsoft 365 (Graph) and Gmail, using plain
 * HTTPS calls. Endpoints and parameters checked against the official docs (2026-10):
 *  - https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 *  - https://developers.google.com/identity/protocols/oauth2/web-server
 */

export type MailProvider = 'graph' | 'gmail';
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type ProviderConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId?: string;
  clientSecret?: string;
  extraAuthParams: Record<string, string>;
};

export function providerConfig(provider: MailProvider): ProviderConfig {
  if (provider === 'graph') {
    return {
      authorizeUrl: `https://login.microsoftonline.com/${env.MS_TENANT}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${env.MS_TENANT}/oauth2/v2.0/token`,
      // offline_access is what makes Microsoft return a refresh token.
      scopes: [
        'openid',
        'email',
        'offline_access',
        'https://graph.microsoft.com/User.Read',
        'https://graph.microsoft.com/Mail.Read',
      ],
      clientId: env.MS_CLIENT_ID,
      clientSecret: env.MS_CLIENT_SECRET,
      extraAuthParams: { response_mode: 'query', prompt: 'select_account' },
    };
  }
  return {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    // offline + consent: Google only returns a refresh token on a consented, offline request.
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  };
}

export function isProviderConfigured(provider: MailProvider): boolean {
  const c = providerConfig(provider);
  return Boolean(c.clientId && c.clientSecret);
}

/** Registered redirect URI: same origin as the web app so session cookies come along. */
export function redirectUri(provider: MailProvider): string {
  return `${env.APP_URL}/api/mailboxes/oauth/${provider}/callback`;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(provider: MailProvider, state: string, codeChallenge: string): string {
  const c = providerConfig(provider);
  const params = new URLSearchParams({
    client_id: c.clientId ?? '',
    response_type: 'code',
    redirect_uri: redirectUri(provider),
    scope: c.scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    ...c.extraAuthParams,
  });
  return `${c.authorizeUrl}?${params}`;
}

export type StoredTokens = { accessToken: string; refreshToken: string; expiresAt: number };

export class OAuthError extends Error {
  constructor(
    message: string,
    /** True when the user must reconnect (revoked or expired grant). */
    readonly needsReconnect: boolean,
  ) {
    super(message);
  }
}

async function tokenRequest(
  fetchFn: FetchLike,
  provider: MailProvider,
  body: Record<string, string>,
): Promise<StoredTokens & { refreshToken?: string }> {
  const c = providerConfig(provider);
  const res = await fetchFn(c.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId ?? '',
      client_secret: c.clientSecret ?? '',
      ...body,
    }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    const code = typeof json.error === 'string' ? json.error : `http_${res.status}`;
    const description =
      typeof json.error_description === 'string' ? json.error_description.split('\n')[0] : '';
    throw new OAuthError(
      `${provider} token request failed: ${code} ${description}`.trim(),
      code === 'invalid_grant',
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : '',
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
}

export async function exchangeCode(
  fetchFn: FetchLike,
  provider: MailProvider,
  code: string,
  codeVerifier: string,
): Promise<StoredTokens> {
  const tokens = await tokenRequest(fetchFn, provider, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(provider),
    code_verifier: codeVerifier,
  });
  if (!tokens.refreshToken) {
    throw new OAuthError(
      `${provider} did not return a refresh token; remove the app's access in your account settings and connect again`,
      true,
    );
  }
  return tokens;
}

export function saveTokens(mailbox: MailboxDoc, tokens: StoredTokens): void {
  mailbox.tokensEnc = encrypt(JSON.stringify(tokens));
}

/** A valid access token, refreshing (and persisting any rotated refresh token) when needed. */
export async function accessToken(
  fetchFn: FetchLike,
  mailbox: MailboxDoc,
  force = false,
): Promise<string> {
  if (!mailbox.tokensEnc) throw new OAuthError('Mailbox has no stored credentials', true);
  const tokens = JSON.parse(decrypt(mailbox.tokensEnc)) as StoredTokens;
  if (!force && tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;

  const refreshed = await tokenRequest(fetchFn, mailbox.type as MailProvider, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  });
  // Providers may rotate the refresh token; keep the newest one.
  saveTokens(mailbox, {
    ...refreshed,
    refreshToken: refreshed.refreshToken || tokens.refreshToken,
  });
  await mailbox.save();
  return refreshed.accessToken;
}

/** Signed-in account's address, used as the mailbox address. */
export async function fetchAccountAddress(
  fetchFn: FetchLike,
  provider: MailProvider,
  token: string,
): Promise<string> {
  const url =
    provider === 'graph'
      ? 'https://graph.microsoft.com/v1.0/me'
      : 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok)
    throw new Error(`Could not read the ${provider} account profile (HTTP ${res.status})`);
  const json = (await res.json()) as {
    mail?: string;
    userPrincipalName?: string;
    emailAddress?: string;
  };
  const address = provider === 'graph' ? (json.mail ?? json.userPrincipalName) : json.emailAddress;
  if (!address) throw new Error(`The ${provider} account has no email address`);
  return address.toLowerCase();
}
