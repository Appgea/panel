/**
 * Dev harness for the Pull all / Push all sweep and the Git card's action row. NOT part of the
 * app build — index.html never loads this. It fakes the git-manager module (repo lists, per-repo
 * phases, one conflict, one failure) so the panel can be styled, timed and screenshotted in a
 * plain browser without Tauri or a real remote. Nothing here touches a repository.
 */
import "./style.css";
import { openGitSweep } from "./features/git-sync";
import { mountDashboard } from "./features/dashboard";

type Args = { path: string; method?: string; body?: string };

const CLEAN = new URLSearchParams(location.search).has("clean");

const REPOS = [
  { name: "Wolf2048", branch: "main", behind: 2, ahead: 5, dirty: 1 },
  { name: "Payee", branch: "main", behind: 0, ahead: 0, dirty: 2 },
  { name: "Tavla", branch: "main", behind: 4, ahead: 1, dirty: 0 },
  { name: "panel", branch: "next", behind: 1, ahead: 12, dirty: 7 },
  { name: "SpeedRead", branch: "feature/paywall", behind: 3, ahead: 0, dirty: 0 },
  { name: "Kelime", branch: "main", behind: 0, ahead: 2, dirty: 0 },
  { name: "Sudokov", branch: "main", behind: 0, ahead: 0, dirty: 0 },
  { name: "Memor", branch: "main", behind: 0, ahead: 0, dirty: 0 },
  { name: "Pisti", branch: "main", behind: 0, ahead: 0, dirty: 0 },
  { name: "Weekcut", branch: "main", behind: 0, ahead: 0, dirty: 43 },
  { name: "CoinApp", branch: "main", behind: 0, ahead: 0, dirty: 0 },
].map((repo) => ({
  ...repo,
  // ?clean renders the all-green finish: no failure, no uncommitted work left behind
  dirty: CLEAN ? 0 : repo.dirty,
  path: `/Users/dev/projects/${repo.name}`,
  remote: "origin",
  hasUpstream: true,
}));

const CONFLICT = "/Users/dev/projects/Tavla";
const BROKEN = CLEAN ? "" : "/Users/dev/projects/SpeedRead";

const phases = new Map<string, { phase: string; note: string }>();
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Fake the module host: same paths, same payload shapes, invented timings. */
async function moduleRequest({ path, body }: Args): Promise<unknown> {
  const [route, query] = path.replace("/m/git-manager", "").split("?");
  const params = new URLSearchParams(query ?? "");
  const data = body ? JSON.parse(body) : {};

  if (route === "/pullable") {
    if (params.get("fetch") === "1") await wait(1400);
    return { pullable: REPOS };
  }
  if (route === "/pushable") return { pushable: REPOS };
  if (route === "/syncable") {
    await wait(1400);
    return { syncable: REPOS };
  }
  if (route === "/pull/progress" || route === "/push/progress" || route === "/sync/progress") {
    return phases.get(params.get("repo") ?? "") ?? {};
  }
  if (route === "/pull") {
    phases.set(data.repo, { phase: "fetching", note: "" });
    await wait(900);
    phases.set(data.repo, { phase: "rebasing", note: "" });
    await wait(900);
    if (data.repo === CONFLICT) return { ok: false, conflict: true, conflicts: ["lib/main.dart", "pubspec.yaml"] };
    if (data.repo === BROKEN) return { error: "could not read from remote repository (permission denied)" };
    return { ok: true, pulled: true };
  }
  if (route === "/push") {
    phases.set(data.repo, { phase: "pushing", note: "" });
    await wait(1100);
    if (data.repo === BROKEN) return { error: "updates were rejected — fetch first", rejected: true };
    return { ok: true, pushed: true };
  }
  if (route === "/pull/resolve" || route === "/pull/resolve-all") {
    const list: string[] = route === "/pull/resolve" ? [data.repo] : data.repos;
    list.forEach((repo) => phases.set(repo, { phase: "resolving", note: "" }));
    await wait(1600);
    if (route === "/pull/resolve") return { ok: true, files: ["lib/main.dart", "pubspec.yaml"] };
    return { results: list.map((repo) => ({ repo, ok: true, files: ["lib/main.dart"] })) };
  }
  if (route === "/pull/abort") return { ok: true, aborted: true };
  return { error: `dev harness has no route ${route}` };
}

// modules.ts goes through @tauri-apps/api's invoke, which lands here.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: (_cmd: string, args: Args) => moduleRequest(args),
  transformCallback: (cb: unknown) => cb,
};

const stage = document.querySelector<HTMLElement>("#stage")!;
stage.style.cssText = "min-height:100vh;background:var(--bg);";

// The real dashboard, so the Git card's action row is styled in its actual neighbours' company.
const dash = mountDashboard(stage, () => {}, {
  async runWithAgent(prompt) {
    // eslint-disable-next-line no-console
    console.log("[dev] agent prompt:", prompt);
  },
  // The fixture is here for the Git card's action row. The rest of the bar only has to exist.
  openSession: () => {},
  run: () => {},
  stop: () => {},
  nudge: () => {},
  openFolder: () => {},
  installed: (module) => module === "git-manager",
});
dash.setModules(new Set(["git", "product-spine", "release"]));
dash.setProject(
  {
    id: "wolf",
    name: "Wolf2048",
    path: "/Users/dev/projects/Wolf2048",
    exists: true,
    group: "",
    role: "leaf",
    type: "generic",
    parent_id: "",
    extension_id: "",
  },
  { branch: "main", ahead: 5, behind: 2, dirty: 7, is_repo: true },
  false,
);
dash.setWork([]);

const bar = document.createElement("div");
bar.style.cssText = "position:fixed;right:14px;bottom:14px;display:flex;gap:8px;";
for (const mode of ["sync", "pull", "push"] as const) {
  const button = document.createElement("button");
  button.textContent = `${mode} all`;
  button.style.cssText =
    "padding:8px 16px;border-radius:9px;border:1px solid var(--line);background:var(--bg-sunken);color:var(--ink);";
  button.addEventListener("click", () =>
    void openGitSweep(mode, {
      async fixWithAgent(prompt) {
        // eslint-disable-next-line no-console
        console.log("[dev] fix prompt:", prompt);
      },
    }),
  );
  bar.append(button);
}
document.body.append(bar);
