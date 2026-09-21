create extension if not exists pgcrypto;

create table public.palettes (
  id text primary key,
  name text not null,
  version text not null,
  created_at timestamptz not null default now(),
  unique (name, version)
);

create table public.palette_colors (
  id text primary key,
  palette_id text not null references public.palettes (id) on delete restrict,
  code text not null,
  name text,
  hex text not null check (hex ~ '^#[0-9A-F]{6}$'),
  rgb jsonb not null,
  lab jsonb not null,
  is_active boolean not null default true,
  unique (palette_id, code)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  description text,
  status text not null default 'draft'
    check (status in ('draft', 'ready', 'in_progress', 'paused', 'completed')),
  current_pattern_version integer not null default 0 check (current_pattern_version >= 0),
  board_width integer not null check (board_width > 0),
  board_height integer not null check (board_height > 0),
  cover_image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pattern_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  version integer not null check (version > 0),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users (id) on delete restrict,
  unique (project_id, version)
);

create table public.pattern_cells (
  pattern_version_id uuid not null references public.pattern_versions (id) on delete cascade,
  row integer not null check (row >= 0),
  col integer not null check (col >= 0),
  palette_color_id text references public.palette_colors (id) on delete restrict,
  status text not null default 'unstarted'
    check (status in ('unstarted', 'placed', 'verified', 'uncertain', 'error')),
  primary key (pattern_version_id, row, col)
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  project_id uuid references public.projects (id) on delete cascade,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create index pattern_versions_project_id_idx on public.pattern_versions (project_id);
create index pattern_cells_palette_color_id_idx on public.pattern_cells (palette_color_id);
create index audit_logs_project_id_created_at_idx
  on public.audit_logs (project_id, created_at desc);

alter table public.palettes enable row level security;
alter table public.palette_colors enable row level security;
alter table public.projects enable row level security;
alter table public.pattern_versions enable row level security;
alter table public.pattern_cells enable row level security;
alter table public.audit_logs enable row level security;

revoke all on public.palettes from anon, authenticated;
revoke all on public.palette_colors from anon, authenticated;
revoke all on public.projects from anon, authenticated;
revoke all on public.pattern_versions from anon, authenticated;
revoke all on public.pattern_cells from anon, authenticated;
revoke all on public.audit_logs from anon, authenticated;

grant select on public.palettes, public.palette_colors to authenticated;
grant select on public.projects, public.pattern_versions, public.pattern_cells, public.audit_logs
  to authenticated;
grant insert (user_id, name, description, status, board_width, board_height, cover_image_path)
  on public.projects to authenticated;
grant update (name, description, status, cover_image_path, updated_at)
  on public.projects to authenticated;
grant delete on public.projects to authenticated;

create policy "authenticated users read palettes"
  on public.palettes for select
  to authenticated
  using (true);

create policy "authenticated users read palette colors"
  on public.palette_colors for select
  to authenticated
  using (true);

create policy "users read own projects"
  on public.projects for select
  to authenticated
  using (user_id = auth.uid());

create policy "users create own projects"
  on public.projects for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "users update own projects"
  on public.projects for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users delete own projects"
  on public.projects for delete
  to authenticated
  using (user_id = auth.uid());

create policy "users read own pattern versions"
  on public.pattern_versions for select
  to authenticated
  using (
    exists (
      select 1
      from public.projects
      where projects.id = pattern_versions.project_id
        and projects.user_id = auth.uid()
    )
  );

create policy "users read own pattern cells"
  on public.pattern_cells for select
  to authenticated
  using (
    exists (
      select 1
      from public.pattern_versions
      join public.projects on projects.id = pattern_versions.project_id
      where pattern_versions.id = pattern_cells.pattern_version_id
        and projects.user_id = auth.uid()
    )
  );

create policy "users read own audit logs"
  on public.audit_logs for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.save_pattern_version(
  p_project_id uuid,
  p_base_version integer,
  p_width integer,
  p_height integer,
  p_cells jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_version integer;
  v_project_owner uuid;
  v_pattern_version_id uuid;
  v_new_version integer;
  v_created_at timestamptz;
  v_cell_count integer;
  v_distinct_count integer;
  v_cells jsonb;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_base_version < 0
    or p_width < 1
    or p_height < 1
  then
    raise exception 'INVALID_PATTERN_DIMENSIONS';
  end if;
  if jsonb_typeof(p_cells) <> 'array' then
    raise exception 'INVALID_PATTERN_CELLS';
  end if;

  select current_pattern_version, user_id
  into v_current_version, v_project_owner
  from public.projects
  where id = p_project_id
  for update;

  if not found or v_project_owner <> v_user_id then
    raise exception 'PROJECT_NOT_FOUND';
  end if;
  if v_current_version <> p_base_version then
    raise exception 'VERSION_CONFLICT: expected %, actual %', p_base_version, v_current_version;
  end if;

  select count(*), count(distinct (cell.row, cell.col))
  into v_cell_count, v_distinct_count
  from jsonb_to_recordset(p_cells) as cell(
    row integer,
    col integer,
    "paletteColorId" text,
    status text
  );

  if v_cell_count <> p_width * p_height or v_distinct_count <> v_cell_count then
    raise exception 'INVALID_PATTERN_MATRIX';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_cells) as cell(
      row integer,
      col integer,
      "paletteColorId" text,
      status text
    )
    where cell.row < 0
      or cell.row >= p_height
      or cell.col < 0
      or cell.col >= p_width
      or coalesce(cell.status, 'unstarted')
        not in ('unstarted', 'placed', 'verified', 'uncertain', 'error')
  ) then
    raise exception 'INVALID_PATTERN_CELL';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_cells) as cell(
      row integer,
      col integer,
      "paletteColorId" text,
      status text
    )
    left join public.palette_colors
      on palette_colors.id = cell."paletteColorId"
    where cell."paletteColorId" is not null
      and palette_colors.id is null
  ) then
    raise exception 'UNKNOWN_PALETTE_COLOR';
  end if;

  v_new_version := v_current_version + 1;

  insert into public.pattern_versions (
    project_id,
    version,
    width,
    height,
    created_by
  )
  values (
    p_project_id,
    v_new_version,
    p_width,
    p_height,
    v_user_id
  )
  returning id, created_at into v_pattern_version_id, v_created_at;

  insert into public.pattern_cells (
    pattern_version_id,
    row,
    col,
    palette_color_id,
    status
  )
  select
    v_pattern_version_id,
    cell.row,
    cell.col,
    cell."paletteColorId",
    coalesce(cell.status, 'unstarted')
  from jsonb_to_recordset(p_cells) as cell(
    row integer,
    col integer,
    "paletteColorId" text,
    status text
  );

  update public.projects
  set
    current_pattern_version = v_new_version,
    board_width = p_width,
    board_height = p_height,
    updated_at = now()
  where id = p_project_id;

  insert into public.audit_logs (
    user_id,
    project_id,
    action,
    entity_type,
    entity_id,
    before_state,
    after_state
  )
  values (
    v_user_id,
    p_project_id,
    'pattern_version_created',
    'pattern_version',
    v_pattern_version_id::text,
    jsonb_build_object('version', v_current_version),
    jsonb_build_object(
      'version', v_new_version,
      'width', p_width,
      'height', p_height,
      'cellCount', v_cell_count
    )
  );

  select jsonb_agg(
    jsonb_build_object(
      'row', pattern_cells.row,
      'col', pattern_cells.col,
      'paletteColorId', pattern_cells.palette_color_id,
      'status', pattern_cells.status
    )
    order by pattern_cells.row, pattern_cells.col
  )
  into v_cells
  from public.pattern_cells
  where pattern_version_id = v_pattern_version_id;

  return jsonb_build_object(
    'id', v_pattern_version_id::text,
    'projectId', p_project_id::text,
    'version', v_new_version,
    'width', p_width,
    'height', p_height,
    'cells', v_cells,
    'createdAt', v_created_at,
    'createdBy', v_user_id::text
  );
end;
$$;

revoke all on function public.save_pattern_version(uuid, integer, integer, integer, jsonb)
  from public;
grant execute on function public.save_pattern_version(uuid, integer, integer, integer, jsonb)
  to authenticated;
