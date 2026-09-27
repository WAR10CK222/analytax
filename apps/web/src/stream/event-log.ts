import { defaultProjections, foldEvents, type LifecycleEvent, type OrchestrationViews } from "@analytax/contracts";
import { useMemo, useSyncExternalStore } from "react";

/** Ring-buffer size for ephemeral (custom-stream) events. */
export const LIVE_EVENT_CAPACITY = 2000;

export type EventLogSnapshot = {
  /** Durable events (graph state) followed by buffered live events. Fold with `foldEvents`, which orders them. */
  readonly events: readonly LifecycleEvent[];
  /** Live ephemeral events in arrival order (oldest first), at most `LIVE_EVENT_CAPACITY`. */
  readonly live: readonly LifecycleEvent[];
  /** Increments on every published change; memoize derived views on it. */
  readonly version: number;
};

type Listener = () => void;

const EMPTY: EventLogSnapshot = { events: [], live: [], version: 0 };

const scheduleFrame: (callback: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? (callback) => requestAnimationFrame(callback)
    : (callback) => setTimeout(callback, 16) as unknown as number;

const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === "function" ? (handle) => cancelAnimationFrame(handle) : (handle) => clearTimeout(handle);

function isLifecycleEventLike(value: unknown): value is LifecycleEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; type?: unknown; ts?: unknown };
  return typeof candidate.id === "string" && typeof candidate.type === "string" && typeof candidate.ts === "string";
}

/**
 * External store merging durable events (from `values.events`) with ephemeral events pushed from the
 * LangGraph custom stream. Dedupes by id, bounds live events with a ring buffer, and coalesces
 * notifications into one per animation frame. Consume with `useEventLogSnapshot`.
 */
export class EventLog {
  readonly #capacity: number;

  #durable: LifecycleEvent[] = [];
  readonly #durableIds = new Set<string>();
  #durableSource: readonly LifecycleEvent[] | null = null;
  #durableConsumed = 0;
  #durableLastId: string | undefined;

  readonly #ring: (LifecycleEvent | undefined)[];
  #ringStart = 0;
  #ringSize = 0;
  readonly #liveIds = new Set<string>();

  readonly #listeners = new Set<Listener>();
  #frame: number | null = null;
  #snapshot: EventLogSnapshot = EMPTY;

  constructor(capacity: number = LIVE_EVENT_CAPACITY) {
    this.#capacity = Math.max(1, Math.floor(capacity));
    this.#ring = new Array<LifecycleEvent | undefined>(this.#capacity);
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): EventLogSnapshot => this.#snapshot;

  /**
   * Accepts the full `values.events` array on every state update. Appends only the unseen tail when
   * the array extends the previous one; rebuilds when history was replaced (thread switch, rewind).
   */
  syncDurable(events: readonly LifecycleEvent[] | null | undefined): void {
    if (!Array.isArray(events) || events === this.#durableSource) return;
    this.#durableSource = events;

    let changed = false;
    const extendsPrevious =
      this.#durableConsumed <= events.length &&
      (this.#durableConsumed === 0 || events[this.#durableConsumed - 1]?.id === this.#durableLastId);

    if (!extendsPrevious) {
      this.#durable = [];
      this.#durableIds.clear();
      this.#durableConsumed = 0;
      changed = true;
    }

    for (let index = this.#durableConsumed; index < events.length; index++) {
      const event = events[index];
      if (!isLifecycleEventLike(event) || this.#durableIds.has(event.id)) continue;
      this.#durable.push(event);
      this.#durableIds.add(event.id);
      changed = true;
    }
    this.#durableConsumed = events.length;
    this.#durableLastId = events.at(-1)?.id;

    if (changed) this.#schedule();
  }

  /** Adds one live event from the custom stream. Returns false when it was a duplicate or malformed. */
  pushLive(event: unknown): boolean {
    if (!isLifecycleEventLike(event)) return false;
    if (this.#liveIds.has(event.id) || this.#durableIds.has(event.id)) return false;

    if (this.#ringSize === this.#capacity) {
      const evicted = this.#ring[this.#ringStart];
      if (evicted) this.#liveIds.delete(evicted.id);
      this.#ring[this.#ringStart] = event;
      this.#ringStart = (this.#ringStart + 1) % this.#capacity;
    } else {
      this.#ring[(this.#ringStart + this.#ringSize) % this.#capacity] = event;
      this.#ringSize += 1;
    }
    this.#liveIds.add(event.id);
    this.#schedule();
    return true;
  }

  /** Drops everything (new run / thread switch) and publishes immediately. */
  reset(): void {
    this.#durable = [];
    this.#durableIds.clear();
    this.#durableSource = null;
    this.#durableConsumed = 0;
    this.#durableLastId = undefined;
    this.#ring.fill(undefined);
    this.#ringStart = 0;
    this.#ringSize = 0;
    this.#liveIds.clear();
    if (this.#frame !== null) {
      cancelFrame(this.#frame);
      this.#frame = null;
    }
    this.#publish();
  }

  dispose(): void {
    if (this.#frame !== null) cancelFrame(this.#frame);
    this.#frame = null;
    this.#listeners.clear();
  }

  #schedule(): void {
    if (this.#frame !== null) return;
    this.#frame = scheduleFrame(() => {
      this.#frame = null;
      this.#publish();
    });
  }

  #publish(): void {
    const live: LifecycleEvent[] = [];
    for (let offset = 0; offset < this.#ringSize; offset++) {
      const event = this.#ring[(this.#ringStart + offset) % this.#capacity];
      if (event) live.push(event);
    }
    this.#snapshot = {
      events: this.#durable.concat(live),
      live,
      version: this.#snapshot.version + 1,
    };
    for (const listener of [...this.#listeners]) listener();
  }
}

export function useEventLogSnapshot(log: EventLog): EventLogSnapshot {
  return useSyncExternalStore(log.subscribe, log.getSnapshot, log.getSnapshot);
}

/** Folds the snapshot into every read model; recomputed only when the log version changes. */
export function useOrchestrationViews(snapshot: EventLogSnapshot): OrchestrationViews {
  const { events, version } = snapshot;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `events` is replaced whenever `version` changes.
  return useMemo(() => foldEvents(events, defaultProjections), [version]);
}
