-- ============================================================
--  CAR RAPID RIDE — Base de réservations (Supabase / PostgreSQL)
--  À coller dans Supabase : menu "SQL Editor" > New query > Run
-- ============================================================

-- 1) Table des réservations
create table if not exists public.reservations (
  id          bigint generated always as identity primary key,
  ref         text unique not null,               -- référence unique (CRR-...)
  date        date not null,                       -- date du départ
  creneau     text not null,                       -- 'Matin' ou 'Apres-midi'
  adultes     int  not null default 0,
  enfants     int  not null default 0,
  places      int  not null default 0,             -- adultes + enfants
  montant     numeric not null default 0,          -- total en euros
  nom         text,
  email       text,
  tel         text,
  statut      text not null default 'en_attente',  -- 'en_attente' | 'paye' | 'annule'
  cree_le     timestamptz not null default now()
);

-- Index pour compter vite les places d'un départ
create index if not exists idx_resa_depart
  on public.reservations (date, creneau, statut);

-- 2) Sécurité (Row Level Security)
alter table public.reservations enable row level security;

-- Lecture publique : uniquement les colonnes utiles au comptage des places.
-- (On expose une VUE qui ne montre PAS les données personnelles.)
create or replace view public.places_reservees as
  select date, creneau, sum(places) as places_prises
  from public.reservations
  where statut = 'paye'
  group by date, creneau;

grant select on public.places_reservees to anon;

-- La page web (clé anon) peut CRÉER une réservation "en_attente"...
create policy "creer_reservation_en_attente"
  on public.reservations for insert
  to anon
  with check (statut = 'en_attente');

-- ...mais NE PEUT PAS lire, modifier ni voir les données des autres clients.
-- La confirmation en 'paye' se fait uniquement côté serveur (Edge Function + clé service).

-- 3) (Optionnel) empêcher la surréservation au niveau base :
--    fonction qui refuse d'insérer si le départ est déjà complet.
create or replace function public.check_capacite()
returns trigger as $$
declare
  deja int;
begin
  select coalesce(sum(places),0) into deja
    from public.reservations
    where date = new.date and creneau = new.creneau and statut = 'paye';
  if deja + new.places > 12 then
    raise exception 'Depart complet (12 places max)';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_check_capacite on public.reservations;
create trigger trg_check_capacite
  before insert on public.reservations
  for each row execute function public.check_capacite();

-- ============================================================
--  Fin. Ta base est prête. Récupère dans "Project Settings > API" :
--   - Project URL   -> SUPABASE_URL dans la page
--   - anon public   -> SUPABASE_KEY dans la page
-- ============================================================
