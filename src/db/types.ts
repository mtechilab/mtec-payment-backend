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

export interface Database {
  public: {
    Tables: {
      programmes: {
        Row: { id: string; name: string; department: string; duration_years: number; duration_label: string };
        Insert: Partial<Database["public"]["Tables"]["programmes"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["programmes"]["Row"]>;
        Relationships: [];
      };
      payment_plans: {
        Row: {
          id: string;
          student_row_id: string;
          programme_id: string;
          label: string;
          frequency: string;
          period_amount: number;
          total_amount: number;
          plan_start_date: string;
          plan_end_date: string;
          status: string;
          created_at: string;
          programmes?: { name: string; duration_years: number } | null;
          monime_recurrent_code_id: string | null;
          monime_recurrent_ussd_code: string | null;
          monime_recurrent_expire_time: string | null;
          monime_recurrent_amount: number | null;
        };
        Insert: Partial<Database["public"]["Tables"]["payment_plans"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["payment_plans"]["Row"]>;
        Relationships: [];
      };
      payment_periods: {
        Row: {
          id: string;
          payment_plan_id: string;
          period_label: string;
          period_index: number;
          due_date: string;
          amount_due: number;
          amount_paid: number;
          status: string;
        };
        Insert: Partial<Database["public"]["Tables"]["payment_periods"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["payment_periods"]["Row"]>;
        Relationships: [];
      };
      payment_submissions: {
        Row: {
          id: string;
          mtec_reference: string;
          payment_plan_id: string;
          payment_period_id: string | null;
          student_row_id: string;
          amount: number;
          method: string;
          provider_reference: string | null;
          status: string;
          verified_by: string | null;
          verified_at: string | null;
          rejection_reason: string | null;
          created_at: string;
          monime_payment_code_id: string | null;
          monime_payment_id: string | null;
          monime_transaction_reference: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["payment_submissions"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["payment_submissions"]["Row"]>;
        Relationships: [];
      };
      students: {
        Row: {
          id: string;
          student_id: string;
          student_pin: string;
          password_hash: string | null;
          first_login_complete: boolean;
          application_id: string;
          full_name: string;
          phone: string;
          email: string;
          programme: string;
          academic_year: string;
          level: string;
          status: string;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["students"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["students"]["Row"]>;
        Relationships: [];
      };
      receipts: {
        Row: {
          id: string;
          receipt_number: string;
          student_row_id: string;
          student_id_number: string;
          student_name: string;
          programme: string;
          amount: number;
          method: string;
          date: string;
          received_by: string;
          previous_balance: number;
          new_balance: number;
        };
        Insert: Partial<Database["public"]["Tables"]["receipts"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["receipts"]["Row"]>;
        Relationships: [];
      };
      processed_webhook_events: {
        Row: { event_id: string; processed_at: string };
        Insert: Partial<Database["public"]["Tables"]["processed_webhook_events"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["processed_webhook_events"]["Row"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
<<<<<<< HEAD
      }
=======
}
>>>>>>> 36cdb6a (Initial commit)
