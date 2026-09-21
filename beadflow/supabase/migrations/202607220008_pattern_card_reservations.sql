create table public.pattern_card_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pattern_card_id uuid not null references public.pattern_cards (id) on delete restrict,
  material_version_id uuid not null references public.pattern_material_versions (id) on delete restrict,
  material_version integer not null check (material_version > 0),
  idempotency_key uuid not null,
  status text not null default 'active' check (status in ('active', 'released', 'consumed')),
  total_quantity integer not null check (total_quantity > 0),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  consumed_at timestamptz,
  unique (user_id, idempotency_key)
);

create unique index pattern_card_reservations_one_active_per_card
  on public.pattern_card_reservations (user_id, pattern_card_id)
  where status = 'active';
create index pattern_card_reservations_user_status
  on public.pattern_card_reservations (user_id, status, created_at desc);

create table public.pattern_card_reservation_items (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.pattern_card_reservations (id) on delete restrict,
  palette_color_id text not null references public.palette_colors (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unique (reservation_id, palette_color_id)
);

alter table public.pattern_card_reservations enable row level security;
alter table public.pattern_card_reservation_items enable row level security;
revoke all on public.pattern_card_reservations, public.pattern_card_reservation_items
  from anon, authenticated;
grant select on public.pattern_card_reservations, public.pattern_card_reservation_items
  to authenticated;

create policy "users read own pattern reservations"
  on public.pattern_card_reservations for select to authenticated
  using (user_id = auth.uid());
create policy "users read own pattern reservation items"
  on public.pattern_card_reservation_items for select to authenticated
  using (exists (
    select 1 from public.pattern_card_reservations reservation
    where reservation.id = pattern_card_reservation_items.reservation_id
      and reservation.user_id = auth.uid()
  ));

create or replace function public.pattern_card_reservation_json(
  p_reservation_id uuid,
  p_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', reservation.id::text,
    'patternCardId', reservation.pattern_card_id::text,
    'materialVersion', reservation.material_version,
    'idempotencyKey', reservation.idempotency_key::text,
    'status', reservation.status,
    'totalQuantity', reservation.total_quantity,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'paletteColorId', item.palette_color_id,
        'quantity', item.quantity
      ) order by item.palette_color_id)
      from public.pattern_card_reservation_items item
      where item.reservation_id = reservation.id
    ), '[]'::jsonb),
    'createdAt', reservation.created_at,
    'releasedAt', reservation.released_at,
    'consumedAt', reservation.consumed_at
  ))
  from public.pattern_card_reservations reservation
  where reservation.id = p_reservation_id and reservation.user_id = p_user_id;
$$;

create or replace function public.list_active_pattern_card_reservations()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  return coalesce((
    select jsonb_agg(public.pattern_card_reservation_json(reservation.id, v_user_id)
      order by reservation.created_at, reservation.id)
    from public.pattern_card_reservations reservation
    where reservation.user_id = v_user_id and reservation.status = 'active'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_active_pattern_card_reservation(p_pattern_card_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_reservation_id uuid;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (
    select 1 from public.pattern_cards
    where id = p_pattern_card_id and user_id = v_user_id
  ) then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;
  select id into v_reservation_id
  from public.pattern_card_reservations
  where user_id = v_user_id and pattern_card_id = p_pattern_card_id and status = 'active';
  if v_reservation_id is null then return null; end if;
  return public.pattern_card_reservation_json(v_reservation_id, v_user_id);
end;
$$;

create or replace function public.reserve_pattern_card_inventory(
  p_pattern_card_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.pattern_card_reservations;
  v_card public.pattern_cards;
  v_version public.pattern_material_versions;
  v_reservation public.pattern_card_reservations;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_idempotency_key is null then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  select * into v_existing from public.pattern_card_reservations
  where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.pattern_card_id <> p_pattern_card_id then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return public.pattern_card_reservation_json(v_existing.id, v_user_id);
  end if;

  select * into v_existing from public.pattern_card_reservations
  where user_id = v_user_id and pattern_card_id = p_pattern_card_id and status = 'active';
  if found then return public.pattern_card_reservation_json(v_existing.id, v_user_id); end if;

  select * into v_card from public.pattern_cards
  where id = p_pattern_card_id and user_id = v_user_id for update;
  if not found then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;
  if v_card.status <> 'confirmed' then raise exception 'PATTERN_MATERIALS_NOT_CONFIRMED'; end if;

  select * into v_version from public.pattern_material_versions
  where pattern_card_id = v_card.id and user_id = v_user_id
  order by version desc limit 1;
  if not found then raise exception 'PATTERN_MATERIALS_NOT_CONFIRMED'; end if;

  insert into public.inventory_items (user_id, palette_color_id)
  select v_user_id, material.palette_color_id
  from public.pattern_material_items material
  where material.material_version_id = v_version.id
  on conflict (user_id, palette_color_id) do nothing;

  perform inventory.id
  from public.inventory_items inventory
  join public.pattern_material_items material
    on material.palette_color_id = inventory.palette_color_id
   and material.material_version_id = v_version.id
  where inventory.user_id = v_user_id
  order by inventory.palette_color_id
  for update of inventory;

  if exists (
    select 1
    from public.pattern_material_items material
    join public.inventory_items inventory
      on inventory.user_id = v_user_id
     and inventory.palette_color_id = material.palette_color_id
    where material.material_version_id = v_version.id
      and inventory.quantity - coalesce((
        select sum(item.quantity)
        from public.pattern_card_reservation_items item
        join public.pattern_card_reservations reservation on reservation.id = item.reservation_id
        where reservation.user_id = v_user_id
          and reservation.status = 'active'
          and item.palette_color_id = material.palette_color_id
      ), 0) < material.quantity
  ) then raise exception 'INSUFFICIENT_AVAILABLE_INVENTORY'; end if;

  insert into public.pattern_card_reservations (
    user_id, pattern_card_id, material_version_id, material_version,
    idempotency_key, total_quantity
  ) values (
    v_user_id, v_card.id, v_version.id, v_version.version,
    p_idempotency_key, v_version.total_quantity
  ) returning * into v_reservation;

  insert into public.pattern_card_reservation_items (reservation_id, palette_color_id, quantity)
  select v_reservation.id, material.palette_color_id, material.quantity
  from public.pattern_material_items material
  where material.material_version_id = v_version.id;

  insert into public.audit_logs (user_id, action, entity_type, entity_id, after_state)
  values (
    v_user_id, 'pattern_card_inventory_reserved', 'pattern_card_reservation',
    v_reservation.id::text,
    jsonb_build_object('patternCardId', v_card.id, 'materialVersion', v_version.version,
      'totalQuantity', v_version.total_quantity, 'idempotencyKey', p_idempotency_key)
  );
  return public.pattern_card_reservation_json(v_reservation.id, v_user_id);
end;
$$;

create or replace function public.release_pattern_card_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.pattern_card_reservations;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  select * into v_reservation from public.pattern_card_reservations
  where id = p_reservation_id and user_id = v_user_id for update;
  if not found then raise exception 'PATTERN_RESERVATION_NOT_FOUND'; end if;
  if v_reservation.status = 'released' then
    return public.pattern_card_reservation_json(v_reservation.id, v_user_id);
  end if;
  if v_reservation.status = 'consumed' then raise exception 'RESERVATION_ALREADY_CONSUMED'; end if;

  update public.pattern_card_reservations
  set status = 'released', released_at = now()
  where id = v_reservation.id;
  insert into public.audit_logs (user_id, action, entity_type, entity_id, after_state)
  values (
    v_user_id, 'pattern_card_inventory_reservation_released', 'pattern_card_reservation',
    v_reservation.id::text,
    jsonb_build_object('patternCardId', v_reservation.pattern_card_id,
      'totalQuantity', v_reservation.total_quantity)
  );
  return public.pattern_card_reservation_json(v_reservation.id, v_user_id);
end;
$$;

create or replace function public.consume_pattern_card_inventory(
  p_pattern_card_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.pattern_card_consumptions;
  v_card public.pattern_cards;
  v_version public.pattern_material_versions;
  v_reservation public.pattern_card_reservations;
  v_consumption public.pattern_card_consumptions;
  v_material record;
  v_item public.inventory_items;
  v_transaction public.inventory_transactions;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_idempotency_key is null then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  select * into v_existing from public.pattern_card_consumptions
  where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.pattern_card_id <> p_pattern_card_id then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
    return public.pattern_card_consumption_json(v_existing.id, v_user_id);
  end if;

  select * into v_card from public.pattern_cards
  where id = p_pattern_card_id and user_id = v_user_id for update;
  if not found then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;
  if v_card.status <> 'confirmed' then raise exception 'PATTERN_MATERIALS_NOT_CONFIRMED'; end if;
  select * into v_version from public.pattern_material_versions
  where pattern_card_id = v_card.id and user_id = v_user_id order by version desc limit 1;
  if not found then raise exception 'PATTERN_MATERIALS_NOT_CONFIRMED'; end if;

  select * into v_reservation from public.pattern_card_reservations
  where user_id = v_user_id and pattern_card_id = p_pattern_card_id and status = 'active'
  for update;
  if found and v_reservation.material_version_id <> v_version.id then
    raise exception 'RESERVATION_VERSION_MISMATCH';
  end if;

  insert into public.inventory_items (user_id, palette_color_id)
  select v_user_id, material.palette_color_id
  from public.pattern_material_items material where material.material_version_id = v_version.id
  on conflict (user_id, palette_color_id) do nothing;
  perform inventory.id
  from public.inventory_items inventory
  join public.pattern_material_items material
    on material.palette_color_id = inventory.palette_color_id
   and material.material_version_id = v_version.id
  where inventory.user_id = v_user_id order by inventory.palette_color_id
  for update of inventory;

  if exists (
    select 1
    from public.pattern_material_items material
    join public.inventory_items inventory
      on inventory.user_id = v_user_id and inventory.palette_color_id = material.palette_color_id
    where material.material_version_id = v_version.id
      and inventory.quantity - coalesce((
        select sum(item.quantity)
        from public.pattern_card_reservation_items item
        join public.pattern_card_reservations reservation on reservation.id = item.reservation_id
        where reservation.user_id = v_user_id and reservation.status = 'active'
          and reservation.id <> coalesce(v_reservation.id, '00000000-0000-0000-0000-000000000000'::uuid)
          and item.palette_color_id = material.palette_color_id
      ), 0) < material.quantity
  ) then raise exception 'INSUFFICIENT_AVAILABLE_INVENTORY'; end if;

  insert into public.pattern_card_consumptions (
    user_id, pattern_card_id, material_version_id, material_version,
    idempotency_key, total_quantity
  ) values (
    v_user_id, v_card.id, v_version.id, v_version.version,
    p_idempotency_key, v_version.total_quantity
  ) returning * into v_consumption;

  for v_material in
    select palette_color_id, quantity from public.pattern_material_items
    where material_version_id = v_version.id order by palette_color_id
  loop
    update public.inventory_items set quantity = quantity - v_material.quantity, updated_at = now()
    where user_id = v_user_id and palette_color_id = v_material.palette_color_id
    returning * into v_item;
    insert into public.inventory_transactions (user_id, palette_color_id, delta, balance_after, reason)
    values (v_user_id, v_material.palette_color_id, -v_material.quantity,
      v_item.quantity, 'pattern_consumption') returning * into v_transaction;
    insert into public.pattern_card_consumption_items (
      consumption_id, palette_color_id, quantity, balance_after, consumption_transaction_id
    ) values (
      v_consumption.id, v_material.palette_color_id, v_material.quantity,
      v_item.quantity, v_transaction.id
    );
  end loop;

  if v_reservation.id is not null then
    update public.pattern_card_reservations
    set status = 'consumed', consumed_at = now()
    where id = v_reservation.id;
  end if;
  insert into public.audit_logs (user_id, action, entity_type, entity_id, after_state)
  values (
    v_user_id, 'pattern_card_inventory_consumed', 'pattern_card_consumption',
    v_consumption.id::text,
    jsonb_build_object('patternCardId', v_card.id, 'materialVersion', v_version.version,
      'totalQuantity', v_version.total_quantity, 'idempotencyKey', p_idempotency_key,
      'reservationId', v_reservation.id)
  );
  return public.pattern_card_consumption_json(v_consumption.id, v_user_id);
end;
$$;

alter function public.export_my_beadflow_data() rename to export_my_beadflow_data_v1;
revoke all on function public.export_my_beadflow_data_v1() from public, anon, authenticated;

create function public.export_my_beadflow_data()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_export jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  v_export := public.export_my_beadflow_data_v1();
  v_export := jsonb_set(v_export, '{currentProduct,patternCardReservations}', coalesce((
    select jsonb_agg(to_jsonb(reservation) order by reservation.created_at, reservation.id)
    from public.pattern_card_reservations reservation where reservation.user_id = v_user_id
  ), '[]'::jsonb));
  v_export := jsonb_set(v_export, '{currentProduct,patternCardReservationItems}', coalesce((
    select jsonb_agg(to_jsonb(item) order by item.reservation_id, item.id)
    from public.pattern_card_reservation_items item
    join public.pattern_card_reservations reservation on reservation.id = item.reservation_id
    where reservation.user_id = v_user_id
  ), '[]'::jsonb));
  return v_export;
end;
$$;

revoke all on function public.pattern_card_reservation_json(uuid, uuid) from public;
revoke all on function public.list_active_pattern_card_reservations() from public;
revoke all on function public.get_active_pattern_card_reservation(uuid) from public;
revoke all on function public.reserve_pattern_card_inventory(uuid, uuid) from public;
revoke all on function public.release_pattern_card_reservation(uuid) from public;
revoke all on function public.export_my_beadflow_data() from public;
grant execute on function public.list_active_pattern_card_reservations() to authenticated;
grant execute on function public.get_active_pattern_card_reservation(uuid) to authenticated;
grant execute on function public.reserve_pattern_card_inventory(uuid, uuid) to authenticated;
grant execute on function public.release_pattern_card_reservation(uuid) to authenticated;
grant execute on function public.export_my_beadflow_data() to authenticated;
