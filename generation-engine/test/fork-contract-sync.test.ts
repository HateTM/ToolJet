import * as fs from 'fs';
import * as path from 'path';

/**
 * Mirror of server/test/modules/ai/unit/engine-contract-sync.spec.ts: same guard, run
 * from the engine side, so a break shows up regardless of which package's CI runs.
 * Neither package can import the other's TS directly (typeorm, path aliases), so both
 * copies read the other's source as text and regex out the literal list.
 */

function extractStringArrayLiteral(source: string, constName: string): string[] {
  const re = new RegExp(`${constName}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`, 's');
  const match = source.match(re);
  if (!match) {
    throw new Error(`Could not find array literal for ${constName}`);
  }
  return Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
}

function extractUnionTypeLiteral(source: string, typeName: string): string[] {
  const re = new RegExp(`type ${typeName}\\s*=([^;]*);`, 's');
  const match = source.match(re);
  if (!match) {
    throw new Error(`Could not find union type for ${typeName}`);
  }
  return Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
}

describe('fork-contract-sync (generation-engine <-> fork)', () => {
  it('engine STEP_TYPES matches the fork StepType union', () => {
    const enginePath = path.join(__dirname, '../src/pipeline/types.ts');
    const forkPath = path.join(__dirname, '../../server/src/entities/step.entity.ts');

    const engineTypes = extractStringArrayLiteral(fs.readFileSync(enginePath, 'utf8'), 'export const STEP_TYPES');
    const forkTypes = extractUnionTypeLiteral(fs.readFileSync(forkPath, 'utf8'), 'StepType');

    expect(new Set(engineTypes)).toEqual(new Set(forkTypes));
  });

  it('engine LlmProvider matches the fork LlmProvider union', () => {
    const enginePath = path.join(__dirname, '../src/config/llm.ts');
    const forkPath = path.join(__dirname, '../../server/src/modules/ai/constants/llm.ts');

    const engineProviders = extractUnionTypeLiteral(fs.readFileSync(enginePath, 'utf8'), 'LlmProvider');
    const forkProviders = extractUnionTypeLiteral(fs.readFileSync(forkPath, 'utf8'), 'LlmProvider');

    expect(new Set(engineProviders)).toEqual(new Set(forkProviders));
  });
});
