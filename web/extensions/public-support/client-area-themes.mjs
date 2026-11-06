// Client area themes: a theme is a stylesheet at themes/<id>.css in one of the
// site folders (the brand's, a plugin's or web/public), so a plugin ships a
// client's look as a file. The owner picks one per area (client-areas.mjs) and
// the screen loads it after its own style for the assistant on screen: it
// overrides the CSS variables in :root of public-support.html (colors, fonts,
// radii, shadow) and may add rules of its own. No theme = the default look.
import fs from 'node:fs';
import path from 'node:path';
import { siteFolders } from '../../brand.mjs';

export const THEMES_DIR = 'themes';
// Also what keeps the id safe to put in the stylesheet's address.
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

// The ids found now, sorted; read on every call, so a theme added to a folder
// shows up without a restart.
export function listThemes(folders = siteFolders()) {
  const ids = new Set();
  for (const dir of folders) {
    let names;
    try { names = fs.readdirSync(path.join(dir, THEMES_DIR)); } catch { continue; }
    for (const name of names) {
      const id = name.endsWith('.css') ? name.slice(0, -4) : '';
      if (THEME_ID.test(id)) ids.add(id);
    }
  }
  return [...ids].sort();
}
