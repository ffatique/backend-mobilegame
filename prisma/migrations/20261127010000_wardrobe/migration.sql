ALTER TABLE pier_saves
  ADD COLUMN owned TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN outfit TEXT,
  ADD COLUMN hat TEXT;

CREATE TABLE pier_activity_days (
  "playerId" UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  PRIMARY KEY ("playerId", day)
);

INSERT INTO pier_activity_days ("playerId", day)
SELECT "playerId", "caughtAt"::date FROM pier_catches WHERE "caughtAt" <= CURRENT_TIMESTAMP
UNION
SELECT id, "createdAt"::date FROM players;
