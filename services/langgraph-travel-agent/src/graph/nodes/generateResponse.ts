import { toErrorMessage } from "../../util/errors.js";
import type { AgentDependencies, TravelState, TravelStateUpdate } from "../state.js";

/**
 * Terminal node: hands the combined brief to the response generator
 * (Claude, or the deterministic template responder when no API key is set).
 */
export function createGenerateResponseNode(deps: AgentDependencies) {
  return async function generateResponse(state: TravelState): Promise<TravelStateUpdate> {
    if (!state.brief) {
      return {
        reply: "Something went wrong assembling the answer. Please try again.",
        responder: "none",
        errors: ["generateResponse: no brief available"],
        trace: ["generateResponse:error"],
      };
    }

    try {
      const result = await deps.responder.generate({
        brief: state.brief,
        // Short-term memory (the trimmed window) and long-term memory (profile).
        history: state.messages,
        profile: state.profile,
      });
      return {
        reply: result.text,
        responder: result.model ? `${result.generator}:${result.model}` : result.generator,
        trace: ["generateResponse"],
      };
    } catch (error) {
      const message = toErrorMessage(error);
      deps.logger.error("response generation failed", { error: message });
      return {
        reply:
          "I found the data but could not write the summary. Please retry in a moment.",
        responder: "error",
        errors: [`generateResponse: ${message}`],
        trace: ["generateResponse:error"],
      };
    }
  };
}
