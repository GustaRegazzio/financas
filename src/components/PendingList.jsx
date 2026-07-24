import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "../lib/supabase";
import { COLORS, NATURE_COLOR, brl } from "../lib/theme";
import TransactionForm from "./TransactionForm.jsx";

/* ============================================================
   Lista de Pendências — Human-in-the-Loop (Supabase)
   - Carrega transactions status='pending' + categories
   - Aprovação individual e em lote; grava em action_history
   - Undo/Redo: Ctrl+Z / Ctrl+Shift+Z + botões Steel Blue
   - Projeção de parcelas: ao confirmar a parcela 1/N,
     insere as N-1 futuras (is_projected=true)
   ============================================================ */

const shortDate = (iso) => {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
};

const addMonths = (iso, n) => {
  const d = new Date(iso + "T12:00:00");
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
};

export default function PendingList({ userId }) {
  const [pending, setPending] = useState([]);
  const [categories, setCategories] = useState([]);
  const [people, setPeople] = useState([]);
  const [methods, setMethods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const catById = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c])),
    [categories]
  );

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  /* ---------- Carga inicial ---------- */
  const load = useCallback(async () => {
    setLoading(true);
    const [tx, cats, ppl, pm] = await Promise.all([
      supabase
        .from("transactions")
        .select("*")
        .eq("status", "pending")
        .order("occurred_on", { ascending: true }),
      supabase.from("categories").select("*").order("name"),
      supabase.from("people").select("*").eq("active", true).order("is_owner", { ascending: false }),
      supabase.from("payment_methods").select("*").eq("active", true).order("name")
    ]);
    if (!tx.error) setPending(tx.data ?? []);
    if (!cats.error) setCategories(cats.data ?? []);
    if (!ppl.error) setPeople(ppl.data ?? []);
    if (!pm.error) setMethods(pm.data ?? []);
    setLoading(false);
  }, []);

  /* Reidrata as pilhas do banco: undo/redo sobrevive a recarregar a página */
  const hydrateStacks = useCallback(async () => {
    const { data } = await supabase
      .from("action_history")
      .select("*")
      .in("action", ["categorize", "bulk_categorize"])
      .order("created_at", { ascending: true })
      .limit(50);
    if (!data) return;
    const toEntry = (h) => ({
      historyId: h.id,
      prev: h.prev_state,
      next: h.next_state
    });
    setUndoStack(data.filter((h) => !h.undone).map(toEntry));
    setRedoStack(data.filter((h) => h.undone).reverse().map(toEntry));
  }, []);

  useEffect(() => {
    load();
    hydrateStacks();
  }, [load, hydrateStacks]);

  /* ---------- Aprovação (individual e lote) ---------- */
  const approve = useCallback(
    async (ids) => {
      const affected = pending.filter((t) => ids.includes(t.id));
      if (affected.length === 0) return;

      const prevState = affected.map((t) => ({
        id: t.id,
        status: "pending",
        category_id: t.category_id
      }));
      const nextState = affected.map((t) => ({
        id: t.id,
        status: "confirmed",
        category_id: t.suggested_category_id ?? t.category_id
      }));

      // 1. Confirma as transações (categoria = sugestão aceita)
      for (const t of affected) {
        const { error } = await supabase
          .from("transactions")
          .update({
            status: "confirmed",
            category_id: t.suggested_category_id ?? t.category_id
          })
          .eq("id", t.id);
        if (error) {
          showToast("Erro ao aprovar — nada foi alterado localmente");
          return;
        }
      }

      // 2. Registra no histórico (base do undo/redo persistido)
      const { data: hist } = await supabase
        .from("action_history")
        .insert({
          user_id: userId,
          action: affected.length > 1 ? "bulk_categorize" : "categorize",
          transaction_ids: affected.map((t) => t.id),
          prev_state: prevState,
          next_state: nextState
        })
        .select()
        .single();

      // 3. Motor de Parcelamento: parcela 1/N confirma → projeta futuras
      for (const t of affected) {
        if (t.installment_num === 1 && t.installment_total > 1 && !t.is_projected) {
          const groupId = t.installment_group_id ?? crypto.randomUUID();
          if (!t.installment_group_id) {
            await supabase
              .from("transactions")
              .update({ installment_group_id: groupId })
              .eq("id", t.id);
          }
          const future = [];
          for (let i = 2; i <= t.installment_total; i++) {
            future.push({
              user_id: userId,
              occurred_on: addMonths(t.occurred_on, i - 1),
              description: t.description.replace(
                /\b0?1\/(\d{1,2})\b/,
                `${String(i).padStart(2, "0")}/$1`
              ),
              amount: t.amount,
              status: "pending",
              context: t.context,
              category_id: t.suggested_category_id ?? t.category_id,
              suggested_category_id: t.suggested_category_id,
              installment_group_id: groupId,
              installment_num: i,
              installment_total: t.installment_total,
              is_projected: true
            });
          }
          if (future.length > 0) {
            // upsert ignorando duplicatas (índice anti-dup protege re-imports)
            await supabase
              .from("transactions")
              .upsert(future, { onConflict: undefined, ignoreDuplicates: true });
          }
        }
      }

      setUndoStack((s) => [
        ...s,
        { historyId: hist?.id, prev: prevState, next: nextState }
      ]);
      setRedoStack([]);
      setPending((p) => p.filter((t) => !ids.includes(t.id)));
      setSelected(new Set());
      showToast(
        affected.length === 1
          ? "1 transação aprovada"
          : `${affected.length} transações aprovadas`
      );
      // recarrega p/ trazer parcelas projetadas recém-criadas
      load();
    },
    [pending, userId, load]
  );

  /* ---------- Undo / Redo ---------- */
  const undo = useCallback(async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    for (const t of last.prev) {
      await supabase
        .from("transactions")
        .update({ status: t.status, category_id: t.category_id })
        .eq("id", t.id);
    }
    if (last.historyId) {
      await supabase
        .from("action_history")
        .update({ undone: true })
        .eq("id", last.historyId);
    }
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((r) => [...r, last]);
    showToast("Aprovação desfeita — de volta para pendentes");
    load();
  }, [undoStack, load]);

  const redo = useCallback(async () => {
    const last = redoStack[redoStack.length - 1];
    if (!last) return;
    for (const t of last.next) {
      await supabase
        .from("transactions")
        .update({ status: t.status, category_id: t.category_id })
        .eq("id", t.id);
    }
    if (last.historyId) {
      await supabase
        .from("action_history")
        .update({ undone: false })
        .eq("id", last.historyId);
    }
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((u) => [...u, last]);
    showToast("Aprovação refeita");
    load();
  }, [redoStack, load]);

  /* Atalhos globais obrigatórios */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  /* ---------- Seleção e edição da sugestão ---------- */
  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allSelected = pending.length > 0 && selected.size === pending.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(pending.map((t) => t.id)));

  const changeSuggestion = async (id, categoryId) => {
    setPending((p) =>
      p.map((t) =>
        t.id === id ? { ...t, suggested_category_id: categoryId || null } : t
      )
    );
    await supabase
      .from("transactions")
      .update({ suggested_category_id: categoryId || null })
      .eq("id", id);
  };

  /* ---------- UI ---------- */
  return (
    <div className="px-4 py-6 md:px-10 md:py-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold md:text-3xl">Pendências</h1>
            <p className="mt-1 text-sm opacity-80">
              {loading
                ? "Carregando…"
                : pending.length === 0
                  ? "Tudo revisado por aqui."
                  : `${pending.length} transações aguardando sua revisão`}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={undo}
              disabled={undoStack.length === 0}
              title="Desfazer (Ctrl+Z)"
              className="neu-out-sm neu-btn rounded-2xl px-4 py-2 text-sm font-semibold disabled:opacity-40"
              style={{ color: COLORS.accent }}
            >
              ↩ Desfazer
            </button>
            <button
              onClick={redo}
              disabled={redoStack.length === 0}
              title="Refazer (Ctrl+Shift+Z)"
              className="neu-out-sm neu-btn rounded-2xl px-4 py-2 text-sm font-semibold disabled:opacity-40"
              style={{ color: COLORS.accent }}
            >
              ↪ Refazer
            </button>
          </div>
        </header>

        {pending.length > 0 && (
          <div className="neu-in mb-5 flex flex-col gap-3 rounded-3xl px-5 py-4 md:flex-row md:items-center md:justify-between">
            <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
              <NeuCheckbox checked={allSelected} onChange={toggleAll} />
              Selecionar todas
            </label>
            <button
              onClick={() => approve([...selected])}
              disabled={selected.size === 0}
              className="neu-btn rounded-2xl px-6 py-3 text-sm font-bold text-white disabled:opacity-40"
              style={{
                background: COLORS.danger,
                boxShadow: `-4px -4px 12px rgba(255,255,255,0.7), 4px 4px 12px ${COLORS.shadowDark}`
              }}
            >
              Aprovar selecionadas{selected.size > 0 ? ` (${selected.size})` : ""}
            </button>
          </div>
        )}

        <ul className="flex flex-col gap-4">
          {pending.map((t) => {
            const cat = t.suggested_category_id
              ? catById[t.suggested_category_id]
              : null;
            const dotColor = cat
              ? NATURE_COLOR[cat.nature]
              : COLORS.surface;
            const person = people.find((p) => p.id === t.person_id);
            const isFather = Boolean(person && !person.is_owner);
            return (
              <li
                key={t.id}
                className="neu-out rounded-3xl p-4 md:p-5"
                style={
                  isFather
                    ? { borderLeft: `6px solid ${COLORS.accent}` }
                    : undefined
                }
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center">
                  <div className="flex items-start gap-3 md:items-center">
                    <NeuCheckbox
                      checked={selected.has(t.id)}
                      onChange={() => toggle(t.id)}
                    />
                    <span
                      aria-hidden
                      className="mt-1 inline-block h-3 w-3 shrink-0 rounded-full md:mt-0"
                      style={{ background: dotColor }}
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold md:text-base">
                        {t.expense_type
                          ? `${t.expense_type}${t.note ? ` — ${t.note}` : ""}`
                          : t.description}
                      </p>
                      <p className="mt-0.5 text-xs opacity-70">
                        {shortDate(t.occurred_on)}
                        {t.installment_num && (
                          <span
                            className="ml-1.5 rounded-lg px-1.5 py-0.5 font-semibold"
                            style={{ background: COLORS.highlight }}
                          >
                            {t.installment_num}/{t.installment_total}
                          </span>
                        )}
                        {t.suggestion_score != null && (
                          <> · sugestão {Math.round(t.suggestion_score * 100)}%</>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 md:ml-auto">
                    <span
                      className="whitespace-nowrap text-sm font-bold md:text-base"
                      style={{
                        color: t.amount < 0 ? COLORS.dangerDeep : COLORS.accent
                      }}
                    >
                      {brl(t.amount)}
                    </span>

                    <select
                      value={t.suggested_category_id ?? ""}
                      onChange={(e) => changeSuggestion(t.id, e.target.value)}
                      aria-label="Categoria sugerida"
                      className="neu-select rounded-2xl px-3 py-2 text-xs font-medium md:text-sm"
                      style={{ color: COLORS.ink }}
                    >
                      <option value="">Sem categoria</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>

                    <button
                      onClick={() => setEditing(t)}
                      className="neu-out-sm neu-btn rounded-2xl px-3 py-2 text-xs font-semibold md:text-sm"
                      style={{ color: COLORS.accent }}
                    >
                      Editar
                    </button>

                    <button
                      onClick={() => approve([t.id])}
                      className="neu-out-sm neu-btn rounded-2xl px-4 py-2 text-xs font-bold md:text-sm"
                      style={{ color: COLORS.danger }}
                    >
                      Aprovar
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        {!loading && pending.length === 0 && (
          <div className="neu-in mt-4 rounded-3xl p-10 text-center">
            <p className="text-lg font-semibold">Nenhuma pendência</p>
            <p className="mt-1 text-sm opacity-75">
              Importe transações para revisar. Ctrl+Z desfaz a última aprovação.
            </p>
          </div>
        )}

        {editing && (
          <TransactionForm
            userId={userId}
            transaction={editing}
            categories={categories}
            people={people}
            methods={methods}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              showToast("Transação atualizada");
              load();
            }}
          />
        )}

        {toast && (
          <div
            role="status"
            className="neu-out fixed bottom-6 left-1/2 -translate-x-1/2 rounded-2xl px-5 py-3 text-sm font-semibold"
            style={{ color: COLORS.ink }}
          >
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function NeuCheckbox({ checked, onChange }) {
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      onClick={onChange}
      className="neu-in neu-btn flex h-6 w-6 shrink-0 items-center justify-center rounded-lg"
    >
      {checked && (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M2 7.5 5.5 11 12 3.5"
            fill="none"
            stroke={COLORS.danger}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
