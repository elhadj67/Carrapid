// ============================================================
//  CAR RAPID RIDE — Webhook Stripe -> Supabase
//  Confirme la reservation (statut 'paye') une fois le paiement reussi.
//
//  A deployer comme Edge Function Supabase, nom : "stripe-webhook"
//  (voir GUIDE-reservation-temps-reel.md, etape 4).
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Variables d'environnement (a definir dans Supabase > Edge Functions > Secrets) :
//   SUPABASE_URL            -> l'URL de ton projet
//   SUPABASE_SERVICE_ROLE   -> la cle "service_role" (secrete, cote serveur uniquement)
//   STRIPE_WEBHOOK_SECRET   -> le secret du webhook fourni par Stripe (whsec_...)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE")!;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

serve(async (req) => {
  try {
    const sig = req.headers.get("stripe-signature") || "";
    const body = await req.text();

    // Verification de la signature Stripe (securite : le message vient bien de Stripe)
    const ok = await verifyStripe(body, sig, WEBHOOK_SECRET);
    if (!ok) return new Response("Signature invalide", { status: 400 });

    const event = JSON.parse(body);

    // On agit quand le paiement de la session est complete
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const ref = session.client_reference_id; // notre reference CRR-...
      if (ref) {
        // Passe la reservation en 'paye' -> la place est definitivement bloquee
        await supabase
          .from("reservations")
          .update({ statut: "paye" })
          .eq("ref", ref);
      }
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    return new Response("Erreur: " + e.message, { status: 400 });
  }
});

// --- Verification HMAC de la signature Stripe (sans SDK) ---
async function verifyStripe(payload: string, header: string, secret: string): Promise<boolean> {
  try {
    const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
    const t = parts["t"]; const v1 = parts["v1"];
    if (!t || !v1) return false;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
    const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return expected === v1;
  } catch {
    return false;
  }
}
