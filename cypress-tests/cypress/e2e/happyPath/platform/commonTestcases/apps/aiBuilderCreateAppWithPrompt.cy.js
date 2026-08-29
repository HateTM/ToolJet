// Covers ticket #9 / ADR-0010: homepage "create app with prompt" → new empty App →
// builder opens with the AI sidebar already showing the typed prompt in flight. Follows
// this suite's existing convention (appCreate.cy.js et al.) of running against a real
// backend/DB rather than stubbing responses — the AI Builder feature itself already
// depends on a configured OpenAI-compatible endpoint (OPENAI_BASE_URL/OPENAI_API_KEY/
// AI_MODEL) to function at all, same as every other AI Builder flow.
import { dashboardSelector } from "Selectors/dashboard";
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

    cy.get(dashboardSelector.homePagePromptTextArea, { timeout: 20000 }).should("be.visible");
    cy.get('[data-cy="create-app-with-prompt-submit-button"]').should("be.disabled");

    cy.get(dashboardSelector.homePagePromptTextArea).type(prompt);
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

  // Ticket #25 / ADR-0017. Unlike the happy path above, these two force a server failure with
  // a stubbed reply — the only way to exercise the handoff's failure path deterministically,
  // since a correctly-configured backend won't fail on demand. Everything else still runs
  // against the real app-creation flow.
  const createAppFromPrompt = (prompt) => {
    cy.intercept("POST", "**/api/apps").as("createApp");
    cy.get(dashboardSelector.homePagePromptTextArea, { timeout: 20000 }).should("be.visible").type(prompt);
    cy.get('[data-cy="create-app-with-prompt-submit-button"]').should("be.enabled").click();
    cy.wait("@createApp");
    cy.url({ timeout: 20000 }).should("match", /\/apps\/[^/]+$/);
  };

  it("hands the prompt back to the composer and bootstraps the panel when conversation creation fails", () => {
    const prompt = "Build a CRM to track leads and deals";

    cy.intercept("POST", "**/api/ai/conversation", { statusCode: 500, body: { message: "boom" } }).as(
      "createConversation"
    );
    // The panel's own bootstrap, which the handoff stood down for — it has to run after the
    // failure instead of leaving the panel empty for the rest of the session.
    cy.intercept("GET", "**/api/ai/conversations*").as("listConversations");

    createAppFromPrompt(prompt);

    cy.get('[data-cy="ai-builder-chat-panel"]', { timeout: 20000 }).should("be.visible");
    cy.wait("@createConversation");

    // AC: the typed prompt is recoverable, not lost with only an error banner to show for it.
    cy.get('[data-cy="ai-builder-message-input"]', { timeout: 20000 }).should("have.value", prompt);
    // AC: the bootstrap the handoff skipped actually runs once the handoff fails.
    cy.wait("@listConversations", { timeout: 20000 });
    // ...and survives it. The fallback bootstrap is built out of the very read actions that
    // used to null `error` on start, so without ADR-0017's change to those the banner would
    // vanish a tick after appearing and the recovered draft would have no explanation.
    cy.get('[data-cy="ai-builder-error-banner"]').should("be.visible");
  });

  it("hands the prompt back to the composer when the message itself fails after the conversation was created", () => {
    const prompt = "Build an inventory tracker";

    // Conversation creation is left real, so this covers the harder half: a conversation does
    // exist server-side, and only the message failed.
    cy.intercept("POST", "**/api/ai/conversation/message", { statusCode: 500, body: { message: "boom" } }).as(
      "sendMessage"
    );
    cy.intercept("GET", "**/api/ai/conversations*").as("listConversations");

    createAppFromPrompt(prompt);

    cy.get('[data-cy="ai-builder-chat-panel"]', { timeout: 20000 }).should("be.visible");
    cy.wait("@sendMessage", { timeout: 30000 });

    cy.get('[data-cy="ai-builder-message-input"]', { timeout: 20000 }).should("have.value", prompt);
    cy.wait("@listConversations", { timeout: 20000 });
    cy.get('[data-cy="ai-builder-error-banner"]').should("be.visible");
  });

  // ADR-0010's strip is unconditional and now runs as soon as the store holds the prompt, so a
  // failed handoff can't be replayed by a reload — otherwise a user who recovers the draft and
  // sends it successfully would get a second conversation on their next refresh.
  it("does not re-run the handoff on reload after a failure", () => {
    const prompt = "Build a helpdesk";

    cy.intercept("POST", "**/api/ai/conversation", { statusCode: 500, body: { message: "boom" } }).as(
      "createConversation"
    );

    createAppFromPrompt(prompt);

    cy.get('[data-cy="ai-builder-chat-panel"]', { timeout: 20000 }).should("be.visible");
    cy.wait("@createConversation");
    cy.get('[data-cy="ai-builder-message-input"]', { timeout: 20000 }).should("have.value", prompt);

    let conversationAttempts = 0;
    cy.intercept("POST", "**/api/ai/conversation", (req) => {
      conversationAttempts += 1;
      req.reply({ statusCode: 500, body: { message: "boom" } });
    }).as("createConversationAfterReload");

    cy.reload();

    // Wait for the rebuilt builder, then assert the handoff stayed put: no sidebar opened for
    // it, and above all no second conversation created.
    cy.get('[data-cy="left-sidebar-ai-builder-button"]', { timeout: 20000 }).should("be.visible");
    cy.get('[data-cy="ai-builder-chat-panel"]').should("not.exist");
    cy.then(() => expect(conversationAttempts).to.equal(0));
  });
});
