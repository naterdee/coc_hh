# coc_hh
Super secret coordination team project A
Log in by going to naterdee.github.io/coc_hh and entering password.

## Calendar setup

Before using the Calendar view, run [`migration_calendar.sql`](./migration_calendar.sql) in the Supabase SQL Editor. It creates recurring-meeting, meeting-log, and canceled-occurrence tables and converts existing complete recurring meetings from the people table. Existing person notes and logs remain unchanged.

Recurring meetings are weekly by default. The week schedule lets you cancel or restore an individual occurrence without changing the recurring schedule. Open an occurrence to view or add logs for that date; use **All meeting logs** to browse the log history.

The menu exports people, recurring meetings, and logs separately. Importing an older people CSV with the previous single-meeting columns converts complete meeting rows to recurring meetings.
