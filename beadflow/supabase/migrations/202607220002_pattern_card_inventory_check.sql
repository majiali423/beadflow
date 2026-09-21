create or replace function public.get_latest_pattern_material_version(p_pattern_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_card public.pattern_cards;
  v_version public.pattern_material_versions;
  v_items jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;

  select * into v_card
  from public.pattern_cards
  where id = p_pattern_card_id and user_id = v_user_id;
  if not found then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;
  if v_card.status <> 'confirmed' or v_card.material_version < 1 then
    raise exception 'PATTERN_MATERIALS_NOT_CONFIRMED';
  end if;

  select * into v_version
  from public.pattern_material_versions
  where pattern_card_id = v_card.id
    and user_id = v_user_id
    and version = v_card.material_version;
  if not found then raise exception 'PATTERN_MATERIALS_NOT_CONFIRMED'; end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', item.id::text,
    'paletteColorId', item.palette_color_id,
    'quantity', item.quantity,
    'rawText', item.raw_text,
    'confidence', item.confidence,
    'evidenceRegion', item.evidence_region,
    'recognitionSource', item.recognition_source
  )) order by item.palette_color_id), '[]'::jsonb)
  into v_items
  from public.pattern_material_items item
  where item.material_version_id = v_version.id
    and item.user_id = v_user_id;

  return jsonb_build_object(
    'id', v_version.id::text,
    'patternCardId', v_card.id::text,
    'version', v_version.version,
    'totalQuantity', v_version.total_quantity,
    'items', v_items,
    'confirmedAt', v_version.confirmed_at
  );
end;
$$;

revoke all on function public.get_latest_pattern_material_version(uuid) from public;
grant execute on function public.get_latest_pattern_material_version(uuid) to authenticated;
