/** RevenueCat — read-only product revenue inside Panel.
 *
 * Credentials and network calls stay in the one-shot Python module. This surface receives only
 * metrics, draws them with Panel-native DOM, and loads only when its card or tab is visible.
 */

import { moduleGet, modulePost } from "./modules";
import { invoke } from "@tauri-apps/api/core";
import "./revenuecat.css";

const M = "/m/revenuecat";
const q = (value: string): string => encodeURIComponent(value);

type Metric = {
  name: string;
  value: unknown;
  unit: string;
  period: string;
  updatedAt?: unknown;
};

export type RevenueCatData = {
  status: "needs_setup" | "ready" | "error";
  configured: boolean;
  hasKey: boolean;
  keySource?: string;
  projectId: string;
  currency: string;
  revenueType: string;
  revenue28d?: number;
  previousRevenue28d?: number;
  changePercent?: number | null;
  metrics?: Record<string, Metric>;
  chart?: Record<string, unknown>;
  fetchedAt?: number;
  cached?: boolean;
  secureStorageReady?: boolean;
  storageTarget?: string;
  error?: string;
};

export type RevenueCatHandle = {
  setProject(projectId: string, path: string): void;
  refresh(): void;
};

const cardCache = new Map<string, Promise<RevenueCatData>>();

function getData(path: string, refresh = false): Promise<RevenueCatData> {
  if (refresh) cardCache.delete(path);
  const existing = cardCache.get(path);
  if (existing) return existing;
  const pending = moduleGet<RevenueCatData>(
    `${M}/dashboard?root=${q(path)}${refresh ? "&refresh=1" : ""}`,
  ).catch((error) => ({
    status: "error" as const,
    configured: false,
    hasKey: false,
    projectId: "",
    currency: "USD",
    revenueType: "proceeds",
    error: String(error),
  }));
  cardCache.set(path, pending);
  return pending;
}

function money(value: unknown, currency: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: number >= 100 ? 0 : 2,
  }).format(number);
}

function count(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : "—";
}

function metric(data: RevenueCatData, ...ids: string[]): Metric | undefined {
  for (const id of ids) {
    const found = data.metrics?.[id];
    if (found) return found;
  }
  return undefined;
}

function trend(data: RevenueCatData): string {
  const change = data.changePercent;
  if (change === null || change === undefined || !Number.isFinite(change)) return "first measured period";
  if (Math.abs(change) < 0.05) return "flat vs previous 28 days";
  return `${change > 0 ? "↑" : "↓"} ${Math.abs(change).toFixed(1)}% vs previous 28 days`;
}

function metricValue(data: RevenueCatData, item: Metric | undefined): string {
  if (!item) return "—";
  return item.unit === "$" || /revenue|mrr/i.test(item.name)
    ? money(item.value, data.currency)
    : count(item.value);
}

export async function paintRevenueCatCard(path: string, host: HTMLElement): Promise<void> {
  host.innerHTML = `<div class="rc-card-loading">reading RevenueCat…</div>`;
  const data = await getData(path);
  if (data.status === "needs_setup") {
    host.innerHTML = data.configured
      ? `<div class="rc-card-empty"><b>Reconnect RevenueCat</b><small>Paste a read-only key once; Panel stores it in ${data.storageTarget ?? "macOS Keychain"}.</small></div>`
      : `<div class="rc-card-empty"><b>Connect RevenueCat</b><small>Create a read-only API v2 key to see live product revenue.</small></div>`;
    return;
  }
  if (data.status === "error") {
    host.innerHTML = `<div class="rc-card-empty"><b>Revenue data unavailable</b><small></small></div>`;
    host.querySelector("small")!.textContent = data.error ?? "Open RevenueCat to reconnect.";
    return;
  }
  const active = metric(data, "active_subscriptions", "active_subscribers", "active_subscriptions_count", "actives");
  const trials = metric(data, "active_trials", "trials");
  const mrr = metric(data, "mrr");
  const customers = metric(data, "new_customers");
  host.innerHTML = `
    <div class="rc-card-kpi"><strong></strong><span>28-day proceeds</span></div>
    <div class="rc-card-overview">
      <span><b data-rc="mrr"></b><small>MRR</small></span>
      <span><b data-rc="active"></b><small>active paid</small></span>
      <span><b data-rc="customers"></b><small>new customers</small></span>
    </div>
    <div class="rc-card-trend"></div>`;
  host.querySelector("strong")!.textContent = money(data.revenue28d, data.currency);
  host.querySelector<HTMLElement>("[data-rc=mrr]")!.textContent = metricValue(data, mrr);
  host.querySelector<HTMLElement>("[data-rc=active]")!.textContent = active ? count(active.value) : trials ? count(trials.value) : "—";
  host.querySelector<HTMLElement>("[data-rc=customers]")!.textContent = metricValue(data, customers);
  host.querySelector(".rc-card-trend")!.textContent = trend(data);
}

type Point = { stamp: number; value: number };

function chartPoints(chart: Record<string, unknown> | undefined): Point[] {
  const rows = Array.isArray(chart?.values) ? chart.values : [];
  const measures = Array.isArray(chart?.measures) ? chart.measures : [];
  const moneyMeasure = Math.max(
    0,
    measures.findIndex((raw) => {
      if (!raw || typeof raw !== "object") return false;
      const measure = raw as Record<string, unknown>;
      return measure.unit === "$" || /revenue|proceeds/i.test(String(measure.display_name ?? ""));
    }),
  );
  const points: Point[] = [];
  for (const raw of rows) {
    if (Array.isArray(raw)) {
      const stamp = Number(raw[0]);
      const values = raw.slice(1).flat(4).map(Number).filter(Number.isFinite);
      if (Number.isFinite(stamp) && values.length) points.push({ stamp, value: values[0] });
      continue;
    }
    if (raw && typeof raw === "object") {
      const row = raw as Record<string, unknown>;
      if (row.measure !== undefined && Number(row.measure) !== moneyMeasure) continue;
      const stamp = Number(row.timestamp ?? row.date ?? row.period ?? row.cohort ?? row.x);
      const value = Number(row.value ?? row.revenue ?? row.y);
      if (Number.isFinite(stamp) && Number.isFinite(value)) points.push({ stamp, value });
    }
  }
  return points.slice(-120);
}

function sparkline(data: RevenueCatData): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "rc-chart";
  const points = chartPoints(data.chart);
  if (points.length < 2) {
    wrap.innerHTML = `<div class="rc-chart-empty">Revenue history will appear after RevenueCat returns chart periods.</div>`;
    return wrap;
  }
  const width = 720;
  const height = 210;
  const pad = 18;
  const min = Math.min(...points.map((point) => point.value), 0);
  const max = Math.max(...points.map((point) => point.value), 1);
  const range = Math.max(1, max - min);
  const xy = points.map((point, index) => ({
    x: pad + (index / (points.length - 1)) * (width - pad * 2),
    y: height - pad - ((point.value - min) / range) * (height - pad * 2),
  }));
  const line = xy.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
  wrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="90-day RevenueCat proceeds trend">
      <defs><linearGradient id="rc-area" x1="0" y1="0" x2="0" y2="1"><stop class="rc-chart-stop" offset="0" stop-opacity=".34"/><stop class="rc-chart-stop" offset="1" stop-opacity="0"/></linearGradient></defs>
      <line class="rc-chart-zero" x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"/>
      <polygon class="rc-chart-area" points="${area}"/>
      <polyline class="rc-chart-line" points="${line}"/>
    </svg>
    <div class="rc-chart-labels"><span>90 days ago</span><b>${money(max, data.currency)} peak</b><span>today · partial</span></div>`;
  return wrap;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountRevenueCat(pane: HTMLElement): RevenueCatHandle {
  let projectPath = "";
  let latest: RevenueCatData | null = null;
  const root = element("div", "rc-root");
  pane.replaceChildren(root);

  async function load(refresh = false): Promise<void> {
    root.innerHTML = `<div class="rc-loading">Loading RevenueCat metrics…</div>`;
    latest = await getData(projectPath, refresh);
    paint(latest);
    if (refresh) {
      window.dispatchEvent(new CustomEvent("panel-revenuecat-updated", { detail: projectPath }));
    }
  }

  function paint(data: RevenueCatData): void {
    root.replaceChildren();
    const head = element("header", "rc-head");
    head.innerHTML = `<div><small>PRODUCT REVENUE</small><h2>RevenueCat</h2><p></p></div><div class="rc-head-actions"></div>`;
    head.querySelector("p")!.textContent = data.status === "ready"
      ? `${data.projectId} · ${data.revenueType === "proceeds" ? "after tax and store commission" : data.revenueType}${data.keySource ? ` · ${data.keySource}` : ""}`
      : data.configured
        ? `Reconnect this project's read-only key to ${data.storageTarget ?? "macOS Keychain"}.`
        : "Connect one RevenueCat project to this Panel project.";
    root.append(head);

    if (data.status === "needs_setup") {
      paintSetup(data);
      return;
    }
    if (data.status === "error") {
      const error = element("section", "rc-error");
      error.append(element("b", undefined, "RevenueCat could not refresh"), element("p", undefined, data.error ?? "Unknown RevenueCat error."));
      const retry = element("button", "rc-secondary", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => void load(true));
      const reconnect = element("button", "rc-secondary", "Reconnect");
      reconnect.type = "button";
      reconnect.addEventListener("click", () => paintSetup(data));
      error.append(retry, reconnect);
      root.append(error);
      return;
    }

    const refresh = element("button", "rc-refresh", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => void load(true));
    head.querySelector(".rc-head-actions")!.append(refresh);

    const metrics = element("section", "rc-metrics");
    const active = metric(data, "active_subscriptions", "active_subscribers", "active_subscriptions_count", "actives");
    const trials = metric(data, "active_trials", "trials");
    const mrr = metric(data, "mrr");
    const users = metric(data, "active_users");
    const customers = metric(data, "new_customers");
    metrics.append(
      metricCard(money(data.revenue28d, data.currency), "28-day proceeds", trend(data), "hero"),
      metricCard(metricValue(data, mrr), "MRR", "recurring revenue", ""),
      metricCard(metricValue(data, active), "Active paid", "subscriptions", ""),
      metricCard(metricValue(data, trials), "Active trials", "right now", ""),
      metricCard(metricValue(data, users), "Active users", "current period", ""),
      metricCard(metricValue(data, customers), "New customers", "current period", ""),
    );
    root.append(metrics);

    const chartSection = element("section", "rc-chart-section");
    chartSection.innerHTML = `<header><div><small>PROCEEDS</small><h3>90-day movement</h3></div><span>Today remains provisional</span></header>`;
    chartSection.append(sparkline(data));
    root.append(chartSection);

    const foot = element("footer", "rc-foot");
    const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : "just now";
    foot.textContent = `${data.cached ? "Cached" : "Updated"} ${when} · RevenueCat receipts only; advertising revenue is not included.`;
    root.append(foot);
  }

  function metricCard(value: string, label: string, note: string, tone: string): HTMLElement {
    const card = element("article", `rc-metric${tone ? ` is-${tone}` : ""}`);
    card.innerHTML = `<strong></strong><span></span><small></small>`;
    card.querySelector("strong")!.textContent = value;
    card.querySelector("span")!.textContent = label;
    card.querySelector("small")!.textContent = note;
    return card;
  }

  function paintSetup(data: RevenueCatData): void {
    root.querySelectorAll(".rc-setup, .rc-error, .rc-metrics, .rc-chart-section, .rc-foot").forEach((node) => node.remove());
    const form = element("form", "rc-setup");
    form.innerHTML = `
      <div class="rc-setup-copy"><small>ONE-TIME CONNECTION</small><h3>Paste one key. Panel handles the rest.</h3><p>Create a V2 key named <b>Panel read-only</b>. Enable only Projects read, Overview read, and Charts read.</p></div>
      <div class="rc-setup-steps">
        <button type="button" data-action="open-revenuecat">Open RevenueCat API keys ↗</button>
        <small>Panel discovers the project automatically and stores the key in ${data.storageTarget ?? "macOS Keychain"}.</small>
      </div>
      <label class="rc-key"><span>API v2 secret key</span><input name="apiKey" type="password" autocomplete="off" placeholder="Paste once — it will not be shown again" required></label>
      <label><span>Display currency</span><select name="currency"><option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option></select></label>
      <div class="rc-setup-actions"><button type="submit">Connect securely</button><small></small></div>`;
    const currency = form.elements.namedItem("currency") as HTMLSelectElement;
    currency.value = data.currency || "USD";
    form.querySelector<HTMLButtonElement>("[data-action=open-revenuecat]")!.addEventListener("click", () => {
      void invoke("open_revenuecat_setup", { projectId: data.projectId || null });
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void connect(form);
    });
    root.append(form);
  }

  async function connect(form: HTMLFormElement): Promise<void> {
    const button = form.querySelector<HTMLButtonElement>(".rc-setup-actions button")!;
    const note = form.querySelector<HTMLElement>(".rc-setup-actions small")!;
    const apiKey = (form.elements.namedItem("apiKey") as HTMLInputElement).value.trim();
    const currency = (form.elements.namedItem("currency") as HTMLSelectElement).value;
    button.disabled = true;
    button.textContent = "Connecting…";
    note.textContent = "";
    try {
      const result = await modulePost<{ ok: boolean; error?: string }>(`${M}/connect`, {
        root: projectPath,
        project_id: latest?.projectId ?? "",
        apiKey,
        currency,
        revenue_type: "proceeds",
      });
      if (!result.ok) throw new Error(result.error ?? "Could not save RevenueCat connection");
      cardCache.delete(projectPath);
      await load(true);
    } catch (error) {
      note.textContent = String(error);
      button.disabled = false;
      button.textContent = "Connect securely";
    }
  }

  return {
    setProject(_projectId, path): void {
      if (projectPath === path && latest) return;
      projectPath = path;
      void load();
    },
    refresh(): void {
      void load(true);
    },
  };
}
