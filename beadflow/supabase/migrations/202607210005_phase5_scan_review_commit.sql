alter table public.cell_progress
  alter column last_session_id drop not null,
  add column last_scan_id uuid references public.scan_jobs (id) on delete restrict,
  add column inventory_consumed boolean not null default false;

alter table public.cell_progress
  add constraint cell_progress_provenance_check
  check (last_session_id is not null or last_scan_id is not null);

create table public.scan_review_commits (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null unique references public.scan_jobs (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete cascade,
  pattern_version_id uuid not null references public.pattern_versions (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete cascade,
  correct_cells jsonb not null check (jsonb_typeof(correct_cells) = 'array'),
  issue_cells jsonb not null check (jsonb_typeof(issue_cells) = 'array'),
  previous_progress jsonb not null check (jsonb_typeof(previous_progress) = 'array'),
  status text not null default 'confirmed' check (status in ('confirmed', 'rolled_back')),
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz
);

create table public.scan_review_deductions (
  id uuid primary key default gen_random_uuid(),
  commit_id uuid not null references public.scan_review_commits (id) on delete restrict,
  palette_color_id text not null references public.palette_colors (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  consumption_transaction_id uuid not null references public.inventory_transactions (id) on delete restrict,
  rollback_transaction_id uuid references public.inventory_transactions (id) on delete restrict,
  unique (commit_id, palette_color_id)
);

alter table public.scan_review_commits enable row level security;
alter table public.scan_review_deductions enable row level security;
revoke all on public.scan_review_commits, public.scan_review_deductions from anon, authenticated;
grant select on public.scan_review_commits, public.scan_review_deductions to authenticated;

create policy "users read own scan review commits"
  on public.scan_review_commits for select to authenticated
  using (user_id = auth.uid());

create policy "users read own scan review deductions"
  on public.scan_review_deductions for select to authenticated
  using (
    exists (
      select 1 from public.scan_review_commits
      where scan_review_commits.id = scan_review_deductions.commit_id
        and scan_review_commits.user_id = auth.uid()
    )
  );

create or replace function public.confirm_scan_review(
  p_scan_id uuid,
  p_correct_cells jsonb,
  p_issue_cells jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_job public.scan_jobs;
  v_commit public.scan_review_commits;
  v_color record;
  v_item public.inventory_items;
  v_transaction public.inventory_transactions;
  v_previous jsonb;
  v_correct_count integer;
  v_issue_count integer;
  v_total_deducted integer := 0;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if jsonb_typeof(p_correct_cells) <> 'array' or jsonb_typeof(p_issue_cells) <> 'array' then
    raise exception 'INVALID_SCAN_REVIEW';
  end if;

  select * into v_job from public.scan_jobs
  where id = p_scan_id and user_id = v_user_id for update;
  if not found then raise exception 'SCAN_NOT_FOUND'; end if;
  if v_job.status = 'confirmed' or exists (
    select 1 from public.scan_review_commits where scan_id = p_scan_id
  ) then
    raise exception 'SCAN_ALREADY_COMMITTED';
  end if;
  if v_job.status <> 'needs_review' or v_job.rectified_image_path is null then
    raise exception 'SCAN_NOT_READY';
  end if;

  select count(*) into v_correct_count
  from jsonb_to_recordset(p_correct_cells) as item(row integer, col integer);
  select count(*) into v_issue_count
  from jsonb_to_recordset(p_issue_cells) as item(row integer, col integer);
  if v_correct_count + v_issue_count < 1 or v_correct_count + v_issue_count > 784 then
    raise exception 'INVALID_SCAN_REVIEW';
  end if;
  if exists (
    with all_cells as (
      select row, col from jsonb_to_recordset(p_correct_cells) as item(row integer, col integer)
      union all
      select row, col from jsonb_to_recordset(p_issue_cells) as item(row integer, col integer)
    )
    select 1 from all_cells
    where row not between 0 and v_job.grid_height - 1
      or col not between 0 and v_job.grid_width - 1
    group by row, col
    having count(*) > 1 or bool_or(
      row not between 0 and v_job.grid_height - 1
      or col not between 0 and v_job.grid_width - 1
    )
  ) or (
    with all_cells as (
      select row, col from jsonb_to_recordset(p_correct_cells) as item(row integer, col integer)
      union all
      select row, col from jsonb_to_recordset(p_issue_cells) as item(row integer, col integer)
    )
    select count(*) <> count(distinct (row, col)) from all_cells
  ) then
    raise exception 'INVALID_SCAN_REVIEW';
  end if;

  with affected as (
    select item.row, item.col
    from jsonb_to_recordset(p_issue_cells) as item(row integer, col integer)
    union
    select item.row, item.col
    from jsonb_to_recordset(p_correct_cells) as item(row integer, col integer)
    join public.pattern_cells pc
      on pc.pattern_version_id = v_job.pattern_version_id
      and pc.row = item.row and pc.col = item.col
      and pc.palette_color_id is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'row', affected.row,
    'col', affected.col,
    'status', cp.status,
    'inventoryConsumed', coalesce(cp.inventory_consumed, false),
    'lastSessionId', cp.last_session_id,
    'lastScanId', cp.last_scan_id
  ) order by affected.row, affected.col), '[]'::jsonb)
  into v_previous
  from affected
  left join public.cell_progress cp
    on cp.pattern_version_id = v_job.pattern_version_id
    and cp.row = affected.row and cp.col = affected.col;

  insert into public.scan_review_commits (
    scan_id, project_id, pattern_version_id, user_id,
    correct_cells, issue_cells, previous_progress
  ) values (
    p_scan_id, v_job.project_id, v_job.pattern_version_id, v_user_id,
    p_correct_cells, p_issue_cells, v_previous
  ) returning * into v_commit;

  for v_color in
    select pc.palette_color_id, count(*)::integer as quantity
    from jsonb_to_recordset(p_correct_cells) as item(row integer, col integer)
    join public.pattern_cells pc
      on pc.pattern_version_id = v_job.pattern_version_id
      and pc.row = item.row and pc.col = item.col
      and pc.palette_color_id is not null
    left join public.cell_progress cp
      on cp.pattern_version_id = v_job.pattern_version_id
      and cp.row = item.row and cp.col = item.col
    where coalesce(cp.inventory_consumed, false) = false
    group by pc.palette_color_id
    order by pc.palette_color_id
  loop
    insert into public.inventory_items (user_id, palette_color_id)
    values (v_user_id, v_color.palette_color_id)
    on conflict (user_id, palette_color_id) do nothing;

    select * into v_item from public.inventory_items
    where user_id = v_user_id and palette_color_id = v_color.palette_color_id
    for update;
    if v_item.quantity < v_color.quantity then raise exception 'INSUFFICIENT_INVENTORY'; end if;

    update public.inventory_items set
      quantity = quantity - v_color.quantity,
      updated_at = now()
    where id = v_item.id returning * into v_item;

    insert into public.inventory_transactions (
      user_id, palette_color_id, delta, balance_after, reason, project_id
    ) values (
      v_user_id, v_color.palette_color_id, -v_color.quantity,
      v_item.quantity, 'project_consumption', v_job.project_id
    ) returning * into v_transaction;

    insert into public.scan_review_deductions (
      commit_id, palette_color_id, quantity, consumption_transaction_id
    ) values (v_commit.id, v_color.palette_color_id, v_color.quantity, v_transaction.id);
    v_total_deducted := v_total_deducted + v_color.quantity;
  end loop;

  insert into public.cell_progress (
    project_id, pattern_version_id, user_id, last_session_id, last_scan_id,
    row, col, status, inventory_consumed
  )
  select
    v_job.project_id, v_job.pattern_version_id, v_user_id, null, v_job.id,
    item.row, item.col, 'verified', true
  from jsonb_to_recordset(p_correct_cells) as item(row integer, col integer)
  join public.pattern_cells pc
    on pc.pattern_version_id = v_job.pattern_version_id
    and pc.row = item.row and pc.col = item.col
    and pc.palette_color_id is not null
  on conflict (pattern_version_id, row, col) do update set
    status = 'verified', inventory_consumed = true,
    last_session_id = null, last_scan_id = excluded.last_scan_id, updated_at = now();

  insert into public.cell_progress (
    project_id, pattern_version_id, user_id, last_session_id, last_scan_id,
    row, col, status, inventory_consumed
  )
  select
    v_job.project_id, v_job.pattern_version_id, v_user_id, null, v_job.id,
    item.row, item.col, 'error', false
  from jsonb_to_recordset(p_issue_cells) as item(row integer, col integer)
  on conflict (pattern_version_id, row, col) do update set
    status = 'error', last_session_id = null,
    last_scan_id = excluded.last_scan_id, updated_at = now();

  update public.scan_jobs set status = 'confirmed', updated_at = now() where id = v_job.id;
  update public.build_sessions bs set
    completed_cells = (
      select count(*) from public.cell_progress cp
      where cp.pattern_version_id = bs.pattern_version_id
        and cp.status in ('placed', 'verified')
    ), updated_at = now()
  where bs.pattern_version_id = v_job.pattern_version_id and bs.ended_at is null;

  insert into public.audit_logs (
    user_id, project_id, action, entity_type, entity_id, after_state
  ) values (
    v_user_id, v_job.project_id, 'scan_review_committed', 'scan_review_commit', v_commit.id::text,
    jsonb_build_object(
      'scanId', v_job.id, 'correctCells', v_correct_count,
      'issueCells', v_issue_count, 'inventoryDeducted', v_total_deducted
    )
  );

  return jsonb_build_object(
    'id', v_commit.id::text, 'scanId', v_job.id::text, 'status', 'confirmed',
    'correctCellCount', v_correct_count, 'issueCellCount', v_issue_count,
    'deductedTotal', v_total_deducted, 'undoAvailable', true
  );
end;
$$;

create or replace function public.rollback_scan_review(p_scan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_job public.scan_jobs;
  v_commit public.scan_review_commits;
  v_deduction record;
  v_item public.inventory_items;
  v_transaction public.inventory_transactions;
  v_previous record;
  v_restored integer := 0;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_job from public.scan_jobs
  where id = p_scan_id and user_id = v_user_id for update;
  if not found then raise exception 'SCAN_NOT_FOUND'; end if;
  select * into v_commit from public.scan_review_commits
  where scan_id = p_scan_id and user_id = v_user_id for update;
  if not found or v_commit.status <> 'confirmed' then raise exception 'SCAN_ROLLBACK_NOT_AVAILABLE'; end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_commit.previous_progress) as previous(row integer, col integer)
    left join public.cell_progress cp
      on cp.pattern_version_id = v_commit.pattern_version_id
      and cp.row = previous.row and cp.col = previous.col
    where cp.last_scan_id is distinct from p_scan_id
  ) then
    raise exception 'SCAN_CONFIRMATION_SUPERSEDED';
  end if;

  for v_deduction in
    select * from public.scan_review_deductions
    where commit_id = v_commit.id and rollback_transaction_id is null
    order by palette_color_id
  loop
    select * into v_item from public.inventory_items
    where user_id = v_user_id and palette_color_id = v_deduction.palette_color_id
    for update;
    update public.inventory_items set
      quantity = quantity + v_deduction.quantity, updated_at = now()
    where id = v_item.id returning * into v_item;
    insert into public.inventory_transactions (
      user_id, palette_color_id, delta, balance_after, reason, project_id
    ) values (
      v_user_id, v_deduction.palette_color_id, v_deduction.quantity,
      v_item.quantity, 'project_rollback', v_job.project_id
    ) returning * into v_transaction;
    update public.scan_review_deductions
    set rollback_transaction_id = v_transaction.id where id = v_deduction.id;
  end loop;

  for v_previous in
    select * from jsonb_to_recordset(v_commit.previous_progress) as item(
      row integer, col integer, status text, "inventoryConsumed" boolean,
      "lastSessionId" uuid, "lastScanId" uuid
    )
  loop
    if v_previous.status is null then
      delete from public.cell_progress
      where pattern_version_id = v_commit.pattern_version_id
        and row = v_previous.row and col = v_previous.col;
    else
      update public.cell_progress set
        status = v_previous.status,
        inventory_consumed = v_previous."inventoryConsumed",
        last_session_id = v_previous."lastSessionId",
        last_scan_id = v_previous."lastScanId",
        updated_at = now()
      where pattern_version_id = v_commit.pattern_version_id
        and row = v_previous.row and col = v_previous.col;
    end if;
    v_restored := v_restored + 1;
  end loop;

  update public.scan_review_commits
  set status = 'rolled_back', rolled_back_at = now() where id = v_commit.id;
  update public.scan_jobs set status = 'needs_review', updated_at = now() where id = v_job.id;
  update public.build_sessions bs set
    completed_cells = (
      select count(*) from public.cell_progress cp
      where cp.pattern_version_id = bs.pattern_version_id
        and cp.status in ('placed', 'verified')
    ), updated_at = now()
  where bs.pattern_version_id = v_job.pattern_version_id and bs.ended_at is null;

  insert into public.audit_logs (
    user_id, project_id, action, entity_type, entity_id, after_state
  ) values (
    v_user_id, v_job.project_id, 'scan_review_rolled_back', 'scan_review_commit', v_commit.id::text,
    jsonb_build_object('scanId', v_job.id, 'restoredCells', v_restored)
  );

  return jsonb_build_object(
    'id', v_commit.id::text, 'scanId', v_job.id::text, 'status', 'rolled_back',
    'correctCellCount', jsonb_array_length(v_commit.correct_cells),
    'issueCellCount', jsonb_array_length(v_commit.issue_cells),
    'deductedTotal', coalesce((
      select sum(quantity) from public.scan_review_deductions where commit_id = v_commit.id
    ), 0),
    'undoAvailable', false
  );
end;
$$;

revoke all on function public.confirm_scan_review(uuid, jsonb, jsonb) from public;
revoke all on function public.rollback_scan_review(uuid) from public;
grant execute on function public.confirm_scan_review(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.rollback_scan_review(uuid) to authenticated;
