import config from 'config';
import { authHeader, handleResponse } from '@/_helpers';
import { fetchEventSource } from '@microsoft/fetch-event-source';

export const aiService = {
  sendMessage,
  voteMessage,
  getCopilotSuggestion,
  getCreditBalance,
  fixWithAI,
  updateKey,
  getKeySettings,
  updateMessageData,
  listConversations,
  createConversation,
  getConversation,
  autoSort,
  getTokenUsage,
  fetchZeroState,
  getActiveRun,
  approvePrd,
  previewPlan,
  rewindStep,
  skipStep,
  confirmStep,
  interruptAnswer,
  regenerateMessage,
  promoteConversation,
};

function handleAITextResponse(response) {
  return response.text().then((text) => {
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw {
        error: data?.message || text || response.statusText,
        data: data || { message: text },
        statusCode: response?.status,
      };
    }

    return data ?? text;
  });
}

async function voteMessage(messageId, voteType) {
  const body = {
    messageId,
    voteType,
  };
  const requestOptions = { method: 'POST', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/ai/conversation/vote-message`, requestOptions).then(handleResponse);
}

async function postSSE(url, body, onMessage) {
  const fullResponse = [];
  await fetchEventSource(url, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
    retryStrategy: {
      next: () => null,
    },
    openWhenHidden: true,
    onopen: async (response) => {
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const err = new Error(data?.message || `HTTP error! status: ${response.status}`);
        err.statusCode = response.status;
        throw err;
      }
    },
    onmessage: (event) => {
      if (!event.data) return;
      try {
        const parsed = JSON.parse(event.data);
        fullResponse.push(parsed);
        const { event: type } = event;
        onMessage({
          data: parsed,
          type,
        });
      } catch (e) {
        console.log(e);
      }
    },
    onerror: (error) => {
      console.log(error);
      throw new Error(error);
    },
    onclose: () => {
      console.log('Connection closed');
    },
  });

  return fullResponse;
}

// `isDocs` picks the Learn conversation's endpoint (see AiService.sendUserDocsMessage on the
// backend): a different prompt and an App inventory for grounding, but the same SSE event
// contract (chunk/done/error), so callers handle both identically.
async function sendMessage(body, onMessage, isDocs = false) {
  const url = isDocs ? `${config.apiUrl}/ai/conversation/docs-message` : `${config.apiUrl}/ai/conversation/message`;
  return postSSE(url, body, onMessage);
}

// body: { conversationId, messageId }. Starts a new Generate conversation seeded with the
// promoted question/answer (ADR-0012) — the Learn conversation is left untouched. Not SSE:
// there's no LLM call on this path, just conversation/message creation.
async function promoteConversation(body) {
  const requestOptions = { method: 'POST', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/ai/conversation/promote`, requestOptions).then(handleResponse);
}

// body: { conversationId, prd }. SSE event contract (see AiService.approvePrd on the
// backend): plan, step-progress, step-done, step-failed, done, error.
async function approvePrd(body, onMessage) {
  return postSSE(`${config.apiUrl}/ai/conversation/approve-prd`, body, onMessage);
}

// body: { conversationId, dataSourceId }. Not SSE — preview-plan generates (or reuses) the
// plan for the conversation's latest PRD and returns it as plain JSON (see AiService.previewPlan
// on the backend); nothing executes (ticket #20).
async function previewPlan(body) {
  const requestOptions = {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  };
  return fetch(`${config.apiUrl}/ai/conversation/preview-plan`, requestOptions).then(handleResponse);
}

// body: { conversationId, stepId, inclusive? }. Not SSE — rewind is a synchronous DB/App
// undo, no LLM call is on this path (see AiService.rewindStep on the backend). `inclusive`
// (ticket #15) also discards the target step itself: undoing a whole failed build is an
// inclusive rewind to its first step.
async function rewindStep(body) {
  const requestOptions = { method: 'POST', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/ai/conversation/rewind-step`, requestOptions).then(handleResponse);
}

// body: { conversationId, stepId }. Not SSE — records the user's decision to skip a step of a
// running plan; the backend's execution loop picks it up at its next checkpoint (ticket #21).
async function skipStep(body) {
  const requestOptions = { method: 'POST', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/ai/conversation/skip-step`, requestOptions).then(handleResponse);
}

// body: { conversationId, stepId }. Ticket #77 / ADR-0025: records the user's explicit
// go-ahead on a CreateTable step targeting a connected PostgreSQL source (a
// 'step-awaiting-confirmation' SSE event on the approve-prd stream). Not SSE itself — the
// backend's execution loop poll picks the new status up (see AiService.confirmStep).
// TODO(#77 follow-up): no run-UI affordance calls this yet — see the ticket's PR body.
async function confirmStep(body) {
  const requestOptions = { method: 'POST', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/ai/conversation/confirm-step`, requestOptions).then(handleResponse);
}

// body: { conversationId, interruptId, answer }. ADR-0044: answers a paused interrupt (e.g.
// `select_datasource`) raised by an `interrupt` SSE event on the approve-prd stream. Not SSE
// itself — the backend's poll on the paused approvePrd request picks up the answer.
async function interruptAnswer(body) {
  const requestOptions = { method: 'POST', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/ai/conversation/interrupt-answer`, requestOptions).then(handleResponse);
}

// body: { parentMessageId }. Not SSE — the backend generates the full reply before
// responding (AiService.regenerateAiMessage), same as any other plain JSON endpoint here.
async function regenerateMessage(body) {
  const requestOptions = { method: 'POST', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/ai/conversation/regenerate-message`, requestOptions).then(handleResponse);
}

async function getCopilotSuggestion(body) {
  const requestOptions = { method: 'POST', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/ai/copilot`, requestOptions).then(handleAITextResponse);
}
async function getCreditBalance() {
  const requestOptions = { method: 'GET', headers: authHeader(), credentials: 'include' };

  return fetch(`${config.apiUrl}/ai/get-credits-balance`, requestOptions).then((response) =>
    handleResponse(response, undefined, undefined, true)
  );
}

async function fixWithAI(body) {
  const requestOptions = { method: 'POST', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/ai/fix-with-ai`, requestOptions).then(handleAITextResponse);
}

async function updateKey(body) {
  const requestOptions = { method: 'PATCH', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/ai/update-key`, requestOptions).then(handleResponse);
}

// `licenseType` is accepted for callers that already pass it, but the ticket #59 backend
// (AiController.getKeySettings) ignores query params entirely — the response is the same
// org-scoped BYOK settings regardless, so it's optional here (ticket #65).
async function getKeySettings(licenseType) {
  const requestOptions = { method: 'GET', headers: authHeader(), credentials: 'include' };
  const query = licenseType ? `?licenseType=${licenseType}` : '';
  return fetch(`${config.apiUrl}/ai/key-settings${query}`, requestOptions).then(handleResponse);
}

async function updateMessageData(messageId, body) {
  const requestOptions = { method: 'PATCH', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };

  return fetch(`${config.apiUrl}/ai/conversation/message/${messageId}`, requestOptions).then(handleResponse);
}

async function listConversations(appId, conversationType = 'generate') {
  const requestOptions = { method: 'GET', headers: authHeader(), credentials: 'include' };
  return fetch(
    `${config.apiUrl}/ai/conversations?appId=${appId}&conversationType=${conversationType}`,
    requestOptions
  ).then(handleResponse);
}

async function createConversation(payload) {
  const requestOptions = {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ ...payload, ...(!payload?.conversationType && { conversationType: 'generate' }) }),
  };
  return fetch(`${config.apiUrl}/ai/conversation`, requestOptions).then(handleResponse);
}

async function getConversation(conversationId) {
  const requestOptions = { method: 'GET', headers: authHeader(), credentials: 'include' };
  return fetch(`${config.apiUrl}/ai/conversation/${conversationId}`, requestOptions).then(handleResponse);
}

async function autoSort(body) {
  const requestOptions = {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  };
  return fetch(`${config.apiUrl}/ai/autosort`, requestOptions).then(handleAITextResponse);
}

async function getTokenUsage(conversationId) {
  const requestOptions = { method: 'GET', headers: authHeader(), credentials: 'include' };
  return fetch(`${config.apiUrl}/ai/conversation/${conversationId}/token-usage`, requestOptions).then(handleResponse);
}

async function getActiveRun(conversationId) {
  const requestOptions = { method: 'GET', headers: authHeader(), credentials: 'include' };
  return fetch(`${config.apiUrl}/ai/conversation/${conversationId}/active-run`, requestOptions).then(handleResponse);
}

async function fetchZeroState() {
  const requestOptions = { method: 'GET', headers: authHeader(), credentials: 'include' };
  return fetch(`${config.apiUrl}/ai/zero-state`, requestOptions).then(handleResponse);
}
