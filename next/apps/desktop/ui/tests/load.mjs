import { readFile } from "node:fs/promises";
import { transformWithOxc } from "vite";

/** Import a TypeScript module from src as JavaScript, with the modules it imports by relative
 *  path. Style sheets are dropped. */
export async function load(url) {
  const { code } = await transformWithOxc(await readFile(url, "utf8"), url.pathname);
  let out = code.replace(/^import\s+["'][^"']+\.css["'];?$/gm, "");
  for (const [whole, spec] of [...out.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)]) {
    const target = new URL(`${spec}.ts`, url);
    out = out.replace(whole, `from "${await load(target)}"`);
  }
  return `data:text/javascript;base64,${Buffer.from(out).toString("base64")}`;
}

export const src = async (path) => import(await load(new URL(`../src/${path}`, import.meta.url)));
