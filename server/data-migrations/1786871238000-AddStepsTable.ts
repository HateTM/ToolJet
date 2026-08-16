import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class AddStepsTable1786871238000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'steps',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          {
            name: 'conversation_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'message_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'order',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'type',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'status',
            type: 'varchar',
            isNullable: false,
            default: "'pending'",
          },
          {
            name: 'props',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'attempts',
            type: 'int',
            isNullable: false,
            default: 0,
          },
          {
            name: 'error_message',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'artifact_id',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
      true
    );

    await queryRunner.createForeignKey(
      'steps',
      new TableForeignKey({
        columnNames: ['conversation_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'ai_conversations',
        onDelete: 'CASCADE',
      })
    );

    await queryRunner.createForeignKey(
      'steps',
      new TableForeignKey({
        columnNames: ['message_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'ai_conversation_messages',
        onDelete: 'CASCADE',
      })
    );

    await queryRunner.createForeignKey(
      'steps',
      new TableForeignKey({
        columnNames: ['artifact_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'artifacts',
        onDelete: 'SET NULL',
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('steps');
    if (table) {
      const foreignKeys = table.foreignKeys;
      await Promise.all(foreignKeys.map((foreignKey) => queryRunner.dropForeignKey('steps', foreignKey)));
    }
    await queryRunner.dropTable('steps');
  }
}
