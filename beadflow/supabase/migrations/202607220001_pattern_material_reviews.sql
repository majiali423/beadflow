create table public.pattern_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_image_path text not null,
  source_mime_type text not null check (source_mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  perceptual_hash text,
  ocr_status text not null default 'uploaded'
    check (ocr_status in ('uploaded', 'processing', 'needs_review', 'confirmed', 'failed')),
  created_at timestamptz not null default now(),
  unique (user_id, sha256)
);

create table public.pattern_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  asset_id uuid not null references public.pattern_assets (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  declared_total integer check (declared_total is null or declared_total > 0),
  recognized_total integer not null default 0 check (recognized_total >= 0),
  material_version integer not null default 0 check (material_version >= 0),
  review_revision integer not null default 0 check (review_revision >= 0),
  review_conflicts jsonb not null default '[]'::jsonb check (jsonb_typeof(review_conflicts) = 'array'),
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pattern_material_draft_items (
  id uuid primary key,
  pattern_card_id uuid not null references public.pattern_cards (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  palette_color_id text not null references public.palette_colors (id) on delete restrict,
  quantity integer not null check (quantity between 1 and 100000),
  raw_text text check (raw_text is null or length(raw_text) <= 500),
  confidence double precision check (confidence is null or confidence between 0 and 1),
  evidence_region jsonb,
  recognition_source text not null check (recognition_source in ('direct', 'compact', 'spatial', 'manual')),
  review_state text not null check (review_state in ('pending', 'confirmed', 'edited', 'added')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pattern_card_id, palette_color_id),
  check (recognition_source <> 'manual' or review_state <> 'pending'),
  check (
    evidence_region is null or (
      jsonb_typeof(evidence_region) = 'object'
      and (evidence_region->>'x')::double precision >= 0
      and (evidence_region->>'y')::double precision >= 0
      and (evidence_region->>'width')::double precision >= 0
      and (evidence_region->>'height')::double precision >= 0
    )
  )
);

create table public.pattern_material_versions (
  id uuid primary key default gen_random_uuid(),
  pattern_card_id uuid not null references public.pattern_cards (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null check (version > 0),
  total_quantity integer not null check (total_quantity > 0),
  confirmed_at timestamptz not null default now(),
  unique (pattern_card_id, version)
);

create table public.pattern_material_items (
  id uuid primary key,
  material_version_id uuid not null references public.pattern_material_versions (id) on delete cascade,
  pattern_card_id uuid not null references public.pattern_cards (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  palette_color_id text not null references public.palette_colors (id) on delete restrict,
  quantity integer not null check (quantity between 1 and 100000),
  raw_text text,
  confidence double precision check (confidence is null or confidence between 0 and 1),
  evidence_region jsonb,
  recognition_source text not null check (recognition_source in ('direct', 'compact', 'spatial', 'manual')),
  unique (material_version_id, palette_color_id)
);

create index pattern_cards_user_updated_idx on public.pattern_cards (user_id, updated_at desc);
create index pattern_material_versions_card_idx
  on public.pattern_material_versions (pattern_card_id, version desc);
create index pattern_material_items_palette_idx on public.pattern_material_items (palette_color_id);

alter table public.pattern_assets enable row level security;
alter table public.pattern_cards enable row level security;
alter table public.pattern_material_draft_items enable row level security;
alter table public.pattern_material_versions enable row level security;
alter table public.pattern_material_items enable row level security;

revoke all on public.pattern_assets, public.pattern_cards, public.pattern_material_draft_items,
  public.pattern_material_versions, public.pattern_material_items from anon, authenticated;
grant select on public.pattern_assets, public.pattern_cards, public.pattern_material_draft_items,
  public.pattern_material_versions, public.pattern_material_items to authenticated;

create policy "users read own pattern assets" on public.pattern_assets for select
  to authenticated using (user_id = auth.uid());
create policy "users read own pattern cards" on public.pattern_cards for select
  to authenticated using (user_id = auth.uid());
create policy "users read own material drafts" on public.pattern_material_draft_items for select
  to authenticated using (user_id = auth.uid());
create policy "users read own material versions" on public.pattern_material_versions for select
  to authenticated using (user_id = auth.uid());
create policy "users read own material items" on public.pattern_material_items for select
  to authenticated using (user_id = auth.uid());

create or replace function public.get_pattern_material_review(p_pattern_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_card public.pattern_cards;
  v_items jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_card from public.pattern_cards
  where id = p_pattern_card_id and user_id = v_user_id;
  if not found then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', item.id::text,
    'paletteColorId', item.palette_color_id,
    'quantity', item.quantity,
    'rawText', item.raw_text,
    'confidence', item.confidence,
    'evidenceRegion', item.evidence_region,
    'recognitionSource', item.recognition_source,
    'reviewState', item.review_state
  ) order by item.created_at, item.id), '[]'::jsonb)
  into v_items from public.pattern_material_draft_items item
  where item.pattern_card_id = v_card.id;

  return jsonb_strip_nulls(jsonb_build_object(
    'patternCardId', v_card.id::text,
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

create or replace function public.save_pattern_material_review(
  p_pattern_card_id uuid,
  p_expected_revision integer,
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
  v_card public.pattern_cards;
  v_count integer;
  v_distinct_count integer;
  v_total integer;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_expected_revision < 0
    or (p_declared_total is not null and p_declared_total not between 1 and 1000000)
    or jsonb_typeof(p_items) <> 'array'
    or jsonb_typeof(p_conflicts) <> 'array' then raise exception 'INVALID_REVIEW_DRAFT'; end if;

  select * into v_card from public.pattern_cards
  where id = p_pattern_card_id and user_id = v_user_id for update;
  if not found then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;
  if v_card.review_revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;
  if v_card.status = 'archived' then raise exception 'PATTERN_CARD_ARCHIVED'; end if;

  select count(*), count(distinct draft."paletteColorId"), coalesce(sum(draft.quantity), 0)
  into v_count, v_distinct_count, v_total
  from jsonb_to_recordset(p_items) as draft(
    id uuid, "paletteColorId" text, quantity integer, "rawText" text,
    confidence double precision, "evidenceRegion" jsonb,
    "recognitionSource" text, "reviewState" text
  );
  if v_count > 221 or v_count <> v_distinct_count then raise exception 'INVALID_REVIEW_DRAFT'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as draft(
      id uuid, "paletteColorId" text, quantity integer, "rawText" text,
      confidence double precision, "evidenceRegion" jsonb,
      "recognitionSource" text, "reviewState" text
    ) left join public.palette_colors color on color.id = draft."paletteColorId"
    where draft.id is null or color.id is null or not color.is_active
      or draft.quantity not between 1 and 100000
      or draft."recognitionSource" not in ('direct', 'compact', 'spatial', 'manual')
      or draft."reviewState" not in ('pending', 'confirmed', 'edited', 'added')
      or (draft."recognitionSource" = 'manual' and draft."reviewState" = 'pending')
  ) then raise exception 'INVALID_REVIEW_DRAFT_ITEM'; end if;

  delete from public.pattern_material_draft_items where pattern_card_id = v_card.id;
  insert into public.pattern_material_draft_items (
    id, pattern_card_id, user_id, palette_color_id, quantity, raw_text,
    confidence, evidence_region, recognition_source, review_state
  ) select draft.id, v_card.id, v_user_id, draft."paletteColorId", draft.quantity,
    draft."rawText", draft.confidence, draft."evidenceRegion",
    draft."recognitionSource", draft."reviewState"
  from jsonb_to_recordset(p_items) as draft(
    id uuid, "paletteColorId" text, quantity integer, "rawText" text,
    confidence double precision, "evidenceRegion" jsonb,
    "recognitionSource" text, "reviewState" text
  );

  update public.pattern_cards set
    declared_total = p_declared_total,
    recognized_total = v_total,
    review_conflicts = p_conflicts,
    review_revision = review_revision + 1,
    status = 'draft',
    updated_at = now()
  where id = v_card.id;

  insert into public.audit_logs (user_id, action, entity_type, entity_id, before_state, after_state)
  values (v_user_id, 'pattern_material_review_saved', 'pattern_card', v_card.id::text,
    jsonb_build_object('revision', v_card.review_revision, 'recognizedTotal', v_card.recognized_total),
    jsonb_build_object('revision', v_card.review_revision + 1, 'recognizedTotal', v_total));

  return public.get_pattern_material_review(v_card.id);
end;
$$;

create or replace function public.confirm_pattern_material_review(
  p_pattern_card_id uuid,
  p_expected_revision integer,
  p_accept_declared_total_mismatch boolean
)
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
  select * into v_card from public.pattern_cards
  where id = p_pattern_card_id and user_id = v_user_id for update;
  if not found then raise exception 'PATTERN_CARD_NOT_FOUND'; end if;
  if v_card.review_revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;
  if jsonb_array_length(v_card.review_conflicts) > 0 then raise exception 'UNRESOLVED_CONFLICTS'; end if;
  if v_card.recognized_total <= 0 or exists (
    select 1 from public.pattern_material_draft_items
    where pattern_card_id = v_card.id and review_state = 'pending'
  ) then raise exception 'REVIEW_INCOMPLETE'; end if;
  if v_card.declared_total is not null and v_card.declared_total <> v_card.recognized_total
    and not p_accept_declared_total_mismatch then raise exception 'TOTAL_MISMATCH_NOT_ACCEPTED'; end if;

  insert into public.pattern_material_versions (pattern_card_id, user_id, version, total_quantity)
  values (v_card.id, v_user_id, v_card.material_version + 1, v_card.recognized_total)
  returning * into v_version;

  insert into public.pattern_material_items (
    id, material_version_id, pattern_card_id, user_id, palette_color_id,
    quantity, raw_text, confidence, evidence_region, recognition_source
  ) select gen_random_uuid(), v_version.id, v_card.id, v_user_id, item.palette_color_id,
    item.quantity, item.raw_text, item.confidence, item.evidence_region, item.recognition_source
  from public.pattern_material_draft_items item where item.pattern_card_id = v_card.id;

  update public.pattern_cards set material_version = v_version.version,
    status = 'confirmed', review_revision = review_revision + 1, updated_at = now()
  where id = v_card.id;
  update public.pattern_assets set ocr_status = 'confirmed'
  where id = v_card.asset_id and user_id = v_user_id;

  insert into public.audit_logs (user_id, action, entity_type, entity_id, before_state, after_state)
  values (v_user_id, 'pattern_material_version_confirmed', 'pattern_material_version',
    v_version.id::text, null, jsonb_build_object('patternCardId', v_card.id::text,
    'version', v_version.version, 'totalQuantity', v_version.total_quantity));

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', item.id::text, 'paletteColorId', item.palette_color_id,
    'quantity', item.quantity, 'rawText', item.raw_text,
    'confidence', item.confidence, 'evidenceRegion', item.evidence_region,
    'recognitionSource', item.recognition_source
  )) order by item.palette_color_id) into v_items
  from public.pattern_material_items item where item.material_version_id = v_version.id;

  return jsonb_build_object(
    'id', v_version.id::text, 'patternCardId', v_card.id::text,
    'version', v_version.version, 'totalQuantity', v_version.total_quantity,
    'items', coalesce(v_items, '[]'::jsonb), 'confirmedAt', v_version.confirmed_at
  );
end;
$$;

revoke all on function public.get_pattern_material_review(uuid) from public;
revoke all on function public.save_pattern_material_review(uuid, integer, integer, jsonb, jsonb) from public;
revoke all on function public.confirm_pattern_material_review(uuid, integer, boolean) from public;
grant execute on function public.get_pattern_material_review(uuid) to authenticated;
grant execute on function public.save_pattern_material_review(uuid, integer, integer, jsonb, jsonb) to authenticated;
grant execute on function public.confirm_pattern_material_review(uuid, integer, boolean) to authenticated;
