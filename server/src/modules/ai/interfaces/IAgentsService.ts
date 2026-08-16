export interface IAgentsService {
  CreateTable(organizationId: string, tables: any): Promise<any>;

  // `type` + `props` per ADR-0002's generic "CreateComponent(type, props)" tool; the
  // props shape is type-specific (see AgentsService.CreateComponent's doc comment).
  CreateComponent(appVersionId: string, organizationId: string, type: string, props: any): Promise<any>;

  CreateQuery(appVersionId: string, organizationId: string, props: any): Promise<any>;

  docs(prompt: string, organizationId: string, previousMessages?: any[]): Promise<any>;

  create_header_component(appTitle: string): Promise<any>;

  classify(prompt: string, organizationId: string): Promise<any>;

  copilot(prompt: string, context: string, language: string, organizationId: string): Promise<any>;
}
