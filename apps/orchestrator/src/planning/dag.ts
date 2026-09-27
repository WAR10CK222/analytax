import type { Task } from "@analytax/contracts";

export type TaskMap = Readonly<Record<string, Task>>;

export const taskNumber = (id: string): number => {
  const match = /(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

export const compareTaskIds = (a: string, b: string): number => taskNumber(a) - taskNumber(b) || (a < b ? -1 : a > b ? 1 : 0);

export const sortedTasks = (tasks: TaskMap): Task[] => Object.values(tasks).sort((a, b) => compareTaskIds(a.id, b.id));

/** taskId → ids of tasks that list it in `dependsOn`. */
export function dependentsIndex(tasks: TaskMap): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const task of sortedTasks(tasks)) {
    for (const dependency of task.dependsOn) {
      const list = index.get(dependency);
      if (list) list.push(task.id);
      else index.set(dependency, [task.id]);
    }
  }
  return index;
}

/** Kahn's algorithm. Returns ids in dependency order, or the unresolved remainder when a cycle exists. */
export function topologicalSort(tasks: TaskMap): { order: string[]; cyclic: string[] } {
  const inDegree = new Map<string, number>();
  for (const task of Object.values(tasks)) {
    inDegree.set(task.id, task.dependsOn.filter((dependency) => dependency in tasks).length);
  }
  const dependents = dependentsIndex(tasks);
  const queue = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort(compareTaskIds);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const degree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, degree);
      if (degree === 0) {
        queue.push(dependent);
        queue.sort(compareTaskIds);
      }
    }
  }
  const cyclic = [...inDegree.entries()].filter(([, degree]) => degree > 0).map(([id]) => id).sort(compareTaskIds);
  return { order, cyclic };
}

export function findCycle(tasks: TaskMap): string[] | null {
  const { cyclic } = topologicalSort(tasks);
  return cyclic.length > 0 ? cyclic : null;
}

export function descendants(tasks: TaskMap, id: string, index = dependentsIndex(tasks)): Set<string> {
  const seen = new Set<string>();
  const stack = [...(index.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(index.get(next) ?? []));
  }
  return seen;
}

export function ancestors(tasks: TaskMap, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(tasks[id]?.dependsOn ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(tasks[next]?.dependsOn ?? []));
  }
  return seen;
}

export function hasCriticalDescendant(tasks: TaskMap, id: string, index = dependentsIndex(tasks)): boolean {
  for (const descendant of descendants(tasks, id, index)) if (tasks[descendant]?.critical) return true;
  return false;
}
