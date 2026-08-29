import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddPlannedSeedRowsToSteps1783200000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'steps',
            new TableColumn({
                name: 'planned_seed_rows',
                type: 'jsonb',
                isNullable: true,
            })
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('steps', 'planned_seed_rows');
    }
}
