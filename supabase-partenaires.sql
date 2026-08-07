-- ============================================================
--  CAR RAPID RIDE — Espace partenaires
--  A coller dans Supabase : SQL Editor > New query > Run
--  Complement de supabase-schema.sql (ne le remplace pas)
-- ============================================================

-- 1) Table des partenaires
create table if not exists public.partenaires (
  id           bigint generated always as identity primary key,
  nom          text not null,                  -- raison sociale
  type         text not null default 'agence', -- agence | hotel | plateforme | autre
  pays         text,
  contact      text,                           -- nom de l'interlocuteur
  email        text,
  tel          text,
  commission   numeric default 0,              -- FCFA par place, pour info
  signe_le     date,                           -- date de signature de la convention
  actif        boolean not null default true,
  notes        text,
  cree_le      timestamptz not null default now()
);

create unique index if not exists idx_partenaire_nom
  on public.partenaires (lower(nom));

-- 2) Rattachement d'un code promo a un partenaire
alter table public.promo_codes
  add column if not exists partenaire_id bigint
  references public.partenaires (id) on delete set null;

create index if not exists idx_promo_partenaire
  on public.promo_codes (partenaire_id);

-- 3) Vue de synthese : ventes par partenaire
--    (ne compte que les reservations reellement payees)
create or replace view public.ventes_partenaires as
  select
    p.id                                   as partenaire_id,
    p.nom                                  as partenaire,
    p.type,
    p.pays,
    c.code,
    count(r.id)                            as reservations,
    coalesce(sum(r.places), 0)             as places,
    coalesce(sum(r.montant), 0)            as chiffre_affaires,
    coalesce(sum(r.remise), 0)             as remises,
    max(r.cree_le)                         as derniere_vente
  from public.partenaires p
  left join public.promo_codes c on c.partenaire_id = p.id
  left join public.reservations r
         on r.promo = c.code and r.statut = 'paye'
  group by p.id, p.nom, p.type, p.pays, c.code;

-- 4) Securite : tables reservees a l'administration.
--    La cle anon (site public) ne doit ni lire ni ecrire ici.
alter table public.partenaires enable row level security;

drop policy if exists "partenaires_admin" on public.partenaires;
create policy "partenaires_admin"
  on public.partenaires for all
  to authenticated
  using (true) with check (true);

-- ============================================================
--  Fin. L'onglet "Partenaires" de admin.html utilise ces objets.
-- ============================================================
