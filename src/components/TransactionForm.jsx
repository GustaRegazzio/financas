import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { COLORS } from "../lib/theme";

/* ============================================================
   TransactionForm — criar / editar / excluir uma transação
   Usado pela aba Transações e pela Lista de Pendências.
   Campos espelham o controle real: tipo, anotação, cartão,
   pessoa, categoria, parcelas e status de acerto.
   ============================================================ */

const toISO = (d) => d.toISOString().slice(0, 10);

export const parseAmount = (raw) => {
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

/* Rótulos frequentes de "Gasto" — sugestões, não lista fechada */
const TYPE_SUGGESTIONS = [
  "Compra", "Uber", "Rolê", "Jogos", "Mercado",
  "Assinatura", "Cabelo", "Saúde", "Presente"
];

export default function TransactionForm({
  userId,
  transaction, // null = nova
  categories,
  people,
  methods,
  onClose,
  onSaved
}) {
  const isEdit = Boolean(transaction);
  const owner = people.find((p) => p.is_owner);

  const [form, setForm] = useState(() => ({
    occurred_on: transaction?.occurred_on ?? toISO(new Date()),
    /* Em transação nova, "Compra" é um padrão útil. Em edição, nunca
       inventamos: mostramos exatamente o que está gravado. */
    expense_type: isEdit ? (transaction.expense_type ?? "") : "Compra",
    /* Importadas do CSV não têm anotação — o texto do extrato está na
       descrição. Trazemos ele para o campo em vez de deixar vazio. */
    note: isEdit
      ? (transaction.note ?? transaction.description ?? "")
      : "",
    description: transaction?.description ?? "",
    amount:
      transaction != null
        ? String(Math.abs(transaction.amount)).replace(".", ",")
        : "",
    kind: transaction ? (transaction.amount < 0 ? "out" : "in") : "out",
    category_id:
      transaction?.category_id ?? transaction?.suggested_category_id ?? "",
    person_id: transaction?.person_id ?? owner?.id ?? "",
    payment_method_id: transaction?.payment_method_id ?? "",
    installment_total: transaction?.installment_total
      ? String(transaction.installment_total)
      : "",
    is_paid_back: transaction?.is_paid_back ?? false
  }));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [applyToGroup, setApplyToGroup] = useState(false);

  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value
    }));

  const selectedPerson = people.find((p) => p.id === form.person_id);
  const isThirdParty = selectedPerson && !selectedPerson.is_owner;
  const hasGroup =
    isEdit && transaction.installment_group_id && transaction.installment_total > 1;

  /* A descrição é o que o motor de regras e o anti-duplicação usam,
     então ela só muda se o usuário realmente mexeu em tipo ou anotação.
     Caso contrário, preservamos o texto original (ex.: o do extrato). */
  const buildDescription = () => {
    if (isEdit) {
      const typeUnchanged =
        (form.expense_type?.trim() || "") === (transaction.expense_type ?? "");
      const noteUnchanged =
        (form.note?.trim() || "") ===
        (transaction.note ?? transaction.description ?? "");
      if (typeUnchanged && noteUnchanged) return transaction.description;
    }
    const base = [form.expense_type?.trim(), form.note?.trim()]
      .filter(Boolean)
      .join(" — ");
    return base || transaction?.description || "Sem descrição";
  };

  const save = async () => {
    const amount = parseAmount(form.amount);
    if (amount === null || amount === 0) {
      setError("Informe um valor válido.");
      return;
    }
    if (!isEdit && !form.expense_type?.trim() && !form.note?.trim()) {
      setError("Preencha ao menos o tipo ou a anotação.");
      return;
    }
    setSaving(true);
    setError(null);

    const signed = form.kind === "out" ? -Math.abs(amount) : Math.abs(amount);
    const total = parseInt(form.installment_total, 10);
    const hasInstallments = Number.isFinite(total) && total > 1;

    const payload = {
      occurred_on: form.occurred_on,
      expense_type: form.expense_type?.trim() || null,
      note: form.note?.trim() || null,
      amount: signed,
      category_id: form.category_id || null,
      person_id: form.person_id || null,
      payment_method_id: form.payment_method_id || null,
      is_paid_back: isThirdParty ? form.is_paid_back : false
    };

    let err;
    if (isEdit) {
      /* Edição em grupo: replica os campos comuns nas demais parcelas,
         preservando a data de cada uma. */
      if (applyToGroup && hasGroup) {
        const { occurred_on, ...shared } = payload;
        ({ error: err } = await supabase
          .from("transactions")
          .update(shared)
          .eq("installment_group_id", transaction.installment_group_id));
      } else {
        ({ error: err } = await supabase
          .from("transactions")
          .update({
            ...payload,
            description: buildDescription()
          })
          .eq("id", transaction.id));
      }
    } else {
      ({ error: err } = await supabase.from("transactions").insert({
        user_id: userId,
        ...payload,
        description: hasInstallments
          ? `${buildDescription()} 01/${String(total).padStart(2, "0")}`
          : buildDescription(),
        status: "pending",
        suggested_category_id: form.category_id || null,
        installment_num: hasInstallments ? 1 : null,
        installment_total: hasInstallments ? total : null
      }));
    }

    setSaving(false);
    if (err) {
      setError(
        err.code === "23505"
          ? "Já existe uma transação idêntica (mesma data, valor e descrição)."
          : "Não consegui salvar. Tente de novo."
      );
      return;
    }
    onSaved();
  };

  const remove = async () => {
    setSaving(true);
    const query = supabase.from("transactions").delete();
    const { error: err } =
      applyToGroup && hasGroup
        ? await query.eq("installment_group_id", transaction.installment_group_id)
        : await query.eq("id", transaction.id);
    setSaving(false);
    if (err) {
      setError("Não consegui excluir. Tente de novo.");
      return;
    }
    onSaved();
  };

  return (
    <Modal onClose={() => !saving && onClose()}>
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-bold">
          {isEdit ? "Editar transação" : "Nova transação"}
        </h2>
        {isEdit && transaction.status === "confirmed" && (
          <span className="rounded-lg px-2 py-1 text-xs font-semibold"
                style={{ background: COLORS.highlight }}>
            aprovada
          </span>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {/* Despesa / Entrada */}
        <div className="flex gap-2">
          {[["out", "Despesa"], ["in", "Entrada"]].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setForm((f) => ({ ...f, kind: k }))}
              className={`${form.kind === k ? "neu-in" : "neu-out-sm neu-btn"} flex-1 rounded-2xl px-4 py-2 text-sm font-bold`}
              style={{
                color:
                  form.kind === k
                    ? k === "out" ? COLORS.danger : COLORS.accent
                    : COLORS.ink
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <Field label="Data">
          <input
            type="date"
            value={form.occurred_on}
            onChange={set("occurred_on")}
            className="neu-input w-full rounded-2xl px-4 py-3 text-sm"
            style={{ color: COLORS.ink }}
          />
        </Field>

        <Field label="Tipo (Gasto)">
          <input
            type="text"
            list="expense-types"
            placeholder={isEdit ? "Sem tipo definido" : "Compra, Uber, Rolê…"}
            value={form.expense_type}
            onChange={set("expense_type")}
            className="neu-input w-full rounded-2xl px-4 py-3 text-sm"
            style={{ color: COLORS.ink }}
          />
          <datalist id="expense-types">
            {TYPE_SUGGESTIONS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>

        <Field label="Anotação">
          <input
            type="text"
            placeholder="O que foi comprado"
            value={form.note}
            onChange={set("note")}
            className="neu-input w-full rounded-2xl px-4 py-3 text-sm"
            style={{ color: COLORS.ink }}
          />
        </Field>

        <Field label="Valor">
          <input
            type="text"
            inputMode="decimal"
            placeholder="45,90"
            value={form.amount}
            onChange={set("amount")}
            className="neu-input w-full rounded-2xl px-4 py-3 text-sm"
            style={{ color: COLORS.ink }}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Categoria">
            <select
              value={form.category_id}
              onChange={set("category_id")}
              className="neu-select w-full rounded-2xl px-3 py-3 text-sm"
              style={{ color: COLORS.ink }}
            >
              <option value="">Sem categoria</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Cartão / Pix">
            <select
              value={form.payment_method_id}
              onChange={set("payment_method_id")}
              className="neu-select w-full rounded-2xl px-3 py-3 text-sm"
              style={{ color: COLORS.ink }}
            >
              <option value="">Não informado</option>
              {methods.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Pessoa">
            <select
              value={form.person_id}
              onChange={set("person_id")}
              className="neu-select w-full rounded-2xl px-3 py-3 text-sm"
              style={{ color: COLORS.ink }}
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>

          {!isEdit && (
            <Field label="Parcelas">
              <input
                type="number"
                min="2"
                max="99"
                placeholder="à vista"
                value={form.installment_total}
                onChange={set("installment_total")}
                className="neu-input w-full rounded-2xl px-4 py-3 text-sm"
                style={{ color: COLORS.ink }}
              />
            </Field>
          )}
        </div>

        {/* "Pago": só faz sentido quando a compra é de outra pessoa */}
        {isThirdParty && (
          <label className="neu-in flex cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium">
            <input
              type="checkbox"
              checked={form.is_paid_back}
              onChange={set("is_paid_back")}
              className="h-4 w-4 accent-current"
              style={{ accentColor: COLORS.accent }}
            />
            {selectedPerson.name} já acertou esse valor comigo
          </label>
        )}

        {/* Escopo da edição quando a compra é parcelada */}
        {hasGroup && (
          <label className="neu-in flex cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium">
            <input
              type="checkbox"
              checked={applyToGroup}
              onChange={(e) => setApplyToGroup(e.target.checked)}
              className="h-4 w-4"
              style={{ accentColor: COLORS.danger }}
            />
            Aplicar às {transaction.installment_total} parcelas desta compra
          </label>
        )}

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
          {saving ? "Salvando…" : isEdit ? "Salvar alterações" : "Salvar"}
        </button>

        {isEdit && (
          confirmDelete ? (
            <div className="neu-in rounded-2xl p-4">
              <p className="text-sm font-semibold">
                Excluir {applyToGroup && hasGroup
                  ? `as ${transaction.installment_total} parcelas`
                  : "esta transação"}?
              </p>
              <p className="mt-1 text-xs opacity-70">Não dá para desfazer.</p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={remove}
                  disabled={saving}
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
              Excluir transação
            </button>
          )
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

export function Modal({ children, onClose }) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/20 p-4 md:items-center"
      onClick={onClose}
    >
      <div
        className="neu-out max-h-[88vh] w-full max-w-md overflow-y-auto rounded-3xl p-6"
        style={{ background: COLORS.bg, color: COLORS.ink }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
