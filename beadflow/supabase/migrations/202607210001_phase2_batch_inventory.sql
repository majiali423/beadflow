create or replace function public.set_inventory_items_batch(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_count integer;
  v_distinct_count integer;
  v_input record;
  v_item public.inventory_items;
  v_current_quantity integer;
  v_delta integer;
  v_items jsonb;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_INVENTORY_BATCH';
  end if;

  select count(*), count(distinct item."paletteColorId")
  into v_count, v_distinct_count
  from jsonb_to_recordset(p_items) as item(
    "paletteColorId" text,
    quantity integer,
    "quantityConfidence" text,
    "lowStockThreshold" integer
  );

  if v_count < 1 or v_count > 221 or v_distinct_count <> v_count then
    raise exception 'INVALID_INVENTORY_BATCH';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(
      "paletteColorId" text,
      quantity integer,
      "quantityConfidence" text,
      "lowStockThreshold" integer
    )
    left join public.palette_colors
      on palette_colors.id = item."paletteColorId"
    where item.quantity is null
      or item.quantity < 0
      or item."quantityConfidence" not in ('exact', 'estimated')
      or item."lowStockThreshold" < 0
      or palette_colors.id is null
      or not palette_colors.is_active
  ) then
    raise exception 'INVALID_INVENTORY_BATCH_ITEM';
  end if;

  for v_input in
    select *
    from jsonb_to_recordset(p_items) as item(
      "paletteColorId" text,
      quantity integer,
      "quantityConfidence" text,
      "lowStockThreshold" integer
    )
    order by item."paletteColorId"
  loop
    insert into public.inventory_items (user_id, palette_color_id)
    values (v_user_id, v_input."paletteColorId")
    on conflict (user_id, palette_color_id) do nothing;

    select *
    into v_item
    from public.inventory_items
    where user_id = v_user_id
      and palette_color_id = v_input."paletteColorId"
    for update;

    v_current_quantity := v_item.quantity;
    v_delta := v_input.quantity - v_current_quantity;

    update public.inventory_items
    set
      quantity = v_input.quantity,
      quantity_confidence = v_input."quantityConfidence",
      low_stock_threshold = v_input."lowStockThreshold",
      updated_at = now()
    where id = v_item.id
    returning * into v_item;

    if v_delta <> 0 then
      insert into public.inventory_transactions (
        user_id,
        palette_color_id,
        delta,
        balance_after,
        reason
      )
      values (
        v_user_id,
        v_input."paletteColorId",
        v_delta,
        v_input.quantity,
        'manual_adjustment'
      );
    end if;

    insert into public.audit_logs (
      user_id,
      action,
      entity_type,
      entity_id,
      before_state,
      after_state
    )
    values (
      v_user_id,
      'inventory_item_batch_set',
      'inventory_item',
      v_item.id::text,
      jsonb_build_object('quantity', v_current_quantity),
      jsonb_build_object(
        'quantity', v_input.quantity,
        'quantityConfidence', v_input."quantityConfidence",
        'lowStockThreshold', v_input."lowStockThreshold",
        'paletteColorId', v_input."paletteColorId"
      )
    );
  end loop;

  select jsonb_agg(
    jsonb_build_object(
      'id', inventory_items.id::text,
      'userId', inventory_items.user_id::text,
      'paletteColorId', inventory_items.palette_color_id,
      'quantity', inventory_items.quantity,
      'quantityConfidence', inventory_items.quantity_confidence,
      'lowStockThreshold', inventory_items.low_stock_threshold,
      'updatedAt', inventory_items.updated_at
    )
    order by inventory_items.palette_color_id
  )
  into v_items
  from public.inventory_items
  where inventory_items.user_id = v_user_id
    and inventory_items.palette_color_id in (
      select item."paletteColorId"
      from jsonb_to_recordset(p_items) as item("paletteColorId" text)
    );

  return jsonb_build_object('items', v_items);
end;
$$;

revoke all on function public.set_inventory_items_batch(jsonb) from public;
grant execute on function public.set_inventory_items_batch(jsonb) to authenticated;
