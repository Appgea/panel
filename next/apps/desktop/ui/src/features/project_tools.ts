
import type { FilesHandle } from "./files";
import type { GitHandle, GitTurn, GitProject } from "./git";
import type { ProductSpineHandle } from "./product_spine";
import type { ReleaseHandle } from "./release";
import type { RevenueCatHandle } from "./revenuecat";
import type { AnalyticsHandle } from "./analytics";
import type { DebuggerHandle } from "./debugger";

type CurrentProject = {
  id: string;
  path: string;
};

type ToolHosts = {
  files: HTMLElement;
  debugger: HTMLElement;
  git: HTMLElement;
  productSpine: HTMLElement;
  release: HTMLElement;
  revenuecat: HTMLElement;
  analytics: HTMLElement;
};

type ToolEvents = {
  current(): CurrentProject | null;
  turns(projectId?: string): GitTurn[];
  runWithAgent(prompt: string): Promise<void>;
  gitProjects(): GitProject[];
  openGitProject(id: string): void;
  openProject(path: string, tab?: "git"): void;
  openRef(path: string, line: number): void;
};

export type ProjectTools = {
  readonly files: FilesHandle | undefined;
  readonly git: GitHandle | undefined;
  readonly debugger: DebuggerHandle | undefined;
  ensureFiles(): Promise<FilesHandle>;
  ensureDebugger(): Promise<DebuggerHandle>;
  ensureGit(): Promise<GitHandle>;
  ensureProductSpine(): Promise<ProductSpineHandle>;
  ensureRelease(): Promise<ReleaseHandle>;
  ensureRevenueCat(): Promise<RevenueCatHandle>;
  ensureAnalytics(): Promise<AnalyticsHandle>;
};

export function createProjectTools(hosts: ToolHosts, events: ToolEvents): ProjectTools {
  let files: FilesHandle | undefined;
  let git: GitHandle | undefined;
  let debuggerTool: DebuggerHandle | undefined;
  let productSpine: ProductSpineHandle | undefined;
  let release: ReleaseHandle | undefined;
  let revenuecat: RevenueCatHandle | undefined;
  let analytics: AnalyticsHandle | undefined;

  let filesPromise: Promise<FilesHandle> | undefined;
  let gitPromise: Promise<GitHandle> | undefined;
  let debuggerPromise: Promise<DebuggerHandle> | undefined;
  let productSpinePromise: Promise<ProductSpineHandle> | undefined;
  let releasePromise: Promise<ReleaseHandle> | undefined;
  let revenuecatPromise: Promise<RevenueCatHandle> | undefined;
  let analyticsPromise: Promise<AnalyticsHandle> | undefined;

  const loadDebugger = async (): Promise<DebuggerHandle> => {
    debuggerPromise ??= import("./debugger").then(({ mountDebugger }) => {
      debuggerTool = mountDebugger(hosts.debugger, { open: events.openRef });
      return debuggerTool;
    });
    return debuggerTool ?? debuggerPromise;
  };

  return {
    get files() {
      return files;
    },
    get git() {
      return git;
    },
    get debugger() {
      return debuggerTool;
    },
    async ensureFiles() {
      filesPromise ??= import("./files").then(({ mountFiles }) => {
        const handle = mountFiles(hosts.files, {
          startDebug: () => {
            const current = events.current();
            if (!current) return;
            void loadDebugger().then(async (tool) => {
              await tool.setProject(current.id, current.path);
              tool.start();
            });
          },
          debugCommand: (command) => void loadDebugger().then((tool) => tool.command(command)),
          evaluate: (expression) =>
            loadDebugger().then((tool) => tool.evaluate(expression)),
        });
        const current = events.current();
        if (current) handle.setProject(current.id, current.path);
        files = handle;
        return handle;
      });
      return files ?? filesPromise;
    },
    async ensureDebugger() {
      return loadDebugger();
    },
    async ensureGit() {
      gitPromise ??= import("./git").then(({ mountGit }) => {
        git = mountGit(hosts.git, {
          commitAllWithAgent: events.runWithAgent,
          turns: events.turns,
          projects: events.gitProjects,
          selectProject: events.openGitProject,
          openProject: (path) => events.openProject(path, "git"),
        });
        return git;
      });
      return git ?? gitPromise;
    },
    async ensureProductSpine() {
      productSpinePromise ??= import("./product_spine").then(({ mountProductSpine }) => {
        productSpine = mountProductSpine(hosts.productSpine);
        return productSpine;
      });
      return productSpine ?? productSpinePromise;
    },
    async ensureRelease() {
      releasePromise ??= import("./release").then(({ mountRelease }) => {
        release = mountRelease(hosts.release, {
          onOpenProject: (path) => events.openProject(path),
        });
        return release;
      });
      return release ?? releasePromise;
    },
    async ensureRevenueCat() {
      revenuecatPromise ??= import("./revenuecat").then(({ mountRevenueCat }) => {
        revenuecat = mountRevenueCat(hosts.revenuecat);
        return revenuecat;
      });
      return revenuecat ?? revenuecatPromise;
    },
    async ensureAnalytics() {
      analyticsPromise ??= import("./analytics").then(({ mountAnalytics }) => {
        analytics = mountAnalytics(hosts.analytics);
        return analytics;
      });
      return analytics ?? analyticsPromise;
    },
  };
}
