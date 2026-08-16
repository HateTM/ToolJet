import { Injectable } from '@nestjs/common';
import { IAgentsService } from '../interfaces/IAgentsService';
import { TooljetDbTableOperationsService } from '@modules/tooljet-db/services/tooljet-db-table-operations.service';

@Injectable()
export class AgentsService implements IAgentsService {
  constructor(private readonly tooljetDbTableOperationsService: TooljetDbTableOperationsService) {}

  /**
   * `tables` is the single-table creation payload for TooljetDbTableOperationsService's
   * 'create_table' action: { table_name, columns: [{ column_name, data_type,
   * constraints_type: { is_primary_key, is_not_null, is_unique }, column_default? }],
   * foreign_keys? }. One CreateTable Step creates exactly one table (CONTEXT.md: "Each
   * Step produces exactly one Artifact"), so this always returns a single { id, table_name }
   * result — errors (missing primary key, duplicate table name, etc.) propagate as-is so the
   * Step-execution retry loop can catch and act on them.
   */
  async CreateTable(organizationId: string, tables): Promise<any> {
    return this.tooljetDbTableOperationsService.perform(organizationId, 'create_table', tables);
  }

  async docs(prompt: string, organizationId: string, previousMessages?: any[]): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async create_header_component(appTitle: string): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async classify(prompt: string, organizationId): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async copilot(prompt: string, context: string, language: string, organizationId): Promise<any> {
    throw new Error('Method not implemented.');
  }
}
