-- Two indexes repeat, column for column, one that already exists and serves
-- every query the duplicate served:
--
--   * "agent_steps_runId_position_idx" is the same (runId, position) pair as the
--     unique index created with the table. A unique index on those columns is
--     every lookup, range scan and ordering the plain one would have answered.
--     The reads that used it - the steps of a run, the count of a run's steps,
--     the reset of one run's unfinished steps - are unchanged: the query plan
--     is the same search on the same columns, only the index it names changes.
--
--   * "media_assets_createdAt_idx" is a strict prefix of
--     "media_assets_createdAt_id_idx", which has covered every media listing
--     on its own. SQLite uses the longer index for a range on the leading
--     column, so the shorter one was never chosen for any query.
--
-- Both are dropped with IF EXISTS: a database that never had them, or already
-- lost them, is left alone. No table, column or row is touched, so nothing to
-- convert and no data to back up beforehand.
DROP INDEX IF EXISTS "agent_steps_runId_position_idx";
DROP INDEX IF EXISTS "media_assets_createdAt_idx";
