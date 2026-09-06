// server/test/modules/tooljet-db/unit/tooljet-db-create-table-indexes.spec.ts
//
// Ticket #23, DB layer: the create_table action must persist the `indexes` it is given —
// TypeORM createIndex per index inside the same transaction as the table — and must reject
// an index naming a column the table doesn't define before any side effect. Both query
// runners are mocked, so the suite runs offline (jest-ai-unit.config.ts includes it by
// name; the DB-backed tooljet-db specs stay on the main jest config).
import { BadRequestException } from '@nestjs/common';
import { TooljetDatabaseError } from '@modules/tooljet-db/types';
import { TooljetDbTableOperationsService } from '@modules/tooljet-db/services/tooljet-db-table-operations.service';

const ORGANIZATION_ID = 'org-1';
// findTenantSchema's actual prefix
const TENANT_SCHEMA = 'workspace_org-1';
const TABLE_UUID = '11111111-1111-1111-1111-111111111111';
// TooljetDatabaseError wraps a TypeORM QueryFailedError, so the mocked rejection must
// carry the same shape (parameters, driverError with a pg error code).
const PG_LIKE_ERROR = {
  message: 'relation "11111111" does not exist',
  parameters: [],
  driverError: Object.assign(new Error('relation "11111111" does not exist'), { code: '42P01' }),
};

const TABLE_PARAMS = {
  table_name: 'orders',
  columns: [
    {
      column_name: 'id',
      data_type: 'serial',
      constraints_type: { is_primary_key: true, is_not_null: true, is_unique: true },
    },
    {
      column_name: 'customer_id',
      data_type: 'integer',
      constraints_type: { is_primary_key: false, is_not_null: true, is_unique: false },
    },
    {
      column_name: 'status',
      data_type: 'character varying',
      constraints_type: { is_primary_key: false, is_not_null: false, is_unique: false },
    },
  ],
};

const buildQueryRunner = () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  startTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined),
  createTable: jest.fn().mockResolvedValue(undefined),
  createPrimaryKey: jest.fn().mockResolvedValue(undefined),
  createIndex: jest.fn().mockResolvedValue(undefined),
  manager: {
    create: jest.fn().mockReturnValue({ id: TABLE_UUID, tableName: TABLE_PARAMS.table_name }),
    save: jest.fn().mockResolvedValue(undefined),
  },
});

const buildService = (appQueryRunner: any, tjdbQueryRunner: any) => {
  // createTable prefers the manager's own queryRunner when present, so handing the mocks in
  // as `queryRunner` properties routes every transaction call into the assertions above.
  const appManager = {
    findOne: jest.fn().mockResolvedValue(null), // no table name conflict
    queryRunner: appQueryRunner,
    connection: { createQueryRunner: jest.fn() },
  };
  const tjdbManager = {
    query: jest.fn().mockResolvedValue([]), // NOTIFY pgrst after commit
    queryRunner: tjdbQueryRunner,
    connection: { createQueryRunner: jest.fn() },
  };
  return new TooljetDbTableOperationsService(
    appManager as any,
    tjdbManager as any,
    { emit: jest.fn() } as any,
    {} as any,
    {} as any
  );
};

describe('TooljetDbTableOperationsService create_table — indexes (ticket #23)', () => {
  it('creates every requested index inside the same transaction, before commit', async () => {
    const appQueryRunner = buildQueryRunner();
    const tjdbQueryRunner = buildQueryRunner();
    const service = buildService(appQueryRunner, tjdbQueryRunner);

    await service.perform(ORGANIZATION_ID, 'create_table', {
      ...TABLE_PARAMS,
      indexes: [{ column_names: ['customer_id'] }, { column_names: ['customer_id', 'status'], is_unique: true }],
    });

    expect(tjdbQueryRunner.createIndex).toHaveBeenCalledTimes(2);
    const [firstTable, firstIndex] = tjdbQueryRunner.createIndex.mock.calls[0];
    expect(firstTable.name).toBe(TABLE_UUID);
    expect(firstTable.schema).toBe(TENANT_SCHEMA);
    expect(firstIndex.columnNames).toEqual(['customer_id']);
    expect(firstIndex.isUnique).toBe(false);
    const [, secondIndex] = tjdbQueryRunner.createIndex.mock.calls[1];
    expect(secondIndex.columnNames).toEqual(['customer_id', 'status']);
    expect(secondIndex.isUnique).toBe(true);

    // Indexes are part of the transaction: created after CREATE TABLE/PK, before commit.
    const order = tjdbQueryRunner.createIndex.mock.invocationCallOrder[0];
    expect(order).toBeGreaterThan(tjdbQueryRunner.createPrimaryKey.mock.invocationCallOrder[0]);
    expect(order).toBeLessThan(tjdbQueryRunner.commitTransaction.mock.invocationCallOrder[0]);
    expect(appQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('creates no indexes when none are requested', async () => {
    const tjdbQueryRunner = buildQueryRunner();
    const service = buildService(buildQueryRunner(), tjdbQueryRunner);

    await service.perform(ORGANIZATION_ID, 'create_table', TABLE_PARAMS);

    expect(tjdbQueryRunner.createIndex).not.toHaveBeenCalled();
  });

  it('rejects an index naming an unknown column before any transaction opens', async () => {
    const appQueryRunner = buildQueryRunner();
    const tjdbQueryRunner = buildQueryRunner();
    const service = buildService(appQueryRunner, tjdbQueryRunner);

    await expect(
      service.perform(ORGANIZATION_ID, 'create_table', {
        ...TABLE_PARAMS,
        indexes: [{ column_names: ['ghost_column'] }],
      })
    ).rejects.toThrow(BadRequestException);

    expect(appQueryRunner.startTransaction).not.toHaveBeenCalled();
    expect(tjdbQueryRunner.createTable).not.toHaveBeenCalled();
  });

  it('rolls both transactions back when an index fails to create', async () => {
    const appQueryRunner = buildQueryRunner();
    const tjdbQueryRunner = buildQueryRunner();
    tjdbQueryRunner.createIndex.mockRejectedValue(PG_LIKE_ERROR);
    const service = buildService(appQueryRunner, tjdbQueryRunner);

    await expect(
      service.perform(ORGANIZATION_ID, 'create_table', {
        ...TABLE_PARAMS,
        indexes: [{ column_names: ['customer_id'] }],
      })
    ).rejects.toThrow(TooljetDatabaseError);

    expect(tjdbQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(appQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(tjdbQueryRunner.commitTransaction).not.toHaveBeenCalled();
  });
});
