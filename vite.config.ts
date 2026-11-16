import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const FRAMING_FILE = fileURLToPath(new URL('./src/landscape/camera/framing.json', import.meta.url));
const LAYOUT_FILE = fileURLToPath(new URL('./src/landscape/layout.json', import.meta.url));

/**
 * Dev server only: POST /__dev/save with { camera?, layout? } saves the
 * camera's resting framing (src/landscape/camera/framing.json) and/or where
 * the props stand (src/landscape/layout.json), making them the defaults.
 * Used by the in-page dev editors (src/dev/devTools.ts); Vite then reloads the
 * page with them. Only those two files, only numbers (and booleans in the
 * layout), only props that layout.json already has.
 */
function devSaveEndpoint(): Plugin {
  const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const isVec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(isNum);
  const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
  const list = (v: number[]) => `[${v.map((n) => round(n, 2)).join(', ')}]`;

  function framingJson(camera: unknown) {
    const { position, target } = (camera ?? {}) as { position?: unknown; target?: unknown };
    if (!isVec3(position) || !isVec3(target)) throw new Error('camera: expected { position: [x, y, z], target: [x, y, z] }');
    return `{\n  "position": ${list(position)},\n  "target": ${list(target)}\n}\n`;
  }

  function layoutJson(layout: unknown) {
    if (typeof layout !== 'object' || layout === null) throw new Error('layout: expected an object');
    const current = JSON.parse(readFileSync(LAYOUT_FILE, 'utf8')) as Record<string, Record<string, unknown>>;
    for (const [name, entry] of Object.entries(layout)) {
      if (!(name in current)) throw new Error(`layout: unknown prop "${name}"`);
      if (typeof entry !== 'object' || entry === null) throw new Error(`layout.${name}: expected an object`);
      for (const [key, value] of Object.entries(entry)) {
        if (!(key in current[name])) throw new Error(`layout.${name}: unknown field "${key}"`);
        if (!isNum(value) && typeof value !== 'boolean') throw new Error(`layout.${name}.${key}: expected a number`);
        current[name][key] = isNum(value) ? round(value, 4) : value;
      }
    }
    // One prop per line, like the hand-written file.
    const lines = Object.entries(current).map(([name, entry]) => {
      const fields = Object.entries(entry).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ');
      return `  "${name}": { ${fields} }`;
    });
    return `{\n${lines.join(',\n')}\n}\n`;
  }

  return {
    name: 'dev-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const { camera, layout } = JSON.parse(body) as { camera?: unknown; layout?: unknown };
            // Check everything before writing anything.
            const framing = camera === undefined ? null : framingJson(camera);
            const props = layout === undefined ? null : layoutJson(layout);
            if (props) writeFileSync(LAYOUT_FILE, props);
            if (framing) writeFileSync(FRAMING_FILE, framing);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.statusCode = 400;
            res.end(err instanceof Error ? err.message : String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [devSaveEndpoint()],
});
