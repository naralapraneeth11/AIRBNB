-- Removing a property from the app pauses its calendar links with their own
-- state, distinct from a link the host switched off ("DISABLED"), so that
-- restoring the property turns back on exactly the links the removal paused.
-- A paused link is always switched off. Constraint changes only: no table or
-- column changes, and every existing row already satisfies both checks, so
-- the previous release keeps working whether this runs before or after it is
-- replaced (MIG 01 expand step). Until it runs, removing a property fails as
-- a whole and changes nothing.
ALTER TABLE "ChannelConnection"
  DROP CONSTRAINT connection_health,
  ADD CONSTRAINT connection_health CHECK ("health" IN ('PENDING','HEALTHY','DEGRADED','FAILING','PAUSED_BY_SOURCE','EXPORT_ONLY','DISABLED','PROPERTY_REMOVED')),
  ADD CONSTRAINT connection_removed_paused CHECK ("health" <> 'PROPERTY_REMOVED' OR "enabled" = false);
