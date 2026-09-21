create or replace function public.get_latest_pattern(p_project_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects;
  v_version public.pattern_versions;
  v_cells jsonb;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select *
  into v_project
  from public.projects
  where id = p_project_id
    and user_id = v_user_id;

  if not found then
    raise exception 'PROJECT_NOT_FOUND';
  end if;
  if v_project.current_pattern_version < 1 then
    raise exception 'PATTERN_NOT_FOUND';
  end if;

  select *
  into v_version
  from public.pattern_versions
  where project_id = p_project_id
    and version = v_project.current_pattern_version;

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
  where pattern_version_id = v_version.id;

  return jsonb_build_object(
    'id', v_version.id::text,
    'projectId', v_project.id::text,
    'version', v_version.version,
    'width', v_version.width,
    'height', v_version.height,
    'cells', v_cells,
    'createdAt', v_version.created_at,
    'createdBy', v_version.created_by::text
  );
end;
$$;

revoke all on function public.get_latest_pattern(uuid) from public;
grant execute on function public.get_latest_pattern(uuid) to authenticated;
