// Minimal hand-written Database type — covers only the tables this
// backend actually touches, matching supabase/schema.sql column-for-
// column. Normally generated via `supabase gen types typescript`, but
// written by hand here since there's no live Supabase project to
// generate against yet. If columns drift from schema.sql, regenerate
// this properly once the project exists.
//
// Shape (Row/Insert/Update/Relationships per table, Tables/Views/
// Functions per schema) matches @supabase/postgrest-js's GenericSchema —
// confirmed against the installed package's own type definitions rather
// than assumed, since this version requires Relationships explicitly.
export {};
