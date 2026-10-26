import { describe, expect, it } from 'vitest';
import { sampleEmail } from '@keyless/core/demo/sampleEmails';
import { decrypt, encrypt } from '@keyless/core/lib/crypto';
import { ErrorLog } from '@keyless/core/models/ErrorLog';
import { InboundEmail } from '@keyless/core/models/InboundEmail';
import { Mailbox } from '@keyless/core/models/Mailbox';
import type { FetchLike } from '@keyless/core/mailboxes/oauth';
import { useTestApp } from './helpers';

/** A scripted fake of the Microsoft/Google endpoints. Each test sets `routes`. */
type Route = (url: URL, init?: RequestInit) => Response | undefined;
let routes: Route[] = [];
const calls: string[] = [];
const fakeFetch: FetchLike = async (input, init) => {
  const url = new URL(input);
  calls.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
  for (const route of routes) {
    const res = route(url, init);
    if (res) return res;
  }
  return new Response(JSON.stringify({ error: 'not_mocked', url: input }), { status: 599 });
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const t = useTestApp({ fakeFetch });

const mime = (subject: string, id: string) =>
  sampleEmail('body_order', {
    customerName: 'Oak Kitchen',
    senderName: 'Pat',
    senderAddress: 'pat@oakkitchen.example',
    to: 'orders@distributor.example',
    poNumber: subject,
    deliveryAddress: ['1 Mill Road'],
    lines: [
      { code: 'GL1001', description: 'Gloves', quantity: 3 },
      { code: 'BL1001', description: 'Sacks', quantity: 2 },
    ],
  }).then((b) =>
    Buffer.from(b.toString('utf8').replace(/^Message-ID: .*$/m, `Message-ID: <${id}@oak.example>`)),
  );

async function connectedMailbox(type: 'graph' | 'gmail', orgId: unknown) {
  return Mailbox.create({
    orgId,
    type,
    name: 'orders@distributor.example',
    address: 'orders@distributor.example',
    folder: type === 'graph' ? 'inbox' : 'INBOX',
    tokensEnc: encrypt(
      JSON.stringify({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresAt: Date.now() + 3_600_000,
      }),
    ),
  });
}

describe('mailbox list and forwarding address', () => {
  it('creates one forwarding address per org and reports which providers are configured', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    const first = await c.get('/api/mailboxes');
    const second = await c.get('/api/mailboxes');
    expect(first.body.items).toHaveLength(1);
    expect(second.body.items[0].address).toBe(first.body.items[0].address);
    expect(first.body.providers).toEqual({ graph: true, gmail: true });
    expect((await c.delete(`/api/mailboxes/${first.body.items[0].id}`)).status).toBe(403);
  });
});

describe('OAuth connect', () => {
  it('redirects to Microsoft with PKCE, then stores encrypted tokens on callback', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);

    const start = await c.get('/api/mailboxes/oauth/graph/start');
    expect(start.status).toBe(302);
    const auth = new URL(start.headers.location!);
    expect(`${auth.origin}${auth.pathname}`).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('redirect_uri')).toBe(
      'http://localhost:5173/api/mailboxes/oauth/graph/callback',
    );
    expect(auth.searchParams.get('scope')).toContain('offline_access');
    const state = auth.searchParams.get('state')!;

    let tokenBody = '';
    routes = [
      (url, init) => {
        if (url.pathname.endsWith('/oauth2/v2.0/token')) {
          tokenBody = String(init?.body);
          return json({
            access_token: 'at-new',
            refresh_token: 'rt-new',
            expires_in: 3600,
            token_type: 'Bearer',
          });
        }
      },
      (url) =>
        url.pathname === '/v1.0/me' ? json({ mail: 'Orders@Distributor.example' }) : undefined,
    ];

    // Wrong state is rejected.
    const bad = await c.get(`/api/mailboxes/oauth/graph/callback?code=abc&state=wrong`);
    expect(bad.headers.location).toContain('error=');

    const restart = await c.get('/api/mailboxes/oauth/graph/start');
    const state2 = new URL(restart.headers.location!).searchParams.get('state')!;
    expect(state2).not.toBe(state);
    const done = await c.get(`/api/mailboxes/oauth/graph/callback?code=abc&state=${state2}`);
    expect(done.headers.location).toBe(
      'http://localhost:5173/settings/mailboxes?connected=orders%40distributor.example',
    );
    expect(tokenBody).toContain('grant_type=authorization_code');
    expect(tokenBody).toContain('code_verifier=');

    const mailbox = await Mailbox.findOne({ orgId: owner.orgId, type: 'graph' });
    expect(mailbox).toMatchObject({
      address: 'orders@distributor.example',
      status: 'active',
      folder: 'inbox',
    });
    expect(mailbox!.tokensEnc).not.toContain('rt-new');
    expect(JSON.parse(decrypt(mailbox!.tokensEnc!))).toMatchObject({ refreshToken: 'rt-new' });
  });

  it('only admins can start a connection', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const reviewer = await t.createUser({ role: 'reviewer', orgId: owner.orgId });
    const rc = await t.loginAs(reviewer.email);
    expect((await rc.get('/api/mailboxes/oauth/gmail/start')).status).toBe(403);
  });
});

describe('Microsoft Graph sync', () => {
  it('imports new messages via delta, then resumes from the deltaLink', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const mailbox = await connectedMailbox('graph', owner.orgId);
    const raws: Record<string, Buffer> = {
      m1: await mime('PO-1', 'one'),
      m2: await mime('PO-2', 'two'),
      m3: await mime('PO-3', 'three'),
    };
    let deltaRound = 0;
    routes = [
      (url) => {
        if (!url.pathname.endsWith('/messages/delta')) return;
        if (url.searchParams.get('$deltatoken') === 'd1') {
          deltaRound = 2;
          return json({
            value: [{ id: 'm3' }, { id: 'gone', '@removed': { reason: 'deleted' } }],
            '@odata.deltaLink':
              'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=d2',
          });
        }
        if (url.searchParams.get('$skiptoken') === 's1') {
          return json({
            value: [{ id: 'm2' }],
            '@odata.deltaLink':
              'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=d1',
          });
        }
        deltaRound = 1;
        expect(url.searchParams.get('$filter')).toMatch(/^receivedDateTime ge /);
        return json({
          value: [{ id: 'm1' }],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=s1',
        });
      },
      (url) => {
        const m = /\/me\/messages\/([^/]+)\/\$value$/.exec(url.pathname);
        return m ? new Response(raws[m[1]!]) : undefined;
      },
    ];

    const c = await t.loginAs(owner.email);
    await c.post(`/api/mailboxes/${mailbox._id}/sync`);
    await t.drainJobs();
    expect(deltaRound).toBe(1);
    expect(await InboundEmail.countDocuments({ orgId: owner.orgId, source: 'graph' })).toBe(2);
    const saved = await Mailbox.findOne({ _id: mailbox._id, orgId: owner.orgId });
    expect(saved!.syncCursor).toContain('$deltatoken=d1');
    expect(saved!.lastSyncAt).toBeTruthy();

    await c.post(`/api/mailboxes/${mailbox._id}/sync`);
    await t.drainJobs();
    expect(deltaRound).toBe(2);
    expect(await InboundEmail.countDocuments({ orgId: owner.orgId })).toBe(3);
    expect(await InboundEmail.countDocuments({ orgId: owner.orgId, status: 'classified' })).toBe(3);
  });

  it('refreshes an expired access token and keeps the rotated refresh token', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const mailbox = await connectedMailbox('graph', owner.orgId);
    mailbox.tokensEnc = encrypt(
      JSON.stringify({ accessToken: 'old', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 }),
    );
    await mailbox.save();
    let auth = '';
    routes = [
      (url) =>
        url.pathname.endsWith('/token')
          ? json({ access_token: 'fresh', refresh_token: 'rt-2', expires_in: 3600 })
          : undefined,
      (url, init) => {
        if (!url.pathname.endsWith('/messages/delta')) return;
        auth = new Headers(init?.headers).get('authorization') ?? '';
        return json({
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/x?$deltatoken=z',
        });
      },
    ];
    const c = await t.loginAs(owner.email);
    await c.post(`/api/mailboxes/${mailbox._id}/sync`);
    await t.drainJobs();
    expect(auth).toBe('Bearer fresh');
    const saved = await Mailbox.findOne({ _id: mailbox._id, orgId: owner.orgId });
    expect(JSON.parse(decrypt(saved!.tokensEnc!))).toMatchObject({
      accessToken: 'fresh',
      refreshToken: 'rt-2',
    });
  });

  it('a revoked grant stops syncing and asks for a reconnect', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const mailbox = await connectedMailbox('graph', owner.orgId);
    mailbox.tokensEnc = encrypt(
      JSON.stringify({ accessToken: 'old', refreshToken: 'dead', expiresAt: 0 }),
    );
    await mailbox.save();
    routes = [
      (url) =>
        url.pathname.endsWith('/token')
          ? json({ error: 'invalid_grant', error_description: 'AADSTS70000: revoked' }, 400)
          : undefined,
    ];
    const c = await t.loginAs(owner.email);
    await c.post(`/api/mailboxes/${mailbox._id}/sync`);
    await t.drainJobs();
    const saved = await Mailbox.findOne({ _id: mailbox._id, orgId: owner.orgId });
    expect(saved).toMatchObject({ status: 'error' });
    expect(saved!.lastError).toContain('reconnect');
    expect(await ErrorLog.countDocuments({ orgId: owner.orgId, jobName: 'mailbox-sync' })).toBe(1);
  });
});

describe('Gmail sync', () => {
  it('does a lookback sync first, then follows history; a 404 history id triggers a full resync', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const mailbox = await connectedMailbox('gmail', owner.orgId);
    const raws: Record<string, Buffer> = {
      g1: await mime('PO-10', 'g-one'),
      g2: await mime('PO-11', 'g-two'),
    };
    let historyStatus = 200;
    routes = [
      (url) =>
        url.pathname === '/gmail/v1/users/me/profile'
          ? json({ emailAddress: 'orders@distributor.example', historyId: '100' })
          : undefined,
      (url) => {
        if (url.pathname !== '/gmail/v1/users/me/messages') return;
        expect(url.searchParams.get('labelIds')).toBe('INBOX');
        expect(url.searchParams.get('q')).toBe('newer_than:2d');
        return json({ messages: [{ id: 'g1' }] });
      },
      (url) => {
        if (url.pathname !== '/gmail/v1/users/me/history') return;
        if (historyStatus === 404) return json({ error: { code: 404 } }, 404);
        expect(url.searchParams.get('startHistoryId')).toBe('100');
        return json({
          history: [{ messagesAdded: [{ message: { id: 'g2' } }, { message: { id: 'g1' } }] }],
          historyId: '120',
        });
      },
      (url) => {
        const m = /\/messages\/([^/]+)$/.exec(url.pathname);
        return m && url.searchParams.get('format') === 'raw'
          ? json({ id: m[1], raw: raws[m[1]!]!.toString('base64url') })
          : undefined;
      },
    ];
    const c = await t.loginAs(owner.email);
    await c.post(`/api/mailboxes/${mailbox._id}/sync`);
    await t.drainJobs();
    expect(await InboundEmail.countDocuments({ orgId: owner.orgId, source: 'gmail' })).toBe(1);
    expect((await Mailbox.findOne({ _id: mailbox._id, orgId: owner.orgId }))!.syncCursor).toBe(
      '100',
    );

    await c.post(`/api/mailboxes/${mailbox._id}/sync`);
    await t.drainJobs();
    expect(await InboundEmail.countDocuments({ orgId: owner.orgId })).toBe(2); // g1 deduplicated
    expect((await Mailbox.findOne({ _id: mailbox._id, orgId: owner.orgId }))!.syncCursor).toBe(
      '120',
    );

    historyStatus = 404;
    calls.length = 0;
    await c.post(`/api/mailboxes/${mailbox._id}/sync`);
    await t.drainJobs();
    expect(calls).toContain('GET https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect((await Mailbox.findOne({ _id: mailbox._id, orgId: owner.orgId }))!.syncCursor).toBe(
      '100',
    );
  });
});
