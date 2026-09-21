alter table public.inventory_transactions
  drop constraint inventory_transactions_reason_check;

alter table public.inventory_transactions
  add constraint inventory_transactions_reason_check check (
    reason in (
      'purchase',
      'manual_adjustment',
      'project_reservation',
      'project_consumption',
      'project_rollback',
      'pattern_consumption',
      'pattern_rollback'
    )
  );

create table public.pattern_card_consumptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pattern_card_id uuid not null references public.pattern_cards (id) on delete restrict,
  material_version_id uuid not null references public.pattern_material_versions (id) on delete restrict,
  material_version integer not null check (material_version > 0),
  idempotency_key uuid not null,
  status text not null default 'applied' check (status in ('applied', 'reverted')),
  total_quantity integer not null check (total_quantity > 0),
  created_at timestamptz not null default now(),
  undo_expires_at timestamptz not null default (now() + interval '10 minutes'),
  reverted_at timestamptz,
  unique (user_id, idempotency_key)
);

create table public.pattern_card_consumption_items (
  id uuid primary key default gen_random_uuid(),
  consumption_id uuid not null references public.pattern_card_consumptions (id) on delete restrict,
  palette_color_id text not null references public.palette_colors (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  balance_after integer not null check (balance_after >= 0),
  consumption_transaction_id uuid not null references public.inventory_transactions (id) on delete restrict,
  rollback_transaction_id uuid references public.inventory_transactions (id) on delete restrict,
  unique (consumption_id, palette_color_id)
);

create index pattern_card_consumptions_card_created_idx
  on public.pattern_card_consumptions (pattern_card_id, created_at desc);

alter table public.pattern_card_consumptions enable row level security;
alter table public.pattern_card_consumption_items enable row level security;
revoke all on public.pattern_card_consumptions, public.pattern_card_consumption_items
  from anon, authenticated;
grant select on public.pattern_card_consumptions, public.pattern_card_consumption_items
  to authenticated;

create policy "users read own pattern consumptions"
  on public.pattern_card_consumptions for select to authenticated
  using (user_id = auth.uid());

create policy "users read own pattern consumption items"
  on public.pattern_card_consumption_items for select to authenticated
  using (exists (
    select 1 from public.pattern_card_consumptions consumption
    where consumption.id = pattern_card_consumption_items.consumption_id
      and consumption.user_id = auth.uid()
  ));

create or replace function public.pattern_card_consumption_json(
  p_consumption_id uuid,
  p_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', consumption.id::text,
    'patternCardId', consumption.pattern_card_id::text,
    'materialVersion', consumption.material_version,
    'idempotencyKey', consumption.idempotency_key::text,
    'status', consumption.status,
    'totalQuantity', consumption.total_quantity,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'paletteColorId', item.palette_color_id,
        'quantity', item.quantity,
        'balanceAfter', case
          when consumption.status = 'reverted' then transaction.balance_after
          else item.balance_after
        end
      ) order by item.palette_color_id)
      from public.pattern_card_consumption_items item
      left join public.inventory_transactions transaction
        on transaction.id = item.rollback_transaction_id
      where item.consumption_id = consumption.id
    ), '[]'::jsonb),
    'createdAt', consumption.created_at,
    'undoExpiresAt', consumption.undo_expires_at,
    'revertedAt', consumption.reverted_at,
    'undoAvailable', consumption.status = 'applied' and now() <= consumption.undo_expires_at
  ))
  from public.pattern_card_consumptions consumption
  where consumption.id = p_consumption_id and consumption.user_id = p_user_id;
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
  v_consumption public.pattern_card_consumptions;
  v_material record;
  v_item public.inventory_items;
  v_transaction public.inventory_transactions;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_idempotency_key is null then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;

  select * into v_existing from public.pattern_card_consumptions
  where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.pattern_card_id <> p_pattern_card_id then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return public.pattern_card_consumption_json(v_existing.id, v_user_id);
  end if;

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
      and inventory.quantity < material.quantity
  ) then raise exception 'INSUFFICIENT_INVENTORY'; end if;

  insert into public.pattern_card_consumptions (
    user_id, pattern_card_id, material_version_id, material_version,
    idempotency_key, total_quantity
  ) values (
    v_user_id, v_card.id, v_version.id, v_version.version,
    p_idempotency_key, v_version.total_quantity
  ) returning * into v_consumption;

  for v_material in
    select palette_color_id, quantity
    from public.pattern_material_items
    where material_version_id = v_version.id
    order by palette_color_id
  loop
    update public.inventory_items set
      quantity = quantity - v_material.quantity,
      updated_at = now()
    where user_id = v_user_id and palette_color_id = v_material.palette_color_id
    returning * into v_item;

    insert into public.inventory_transactions (
      user_id, palette_color_id, delta, balance_after, reason
    ) values (
      v_user_id, v_material.palette_color_id, -v_material.quantity,
      v_item.quantity, 'pattern_consumption'
    ) returning * into v_transaction;

    insert into public.pattern_card_consumption_items (
      consumption_id, palette_color_id, quantity, balance_after,
      consumption_transaction_id
    ) values (
      v_consumption.id, v_material.palette_color_id, v_material.quantity,
      v_item.quantity, v_transaction.id
    );
  end loop;

  insert into public.audit_logs (
    user_id, action, entity_type, entity_id, after_state
  ) values (
    v_user_id, 'pattern_card_inventory_consumed', 'pattern_card_consumption',
    v_consumption.id::text, jsonb_build_object(
      'patternCardId', v_card.id, 'materialVersion', v_version.version,
      'totalQuantity', v_version.total_quantity,
      'idempotencyKey', p_idempotency_key
    )
  );

  return public.pattern_card_consumption_json(v_consumption.id, v_user_id);
end;
$$;

create or replace function public.undo_pattern_card_consumption(p_consumption_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_consumption public.pattern_card_consumptions;
  v_consumed record;
  v_item public.inventory_items;
  v_transaction public.inventory_transactions;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_consumption from public.pattern_card_consumptions
  where id = p_consumption_id and user_id = v_user_id for update;
  if not found then raise exception 'PATTERN_CONSUMPTION_NOT_FOUND'; end if;
  if v_consumption.status = 'reverted' then
    return public.pattern_card_consumption_json(v_consumption.id, v_user_id);
  end if;
  if now() > v_consumption.undo_expires_at then raise exception 'UNDO_EXPIRED'; end if;

  for v_consumed in
    select * from public.pattern_card_consumption_items
    where consumption_id = v_consumption.id
    order by palette_color_id
    for update
  loop
    select * into v_item from public.inventory_items
    where user_id = v_user_id and palette_color_id = v_consumed.palette_color_id
    for update;
    update public.inventory_items set
      quantity = quantity + v_consumed.quantity, updated_at = now()
    where id = v_item.id returning * into v_item;
    insert into public.inventory_transactions (
      user_id, palette_color_id, delta, balance_after, reason
    ) values (
      v_user_id, v_consumed.palette_color_id, v_consumed.quantity,
      v_item.quantity, 'pattern_rollback'
    ) returning * into v_transaction;
    update public.pattern_card_consumption_items
    set rollback_transaction_id = v_transaction.id where id = v_consumed.id;
  end loop;

  update public.pattern_card_consumptions
  set status = 'reverted', reverted_at = now()
  where id = v_consumption.id;

  insert into public.audit_logs (
    user_id, action, entity_type, entity_id, after_state
  ) values (
    v_user_id, 'pattern_card_inventory_restored', 'pattern_card_consumption',
    v_consumption.id::text,
    jsonb_build_object('patternCardId', v_consumption.pattern_card_id,
      'totalQuantity', v_consumption.total_quantity)
  );

  return public.pattern_card_consumption_json(v_consumption.id, v_user_id);
end;
$$;

create or replace function public.get_latest_pattern_card_consumption(p_pattern_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_consumption_id uuid;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (
    select 1 from public.pattern_cards
    where id = p_pattern_card_id and user_id = v_user_id
  ) then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;
  select id into v_consumption_id from public.pattern_card_consumptions
  where pattern_card_id = p_pattern_card_id and user_id = v_user_id
  order by created_at desc limit 1;
  if v_consumption_id is null then return null; end if;
  return public.pattern_card_consumption_json(v_consumption_id, v_user_id);
end;
$$;

revoke all on function public.pattern_card_consumption_json(uuid, uuid) from public;
revoke all on function public.consume_pattern_card_inventory(uuid, uuid) from public;
revoke all on function public.undo_pattern_card_consumption(uuid) from public;
revoke all on function public.get_latest_pattern_card_consumption(uuid) from public;
grant execute on function public.consume_pattern_card_inventory(uuid, uuid) to authenticated;
grant execute on function public.undo_pattern_card_consumption(uuid) to authenticated;
grant execute on function public.get_latest_pattern_card_consumption(uuid) to authenticated;
