-- ---------------------------------------------------------------------------
-- langgraph-travel-agent : PostgreSQL schema
--
-- Apply with:
--   psql "$DATABASE_URL" -f db/schema.sql
-- then load the seeded JSON dataset with:
--   DATABASE_URL=... npm run load:postgres
--
-- The JSON repository is the default; this schema exists so that
-- PostgresFlightRepository is a drop-in replacement (FLIGHT_REPOSITORY=postgres)
-- without touching the LangGraph nodes.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS airports (
  iata        CHAR(3)     PRIMARY KEY,
  name        TEXT        NOT NULL,
  city        TEXT        NOT NULL,
  country     TEXT        NOT NULL,
  time_zone   TEXT        NOT NULL
);

CREATE TABLE IF NOT EXISTS airlines (
  iata        CHAR(2)     PRIMARY KEY,
  name        TEXT        NOT NULL
);

CREATE TABLE IF NOT EXISTS flight_offers (
  id                TEXT        PRIMARY KEY,
  owner_iata        CHAR(2)     NOT NULL REFERENCES airlines (iata),
  cabin_class       TEXT        NOT NULL
                                CHECK (cabin_class IN ('economy', 'premium_economy', 'business', 'first')),
  total_amount      NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
  total_currency    CHAR(3)     NOT NULL,
  seats_available   SMALLINT    NOT NULL CHECK (seats_available >= 0),
  refundable        BOOLEAN     NOT NULL DEFAULT FALSE,
  baggage_included  SMALLINT    NOT NULL DEFAULT 0,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flight_slices (
  id            TEXT        PRIMARY KEY,
  offer_id      TEXT        NOT NULL REFERENCES flight_offers (id) ON DELETE CASCADE,
  position      SMALLINT    NOT NULL DEFAULT 0,
  origin        CHAR(3)     NOT NULL REFERENCES airports (iata),
  destination   CHAR(3)     NOT NULL REFERENCES airports (iata),
  departing_at  TIMESTAMPTZ NOT NULL,
  arriving_at   TIMESTAMPTZ NOT NULL,
  duration_min  INTEGER     NOT NULL CHECK (duration_min > 0),
  UNIQUE (offer_id, position)
);

CREATE TABLE IF NOT EXISTS flight_segments (
  id                TEXT        PRIMARY KEY,
  slice_id          TEXT        NOT NULL REFERENCES flight_slices (id) ON DELETE CASCADE,
  position          SMALLINT    NOT NULL DEFAULT 0,
  carrier_iata      CHAR(2)     NOT NULL REFERENCES airlines (iata),
  flight_number     TEXT        NOT NULL,
  aircraft          TEXT        NOT NULL,
  origin            CHAR(3)     NOT NULL REFERENCES airports (iata),
  destination       CHAR(3)     NOT NULL REFERENCES airports (iata),
  departing_at      TIMESTAMPTZ NOT NULL,
  arriving_at       TIMESTAMPTZ NOT NULL,
  duration_min      INTEGER     NOT NULL CHECK (duration_min > 0),
  UNIQUE (slice_id, position)
);

-- Search path: route + departure day, then price.
CREATE INDEX IF NOT EXISTS idx_slices_route_departure
  ON flight_slices (origin, destination, departing_at);
CREATE INDEX IF NOT EXISTS idx_offers_price
  ON flight_offers (cabin_class, total_amount);

-- ---------------------------------------------------------------------------
-- Read model: one row per offer, with the API-shaped JSON payload pre-built.
-- `buildFlightSearchSql()` filters on the scalar columns and returns `payload`,
-- so the repository does no row-to-object assembly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW flight_offer_json AS
SELECT
  o.id,
  s.origin,
  s.destination,
  s.departing_at,
  (s.departing_at AT TIME ZONE 'UTC')::date       AS departing_on,
  o.cabin_class,
  o.total_amount,
  o.total_currency,
  o.seats_available,
  jsonb_build_object(
    'id',              o.id,
    'owner',           jsonb_build_object('iata', al.iata, 'name', al.name),
    'cabinClass',      o.cabin_class,
    'totalAmount',     to_char(o.total_amount, 'FM9999999990.00'),
    'totalCurrency',   o.total_currency,
    'seatsAvailable',  o.seats_available,
    'refundable',      o.refundable,
    'baggageIncluded', o.baggage_included,
    'expiresAt',       to_char(o.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'slices',          jsonb_build_array(
      jsonb_build_object(
        'id',              s.id,
        'origin',          s.origin,
        'destination',     s.destination,
        'departingAt',     to_char(s.departing_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:00'),
        'arrivingAt',      to_char(s.arriving_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:00'),
        'durationMinutes', s.duration_min,
        'segments',        COALESCE(seg.segments, '[]'::jsonb)
      )
    )
  ) AS payload
FROM flight_offers o
JOIN airlines al
  ON al.iata = o.owner_iata
JOIN flight_slices s
  ON s.offer_id = o.id AND s.position = 0
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
           jsonb_build_object(
             'id',               g.id,
             'marketingCarrier', jsonb_build_object('iata', ca.iata, 'name', ca.name),
             'flightNumber',     g.flight_number,
             'aircraft',         g.aircraft,
             'origin',           g.origin,
             'destination',      g.destination,
             'departingAt',      to_char(g.departing_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:00'),
             'arrivingAt',       to_char(g.arriving_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:00'),
             'durationMinutes',  g.duration_min
           )
           ORDER BY g.position
         ) AS segments
  FROM flight_segments g
  JOIN airlines ca ON ca.iata = g.carrier_iata
  WHERE g.slice_id = s.id
) seg ON TRUE;
