// server/test/modules/ai/unit/agents.service.spec.ts
import { AgentsService } from '@modules/ai/services/agents.service';

const buildMockTooljetDbTableOperationsService = () => ({
  perform: jest.fn(),
});

/** @group platform */
describe('AgentsService.CreateTable', () => {
  it("delegates to TooljetDbTableOperationsService.perform with the 'create_table' action", async () => {
    const tooljetDbTableOperationsService = buildMockTooljetDbTableOperationsService();
    tooljetDbTableOperationsService.perform.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });

    const service = new AgentsService(tooljetDbTableOperationsService as any);
    const tables = {
      table_name: 'customers',
      columns: [
        {
          column_name: 'id',
          data_type: 'serial',
          constraints_type: { is_primary_key: true, is_not_null: true, is_unique: true },
        },
      ],
    };

    const result = await service.CreateTable('org-1', tables);

    expect(tooljetDbTableOperationsService.perform).toHaveBeenCalledWith('org-1', 'create_table', tables);
    expect(result).toEqual({ id: 'tjdb-uuid', table_name: 'customers' });
  });

  it('propagates errors from the underlying table-creation service as-is (e.g. missing primary key)', async () => {
    const tooljetDbTableOperationsService = buildMockTooljetDbTableOperationsService();
    tooljetDbTableOperationsService.perform.mockRejectedValue(new Error('Primary key is mandatory'));

    const service = new AgentsService(tooljetDbTableOperationsService as any);

    await expect(service.CreateTable('org-1', { table_name: 'x', columns: [] })).rejects.toThrow(
      'Primary key is mandatory'
    );
  });
});
