import fs from 'fs';
import path from 'path';
import * as promptsIndex from '../src/prompts';

const PROMPTS_DIR = path.join(__dirname, '..', 'src', 'prompts');
const SRC_DIR = path.join(__dirname, '..', 'src');

/**
 * ADR-0030: one file per individual prompt under prompts/*.ts, with a single
 * index.ts re-export as the only import surface other engine code uses. These
 * two checks are the acceptance criteria's structural guarantees, enforced
 * mechanically so a future prompt addition can't silently bypass the layout.
 */
function promptFiles(): string[] {
  return fs.readdirSync(PROMPTS_DIR).filter((file) => file.endsWith('.ts') && file !== 'index.ts');
}

describe('prompts/index.ts', () => {
  it('re-exports every prompt module under prompts/', () => {
    const files = promptFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path.join(PROMPTS_DIR, file));
      const exportNames = Object.keys(mod);
      expect(exportNames.length).toBeGreaterThan(0);

      for (const name of exportNames) {
        expect(promptsIndex).toHaveProperty(name);
        expect((promptsIndex as Record<string, unknown>)[name]).toBe(mod[name]);
      }
    }
  });
});

describe('prompts/*.ts import surface', () => {
  it('is never imported directly from outside prompts/index.ts', () => {
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (fullPath === PROMPTS_DIR) continue;
          walk(fullPath);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;

        const content = fs.readFileSync(fullPath, 'utf8');
        // Matches a relative import ending in /prompts/<file> (not /prompts or /prompts/index).
        const directImport = /from\s+['"][^'"]*\/prompts\/(?!index['"])[^'"]+['"]/g;
        if (directImport.test(content)) {
          offenders.push(path.relative(SRC_DIR, fullPath));
        }
      }
    };

    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});
