import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddPhaseToSteps1783000001000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'steps',
            new TableColumn({
                name: 'phase',
                type: 'varchar',
                isNullable: true,
            })
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('steps', 'phase');
    }
}
