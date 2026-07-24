import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { COLORS, brl } from "../lib/theme";

/* ============================================================
   Dashboard — métricas de topo (views da migration 0001)
   1. Saldo Total Geral (v_total_balance)
   2. Dinheiro Livre este Mês (v_free_money_this_month)
   3. Fatura do Pai + export WhatsApp (v_father_invoice_current)
   + Módulo de Metas (goals) e Termômetro de Limites
     (v_attention_limits, preenchimento em Molten Lava)
   ============================================================ */

export default function Dashboard({ userId }) {
  const [balance, setBalance] = useState(null);
  const [freeMoney, setFreeMoney] = useState(null);
  const [receivables, setReceivables] = useState([]);
  const [goals, setGoals] = useState([]);
  const [limits, setLimits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [b, f, fa, g, l] = await Promise.all([
      supabase.from("v_total_balance").select("*").maybeSingle(),
      supabase.from("v_free_money_this_month").select("*").maybeSingle(),
      supabase.from("v_receivables_by_person").select("*"),
      supabase.from("goals").select("*").order("due_date"),
      supabase.from("v_attention_limits").select("*")
    ]);
    setBalance(b.data?.total_balance ?? 0);
    setFreeMoney(f.data?.free_money ?? 0);
    setReceivables(fa.data ?? []);
    setGoals(g.data ?? []);
    setLimits((l.data ?? []).filter((x) => x.monthly_limit != null));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* Export formato WhatsApp: resumo do que a pessoa deve */
  const copySummary = async (r) => {
    const lines = (r.items ?? []).map((i) => {
      const [, m, d] = i.date.split("-");
      const label = i.note || i.description;
      return `${d}/${m} — ${label}: ${brl(Math.abs(i.amount))}`;
    });
    const text = [
      `*Gastos — ${r.person_name}*`,
      "",
      ...lines,
      "",
      `*Total: ${brl(r.total_due)}*`
    ].join("\n");
    await navigator.clipboard.writeText(text);
    setCopiedId(r.person_id);
    setTimeout(() => setCopiedId(null), 2200);
  };

  if (loading) {
    return (
      <div className="px-4 py-10 text-center text-sm opacity-70">
        Carregando painel…
      </div>
    );
  }

  return (
    <div className="px-4 py-6 md:px-10 md:py-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-6 text-2xl font-bold md:text-3xl">Visão geral</h1>

        {/* ---- Métricas de topo ---- */}
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <MetricCard
            label="Saldo total"
            value={brl(balance)}
            color={balance < 0 ? COLORS.dangerDeep : COLORS.ink}
          />
          <MetricCard
            label="Dinheiro livre este mês"
            value={brl(freeMoney)}
            color={freeMoney < 0 ? COLORS.dangerDeep : COLORS.accent}
            hint="Já descontadas parcelas futuras e assinaturas"
          />

          <MetricCard
            label="A receber"
            value={brl(
              receivables.reduce((s, r) => s + Number(r.total_due), 0)
            )}
            color={COLORS.accent}
            hint="Gastos de terceiros ainda não acertados"
          />
        </div>

        {/* ---- A receber, por pessoa ---- */}
        {receivables.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-4 text-lg font-bold">A receber</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {receivables.map((r) => (
                <div
                  key={r.person_id}
                  className="neu-out rounded-3xl p-5"
                  style={{ borderLeft: `6px solid ${COLORS.accent}` }}
                >
                  <div className="flex items-baseline justify-between">
                    <p className="font-semibold">{r.person_name}</p>
                    <p className="text-lg font-bold">{brl(r.total_due)}</p>
                  </div>
                  <p className="mt-1 text-xs opacity-60">
                    {r.item_count} {r.item_count === 1 ? "lançamento" : "lançamentos"}
                  </p>
                  <button
                    onClick={() => copySummary(r)}
                    className="neu-out-sm neu-btn mt-4 w-full rounded-2xl px-4 py-2 text-xs font-bold"
                    style={{ color: COLORS.accent }}
                  >
                    {copiedId === r.person_id ? "Copiado!" : "Copiar resumo (WhatsApp)"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ---- Módulo de Metas ---- */}
        {goals.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-4 text-lg font-bold">Metas</h2>
            <div className="flex flex-col gap-4">
              {goals.map((g) => {
                const pct = Math.min(
                  100,
                  (g.saved_amount / g.target_amount) * 100
                );
                return (
                  <div key={g.id} className="neu-out rounded-3xl p-5">
                    <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between">
                      <p className="font-semibold">{g.name}</p>
                      <p className="text-sm opacity-75">
                        {brl(g.saved_amount)} de {brl(g.target_amount)}
                        {g.due_date && (
                          <span
                            className="ml-2 rounded-lg px-1.5 py-0.5 text-xs font-semibold"
                            style={{ background: COLORS.highlight }}
                          >
                            {new Date(g.due_date + "T12:00:00").toLocaleDateString(
                              "pt-BR",
                              { month: "short", year: "numeric" }
                            )}
                          </span>
                        )}
                      </p>
                    </div>
                    <ProgressBar pct={pct} fill={COLORS.accent} />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ---- Termômetro de Limites (categorias de atenção) ---- */}
        {limits.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-4 text-lg font-bold">Limites do mês</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {limits.map((c) => {
                const pct = Math.min(100, c.pct_of_limit ?? 0);
                const over = (c.pct_of_limit ?? 0) >= 100;
                return (
                  <div key={c.category_id} className="neu-out rounded-3xl p-5">
                    <div className="flex items-baseline justify-between">
                      <p className="flex items-center gap-2 font-semibold">
                        <span
                          aria-hidden
                          className="inline-block h-3 w-3 rounded-full"
                          style={{ background: COLORS.danger }}
                        />
                        {c.name}
                      </p>
                      <p
                        className="text-sm font-bold"
                        style={{ color: over ? COLORS.dangerDeep : COLORS.ink }}
                      >
                        {brl(c.spent_this_month)} / {brl(c.monthly_limit)}
                      </p>
                    </div>
                    <ProgressBar pct={pct} fill={COLORS.dangerDeep} />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {goals.length === 0 && limits.length === 0 && receivables.length === 0 && (
          <div className="neu-in mt-8 rounded-3xl p-10 text-center">
            <p className="text-lg font-semibold">Painel pronto para começar</p>
            <p className="mt-1 text-sm opacity-75">
              Cadastre categorias com limite mensal e metas no Supabase para
              ver os termômetros e barras de progresso aqui.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* Barra de progresso neumórfica: trilho em baixo-relevo, preenchimento flat */
function ProgressBar({ pct, fill }) {
  return (
    <div
      className="neu-in mt-3 h-4 w-full overflow-hidden rounded-full"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, background: fill }}
      />
    </div>
  );
}

function MetricCard({ label, value, color, hint }) {
  return (
    <div className="neu-out rounded-3xl p-5">
      <p className="text-xs font-semibold uppercase tracking-wide opacity-60">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold" style={{ color }}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs opacity-60">{hint}</p>}
    </div>
  );
}
