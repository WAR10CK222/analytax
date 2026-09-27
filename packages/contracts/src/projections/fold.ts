import type { LifecycleEvent } from "../events.js";

/** A pure, incremental read model over lifecycle events. */
export interface Projection<V> {
  readonly name: string;
  init(): V;
  apply(view: V, event: LifecycleEvent): V;
}

export type ViewOf<P> = P extends Projection<infer V> ? V : never;
export type ViewsOf<P extends Record<string, Projection<unknown>>> = { [K in keyof P]: ViewOf<P[K]> };

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Dedupes by id and produces a stable order: durable events strictly by `seq`, ephemeral events by `ts`,
 * merged by timestamp (durable first on ties). Safe to call with events arriving in any order.
 */
export function orderEvents(events: Iterable<LifecycleEvent>): LifecycleEvent[] {
  const unique = new Map<string, LifecycleEvent>();
  for (const event of events) if (!unique.has(event.id)) unique.set(event.id, event);

  const durable: LifecycleEvent[] = [];
  const ephemeral: LifecycleEvent[] = [];
  for (const event of unique.values()) (event.durability === "durable" ? durable : ephemeral).push(event);
  durable.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || compareStrings(a.id, b.id));
  ephemeral.sort((a, b) => compareStrings(a.ts, b.ts) || compareStrings(a.id, b.id));

  const ordered: LifecycleEvent[] = [];
  let d = 0;
  let e = 0;
  while (d < durable.length || e < ephemeral.length) {
    const nextDurable = durable[d];
    const nextEphemeral = ephemeral[e];
    if (nextDurable && (!nextEphemeral || nextDurable.ts <= nextEphemeral.ts)) {
      ordered.push(nextDurable);
      d++;
    } else if (nextEphemeral) {
      ordered.push(nextEphemeral);
      e++;
    }
  }
  return ordered;
}

export function foldEvents<P extends Record<string, Projection<unknown>>>(
  events: Iterable<LifecycleEvent>,
  projections: P,
  options: { alreadyOrdered?: boolean } = {},
): ViewsOf<P> {
  const ordered = options.alreadyOrdered ? [...events] : orderEvents(events);
  const entries = Object.entries(projections);
  const views: Record<string, unknown> = {};
  for (const [key, projection] of entries) views[key] = projection.init();
  for (const event of ordered) {
    for (const [key, projection] of entries) views[key] = projection.apply(views[key], event);
  }
  return views as ViewsOf<P>;
}
