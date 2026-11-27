ALTER TABLE pier_saves ADD COLUMN "bonusBait" INTEGER NOT NULL DEFAULT 0 CHECK ("bonusBait" >= 0);
CREATE TABLE bait_operations (
  id UUID PRIMARY KEY, "playerId" UUID REFERENCES players(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('ad','purchase','guest')), day DATE NOT NULL,
  milestone INT, "transactionId" TEXT UNIQUE,
  installation CHAR(64), session UUID,
  CHECK ((kind='guest' AND installation IS NOT NULL AND session IS NOT NULL AND "playerId" IS NULL)
      OR (kind<>'guest' AND "playerId" IS NOT NULL AND installation IS NULL AND session IS NULL)),
  UNIQUE (installation,session,milestone),
  UNIQUE ("playerId", milestone)
);
CREATE INDEX bait_operations_quota ON bait_operations ("playerId", day, kind);
CREATE INDEX bait_operations_guest_quota ON bait_operations (installation,day);
