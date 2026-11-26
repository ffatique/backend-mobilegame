ALTER TABLE players ADD COLUMN avatar TEXT;
CREATE TABLE pier_saves (
  "playerId" UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
  mutation UUID, bait INTEGER NOT NULL DEFAULT 12 CHECK (bait BETWEEN 0 AND 12),
  day DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date
);
CREATE INDEX pier_saves_day_idx ON pier_saves(day);
CREATE TABLE friendships (
  low UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  high UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  sender UUID NOT NULL, accepted BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY(low, high), CHECK(low < high AND sender IN (low,high))
);
CREATE INDEX friendships_high_idx ON friendships(high);
CREATE INDEX players_name_search_idx ON players (lower(name) text_pattern_ops);
CREATE TABLE pier_catches (
  "playerId" UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
  species INTEGER NOT NULL, rare BOOLEAN NOT NULL, length INTEGER NOT NULL, grams INTEGER NOT NULL,
  size VARCHAR(2) NOT NULL, "caughtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY("playerId",revision)
);
