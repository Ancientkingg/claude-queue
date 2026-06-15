import { useEffect, useRef, useState } from 'react';
import type { QueueStore, QueuedJob } from '@/lib/queue-store';

/** Subscribe to the QueueStore; re-renders on any store change. */
export function useQueueJobs(store: QueueStore): QueuedJob[] {
  const [jobs, setJobs] = useState<QueuedJob[]>(store.getJobs());
  useEffect(() => store.subscribe(setJobs), [store]);
  return jobs;
}

/** Track the SPA pathname. Primary signal: 'cq:nav' custom event from content.ts.
 *  Safety nets: popstate listener + periodic polling so the path never goes stale
 *  even if a page transition doesn't fire our custom event. */
export function useLocationPath(): string {
  const [path, setPath] = useState(location.pathname);
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    const update = () => {
      const current = location.pathname;
      if (current !== pathRef.current) setPath(current);
    };

    // Primary: custom event dispatched by content.ts nav interception
    window.addEventListener('cq:nav', update);
    // Safety net: native popstate (SPA back/forward without our interception)
    window.addEventListener('popstate', update);

    // Safety net: poll location.pathname every 500ms so we never miss a change
    const interval = setInterval(update, 500);

    return () => {
      window.removeEventListener('cq:nav', update);
      window.removeEventListener('popstate', update);
      clearInterval(interval);
    };
  }, []); // stable effect — uses pathRef to avoid stale closure

  return path;
}

/** "in 2 hr · 7:50 PM" style label for an absolute ISO send time. */
export function formatSendTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'unknown';
  const diff = ms - Date.now();
  const abs = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff <= 0) return `now · ${abs}`;
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins} min · ${abs}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs} hr · ${abs}`;
  const days = Math.round(hrs / 24);
  return `in ${days} d · ${new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}
