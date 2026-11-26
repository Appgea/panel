/**
 * First-use lifecycle for project tools.
 *
 * These screens are shared across projects and comparatively expensive. Keeping their imports
 * here makes the application spine depend on a small lifecycle API instead of every tool module,
 * and ensures concurrent requests still mount only one instance.
 */

import type { FilesHandle } from "./files";
import type { GitHandle, GitTurn, GitProject } from "./git";
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
  release: HTMLElement;
  revenuecat: HTMLElement;
  analytics: HTMLElement;
};

type ToolEvents = {
  current(): CurrentProject | null;
  /** The selected project's agent turns, most recent first — the Git tab's unit of work. */
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
  ensureRelease(): Promise<ReleaseHandle>;
  ensureRevenueCat(): Promise<RevenueCatHandle>;
  ensureAnalytics(): Promise<AnalyticsHandle>;
};

export function createProjectTools(hosts: ToolHosts, events: ToolEvents): ProjectTools {
  let files: FilesHandle | undefined;
  let git: GitHandle | undefined;
  let debuggerTool: DebuggerHandle | undefined;
  let release: ReleaseHandle | undefined;
  let revenuecat: RevenueCatHandle | undefined;
  let analytics: AnalyticsHandle | undefined;

  let filesPromise: Promise<FilesHandle> | undefined;
  let gitPromise: Promise<GitHandle> | undefined;
  let debuggerPromise: Promise<DebuggerHandle> | undefined;
  let releasePromise: Promise<ReleaseHandle> | undefined;
  let revenuecatPromise: Promise<RevenueCatHandle> | undefined;
  let analyticsPromise: Promise<AnalyticsHandle> | undefined;

  /* Work's debug bar drives the same debugger the Debug tab does, and it may press Start before
     that tab has ever been opened — so this is the loader both entry points share. */
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
