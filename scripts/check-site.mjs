import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
const root = resolve('dist'); const failures = []; let pages = 0;
async function walk(path) {
  for (const item of await readdir(path, { withFileTypes: true })) {
    const target = join(path, item.name);
    if (item.isDirectory()) await walk(target);
    else if (extname(target) === '.html') {
      pages++; const html = await readFile(target, 'utf8');
      if (!/<title>[^<]+Foggy Layers<\/title>/.test(html)) failures.push(`${target}: missing title`);
      if (!/name="description"/.test(html)) failures.push(`${target}: missing description`);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
      if (ids.length !== new Set(ids).size) failures.push(`${target}: duplicate IDs`);
      for (const match of html.matchAll(/\s(?:src|href)="(\/[^"#]*)"/g)) {
        const route = match[1].split(/[?#]/)[0]; if (!route || route.startsWith('//') || route.startsWith('/api/')) continue;
        const file = join(root, decodeURIComponent(route));
        try { const info = await stat(file); if (info.isDirectory()) await stat(join(file, 'index.html')); }
        catch { failures.push(`${target}: missing local target ${route}`); }
      }
    }
  }
}
await walk(root);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`Checked ${pages} pages: titles, descriptions, duplicate IDs, local links, scripts, and image targets passed.`);
