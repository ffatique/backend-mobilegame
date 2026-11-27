CREATE TABLE pier_schools (
  "playerId" uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  id uuid PRIMARY KEY, station integer NOT NULL, species integer NOT NULL, slot integer NOT NULL,
  rare boolean NOT NULL, percentile integer NOT NULL, length integer NOT NULL, grams integer NOT NULL,
  UNIQUE ("playerId", station, species, slot)
);
CREATE TABLE pier_attempts (
  "playerId" uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  id uuid NOT NULL, station integer NOT NULL, "fishId" uuid, species integer,
  rare boolean, percentile integer, length integer, grams integer,
  "openedAt" timestamptz NOT NULL DEFAULT now(), "closedAt" timestamptz,
  outcome text, "finishKey" uuid, "passAvailable" boolean NOT NULL,
  "newRecord" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("playerId", id)
);
CREATE UNIQUE INDEX pier_one_open_attempt ON pier_attempts ("playerId") WHERE outcome IS NULL;
CREATE TABLE pier_refills (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(), accounts integer NOT NULL, duration_ms integer NOT NULL
);
