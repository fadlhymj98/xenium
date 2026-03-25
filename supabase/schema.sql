create table if not exists public.blocks (
  id bigint generated always as identity primary key,
  height integer not null unique,
  hash text not null unique,
  previous_hash text not null,
  nonce bigint not null,
  timestamp timestamptz not null,
  difficulty integer not null,
  mining_reward numeric not null,
  created_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id bigint generated always as identity primary key,
  block_id bigint references public.blocks(id) on delete cascade,
  tx_order integer not null default 0,
  from_address text,
  to_address text not null,
  amount numeric not null,
  timestamp timestamptz not null,
  is_pending boolean not null default false,
  public_key text,
  signature text,
  created_at timestamptz not null default now()
);

alter table public.transactions add column if not exists public_key text;
alter table public.transactions add column if not exists signature text;

create unique index if not exists ux_transactions_block_order
  on public.transactions(block_id, tx_order)
  where is_pending = false;

create index if not exists idx_blocks_height on public.blocks(height);
create index if not exists idx_transactions_block_id on public.transactions(block_id);
create index if not exists idx_transactions_pending on public.transactions(is_pending);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_blocks_nonce_nonnegative'
  ) then
    alter table public.blocks
      add constraint chk_blocks_nonce_nonnegative check (nonce >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chk_blocks_difficulty_positive'
  ) then
    alter table public.blocks
      add constraint chk_blocks_difficulty_positive check (difficulty > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chk_blocks_reward_positive'
  ) then
    alter table public.blocks
      add constraint chk_blocks_reward_positive check (mining_reward > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chk_transactions_amount_positive'
  ) then
    alter table public.transactions
      add constraint chk_transactions_amount_positive check (amount > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chk_pending_block_relation'
  ) then
    alter table public.transactions
      add constraint chk_pending_block_relation check (
        (is_pending = true and block_id is null)
        or (is_pending = false and block_id is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chk_signature_for_non_reward'
  ) then
    alter table public.transactions
      add constraint chk_signature_for_non_reward check (
        from_address is null
        or (public_key is not null and signature is not null)
      );
  end if;
end $$;

create or replace function public.append_mined_block(
  p_height integer,
  p_hash text,
  p_previous_hash text,
  p_nonce bigint,
  p_timestamp timestamptz,
  p_difficulty integer,
  p_mining_reward numeric,
  p_transactions jsonb
)
returns void
language plpgsql
security definer
as $$
declare
  v_block_id bigint;
  v_tx jsonb;
begin
  insert into public.blocks(
    height, hash, previous_hash, nonce, timestamp, difficulty, mining_reward
  )
  values (
    p_height, p_hash, p_previous_hash, p_nonce, p_timestamp, p_difficulty, p_mining_reward
  )
  returning id into v_block_id;

  for v_tx in
    select value from jsonb_array_elements(coalesce(p_transactions, '[]'::jsonb))
  loop
    insert into public.transactions(
      block_id,
      tx_order,
      from_address,
      to_address,
      amount,
      timestamp,
      is_pending,
      public_key,
      signature
    )
    values (
      v_block_id,
      coalesce((v_tx->>'tx_order')::integer, 0),
      nullif(v_tx->>'from_address', ''),
      v_tx->>'to_address',
      (v_tx->>'amount')::numeric,
      (v_tx->>'timestamp')::timestamptz,
      false,
      nullif(v_tx->>'public_key', ''),
      nullif(v_tx->>'signature', '')
    );
  end loop;

  delete from public.transactions where is_pending = true;
end;
$$;
