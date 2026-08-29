// Covers ticket #12: the /home GetStartedHome AI prompt section.
//
// Edition gating matters here: withAdminOrBuilderOnly redirects /home to the dashboard
// whenever the build is CE (fetchEdition reads the webpack-inlined TOOLJET_EDITION), so
// the prompt section only actually renders in cloud/ee builds. This repo's fork has no
// EE modules (frontend/ee/ is empty), so only the CE-redirect test can run locally; the
// section tests are gated on `--env edition=<non-ce>` and belong in a CI that builds a
// non-CE frontend. The section composes CreateAppWithPrompt in its "home" variant
// (rotating placeholder, no example chips) with the shared useCreateAppFromPrompt
// handoff, so the submit assertions mirror aiBuilderCreateAppWithPrompt.cy.js — same
// real-backend convention, same reliance on a configured OpenAI-compatible endpoint.
import { dashboardSelector } from "Selectors/dashboard";
const edition = Cypress.env('edition') || 'ce';

describe('AI Builder - /home prompt section (empty workspace entry point)', () => {
  beforeEach(() => {
    cy.defaultWorkspaceLogin();
    cy.skipWalkthrough();
    cy.viewport(2000, 1900);
  });

  it('redirects /home to the dashboard on a CE build', { env: { edition: 'ce' } }, () => {
    if (edition !== 'ce') {
      cy.log('skipping: not a CE build');
      return;
    }

    cy.visit('/my-workspace/home', { failOnStatusCode: false });
    cy.url({ timeout: 20000 }).should('not.include', '/home');
    // The dashboard's own apps-list prompt entry is where CE lands instead.
    cy.get(dashboardSelector.homePagePromptTextArea, { timeout: 20000 }).should('be.visible');
  });

  (edition === 'ce' ? describe.skip : describe)('prompt section (non-CE build only)', () => {
    it('renders the prompt section on /home above the OR START WITH cards', () => {
      cy.visit('/my-workspace/home');

      cy.get('[data-cy="home-page-prompt-section"]', { timeout: 20000 }).should('be.visible');
      // Banner header (ticket #44): spark icon + title above the prompt bar.
      cy.get('[data-cy="ai-icon"]').should('be.visible');
      cy.get('[data-cy="home-page-prompt-header"]')
        .should('be.visible')
        .and('have.text', 'What do you want to build today?');
      cy.get(dashboardSelector.homePagePromptTextArea).should('be.visible');
      // Home variant: no example-chips row below the prompt bar.
      cy.get('[data-cy="example-prompts-row"]').should('not.exist');
      // Empty input shows the Example prompts dropdown; the submit button stays hidden
      // until text is typed (ticket #45 swap).
      cy.get('[data-cy="example-prompts-dropdown"]').should('be.visible');
      cy.get('[data-cy="create-app-with-prompt-submit-button"]').should('not.be.visible');
      // Composes cleanly with the already-built get-started options below it.
      cy.get('[data-cy="divider-text"]').should('be.visible').and('have.text', 'OR START WITH');
      cy.get('[data-cy="getstarted-app-widget"]').should('be.visible');
    });

    it('fills the input from the Example prompts dropdown and swaps it for the submit button', () => {
      cy.visit('/my-workspace/home');

      cy.get('[data-cy="example-prompts-dropdown"]', { timeout: 20000 }).should('be.visible').click();
      cy.get('[data-cy="example-prompts-option-task-manager"]').click();

      // Selecting an example fills the input and flips the swap: submit visible+enabled,
      // dropdown gone.
      cy.get(dashboardSelector.homePagePromptTextArea).should(($input) => {
        expect($input[0].textContent.length).to.be.greaterThan(200);
      });
      cy.get('[data-cy="create-app-with-prompt-submit-button"]').should('be.visible').and('be.enabled');
      cy.get('[data-cy="example-prompts-dropdown"]').should('not.be.visible');
    });

    it('accepts the rotating example with Tab', () => {
      cy.visit('/my-workspace/home');

      cy.get(dashboardSelector.homePagePromptTextArea, { timeout: 20000 }).should('be.visible').focus();
      cy.realPress('Tab');

      // The Tab handler fills the input with the currently shown example (one of the
      // rotating set, per CreateAppWithPrompt's ROTATING_EXAMPLES), and the submit button
      // only enables once there is text to send.
      cy.get(dashboardSelector.homePagePromptTextArea).should(($input) => {
        const value = $input[0].textContent.trim();
        expect([
          'Build an inventory management system for a manufacturing company',
          'Build a customer support ticketing system for SaaS startup',
          'Build a vendor onboarding portal for procurement department',
          'Build a compliance audit tracker for a finance company',
        ]).to.include(value);
      });
      cy.get('[data-cy="create-app-with-prompt-submit-button"]').should('be.enabled');
    });

    it('creates a new app from a /home prompt and lands in the builder with the prompt already sent', () => {
      const prompt = 'Build an asset register for a facilities team';

      cy.visit('/my-workspace/home');

      cy.intercept('POST', '**/api/apps').as('createApp');
      cy.intercept('POST', '**/api/ai/conversation').as('createConversation');
      cy.intercept('POST', '**/api/ai/conversation/message').as('sendMessage');

      cy.get(dashboardSelector.homePagePromptTextArea, { timeout: 20000 }).should('be.visible');
      cy.get('[data-cy="create-app-with-prompt-submit-button"]').should('be.disabled');

      cy.get(dashboardSelector.homePagePromptTextArea).type(prompt);
      cy.get('[data-cy="create-app-with-prompt-submit-button"]').should('be.enabled').click();

      cy.wait('@createApp');
      cy.url({ timeout: 20000 }).should('match', /\/apps\/[^/]+$/);

      cy.get('[data-cy="ai-builder-chat-panel"]', { timeout: 20000 }).should('be.visible');

      cy.wait('@createConversation');
      cy.wait('@sendMessage', { timeout: 30000 });

      // The typed prompt is the first message, already sent (not sitting in the input box).
      cy.get('[data-cy="ai-builder-chat-panel"]').contains(prompt).should('be.visible');
      cy.get('[data-cy="ai-builder-message-input"]').should('have.value', '');
    });
  });
});
