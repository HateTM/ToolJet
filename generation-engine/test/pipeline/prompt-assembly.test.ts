import {
  buildCatalogPromptContext,
  buildEvaluateStageInput,
  buildLldStageInput,
  buildPerEntityStageInput,
} from '../../src/pipeline/prompt-assembly';
import { PipelineArtifacts, EntityToolCall } from '../../src/pipeline/types';

describe('buildCatalogPromptContext', () => {
  it('renders both catalogs as JSON', () => {
    const ctx = JSON.parse(buildCatalogPromptContext());
    expect(Object.keys(ctx)).toEqual(['components', 'eventActions']);
    expect(ctx.components.Table.triggers.map((t: { id: string }) => t.id)).toContain('onRowClicked');
    expect(ctx.eventActions['run-query']).toBeDefined();
  });
});

describe('buildLldStageInput', () => {
  it('embeds the PRD and the catalog context', () => {
    const input = buildLldStageInput('a CRM with customers');
    expect(input).toContain('# PRD');
    expect(input).toContain('a CRM with customers');
    expect(input).toContain('# Component and event catalogs');
    expect(input).toContain('"onRowClicked"');
  });
});

describe('buildPerEntityStageInput', () => {
  const artifacts: PipelineArtifacts = {
    prompt: 'build a CRM',
    prd: 'CRM PRD text',
    featurePlan: {
      items: [
        { entityName: 'customers', dependsOn: [] },
        { entityName: 'orders', dependsOn: ['customers'] },
      ],
    },
  };

  it('embeds the PRD, entity routing, and catalog context for an update call', () => {
    const call: EntityToolCall = { entityName: 'orders', action: 'update', toolName: 'update_table' };
    const input = buildPerEntityStageInput(call, artifacts);
    expect(input).toContain('CRM PRD text');
    expect(input).toContain('orders');
    expect(input).toContain('update_table');
    expect(input).toContain('Depends on already-generated entities: customers');
    expect(input).toContain('"components"');
  });

  it('states no dependencies for a root entity', () => {
    const call: EntityToolCall = { entityName: 'customers', action: 'create', toolName: 'create_table' };
    const input = buildPerEntityStageInput(call, artifacts);
    expect(input).toContain('Depends on no other entity');
    expect(input).toContain('create_table');
  });
});

describe('buildEvaluateStageInput', () => {
  it('summarizes the generated artifacts', () => {
    const input = JSON.parse(buildEvaluateStageInput({ prompt: 'x', prd: 'the PRD' }));
    expect(input).toEqual({ prd: 'the PRD', entityToolCalls: undefined, featurePlan: undefined, stepPlan: undefined });
    expect(input).not.toHaveProperty('prompt');
  });
});
