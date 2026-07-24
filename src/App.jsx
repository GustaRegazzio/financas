import { useState, useEffect } from "react";
import { supabase } from "./lib/supabase";
import { COLORS, cssVars } from "./lib/theme";
import Dashboard from "./components/Dashboard.jsx";
import PendingList from "./components/PendingList.jsx";

export default function App() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState("dashboard"); // 'dashboard' | 'pending'

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) =>
      setSession(s)
    );
    return () => sub.subscription.unsubscribe();
  }, []);

  if (checking) {
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        style={{ ...cssVars, backgroundColor: COLORS.bg, color: COLORS.ink }}
      >
        <p className="text-sm opacity-70">Carregando…</p>
      </div>
    );
  }

  if (!session) return <Login />;

  return (
    <div
      className="min-h-screen"
      style={{ ...cssVars, backgroundColor: COLORS.bg, color: COLORS.ink }}
    >
      <nav className="mx-auto flex max-w-5xl items-center gap-3 px-4 pt-6 md:px-10">
        <TabButton active={view === "dashboard"} onClick={() => setView("dashboard")}>
          Dashboard
        </TabButton>
        <TabButton active={view === "pending"} onClick={() => setView("pending")}>
          Pendências
        </TabButton>
        <button
          onClick={() => supabase.auth.signOut()}
          className="neu-out-sm neu-btn ml-auto rounded-2xl px-4 py-2 text-xs font-semibold"
          style={{ color: COLORS.accent }}
        >
          Sair
        </button>
      </nav>

      {view === "dashboard" ? (
        <Dashboard userId={session.user.id} />
      ) : (
        <PendingList userId={session.user.id} />
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`${active ? "neu-in" : "neu-out-sm neu-btn"} rounded-2xl px-5 py-2 text-sm font-bold`}
      style={{ color: active ? COLORS.danger : COLORS.ink }}
    >
      {children}
    </button>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const signIn = async () => {
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError("E-mail ou senha incorretos. Confira o usuário criado no Supabase.");
    setLoading(false);
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4"
      style={{ ...cssVars, backgroundColor: COLORS.bg, color: COLORS.ink }}
    >
      <div className="neu-out w-full max-w-sm rounded-3xl p-8">
        <h1 className="text-2xl font-bold">Finanças</h1>
        <p className="mt-1 text-sm opacity-70">Entre com seu usuário</p>

        <div className="mt-6 flex flex-col gap-4">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="E-mail"
            autoComplete="email"
            className="neu-input rounded-2xl px-4 py-3 text-sm"
            style={{ color: COLORS.ink }}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && signIn()}
            placeholder="Senha"
            autoComplete="current-password"
            className="neu-input rounded-2xl px-4 py-3 text-sm"
            style={{ color: COLORS.ink }}
          />
          {error && (
            <p className="text-xs font-semibold" style={{ color: COLORS.danger }}>
              {error}
            </p>
          )}
          <button
            onClick={signIn}
            disabled={loading || !email || !password}
            className="neu-out neu-btn rounded-2xl px-6 py-3 text-sm font-bold text-white disabled:opacity-40"
            style={{ background: COLORS.danger }}
          >
            {loading ? "Entrando…" : "Entrar"}
          </button>
        </div>
      </div>
    </div>
  );
}
