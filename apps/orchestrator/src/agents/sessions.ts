import type { ArtifactRef, EphemeralEventType, EventDataMap } from "@analytax/contracts";

export type EphemeralEmit = <T extends EphemeralEventType>(type: T, data: Omit<EventDataMap[T], "dispatchId">) => void;

/** Live resources of one running dispatch, looked up by `dispatchId` from agent runtime context. */
export interface DispatchSession {
  dispatchId: string;
  emit: EphemeralEmit;
  artifacts: ReadonlyMap<string, ArtifactRef>;
  readArtifact(ref: ArtifactRef): Promise<string>;
}

/**
 * Process-wide registry. Agent tools and middleware receive only a serializable `{ dispatchId }` context and
 * resolve functions/stores here — functions never travel through LangGraph config or checkpoints.
 */
class DispatchSessionRegistry {
  private readonly sessions = new Map<string, DispatchSession>();

  register(session: DispatchSession): () => void {
    this.sessions.set(session.dispatchId, session);
    return () => {
      if (this.sessions.get(session.dispatchId) === session) this.sessions.delete(session.dispatchId);
    };
  }

  get(dispatchId: string | undefined | null): DispatchSession | undefined {
    return dispatchId ? this.sessions.get(dispatchId) : undefined;
  }

  fromRuntime(runtime: unknown): DispatchSession | undefined {
    const context = (runtime as { context?: { dispatchId?: unknown } } | undefined)?.context;
    return typeof context?.dispatchId === "string" ? this.sessions.get(context.dispatchId) : undefined;
  }
}

export const dispatchSessions = new DispatchSessionRegistry();
