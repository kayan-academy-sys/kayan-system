-- Booking availability is derived synchronously, never left to a periodic job.
CREATE OR REPLACE FUNCTION kayan_group_occupancy_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booked integer; threshold integer;
BEGIN
 IF NEW.capacity IS NULL OR NEW.capacity<1 THEN RAISE EXCEPTION 'Group capacity must be positive'; END IF;
 SELECT count(*) INTO booked FROM enrollments WHERE group_id=NEW.id AND status='active';
 IF NEW.capacity<booked THEN RAISE EXCEPTION 'Group capacity below active roster'; END IF;
 IF NEW.status IN ('open','nearly_full','full') THEN
  SELECT COALESCE((value::text)::integer,3) INTO threshold FROM settings WHERE key='nearly_full_threshold';
  threshold:=COALESCE(threshold,3);
  NEW.status:=CASE WHEN booked>=NEW.capacity THEN 'full' WHEN NEW.capacity-booked<=threshold THEN 'nearly_full' ELSE 'open' END;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS group_occupancy_status ON groups;
CREATE TRIGGER group_occupancy_status BEFORE INSERT OR UPDATE OF capacity,status ON groups FOR EACH ROW EXECUTE FUNCTION kayan_group_occupancy_status();
CREATE OR REPLACE FUNCTION kayan_roster_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_group integer;new_group integer;gid integer;
BEGIN
 IF TG_OP<>'INSERT' THEN old_group:=OLD.group_id; END IF;
 IF TG_OP<>'DELETE' THEN new_group:=NEW.group_id; END IF;
 FOR gid IN SELECT DISTINCT x FROM unnest(ARRAY[old_group,new_group]) x WHERE x IS NOT NULL ORDER BY x LOOP
  UPDATE groups SET status=status WHERE id=gid;
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS roster_occupancy_status ON enrollments;
CREATE TRIGGER roster_occupancy_status AFTER INSERT OR UPDATE OF group_id,status OR DELETE ON enrollments FOR EACH ROW EXECUTE FUNCTION kayan_roster_status();
UPDATE groups SET status=status WHERE status IN ('open','nearly_full','full');
