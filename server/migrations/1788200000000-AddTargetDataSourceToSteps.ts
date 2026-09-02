import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

// Ticket #77 / ADR-0042: the optional external-target discriminant on a CreateTable Step —
// present only when the step targets a connected PostgreSQL data source instead of ToolJet
// DB (mirrors the dataSourceId-optional pattern CreateQuery already uses per ADR-0019).
export class AddTargetDataSourceToSteps1788200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'steps',
      new TableColumn({
        name: 'target_data_source_id',
        type: 'uuid',
        isNullable: true,
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('steps', 'target_data_source_id');
  }
}
