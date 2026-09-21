create or replace function public.create_project(
  p_name text,
  p_description text,
  p_board_width integer,
  p_board_height integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if length(trim(p_name)) < 1 or length(trim(p_name)) > 80 then
    raise exception 'INVALID_PROJECT_NAME';
  end if;
  if p_board_width < 1 or p_board_height < 1 then
    raise exception 'INVALID_PATTERN_DIMENSIONS';
  end if;

  insert into public.projects (
    user_id,
    name,
    description,
    board_width,
    board_height
  )
  values (
    v_user_id,
    trim(p_name),
    nullif(trim(p_description), ''),
    p_board_width,
    p_board_height
  )
  returning * into v_project;

  insert into public.audit_logs (
    user_id,
    project_id,
    action,
    entity_type,
    entity_id,
    after_state
  )
  values (
    v_user_id,
    v_project.id,
    'project_created',
    'project',
    v_project.id::text,
    jsonb_build_object(
      'name', v_project.name,
      'boardWidth', v_project.board_width,
      'boardHeight', v_project.board_height
    )
  );

  return jsonb_build_object(
    'id', v_project.id::text,
    'name', v_project.name,
    'description', v_project.description,
    'status', v_project.status,
    'currentPatternVersion', v_project.current_pattern_version,
    'boardWidth', v_project.board_width,
    'boardHeight', v_project.board_height,
    'createdAt', v_project.created_at,
    'updatedAt', v_project.updated_at
  );
end;
$$;

revoke all on function public.create_project(text, text, integer, integer) from public;
grant execute on function public.create_project(text, text, integer, integer) to authenticated;
