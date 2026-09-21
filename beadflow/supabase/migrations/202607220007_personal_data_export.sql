create or replace function public.export_my_beadflow_data()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_account jsonb;
  v_current jsonb;
  v_legacy jsonb;
  v_palette jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;

  select jsonb_build_object(
    'id', account.id::text,
    'email', account.email,
    'createdAt', account.created_at
  ) into v_account
  from auth.users account
  where account.id = v_user_id;
  if v_account is null then raise exception 'ACCOUNT_NOT_FOUND'; end if;

  select jsonb_build_object(
    'patternAssets', coalesce((
      select jsonb_agg(to_jsonb(asset) order by asset.created_at, asset.id)
      from public.pattern_assets asset where asset.user_id = v_user_id
    ), '[]'::jsonb),
    'patternCards', coalesce((
      select jsonb_agg(to_jsonb(card) order by card.created_at, card.id)
      from public.pattern_cards card where card.user_id = v_user_id
    ), '[]'::jsonb),
    'patternMaterialDraftItems', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.created_at, item.id)
      from public.pattern_material_draft_items item where item.user_id = v_user_id
    ), '[]'::jsonb),
    'patternMaterialVersions', coalesce((
      select jsonb_agg(to_jsonb(version) order by version.confirmed_at, version.id)
      from public.pattern_material_versions version where version.user_id = v_user_id
    ), '[]'::jsonb),
    'patternMaterialItems', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.material_version_id, item.id)
      from public.pattern_material_items item where item.user_id = v_user_id
    ), '[]'::jsonb),
    'inventoryItems', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.palette_color_id, item.id)
      from public.inventory_items item where item.user_id = v_user_id
    ), '[]'::jsonb),
    'inventoryTransactions', coalesce((
      select jsonb_agg(to_jsonb(tx) order by tx.created_at, tx.id)
      from public.inventory_transactions tx where tx.user_id = v_user_id
    ), '[]'::jsonb),
    'patternCardConsumptions', coalesce((
      select jsonb_agg(to_jsonb(consumption) order by consumption.created_at, consumption.id)
      from public.pattern_card_consumptions consumption where consumption.user_id = v_user_id
    ), '[]'::jsonb),
    'patternCardConsumptionItems', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.consumption_id, item.id)
      from public.pattern_card_consumption_items item
      join public.pattern_card_consumptions consumption on consumption.id = item.consumption_id
      where consumption.user_id = v_user_id
    ), '[]'::jsonb),
    'auditLogs', coalesce((
      select jsonb_agg(to_jsonb(log) order by log.created_at, log.id)
      from public.audit_logs log where log.user_id = v_user_id
    ), '[]'::jsonb)
  ) into v_current;

  select jsonb_build_object(
    'projects', coalesce((
      select jsonb_agg(to_jsonb(project) order by project.created_at, project.id)
      from public.projects project where project.user_id = v_user_id
    ), '[]'::jsonb),
    'patternVersions', coalesce((
      select jsonb_agg(to_jsonb(version) order by version.created_at, version.id)
      from public.pattern_versions version
      join public.projects project on project.id = version.project_id
      where project.user_id = v_user_id
    ), '[]'::jsonb),
    'patternCells', coalesce((
      select jsonb_agg(to_jsonb(cell) order by cell.pattern_version_id, cell.row, cell.col)
      from public.pattern_cells cell
      join public.pattern_versions version on version.id = cell.pattern_version_id
      join public.projects project on project.id = version.project_id
      where project.user_id = v_user_id
    ), '[]'::jsonb),
    'buildSessions', coalesce((
      select jsonb_agg(to_jsonb(build_session) order by build_session.started_at, build_session.id)
      from public.build_sessions build_session where build_session.user_id = v_user_id
    ), '[]'::jsonb),
    'buildSteps', coalesce((
      select jsonb_agg(to_jsonb(step) order by step.session_id, step.step_order)
      from public.build_steps step
      join public.build_sessions build_session on build_session.id = step.session_id
      where build_session.user_id = v_user_id
    ), '[]'::jsonb),
    'cellProgress', coalesce((
      select jsonb_agg(to_jsonb(progress) order by progress.pattern_version_id, progress.row, progress.col)
      from public.cell_progress progress where progress.user_id = v_user_id
    ), '[]'::jsonb),
    'scanJobs', coalesce((
      select jsonb_agg(to_jsonb(job) order by job.created_at, job.id)
      from public.scan_jobs job where job.user_id = v_user_id
    ), '[]'::jsonb),
    'scanReviewCommits', coalesce((
      select jsonb_agg(to_jsonb(review_commit) order by review_commit.created_at, review_commit.id)
      from public.scan_review_commits review_commit where review_commit.user_id = v_user_id
    ), '[]'::jsonb),
    'scanReviewDeductions', coalesce((
      select jsonb_agg(to_jsonb(deduction) order by deduction.commit_id, deduction.id)
      from public.scan_review_deductions deduction
      join public.scan_review_commits review_commit on review_commit.id = deduction.commit_id
      where review_commit.user_id = v_user_id
    ), '[]'::jsonb)
  ) into v_legacy;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', color.id,
    'paletteId', color.palette_id,
    'code', color.code,
    'name', color.name,
    'hex', color.hex
  ) order by color.code), '[]'::jsonb)
  into v_palette from public.palette_colors color where color.is_active;

  return jsonb_build_object(
    'schemaVersion', '1.0',
    'generatedAt', now(),
    'account', v_account,
    'currentProduct', v_current,
    'legacyProduct', v_legacy,
    'referenceData', jsonb_build_object('paletteColors', v_palette),
    'notices', jsonb_build_array(
      '此文件不包含密码、登录令牌或 Supabase 内部认证字段。',
      '图纸和扫描图片仅导出文件路径、类型及删除状态，不包含图片二进制。',
      'source_deleted_at 不为空表示对应图纸原图已被永久删除。'
    )
  );
end;
$$;

revoke all on function public.export_my_beadflow_data() from public;
grant execute on function public.export_my_beadflow_data() to authenticated;
