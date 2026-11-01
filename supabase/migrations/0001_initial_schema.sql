-- AI Creative Studio: initial single-owner schema.
-- Apply only to a dedicated Supabase project after reviewing the migration.
create extension if not exists pgcrypto;

create type public.asset_kind as enum ('image', 'video', 'audio', 'other');
create type public.job_status as enum ('queued', 'submitted', 'processing', 'validating', 'completed', 'failed', 'cancelled');
create type public.job_capability as enum (
  'text_to_image', 'image_to_image', 'image_edit', 'inpaint', 'outpaint', 'upscale',
  'text_to_video', 'image_to_video', 'video_to_video', 'video_extend',
  'video_edit', 'background_remove', 'background_replace', 'object_remove',
  'face_replace', 'character_replace'
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  kind public.asset_kind not null,
  object_key text not null,
  original_filename text,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  checksum_sha256 text,
  source_asset_id uuid references public.media_assets(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (owner_id, object_key),
  check (original_filename is null or char_length(original_filename) <= 255)
);

create table public.providers (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  display_name text not null,
  docs_url text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.provider_models (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(id) on delete cascade,
  model_key text not null,
  display_name text not null,
  capabilities public.job_capability[] not null default '{}',
  input_types text[] not null default '{}',
  output_types text[] not null default '{}',
  pricing jsonb not null default '{}'::jsonb,
  pricing_verified_at timestamptz,
  availability text not null default 'unverified' check (availability in ('available', 'limited', 'unavailable', 'unverified')),
  constraints jsonb not null default '{}'::jsonb,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, model_key)
);

-- Only ciphertext is persisted. The encryption key must remain outside the database.
create table public.provider_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider_id text not null references public.providers(id) on delete restrict,
  label text not null default 'Default' check (char_length(label) between 1 and 80),
  encrypted_secret text not null,
  key_version smallint not null default 1,
  key_hint text,
  last_validated_at timestamptz,
  validation_status text not null default 'unknown' check (validation_status in ('unknown', 'valid', 'invalid', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, provider_id, label)
);

create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  capability public.job_capability not null,
  status public.job_status not null default 'queued',
  provider_id text references public.providers(id) on delete set null,
  model_id uuid references public.provider_models(id) on delete set null,
  provider_job_id text,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  input_asset_ids uuid[] not null default '{}',
  prompt text,
  parameters jsonb not null default '{}'::jsonb,
  estimated_cost numeric(14,6),
  actual_cost numeric(14,6),
  cost_currency char(3),
  error_code text,
  error_message text,
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, idempotency_key),
  check (estimated_cost is null or estimated_cost >= 0),
  check (actual_cost is null or actual_cost >= 0)
);

create index ai_jobs_owner_created_idx on public.ai_jobs(owner_id, created_at desc);
create index ai_jobs_status_created_idx on public.ai_jobs(status, created_at);
create index media_assets_owner_created_idx on public.media_assets(owner_id, created_at desc);
create index provider_credentials_owner_idx on public.provider_credentials(owner_id);

create table public.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.ai_jobs(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 80),
  from_status public.job_status,
  to_status public.job_status,
  message text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index job_events_job_created_idx on public.job_events(job_id, created_at);

create table public.job_costs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_jobs(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider_id text references public.providers(id) on delete set null,
  model_key text,
  amount numeric(14,6) not null check (amount >= 0),
  currency char(3) not null,
  cost_type text not null check (cost_type in ('estimate', 'actual', 'adjustment')),
  source text not null default 'provider' check (source in ('provider', 'catalog_estimate', 'manual')),
  created_at timestamptz not null default now()
);

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  name text not null check (char_length(name) between 1 and 100),
  reference_asset_id uuid references public.media_assets(id) on delete set null,
  consent_confirmed_at timestamptz,
  consent_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS on every owner-scoped table. Provider/model catalog is readable to signed-in owners.
alter table public.projects enable row level security;
alter table public.media_assets enable row level security;
alter table public.providers enable row level security;
alter table public.provider_models enable row level security;
alter table public.provider_credentials enable row level security;
alter table public.ai_jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.job_costs enable row level security;
alter table public.characters enable row level security;

create policy "owners manage projects" on public.projects for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owners manage assets" on public.media_assets for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "signed-in read providers" on public.providers for select to authenticated using (true);
create policy "signed-in read models" on public.provider_models for select to authenticated using (true);
create policy "owners manage credentials" on public.provider_credentials for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owners manage jobs" on public.ai_jobs for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owners read job events" on public.job_events for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "owners read costs" on public.job_costs for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "owners manage characters" on public.characters for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create trigger projects_updated_at before update on public.projects for each row execute function public.set_updated_at();
create trigger providers_updated_at before update on public.providers for each row execute function public.set_updated_at();
create trigger provider_models_updated_at before update on public.provider_models for each row execute function public.set_updated_at();
create trigger provider_credentials_updated_at before update on public.provider_credentials for each row execute function public.set_updated_at();
create trigger ai_jobs_updated_at before update on public.ai_jobs for each row execute function public.set_updated_at();
create trigger characters_updated_at before update on public.characters for each row execute function public.set_updated_at();

-- Private object bucket. The first path segment must be the authenticated owner's UUID.
insert into storage.buckets (id, name, public, file_size_limit)
values ('creative-assets', 'creative-assets', false, 1073741824)
on conflict (id) do update set public = false;

create policy "owners upload own creative assets" on storage.objects for insert to authenticated
  with check (bucket_id = 'creative-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "owners read own creative assets" on storage.objects for select to authenticated
  using (bucket_id = 'creative-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "owners delete own creative assets" on storage.objects for delete to authenticated
  using (bucket_id = 'creative-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);
