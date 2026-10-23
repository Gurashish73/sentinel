BEGIN;

-- Lock tables in the same order as incident mutation paths:
-- incident first, then event. This prevents new incident mutations
-- while the event backfill and trigger installation are in progress.
LOCK TABLE "Incident" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "Event" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "Event"
ADD COLUMN "streamSequence" INTEGER;

CREATE TABLE "EventStreamCursor" (
    "incidentId" TEXT NOT NULL,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EventStreamCursor_pkey" PRIMARY KEY ("incidentId")
);

ALTER TABLE "EventStreamCursor"
ADD CONSTRAINT "EventStreamCursor_incidentId_fkey"
FOREIGN KEY ("incidentId")
REFERENCES "Incident"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- Assign deterministic sequence positions to existing events.
-- This establishes their initial order; new events use the trigger below.
WITH numbered_events AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "incidentId"
            ORDER BY "createdAt" ASC, "id" ASC
        )::INTEGER AS sequence
    FROM "Event"
    WHERE "incidentId" IS NOT NULL
)
UPDATE "Event" AS e
SET "streamSequence" = n.sequence
FROM numbered_events AS n
WHERE e."id" = n."id";

-- Initialize each incident's cursor to its highest existing sequence.
INSERT INTO "EventStreamCursor" ("incidentId", "lastSequence")
SELECT
    "incidentId",
    MAX("streamSequence")
FROM "Event"
WHERE "incidentId" IS NOT NULL
GROUP BY "incidentId";

CREATE UNIQUE INDEX "Event_incidentId_streamSequence_key"
ON "Event"("incidentId", "streamSequence");

-- Allocate the next sequence while holding a row lock on the cursor.
-- PostgreSQL retains this lock until the inserting transaction ends,
-- preventing a later sequence from becoming visible before an earlier one.
CREATE OR REPLACE FUNCTION public.assign_event_stream_sequence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW."incidentId" IS NULL THEN
        NEW."streamSequence" := NULL;
        RETURN NEW;
    END IF;

    INSERT INTO public."EventStreamCursor" (
        "incidentId",
        "lastSequence"
    )
    VALUES (NEW."incidentId", 0)
    ON CONFLICT ("incidentId") DO NOTHING;

    UPDATE public."EventStreamCursor"
    SET "lastSequence" = "lastSequence" + 1
    WHERE "incidentId" = NEW."incidentId"
    RETURNING "lastSequence" INTO NEW."streamSequence";

    IF NEW."streamSequence" IS NULL THEN
        RAISE EXCEPTION
            'Unable to allocate event sequence for incident %',
            NEW."incidentId";
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "Event_assign_stream_sequence_before_insert"
BEFORE INSERT ON "Event"
FOR EACH ROW
EXECUTE FUNCTION public.assign_event_stream_sequence();

COMMIT;
