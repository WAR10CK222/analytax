import type { ArtifactRef } from "@analytax/contracts";
import type { BaseStore } from "@langchain/langgraph";

/**
 * Large task outputs live in the LangGraph store (provided by the Agent Server, or InMemoryStore in tests);
 * graph state keeps only summaries plus an ArtifactRef. Falls back to "no store" gracefully.
 */
export class ArtifactStore {
  constructor(
    private readonly store: BaseStore | null | undefined,
    private readonly threadId: string,
  ) {}

  get available(): boolean {
    return Boolean(this.store);
  }

  namespace(): string[] {
    return ["analytax", this.threadId, "artifacts"];
  }

  async put(taskId: string, attempt: number, content: string, mime = "text/markdown"): Promise<ArtifactRef | null> {
    if (!this.store) return null;
    const key = `${taskId}.a${attempt}`;
    const bytes = Buffer.byteLength(content, "utf8");
    await this.store.put(this.namespace(), key, { content, mime, bytes, createdAt: new Date().toISOString() }, false);
    return { namespace: this.namespace(), key, bytes, mime };
  }

  async read(ref: ArtifactRef): Promise<string> {
    if (!this.store) return "";
    const item = await this.store.get(ref.namespace, ref.key);
    const content = item?.value?.content;
    return typeof content === "string" ? content : "";
  }
}
