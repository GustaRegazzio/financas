-- ============================================================
-- Migration 0001 — Schema inicial
-- App: Rastreador de Finanças Pessoais
-- Stack: Supabase (PostgreSQL 15+)
-- ============================================================

-- ------------------------------------------------------------
-- 0. EXTENSÕES
-- ------------------------------------------------------------
-- pg_trgm: busca fuzzy por similaridade de trigramas (Motor de Regras)
create extension if not exists pg_trgm;
-- uuid: geração de ids
create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- 1. ENUMS
-- ------------------------------------------------------------
create type category_nature as enum (
  'neutral',    -- categorias comuns (Deep Space Blue na UI)
  'positive',   -- receitas / categorias positivas (Steel Blue)
  'attention'   -- categorias de atenção: Doces, Álcool etc. (Brick Red / Molten Lava)
);

create type transaction_status as enum (
  'pending',    -- importada, aguardando aprovação humana (Human-in-the-Loop)
  'confirmed'   -- aprovada pelo usuário
);

create type transaction_context as enum (
  'personal',   -- fluxo de caixa pessoal
  'father'      -- Fatura do Pai (isolada do fluxo pessoal)
);

create type action_type as enum (
  'categorize',        -- categorização individual
  'bulk_categorize',   -- aprovação em lote
  'uncategorize',      -- reversão manual
  'create_installments'-- projeção de parcelas futuras
);

-- ------------------------------------------------------------
-- 2. TABELA: categories
-- ------------------------------------------------------------
create table categories (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  nature        category_nature not null default 'neutral',
  -- Limite mensal de gastos (Termômetro de Limites). NULL = sem limite.
  monthly_limit numeric(12,2) check (monthly_limit is null or monthly_limit > 0),
  created_at    timestamptz not null default now(),
  unique (user_id, name)
);

-- ------------------------------------------------------------
-- 3. TABELA: transactions
-- ------------------------------------------------------------
create table transactions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  occurred_on        date not null,
  description        text not null,
  -- Descrição normalizada (lowercase, sem acentos/espacos extras) p/ fuzzy e dedup
  description_norm   text generated always as (lower(btrim(description))) stored,
  amount             numeric(12,2) not null,
  status             transaction_status not null default 'pending',
  context            transaction_context not null default 'personal',
  category_id        uuid references categories(id) on delete set null,
  -- Categoria sugerida pelo Motor de Regras (fuzzy), aguardando aprovação
  suggested_category_id uuid references categories(id) on delete set null,
  suggestion_score   real, -- similarity() da sugestão, p/ ordenar pendências

  -- ---- Motor de Parcelamento ----
  installment_group_id uuid,           -- agrupa parcelas da mesma compra
  installment_num      smallint,       -- XX de XX/YY
  installment_total    smallint,       -- YY de XX/YY
  is_projected         boolean not null default false, -- parcela futura inserida pelo sistema

  -- ---- Detector de Assinaturas ----
  subscription_id    uuid,             -- FK adicionada após criação de subscriptions

  imported_at        timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  check (installment_num is null or installment_num >= 1),
  check (installment_total is null or installment_total >= 1),
  check (installment_num is null or installment_total is null or installment_num <= installment_total)
);

-- Filtro anti-duplicação: ignora transações repetidas em imports múltiplos de CSV.
-- installment_num entra no índice p/ não colidir parcelas projetadas de mesma descrição/valor.
create unique index ux_transactions_dedup
  on transactions (user_id, occurred_on, amount, description_norm, coalesce(installment_num, 0));

-- Índice GIN p/ busca fuzzy (pg_trgm) nas descrições
create index ix_transactions_desc_trgm
  on transactions using gin (description_norm gin_trgm_ops);

create index ix_transactions_user_status on transactions (user_id, status);
create index ix_transactions_user_month  on transactions (user_id, occurred_on);
create index ix_transactions_context     on transactions (user_id, context);

-- ------------------------------------------------------------
-- 4. TABELA: rules (Motor de Regras — fuzzy)
-- ------------------------------------------------------------
create table rules (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  pattern              text not null,          -- string base p/ similaridade
  pattern_norm         text generated always as (lower(btrim(pattern))) stored,
  similarity_threshold real not null default 0.35
                       check (similarity_threshold between 0 and 1),
  category_id          uuid not null references categories(id) on delete cascade,
  -- Regra sistêmica de contexto (ex.: isolar Fatura do Pai)
  set_context          transaction_context,
  priority             int not null default 100, -- menor = avaliada primeiro
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);

create index ix_rules_pattern_trgm on rules using gin (pattern_norm gin_trgm_ops);
create index ix_rules_user_active  on rules (user_id, active, priority);

-- ------------------------------------------------------------
-- 5. TABELA: subscriptions (custos fixos detectados)
-- ------------------------------------------------------------
create table subscriptions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  canonical_name   text not null,           -- nome agrupador (fuzzy) ex.: "netflix"
  expected_amount  numeric(12,2) not null,  -- valor médio observado
  amount_tolerance numeric(12,2) not null default 5.00, -- variação aceitável
  category_id      uuid references categories(id) on delete set null,
  first_seen_on    date not null,
  last_seen_on     date not null,
  months_observed  smallint not null default 2,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (user_id, canonical_name)
);

alter table transactions
  add constraint fk_transactions_subscription
  foreign key (subscription_id) references subscriptions(id) on delete set null;

-- ------------------------------------------------------------
-- 6. TABELA: action_history (Undo / Redo)
-- ------------------------------------------------------------
-- Pilha de ações reversíveis. Undo (Ctrl+Z) marca undone=true e aplica
-- prev_state; Redo (Ctrl+Shift+Z) reaplica next_state.
create table action_history (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  action      action_type not null,
  -- ids das transações afetadas (suporta bulk)
  transaction_ids uuid[] not null,
  -- snapshot dos campos mutáveis ANTES da ação: [{id, status, category_id, context}, ...]
  prev_state  jsonb not null,
  -- snapshot DEPOIS da ação (p/ redo)
  next_state  jsonb not null,
  undone      boolean not null default false,
  created_at  timestamptz not null default now()
);

create index ix_history_user_stack on action_history (user_id, created_at desc);

-- ------------------------------------------------------------
-- 7. TABELA: goals (Módulo de Metas)
-- ------------------------------------------------------------
create table goals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,               -- ex.: "Viagem para a Europa"
  target_amount numeric(12,2) not null check (target_amount > 0),
  saved_amount  numeric(12,2) not null default 0 check (saved_amount >= 0),
  due_date      date,                        -- ex.: 2026-10-01
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 8. TRIGGER: updated_at automático
-- ------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_transactions_updated
  before update on transactions
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- 9. FUNÇÃO: sugestão fuzzy de categoria (Motor de Regras)
-- ------------------------------------------------------------
-- Retorna a melhor regra p/ uma descrição, respeitando threshold e prioridade.
create or replace function suggest_category(p_user_id uuid, p_description text)
returns table (rule_id uuid, category_id uuid, set_context transaction_context, score real)
language sql stable as $$
  select r.id, r.category_id, r.set_context,
         similarity(r.pattern_norm, lower(btrim(p_description))) as score
  from rules r
  where r.user_id = p_user_id
    and r.active
    and similarity(r.pattern_norm, lower(btrim(p_description))) >= r.similarity_threshold
  order by r.priority asc, score desc
  limit 1;
$$;

-- ------------------------------------------------------------
-- 10. VIEWS DE DASHBOARD (métricas de topo)
-- ------------------------------------------------------------
-- Saldo total geral (somente contexto pessoal, confirmadas)
create or replace view v_total_balance as
select user_id, sum(amount) as total_balance
from transactions
where status = 'confirmed' and context = 'personal'
group by user_id;

-- Dinheiro livre este mês:
-- saldo do mês − parcelas futuras já projetadas p/ o mês − assinaturas ativas
create or replace view v_free_money_this_month as
with month_tx as (
  select user_id, sum(amount) as month_net
  from transactions
  where context = 'personal'
    and status = 'confirmed'
    and date_trunc('month', occurred_on) = date_trunc('month', current_date)
  group by user_id
),
projected as (
  select user_id, coalesce(sum(abs(amount)), 0) as projected_out
  from transactions
  where context = 'personal'
    and is_projected
    and status = 'pending'
    and date_trunc('month', occurred_on) = date_trunc('month', current_date)
  group by user_id
),
subs as (
  select user_id, coalesce(sum(expected_amount), 0) as subs_out
  from subscriptions
  where active
  group by user_id
)
select
  u.id as user_id,
  coalesce(m.month_net, 0)
    - coalesce(p.projected_out, 0)
    - coalesce(s.subs_out, 0) as free_money
from auth.users u
left join month_tx  m on m.user_id = u.id
left join projected p on p.user_id = u.id
left join subs      s on s.user_id = u.id;

-- Fatura do Pai (mês atual)
create or replace view v_father_invoice_current as
select user_id,
       sum(abs(amount)) as father_total,
       jsonb_agg(jsonb_build_object(
         'date', occurred_on, 'description', description, 'amount', amount
       ) order by occurred_on) as items -- alimenta o export formato WhatsApp
from transactions
where context = 'father'
  and date_trunc('month', occurred_on) = date_trunc('month', current_date)
group by user_id;

-- Termômetro de Limites (categorias de atenção)
create or replace view v_attention_limits as
select
  c.user_id,
  c.id as category_id,
  c.name,
  c.monthly_limit,
  coalesce(sum(abs(t.amount)), 0) as spent_this_month,
  case when c.monthly_limit is not null and c.monthly_limit > 0
       then round(coalesce(sum(abs(t.amount)), 0) / c.monthly_limit * 100, 1)
  end as pct_of_limit
from categories c
left join transactions t
  on t.category_id = c.id
 and t.status = 'confirmed'
 and t.context = 'personal'
 and date_trunc('month', t.occurred_on) = date_trunc('month', current_date)
where c.nature = 'attention'
group by c.user_id, c.id;

-- ------------------------------------------------------------
-- 11. ROW LEVEL SECURITY (padrão Supabase)
-- ------------------------------------------------------------
alter table categories     enable row level security;
alter table transactions   enable row level security;
alter table rules          enable row level security;
alter table subscriptions  enable row level security;
alter table action_history enable row level security;
alter table goals          enable row level security;

do $$
declare t text;
begin
  foreach t in array array['categories','transactions','rules','subscriptions','action_history','goals']
  loop
    execute format(
      'create policy %I_owner on %I for all
         using (user_id = auth.uid())
         with check (user_id = auth.uid());',
      t, t
    );
  end loop;
end $$;
