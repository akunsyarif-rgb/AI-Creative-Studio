-- Tighten the initial schema before it is applied to a real project.
-- Supabase PostgreSQL 15+ supports column-specific SET NULL for composite FKs.

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

alter table public.projects add constraint projects_owner_id_id_unique unique (owner_id, id);
alter table public.media_assets add constraint media_assets_owner_id_id_unique unique (owner_id, id);
alter table public.ai_jobs add constraint ai_jobs_owner_id_id_unique unique (owner_id, id);

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

alter table public.ai_job_inputs enable row level security;
create policy "owners read job inputs" on public.ai_job_inputs for select to authenticated
  using (owner_id = (select auth.uid()));

-- The browser can read job status but cannot forge provider IDs, mark jobs complete,
-- or alter cost records. Trusted server routes/workers use the service role after
-- authenticating and authorizing the owner.
drop policy if exists "owners manage jobs" on public.ai_jobs;
create policy "owners read jobs" on public.ai_jobs for select to authenticated
  using (owner_id = (select auth.uid()));

-- BYOK ciphertext must not be directly accessible through the browser Supabase client.
-- No authenticated-user policy is intentionally created for provider_credentials.
drop policy if exists "owners manage credentials" on public.provider_credentials;

-- Cost and lifecycle events remain read-only to the owner; trusted server code writes them.
