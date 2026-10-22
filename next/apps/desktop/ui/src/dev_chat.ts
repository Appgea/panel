/**
 * Dev harness for the chat rail and Home's activity strip. NOT part of the app build — index.html
 * never loads this. It mounts the REAL modules (mountChat, mountHome) against fixture data and
 * stubbed events, so the shell's three-column layout, the rail at its true width and the strip can
 * be looked at without Tauri. No IO, no invoke, no live data.
 */
import "./style.css";
// Side-effect import: this is what fills the view registry. Without it every post renders as
// the raw-payload fallback.
import "./views";
import { mountChat, type ChatPost } from "./features/chat";
import { mountHome, type HomeActivity, type HomeProject } from "./features/home";
import { renderView } from "./registry";
import type { RenderCtx } from "./types";

const CTX: RenderCtx = {
  openRef: () => {},
  openDocument: async () => {},
  finishDocument: async () => "",
};

const ago = (minutes: number): number => Date.now() - minutes * 60_000;

const POSTS: ChatPost[] = [
  {
    id: "p1",
    project: "kelimelik",
    projectName: "Kelimelik",
    author: "claude 1",
    agentKind: "claude",
    session: "s1",
    flowFiles: ["lib/game/board.dart", "lib/game/scoring.dart"],
    flowSteps: [],
    at: ago(96),
    payload: {
      title: "Board no longer re-lays out on every tile drop",
      text: "The board rebuilt its whole grid on each drag update, which is why the drop felt sticky on older phones.\n\nMoved the tile layer into its own `RepaintBoundary` and switched the drag target to a `ValueNotifier`, so a drop repaints one cell instead of 225.",
      outcome: "done",
    },
  },
  {
    id: "p2",
    project: "kelimelik",
    projectName: "Kelimelik",
    author: "claude 1",
    agentKind: "claude",
    session: "s1",
    flowFiles: ["lib/game/scoring.dart"],
    flowSteps: [],
    at: ago(41),
    payload: {
      title: "Scoring: double-letter under a double-word was counted twice",
      text: "The multiplier stack applied the letter bonus after the word bonus had already scaled the tile. Order is fixed and the test now covers all four bonus squares.",
      outcome: "done",
    },
  },
  {
    id: "p-preview",
    project: "kelimelik",
    projectName: "Kelimelik",
    author: "claude 1",
    agentKind: "claude",
    session: "s1",
    flowFiles: [],
    flowSteps: [],
    at: ago(24),
    view: "showcase",
    payload: {
      title: "New game flow",
      shots: [
        { title: "Board", caption: "The board keeps the active turn in view.", color: "#6255d9" },
        { title: "Score", caption: "Scoring feedback appears beside the move.", color: "#287d9a" },
        { title: "Result", caption: "The result closes the loop without a new screen.", color: "#357a56" },
      ],
    },
  },
  {
    id: "p3",
    project: "harbor",
    projectName: "Harbor",
    author: "codex 2",
    agentKind: "codex",
    session: "s2",
    flowFiles: [],
    flowSteps: [],
    at: ago(12),
    payload: {
      title: "Release status now reads the build number from App Store Connect",
      text: "The local plist is written at archive time, so anything uploaded from CI drifted the moment the build left this machine. `release.py status` reads the remote number instead.",
      outcome: "needs review",
    },
  },
];

const PROJECTS = [
  { id: "kelimelik", name: "Kelimelik" },
  { id: "harbor", name: "Harbor" },
  { id: "sayi-avi", name: "Sayı Avı" },
];

const HOME_PROJECTS: HomeProject[] = PROJECTS.map((p, index) => ({
  id: p.id,
  name: p.name,
  path: `/Users/example/projects/${p.id}`,
  exists: true,
  group: "",
  running: index === 0,
  status: index === 0 ? "working" : "idle",
  detail: index === 0 ? "editing lib/game/scoring.dart" : "no agent running",
  sessions: [],
  attention: index === 1 ? "needs" : index === 2 ? "done" : null,
}));

const home = mountHome(document.getElementById("homeScreen")!, {
  openProject: () => {},
  isExited: () => false,
  projectGit: async () => ({ is_repo: true, branch: "main", dirty: 2 }) as never,
  openPost: (id) => chat.reveal(id),
  installed: () => false,
});

const chat = mountChat(document.getElementById("chatRail")!, {
  render: (post, openRef) => renderView(post.view ?? "message", post.payload, { ...CTX, openRef }),
  openRuns: () => {},
  openSession: () => {},
  isLiveSession: (session) => session === "s1" || session === "s2",
  visibility: () => {
    for (const [id, section] of [["chatButton", "reports"], ["cpoButton", "manager"]] as const) {
      const button = document.getElementById(id)!;
      const on = chat.currentSection() === section;
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", String(on));
    }
  },
  unread: (total) => {
    const badge = document.getElementById("chatBadge")!;
    badge.textContent = String(total);
    badge.hidden = total === 0;
  },
  unreadByProject: (counts) => home.unread(counts),
  archive: (posts) =>
    home.activity(
      posts.map(
        (post): HomeActivity => ({
          id: post.id,
          project: post.project,
          projectName: post.projectName,
          author: post.author,
          agentKind: post.agentKind,
          title: String(post.payload.title ?? "Report"),
          at: post.at,
        }),
      ),
    ),
  changes: async () => [],
  readFile: async () => "",
  renderFlow: () => null,
  openRef: () => {},
}, {
  // No PTY without Tauri, so Manager stays on its start card. Everything else about the
  // pane — the preprompt editor, the engine picker — is real and can be looked at.
  start: async () => { throw new Error("no terminal in the dev harness"); },
  current: () => null,
  lend: () => {},
  unlend: () => {},
  openChanges: () => {},
  stop: async () => {},
  write: async () => {},
  preprompt: async () => "# You are the appgea manager\n\nEdit me.\n",
  savePreprompt: async () => {},
  resetPreprompt: async () => "# You are the appgea manager\n\nEdit me.\n",
});

home.open(HOME_PROJECTS);
document.getElementById("chatButton")!.addEventListener("click", () => chat.show("reports"));
document.getElementById("cpoButton")!.addEventListener("click", () => chat.showCpo());
// Chat boots down in the app — a screen you did not ask for is a bad greeting. Here it IS the
// harness, so it opens itself.
chat.show();
for (const post of POSTS) chat.add(post);

// Reach them from the console while poking at layout.
Object.assign(window as unknown as Record<string, unknown>, { chat, home });
