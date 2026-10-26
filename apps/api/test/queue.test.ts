import { describe, expect, it } from 'vitest';
import { Job } from '@keyless/core/models/Job';
import { ErrorLog } from '@keyless/core/models/ErrorLog';
import { MongoQueue, MongoWorker } from '@keyless/core/queue/mongo';
import { PermanentJobError, backoffMs, type JobHandlers } from '@keyless/core/queue/types';
import { useTestApp } from './helpers';

const t = useTestApp();

function handlers(impl: Partial<JobHandlers>): JobHandlers {
  const noop = async () => undefined;
  return { 'process-email': noop, 'classify-email': noop, 'mailbox-sync': noop, ...impl };
}

/** Make delayed retries due now so drain() picks them up. */
const fastForward = () => Job.updateMany({ status: 'waiting' }, { runAt: new Date(0) });

describe('MongoDB job queue', () => {
  it('retries with exponential backoff, then records a permanent failure', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const queue = new MongoQueue();
    let calls = 0;
    const worker = new MongoWorker(
      handlers({
        'classify-email': async () => {
          calls += 1;
          throw new Error('LLM timeout');
        },
      }),
    );
    const data = { orgId: owner.orgId.toString(), emailId: '6560f0000000000000000001' };
    await queue.add('classify-email', data, { maxAttempts: 3 });

    await worker.drain();
    let job = await Job.findOne({ name: 'classify-email' });
    expect(job).toMatchObject({ status: 'waiting', attempts: 1, lastError: 'LLM timeout' });
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + backoffMs(1) - 1000);

    await fastForward();
    await worker.drain();
    await fastForward();
    await worker.drain();
    job = await Job.findOne({ name: 'classify-email' });
    expect(job).toMatchObject({ status: 'failed', attempts: 3 });
    expect(calls).toBe(3);
    expect(await ErrorLog.find({ orgId: owner.orgId })).toEqual([
      expect.objectContaining({
        jobName: 'classify-email',
        message: 'LLM timeout',
        attempts: 3,
        status: 'open',
      }),
    ]);
  });

  it('does not retry permanent errors', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const queue = new MongoQueue();
    const worker = new MongoWorker(
      handlers({
        'process-email': async () => {
          throw new PermanentJobError('gone');
        },
      }),
    );
    await queue.add('process-email', {
      orgId: owner.orgId.toString(),
      emailId: '6560f0000000000000000002',
    });
    await worker.drain();
    expect(await Job.findOne({ name: 'process-email' })).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
  });

  it('deduplicates by unique key and re-runs finished jobs only on reset', async () => {
    const queue = new MongoQueue();
    let runs = 0;
    const worker = new MongoWorker(
      handlers({
        'mailbox-sync': async () => {
          runs += 1;
        },
      }),
    );
    const data = { orgId: '6560f0000000000000000003', mailboxId: 'm1' };
    await queue.add('mailbox-sync', data, { uniqueKey: 'mailbox-sync:m1' });
    await queue.add('mailbox-sync', data, { uniqueKey: 'mailbox-sync:m1' });
    expect(await Job.countDocuments()).toBe(1);
    await worker.drain();
    await queue.add('mailbox-sync', data, { uniqueKey: 'mailbox-sync:m1' });
    await worker.drain();
    expect(runs).toBe(1);
    await queue.add('mailbox-sync', data, { uniqueKey: 'mailbox-sync:m1', reset: true });
    await worker.drain();
    expect(runs).toBe(2);
  });

  it('reclaims jobs whose worker died mid-run (expired lease)', async () => {
    const queue = new MongoQueue();
    let runs = 0;
    await queue.add('mailbox-sync', { orgId: '6560f0000000000000000004', mailboxId: 'm2' });
    await Job.updateOne(
      {},
      { status: 'active', attempts: 1, lockedUntil: new Date(Date.now() - 1000) },
    );
    await new MongoWorker(
      handlers({
        'mailbox-sync': async () => {
          runs += 1;
        },
      }),
    ).drain();
    expect(runs).toBe(1);
    expect(await Job.findOne()).toMatchObject({ status: 'completed', attempts: 2 });
  });

  it('admins retry or dismiss processing errors', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const reviewer = await t.createUser({ role: 'reviewer', orgId: owner.orgId });
    const entry = await ErrorLog.create({
      orgId: owner.orgId,
      jobName: 'mailbox-sync',
      data: { orgId: owner.orgId.toString(), mailboxId: 'm3' },
      entity: { type: 'mailbox', id: 'm3' },
      message: 'boom',
      attempts: 3,
    });
    const rc = await t.loginAs(reviewer.email);
    expect((await rc.get('/api/processing-errors')).status).toBe(403);

    const c = await t.loginAs(owner.email);
    expect((await c.get('/api/processing-errors')).body.items).toHaveLength(1);
    expect((await c.post(`/api/processing-errors/${entry._id}/retry`)).status).toBe(200);
    expect(await Job.findOne({ uniqueKey: 'mailbox-sync:m3' })).toMatchObject({
      status: 'waiting',
    });
    expect((await c.get('/api/processing-errors')).body.items).toHaveLength(0);
  });
});
