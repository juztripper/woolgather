import { createClient } from "npm:@supabase/supabase-js@2.115.0";
import { handleAttachments } from "./handler.ts";
Deno.serve((request) =>
  handleAttachments(request, {
    url: Deno.env.get("SUPABASE_URL")!,
    key: Deno.env.get("SUPABASE_ANON_KEY")!,
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    createClient,
  }),
);
