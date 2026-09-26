import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn } from "../domain/types.js";
import type { Logger } from "../util/logger.js";
import { silentLogger } from "../util/logger.js";
import {
  renderBrief,
  TemplateResponseGenerator,
  type GenerateInput,
  type GenerateOutput,
  type ResponseGenerator,
} from "./ResponseGenerator.js";

export interface AnthropicResponseGeneratorOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  logger?: Logger;
  /** Injectable for tests. */
  client?: Anthropic;
}

const SYSTEM_PROMPT = `You are the reply writer for a travel-planning agent.

A LangGraph pipeline has already searched flight inventory and the web; you
receive its brief and turn it into the traveller-facing answer.

Rules:
- Use only the flights in the brief. Never invent a flight, price, time or airline.
- Lead with the recommendation, then list the concrete options.
- Keep prices, times, airlines and flight numbers exactly as given.
- When web research is present, weave in one or two useful facts and link the
  source inline as a markdown link.
- If the brief has no flights, say so plainly and ask for the one detail that
  would unblock the search.
- Format as short markdown: a sentence or two, then a compact bullet list.
  No headings above level 3, no tables, under 220 words.`;

/**
 * Writes the final reply with Claude, falling back to the deterministic
 * template responder when the API is unavailable or declines the request.
 *
 * The API key is read from the environment on the server only.
 */
export class AnthropicResponseGenerator implements ResponseGenerator {
  readonly name = "anthropic";

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
  private readonly logger: Logger;
  private readonly fallback = new TemplateResponseGenerator();

  constructor(options: AnthropicResponseGeneratorOptions) {
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        timeout: options.timeoutMs ?? 45_000,
        maxRetries: 2,
      });
    this.model = options.model ?? "claude-opus-5";
    this.maxTokens = options.maxTokens ?? 8000;
    this.effort = options.effort ?? "low";
    this.logger = options.logger ?? silentLogger;
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
        output_config: { effort: this.effort },
        // Server-side fallback: if a safety classifier declines the request,
        // the platform re-routes it instead of returning an unusable turn.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [
          ...toApiHistory(input.history),
          { role: "user", content: renderBrief(input.brief) },
        ],
      });

      if (response.stop_reason === "refusal") {
        this.logger.warn("model declined the request; using template responder", {
          category: response.stop_details?.category ?? null,
        });
        return this.fallback.generate(input);
      }

      const text = response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      if (text === "") {
        this.logger.warn("model returned no text; using template responder");
        return this.fallback.generate(input);
      }

      return { text, generator: this.name, model: response.model };
    } catch (error) {
      this.logger.error("anthropic call failed; using template responder", {
        error: describeApiError(error),
      });
      return this.fallback.generate(input);
    }
  }
}

function toApiHistory(history: ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
  // Keep the prompt bounded: only the last few turns matter for a follow-up.
  return history.slice(-6).map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));
}

function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return "rate limited (429)";
  if (error instanceof Anthropic.AuthenticationError) return "authentication failed (401)";
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "request timed out";
  if (error instanceof Anthropic.APIError) return `api error ${error.status ?? "unknown"}`;
  return error instanceof Error ? error.message : String(error);
}
