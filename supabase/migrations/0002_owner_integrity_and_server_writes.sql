-- Tighten the initial schema before it is applied to a real project.
-- Requires Supabase PostgreSQL 15+ for column-specific composite FK SET NULL.

-- Add candidate keys first because the following composite foreign keys depend on them.
alter table public.projects add constraint projects_owner_id_id_unique unique (owner_id, id);
alter table public.media_assets add constraint media_assets_owner_id_id_unique unique (owner_id, id);
alter table public.ai_jobs add constraint ai_jobs_owner_id_id_unique unique (owner_id, id);

-- A job's input list is normalized so each input asset can be constrained to the same owner.
create table public.ai_job_inputs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null,
  asset_id uuid not null,
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  unique (job_id, asset_id),
  unique (job_id, position),
  constraint ai_job_inputs_job_owner_fk
    foreign key (owner_id, job_id) references public.ai_jobs(owner_id, id) on delete cascade,
  constraint ai_job_inputs_asset_owner_fk
    foreign key (owner_id, asset_id) references public.media_assets(owner_id, id) on delete cascade
);

-- Prevent cross-owner project/asset/job references even when UUIDs are guessed or leaked.
alter table public.media_assets
  add constraint media_assets_project_owner_fk
  foreign key (owner_id, project_id) references public.projects(owner_id, id)
  on delete set null (project_id);
alter table public.media_assets
  add constraint media_assets_source_owner_fk
  foreign key (owner_id, source_asset_id) references public.media_assets(owner_id, id)
  on delete set null (source_asset_id);
alter table public.ai_jobs
  add constraint ai_jobs_project_owner_fk
  foreign key (owner_id, project_id) references public.projects(owner_id, id)
  on delete set null (project_id);
alter table public.job_events
  add constraint job_events_job_owner_fk
  foreign key (owner_id, job_id) references public.ai_jobs(owner_id, id) on delete cascade;
alter table public.job_costs
  add constraint job_costs_job_owner_fk
  foreign key (owner_id, job_id) references public.ai_jobs(owner_id, id) on delete cascade;
alter table public.characters
  add constraint characters_project_owner_fk
  foreign key (owner_id, project_id) references public.projects(owner_id, id)
  on delete set null (project_id);
alter table public.characters
  add constraint characters_reference_asset_owner_fk
  foreign key (owner_id, reference_asset_id) references public.media_assets(owner_id, id)
  on delete set null (reference_asset_id);

alter table public.ai_jobs drop column input_asset_ids;

-- Explicit single-owner allowlist. After the owner's Supabase Auth user exists,
-- insert that UUID into this table using the Supabase SQL editor.
create table public.app_owner (
  user_id uuid primary key references auth.users(id) on delete cascade,
  configured_at timestamptz not null default now()
);
alter table public.app_owner enable row level security;
revoke all on public.app_owner from anon, authenticated;

create or replace function public.is_app_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  select exists (
    select 1 from public.app_owner
    where user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_app_owner() from public, anon;
grant execute on function public.is_app_owner() to authenticated;

-- Browser clients cannot forge provider job IDs, mark jobs complete, or alter costs.
-- Trusted server routes/workers use the service role only after owner authorization.
drop policy if exists "owners manage projects" on public.projects;
create policy "app owner manages projects" on public.projects for all to authenticated
  using (public.is_app_owner() and owner_id = (select auth.uid()))
  with check (public.is_app_owner() and owner_id = (select auth.uid()));

drop policy if exists "owners manage assets" on public.media_assets;
create policy "app owner manages assets" on public.media_assets for all to authenticated
  using (public.is_app_owner() and owner_id = (select auth.uid()))
  with check (public.is_app_owner() and owner_id = (select auth.uid()));

drop policy if exists "signed-in read providers" on public.providers;
create policy "app owner reads providers" on public.providers for select to authenticated
  using (public.is_app_owner());

drop policy if exists "signed-in read models" on public.provider_models;
create policy "app owner reads models" on public.provider_models for select to authenticated
  using (public.is_app_owner());

-- No authenticated-user policy is intentionally created for provider_credentials.
drop policy if exists "owners manage credentials" on public.provider_credentials;

drop policy if exists "owners manage jobs" on public.ai_jobs;
create policy "app owner reads jobs" on public.ai_jobs for select to authenticated
  using (public.is_app_owner() and owner_id = (select auth.uid()));

drop policy if exists "owners read job events" on public.job_events;
create policy "app owner reads job events" on public.job_events for select to authenticated
  using (public.is_app_owner() and owner_id = (select auth.uid()));

drop policy if exists "owners read costs" on public.job_costs;
create policy "app owner reads costs" on public.job_costs for select to authenticated
  using (public.is_app_owner() and owner_id = (select auth.uid()));

drop policy if exists "owners manage characters" on public.characters;
create policy "app owner manages characters" on public.characters for all to authenticated
  using (public.is_app_owner() and owner_id = (select auth.uid()))
  with check (public.is_app_owner() and owner_id = (select auth.uid()));

alter table public.ai_job_inputs enable row level security;
create policy "app owner reads job inputs" on public.ai_job_inputs for select to authenticated
  using (public.is_app_owner() and owner_id = (select auth.uid()));

-- Storage access is also restricted to the single configured owner.
drop policy if exists "owners upload own creative assets" on storage.objects;
create policy "app owner uploads own creative assets" on storage.objects for insert to authenticated
  with check (
    public.is_app_owner()
    and bucket_id = 'creative-assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "owners read own creative assets" on storage.objects;
create policy "app owner reads own creative assets" on storage.objects for select to authenticated
  using (
    public.is_app_owner()
    and bucket_id = 'creative-assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "owners delete own creative assets" on storage.objects;
create policy "app owner deletes own creative assets" on storage.objects for delete to authenticated
  using (
    public.is_app_owner()
    and bucket_id = 'creative-assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Cost and lifecycle event writes are server-only; authenticated browser roles are read-only.
