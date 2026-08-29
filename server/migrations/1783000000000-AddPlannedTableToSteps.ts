import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddPlannedTableToSteps1783000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'steps',
            new TableColumn({
                name: 'planned_table',
                type: 'jsonb',
                isNullable: true,
            })
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('steps', 'planned_table');
    }
}
