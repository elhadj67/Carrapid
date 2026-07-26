# Réservation en temps réel — Guide de mise en place

Ce guide branche ta page `reservation.html` à **Supabase** (base de données
temps réel, gratuite) et **Stripe** (paiement carte). À la fin, tes clients
voient les places disponibles en direct et une place se bloque **après** paiement.

Tu as 4 fichiers :
- `reservation.html` — la page (déjà prête, il faut juste y mettre 3 valeurs)
- `supabase-schema.sql` — crée la base de données
- `stripe-webhook.ts` — bloque la place après paiement
- ce guide

Compte prévoir ~30-40 min. Aucun code à écrire, juste du copier-coller.

---

## Étape 1 — Créer le projet Supabase (5 min)

1. Va sur **supabase.com** → *Start your project* → connecte-toi (GitHub possible).
2. *New project* : donne un nom (« carrapidride »), un mot de passe de base de
   données (note-le), et choisis la région **West EU (Ireland)** ou **Paris**
   (proche de tes clients, conforme RGPD).
3. Attends 1-2 min que le projet se crée.

## Étape 2 — Créer la base de données (2 min)

1. Dans Supabase, menu de gauche → **SQL Editor** → *New query*.
2. Ouvre `supabase-schema.sql`, copie **tout** son contenu, colle-le, clique **Run**.
3. Tu dois voir « Success ». Ta table `reservations` est créée.

## Étape 3 — Récupérer tes clés et les mettre dans la page (3 min)

1. Menu → **Project Settings** (roue dentée) → **API**.
2. Copie deux valeurs :
   - **Project URL** (ex. `https://abcd.supabase.co`)
   - **anon public** (une longue clé)
3. Ouvre `reservation.html`, cherche le bloc `CONFIG` (vers la fin) et remplis :
   ```
   var SUPABASE_URL = "https://abcd.supabase.co";
   var SUPABASE_KEY = "colle-ici-la-cle-anon-public";
   ```
   ⚠️ La clé **anon public** est faite pour être dans une page web, c'est sans
   danger. Ne mets **jamais** la clé *service_role* ici (elle est secrète).

À ce stade, l'affichage des places en temps réel fonctionne déjà.

---

## Étape 4 — Stripe : le lien de paiement (5 min)

1. Crée un compte sur **stripe.com** (ou connecte le tien).
2. Menu **Paiements → Liens de paiement → Créer un lien**.
3. Crée un produit « Tour Car Rapid Ride » à **30 €**. (Astuce simple pour
   démarrer : un lien à 30 €. Pour gérer finement adultes/enfants, tu peux créer
   deux produits, ou activer la quantité ajustable.)
4. Dans les options du lien, coche **« Autoriser les codes de réduction »** si tu
   veux, et surtout garde l'option qui transmet le `client_reference_id`.
5. Copie l'URL du lien (ex. `https://buy.stripe.com/xxxx`) et mets-la dans la page :
   ```
   var STRIPE_LINK = "https://buy.stripe.com/xxxx";
   ```

## Étape 5 — Bloquer la place après paiement (webhook) (10 min)

C'est ce qui met la place à jour automatiquement quand un client a payé.

1. Dans Supabase → menu **Edge Functions** → *Create a function* → nomme-la
   exactement **`stripe-webhook`**.
2. Colle le contenu de `stripe-webhook.ts`. Déploie (*Deploy*).
3. Toujours dans Supabase → **Edge Functions → Secrets** (ou *Manage secrets*),
   ajoute 3 secrets :
   - `SUPABASE_URL` = ton Project URL
   - `SUPABASE_SERVICE_ROLE` = **Project Settings → API → service_role** (la clé secrète)
   - `STRIPE_WEBHOOK_SECRET` = tu l'obtiens à l'étape suivante
4. Copie l'URL publique de ta fonction (Supabase l'affiche, du type
   `https://abcd.functions.supabase.co/stripe-webhook`).
5. Dans **Stripe → Développeurs → Webhooks → Ajouter un endpoint** :
   - URL = l'URL de ta fonction ci-dessus
   - Événement à écouter = **`checkout.session.completed`**
   - Valide, puis copie le **secret de signature** (`whsec_...`) et colle-le dans
     le secret Supabase `STRIPE_WEBHOOK_SECRET` (étape 3).

## Étape 6 — Mettre en ligne (2 min)

1. Sur GitHub, remplace `reservation.html` par la nouvelle version remplie.
2. Ouvre `carrapidride.com/reservation.html` et fais un **test réel** : réserve
   1 place, paie avec une **carte de test Stripe** (`4242 4242 4242 4242`, date
   future, CVC au hasard) en mode test. Vérifie que la réservation passe en
   `paye` dans Supabase (table *reservations*) et que les places diminuent.
3. Quand tout marche, passe Stripe en **mode production** (Live) et refais le
   webhook avec les clés Live.

---

## Comment ça marche (résumé)

1. Le client choisit date + créneau → la page lit Supabase et affiche les places.
2. Il remplit et clique « Payer » → une réservation `en_attente` est créée, puis
   il part sur Stripe.
3. Il paie → Stripe prévient ta fonction webhook → la réservation passe en `paye`
   → la place est **définitivement bloquée** pour les autres.
4. S'il ne paie pas, la réservation reste `en_attente` et **ne bloque aucune place**.

## Bon à savoir

- **Coûts** : Supabase gratuit (largement suffisant au début), Stripe ~2,9 % + 0,30 €
  par transaction. **Aucune commission de plateforme.**
- **Sécurité** : la page n'utilise que la clé *anon* (publique, sans risque).
  La confirmation du paiement se fait côté serveur avec la clé secrète.
- **Voir tes réservations** : dans Supabase → *Table editor → reservations*. Tu
  peux exporter en CSV, filtrer par date, etc.
- **Nettoyage** (optionnel) : tu peux supprimer de temps en temps les vieilles
  lignes `en_attente` non payées.
- **Ménage des places** : le décompte se base sur `statut = 'paye'`. Une réservation
  abandonnée avant paiement ne bloque rien.

Si tu bloques à une étape, envoie-moi une capture de l'écran concerné.
