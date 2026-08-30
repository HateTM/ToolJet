export interface IAiUtilService {
  getColorScheme(prd: any): any;
  getAgentAssetPath(filename: string): any;

  mergeSteps(componentsJson: any, newStepsJson: any): any;

  AgenticMergeSteps(input: any): any;

  AIGateway(provider: string, operation_id: string, prompt_body: any, organizationId: string): Promise<any>;

  AIGatewayGenerate(provider: string, operation_id: string, prompt_body: any, organizationId: string): Promise<any>;

  createComponentfromSteps(
    steps: any,
    componentDatapath?: string
  ): Promise<{
    type?: string;
    steps: {
      [key: string]: {
        component: {
          definition: {
            properties: {
              text?: {
                value: string;
              };
            };
          };
        };
      };
    };
  }>;

  getComponentsfromsteps(steps: any): Promise<any>;

  createQueryfromSteps(steps: any): Promise<any>;

  getQueriesfromsteps(steps: any): Promise<any>;

  convertToSteps(jsonData: any): Promise<any>;

  getColorScheme(prd: any): any;

  sendSSE(res: any, type: string, data: any): any;

  initSSE(res: any): any;

  startHeartbeat(res: any, intervalMs?: number): any;

  estimateTokenCount(content: string): number;

  getContextWindow(provider?: string, configuredWindow?: number): number;

  fitMessagesToContextWindowForOrg(
    organizationId: string,
    messages: Array<{ role: string; content: string }>
  ): Promise<{
    messages: Array<{ role: string; content: string }>;
    truncated: Array<{
      role: string;
      originalTokens: number;
      keptTokens: number;
      droppedTokens: number;
      reason: 'content-truncated' | 'message-dropped';
    }>;
  }>;

  fitMessagesToContextWindow(
    messages: Array<{ role: string; content: string }>,
    provider?: string,
    configuredWindow?: number
  ): {
    messages: Array<{ role: string; content: string }>;
    truncated: Array<{
      role: string;
      originalTokens: number;
      keptTokens: number;
      droppedTokens: number;
      reason: 'content-truncated' | 'message-dropped';
    }>;
  };

  getConversation(appId: string, userId: string, conversationType: string): Promise<any>;

  createNewConversation(
    userId: string,
    appId: string,
    conversationType: string,
    currentConversationId?: string,
    handoff?: boolean
  ): Promise<any>;

  getConversationsList(appId: string, userId: string, conversationType: string): Promise<any[]>;

  getConversationById(conversationId: string, userId: string): Promise<any>;
}
