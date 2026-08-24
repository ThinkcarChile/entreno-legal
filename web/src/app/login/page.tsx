import { signIn, signUp } from "./actions";

interface Props {
  searchParams: Promise<{ error?: string; next?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const { error, next } = await searchParams;

  return (
    <main className="pt-16">
      <h1 className="text-3xl font-bold">Mesa Familiar</h1>
      <p className="mt-1 text-sm opacity-70">Inicia sesión o crea tu cuenta.</p>

      {error ? (
        <p className="mt-4 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}

      <form className="mt-6 flex flex-col gap-3">
        <input type="hidden" name="next" value={next ?? "/family"} />
        <label className="text-sm font-medium" htmlFor="email">
          Correo
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="rounded-xl border border-gray-300 bg-white px-4 py-3"
        />
        <label className="text-sm font-medium" htmlFor="password">
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="current-password"
          className="rounded-xl border border-gray-300 bg-white px-4 py-3"
        />
        <button
          formAction={signIn}
          className="mt-2 rounded-xl bg-[var(--accent)] px-4 py-3 font-semibold text-white"
        >
          Entrar
        </button>
        <button
          formAction={signUp}
          className="rounded-xl border border-[var(--accent)] px-4 py-3 font-semibold text-[var(--accent)]"
        >
          Crear cuenta
        </button>
      </form>
    </main>
  );
}
