alter table public.pattern_assets
  add column source_deleted_at timestamptz;

create policy "users delete own pattern images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'pattern-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

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

  return jsonb_strip_nulls(jsonb_build_object(
    'patternCardId', v_card.id::text,
    'name', v_card.name,
    'sourceImagePath', v_asset.source_image_path,
    'sourceMimeType', v_asset.source_mime_type,
    'sourceDeletedAt', v_asset.source_deleted_at
  ));
end;
$$;

create or replace function public.prepare_pattern_card_source_deletion(p_pattern_card_id uuid)
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
  if v_card.status <> 'confirmed' then raise exception 'PATTERN_CARD_NOT_CONFIRMED'; end if;

  select * into v_asset from public.pattern_assets
  where id = v_card.asset_id and user_id = v_user_id;
  if not found then raise exception 'PATTERN_ASSET_NOT_FOUND'; end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'patternCardId', v_card.id::text,
    'sourceImagePath', v_asset.source_image_path,
    'sourceDeletedAt', v_asset.source_deleted_at
  ));
end;
$$;

create or replace function public.complete_pattern_card_source_deletion(p_pattern_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_card public.pattern_cards;
  v_deleted_at timestamptz;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_card from public.pattern_cards
  where id = p_pattern_card_id and user_id = v_user_id;
  if not found then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;
  if v_card.status <> 'confirmed' then raise exception 'PATTERN_CARD_NOT_CONFIRMED'; end if;

  update public.pattern_assets
  set source_deleted_at = coalesce(source_deleted_at, now())
  where id = v_card.asset_id and user_id = v_user_id
  returning source_deleted_at into v_deleted_at;
  if not found then raise exception 'PATTERN_ASSET_NOT_FOUND'; end if;

  return jsonb_build_object(
    'patternCardId', v_card.id::text,
    'sourceDeletedAt', v_deleted_at
  );
end;
$$;

create or replace function public.restore_pattern_card_source(
  p_pattern_card_id uuid,
  p_source_image_path text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_card public.pattern_cards;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_card from public.pattern_cards
  where id = p_pattern_card_id and user_id = v_user_id;
  if not found then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;

  update public.pattern_assets
  set source_deleted_at = null
  where id = v_card.asset_id
    and user_id = v_user_id
    and source_image_path = p_source_image_path;
  if not found then raise exception 'PATTERN_ASSET_PATH_MISMATCH'; end if;
end;
$$;

revoke all on function public.prepare_pattern_card_source_deletion(uuid) from public;
grant execute on function public.prepare_pattern_card_source_deletion(uuid) to authenticated;
revoke all on function public.complete_pattern_card_source_deletion(uuid) from public;
grant execute on function public.complete_pattern_card_source_deletion(uuid) to authenticated;
revoke all on function public.restore_pattern_card_source(uuid, text) from public;
grant execute on function public.restore_pattern_card_source(uuid, text) to authenticated;
