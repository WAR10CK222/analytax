import { createContext, useContext } from "react";

export type ShellActions = {
  openRun: (threadId: string) => void;
  newRun: () => void;
  openAgents: () => void;
  toggleSidebar: () => void;
};

export const ShellContext = createContext<{ actions: ShellActions; sidebarOpen: boolean } | null>(null);

export function useShell(): { actions: ShellActions; sidebarOpen: boolean } {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside <Shell>");
  return value;
}
