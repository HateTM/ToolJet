import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAiActiveRunsTable1788083614113 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_active_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid NOT NULL,
        user_id uuid NOT NULL,
        organization_id uuid NOT NULL,
        started_at timestamp NOT NULL DEFAULT now(),
        last_heartbeat_at timestamp NOT NULL DEFAULT now(),
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT uq_ai_active_runs_conversation_id UNIQUE (conversation_id)
      )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_active_runs_conversation') THEN
          ALTER TABLE ai_active_runs
            ADD CONSTRAINT fk_ai_active_runs_conversation
            FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_active_runs_user') THEN
          ALTER TABLE ai_active_runs
            ADD CONSTRAINT fk_ai_active_runs_user
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_active_runs_organization') THEN
          ALTER TABLE ai_active_runs
            ADD CONSTRAINT fk_ai_active_runs_organization
            FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS ai_active_runs');
  }
}
