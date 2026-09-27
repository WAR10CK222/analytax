import type { StructuredToolInterface } from "@langchain/core/tools";

export type ToolFactory = () => StructuredToolInterface;

/** Named, lazily-built tools that agent cards reference by name. */
export class ToolRegistry {
  private readonly instances = new Map<string, StructuredToolInterface>();

  constructor(private readonly factories: Readonly<Record<string, ToolFactory>>) {}

  names(): Set<string> {
    return new Set(Object.keys(this.factories));
  }

  get(name: string): StructuredToolInterface {
    const existing = this.instances.get(name);
    if (existing) return existing;
    const factory = this.factories[name];
    if (!factory) throw new Error(`Unknown tool '${name}'`);
    const instance = factory();
    this.instances.set(name, instance);
    return instance;
  }

  resolve(names: readonly string[]): StructuredToolInterface[] {
    return names.map((name) => this.get(name));
  }
}
