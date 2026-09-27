import type { AgentCardSummary, CatalogResponse } from "@analytax/contracts";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useCatalog, type CatalogState } from "../lib/api";

type CatalogContextValue = CatalogState & { agentName: (id: string) => string; agent: (id: string) => AgentCardSummary | undefined };

const CatalogContext = createContext<CatalogContextValue | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const state = useCatalog();
  const value = useMemo<CatalogContextValue>(() => {
    const byId = new Map((state.catalog?.agents ?? []).map((agent) => [agent.id, agent]));
    return { ...state, agent: (id) => byId.get(id), agentName: (id) => byId.get(id)?.name ?? id };
  }, [state]);
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalogContext(): CatalogContextValue {
  const value = useContext(CatalogContext);
  if (!value) throw new Error("useCatalogContext must be used inside <CatalogProvider>");
  return value;
}

export type { CatalogResponse };
