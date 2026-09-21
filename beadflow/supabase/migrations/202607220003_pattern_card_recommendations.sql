create or replace function public.list_confirmed_pattern_materials()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_candidates jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'patternCardId', card.id::text,
    'name', card.name,
    'materialVersion', version.version,
    'totalBeads', version.total_quantity,
    'confirmedAt', version.confirmed_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'paletteColorId', item.palette_color_id,
        'quantity', item.quantity
      ) order by item.palette_color_id)
      from public.pattern_material_items item
      where item.material_version_id = version.id
        and item.user_id = v_user_id
    ), '[]'::jsonb)
  ) order by card.updated_at desc, card.id), '[]'::jsonb)
  into v_candidates
  from public.pattern_cards card
  join public.pattern_material_versions version
    on version.pattern_card_id = card.id
   and version.version = card.material_version
   and version.user_id = v_user_id
  where card.user_id = v_user_id
    and card.status = 'confirmed'
    and card.material_version > 0;

  return v_candidates;
end;
$$;

revoke all on function public.list_confirmed_pattern_materials() from public;
grant execute on function public.list_confirmed_pattern_materials() to authenticated;
