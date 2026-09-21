insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pattern-images',
  'pattern-images',
  false,
  15728640,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "users insert own pattern images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'pattern-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "users read own pattern images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'pattern-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "users update own pattern images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'pattern-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'pattern-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create or replace function public.create_pattern_card_from_ocr(
  p_source_image_path text,
  p_source_mime_type text,
  p_sha256 text,
  p_name text,
  p_declared_total integer,
  p_conflicts jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_asset public.pattern_assets;
  v_card public.pattern_cards;
  v_count integer;
  v_distinct_count integer;
  v_total integer;
  v_items jsonb;
  v_deduplicated boolean := false;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_source_image_path is null
    or p_sha256 is null
    or p_name is null
    or p_source_mime_type is null
    or p_conflicts is null
    or p_items is null
    or p_source_image_path <> v_user_id::text || '/patterns/' || p_sha256 || '/source'
    or p_source_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
    or p_sha256 !~ '^[0-9a-f]{64}$'
    or length(trim(p_name)) not between 1 and 100
    or (p_declared_total is not null and p_declared_total not between 1 and 1000000)
    or jsonb_typeof(p_conflicts) <> 'array'
    or jsonb_typeof(p_items) <> 'array'
  then raise exception 'INVALID_PATTERN_IMPORT'; end if;
  if jsonb_array_length(p_conflicts) > 221 or exists (
    select 1 from jsonb_array_elements(p_conflicts) as conflict(value)
    where jsonb_typeof(conflict.value) <> 'string'
      or length(trim(conflict.value #>> '{}')) not between 1 and 20
  ) then raise exception 'INVALID_PATTERN_IMPORT_CONFLICTS'; end if;

  select count(*), count(distinct draft."paletteColorId"), coalesce(sum(draft.quantity), 0)
  into v_count, v_distinct_count, v_total
  from jsonb_to_recordset(p_items) as draft(
    id uuid, "paletteColorId" text, quantity integer, "rawText" text,
    confidence double precision, "evidenceRegion" jsonb,
    "recognitionSource" text, "reviewState" text
  );
  if v_count > 221 or v_count <> v_distinct_count then
    raise exception 'INVALID_PATTERN_IMPORT_ITEMS';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_items) as draft(
      id uuid, "paletteColorId" text, quantity integer, "rawText" text,
      confidence double precision, "evidenceRegion" jsonb,
      "recognitionSource" text, "reviewState" text
    )
    left join public.palette_colors color on color.id = draft."paletteColorId"
    where draft.id is null
      or color.id is null
      or not color.is_active
      or draft.quantity not between 1 and 100000
      or draft."recognitionSource" not in ('direct', 'compact', 'spatial')
      or draft."reviewState" <> 'pending'
      or (draft.confidence is not null and draft.confidence not between 0 and 1)
  ) then raise exception 'INVALID_PATTERN_IMPORT_ITEM'; end if;

  insert into public.pattern_assets (
    user_id, source_image_path, source_mime_type, sha256, ocr_status
  ) values (
    v_user_id, p_source_image_path, p_source_mime_type, p_sha256, 'needs_review'
  ) on conflict (user_id, sha256) do nothing;

  select * into v_asset
  from public.pattern_assets
  where user_id = v_user_id and sha256 = p_sha256
  for update;

  select * into v_card
  from public.pattern_cards
  where user_id = v_user_id and asset_id = v_asset.id and status <> 'archived'
  order by created_at desc
  limit 1;

  if found then
    v_deduplicated := true;
  else
    insert into public.pattern_cards (
      user_id, asset_id, name, declared_total, recognized_total,
      review_conflicts, status
    ) values (
      v_user_id, v_asset.id, trim(p_name), p_declared_total, v_total,
      p_conflicts, 'draft'
    ) returning * into v_card;

    insert into public.pattern_material_draft_items (
      id, pattern_card_id, user_id, palette_color_id, quantity, raw_text,
      confidence, evidence_region, recognition_source, review_state
    )
    select draft.id, v_card.id, v_user_id, draft."paletteColorId", draft.quantity,
      draft."rawText", draft.confidence, draft."evidenceRegion",
      draft."recognitionSource", draft."reviewState"
    from jsonb_to_recordset(p_items) as draft(
      id uuid, "paletteColorId" text, quantity integer, "rawText" text,
      confidence double precision, "evidenceRegion" jsonb,
      "recognitionSource" text, "reviewState" text
    );

    insert into public.audit_logs (
      user_id, action, entity_type, entity_id, before_state, after_state
    ) values (
      v_user_id, 'pattern_card_imported', 'pattern_card', v_card.id::text, null,
      jsonb_build_object(
        'sha256', p_sha256,
        'recognizedTotal', v_total,
        'materialCount', v_count,
        'conflictCount', jsonb_array_length(p_conflicts)
      )
    );
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', item.id::text,
    'paletteColorId', item.palette_color_id,
    'quantity', item.quantity,
    'rawText', item.raw_text,
    'confidence', item.confidence,
    'evidenceRegion', item.evidence_region,
    'recognitionSource', item.recognition_source,
    'reviewState', item.review_state
  )) order by item.created_at, item.id), '[]'::jsonb)
  into v_items
  from public.pattern_material_draft_items item
  where item.pattern_card_id = v_card.id and item.user_id = v_user_id;

  return jsonb_strip_nulls(jsonb_build_object(
    'patternCardId', v_card.id::text,
    'name', v_card.name,
    'sourceImagePath', v_asset.source_image_path,
    'sourceMimeType', v_asset.source_mime_type,
    'deduplicated', v_deduplicated,
    'revision', v_card.review_revision,
    'status', case when v_card.status = 'confirmed' then 'confirmed' else 'needs_review' end,
    'declaredTotal', v_card.declared_total,
    'recognizedTotal', v_card.recognized_total,
    'conflicts', v_card.review_conflicts,
    'items', v_items,
    'updatedAt', v_card.updated_at
  ));
end;
$$;

revoke all on function public.create_pattern_card_from_ocr(
  text, text, text, text, integer, jsonb, jsonb
) from public;
grant execute on function public.create_pattern_card_from_ocr(
  text, text, text, text, integer, jsonb, jsonb
) to authenticated;

create or replace function public.get_pattern_card_source(p_pattern_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_card public.pattern_cards;
  v_asset public.pattern_assets;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_card from public.pattern_cards
  where id = p_pattern_card_id and user_id = v_user_id;
  if not found then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;
  select * into v_asset from public.pattern_assets
  where id = v_card.asset_id and user_id = v_user_id;
  if not found then raise exception 'PATTERN_ASSET_NOT_FOUND'; end if;

  return jsonb_build_object(
    'patternCardId', v_card.id::text,
    'name', v_card.name,
    'sourceImagePath', v_asset.source_image_path,
    'sourceMimeType', v_asset.source_mime_type
  );
end;
$$;

revoke all on function public.get_pattern_card_source(uuid) from public;
grant execute on function public.get_pattern_card_source(uuid) to authenticated;
