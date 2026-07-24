import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Papa from "papaparse";
import { supabase } from "../lib/supabase";
import { COLORS, NATURE_COLOR, brl } from "../lib/theme";

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

/* Converte "1.234,56" / "-45.9" / "R$ 12,00" em número JS */
const parseAmount = (raw) => {
  if (typeof raw === "number") return raw;
  let s = String(raw).replace(/[^\d,.\-]/g, "");
  if (s.includes(",") && s.lastIndexOf(",") > s.lastIndexOf(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
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
  const [loading, setLoading] = useState(true);
  const [showManual, setShowManual] = useState(false);
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

  const load = useCallback(async () => {
    setLoading(true);
    const [tx, cats] = await Promise.all([
      supabase
        .from("transactions")
        .select("*")
        .gte("occurred_on", toISO(start))
        .lte("occurred_on", toISO(end))
        .order("occurred_on", { ascending: false }),
      supabase.from("categories").select("*").order("name")
    ]);
    if (!tx.error) setRows(tx.data ?? []);
    if (!cats.error) setCategories(cats.data ?? []);
    setLoading(false);
  }, [start, end]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => {
    const personal = rows.filter(
      (r) => r.context === "personal" && r.status === "confirmed"
    );
    const out = personal
      .filter((r) => r.amount < 0)
      .reduce((s, r) => s + Math.abs(r.amount), 0);
    const inc = personal
      .filter((r) => r.amount > 0)
      .reduce((s, r) => s + r.amount, 0);
    return { out, inc, net: inc - out };
  }, [rows]);

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
          context: "personal"
        });
      },
      error: () => showToast("Não consegui ler esse arquivo")
    });
    e.target.value = "";
  };

  const runImport = async () => {
    const { headers, rows: raw, map, context } = importState;
    setBusy(true);
    let ok = 0, dup = 0, bad = 0;

    for (const line of raw) {
      const occurred_on = parseDate(line[map.date]);
      const description = String(line[map.desc] ?? "").trim();
      const amount = parseAmount(line[map.amount]);
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
        context: sug?.[0]?.set_context ?? context,
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
              const isFather = t.context === "father";
              return (
                <li
                  key={t.id}
                  className="neu-out rounded-3xl px-4 py-3 md:px-5"
                  style={{
                    ...(isFather
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
                        {t.description}
                      </p>
                      <p className="mt-0.5 text-xs opacity-70">
                        {new Date(t.occurred_on + "T12:00:00").toLocaleDateString("pt-BR")}
                        {cat && <> · {cat.name}</>}
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
                </li>
              );
            })}
          </ul>
        )}

        {/* Modal: lançamento manual */}
        {showManual && (
          <ManualEntry
            userId={userId}
            categories={categories}
            onClose={() => setShowManual(false)}
            onSaved={() => {
              setShowManual(false);
              showToast("Lançada — aprove na aba Pendências");
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
                Contexto
                <select
                  value={importState.context}
                  onChange={(e) =>
                    setImportState((s) => ({ ...s, context: e.target.value }))
                  }
                  className="neu-select rounded-2xl px-3 py-2 text-sm"
                  style={{ color: COLORS.ink }}
                >
                  <option value="personal">Pessoal</option>
                  <option value="father">Fatura do pai</option>
                </select>
              </label>

              {/* Preview das 3 primeiras linhas interpretadas */}
              <div className="neu-in rounded-2xl p-3 text-xs">
                {importState.rows.slice(0, 3).map((line, i) => (
                  <p key={i} className="truncate py-0.5">
                    {parseDate(line[importState.map.date]) ?? "data?"} ·{" "}
                    {String(line[importState.map.desc] ?? "descrição?")} ·{" "}
                    {parseAmount(line[importState.map.amount]) ?? "valor?"}
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

/* ---------- Lançamento manual ---------- */
function ManualEntry({ userId, categories, onClose, onSaved }) {
  const [form, setForm] = useState({
    occurred_on: toISO(new Date()),
    description: "",
    amount: "",
    kind: "out", // out | in
    context: "personal",
    category_id: "",
    installment_total: ""
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    const amount = parseAmount(form.amount);
    if (!form.description.trim() || amount === null || amount === 0) {
      setError("Preencha descrição e um valor válido.");
      return;
    }
    setSaving(true);
    const total = parseInt(form.installment_total, 10);
    const hasInstallments = Number.isFinite(total) && total > 1;
    const signed = form.kind === "out" ? -Math.abs(amount) : Math.abs(amount);
    const { error: err } = await supabase.from("transactions").insert({
      user_id: userId,
      occurred_on: form.occurred_on,
      description: hasInstallments
        ? `${form.description.trim()} 01/${String(total).padStart(2, "0")}`
        : form.description.trim(),
      amount: signed,
      status: "pending",
      context: form.context,
      suggested_category_id: form.category_id || null,
      installment_num: hasInstallments ? 1 : null,
      installment_total: hasInstallments ? total : null
    });
    setSaving(false);
    if (err) {
      setError(
        err.code === "23505"
          ? "Já existe uma transação idêntica nessa data."
          : "Erro ao salvar. Tente de novo."
      );
      return;
    }
    onSaved();
  };

  return (
    <Modal onClose={() => !saving && onClose()}>
      <h2 className="text-lg font-bold">Nova transação</h2>
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex gap-2">
          {[["out", "Despesa"], ["in", "Entrada"]].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setForm((f) => ({ ...f, kind: k }))}
              className={`${form.kind === k ? "neu-in" : "neu-out-sm neu-btn"} flex-1 rounded-2xl px-4 py-2 text-sm font-bold`}
              style={{
                color:
                  form.kind === k
                    ? k === "out"
                      ? COLORS.danger
                      : COLORS.accent
                    : COLORS.ink
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="date"
          value={form.occurred_on}
          onChange={set("occurred_on")}
          className="neu-input rounded-2xl px-4 py-3 text-sm"
          style={{ color: COLORS.ink }}
        />
        <input
          type="text"
          placeholder="Descrição"
          value={form.description}
          onChange={set("description")}
          className="neu-input rounded-2xl px-4 py-3 text-sm"
          style={{ color: COLORS.ink }}
        />
        <input
          type="text"
          inputMode="decimal"
          placeholder="Valor (ex.: 45,90)"
          value={form.amount}
          onChange={set("amount")}
          className="neu-input rounded-2xl px-4 py-3 text-sm"
          style={{ color: COLORS.ink }}
        />
        <div className="grid grid-cols-2 gap-3">
          <select
            value={form.category_id}
            onChange={set("category_id")}
            className="neu-select rounded-2xl px-3 py-3 text-sm"
            style={{ color: COLORS.ink }}
          >
            <option value="">Sem categoria</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={form.context}
            onChange={set("context")}
            className="neu-select rounded-2xl px-3 py-3 text-sm"
            style={{ color: COLORS.ink }}
          >
            <option value="personal">Pessoal</option>
            <option value="father">Fatura do pai</option>
          </select>
        </div>
        <input
          type="number"
          min="2"
          max="99"
          placeholder="Parcelas (deixe vazio se à vista)"
          value={form.installment_total}
          onChange={set("installment_total")}
          className="neu-input rounded-2xl px-4 py-3 text-sm"
          style={{ color: COLORS.ink }}
        />
        {error && (
          <p className="text-xs font-semibold" style={{ color: COLORS.danger }}>
            {error}
          </p>
        )}
        <button
          onClick={save}
          disabled={saving}
          className="neu-btn rounded-2xl px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
          style={{
            background: COLORS.danger,
            boxShadow: `-4px -4px 12px rgba(255,255,255,0.7), 4px 4px 12px ${COLORS.shadowDark}`
          }}
        >
          {saving ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </Modal>
  );
}

/* ---------- Modal genérico ---------- */
function Modal({ children, onClose }) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/20 p-4 md:items-center"
      onClick={onClose}
    >
      <div
        className="neu-out max-h-[85vh] w-full max-w-md overflow-y-auto rounded-3xl p-6"
        style={{ background: COLORS.bg, color: COLORS.ink }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
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
