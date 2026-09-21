insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'scan-images',
  'scan-images',
  false,
  15728640,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.scan_jobs (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  pattern_version_id uuid not null references public.pattern_versions (id) on delete restrict,
  pattern_version integer not null check (pattern_version > 0),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_image_path text not null unique,
  rectified_image_path text unique,
  source_mime_type text not null check (source_mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  source_size_bytes integer not null check (source_size_bytes between 1 and 15728640),
  status text not null default 'uploaded' check (
    status in (
      'uploaded',
      'quality_check',
      'needs_corners',
      'processing',
      'needs_review',
      'confirmed',
      'failed'
    )
  ),
  grid_width integer not null check (grid_width > 0),
  grid_height integer not null check (grid_height > 0),
  quality_score numeric(6, 5) check (quality_score between 0 and 1),
  quality_result jsonb,
  corners jsonb check (corners is null or jsonb_array_length(corners) = 4),
  corner_source text not null default 'none' check (corner_source in ('aruco', 'manual', 'none')),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_image_path = user_id::text || '/' || project_id::text || '/' || id::text || '/source'),
  check (
    rectified_image_path is null
    or rectified_image_path = user_id::text || '/' || project_id::text || '/' || id::text || '/rectified.png'
  )
);

create index scan_jobs_project_created_idx on public.scan_jobs (project_id, created_at desc);

alter table public.scan_jobs enable row level security;
revoke all on public.scan_jobs from anon, authenticated;
grant select on public.scan_jobs to authenticated;

create policy "users read own scan jobs"
  on public.scan_jobs for select
  to authenticated
  using (user_id = auth.uid());

create policy "users upload own scan images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users read own scan images"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users update own scan images"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users delete own scan images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create or replace function public.create_scan_job(
  p_id uuid,
  p_project_id uuid,
  p_source_image_path text,
  p_source_mime_type text,
  p_source_size_bytes integer
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
  v_job public.scan_jobs;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_source_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
    or p_source_size_bytes not between 1 and 15728640
  then
    raise exception 'INVALID_SCAN_UPLOAD';
  end if;
  select * into v_project from public.projects
  where id = p_project_id and user_id = v_user_id;
  if not found or v_project.current_pattern_version < 1 then
    raise exception 'PROJECT_NOT_FOUND';
  end if;
  if p_source_image_path <> v_user_id::text || '/' || p_project_id::text || '/' || p_id::text || '/source' then
    raise exception 'INVALID_SCAN_PATH';
  end if;
  select id into v_pattern_version_id from public.pattern_versions
  where project_id = p_project_id and version = v_project.current_pattern_version;

  insert into public.scan_jobs (
    id, project_id, pattern_version_id, pattern_version, user_id,
    source_image_path, source_mime_type, source_size_bytes, grid_width, grid_height
  ) values (
    p_id, p_project_id, v_pattern_version_id, v_project.current_pattern_version, v_user_id,
    p_source_image_path, p_source_mime_type, p_source_size_bytes,
    v_project.board_width, v_project.board_height
  ) returning * into v_job;

  insert into public.audit_logs (
    user_id, project_id, action, entity_type, entity_id, after_state
  ) values (
    v_user_id, p_project_id, 'scan_job_created', 'scan_job', v_job.id::text,
    jsonb_build_object(
      'patternVersion', v_job.pattern_version,
      'mimeType', p_source_mime_type,
      'sizeBytes', p_source_size_bytes
    )
  );
  return jsonb_build_object('id', v_job.id::text);
end;
$$;

create or replace function public.save_scan_inspection(
  p_scan_id uuid,
  p_status text,
  p_quality_result jsonb,
  p_corners jsonb,
  p_corner_source text,
  p_failure_reason text default null
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
  if p_status not in ('quality_check', 'needs_corners', 'failed')
    or p_corner_source not in ('aruco', 'manual', 'none')
    or jsonb_typeof(p_quality_result) <> 'object'
    or (p_corners is not null and (jsonb_typeof(p_corners) <> 'array' or jsonb_array_length(p_corners) <> 4))
  then
    raise exception 'INVALID_SCAN_INSPECTION';
  end if;
  select * into v_job from public.scan_jobs
  where id = p_scan_id and user_id = v_user_id for update;
  if not found then raise exception 'SCAN_NOT_FOUND'; end if;

  update public.scan_jobs set
    status = p_status,
    quality_score = (p_quality_result->>'qualityScore')::numeric,
    quality_result = p_quality_result,
    corners = p_corners,
    corner_source = p_corner_source,
    failure_reason = p_failure_reason,
    updated_at = now()
  where id = p_scan_id;

  insert into public.audit_logs (
    user_id, project_id, action, entity_type, entity_id, before_state, after_state
  ) values (
    v_user_id, v_job.project_id, 'scan_inspection_saved', 'scan_job', v_job.id::text,
    jsonb_build_object('status', v_job.status),
    jsonb_build_object('status', p_status, 'cornerSource', p_corner_source)
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
  if v_job.corners is null or v_job.status not in ('quality_check', 'needs_corners') then
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
    jsonb_build_object('status', 'needs_review', 'rectifiedImagePath', p_rectified_image_path)
  );
  return jsonb_build_object('id', v_job.id::text);
end;
$$;

revoke all on function public.create_scan_job(uuid, uuid, text, text, integer) from public;
revoke all on function public.save_scan_inspection(uuid, text, jsonb, jsonb, text, text) from public;
revoke all on function public.save_rectified_scan(uuid, text) from public;
grant execute on function public.create_scan_job(uuid, uuid, text, text, integer) to authenticated;
grant execute on function public.save_scan_inspection(uuid, text, jsonb, jsonb, text, text) to authenticated;
grant execute on function public.save_rectified_scan(uuid, text) to authenticated;
