// ============================================================
//  CAR RAPID RIDE — Webhook Stripe -> Supabase
//  Confirme la reservation (statut 'paye') une fois le paiement reussi,
//  puis envoie un e-mail de notification au gerant (via Resend).
//
//  A deployer comme Edge Function Supabase, nom : "stripe-webhook"
//  (voir GUIDE-reservation-temps-reel.md, etape 5 et etape 7).
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Variables d'environnement (a definir dans Supabase > Edge Functions > Secrets) :
//   SUPABASE_URL            -> l'URL de ton projet
//   SUPABASE_SERVICE_ROLE   -> la cle "service_role" (secrete, cote serveur uniquement)
//   STRIPE_WEBHOOK_SECRET   -> le secret du webhook fourni par Stripe (whsec_...)
//   RESEND_API_KEY          -> la cle API Resend (re_...)          [notification e-mail]
//   NOTIF_EMAIL             -> l'adresse qui recoit les notifications [notification e-mail]
//   NOTIF_FROM  (optionnel) -> expediteur, ex. "Car Rapid Ride <reservations@carrapidride.com>"
//                              (domaine a verifier dans Resend). Par defaut : onboarding@resend.dev,
//                              qui ne peut ecrire QU'A l'adresse du compte Resend.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE")!;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const NOTIF_EMAIL = Deno.env.get("NOTIF_EMAIL") || "";
const NOTIF_FROM = Deno.env.get("NOTIF_FROM") || "Car Rapid Ride <onboarding@resend.dev>";

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
        // Passe la reservation en 'paye' -> la place est definitivement bloquee.
        // Le filtre neq('statut','paye') evite d'envoyer 2 e-mails si Stripe
        // renvoie le meme evenement (Stripe peut re-essayer un webhook).
        const { data: lignes, error } = await supabase
          .from("reservations")
          .update({ statut: "paye" })
          .eq("ref", ref)
          .neq("statut", "paye")
          .select();
        if (error) throw error;

        if (lignes && lignes.length > 0) {
          try {
            await notifierGerant(lignes[0], session);
          } catch (e) {
            // Un e-mail rate ne doit pas faire echouer la confirmation du paiement.
            console.error("Notification e-mail echouee :", (e as Error).message);
          }
        }
      }
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    return new Response("Erreur: " + (e as Error).message, { status: 400 });
  }
});

// --- E-mail de notification au gerant ---
async function notifierGerant(r: Record<string, unknown>, session: Record<string, unknown>) {
  if (!RESEND_API_KEY || !NOTIF_EMAIL) {
    console.warn("RESEND_API_KEY ou NOTIF_EMAIL manquant : pas de notification envoyee.");
    return;
  }
  const esc = (v: unknown) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

  const creneau = r.creneau === "Matin" ? "Matin (9h)" : r.creneau === "Apres-midi" ? "Apres-midi (14h)" : r.creneau;
  const dateFr = r.date
    ? new Date(String(r.date) + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    : "";
  const paye = typeof session.amount_total === "number" ? (session.amount_total as number) / 100 : Number(r.montant || 0);
  const montant = paye.toFixed(2).replace(".", ",") + " EUR";

  const lignes: [string, unknown][] = [
    ["Reference", r.ref],
    ["Depart", dateFr + " - " + creneau],
    ["Passagers", `${r.adultes ?? 0} adulte(s), ${r.enfants ?? 0} enfant(s)`],
    ["Montant paye", montant],
    ["Code promo", r.promo || "-"],
    ["Nom", r.nom || "-"],
    ["E-mail", r.email || "-"],
    ["Telephone", r.tel || "-"],
  ];
  const html =
    `<h2 style="font-family:sans-serif;color:#1B3FAE">Nouvelle reservation payee</h2>` +
    `<table style="font-family:sans-serif;border-collapse:collapse">` +
    lignes.map(([k, v]) =>
      `<tr><td style="padding:6px 14px 6px 0;color:#666">${esc(k)}</td><td style="padding:6px 0"><b>${esc(v)}</b></td></tr>`
    ).join("") +
    `</table>`;
  const text = lignes.map(([k, v]) => `${k} : ${v ?? ""}`).join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: NOTIF_FROM,
      to: NOTIF_EMAIL.split(",").map((s) => s.trim()).filter(Boolean),
      reply_to: r.email ? String(r.email) : undefined,
      subject: `Nouvelle reservation ${r.ref} - ${r.date} ${r.creneau} - ${(Number(r.adultes) || 0) + (Number(r.enfants) || 0)} pers.`,
      html,
      text,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status} : ${(await res.text()).slice(0, 300)}`);
}

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
