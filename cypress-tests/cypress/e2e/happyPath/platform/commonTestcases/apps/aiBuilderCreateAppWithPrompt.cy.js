// Covers ticket #9 / ADR-0010: homepage "create app with prompt" → new empty App →
// builder opens with the AI sidebar already showing the typed prompt in flight. Follows
// this suite's existing convention (appCreate.cy.js et al.) of running against a real
// backend/DB rather than stubbing responses — the AI Builder feature itself already
// depends on a configured OpenAI-compatible endpoint (OPENAI_BASE_URL/OPENAI_API_KEY/
// AI_MODEL) to function at all, same as every other AI Builder flow.
describe("AI Builder - homepage create app with prompt", () => {
  beforeEach(() => {
    cy.defaultWorkspaceLogin();
    cy.skipWalkthrough();
    cy.viewport(2000, 1900);
  });

  it("creates a new app from a homepage prompt and lands in the builder with the prompt already sent", () => {
    const prompt = "Build a CRM to track leads and deals";

    cy.intercept("POST", "**/api/apps").as("createApp");
    cy.intercept("POST", "**/api/ai/conversation").as("createConversation");
    cy.intercept("POST", "**/api/ai/conversation/message").as("sendMessage");

    cy.get('[data-cy="create-app-with-prompt-input"]', { timeout: 20000 }).should("be.visible");
    cy.get('[data-cy="create-app-with-prompt-submit-button"]').should("be.disabled");

    cy.get('[data-cy="create-app-with-prompt-input"]').type(prompt);
    cy.get('[data-cy="create-app-with-prompt-submit-button"]').should("be.enabled").click();

    cy.wait("@createApp");
    cy.url({ timeout: 20000 }).should("match", /\/apps\/[^/]+$/);

    // Same panel component the in-builder chat uses (AiBuilderChatPanel) — the AI sidebar
    // opens automatically as part of the handoff, no manual click needed.
    cy.get('[data-cy="ai-builder-chat-panel"]', { timeout: 20000 }).should("be.visible");

    cy.wait("@createConversation");
    cy.wait("@sendMessage", { timeout: 30000 });

    // The typed prompt is the first message, already sent (not sitting in the input box).
    cy.get('[data-cy="ai-builder-chat-panel"]').contains(prompt).should("be.visible");
    cy.get('[data-cy="ai-builder-message-input"]').should("have.value", "");

    // A reply eventually lands — the same panel that streams replies for any other message,
    // so once it's showing content beyond the prompt itself, the rest of the flow (PRD,
    // approve, build) is exactly the in-builder chat panel's already-covered behavior.
    cy.get('[data-cy="ai-builder-chat-panel"]', { timeout: 30000 }).within(() => {
      cy.get('[data-cy="ai-builder-approve-prd-button"]', { timeout: 30000 }).should("exist");
    });
  });
});
