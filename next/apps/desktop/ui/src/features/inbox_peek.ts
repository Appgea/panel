/**
 * The evidence box — what happened, shown inside the post that reported it.
 *
 * A deeplink used to mean "leave". You tapped a screenshot, a file, a Play flow button, and the
 * app threw you into another project, another tab, another screen you then had to walk back from.
 * For reading an agent's report that is the wrong trade: you are not going there to work, you are
 * going there to LOOK. So every reference a post carries resolves here instead — the edit replay,
 * a file at the line the agent named, a screenshot at full size — in a box under the post, and
 * the trip into the real surface stays available as one explicit ↗.
 *
 * The replay is the same theater the Files tab uses (`rr-overlay` is absolute, so it fills our
 * stage instead of the window). Nothing here writes anything.
 */

import { projectImage } from "../project-assets";
import type { ChangeStep } from "../types";
import { showLightbox } from "../views/lightbox";
import type { InboxPost } from "./inbox_feed";
import { mountRobotReplay } from "./robot_replay";

export type PeekDeps = {
  /** Every edit Panel recorded for one file (before/after per tool call). */
  changes(project: string, path: string): Promise<ChangeStep[]>;
  /** Current contents, for looking at a line nobody edited. */
  readFile(project: string, path: string): Promise<string>;
  /** The agent's own walkthrough, rendered by the view registry with its refs pointed back here. */
  flow(post: InboxPost, openRef: (ref: string) => void): HTMLElement | null;
  /** The one door out: the real editor, in the real project. */
  openRef(project: string, ref: string): void;
  /** Oldest edit that belongs to this post's turn — anything earlier is a previous report's work. */
  since(post: InboxPost): number;
};

export type PeekHandle = {
  root: HTMLElement;
  /** The post's own button: open the box on what happened, or close it. */
  toggle(): void;
  /** A reference clicked anywhere in the post body — resolve it INSIDE the box. */
  showRef(ref: string): void;
  isOpen(): boolean;
};

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|heic)$/i;
const base = (path: string): string => path.replaceAll("\\", "/").split("/").pop() || path;

/** A ref is `path` or `path:line`. Anything with a scheme is a link, not a file. */
const parseRef = (ref: string): { path: string; line: number | null } => {
  const match = /^(.*?)(?::(\d+))?$/.exec(ref.trim());
  return { path: match?.[1] ?? ref.trim(), line: match?.[2] ? Number(match[2]) : null };
};

const make = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const chip = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
  const button = make("button", "inbox-peek-door", label) as HTMLButtonElement;
  button.type = "button";
  button.title = title;
  button.addEventListener("click", () => onClick());
  return button;
};

/** Lines around the one that was named, so a ref reads as a place in a file rather than a path. */
const snippet = (text: string, line: number | null): HTMLElement => {
  const lines = text.split("\n");
  const target = line && line >= 1 && line <= lines.length ? line : null;
  const from = target ? Math.max(1, target - 8) : 1;
  const to = target ? Math.min(lines.length, target + 12) : Math.min(lines.length, 40);
  const code = make("div", "inbox-peek-code");
  for (let at = from; at <= to; at += 1) {
    const row = make("div", `inbox-peek-line${at === target ? " is-hit" : ""}`);
    row.append(make("i", undefined, String(at)), make("code", undefined, lines[at - 1] ?? ""));
    code.append(row);
  }
  return code;
};

export function buildPeek(post: InboxPost, deps: PeekDeps): PeekHandle {
  const root = make("section", "inbox-peek");
  root.hidden = true;
  const doors = make("nav", "inbox-peek-doors");
  const stage = make("div", "inbox-peek-stage");
  root.append(doors, stage);

  /** What the ↗ opens right now — it follows whatever the stage is showing, so the escape hatch
   *  is never a guess about which file you meant. */
  let current = post.flowFiles[0] ?? "";
  let built = false;

  /** True only while a show we started is running, so the theater closing itself at the end
   *  leaves a note, while us closing it to show something else stays silent. */
  let performing = false;

  // mountRobotReplay appends its own root into the stage.
  const replay = mountRobotReplay(stage, {
    open: (path) => deps.openRef(post.project, path),
    onDone: () => {
      if (!performing) return;
      performing = false;
      note("That was every recorded edit. Pick a file above to watch it again.");
    },
  });

  const clearStage = (): void => {
    performing = false;
    replay.close();
    for (const child of [...stage.children]) if (child !== replay.root) child.remove();
  };

  const note = (text: string): void => {
    clearStage();
    stage.append(make("p", "inbox-peek-note", text));
  };

  const markDoor = (key: string): void => {
    for (const door of doors.querySelectorAll<HTMLElement>(".inbox-peek-door")) {
      door.classList.toggle("is-on", door.dataset.key === key);
    }
  };

  /* --------------------------------------------------------------- stages */

  /** Perform the edits Panel recorded for these files during THIS post's turn. */
  const showEdits = async (paths: string[], key: string): Promise<void> => {
    markDoor(key);
    current = paths[0] ?? current;
    clearStage();
    stage.append(make("p", "inbox-peek-note", "Loading the recorded edits…"));
    const from = deps.since(post);
    const to = post.at + 2_000; // the report is written at the end of a turn, not the microsecond
    const shows = await Promise.all(
      paths.map(async (path) => {
        try {
          const steps = await deps.changes(post.project, path);
          return { path, steps: steps.filter((step) => step.at_ms > from && step.at_ms <= to) };
        } catch {
          return { path, steps: [] as ChangeStep[] };
        }
      }),
    );
    const playable = shows.filter((show) => show.steps.length);
    if (!playable.length) {
      // A write with no captured text (binary, a new file, a tool Panel did not see) still has
      // a file worth looking at — so fall through to reading it rather than saying nothing.
      if (paths.length === 1) {
        await showFile(paths[0], null, key);
        return;
      }
      note("No replayable text edit was recorded for these files.");
      return;
    }
    clearStage();
    replay.play(playable);
    performing = true;
  };

  const showFile = async (path: string, line: number | null, key: string): Promise<void> => {
    markDoor(key);
    current = line ? `${path}:${line}` : path;
    clearStage();
    stage.append(make("p", "inbox-peek-note", `Reading ${base(path)}…`));
    try {
      const text = await deps.readFile(post.project, path);
      clearStage();
      const head = make("div", "inbox-peek-filehead");
      head.append(make("b", undefined, base(path)), make("small", undefined, line ? `line ${line}` : path));
      stage.append(head, snippet(text, line));
    } catch (error) {
      note(`Could not read ${path} — ${String(error)}`);
    }
  };

  const showImage = (path: string, key: string): void => {
    markDoor(key);
    current = path;
    clearStage();
    const figure = make("figure", "inbox-peek-image");
    const image = projectImage(post.project, path, base(path));
    image.classList.add("is-expandable");
    image.title = "Tap to expand";
    image.addEventListener("click", () =>
      showLightbox([{ project: post.project, path, caption: base(path) }]),
    );
    figure.append(image, make("figcaption", undefined, path));
    stage.append(figure);
  };

  const showFlow = (key: string): void => {
    markDoor(key);
    clearStage();
    const rendered = deps.flow(post, (ref) => showRef(ref));
    stage.append(rendered ?? make("p", "inbox-peek-note", "No walkthrough was attached."));
  };

  /* ---------------------------------------------------------------- doors */

  const buildDoors = (): void => {
    doors.replaceChildren();
    if (post.flowFiles.length) {
      const all = chip(
        `Replay ${post.flowFiles.length} file${post.flowFiles.length === 1 ? "" : "s"}`,
        "Watch the edits happen, here",
        () => void showEdits(post.flowFiles, "edits"),
      );
      all.dataset.key = "edits";
      doors.append(all);
      // Past a handful the row becomes the noise it was meant to remove; the replay covers the rest.
      for (const path of post.flowFiles.slice(0, 6)) {
        const one = chip(base(path), path, () => void showEdits([path], `file:${path}`));
        one.dataset.key = `file:${path}`;
        doors.append(one);
      }
    }
    if (post.flowSteps.length) {
      const walk = chip(`Walkthrough · ${post.flowSteps.length}`, "The agent's own trace", () =>
        showFlow("flow"),
      );
      walk.dataset.key = "flow";
      doors.append(walk);
    }
    const out = chip("Open ↗", "Leave the inbox and open this in the editor", () => {
      if (current) deps.openRef(post.project, current);
    });
    out.classList.add("is-out");
    doors.append(out);
  };

  /* --------------------------------------------------------------- public */

  const showRef = (ref: string): void => {
    root.hidden = false;
    if (!built) {
      buildDoors();
      built = true;
    }
    const { path, line } = parseRef(ref);
    if (IMAGE.test(path)) {
      showImage(path, `ref:${ref}`);
      return;
    }
    void showFile(path, line, `ref:${ref}`);
    root.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  return {
    root,
    toggle() {
      if (!root.hidden) {
        replay.close();
        root.hidden = true;
        return;
      }
      root.hidden = false;
      if (!built) {
        buildDoors();
        built = true;
      }
      if (post.flowFiles.length) void showEdits(post.flowFiles, "edits");
      else if (post.flowSteps.length) showFlow("flow");
      else note("Nothing was captured for this post.");
      root.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    showRef,
    isOpen: () => !root.hidden,
  };
}
