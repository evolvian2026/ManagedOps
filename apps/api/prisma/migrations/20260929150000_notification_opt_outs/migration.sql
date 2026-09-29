-- Per-event control over what reaches somebody's phone.
--
-- One switch used to be the whole of it, on the argument that everything we
-- send is something the person needs. That holds for whether to use the channel
-- at all; it does not hold for each event. A trainer who checks the app daily
-- has no use for a message about every expense claim, and making them choose
-- between all of it and none of it is how a channel gets switched off whole —
-- taking the document reminders with it, which are the ones that cost them
-- site access when missed.

CREATE TABLE "notification_opt_outs" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "type"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_opt_outs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "notification_opt_outs" ADD CONSTRAINT "notification_opt_outs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One refusal per person per event. Declining twice is the same state as
-- declining once, and two rows would make "have they opted out?" a count.
CREATE UNIQUE INDEX "notification_opt_outs_userId_type_key"
    ON "notification_opt_outs"("userId", "type");

-- The send path asks this of one person at a time.
CREATE INDEX "notification_opt_outs_userId_idx" ON "notification_opt_outs"("userId");

-- The one message that is sent before anybody could have chosen about it: it
-- goes out when the account is created, so a row refusing it was never a
-- decision the person made here. Refused in the schema too, so a future write
-- path cannot create one that the send point would then have to ignore.
ALTER TABLE "notification_opt_outs" ADD CONSTRAINT "notification_opt_outs_declinable"
    CHECK ("type" <> 'credentials_issued');
