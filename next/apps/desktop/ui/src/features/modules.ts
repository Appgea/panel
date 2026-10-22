/**
 * The panel between the Panel modules and a desktop app with no web server.
 *
 * Module front-end assets were written for a page served by Python. They fetch `/m/*` against a
 * relative URL and expect a JSON body back.
 *
 * There is no server any more. Rather than patch the module — which would fork the very design
 * we are restoring — we make the world it expects true: `/m/*` fetches are routed to the Rust
 * one-shot invoker, and the module runs byte-for-byte unmodified.
 *
 * Everything here is loopback-in-process. Nothing listens on a port.
 */

import { invoke } from "@tauri-apps/api/core";
import { schemeOrigin } from "../project-assets";

declare global {
  interface Window {
    GitManager?: {
      renderGraph(mount: HTMLElement, graph: unknown, opts: unknown): void;
      renderPanel?(el: HTMLElement, data: unknown, event: unknown): void;
    };
    /** git-manager's node popover uses the host page's diff viewer when it has one. */
    showDiff?(title: string, patch: string): void;
  }
}

/** A JSON call into a module. Rejects on module error; modules speak `{error}` on failure. */
export async function moduleGet<T = unknown>(path: string): Promise<T> {
  return invoke<T>("module_request", { path });
}

export async function modulePost<T = unknown>(path: string, body: unknown): Promise<T> {
  return invoke<T>("module_request", {
    path,
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

let shimmed = false;

/**
 * Route `/m/*` through the invoker, leave every other fetch alone.
 *
 * The modules' `jget`/`jpost` only ever call `.json()` on the result, but returning a real
 * `Response` keeps the shim honest for anything that inspects it. A module error becomes a
 * 200 carrying `{error}` — which is exactly the shape the module code already branches on,
 * so its own error paths (the calm "git unavailable" state) still fire.
 */
function installFetchShim(): void {
  if (shimmed) return;
  shimmed = true;

  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("/m/")) return original(input as RequestInfo, init);

    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    let payload: unknown;
    try {
      payload = await invoke("module_request", { path: url, method, body });
    } catch (error) {
      payload = { error: String(error) };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const loaded = new Map<string, Promise<void>>();

/**
 * Load a module's chat assets into the page, once.
 *
 * They come off the `module://` scheme rather than being inlined, so the browser treats them
 * as ordinary script/style — no `unsafe-inline`, no eval.
 */
export function loadModuleAssets(name: string): Promise<void> {
  installFetchShim();

  const existing = loaded.get(name);
  if (existing) return existing;

  const pending = new Promise<void>((resolve, reject) => {
    const base = `${schemeOrigin("module")}/m/${name}/assets`;

    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${base}/chat.css`;
    document.head.append(css);

    const js = document.createElement("script");
    js.src = `${base}/chat.js`;
    js.addEventListener("load", () => resolve());
    js.addEventListener("error", () =>
      reject(new Error(`could not load the ${name} module assets`)),
    );
    document.head.append(js);
  });

  loaded.set(name, pending);
  return pending;
}
