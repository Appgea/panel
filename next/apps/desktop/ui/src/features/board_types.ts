export type Scout = { id: string; agent: string | null; model?: string | null };

export type OverviewCard = {
  number: number; title: string; url: string; kind: "done" | "new" | "dropped"; apps: string[]; priority: number;
  who: string; at: string | null; created?: string | null;
  scout?: string;
};
export type OverviewData = { since?: string; until?: string; repo?: string; cards?: OverviewCard[]; limit?: number; error?: string };
