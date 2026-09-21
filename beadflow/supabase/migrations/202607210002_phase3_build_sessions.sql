create table public.build_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  pattern_version_id uuid not null references public.pattern_versions (id) on delete restrict,
  pattern_version integer not null check (pattern_version > 0),
  user_id uuid not null references auth.users (id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  planned_minutes integer check (planned_minutes between 1 and 480),
  completed_cells integer not null default 0 check (completed_cells between 0 and 784),
  total_non_empty_cells integer not null check (total_non_empty_cells between 1 and 784),
  mode text not null check (mode in ('row', 'color', 'region')),
  status text not null default 'active'
    check (status in ('active', 'paused', 'completed')),
  active_step_order integer not null default 1 check (active_step_order > 0),
  viewport jsonb not null default '{"scale":1,"offsetX":0,"offsetY":0}'::jsonb,
  filter_mode text not null default 'current'
    check (filter_mode in ('all', 'current', 'remaining')),
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  check (
    jsonb_typeof(viewport) = 'object'
    and (viewport->>'scale')::numeric between 0.5 and 8
    and (viewport->>'offsetX')::numeric between -10000 and 10000
    and (viewport->>'offsetY')::numeric between -10000 and 10000
  )
);

create table public.build_steps (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.build_sessions (id) on delete cascade,
  step_order integer not null check (step_order > 0),
  mode text not null check (mode in ('row', 'color', 'region')),
  target_cells jsonb not null check (
    jsonb_typeof(target_cells) = 'array'
    and jsonb_array_length(target_cells) between 1 and 784
  ),
  palette_color_ids text[] not null check (cardinality(palette_color_ids) > 0),
  bead_count integer not null check (bead_count between 1 and 784),
  estimated_minutes numeric(8, 2) not null check (estimated_minutes > 0),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'completed')),
  unique (session_id, step_order)
);

create table public.cell_progress (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  pattern_version_id uuid not null references public.pattern_versions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  last_session_id uuid not null references public.build_sessions (id) on delete restrict,
  row integer not null check (row between 0 and 27),
  col integer not null check (col between 0 and 27),
  status text not null check (
    status in ('unstarted', 'placed', 'verified', 'uncertain', 'error')
  ),
  updated_at timestamptz not null default now(),
  unique (pattern_version_id, row, col)
);

create unique index build_sessions_one_open_per_project_idx
  on public.build_sessions (project_id, user_id)
  where ended_at is null;
create index build_sessions_project_started_idx
  on public.build_sessions (project_id, started_at desc);
create index cell_progress_project_version_idx
  on public.cell_progress (project_id, pattern_version_id);

alter table public.build_sessions enable row level security;
alter table public.build_steps enable row level security;
alter table public.cell_progress enable row level security;

revoke all on public.build_sessions from anon, authenticated;
revoke all on public.build_steps from anon, authenticated;
revoke all on public.cell_progress from anon, authenticated;
grant select on public.build_sessions, public.build_steps, public.cell_progress to authenticated;

create policy "users read own build sessions"
  on public.build_sessions for select
  to authenticated
  using (user_id = auth.uid());

create policy "users read own build steps"
  on public.build_steps for select
  to authenticated
  using (
    exists (
      select 1
      from public.build_sessions
      where build_sessions.id = build_steps.session_id
        and build_sessions.user_id = auth.uid()
    )
  );

create policy "users read own cell progress"
  on public.cell_progress for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.start_build_session(
  p_project_id uuid,
  p_mode text,
  p_planned_minutes integer,
  p_steps jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects;
  v_pattern_version_id uuid;
  v_total_non_empty integer;
  v_completed integer;
  v_session public.build_sessions;
  v_step_count integer;
  v_distinct_orders integer;
  v_target_count integer;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_mode not in ('row', 'color', 'region')
    or p_planned_minutes not between 1 and 480
    or jsonb_typeof(p_steps) <> 'array'
  then
    raise exception 'INVALID_BUILD_SESSION';
  end if;

  select *
  into v_project
  from public.projects
  where id = p_project_id and user_id = v_user_id
  for update;
  if not found or v_project.current_pattern_version < 1 then
    raise exception 'PROJECT_NOT_FOUND';
  end if;
  if exists (
    select 1 from public.build_sessions
    where project_id = p_project_id and user_id = v_user_id and ended_at is null
  ) then
    raise exception 'OPEN_BUILD_SESSION_EXISTS';
  end if;

  select id
  into v_pattern_version_id
  from public.pattern_versions
  where project_id = p_project_id and version = v_project.current_pattern_version;

  select count(*)
  into v_total_non_empty
  from public.pattern_cells
  where pattern_version_id = v_pattern_version_id and palette_color_id is not null;
  if v_total_non_empty < 1 then
    raise exception 'EMPTY_PATTERN';
  end if;

  select count(*), count(distinct step."order")
  into v_step_count, v_distinct_orders
  from jsonb_to_recordset(p_steps) as step(
    "order" integer,
    mode text,
    "targetCells" jsonb,
    "paletteColorIds" jsonb,
    "beadCount" integer,
    "estimatedMinutes" numeric
  );
  if v_step_count < 1 or v_step_count > 784 or v_distinct_orders <> v_step_count then
    raise exception 'INVALID_BUILD_STEPS';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_steps) as step(
      "order" integer,
      mode text,
      "targetCells" jsonb,
      "paletteColorIds" jsonb,
      "beadCount" integer,
      "estimatedMinutes" numeric
    )
    where step."order" < 1
      or step.mode <> p_mode
      or jsonb_typeof(step."targetCells") <> 'array'
      or jsonb_array_length(step."targetCells") < 1
      or jsonb_typeof(step."paletteColorIds") <> 'array'
      or jsonb_array_length(step."paletteColorIds") < 1
      or step."beadCount" <> jsonb_array_length(step."targetCells")
      or step."estimatedMinutes" <= 0
  ) then
    raise exception 'INVALID_BUILD_STEPS';
  end if;

  with targets as (
    select
      (cell->>'row')::integer as row,
      (cell->>'col')::integer as col
    from jsonb_to_recordset(p_steps) as step("targetCells" jsonb)
    cross join lateral jsonb_array_elements(step."targetCells") as cell
  )
  select count(*) into v_target_count from targets;

  if v_target_count > 784 or exists (
    with targets as (
      select
        (cell->>'row')::integer as row,
        (cell->>'col')::integer as col
      from jsonb_to_recordset(p_steps) as step("targetCells" jsonb)
      cross join lateral jsonb_array_elements(step."targetCells") as cell
    )
    select 1
    from targets
    left join public.pattern_cells
      on pattern_cells.pattern_version_id = v_pattern_version_id
      and pattern_cells.row = targets.row
      and pattern_cells.col = targets.col
    where targets.row not between 0 and 27
      or targets.col not between 0 and 27
      or pattern_cells.palette_color_id is null
  ) or (
    with targets as (
      select
        (cell->>'row')::integer as row,
        (cell->>'col')::integer as col
      from jsonb_to_recordset(p_steps) as step("targetCells" jsonb)
      cross join lateral jsonb_array_elements(step."targetCells") as cell
    )
    select count(*) <> count(distinct (row, col)) from targets
  ) then
    raise exception 'INVALID_BUILD_TARGETS';
  end if;

  select count(*)
  into v_completed
  from public.cell_progress
  where pattern_version_id = v_pattern_version_id
    and status in ('placed', 'verified');

  insert into public.build_sessions (
    project_id,
    pattern_version_id,
    pattern_version,
    user_id,
    planned_minutes,
    completed_cells,
    total_non_empty_cells,
    mode
  )
  values (
    p_project_id,
    v_pattern_version_id,
    v_project.current_pattern_version,
    v_user_id,
    p_planned_minutes,
    v_completed,
    v_total_non_empty,
    p_mode
  )
  returning * into v_session;

  insert into public.build_steps (
    session_id,
    step_order,
    mode,
    target_cells,
    palette_color_ids,
    bead_count,
    estimated_minutes,
    status
  )
  select
    v_session.id,
    step."order",
    step.mode,
    step."targetCells",
    array(select jsonb_array_elements_text(step."paletteColorIds")),
    step."beadCount",
    step."estimatedMinutes",
    case when step."order" = 1 then 'active' else 'pending' end
  from jsonb_to_recordset(p_steps) as step(
    "order" integer,
    mode text,
    "targetCells" jsonb,
    "paletteColorIds" jsonb,
    "beadCount" integer,
    "estimatedMinutes" numeric
  );

  update public.projects
  set status = 'in_progress', updated_at = now()
  where id = p_project_id;

  insert into public.audit_logs (
    user_id, project_id, action, entity_type, entity_id, after_state
  )
  values (
    v_user_id,
    p_project_id,
    'build_session_started',
    'build_session',
    v_session.id::text,
    jsonb_build_object(
      'patternVersion', v_session.pattern_version,
      'mode', p_mode,
      'stepCount', v_step_count,
      'plannedMinutes', p_planned_minutes
    )
  );

  return jsonb_build_object('id', v_session.id::text);
end;
$$;

create or replace function public.update_build_progress(
  p_session_id uuid,
  p_expected_revision integer,
  p_updates jsonb,
  p_active_step_order integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.build_sessions;
  v_count integer;
  v_distinct_count integer;
  v_completed integer;
  v_next_revision integer;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if jsonb_typeof(p_updates) <> 'array' then
    raise exception 'INVALID_PROGRESS_BATCH';
  end if;

  select *
  into v_session
  from public.build_sessions
  where id = p_session_id and user_id = v_user_id
  for update;
  if not found then
    raise exception 'BUILD_SESSION_NOT_FOUND';
  end if;
  if v_session.ended_at is not null then
    raise exception 'BUILD_SESSION_ENDED';
  end if;
  if v_session.revision <> p_expected_revision then
    raise exception 'SESSION_REVISION_CONFLICT';
  end if;
  if p_active_step_order is not null and not exists (
    select 1 from public.build_steps
    where session_id = p_session_id and step_order = p_active_step_order
  ) then
    raise exception 'INVALID_ACTIVE_STEP';
  end if;

  select count(*), count(distinct (item.row, item.col))
  into v_count, v_distinct_count
  from jsonb_to_recordset(p_updates) as item(row integer, col integer, status text);
  if v_count < 1 or v_count > 784 or v_distinct_count <> v_count then
    raise exception 'INVALID_PROGRESS_BATCH';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_updates) as item(row integer, col integer, status text)
    left join public.pattern_cells
      on pattern_cells.pattern_version_id = v_session.pattern_version_id
      and pattern_cells.row = item.row
      and pattern_cells.col = item.col
    where item.status not in ('unstarted', 'placed', 'verified', 'uncertain', 'error')
      or pattern_cells.palette_color_id is null
  ) then
    raise exception 'INVALID_PROGRESS_CELL';
  end if;

  insert into public.cell_progress (
    project_id,
    pattern_version_id,
    user_id,
    last_session_id,
    row,
    col,
    status
  )
  select
    v_session.project_id,
    v_session.pattern_version_id,
    v_user_id,
    v_session.id,
    item.row,
    item.col,
    item.status
  from jsonb_to_recordset(p_updates) as item(row integer, col integer, status text)
  on conflict (pattern_version_id, row, col)
  do update set
    status = excluded.status,
    last_session_id = excluded.last_session_id,
    updated_at = now();

  delete from public.cell_progress
  where pattern_version_id = v_session.pattern_version_id and status = 'unstarted';

  select count(*)
  into v_completed
  from public.cell_progress
  where pattern_version_id = v_session.pattern_version_id
    and status in ('placed', 'verified');
  v_next_revision := v_session.revision + 1;

  update public.build_sessions
  set
    completed_cells = v_completed,
    active_step_order = coalesce(p_active_step_order, active_step_order),
    revision = v_next_revision,
    updated_at = now()
  where id = p_session_id;

  if p_active_step_order is not null then
    update public.build_steps
    set status = case
      when step_order < p_active_step_order then 'completed'
      when step_order = p_active_step_order then 'active'
      else 'pending'
    end
    where session_id = p_session_id;
  end if;

  insert into public.audit_logs (
    user_id, project_id, action, entity_type, entity_id, before_state, after_state
  )
  values (
    v_user_id,
    v_session.project_id,
    'build_progress_updated',
    'build_session',
    v_session.id::text,
    jsonb_build_object('revision', v_session.revision, 'completedCells', v_session.completed_cells),
    jsonb_build_object('revision', v_next_revision, 'completedCells', v_completed, 'changedCells', v_count)
  );

  return jsonb_build_object('id', v_session.id::text, 'revision', v_next_revision);
end;
$$;

create or replace function public.update_build_session(
  p_session_id uuid,
  p_expected_revision integer,
  p_status text,
  p_active_step_order integer,
  p_viewport jsonb,
  p_filter_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.build_sessions;
  v_next_revision integer;
  v_ended_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_status not in ('active', 'paused', 'completed')
    or p_filter_mode not in ('all', 'current', 'remaining')
    or p_active_step_order < 1
    or jsonb_typeof(p_viewport) <> 'object'
    or (p_viewport->>'scale')::numeric not between 0.5 and 8
    or (p_viewport->>'offsetX')::numeric not between -10000 and 10000
    or (p_viewport->>'offsetY')::numeric not between -10000 and 10000
  then
    raise exception 'INVALID_BUILD_SESSION_STATE';
  end if;

  select *
  into v_session
  from public.build_sessions
  where id = p_session_id and user_id = v_user_id
  for update;
  if not found then
    raise exception 'BUILD_SESSION_NOT_FOUND';
  end if;
  if v_session.ended_at is not null then
    raise exception 'BUILD_SESSION_ENDED';
  end if;
  if v_session.revision <> p_expected_revision then
    raise exception 'SESSION_REVISION_CONFLICT';
  end if;
  if not exists (
    select 1 from public.build_steps
    where session_id = p_session_id and step_order = p_active_step_order
  ) then
    raise exception 'INVALID_ACTIVE_STEP';
  end if;

  v_next_revision := v_session.revision + 1;
  v_ended_at := case when p_status = 'completed' then now() else null end;
  update public.build_sessions
  set
    status = p_status,
    ended_at = v_ended_at,
    active_step_order = p_active_step_order,
    viewport = p_viewport,
    filter_mode = p_filter_mode,
    revision = v_next_revision,
    updated_at = now()
  where id = p_session_id;

  update public.projects
  set
    status = case
      when p_status = 'completed' and v_session.completed_cells = v_session.total_non_empty_cells
        then 'completed'
      when p_status = 'paused' then 'paused'
      else 'in_progress'
    end,
    updated_at = now()
  where id = v_session.project_id;

  insert into public.audit_logs (
    user_id, project_id, action, entity_type, entity_id, before_state, after_state
  )
  values (
    v_user_id,
    v_session.project_id,
    'build_session_state_updated',
    'build_session',
    v_session.id::text,
    jsonb_build_object('revision', v_session.revision, 'status', v_session.status),
    jsonb_build_object('revision', v_next_revision, 'status', p_status)
  );

  return jsonb_build_object('id', v_session.id::text, 'revision', v_next_revision);
end;
$$;

revoke all on function public.start_build_session(uuid, text, integer, jsonb) from public;
revoke all on function public.update_build_progress(uuid, integer, jsonb, integer) from public;
revoke all on function public.update_build_session(uuid, integer, text, integer, jsonb, text)
  from public;
grant execute on function public.start_build_session(uuid, text, integer, jsonb)
  to authenticated;
grant execute on function public.update_build_progress(uuid, integer, jsonb, integer)
  to authenticated;
grant execute on function public.update_build_session(uuid, integer, text, integer, jsonb, text)
  to authenticated;
