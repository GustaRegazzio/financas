import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Papa from "papaparse";
import { supabase } from "../lib/supabase";
import { COLORS, NATURE_COLOR, brl } from "../lib/theme";
import TransactionForm, { Modal, parseAmount } from "./TransactionForm.jsx";

/* ============================================================
   Transações — histórico, visões por período, lançamento
   manual e importação de CSV
   - Visões: Dia / Semana / Mês, com navegação ← →
   - Lançamento manual entra como 'pending' (flui pela
     aprovação, que dispara a projeção de parcelas)
   - Import CSV: preview + mapeamento de colunas, dedup pelo
     índice do banco, sugestão de categoria via motor fuzzy
     (função SQL suggest_category)
   ============================================================ */

const toISO = (d) => d.toISOString().slice(0, 10);

const startOf = (mode, date) => {
  const d = new Date(date);
  if (mode === "day") return d;
  if (mode === "week") {
    const dow = (d.getDay() + 6) % 7; // segunda = 0
    d.setDate(d.getDate() - dow);
    return d;
  }
  d.setDate(1);
  return d;
};

const endOf = (mode, start) => {
  const d = new Date(start);
  if (mode === "day") return d;
  if (mode === "week") {
    d.setDate(d.getDate() + 6);
    return d;
  }
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  return d;
};

const shift = (mode, date, dir) => {
  const d = new Date(date);
  if (mode === "day") d.setDate(d.getDate() + dir);
  if (mode === "week") d.setDate(d.getDate() + 7 * dir);
  if (mode === "month") d.setMonth(d.getMonth() + dir);
  return d;
};

const periodLabel = (mode, start, end) => {
  const f = (d, opts) => d.toLocaleDateString("pt-BR", opts);
  if (mode === "day")
    return f(start, { weekday: "long", day: "2-digit", month: "long" });
  if (mode === "week")
    return `${f(start, { day: "2-digit", month: "2-digit" })} – ${f(end, { day: "2-digit", month: "2-digit" })}`;
  return f(start, { month: "long", year: "numeric" });
};

/* Converte dd/mm/aaaa ou aaaa-mm-dd em ISO */
const parseDate = (raw) => {
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
};

const INSTALLMENT_RE = /\b(\d{1,2})\/(\d{1,2})\b/;

export default function Transactions({ userId }) {
  const [mode, setMode] = useState("month"); // day | week | month
  const [anchor, setAnchor] = useState(new Date());
  const [rows, setRows] = useState([]);
  const [categories, setCategories] = useState([]);
  const [people, setPeople] = useState([]);
  const [methods, setMethods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showManual, setShowManual] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [importState, setImportState] = useState(null); // null | {headers, rows, map}
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const fileRef = useRef(null);
  const toastTimer = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  const start = useMemo(() => startOf(mode, anchor), [mode, anchor]);
  const end = useMemo(() => endOf(mode, start), [mode, start]);

  const catById = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c])),
    [categories]
  );

  const toggleSel = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const exitSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const load = useCallback(async () => {
    setLoading(true);
    const [tx, cats, ppl, pm] = await Promise.all([
      supabase
        .from("transactions")
        .select("*")
        .gte("occurred_on", toISO(start))
        .lte("occurred_on", toISO(end))
        .order("occurred_on", { ascending: false }),
      supabase.from("categories").select("*").order("name"),
      supabase.from("people").select("*").eq("active", true).order("is_owner", { ascending: false }),
      supabase.from("payment_methods").select("*").eq("active", true).order("name")
    ]);
    if (!tx.error) setRows(tx.data ?? []);
    if (!cats.error) setCategories(cats.data ?? []);
    if (!ppl.error) setPeople(ppl.data ?? []);
    if (!pm.error) setMethods(pm.data ?? []);
    setLoading(false);
  }, [start, end]);

  useEffect(() => {
    load();
  }, [load]);

  const ownerId = useMemo(
    () => people.find((p) => p.is_owner)?.id,
    [people]
  );

  const totals = useMemo(() => {
    const excluded = new Set(
      categories.filter((c) => c.exclude_from_metrics).map((c) => c.id)
    );
    const personal = rows.filter(
      (r) =>
        r.status === "confirmed" &&
        (r.person_id ?? ownerId) === ownerId &&
        !excluded.has(r.category_id)
    );
    const out = personal
      .filter((r) => r.amount < 0)
      .reduce((s, r) => s + Math.abs(r.amount), 0);
    const inc = personal
      .filter((r) => r.amount > 0)
      .reduce((s, r) => s + r.amount, 0);
    return { out, inc, net: inc - out };
  }, [rows, categories, ownerId]);

  /* ---------- Import CSV ---------- */
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      skipEmptyLines: true,
      complete: (res) => {
        const data = res.data;
        if (!data || data.length < 2) {
          showToast("CSV vazio ou sem linhas de dados");
          return;
        }
        const headers = data[0].map((h, i) => String(h || `Coluna ${i + 1}`));
        /* tentativa de mapeamento automático por nome de coluna */
        const guess = (words) =>
          headers.findIndex((h) =>
            words.some((w) => h.toLowerCase().includes(w))
          );
        setImportState({
          headers,
          rows: data.slice(1),
          map: {
            date: Math.max(0, guess(["data", "date"])),
            desc: Math.max(0, guess(["desc", "hist", "lanç", "lanc", "title"])),
            amount: Math.max(0, guess(["valor", "amount", "value"]))
          },
          personId: people.find((p) => p.is_owner)?.id ?? "",
          methodId: "",
          /* Faturas de cartão costumam trazer compra como positivo.
             Se a maioria das linhas for positiva, sugerimos inverter. */
          invert: (() => {
            const col = Math.max(0, guess(["valor", "amount", "value"]));
            const vals = data
              .slice(1)
              .map((l) => parseAmount(l[col]))
              .filter((v) => v !== null && v !== 0);
            if (vals.length === 0) return false;
            const pos = vals.filter((v) => v > 0).length;
            return pos / vals.length > 0.6;
          })()
        });
      },
      error: () => showToast("Não consegui ler esse arquivo")
    });
    e.target.value = "";
  };

  const runImport = async () => {
    const { rows: raw, map, personId, methodId, invert } = importState;
    setBusy(true);
    let ok = 0, dup = 0, bad = 0;

    for (const line of raw) {
      const occurred_on = parseDate(line[map.date]);
      const description = String(line[map.desc] ?? "").trim();
      let amount = parseAmount(line[map.amount]);
      if (amount !== null && invert) amount = -amount;
      if (!occurred_on || !description || amount === null) {
        bad++;
        continue;
      }
      const inst = description.match(INSTALLMENT_RE);
      /* motor de regras fuzzy do banco */
      let suggested = null, score = null;
      const { data: sug } = await supabase.rpc("suggest_category", {
        p_user_id: userId,
        p_description: description
      });
      if (sug && sug.length > 0) {
        suggested = sug[0].category_id;
        score = sug[0].score;
      }
      const { error } = await supabase.from("transactions").insert({
        user_id: userId,
        occurred_on,
        description,
        amount,
        status: "pending",
        person_id: personId || null,
        payment_method_id: methodId || null,
        expense_type: "Compra",
        note: description,
        suggested_category_id: suggested,
        suggestion_score: score,
        installment_num: inst ? parseInt(inst[1], 10) : null,
        installment_total: inst ? parseInt(inst[2], 10) : null
      });
      if (error) {
        error.code === "23505" ? dup++ : bad++;
      } else {
        ok++;
      }
    }

    setBusy(false);
    setImportState(null);
    showToast(
      `Import: ${ok} novas · ${dup} duplicadas ignoradas${bad ? ` · ${bad} linhas inválidas` : ""}`
    );
    load();
  };

  /* ---------- UI ---------- */
  return (
    <div className="px-4 py-6 md:px-10 md:py-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <h1 className="text-2xl font-bold md:text-3xl">Transações</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={() => (selecting ? exitSelection() : setSelecting(true))}
              className="neu-out-sm neu-btn rounded-2xl px-4 py-2 text-sm font-semibold"
              style={{ color: selecting ? COLORS.danger : COLORS.ink }}
            >
              {selecting ? "Cancelar" : "Selecionar"}
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              className="neu-out-sm neu-btn rounded-2xl px-4 py-2 text-sm font-semibold"
              style={{ color: COLORS.accent }}
            >
              Importar CSV
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={onFile}
            />
            <button
              onClick={() => setShowManual(true)}
              className="neu-btn rounded-2xl px-5 py-2 text-sm font-bold text-white"
              style={{
                background: COLORS.danger,
                boxShadow: `-4px -4px 12px rgba(255,255,255,0.7), 4px 4px 12px ${COLORS.shadowDark}`
              }}
            >
              + Nova transação
            </button>
          </div>
        </header>

        {/* Seletor de período */}
        <div className="neu-in mb-5 flex flex-col gap-3 rounded-3xl px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex gap-2">
            {[["day", "Dia"], ["week", "Semana"], ["month", "Mês"]].map(
              ([m, label]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`${mode === m ? "neu-in" : "neu-out-sm neu-btn"} rounded-2xl px-4 py-2 text-xs font-bold md:text-sm`}
                  style={{ color: mode === m ? COLORS.danger : COLORS.ink }}
                >
                  {label}
                </button>
              )
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setAnchor(shift(mode, anchor, -1))}
              aria-label="Período anterior"
              className="neu-out-sm neu-btn rounded-2xl px-3 py-2 text-sm font-bold"
            >
              ←
            </button>
            <p className="min-w-40 text-center text-sm font-semibold capitalize">
              {periodLabel(mode, start, end)}
            </p>
            <button
              onClick={() => setAnchor(shift(mode, anchor, 1))}
              aria-label="Próximo período"
              className="neu-out-sm neu-btn rounded-2xl px-3 py-2 text-sm font-bold"
            >
              →
            </button>
            <button
              onClick={() => setAnchor(new Date())}
              className="neu-out-sm neu-btn rounded-2xl px-3 py-2 text-xs font-semibold"
              style={{ color: COLORS.accent }}
            >
              Hoje
            </button>
          </div>
        </div>

        {/* Totais do período (contexto pessoal, confirmadas) */}
        <div className="mb-6 grid grid-cols-3 gap-4">
          <PeriodTotal label="Gastos" value={brl(-totals.out)} color={COLORS.dangerDeep} />
          <PeriodTotal label="Entradas" value={brl(totals.inc)} color={COLORS.accent} />
          <PeriodTotal
            label="Saldo do período"
            value={brl(totals.net)}
            color={totals.net < 0 ? COLORS.dangerDeep : COLORS.ink}
          />
        </div>

        {/* Barra de seleção em lote */}
        {selecting && (
          <div className="neu-in mb-5 flex flex-col gap-3 rounded-3xl px-5 py-4 md:flex-row md:items-center md:justify-between">
            <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
              <input
                type="checkbox"
                checked={rows.length > 0 && selected.size === rows.length}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? new Set(rows.map((r) => r.id)) : new Set()
                  )
                }
                className="h-5 w-5"
                style={{ accentColor: COLORS.danger }}
              />
              {selected.size === 0
                ? "Selecionar todas do período"
                : `${selected.size} selecionada${selected.size > 1 ? "s" : ""}`}
            </label>
            <button
              onClick={() => setBulkOpen(true)}
              disabled={selected.size === 0}
              className="neu-btn rounded-2xl px-6 py-3 text-sm font-bold text-white disabled:opacity-40"
              style={{
                background: COLORS.danger,
                boxShadow: `-4px -4px 12px rgba(255,255,255,0.7), 4px 4px 12px ${COLORS.shadowDark}`
              }}
            >
              Editar selecionadas
            </button>
          </div>
        )}

        {/* Lista */}
        {loading ? (
          <p className="py-8 text-center text-sm opacity-70">Carregando…</p>
        ) : rows.length === 0 ? (
          <div className="neu-in rounded-3xl p-10 text-center">
            <p className="text-lg font-semibold">Nada neste período</p>
            <p className="mt-1 text-sm opacity-75">
              Importe um CSV ou lance uma transação manualmente.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((t) => {
              const cat = t.category_id
                ? catById[t.category_id]
                : t.suggested_category_id
                  ? catById[t.suggested_category_id]
                  : null;
              const dotColor = cat ? NATURE_COLOR[cat.nature] : COLORS.surface;
              const person = people.find((p) => p.id === t.person_id);
              const personName = person && !person.is_owner ? person.name : null;
              const methodName =
                methods.find((m) => m.id === t.payment_method_id)?.name ?? null;
              const isThirdParty = Boolean(person && !person.is_owner);
              return (
                <li key={t.id} className="flex items-center gap-3">
                  {selecting && (
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSel(t.id)}
                      className="h-5 w-5 shrink-0"
                      style={{ accentColor: COLORS.danger }}
                    />
                  )}
                  <button
                    onClick={() =>
                      selecting ? toggleSel(t.id) : setEditing(t)
                    }
                    className="neu-out neu-btn min-w-0 flex-1 rounded-3xl px-4 py-3 text-left md:px-5"
                    style={{
                      ...(isThirdParty
                        ? { borderLeft: `6px solid ${COLORS.accent}` }
                        : {}),
                      ...(t.status === "pending" ? { opacity: 0.65 } : {})
                    }}
                  >
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="inline-block h-3 w-3 shrink-0 rounded-full"
                      style={{ background: dotColor }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">
                        {t.expense_type
                          ? `${t.expense_type}${t.note ? ` — ${t.note}` : ""}`
                          : t.description}
                      </p>
                      <p className="mt-0.5 text-xs opacity-70">
                        {new Date(t.occurred_on + "T12:00:00").toLocaleDateString("pt-BR")}
                        {cat && <> · {cat.name}</>}
                        {personName && <> · {personName}</>}
                        {methodName && <> · {methodName}</>}
                        {isThirdParty && (
                          <> · {t.is_paid_back ? "acertado" : "a receber"}</>
                        )}
                        {t.status === "pending" && <> · aguardando aprovação</>}
                        {t.installment_num && (
                          <span
                            className="ml-1.5 rounded-lg px-1.5 py-0.5 font-semibold"
                            style={{ background: COLORS.highlight }}
                          >
                            {t.installment_num}/{t.installment_total}
                          </span>
                        )}
                      </p>
                    </div>
                    <span
                      className="whitespace-nowrap text-sm font-bold"
                      style={{
                        color: t.amount < 0 ? COLORS.dangerDeep : COLORS.accent
                      }}
                    >
                      {brl(t.amount)}
                    </span>
                  </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Modal: nova transação */}
        {showManual && (
          <TransactionForm
            userId={userId}
            transaction={null}
            categories={categories}
            people={people}
            methods={methods}
            onClose={() => setShowManual(false)}
            onSaved={() => {
              setShowManual(false);
              showToast("Lançada — aprove na aba Pendências");
              load();
            }}
          />
        )}

        {/* Modal: editar transação existente */}
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

        {/* Modal: mapeamento do CSV */}
        {importState && (
          <Modal onClose={() => !busy && setImportState(null)}>
            <h2 className="text-lg font-bold">Importar CSV</h2>
            <p className="mt-1 text-sm opacity-75">
              {importState.rows.length} linhas encontradas. Confirme qual coluna
              é o quê:
            </p>
            <div className="mt-4 flex flex-col gap-3">
              {[["date", "Data"], ["desc", "Descrição"], ["amount", "Valor"]].map(
                ([key, label]) => (
                  <label key={key} className="flex items-center justify-between gap-3 text-sm font-medium">
                    {label}
                    <select
                      value={importState.map[key]}
                      onChange={(e) =>
                        setImportState((s) => ({
                          ...s,
                          map: { ...s.map, [key]: Number(e.target.value) }
                        }))
                      }
                      className="neu-select rounded-2xl px-3 py-2 text-sm"
                      style={{ color: COLORS.ink }}
                    >
                      {importState.headers.map((h, i) => (
                        <option key={i} value={i}>{h}</option>
                      ))}
                    </select>
                  </label>
                )
              )}
              <label className="flex items-center justify-between gap-3 text-sm font-medium">
                Pessoa
                <select
                  value={importState.personId}
                  onChange={(e) =>
                    setImportState((s) => ({ ...s, personId: e.target.value }))
                  }
                  className="neu-select rounded-2xl px-3 py-2 text-sm"
                  style={{ color: COLORS.ink }}
                >
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center justify-between gap-3 text-sm font-medium">
                Cartão / Pix
                <select
                  value={importState.methodId}
                  onChange={(e) =>
                    setImportState((s) => ({ ...s, methodId: e.target.value }))
                  }
                  className="neu-select rounded-2xl px-3 py-2 text-sm"
                  style={{ color: COLORS.ink }}
                >
                  <option value="">Não informado</option>
                  {methods.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </label>

              <label className="neu-in flex cursor-pointer items-start gap-3 rounded-2xl px-4 py-3 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={importState.invert}
                  onChange={(e) =>
                    setImportState((s) => ({ ...s, invert: e.target.checked }))
                  }
                  className="mt-0.5 h-4 w-4"
                  style={{ accentColor: COLORS.danger }}
                />
                <span>
                  Inverter sinal dos valores
                  <span className="mt-0.5 block text-xs font-normal opacity-70">
                    Faturas de cartão lançam compra como positivo. Confira no
                    preview: gasto tem que aparecer negativo.
                  </span>
                </span>
              </label>

              {/* Preview das 3 primeiras linhas interpretadas */}
              <div className="neu-in rounded-2xl p-3 text-xs">
                {importState.rows.slice(0, 3).map((line, i) => (
                  <p key={i} className="truncate py-0.5">
                    {parseDate(line[importState.map.date]) ?? "data?"} ·{" "}
                    {String(line[importState.map.desc] ?? "descrição?")} ·{" "}
                    {(() => {
                      const v = parseAmount(line[importState.map.amount]);
                      if (v === null) return "valor?";
                      return brl(importState.invert ? -v : v);
                    })()}
                  </p>
                ))}
              </div>

              <button
                onClick={runImport}
                disabled={busy}
                className="neu-btn mt-1 rounded-2xl px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
                style={{
                  background: COLORS.danger,
                  boxShadow: `-4px -4px 12px rgba(255,255,255,0.7), 4px 4px 12px ${COLORS.shadowDark}`
                }}
              >
                {busy ? "Importando…" : "Importar para Pendências"}
              </button>
            </div>
          </Modal>
        )}

        {/* Modal: edição em lote */}
        {bulkOpen && (
          <BulkEdit
            count={selected.size}
            categories={categories}
            people={people}
            methods={methods}
            rows={rows.filter((r) => selected.has(r.id))}
            onClose={() => setBulkOpen(false)}
            onDone={(msg) => {
              setBulkOpen(false);
              exitSelection();
              showToast(msg);
              load();
            }}
          />
        )}

        {toast && (
          <div
            role="status"
            className="neu-out fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl px-5 py-3 text-sm font-semibold"
            style={{ color: COLORS.ink }}
          >
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Edição em lote ---------- */
function BulkEdit({ count, categories, people, methods, rows, onClose, onDone }) {
  const [sign, setSign] = useState("keep"); // keep | out | in | invert
  const [categoryId, setCategoryId] = useState("");
  const [personId, setPersonId] = useState("");
  const [methodId, setMethodId] = useState("");
  const [paidBack, setPaidBack] = useState("keep"); // keep | yes | no
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const apply = async () => {
    setBusy(true);
    setError(null);
    const common = {};
    if (categoryId) common.category_id = categoryId;
    if (personId) common.person_id = personId;
    if (methodId) common.payment_method_id = methodId;
    if (paidBack !== "keep") common.is_paid_back = paidBack === "yes";

    let failed = 0;
    for (const r of rows) {
      const patch = { ...common };
      if (sign === "out") patch.amount = -Math.abs(r.amount);
      if (sign === "in") patch.amount = Math.abs(r.amount);
      if (sign === "invert") patch.amount = -r.amount;
      if (Object.keys(patch).length === 0) continue;
      const { error: err } = await supabase
        .from("transactions")
        .update(patch)
        .eq("id", r.id);
      if (err) failed++;
    }
    setBusy(false);
    if (failed > 0) {
      setError(`${failed} de ${rows.length} não puderam ser alteradas.`);
      return;
    }
    onDone(`${rows.length} transações atualizadas`);
  };

  const removeAll = async () => {
    setBusy(true);
    const { error: err } = await supabase
      .from("transactions")
      .delete()
      .in("id", rows.map((r) => r.id));
    setBusy(false);
    if (err) {
      setError("Não consegui excluir. Tente de novo.");
      return;
    }
    onDone(`${rows.length} transações excluídas`);
  };

  return (
    <Modal onClose={() => !busy && onClose()}>
      <h2 className="text-lg font-bold">Editar {count} transações</h2>
      <p className="mt-1 text-sm opacity-75">
        Campos deixados em "manter" não são alterados.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <Field label="Tipo do valor">
          <select
            value={sign}
            onChange={(e) => setSign(e.target.value)}
            className="neu-select w-full rounded-2xl px-3 py-3 text-sm"
            style={{ color: COLORS.ink }}
          >
            <option value="keep">Manter como está</option>
            <option value="out">Transformar em despesa</option>
            <option value="in">Transformar em entrada</option>
            <option value="invert">Inverter o sinal</option>
          </select>
        </Field>

        <Field label="Categoria">
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="neu-select w-full rounded-2xl px-3 py-3 text-sm"
            style={{ color: COLORS.ink }}
          >
            <option value="">Manter</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Pessoa">
            <select
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              className="neu-select w-full rounded-2xl px-3 py-3 text-sm"
              style={{ color: COLORS.ink }}
            >
              <option value="">Manter</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Cartão / Pix">
            <select
              value={methodId}
              onChange={(e) => setMethodId(e.target.value)}
              className="neu-select w-full rounded-2xl px-3 py-3 text-sm"
              style={{ color: COLORS.ink }}
            >
              <option value="">Manter</option>
              {methods.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Acerto de terceiros">
          <select
            value={paidBack}
            onChange={(e) => setPaidBack(e.target.value)}
            className="neu-select w-full rounded-2xl px-3 py-3 text-sm"
            style={{ color: COLORS.ink }}
          >
            <option value="keep">Manter</option>
            <option value="yes">Marcar como acertado</option>
            <option value="no">Marcar como a receber</option>
          </select>
        </Field>

        {error && (
          <p className="text-xs font-semibold" style={{ color: COLORS.danger }}>
            {error}
          </p>
        )}

        <button
          onClick={apply}
          disabled={busy}
          className="neu-btn rounded-2xl px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
          style={{
            background: COLORS.danger,
            boxShadow: `-4px -4px 12px rgba(255,255,255,0.7), 4px 4px 12px ${COLORS.shadowDark}`
          }}
        >
          {busy ? "Aplicando…" : `Aplicar a ${count}`}
        </button>

        {confirmDelete ? (
          <div className="neu-in rounded-2xl p-4">
            <p className="text-sm font-semibold">Excluir as {count} selecionadas?</p>
            <p className="mt-1 text-xs opacity-70">Não dá para desfazer.</p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={removeAll}
                disabled={busy}
                className="neu-btn flex-1 rounded-2xl px-4 py-2 text-xs font-bold text-white"
                style={{ background: COLORS.dangerDeep }}
              >
                Excluir
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="neu-out-sm neu-btn flex-1 rounded-2xl px-4 py-2 text-xs font-bold"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="neu-out-sm neu-btn rounded-2xl px-6 py-2 text-xs font-semibold"
            style={{ color: COLORS.dangerDeep }}
          >
            Excluir selecionadas
          </button>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide opacity-60">
        {label}
      </span>
      {children}
    </label>
  );
}

function PeriodTotal({ label, value, color }) {
  return (
    <div className="neu-out rounded-3xl p-4">
      <p className="text-xs font-semibold uppercase tracking-wide opacity-60">
        {label}
      </p>
      <p className="mt-1 text-base font-bold md:text-xl" style={{ color }}>
        {value}
      </p>
    </div>
  );
}
