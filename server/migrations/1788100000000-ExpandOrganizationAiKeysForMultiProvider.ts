import { MigrationInterface, QueryRunner, TableColumn, TableCheck } from 'typeorm';

/**
 * Ticket #59: multi-provider BYOK for AI Builder.
 *
 * Extends `organization_ai_keys` (created in 1775040752060) with the settings an
 * admin configures via GET/PATCH key-settings: the concrete model, an optional
 * context-window override, and a switch that forces the env-config fallback.
 * The provider check constraint from 1776500000000 is widened to every provider
 * the CE provider factory can build (previously anthropic/gemini/tooljet_managed).
 */
export class ExpandOrganizationAiKeysForMultiProvider1788100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'organization_ai_keys',
      new TableColumn({
        name: 'model',
        type: 'varchar',
        length: '120',
        isNullable: true,
      })
    );
    await queryRunner.addColumn(
      'organization_ai_keys',
      new TableColumn({
        name: 'context_window',
        type: 'integer',
        isNullable: true,
      })
    );
    await queryRunner.addColumn(
      'organization_ai_keys',
      new TableColumn({
        name: 'use_environment_config',
        type: 'boolean',
        isNullable: false,
        default: false,
      })
    );

    await queryRunner.query(
      'ALTER TABLE organization_ai_keys DROP CONSTRAINT IF EXISTS chk_organization_ai_keys_provider'
    );
    await queryRunner.createCheckConstraint(
      'organization_ai_keys',
      new TableCheck({
        name: 'chk_organization_ai_keys_provider',
        columnNames: ['provider'],
        expression: `provider IN ('anthropic', 'gemini', 'grok', 'openai', 'openrouter', 'tooljet_managed')`,
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE organization_ai_keys DROP CONSTRAINT IF EXISTS chk_organization_ai_keys_provider'
    );
    await queryRunner.createCheckConstraint(
      'organization_ai_keys',
      new TableCheck({
        name: 'chk_organization_ai_keys_provider',
        columnNames: ['provider'],
        expression: `provider IN ('anthropic', 'gemini', 'tooljet_managed')`,
      })
    );
    await queryRunner.dropColumn('organization_ai_keys', 'use_environment_config');
    await queryRunner.dropColumn('organization_ai_keys', 'context_window');
    await queryRunner.dropColumn('organization_ai_keys', 'model');
  }
}
