import { describe, it, expect, vi } from 'vitest';
import { QueueStore, type QueuedJob } from './queue-store';

const job = (id: string, conversationId: string | null = null): QueuedJob => ({
  id, conversationId, promptText: 'p-' + id, modelTarget: 'm', scheduledFor: '2026-06-15T19:00:00Z', status: 'PENDING',
});

describe('QueueStore', () => {
  it('notifies subscribers immediately and on change', async () => {
    const store = new QueueStore(async () => [job('a')]);
    const seen: QueuedJob[][] = [];
    store.subscribe((j) => seen.push(j));
    expect(seen[0]).toEqual([]);          // initial empty
    await store.refresh();
    expect(seen[1]).toEqual([job('a')]);  // after fetch
  });

  it('replaces contents on refresh', async () => {
    let batch = [job('a')];
    const store = new QueueStore(async () => batch);
    await store.refresh();
    batch = [job('b')];
    await store.refresh();
    expect(store.getJobs()).toEqual([job('b')]);
  });

  it('retains an optimistically-added job until it appears or the grace expires', async () => {
    let now = 1000;
    const store = new QueueStore(async () => [], { graceMs: 100, now: () => now });
    store.addOptimistic(job('a'));
    await store.refresh();                       // fetch empty, within grace
    expect(store.getJobs().map(j => j.id)).toEqual(['a']);
    now = 2000;                                  // past grace
    await store.refresh();
    expect(store.getJobs()).toEqual([]);
  });

  it('dedupes when the real job arrives in a fetch', async () => {
    const store = new QueueStore(async () => [job('a')], { graceMs: 10_000, now: () => 0 });
    store.addOptimistic(job('a'));
    await store.refresh();
    expect(store.getJobs().map(j => j.id)).toEqual(['a']); // not duplicated
  });

  it('remove() drops a job and stops retaining it', async () => {
    const store = new QueueStore(async () => [], { graceMs: 10_000, now: () => 0 });
    store.addOptimistic(job('a'));
    store.remove('a');
    await store.refresh();
    expect(store.getJobs()).toEqual([]);
  });

  it('jobsForConversation filters by conversationId', () => {
    const store = new QueueStore(async () => []);
    store.addOptimistic(job('a', 'c1'));
    store.addOptimistic(job('b', null));
    expect(store.jobsForConversation('c1').map(j => j.id)).toEqual(['a']);
    expect(store.jobsForConversation(null).map(j => j.id)).toEqual(['b']);
  });

  it('filters out non-PENDING jobs from fetched results', async () => {
    const completed = { ...job('a'), status: 'COMPLETED' };
    const processing = { ...job('b'), status: 'PROCESSING' };
    const pending = job('c');
    const store = new QueueStore(async () => [completed, processing, pending]);
    await store.refresh();
    expect(store.getJobs().map(j => j.id)).toEqual(['c']);
  });
});
