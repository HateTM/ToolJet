import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the AI Builder step-plan tables (`steps`, `artifacts`) — the base schema the
 * Step/Artifact entities (@Entity('steps')/@Entity('artifacts')) and the plan-execution
 * flow (tickets #4, #5, #20, #21, #48) depend on.
 *
 * Why this migration is idempotent (CREATE TABLE IF NOT EXISTS + guarded constraints):
 * these tables predate this migration on existing deployments (they were created out of
 * band during development, and `AddPlannedTableToSteps`/`AddPhaseToSteps`/
 * `AddPlannedSeedRowsToSteps` already ALTER them), so re-running against such databases
 * must be a no-op while fresh environments get the full bootstrap. The later columns are
 * deliberately NOT created here — the ALTER migrations own them.
 */
export class CreateAiStepsAndArtifactsTables1782999999999 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid NOT NULL,
        message_id uuid NOT NULL,
        content jsonb NOT NULL,
        identifier varchar NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS steps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid NOT NULL,
        message_id uuid NOT NULL,
        "order" int NOT NULL,
        type varchar NOT NULL,
        description text,
        status varchar NOT NULL DEFAULT 'pending',
        props jsonb,
        attempts int NOT NULL DEFAULT 0,
        error_message text,
        artifact_id uuid,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);

    // The referenced tables (ai_conversations, ai_conversation_messages) exist — they are
    // created by CreateTablesForToojetAiConversations1737530238311, which precedes this
    // migration. Constraints are added only when absent so re-runs stay no-ops.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_artifacts_conversation') THEN
          ALTER TABLE artifacts ADD CONSTRAINT fk_artifacts_conversation
            FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_artifacts_message') THEN
          ALTER TABLE artifacts ADD CONSTRAINT fk_artifacts_message
            FOREIGN KEY (message_id) REFERENCES ai_conversation_messages(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_steps_conversation') THEN
          ALTER TABLE steps ADD CONSTRAINT fk_steps_conversation
            FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_steps_message') THEN
          ALTER TABLE steps ADD CONSTRAINT fk_steps_message
            FOREIGN KEY (message_id) REFERENCES ai_conversation_messages(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_steps_artifact') THEN
          ALTER TABLE steps ADD CONSTRAINT fk_steps_artifact
            FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS steps');
    await queryRunner.query('DROP TABLE IF EXISTS artifacts');
  }
}
