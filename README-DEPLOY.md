# Finanças — Guia de Deploy (repo novo + Supabase novo)

Siga na ordem. Não pule etapas.

## A — Supabase

1. Crie o projeto novo em supabase.com (região São Paulo).
2. **SQL Editor** → cole e rode `sql/0001_initial_schema.sql` inteiro.
3. **SQL Editor** → cole e rode `sql/0002_security_invoker.sql` (corrige as views p/ respeitar RLS).
4. **Authentication → Users** → "Add user" → crie seu usuário com e-mail e senha
   (é o login do app; single-user, sem cadastro aberto).
5. **Settings → API** → anote dois valores:
   - `Project URL` (ex.: `https://xxxx.supabase.co`) — **sem** `/rest/v1` no fim
   - `anon public` key

## B — Repositório GitHub

1. Crie o repositório (ex.: `financas`). O nome importa: ele entra no passo C.2.
2. Crie os arquivos deste pacote, um a um, nos caminhos exatos indicados
   (botão "Add file → Create new file"; use `/` no nome pra criar pastas).
3. Em **Settings → Secrets and variables → Actions → New repository secret**, crie:
   - `VITE_SUPABASE_URL` → Project URL do passo A.5
   - `VITE_SUPABASE_ANON_KEY` → anon key do passo A.5

## C — GitHub Pages

1. **Settings → Pages** → Source: **GitHub Actions**.
2. Confira o `vite.config.js`: a linha `base: "/financas/"` deve ter o
   **nome exato do seu repositório** entre as barras.
3. Qualquer commit na branch `main` dispara o build e o deploy (2–3 min).
4. O site fica em `https://SEU_USUARIO.github.io/financas/`.

## D — Primeiro uso

1. Abra o site, faça login com o usuário do passo A.4.
2. Cadastre categorias direto no Supabase (**Table Editor → categories**),
   preenchendo `user_id` com o UUID do seu usuário (Authentication → Users).
3. Insira algumas transações de teste em `transactions` (status `pending`)
   e veja a Lista de Pendências funcionando.
4. Se algo não carregar: Ctrl+Shift+R pra furar o cache antes de debugar.

## Estrutura de arquivos

```
financas/
├── README-DEPLOY.md
├── package.json
├── vite.config.js
├── index.html
├── tailwind.config.js
├── postcss.config.js
├── .github/workflows/deploy.yml
├── sql/
│   ├── 0001_initial_schema.sql
│   └── 0002_security_invoker.sql
└── src/
    ├── main.jsx
    ├── index.css
    ├── App.jsx
    ├── lib/
    │   ├── theme.js
    │   └── supabase.js
    └── components/
        ├── Dashboard.jsx
        └── PendingList.jsx
```
