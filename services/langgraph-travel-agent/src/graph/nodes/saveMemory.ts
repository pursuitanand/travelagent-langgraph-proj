import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { emptyProfile, learnFromIntent, ProfileStore } from "../../memory/profile.js";
import { toErrorMessage } from "../../util/errors.js";
import type {
  AgentDependencies,
  TravelRunConfigurable,
  TravelState,
  TravelStateUpdate,
} from "../state.js";

/**
 * Terminal node: writes this turn back to memory.
 *
 * - Short-term: appends the user/assistant pair to `messages` and trims the
 *   window to `memoryWindowTurns`, so the context sent to the LLM stays
 *   bounded however long the session runs. The checkpointer persists it.
 * - Structured: stores the resolved intent as `lastIntent` for follow-ups.
 * - Long-term: folds the intent into the user's profile in the store.
 */
export function createSaveMemoryNode(deps: AgentDependencies) {
  return async function saveMemory(
    state: TravelState,
    config: LangGraphRunnableConfig,
  ): Promise<TravelStateUpdate> {
    const window = deps.memoryWindowTurns ?? 10;
    const messages = [
      ...state.messages,
      { role: "user" as const, content: state.message },
      { role: "assistant" as const, content: state.reply },
    ].slice(-window * 2);

    const update: TravelStateUpdate = {
      messages: { replace: messages },
      lastIntent: state.intent,
      trace: ["saveMemory"],
    };

    const userId = (config.configurable as Partial<TravelRunConfigurable> | undefined)?.user_id;
    if (userId && config.store && state.intent) {
      const before = state.profile ?? emptyProfile();
      const after = learnFromIntent(before, state.intent, deps.now());
      if (after !== before) {
        try {
          await new ProfileStore(config.store).save(userId, after);
          update.profile = after;
        } catch (error) {
          deps.logger.warn("could not save user profile", { error: toErrorMessage(error) });
          update.errors = [`saveMemory: ${toErrorMessage(error)}`];
        }
      }
    }

    return update;
  };
}
