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
  // Matches a relative reference ending in /prompts/<file> (not /prompts or
  // /prompts/index, with or without a .js extension). Covers both `from '...'`
  // imports and `require('...')` calls (ticket #118).
  const directImportPattern =
    /(?:from\s+|require\(\s*)['"][^'"]*\/prompts\/(?!index(\.js)?['"])[^'"]+['"](?:\s*\))?/;

  it('flags known bypass forms (.js extension, require(), backtick-free samples)', () => {
    const bypasses = [
      `import { STEP_PLAN_SYSTEM_PROMPT } from '../src/prompts/step-plan';`,
      `import { STEP_PLAN_SYSTEM_PROMPT } from '../src/prompts/step-plan.js';`,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      `const prompts = require('../src/prompts/prd');`,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      `const prompts = require('../src/prompts/prd.js');`,
    ];
    for (const line of bypasses) {
      expect(directImportPattern.test(line)).toBe(true);
      directImportPattern.lastIndex = 0;
    }
  });

  it('does not flag imports resolving to prompts/index.ts', () => {
    const allowed = [
      `import * as prompts from '../src/prompts';`,
      `import * as prompts from '../src/prompts/index';`,
      `import * as prompts from '../src/prompts/index.js';`,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      `const prompts = require('../src/prompts/index.js');`,
    ];
    for (const line of allowed) {
      expect(directImportPattern.test(line)).toBe(false);
      directImportPattern.lastIndex = 0;
    }
  });

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
        if (new RegExp(directImportPattern.source, 'g').test(content)) {
          offenders.push(path.relative(SRC_DIR, fullPath));
        }
      }
    };

    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});

describe('ported non-table step prompts (ADR-0048)', () => {
  it('exports the UpdateComponent prompt with the forced tool-call contract', () => {
    expect(promptsIndex.UPDATE_COMPONENT_SYSTEM_PROMPT).toContain('Call updateComponent exactly once');
    expect(promptsIndex.UPDATE_COMPONENT_SYSTEM_PROMPT).toContain('include ONLY the paths that actually need to change');
  });

  it('exports the DeleteComponent prompt with the forced tool-call contract', () => {
    expect(promptsIndex.DELETE_COMPONENT_SYSTEM_PROMPT).toContain('Call deleteComponent exactly once');
  });

  it('exports the MoveComponent prompt with the forced tool-call contract', () => {
    expect(promptsIndex.MOVE_COMPONENT_SYSTEM_PROMPT).toContain('Call moveComponent exactly once');
  });
});
