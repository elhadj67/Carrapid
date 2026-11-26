// ============================================================
//  CAR RAPID RIDE — Webhook Stripe -> Supabase
//
//  checkout.session.completed -> reservation 'paye'   (place definitive)
//                                + e-mail de notification au gerant (Resend)
//  checkout.session.expired   -> reservation 'expire' (place liberee tout de suite)
//  charge.refunded            -> reservation 'annule' (place liberee)
//
//  A deployer comme Edge Function Supabase, nom : "stripe-webhook"
//  Verify JWT : OFF  (Stripe n'envoie pas de JWT Supabase)
//
//  Secrets :
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (fournis automatiquement par Supabase)
//    STRIPE_WEBHOOK_SECRET                    (whsec_... donne par Stripe)
//    RESEND_API_KEY, NOTIF_EMAIL              (notification e-mail)
//    NOTIF_FROM (optionnel)  ex. "Car Rapid Ride <reservations@carrapidride.com>"
//               par defaut onboarding@resend.dev, qui n'ecrit qu'a l'adresse
//               du compte Resend tant que le domaine n'est pas verifie.
//
//  Evenements a cocher cote Stripe :
//    checkout.session.completed, checkout.session.expired, charge.refunded
// ============================================================
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// SUPABASE_SERVICE_ROLE_KEY est injecte automatiquement par Supabase.
// (L'ancien nom SUPABASE_SERVICE_ROLE n'existait pas : la fonction plantait au demarrage.)
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE")!;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const NOTIF_EMAIL = Deno.env.get("NOTIF_EMAIL") ?? "";
const NOTIF_FROM = Deno.env.get("NOTIF_FROM") ?? "Car Rapid Ride <onboarding@resend.dev>";
const TOLERANCE_S = 300; // rejette les messages de plus de 5 minutes (anti-rejeu)

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

serve(async (req) => {
  try {
    const signature = req.headers.get("stripe-signature") ?? "";
    const corps = await req.text();
    if (!await verifierStripe(corps, signature, WEBHOOK_SECRET)) {
      return new Response("Signature invalide", { status: 400 });
    }
    const evenement = JSON.parse(corps);
    const objet = evenement?.data?.object ?? {};
    const ref = objet.client_reference_id ?? objet.metadata?.ref ?? undefined;

    switch (evenement.type) {
      case "checkout.session.completed": {
        if (ref) {
          // .neq garde l'operation idempotente : si Stripe rejoue
          // l'evenement, le code promo n'est pas recompte et l'e-mail
          // n'est pas renvoye.
          const { data: lignes, error } = await supabase
            .from("reservations")
            .update({ statut: "paye" })
            .eq("ref", ref)
            .neq("statut", "paye")
            .select();
          if (error) throw error;
          if (lignes && lignes.length > 0) {
            try {
              await notifierGerant(lignes[0], objet);
            } catch (e) {
              // Un e-mail rate ne doit jamais faire echouer la confirmation du paiement.
              console.error("notification e-mail echouee:", e);
            }
          }
        }
        break;
      }
      case "checkout.session.expired": {
        // Paiement non termine dans le delai : la place repart au pot commun.
        if (ref) {
          await supabase.from("reservations").update({ statut: "expire" })
            .eq("ref", ref).eq("statut", "en_attente");
        }
        break;
      }
      case "charge.refunded": {
        if (ref) {
          await supabase.from("reservations").update({ statut: "annule" }).eq("ref", ref);
        }
        break;
      }
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("webhook:", e);
    return new Response("Erreur", { status: 400 });
  }
});

// ------------------------------------------------------------
//  E-mail de notification au gerant (Resend)
// ------------------------------------------------------------
async function notifierGerant(r: Record<string, unknown>, session: Record<string, unknown>) {
  if (!RESEND_API_KEY || !NOTIF_EMAIL) {
    console.warn("RESEND_API_KEY ou NOTIF_EMAIL manquant : pas de notification.");
    return;
  }
  const esc = (v: unknown) =>
    String(v ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

  const creneau = r.creneau === "Matin" ? "Matin (9h)"
    : r.creneau === "Apres-midi" ? "Apres-midi (14h)" : String(r.creneau ?? "");
  const dateFr = r.date
    ? new Date(String(r.date) + "T12:00:00Z").toLocaleDateString("fr-FR",
        { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    : "";
  const paye = typeof session.amount_total === "number"
    ? (session.amount_total as number) / 100 : Number(r.montant ?? 0);
  const nb = (Number(r.adultes) || 0) + (Number(r.enfants) || 0);

  const lignes: [string, unknown][] = [
    ["Reference", r.ref],
    ["Depart", `${dateFr} - ${creneau}`],
    ["Passagers", `${r.adultes ?? 0} adulte(s), ${r.enfants ?? 0} enfant(s)`],
    ["Montant paye", paye.toFixed(2).replace(".", ",") + " EUR"],
    ["Code promo", r.promo || "-"],
    ["Nom", r.nom || "-"],
    ["E-mail", r.email || "-"],
    ["Telephone", r.tel || "-"],
  ];
  const html =
    `<h2 style="font-family:sans-serif;color:#1B3FAE">Nouvelle reservation payee</h2>` +
    `<table style="font-family:sans-serif;border-collapse:collapse">` +
    lignes.map(([k, v]) =>
      `<tr><td style="padding:6px 14px 6px 0;color:#666">${esc(k)}</td>` +
      `<td style="padding:6px 0"><b>${esc(v)}</b></td></tr>`).join("") +
    `</table>`;
  const text = lignes.map(([k, v]) => `${k} : ${v ?? ""}`).join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: NOTIF_FROM,
      to: NOTIF_EMAIL.split(",").map((s) => s.trim()).filter(Boolean),
      reply_to: r.email ? String(r.email) : undefined,
      subject: `Nouvelle reservation ${r.ref} - ${r.date} ${r.creneau} - ${nb} pers.`,
      html,
      text,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// ------------------------------------------------------------
//  Verification de la signature Stripe (HMAC-SHA256, sans SDK)
//  - controle l'anciennete du message (anti-rejeu)
//  - accepte plusieurs signatures v1 (rotation de secret)
//  - comparaison a temps constant
// ------------------------------------------------------------
async function verifierStripe(charge: string, entete: string, secret: string): Promise<boolean> {
  try {
    if (!entete || !secret) return false;
    let horodatage = "";
    const signatures: string[] = [];
    for (const bloc of entete.split(",")) {
      const sep = bloc.indexOf("=");
      if (sep < 0) continue;
      const cle = bloc.slice(0, sep).trim();
      const valeur = bloc.slice(sep + 1).trim();
      if (cle === "t") horodatage = valeur;
      else if (cle === "v1") signatures.push(valeur);
    }
    if (!horodatage || signatures.length === 0) return false;
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(horodatage));
    if (!Number.isFinite(age) || age > TOLERANCE_S) return false;
    const enc = new TextEncoder();
    const cle = await crypto.subtle.importKey("raw", enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const brut = await crypto.subtle.sign("HMAC", cle, enc.encode(`${horodatage}.${charge}`));
    const attendu = Array.from(new Uint8Array(brut)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return signatures.some((s) => egalConstant(s, attendu));
  } catch {
    return false;
  }
}

function egalConstant(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
