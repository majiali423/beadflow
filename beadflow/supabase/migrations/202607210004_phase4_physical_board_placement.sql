alter table public.scan_jobs
  add column physical_board_columns integer,
  add column physical_board_rows integer,
  add column pattern_offset_col integer,
  add column pattern_offset_row integer;

alter table public.scan_jobs
  add constraint scan_jobs_physical_board_columns_check
    check (physical_board_columns is null or physical_board_columns between 1 and 64),
  add constraint scan_jobs_physical_board_rows_check
    check (physical_board_rows is null or physical_board_rows between 1 and 64),
  add constraint scan_jobs_pattern_offset_col_check
    check (pattern_offset_col is null or pattern_offset_col >= 0),
  add constraint scan_jobs_pattern_offset_row_check
    check (pattern_offset_row is null or pattern_offset_row >= 0),
  add constraint scan_jobs_placement_complete_check
    check (
      (physical_board_columns is null and physical_board_rows is null and pattern_offset_col is null and pattern_offset_row is null)
      or
      (physical_board_columns is not null and physical_board_rows is not null and pattern_offset_col is not null and pattern_offset_row is not null)
    ),
  add constraint scan_jobs_pattern_fits_physical_board_check
    check (
      physical_board_columns is null
      or (
        pattern_offset_col + grid_width <= physical_board_columns
        and pattern_offset_row + grid_height <= physical_board_rows
      )
    );

create or replace function public.save_scan_placement(
  p_scan_id uuid,
  p_physical_board_columns integer,
  p_physical_board_rows integer,
  p_pattern_offset_col integer,
  p_pattern_offset_row integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_job public.scan_jobs;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_job from public.scan_jobs
  where id = p_scan_id and user_id = v_user_id for update;
  if not found then raise exception 'SCAN_NOT_FOUND'; end if;
  if p_physical_board_columns not between 1 and 64
    or p_physical_board_rows not between 1 and 64
    or p_pattern_offset_col < 0
    or p_pattern_offset_row < 0
    or p_pattern_offset_col + v_job.grid_width > p_physical_board_columns
    or p_pattern_offset_row + v_job.grid_height > p_physical_board_rows
  then
    raise exception 'INVALID_SCAN_PLACEMENT';
  end if;

  update public.scan_jobs set
    physical_board_columns = p_physical_board_columns,
    physical_board_rows = p_physical_board_rows,
    pattern_offset_col = p_pattern_offset_col,
    pattern_offset_row = p_pattern_offset_row,
    rectified_image_path = null,
    status = case when status = 'needs_review' then 'quality_check' else status end,
    updated_at = now()
  where id = p_scan_id;

  insert into public.audit_logs (
    user_id, project_id, action, entity_type, entity_id, before_state, after_state
  ) values (
    v_user_id, v_job.project_id, 'scan_placement_saved', 'scan_job', v_job.id::text,
    jsonb_build_object(
      'physicalBoardColumns', v_job.physical_board_columns,
      'physicalBoardRows', v_job.physical_board_rows,
      'patternOffsetCol', v_job.pattern_offset_col,
      'patternOffsetRow', v_job.pattern_offset_row
    ),
    jsonb_build_object(
      'physicalBoardColumns', p_physical_board_columns,
      'physicalBoardRows', p_physical_board_rows,
      'patternOffsetCol', p_pattern_offset_col,
      'patternOffsetRow', p_pattern_offset_row
    )
  );
  return jsonb_build_object('id', v_job.id::text);
end;
$$;

create or replace function public.save_rectified_scan(
  p_scan_id uuid,
  p_rectified_image_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_job public.scan_jobs;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_job from public.scan_jobs
  where id = p_scan_id and user_id = v_user_id for update;
  if not found then raise exception 'SCAN_NOT_FOUND'; end if;
  if v_job.corners is null
    or v_job.status not in ('quality_check', 'needs_corners')
    or v_job.physical_board_columns is null
    or v_job.physical_board_rows is null
    or v_job.pattern_offset_col is null
    or v_job.pattern_offset_row is null
  then
    raise exception 'SCAN_NOT_READY';
  end if;
  if p_rectified_image_path <> v_user_id::text || '/' || v_job.project_id::text || '/' || p_scan_id::text || '/rectified.png' then
    raise exception 'INVALID_SCAN_PATH';
  end if;
  update public.scan_jobs set
    rectified_image_path = p_rectified_image_path,
    status = 'needs_review',
    failure_reason = null,
    updated_at = now()
  where id = p_scan_id;
  insert into public.audit_logs (
    user_id, project_id, action, entity_type, entity_id, before_state, after_state
  ) values (
    v_user_id, v_job.project_id, 'scan_rectified', 'scan_job', v_job.id::text,
    jsonb_build_object('status', v_job.status),
    jsonb_build_object(
      'status', 'needs_review',
      'rectifiedImagePath', p_rectified_image_path,
      'physicalBoardColumns', v_job.physical_board_columns,
      'physicalBoardRows', v_job.physical_board_rows,
      'patternOffsetCol', v_job.pattern_offset_col,
      'patternOffsetRow', v_job.pattern_offset_row
    )
  );
  return jsonb_build_object('id', v_job.id::text);
end;
$$;

revoke all on function public.save_scan_placement(uuid, integer, integer, integer, integer) from public;
grant execute on function public.save_scan_placement(uuid, integer, integer, integer, integer) to authenticated;
