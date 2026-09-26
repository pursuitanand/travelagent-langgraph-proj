/**
 * The subset of the Duffel API (https://duffel.com/docs/api/v2) this service
 * reads. Deliberately partial and defensive: every field the mapper does not
 * strictly require is optional, so an additive change on Duffel's side cannot
 * break deserialisation.
 */

export interface DuffelAirline {
  id?: string;
  iata_code?: string | null;
  name?: string | null;
}

export interface DuffelAirport {
  id?: string;
  iata_code?: string | null;
  name?: string | null;
  city_name?: string | null;
  city?: { name?: string | null } | null;
  iata_country_code?: string | null;
  time_zone?: string | null;
}

export interface DuffelAircraft {
  iata_code?: string | null;
  name?: string | null;
}

export interface DuffelBaggage {
  /** "checked" | "carry_on" */
  type?: string | null;
  quantity?: number | null;
}

export interface DuffelSegmentPassenger {
  passenger_id?: string;
  cabin_class?: string | null;
  cabin_class_marketing_name?: string | null;
  baggages?: DuffelBaggage[] | null;
}

export interface DuffelSegment {
  id?: string;
  origin?: DuffelAirport | null;
  destination?: DuffelAirport | null;
  /** Local time at the airport, WITHOUT an offset: "2026-10-20T09:00:00". */
  departing_at?: string | null;
  arriving_at?: string | null;
  /** ISO-8601 duration, e.g. "PT11H50M". */
  duration?: string | null;
  marketing_carrier?: DuffelAirline | null;
  marketing_carrier_flight_number?: string | null;
  operating_carrier?: DuffelAirline | null;
  aircraft?: DuffelAircraft | null;
  passengers?: DuffelSegmentPassenger[] | null;
}

export interface DuffelSlice {
  id?: string;
  origin?: DuffelAirport | null;
  destination?: DuffelAirport | null;
  duration?: string | null;
  segments?: DuffelSegment[] | null;
}

export interface DuffelConditionChange {
  allowed?: boolean | null;
  penalty_amount?: string | null;
  penalty_currency?: string | null;
}

export interface DuffelConditions {
  refund_before_departure?: DuffelConditionChange | null;
  change_before_departure?: DuffelConditionChange | null;
}

export interface DuffelOffer {
  id: string;
  total_amount?: string | null;
  total_currency?: string | null;
  owner?: DuffelAirline | null;
  expires_at?: string | null;
  conditions?: DuffelConditions | null;
  slices?: DuffelSlice[] | null;
}

export interface DuffelOfferRequestResponse {
  data?: {
    id?: string;
    offers?: DuffelOffer[] | null;
  } | null;
}

export interface DuffelOfferResponse {
  data?: DuffelOffer | null;
}

export interface DuffelAirportListResponse {
  data?: DuffelAirport[] | null;
  meta?: { after?: string | null; limit?: number | null } | null;
}

/** Duffel's standard error envelope. */
export interface DuffelErrorResponse {
  errors?: Array<{
    type?: string;
    title?: string;
    message?: string;
    code?: string;
  }> | null;
  meta?: { request_id?: string; status?: number } | null;
}
