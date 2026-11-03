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
//   RESEND_API_KEY          -> la cle API Resend (envoi de l'e-mail de confirmation)
//   EMAIL_FROM              -> ex. Car Rapid Ride <reservation@carrapidride.com>
//   EMAIL_REPLY_TO          -> (optionnel) adresse de reponse
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

    // Facture payee : envoi de l'e-mail de confirmation avec la facture en piece jointe.
    // En cas d'echec, le catch repond en erreur et Stripe reessaie.
    if (event.type === "invoice.paid") {
      const facture = event.data.object;
      if (facture.metadata?.ref) await envoyerConfirmation(facture);
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    return new Response("Erreur: " + e.message, { status: 400 });
  }
});

// --- E-mail de confirmation avec facture Stripe ---
const ech = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CRENEAUX: Record<string, string> = {
  "Matin": "Matin, départ à 9h",
  "Apres-midi": "Après-midi, départ à 14h",
};

function dateLongue(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

function passagers(adultes: number, enfants: number): string {
  const p = [`${adultes} adulte${adultes > 1 ? "s" : ""}`];
  if (enfants > 0) p.push(`${enfants} enfant${enfants > 1 ? "s" : ""}`);
  return p.join(", ");
}

function montant(centimes: number, devise: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: devise.toUpperCase() })
    .format(centimes / 100);
}

function emailHtml(r: {
  nom: string; date: string; creneau: string; passagers: string; total: string;
}): string {
  const ligne = (k: string, v: string) =>
    `<tr><td style="padding:7px 0;color:#6E6551;width:115px;vertical-align:top">${k}</td>` +
    `<td style="padding:7px 0;font-weight:bold">${ech(v)}</td></tr>`;
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FBF3DE;font-family:Arial,Helvetica,sans-serif;color:#14181F">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF3DE"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:3px solid #14181F;border-radius:16px;overflow:hidden">
<tr><td style="background:#1B3FAE;padding:22px 26px;color:#ffffff">
  <div style="font-size:24px;font-weight:bold">Car Rapid Ride</div>
  <div style="font-size:14px;color:#FFC61A;font-weight:bold;margin-top:3px">Votre tour de Dakar est réservé</div>
</td></tr>
<tr><td style="padding:26px;font-size:15px;line-height:1.55">
  <p style="margin:0 0 14px">Bonjour${r.nom ? " " + ech(r.nom) : ""},</p>
  <p style="margin:0 0 18px">Merci pour votre réservation ! Votre paiement est bien reçu et vos places sont confirmées. Vous trouverez votre facture en pièce jointe.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF3DE;border-radius:12px;margin:0 0 18px"><tr><td style="padding:14px 18px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
      ${ligne("Date", r.date)}
      ${ligne("Créneau", r.creneau)}
      ${ligne("Passagers", r.passagers)}
      ${ligne("Total payé", r.total)}
      ${ligne("Départ", "Place de l'Indépendance, Plateau, Dakar")}
      ${ligne("Durée", "environ 4 h")}
    </table>
  </td></tr></table>
  <p style="margin:0 0 18px">Le tour se termine par un verre de clôture offert au Loman Art Rooftop, aux Mamelles.</p>
  <p style="margin:0 0 18px">Une question ou un changement ? Écrivez-nous sur WhatsApp : <a href="https://wa.me/33767953581" style="color:#1B3FAE;font-weight:bold">+33 7 67 95 35 81</a> ou <a href="https://wa.me/221774811034" style="color:#1B3FAE;font-weight:bold">+221 77 481 10 34</a>.</p>
  <p style="margin:0">À très vite à bord !<br><strong>L'équipe Car Rapid Ride</strong></p>
</td></tr>
<tr><td style="background:#14181F;color:#cfc8b8;padding:14px 26px;font-size:12px;text-align:center">
  Car Rapid Ride by dd · Dakar, Sénégal · <a href="https://carrapidride.com/" style="color:#FFC61A">carrapidride.com</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

async function envoyerConfirmation(facture: any): Promise<void> {
  const ref = facture.metadata.ref;
  const { data: resa, error } = await supabase
    .from("reservations")
    .select("date, creneau, adultes, enfants, nom, email")
    .eq("ref", ref)
    .single();
  if (error || !resa) throw new Error(`Reservation ${ref} introuvable`);

  const destinataire = resa.email || facture.customer_email;
  if (!destinataire) throw new Error(`Reservation ${ref} : e-mail client absent`);
  if (!facture.invoice_pdf) throw new Error(`Facture ${facture.id} : PDF indisponible`);

  const pdf = await fetch(facture.invoice_pdf);
  if (!pdf.ok) throw new Error(`Facture ${facture.id} : PDF ${pdf.status}`);
  const octets = new Uint8Array(await pdf.arrayBuffer());
  let binaire = "";
  for (let i = 0; i < octets.length; i += 0x8000) {
    binaire += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  }

  const date = dateLongue(resa.date);
  const rep = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `confirmation-${facture.id}`, // pas de doublon si Stripe reessaie
    },
    body: JSON.stringify({
      from: Deno.env.get("EMAIL_FROM"),
      to: [destinataire],
      reply_to: Deno.env.get("EMAIL_REPLY_TO") || undefined,
      subject: `Votre tour Car Rapid Ride du ${date} est confirmé`,
      html: emailHtml({
        nom: resa.nom || facture.customer_name || "",
        date,
        creneau: CRENEAUX[resa.creneau] ?? resa.creneau,
        passagers: passagers(resa.adultes, resa.enfants),
        total: montant(facture.amount_paid, facture.currency),
      }),
      attachments: [{ filename: `Facture-${facture.number ?? ref}.pdf`, content: btoa(binaire) }],
    }),
  });
  if (!rep.ok) throw new Error(`Resend ${rep.status} : ${await rep.text()}`);
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
