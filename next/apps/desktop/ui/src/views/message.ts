/**
 * `message` — an agent report as it reaches the human.
 *
 * The prose is NOT here any more. Panel files the written report to the appgea brain the moment
 * it arrives, and the companion is who reads it. What survives in the Inbox is the part a log
 * cannot carry: a headline you can scan, and media you have to look at, hear or open.
 *
 * That is the whole rule. Talking to an agent happens in its terminal. The Inbox is a place you
 * LOOK, so anything that is only words gets one line and no more.
 *
 * Media, in three deliberately different shapes:
 *   * images — a tile per shot, ratio taken from the picture itself, click for the lightbox.
 *   * audio  — an inline player, because a clip is short and hearing it is the review.
 *   * video  — a link, never a player. A clip long enough to matter deserves a real player with
 *     a scrubber, and an embedded one in a feed is a thing you accidentally start.
 */

import { invoke } from "@tauri-apps/api/core";
import { parsePlace, placeLabel } from "../deeplink";
import { projectAssetUrl, projectImage } from "../project-assets";
import type { Payload, ViewRenderer } from "../types";
import { arr, el, obj, str } from "./dom";
import { showLightbox, type LightboxShot } from "./lightbox";

const named = (value: unknown, fallbackKey: string): Payload => {
  if (typeof value === "string") return { [fallbackKey]: value };
  return obj(value);
};

const basename = (path: string): string => path.replaceAll("\\", "/").split("/").pop() || path;

/** The typed half of a report. Unknown values render nothing rather than an unstyled chip. */
const OUTCOMES = new Map([
  ["progress", "in progress"],
  ["done", "done"],
  ["blocked", "blocked"],
  ["needs_decision", "needs you"],
]);

/** The first real sentence. Headings, bullets and blank lines are structure, not the point. */
function headline(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[#>*-]+\s*/, "");
    if (line) return line;
  }
  return "";
}

export const messageView: ViewRenderer = (payload, ctx): HTMLElement => {
  const root = el("article", "v v-message");
  const project = str(payload._panel_project);

  const head = el("header", "v-head");
  const eyebrow = el("i", "v-eyebrow", "agent report");
  // Where the full text went. Not a button: the companion is how you read a report, and a door
  // to a file outside every project would be a second, worse way to do it.
  const note = str(payload._panel_note);
  if (note) eyebrow.title = `filed to ${note}`;
  head.append(eyebrow);
  head.append(el("h3", "v-title", str(payload.title, "Message")));
  const outcome = str(payload.outcome);
  if (OUTCOMES.has(outcome)) {
    head.append(el("span", `v-message-outcome is-${outcome}`, OUTCOMES.get(outcome)!));
  }
  root.append(head);

  // One line. The report is in the brain; this only has to tell you whether to care.
  const line = headline(str(payload.text, str(payload.report)));
  if (line) root.append(el("p", "v-message-line", line));

  /* ------------------------------------------------------------------ images */

  const images = arr(payload.images).map((item) => named(item, "path"));
  if (images.length && project) {
    const shots: LightboxShot[] = images
      .map((image) => ({ project, path: str(image.path), caption: str(image.caption) }))
      .filter((shot) => shot.path);
    const gallery = el("div", "v-message-gallery");
    shots.forEach((shot, index) => {
      const figure = el("figure", "v-message-image");
      const preview = projectImage(project, shot.path, shot.caption || basename(shot.path));
      preview.classList.add("is-expandable");
      preview.title = "Click to expand — then 100% to read it";
      // The tile takes the picture's own shape. A fixed 4:3 crop of a phone grab showed the
      // status bar and nothing else, which is why a wall of screenshots read as unreadable.
      preview.addEventListener("load", () => {
        const w = preview.naturalWidth;
        const h = preview.naturalHeight;
        if (!w || !h) return;
        const ratio = Math.min(Math.max(w / h, 0.62), 1.9);
        figure.style.setProperty("--shot-ar", String(ratio));
        figure.classList.toggle("is-tall", ratio < 0.95);
      });
      preview.addEventListener("click", () => showLightbox(shots, index));
      figure.append(preview);
      figure.append(el("figcaption", undefined, shot.caption || basename(shot.path)));
      gallery.append(figure);
    });
    if (gallery.childElementCount) root.append(gallery);
  }

  /* ------------------------------------------------------------------- audio */

  const clips = arr(payload.audio).map((item) => named(item, "path"));
  if (clips.length && project) {
    const rack = el("div", "v-message-audio");
    for (const clip of clips) {
      const path = str(clip.path);
      if (!path) continue;
      const row = el("div", "v-message-clip");
      row.append(el("span", "v-message-clip-name", str(clip.caption, basename(path))));
      const player = el("audio") as HTMLAudioElement;
      player.controls = true;
      player.preload = "metadata";
      player.src = projectAssetUrl(project, path);
      row.append(player);
      rack.append(row);
    }
    if (rack.childElementCount) root.append(rack);
  }

  /* ------------------------------------------------------------------- video */

  const films = arr(payload.video).map((item) => named(item, "path"));
  if (films.length) {
    const rack = el("div", "v-message-video");
    for (const film of films) {
      const url = str(film.url);
      const path = str(film.path);
      if (!url && !path) continue;
      const label = str(film.caption, url ? url : basename(path));
      const open = el("button", "v-message-film") as HTMLButtonElement;
      open.type = "button";
      open.title = url || path;
      open.append(el("i", "v-message-film-play", "▶"));
      open.append(el("span", "v-message-film-name", label));
      open.append(el("i", "v-message-film-hint", url ? "opens in browser" : "opens in player"));
      open.addEventListener("click", () => {
        if (url) void invoke("open_link", { url });
        else void invoke("open_media", { project, path });
      });
      rack.append(open);
    }
    if (rack.childElementCount) root.append(rack);
  }

  /* ------------------------------------------------------------- things to open */

  const attachments = arr(payload.attachments).map((item) => named(item, "path"));
  const links = arr(payload.links).map((item) => named(item, "url"));
  // Everything this report made you look at or hear. Its Review opens on exactly these.
  const media = project ? [...images, ...clips, ...films].map((item) => str(item.path)).filter(Boolean) : [];
  if (attachments.length || links.length || media.length) {
    const rail = el("div", "v-message-attachments");
    rail.append(el("i", "v-message-attachments-cap", "Open"));
    /** A door that names its own kind. `node` is a <button> or an <a>; only the label differs. */
    const notate = (node: HTMLElement, kind: string, name: string): HTMLElement => {
      node.className = "v-message-attachment";
      node.dataset.kind = kind;
      node.append(el("i", "v-message-attachment-kind", kind));
      node.append(el("span", "v-message-attachment-name", name));
      return node;
    };
    const door = (kind: string, name: string, title: string, go: () => void): HTMLElement => {
      const button = el("button", undefined) as HTMLButtonElement;
      button.type = "button";
      button.title = title;
      button.addEventListener("click", go);
      return notate(button, kind, name);
    };
    // Reviewing what was made is the usual reason to open a report, so it is the first door.
    if (media.length) {
      const reviewDoor = door("Review", media.length === 1 ? basename(media[0]) : `${media.length} files`,
        "Review what this report made", () => ctx.openPlace({ to: "review" }, media));
      reviewDoor.classList.add("is-primary");
      rail.append(reviewDoor);
    }
    for (const attachment of attachments) {
      const path = str(attachment.path);
      const folder = str(attachment.kind, "file") === "folder";
      const button = el("button", undefined) as HTMLButtonElement;
      button.type = "button";
      button.title = path;
      button.addEventListener("click", () => {
        if (folder) void invoke("open_project_folder", { project, path });
        else ctx.openRef(path);
      });
      rail.append(notate(button, folder ? "Folder" : "File", str(attachment.label, basename(path))));
    }
    for (const link of links) {
      const url = str(link.url);
      if (!url) continue;
      const place = parsePlace(url);
      if (place) {
        // A bare `review` says what the Review door above already does.
        if (place.to === "review" && !place.path && media.length) continue;
        const { kind, name } = placeLabel(place);
        rail.append(door(kind, str(link.label, name), url, () => ctx.openPlace(place, media)));
        continue;
      }
      if (!/^https?:\/\//i.test(url)) {
        // Not a web page and not a Panel place: say so instead of a door that does nothing.
        const dead = notate(el("span", undefined), "Link", str(link.label, url));
        dead.classList.add("is-dead");
        dead.title = `${url}: not a web link or a Panel place (panel:review, panel:work:<path>, panel:git, panel:manager)`;
        rail.append(dead);
        continue;
      }
      const anchor = el("a", undefined) as HTMLAnchorElement;
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      anchor.title = url;
      let host = url;
      try {
        host = new URL(url).hostname || url;
      } catch {
        // Not a parseable URL — the raw string is still the most honest label available.
      }
      rail.append(notate(anchor, "Link", str(link.label, host)));
    }
    root.append(rail);
  }

  return root;
};
