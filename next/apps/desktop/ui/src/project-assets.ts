import { convertFileSrc } from "@tauri-apps/api/core";

/** Media knowledge shared by every surface that renders files from an open project. */
export type ProjectMediaKind = "image" | "audio" | "video" | "pdf";

/**
 * Where a Panel scheme (`project-icon`, `project-asset`, `module`) is served from. macOS serves
 * `project-icon://panel/…` as written; the Windows webview only reaches a custom scheme as
 * `http://project-icon.localhost/…`. Tauri knows which form this webview speaks. Browser
 * previews and partial IPC mocks have no Tauri to ask, so they keep the native form.
 */
export function schemeOrigin(scheme: string): string {
  const internals = (window as Window & {
    __TAURI_INTERNALS__?: { convertFileSrc?: unknown };
  }).__TAURI_INTERNALS__;
  if (typeof internals?.convertFileSrc === "function") {
    const base = convertFileSrc("", scheme);
    if (/^https?:/.test(base)) return base.replace(/\/$/, "");
  }
  return `${scheme}://panel`;
}

/** The app icon of one project, from `project-icon`. */
export function projectIconUrl(projectId: string): string {
  return `${schemeOrigin("project-icon")}/${encodeURIComponent(projectId)}`;
}

const MEDIA_EXTENSIONS: Record<ProjectMediaKind, ReadonlySet<string>> = {
  image: new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]),
  audio: new Set(["mp3", "ogg", "oga", "wav", "m4a", "aac", "flac"]),
  video: new Set(["mp4", "m4v", "mov", "webm"]),
  pdf: new Set(["pdf"]),
};

export function fileExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLocaleLowerCase();
}

export function projectMediaKind(path: string): ProjectMediaKind | null {
  const extension = fileExtension(path);
  for (const [kind, extensions] of Object.entries(MEDIA_EXTENSIONS)) {
    if (extensions.has(extension)) return kind as ProjectMediaKind;
  }
  return null;
}

export function isImagePath(path: string): boolean {
  return projectMediaKind(path) === "image";
}

/**
 * An `<img>` for a path an agent reported.
 *
 * Two things go wrong with agent screenshots, and a bare `<img>` handles neither. The file can
 * land a beat AFTER the report that announces it — so one retry. And when it truly isn't there,
 * the browser draws a broken-image glyph that tells you nothing — so the element replaces itself
 * with the path that failed, which is the only fact worth having.
 */
export function projectImage(projectId: string, path: string, alt: string): HTMLImageElement {
  const image = document.createElement("img");
  image.src = projectAssetUrl(projectId, path);
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  let retried = false;
  image.addEventListener("error", () => {
    if (!retried) {
      retried = true;
      // The query is ignored by the protocol handler; it only defeats the webview's cache.
      window.setTimeout(() => {
        image.src = `${projectAssetUrl(projectId, path)}?retry=1`;
      }, 1200);
      return;
    }
    const card = document.createElement("div");
    card.className = "asset-missing";
    card.title = path;
    const label = document.createElement("b");
    label.textContent = "image not found";
    const where = document.createElement("code");
    where.textContent = path;
    card.append(label, where);
    image.replaceWith(card);
  });
  return image;
}

/** A read-only URL confined by the desktop protocol to the registered project root. */
export function projectAssetUrl(projectId: string, path: string): string {
  const encoded = [projectId, ...path.replaceAll("\\", "/").split("/")]
    .map(encodeURIComponent)
    .join("/");
  return `${schemeOrigin("project-asset")}/${encoded}`;
}
