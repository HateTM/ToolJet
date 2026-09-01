// transit copy from PR #93 (feature/93-generation-engine-prompt-library @ 9cf62c7d86) — dedupe at merge
// The only import surface for prompts/*.ts — per docs/adr/0030, every other file in the
// engine imports prompts from here, never from an individual prompts/<file>.ts. Enforced
// by generation-engine/test/prompts.test.ts.
export * from './classify';
export * from './prd';
export * from './lld';
export * from './feature-planner';
export * from './step-plan';
export * from './create-table';
export * from './create-component';
export * from './create-query';
export * from './update-query';
export * from './update-table';
export * from './evaluate';
