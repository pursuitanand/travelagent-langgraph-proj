import type { BaseStore } from "@langchain/langgraph";
import { z } from "zod";
import type { Airport, CabinClass, TravelIntent } from "../domain/types.js";

/**
 * Long-term, cross-session memory about one traveller.
 *
 * This is the TypeScript equivalent of a Python `TypedDict`: a plain,
 * JSON-serialisable record with a fixed set of typed keys. It is stored in the
 * LangGraph `BaseStore` (not in graph state), so it outlives any single
 * conversation thread.
 */
export interface UserProfile {
  /** Most recent departure airport the traveller searched from. */
  homeAirport: Airport | null;
  /** Last cabin the traveller asked for explicitly. */
  preferredCabin: CabinClass | null;
  /** Party size of the last complete search. */
  typicalPassengers: number | null;
  /** Up to five most recent destinations, newest first, e.g. "Tokyo (NRT)". */
  recentDestinations: string[];
  /** How many complete searches have shaped this profile. */
  searchesObserved: number;
  updatedAt: string | null;
}

const airportSchema = z.object({
  iata: z.string(),
  name: z.string(),
  city: z.string(),
  country: z.string(),
  timeZone: z.string(),
});

/**
 * Runtime twin of `UserProfile`. The store hands back `Record<string, any>`,
 * so anything read from it is validated before it is trusted as typed context.
 */
export const userProfileSchema = z.object({
  homeAirport: airportSchema.nullable(),
  preferredCabin: z.enum(["economy", "premium_economy", "business", "first"]).nullable(),
  typicalPassengers: z.number().int().positive().nullable(),
  recentDestinations: z.array(z.string()).max(5),
  searchesObserved: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
});

const MAX_RECENT_DESTINATIONS = 5;

export function emptyProfile(): UserProfile {
  return {
    homeAirport: null,
    preferredCabin: null,
    typicalPassengers: null,
    recentDestinations: [],
    searchesObserved: 0,
    updatedAt: null,
  };
}

/**
 * Pure "memory write" policy: folds one turn's intent into the profile.
 * Only complete searches teach the profile anything, so a vague question
 * ("is it rainy in May?") never overwrites what we already know.
 */
export function learnFromIntent(
  profile: UserProfile,
  intent: TravelIntent,
  now: Date,
): UserProfile {
  if (!intent.searchable || !intent.origin || !intent.destination) return profile;

  const destination = `${intent.destination.city} (${intent.destination.iata})`;
  return {
    homeAirport: intent.origin,
    preferredCabin: intent.cabinClass ?? profile.preferredCabin,
    typicalPassengers: intent.passengers,
    recentDestinations: [
      destination,
      ...profile.recentDestinations.filter((d) => d !== destination),
    ].slice(0, MAX_RECENT_DESTINATIONS),
    searchesObserved: profile.searchesObserved + 1,
    updatedAt: now.toISOString(),
  };
}

/**
 * Thin, typed facade over the LangGraph store.
 *
 * Namespace layout: ["users", <userId>] / key "travel-profile". Namespacing by
 * user is what keeps one traveller's memory out of another's context.
 */
export class ProfileStore {
  static readonly KEY = "travel-profile";

  constructor(private readonly store: BaseStore) {}

  static namespace(userId: string): string[] {
    return ["users", userId];
  }

  async load(userId: string): Promise<UserProfile | null> {
    const item = await this.store.get(ProfileStore.namespace(userId), ProfileStore.KEY);
    if (!item) return null;
    const parsed = userProfileSchema.safeParse(item.value);
    // A corrupt or outdated record is ignored rather than poisoning the prompt.
    return parsed.success ? parsed.data : null;
  }

  async save(userId: string, profile: UserProfile): Promise<void> {
    await this.store.put(ProfileStore.namespace(userId), ProfileStore.KEY, { ...profile });
  }

  async delete(userId: string): Promise<void> {
    await this.store.delete(ProfileStore.namespace(userId), ProfileStore.KEY);
  }
}
