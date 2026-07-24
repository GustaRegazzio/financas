-- ============================================================
-- Migration 0002 — Views respeitando RLS
-- Por padrão, views no Postgres rodam com permissões do dono
-- (postgres), o que FURARIA o Row Level Security no Supabase.
-- security_invoker=true faz a view rodar como o usuário logado.
-- ============================================================
alter view v_total_balance            set (security_invoker = true);
alter view v_free_money_this_month    set (security_invoker = true);
alter view v_father_invoice_current   set (security_invoker = true);
alter view v_attention_limits         set (security_invoker = true);
