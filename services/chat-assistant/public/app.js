/**
 * Chat UI for the LangGraph travel agent.
 *
 * No business logic and no credentials live here: it posts the user's message
 * to this server's /api/chat, which forwards it to the agent.
 */
import {
  escapeHtml,
  renderFlightCards,
  renderMarkdown,
  renderSources,
} from "/render.js";

const chatEl = document.getElementById("chat");
const formEl = document.getElementById("composer");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

/** Rolling conversation, sent back so the agent can resolve follow-ups. */
const history = [];
let conversationId = null;
let busy = false;

function appendMessage(role, innerHtml, extraClass = "") {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  wrapper.innerHTML = `
    <div class="avatar" aria-hidden="true">${role === "user" ? "🧍" : "✈"}</div>
    <div class="bubble ${extraClass}">${innerHtml}</div>`;
  chatEl.append(wrapper);
  chatEl.scrollTop = chatEl.scrollHeight;
  return wrapper;
}

function appendThinking() {
  return appendMessage(
    "assistant",
    '<div class="thinking"><span></span><span></span><span></span></div>',
  );
}

async function checkBackend() {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    const body = await response.json();
    statusDot.className = response.ok ? "dot ok" : "dot down";
    statusText.textContent = response.ok ? "connected" : "degraded";
    statusDot.title = body.backendUrl ?? "";
  } catch {
    statusDot.className = "dot down";
    statusText.textContent = "offline";
  }
}

async function sendMessage(message) {
  if (busy || typeof message !== "string" || message.trim() === "") return;
  busy = true;
  sendEl.disabled = true;

  appendMessage("user", `<p>${escapeHtml(message)}</p>`);
  const pending = appendThinking();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        history: history.slice(-10),
        ...(conversationId ? { conversationId } : {}),
      }),
    });

    const payload = await response.json().catch(() => ({}));
    pending.remove();

    if (!response.ok) {
      appendMessage(
        "assistant",
        `<p>${escapeHtml(payload.error ?? `Request failed with status ${response.status}.`)}</p>`,
        "error",
      );
      return;
    }

    conversationId = payload.conversationId ?? conversationId;

    appendMessage(
      "assistant",
      [
        renderMarkdown(payload.reply ?? ""),
        renderFlightCards("Outbound", payload.flights?.outbound),
        renderFlightCards("Return", payload.flights?.inbound),
        renderSources(payload.sources),
      ].join(""),
    );

    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: payload.reply ?? "" });
  } catch (error) {
    pending.remove();
    appendMessage(
      "assistant",
      `<p>Could not reach the travel agent: ${escapeHtml(error.message)}</p>`,
      "error",
    );
  } finally {
    busy = false;
    sendEl.disabled = false;
    inputEl.focus();
  }
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = inputEl.value;
  inputEl.value = "";
  inputEl.style.height = "auto";
  void sendMessage(message);
});

// Enter sends, Shift+Enter inserts a newline.
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
});

document.getElementById("suggestions")?.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (chip) void sendMessage(chip.dataset.prompt);
});

void checkBackend();
setInterval(checkBackend, 30_000);
inputEl.focus();
