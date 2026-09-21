create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  palette_color_id text not null references public.palette_colors (id) on delete restrict,
  quantity integer not null default 0 check (quantity >= 0),
  quantity_confidence text not null default 'exact'
    check (quantity_confidence in ('exact', 'estimated')),
  low_stock_threshold integer check (low_stock_threshold >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, palette_color_id)
);

create table public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  palette_color_id text not null references public.palette_colors (id) on delete restrict,
  delta integer not null check (delta <> 0),
  balance_after integer not null check (balance_after >= 0),
  reason text not null check (
    reason in (
      'purchase',
      'manual_adjustment',
      'project_reservation',
      'project_consumption',
      'project_rollback'
    )
  ),
  project_id uuid references public.projects (id) on delete set null,
  created_at timestamptz not null default now()
);

create index inventory_items_user_updated_at_idx
  on public.inventory_items (user_id, updated_at desc);
create index inventory_transactions_user_created_at_idx
  on public.inventory_transactions (user_id, created_at desc);
create index inventory_transactions_project_id_idx
  on public.inventory_transactions (project_id)
  where project_id is not null;

alter table public.inventory_items enable row level security;
alter table public.inventory_transactions enable row level security;

revoke all on public.inventory_items from anon, authenticated;
revoke all on public.inventory_transactions from anon, authenticated;
grant select on public.inventory_items, public.inventory_transactions to authenticated;

create policy "users read own inventory"
  on public.inventory_items for select
  to authenticated
  using (user_id = auth.uid());

create policy "users read own inventory transactions"
  on public.inventory_transactions for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.apply_inventory_transaction(
  p_palette_color_id text,
  p_delta integer,
  p_reason text,
  p_project_id uuid default null,
  p_quantity_confidence text default null,
  p_low_stock_threshold integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_item public.inventory_items;
  v_transaction public.inventory_transactions;
  v_current_quantity integer := 0;
  v_next_quantity integer;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'INVALID_TRANSACTION_DELTA';
  end if;
  if p_reason not in (
    'purchase',
    'manual_adjustment',
    'project_reservation',
    'project_consumption',
    'project_rollback'
  ) then
    raise exception 'INVALID_TRANSACTION_REASON';
  end if;
  if p_quantity_confidence is not null
    and p_quantity_confidence not in ('exact', 'estimated')
  then
    raise exception 'INVALID_QUANTITY_CONFIDENCE';
  end if;
  if p_low_stock_threshold is not null and p_low_stock_threshold < 0 then
    raise exception 'INVALID_LOW_STOCK_THRESHOLD';
  end if;
  if not exists (
    select 1 from public.palette_colors where id = p_palette_color_id and is_active
  ) then
    raise exception 'UNKNOWN_PALETTE_COLOR';
  end if;
  if p_project_id is not null and not exists (
    select 1
    from public.projects
    where id = p_project_id and user_id = v_user_id
  ) then
    raise exception 'PROJECT_NOT_FOUND';
  end if;

  insert into public.inventory_items (user_id, palette_color_id)
  values (v_user_id, p_palette_color_id)
  on conflict (user_id, palette_color_id) do nothing;

  select *
  into v_item
  from public.inventory_items
  where user_id = v_user_id and palette_color_id = p_palette_color_id
  for update;
  v_current_quantity := v_item.quantity;
  v_next_quantity := v_current_quantity + p_delta;
  if v_next_quantity < 0 then
    raise exception 'INSUFFICIENT_INVENTORY';
  end if;

  insert into public.inventory_items (
    user_id,
    palette_color_id,
    quantity,
    quantity_confidence,
    low_stock_threshold
  )
  values (
    v_user_id,
    p_palette_color_id,
    v_next_quantity,
    coalesce(p_quantity_confidence, 'exact'),
    p_low_stock_threshold
  )
  on conflict (user_id, palette_color_id)
  do update set
    quantity = excluded.quantity,
    quantity_confidence = coalesce(
      p_quantity_confidence,
      inventory_items.quantity_confidence
    ),
    low_stock_threshold = coalesce(
      p_low_stock_threshold,
      inventory_items.low_stock_threshold
    ),
    updated_at = now()
  returning * into v_item;

  insert into public.inventory_transactions (
    user_id,
    palette_color_id,
    delta,
    balance_after,
    reason,
    project_id
  )
  values (
    v_user_id,
    p_palette_color_id,
    p_delta,
    v_next_quantity,
    p_reason,
    p_project_id
  )
  returning * into v_transaction;

  insert into public.audit_logs (
    user_id,
    project_id,
    action,
    entity_type,
    entity_id,
    before_state,
    after_state
  )
  values (
    v_user_id,
    p_project_id,
    'inventory_transaction_applied',
    'inventory_transaction',
    v_transaction.id::text,
    jsonb_build_object('quantity', v_current_quantity),
    jsonb_build_object(
      'quantity', v_next_quantity,
      'delta', p_delta,
      'reason', p_reason,
      'paletteColorId', p_palette_color_id
    )
  );

  return jsonb_build_object(
    'item', jsonb_build_object(
      'id', v_item.id::text,
      'userId', v_item.user_id::text,
      'paletteColorId', v_item.palette_color_id,
      'quantity', v_item.quantity,
      'quantityConfidence', v_item.quantity_confidence,
      'lowStockThreshold', v_item.low_stock_threshold,
      'updatedAt', v_item.updated_at
    ),
    'transaction', jsonb_build_object(
      'id', v_transaction.id::text,
      'userId', v_transaction.user_id::text,
      'paletteColorId', v_transaction.palette_color_id,
      'delta', v_transaction.delta,
      'reason', v_transaction.reason,
      'projectId', v_transaction.project_id,
      'createdAt', v_transaction.created_at
    )
  );
end;
$$;

revoke all on function public.apply_inventory_transaction(
  text,
  integer,
  text,
  uuid,
  text,
  integer
) from public;
grant execute on function public.apply_inventory_transaction(
  text,
  integer,
  text,
  uuid,
  text,
  integer
) to authenticated;

create or replace function public.set_inventory_item(
  p_palette_color_id text,
  p_quantity integer,
  p_quantity_confidence text,
  p_low_stock_threshold integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_item public.inventory_items;
  v_transaction public.inventory_transactions;
  v_current_quantity integer := 0;
  v_delta integer;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_quantity is null or p_quantity < 0 then
    raise exception 'INVALID_INVENTORY_QUANTITY';
  end if;
  if p_quantity_confidence not in ('exact', 'estimated') then
    raise exception 'INVALID_QUANTITY_CONFIDENCE';
  end if;
  if p_low_stock_threshold is not null and p_low_stock_threshold < 0 then
    raise exception 'INVALID_LOW_STOCK_THRESHOLD';
  end if;
  if not exists (
    select 1 from public.palette_colors where id = p_palette_color_id and is_active
  ) then
    raise exception 'UNKNOWN_PALETTE_COLOR';
  end if;

  insert into public.inventory_items (user_id, palette_color_id)
  values (v_user_id, p_palette_color_id)
  on conflict (user_id, palette_color_id) do nothing;

  select *
  into v_item
  from public.inventory_items
  where user_id = v_user_id and palette_color_id = p_palette_color_id
  for update;
  v_current_quantity := v_item.quantity;
  v_delta := p_quantity - v_current_quantity;

  insert into public.inventory_items (
    user_id,
    palette_color_id,
    quantity,
    quantity_confidence,
    low_stock_threshold
  )
  values (
    v_user_id,
    p_palette_color_id,
    p_quantity,
    p_quantity_confidence,
    p_low_stock_threshold
  )
  on conflict (user_id, palette_color_id)
  do update set
    quantity = excluded.quantity,
    quantity_confidence = excluded.quantity_confidence,
    low_stock_threshold = excluded.low_stock_threshold,
    updated_at = now()
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
      p_palette_color_id,
      v_delta,
      p_quantity,
      'manual_adjustment'
    )
    returning * into v_transaction;
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
    'inventory_item_set',
    'inventory_item',
    v_item.id::text,
    jsonb_build_object('quantity', v_current_quantity),
    jsonb_build_object(
      'quantity', p_quantity,
      'quantityConfidence', p_quantity_confidence,
      'lowStockThreshold', p_low_stock_threshold,
      'paletteColorId', p_palette_color_id
    )
  );

  v_result := jsonb_build_object(
    'item', jsonb_build_object(
      'id', v_item.id::text,
      'userId', v_item.user_id::text,
      'paletteColorId', v_item.palette_color_id,
      'quantity', v_item.quantity,
      'quantityConfidence', v_item.quantity_confidence,
      'lowStockThreshold', v_item.low_stock_threshold,
      'updatedAt', v_item.updated_at
    )
  );

  if v_transaction.id is not null then
    v_result := v_result || jsonb_build_object(
      'transaction', jsonb_build_object(
        'id', v_transaction.id::text,
        'userId', v_transaction.user_id::text,
        'paletteColorId', v_transaction.palette_color_id,
        'delta', v_transaction.delta,
        'reason', v_transaction.reason,
        'createdAt', v_transaction.created_at
      )
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.set_inventory_item(text, integer, text, integer)
  from public;
grant execute on function public.set_inventory_item(text, integer, text, integer)
  to authenticated;
