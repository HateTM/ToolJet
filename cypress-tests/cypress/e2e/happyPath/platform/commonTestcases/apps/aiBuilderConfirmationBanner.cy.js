// Ticket #77 / ADR-0053: the run-time step list shows an inline banner when a step (a
// CreateTable or UpdateTable targeting an external Postgres connection) reaches
// 'awaiting_confirmation', with Confirm/Reject actions. This spec covers ONLY that banner
// interaction — not a full PRD-to-execution flow (already covered by unit/integration
// tests, see frontend/src/_stores/__tests__/aiBuilderStore.test.js).
//
// There's no fixture for driving a real backend/LLM run into an awaiting_confirmation step
// deterministically, so the approve-prd SSE stream is mocked outright: the app-creation
// hand-off up to "PRD ready" runs for real (same convention as
// aiBuilderCreateAppWithPrompt.cy.js), then the POST to approve-prd is intercepted and
// replied with a scripted text/event-stream body (plan -> step-awaiting-confirmation ->
// done) instead of letting the real backend run. This exercises the exact SSE parsing path
// aiService.approvePrd uses (fetchEventSource over fetch), just with a canned body.
import { dashboardSelector } from "Selectors/dashboard";

describe("AI Builder - step list awaiting_confirmation banner", () => {
  const buildApprovePrdSSEBody = (stepId) => {
    const plan = {
      steps: [{ id: stepId, type: "CreateTable", description: "Create the orders table" }],
    };
    const confirmation = {
      stepId,
      tableName: "orders",
      columns: [{ name: "id" }, { name: "total" }],
      targetConnection: { id: "ds-1", name: "Warehouse PG" },
      seedRowCount: 5,
    };
    return (
      `event: plan\ndata: ${JSON.stringify(plan)}\n\n` +
      `event: step-awaiting-confirmation\ndata: ${JSON.stringify(confirmation)}\n\n`
    );
    // Deliberately no `done` event: the mocked stream stays open, same as the real backend
    // does while polling for the user's decision (awaitExternalTableConfirmation) — the spec
    // only needs the banner to render and the two buttons to fire their requests.
  };

  const reachApprovePrdButton = (prompt) => {
    cy.intercept("POST", "**/api/apps").as("createApp");
    cy.intercept("POST", "**/api/ai/conversation").as("createConversation");
    cy.intercept("POST", "**/api/ai/conversation/message").as("sendMessage");

    cy.get(dashboardSelector.homePagePromptTextArea, { timeout: 20000 }).should("be.visible").type(prompt);
    cy.get('[data-cy="create-app-with-prompt-submit-button"]').should("be.enabled").click();

    cy.wait("@createApp");
    cy.url({ timeout: 20000 }).should("match", /\/apps\/[^/]+$/);
    cy.get('[data-cy="ai-builder-chat-panel"]', { timeout: 20000 }).should("be.visible");
    cy.wait("@createConversation");
    cy.wait("@sendMessage", { timeout: 30000 });
    cy.get('[data-cy="ai-builder-approve-prd-button"]', { timeout: 30000 }).should("exist");
  };

  beforeEach(() => {
    cy.defaultWorkspaceLogin();
    cy.skipWalkthrough();
    cy.viewport(2000, 1900);
  });

  it("shows the confirmation banner for an awaiting_confirmation step and Confirm calls confirm-step", () => {
    const stepId = "step-confirm-1";

    reachApprovePrdButton("Build a CRM to track leads and deals");

    cy.intercept("POST", "**/api/ai/conversation/approve-prd", (req) => {
      req.reply({
        statusCode: 200,
        headers: { "content-type": "text/event-stream" },
        body: buildApprovePrdSSEBody(stepId),
      });
    }).as("approvePrd");
    cy.intercept("POST", "**/api/ai/conversation/confirm-step").as("confirmStep");

    cy.get('[data-cy="ai-builder-approve-prd-button"]').click();
    cy.wait("@approvePrd");

    cy.get('[data-cy="ai-builder-confirmation-banner-0"]', { timeout: 20000 }).should("be.visible");
    cy.get('[data-cy="ai-builder-confirmation-banner-0"]').contains("orders");
    cy.get('[data-cy="ai-builder-confirmation-banner-0"]').contains("Warehouse PG");

    cy.get('[data-cy="ai-builder-confirm-step-0"]').click();
    cy.wait("@confirmStep").its("request.body").should("deep.include", { stepId });
  });

  it("Reject calls the existing skip-step endpoint (declining is a skip, not a separate endpoint)", () => {
    const stepId = "step-confirm-2";

    reachApprovePrdButton("Build an inventory tracker");

    cy.intercept("POST", "**/api/ai/conversation/approve-prd", (req) => {
      req.reply({
        statusCode: 200,
        headers: { "content-type": "text/event-stream" },
        body: buildApprovePrdSSEBody(stepId),
      });
    }).as("approvePrd");
    cy.intercept("POST", "**/api/ai/conversation/skip-step").as("skipStep");

    cy.get('[data-cy="ai-builder-approve-prd-button"]').click();
    cy.wait("@approvePrd");

    cy.get('[data-cy="ai-builder-confirmation-banner-0"]', { timeout: 20000 }).should("be.visible");
    cy.get('[data-cy="ai-builder-reject-step-0"]').click();
    cy.wait("@skipStep").its("request.body").should("deep.include", { stepId });
  });
});
