import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ChatTurn } from "../../domain/types.js";
import { ProfileStore } from "../../memory/profile.js";
import { toErrorMessage } from "../../util/errors.js";
import type {
  AgentDependencies,
  MemorySource,
  TravelRunConfigurable,
  TravelState,
  TravelStateUpdate,
} from "../state.js";

function sameTurn(a: ChatTurn | undefined, b: ChatTurn | undefined): boolean {
  return a !== undefined && b !== undefined && a.role === b.role && a.content === b.content;
}

/**
 * Entry node: assembles the context this turn will work with.
 *
 * 1. Resets the turn-scoped channels restored by the checkpointer.
 * 2. Reconciles short-term memory with the client transcript:
 *    - server memory present and consistent -> use it ("checkpoint")
 *    - no server memory, or it is stale (another replica served the last
 *      turn, or the pod restarted)          -> re-seed from the client ("client-history")
 * 3. Loads the user's long-term profile from the store.
 */
export function createLoadMemoryNode(deps: AgentDependencies) {
  return async function loadMemory(
    state: TravelState,
    config: LangGraphRunnableConfig,
  ): Promise<TravelStateUpdate> {
    const update: TravelStateUpdate = {
      notes: { replace: [] },
      errors: { replace: [] },
      trace: { replace: ["loadMemory"] },
    };

    const window = deps.memoryWindowTurns ?? 10;
    const clientHistory = state.history.slice(-window * 2);
    const serverIsCurrent =
      state.messages.length > 0 &&
      (clientHistory.length === 0 || sameTurn(state.messages.at(-1), clientHistory.at(-1)));

    let source: MemorySource;
    if (serverIsCurrent) {
      source = "checkpoint";
    } else if (clientHistory.length > 0) {
      source = "client-history";
      update.messages = { replace: clientHistory };
      // The structured memory belonged to a transcript we just discarded.
      update.lastIntent = null;
    } else {
      source = "empty";
    }
    update.memorySource = source;

    const userId = (config.configurable as Partial<TravelRunConfigurable> | undefined)?.user_id;
    update.profile = null;
    if (userId && config.store) {
      try {
        update.profile = await new ProfileStore(config.store).load(userId);
      } catch (error) {
        // Memory is an enhancement: failing to read it must not fail the turn.
        deps.logger.warn("could not load user profile", { error: toErrorMessage(error) });
      }
    }

    deps.logger.debug("loaded memory", {
      source,
      windowTurns: Math.ceil((update.messages ? clientHistory : state.messages).length / 2),
      profile: update.profile !== null,
    });

    return update;
  };
}
