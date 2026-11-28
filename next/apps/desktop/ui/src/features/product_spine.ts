import { schemeOrigin } from "../project-assets";

export type ProductSpineHandle = {
  setProject(projectId: string, path: string): void;
};

export function mountProductSpine(host: HTMLElement): ProductSpineHandle {
  host.className = "pane product-spine-pane extension-pane";
  const frame = document.createElement("iframe");
  frame.className = "extension-frame";
  frame.title = "Product Spine";
  host.replaceChildren(frame);
  let projectPath = "";

  return {
    setProject(_projectId, path) {
      if (path === projectPath) return;
      projectPath = path;
      frame.src = `${schemeOrigin("module")}/m/product-spine/tree?root=${encodeURIComponent(path)}&panel_refresh=${Date.now()}`;
    },
  };
}
