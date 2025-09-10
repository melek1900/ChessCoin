import { useEffect, useRef, useState, createContext, useContext } from "react";
import confetti from "canvas-confetti";

const API = import.meta.env.VITE_API_BASE || "http://localhost:4000";

/* -------------------------------------------------------
 * Helpers
 * ----------------------------------------------------- */
async function fetchJson<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      if ((j as any)?.error) msg = (j as any).error;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

function authHeader(
  token: string | null,
  extra?: Record<string, string>
): Record<string, string> {
  return token ? { ...(extra || {}), Authorization: `Bearer ${token}` } : { ...(extra || {}) };
}

/* -------------------------------------------------------
 * Toasts (ultra simple)
 * ----------------------------------------------------- */
type Toast = { id: number; kind: "info" | "ok" | "warn" | "err"; text: string };
const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});
function useToast() {
  return useContext(ToastCtx);
}
function Toasts({ list, onClose }: { list: Toast[]; onClose: (id: number) => void }) {
  return (
    <div className="toasts">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button onClick={() => onClose(t.id)} aria-label="Fermer">×</button>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------
 * Types
 * ----------------------------------------------------- */
type MeResponse = {
  me: {
    id: string;
    email: string | null;
    lichessId: string | null;
    lichessUsername: string | null;
    balance?: { chessCC: number; updatedAt: string };
  } | null;
};

type WalletResponse = {
  balance: { userId: string; chessCC: number; updatedAt: string } | null;
  ledger: {
    id: string;
    type: "gain" | "spend" | "stake_hold" | "stake_release" | "refund";
    amount: number;
    ref?: string | null;
    createdAt: string;
  }[];
  nextCursor: string | null;
};

type HistoryResponse = {
  items: { id: string; gameId: string | null; result: "W" | "L" | "D" | "abort" | null; at: string }[];
  nextCursor: string | null;
};

type LbBalanceResponse = {
  items: {
    rank: number;
    userId: string;
    email: string | null;
    lichess: string | null;
    chessCC: number;
    updatedAt: string;
  }[];
};

type LbGainsResponse = {
  items: {
    rank: number;
    userId: string;
    email: string | null;
    lichess: string | null;
    gained: number;
    since: string;
  }[];
};

type StreamStatus = {
  streaming: boolean;
  lastEventAt: number | null;
  lastGameId: string | null;
};

/* -------------------------------------------------------
 * App
 * ----------------------------------------------------- */
export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("token"));
  const [me, setMe] = useState<MeResponse["me"] | null>(null);
  const [loading, setLoading] = useState(false);

  // toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pushToast = (t: Omit<Toast, "id">) =>
    setToasts((prev) => [...prev, { ...t, id: Date.now() + Math.random() }]);
  const closeToast = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const loadMe = async (t = token) => {
    if (!t) return;
    setLoading(true);
    try {
      const r = await fetchJson<MeResponse>(`${API}/me`, { headers: authHeader(t) });
      setMe(r.me);
    } catch (e: any) {
      pushToast({ kind: "err", text: e.message || "Impossible de charger le profil" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) loadMe(token);
  }, [token]);

  const onLogout = () => {
    localStorage.removeItem("token");
    setToken(null);
    setMe(null);
    pushToast({ kind: "ok", text: "Déconnecté" });
  };

  return (
    <ToastCtx.Provider value={pushToast}>
      <div className="page">
        <header className="topbar">
          <div className="brand">
            <span className="logo">♟</span> ChessCoin
          </div>
          {token ? (
            <div className="top-actions">
              <span className="muted">{me?.email || me?.id}</span>
              <button className="btn ghost" onClick={onLogout}>
                Se déconnecter
              </button>
            </div>
          ) : null}
        </header>

        <main className="container">
          {!token ? (
            <AuthCard
              onSignedIn={(t) => {
                localStorage.setItem("token", t);
                setToken(t);
              }}
            />
          ) : (
            <Dashboard token={token} me={me} refreshMe={loadMe} loading={loading} />
          )}
        </main>

        <footer className="footer">© {new Date().getFullYear()} ChessCoin</footer>
        <Toasts list={toasts} onClose={closeToast} />
      </div>
    </ToastCtx.Provider>
  );
}

/* -------------------------------------------------------
 * Auth
 * ----------------------------------------------------- */
function AuthCard({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const pushToast = useToast();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await fetchJson<{ user: any; token: string }>(`${API}/dev/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() || undefined }),
      });
      onSignedIn(r.token);
      pushToast({ kind: "ok", text: "Bienvenue !" });
    } catch (e: any) {
      pushToast({ kind: "err", text: e.message || "Impossible de se connecter" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card auth">
      <h1>Bienvenue</h1>
      <p className="muted">Crée un compte ou connecte-toi avec ton email.</p>
      <form onSubmit={onSubmit} className="stack">
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            placeholder="tu@exemple.com (optionnel en dev)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <button className="btn primary" disabled={busy}>
          {busy ? "…" : "Continuer"}
        </button>
        <p className="hint">Astuce : si l'email existe déjà, tu seras reconnecté.</p>
      </form>
    </section>
  );
}

/* -------------------------------------------------------
 * Dashboard
 * ----------------------------------------------------- */
function Dashboard({
  token,
  me,
  refreshMe,
  loading,
}: {
  token: string;
  me: MeResponse["me"] | null;
  refreshMe: () => Promise<void>;
  loading: boolean;
}) {
  const linked = Boolean(me?.lichessId);
  const pushToast = useToast();

  // tick partagé pour forcer Wallet/History à recharger
  const [refreshTick, setRefreshTick] = useState(0);
  const pokeRefresh = () => setRefreshTick((t) => t + 1);

  // ---- Statut de stream
  const [stream, setStream] = useState<StreamStatus | null>(null);
  const loadStream = async () => {
    try {
      const r = await fetchJson<StreamStatus>(`${API}/lichess/stream/status`, {
        headers: authHeader(token),
      });
      setStream(r);
    } catch {
      setStream({ streaming: false, lastEventAt: null, lastGameId: null });
    }
  };
  useEffect(() => { if (linked) loadStream(); }, [linked]);
  useEffect(() => { if (linked) loadStream(); }, [refreshTick]);

  const streamBadge = (
    <span className={`pill ${stream?.streaming ? 'ok' : 'off'}`}>
      {stream?.streaming ? 'Stream ON' : 'Stream OFF'}
      {stream?.lastEventAt ? (
        <span className="pill-sub">· vu {new Date(stream.lastEventAt).toLocaleTimeString()}</span>
      ) : null}
    </span>
  );

  return (
    <div className="grid">
      <section className="card">
        <h2>Mon compte</h2>

        {/* Mini-bannière match en cours */}
        {stream?.streaming && stream?.lastGameId ? (
          <div className="banner live">
            Match en cours ·{" "}
            <a  href={`https://lichess.org/${stream.lastGameId}`} target="_blank">ouvrir</a>
          </div>
        ) : null}

        {loading ? <SkeletonRows rows={2} /> : null}
        <div className="row between" style={{ marginBottom: 8 }}>
          <div>
            <div className="kv">
              <span>Utilisateur</span>
              <b>{me?.email || me?.id}</b>
            </div>
            <div className="kv">
              <span>Lichess</span>
              <b className={linked ? "ok" : "warn"}>{linked ? me?.lichessUsername : "Non lié"}</b>
            </div>
            <div className="kv">
              <span>Solde</span>
              <b>{me?.balance?.chessCC ?? 0} CC</b>
            </div>
          </div>
          <div className="row">{linked ? streamBadge : <span className="pill off">Stream OFF</span>}</div>
        </div>

        <div className="row">
          <div className="right">
            {!linked ? (
              <LinkLichess
                token={token}
                onLinked={async () => {
                  await refreshMe();
                  pokeRefresh();
                  pushToast({ kind: "ok", text: "Compte Lichess lié ✅" });
                }}
              />
            ) : (
              <PlayBox
                token={token}
                onAfterAction={async () => {
                  await refreshMe();
                  pokeRefresh();
                }}
                onPoke={pokeRefresh}
              />
            )}
          </div>
        </div>
      </section>

      <WalletCard token={token} refreshTick={refreshTick} />
      <HistoryCard token={token} refreshTick={refreshTick} />
      <LeaderboardCard token={token} />
    </div>
  );
}

/* -------------------------------------------------------
 * Link Lichess
 * ----------------------------------------------------- */
function LinkLichess({ token, onLinked }: { token: string; onLinked: () => void }) {
  const [busy, setBusy] = useState(false);
  const opener = useRef<Window | null>(null);
  const pushToast = useToast();

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== "object" || !e.data) return;
      const { type } = e.data as any;
      if (type === "lichess_linked") {
        setBusy(false);
        onLinked();
      } else if (type === "lichess_conflict") {
        setBusy(false);
        pushToast({ kind: "warn", text: "Ce compte Lichess est déjà lié à un autre utilisateur." });
      } else if (type === "lichess_error") {
        setBusy(false);
        pushToast({ kind: "err", text: "Lien Lichess interrompu. Réessaie." });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onLinked, pushToast]);

  const start = async () => {
    setBusy(true);
    try {
      const r = await fetchJson<{ url: string }>(`${API}/lichess/login`, {
        headers: authHeader(token),
      });
      opener.current = window.open(
        r.url,
        "lichess-link",
        "width=420,height=640,noopener,noreferrer"
      );
    } catch (e: any) {
      setBusy(false);
      pushToast({ kind: "err", text: e.message || "Impossible de démarrer l'auth Lichess" });
    }
  };

  return (
    <div className="stack">
      <p className="muted">Lier ton compte Lichess pour jouer depuis ChessCoin.</p>
      <button className="btn primary" onClick={start} disabled={busy}>
        {busy ? "…" : "Lier mon compte Lichess"}
      </button>
    </div>
  );
}

/* -------------------------------------------------------
 * Play
 * ----------------------------------------------------- */
function PlayBox({
  token,
  onAfterAction,
  onPoke,
}: {
  token: string;
  onAfterAction: () => void;
  onPoke: () => void;
}) {
  const [stake, setStake] = useState<number>(0);
  const [opponent, setOpponent] = useState<string>("");
  const [busyPlay, setBusyPlay] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const pushToast = useToast();

  // watcher court pour rafraîchir l’UI après lancement
  const watcher = useRef<number | null>(null);
  const stopWatcher = () => {
    if (watcher.current) {
      window.clearInterval(watcher.current);
      watcher.current = null;
    }
  };
  useEffect(() => stopWatcher, []);

  const startShortWatch = () => {
    stopWatcher();
    let elapsed = 0;
    onPoke();
    watcher.current = window.setInterval(() => {
      elapsed += 5;
      onPoke();
      if (elapsed >= 60) {
        stopWatcher();
        let elapsed2 = 0;
        watcher.current = window.setInterval(() => {
          elapsed2 += 10;
          onPoke();
          if (elapsed2 >= 120) stopWatcher();
        }, 10_000);
      }
    }, 5_000);
  };

  const openRedirectWindow = () => window.open("about:blank", "_blank");

  const playQuick = async () => {
    setBusyPlay(true);
    setMsg(null);
    const w = openRedirectWindow();
    try {
      const r = await fetchJson<{ ok: boolean; launch: string }>(`${API}/play/quick`, {
        method: "POST",
        headers: authHeader(token, { "content-type": "application/json" }),
        body: JSON.stringify({ stake }),
      });
      if (w && !w.closed) w.location.href = r.launch || "https://lichess.org/";
      else setFallbackUrl(r.launch || "https://lichess.org/");
      setMsg("Partie lancée sur Lichess. Bonne chance !");
      onAfterAction();
      startShortWatch();
    } catch (e: any) {
      if (w && !w.closed) w.close();
      pushToast({ kind: "err", text: e.message || "Échec du lancement de partie" });
      setMsg("Échec du lancement de partie");
    } finally {
      setBusyPlay(false);
    }
  };

  const playStaked = async () => {
    if (!stake || stake <= 0) {
      setMsg("Choisis une mise > 0 pour lancer une partie avec mise.");
      return;
    }
    setBusyPlay(true);
    setMsg(null);
    const w = openRedirectWindow();
    try {
      const r = await fetchJson<{ ok: boolean; launch: string }>(`${API}/play/staked`, {
        method: "POST",
        headers: authHeader(token, { "content-type": "application/json" }),
        body: JSON.stringify({ stake }),
      });
      if (w && !w.closed) w.location.href = r.launch || "https://lichess.org/";
      else setFallbackUrl(r.launch || "https://lichess.org/");
      setMsg(`Partie à ${stake} CC lancée. Bonne chance !`);
      onAfterAction();
      startShortWatch();
    } catch (e: any) {
      if (w && !w.closed) w.close();
      pushToast({ kind: "err", text: e.message || "Échec du lancement (stake)" });
      setMsg("Échec du lancement (stake)");
    } finally {
      setBusyPlay(false);
    }
  };

  const playFriend = async () => {
    if (!stake || stake <= 0 || !opponent.trim()) {
      setMsg("Renseigne un pseudo Lichess et une mise > 0.");
      return;
    }
    setBusyPlay(true);
    setMsg(null);
    const w = openRedirectWindow();
    try {
      const r = await fetchJson<{ ok: boolean; launch: string }>(`${API}/play/staked/challenge`, {
        method: "POST",
        headers: authHeader(token, { "content-type": "application/json" }),
        body: JSON.stringify({ opponent: opponent.trim(), stake, time: 3, increment: 0, rated: false }),
      });
      if (w && !w.closed) w.location.href = r.launch || "https://lichess.org/";
      else setFallbackUrl(r.launch || "https://lichess.org/");
      setMsg(`Défi envoyé à ${opponent} pour ${stake} CC`);
      onAfterAction();
      startShortWatch();
    } catch (e: any) {
      if (w && !w.closed) w.close();
      pushToast({ kind: "err", text: e.message || "Échec du défi ami" });
      setMsg("Échec du défi ami");
    } finally {
      setBusyPlay(false);
    }
  };

  const joinQueue = async () => {
    if (!stake || stake <= 0) {
      setMsg("Mise requise pour entrer en file.");
      return;
    }
    setBusyPlay(true);
    setMsg(null);
    try {
      const r = await fetchJson<{ ok: boolean; matched?: boolean; launch?: string }>(`${API}/queue/join`, {
        method: "POST",
        headers: authHeader(token, { "content-type": "application/json" }),
        body: JSON.stringify({ stake, time: 3, increment: 0, rated: false }),
      });
      if (r.matched && r.launch) {
        const w = openRedirectWindow();
        if (w && !w.closed) w.location.href = r.launch || "https://lichess.org/";
        else setFallbackUrl(r.launch || "https://lichess.org/");
        setMsg("Adversaire trouvé ! Bonne chance !");
        onAfterAction();
        startShortWatch();
      } else {
        setQueued(true);
        setMsg("En file d'attente… (reste sur la page)");
      }
    } catch (e: any) {
      setMsg(e.message || "Échec matchmaking");
    } finally {
      setBusyPlay(false);
    }
  };

  const leaveQueue = async () => {
    try {
      await fetchJson(`${API}/queue/leave`, { method: "POST", headers: authHeader(token) });
      setQueued(false);
      setMsg("Tu as quitté la file.");
    } catch (e: any) {
      setMsg(e.message || "Impossible de quitter la file");
    }
  };

  return (
    <div className="card subtle">
      <h3>Jouer</h3>
      <p className="muted small">Choisis ta mise, puis lance un match.</p>

      <div className="stack">
        <label className="field">
          <span>Mise (CC)</span>
          <input
            type="number"
            min={0}
            value={stake}
            onChange={(e) => setStake(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>

        <div className="row wrap">
          <button className="btn" onClick={playQuick} disabled={busyPlay}>
            {busyPlay ? "…" : "Play Quick (3+0)"}
          </button>
          <button className="btn primary" onClick={playStaked} disabled={busyPlay || !stake}>
            {busyPlay ? "…" : `Play Staked (${stake} CC)`}
          </button>
        </div>

        <div className="divider" />

        <label className="field">
          <span>Défi ami (pseudo Lichess)</span>
          <input
            type="text"
            placeholder="ex: lichessUser123"
            value={opponent}
            onChange={(e) => setOpponent(e.target.value)}
          />
        </label>
        <div className="row">
          <button className="btn" onClick={playFriend} disabled={busyPlay || !stake || !opponent.trim()}>
            {busyPlay ? "…" : `Défier ${opponent || "…"}`}
          </button>
        </div>

        <div className="divider" />

        <div className="row">
          {!queued ? (
            <button className="btn" onClick={joinQueue} disabled={busyPlay || !stake}>
              {busyPlay ? "…" : "Matchmaking (aléatoire)"}
            </button>
          ) : (
            <button className="btn warn" onClick={leaveQueue} disabled={busyPlay}>
              Quitter la file
            </button>
          )}
        </div>

        {fallbackUrl ? (
          <p className="hint">
            Pop-up bloquée. Ouvre Lichess ici :{" "}
            <a href={fallbackUrl} target="_blank" rel="noreferrer">
              {fallbackUrl}
            </a>
          </p>
        ) : null}

        {msg ? <p className="hint">{msg}</p> : null}
        <p className="muted tiny">⚠️ Reste connecté à ChessCoin pendant ta partie pour la détection automatique.</p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------
 * Wallet
 * ----------------------------------------------------- */
function WalletCard({ token, refreshTick }: { token: string; refreshTick: number }) {
  const [type, setType] = useState<"all" | "gain" | "spend">("all");
  const [items, setItems] = useState<WalletResponse["ledger"]>([]);
  const [balance, setBalance] = useState<WalletResponse["balance"]>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (reset = false) => {
    setBusy(true);
    const qs = new URLSearchParams();
    qs.set("take", "20");
    if (type !== "all") qs.set("type", type);
    if (!reset && cursor) qs.set("cursor", cursor);
    const r = await fetchJson<WalletResponse>(`${API}/wallet?${qs.toString()}`, {
      headers: authHeader(token),
    });
    setBalance(r.balance);
    setItems((prev) => (reset ? r.ledger : [...prev, ...r.ledger]));
    setCursor(r.nextCursor);
    setBusy(false);
  };

  useEffect(() => {
    setItems([]);
    setCursor(null);
    load(true);
  }, [type]);

  useEffect(() => {
    setItems([]);
    setCursor(null);
    load(true);
  }, [refreshTick]);

  const label = (t: WalletResponse["ledger"][number]["type"]) =>
    t === "gain"
      ? "Gain"
      : t === "spend"
      ? "Dépense"
      : t === "refund"
      ? "Remboursé"
      : t === "stake_hold"
      ? "Mise bloquée"
      : t === "stake_release"
      ? "Mise libérée"
      : t;

  return (
    <section className="card">
      <h2>Wallet</h2>
      <div className="row between">
        <div className="muted">
          Solde : <b>{balance?.chessCC ?? 0} CC</b>
        </div>
        <div className="tabs">
          <button className={type === "all" ? "tab active" : "tab"} onClick={() => setType("all")}>
            Tout
          </button>
          <button className={type === "gain" ? "tab active" : "tab"} onClick={() => setType("gain")}>
            Gains
          </button>
          <button className={type === "spend" ? "tab active" : "tab"} onClick={() => setType("spend")}>
            Dépenses
          </button>
        </div>
      </div>

      {!items.length && busy ? <SkeletonRows rows={5} /> : null}
      {!items.length && !busy ? <EmptyState text="Aucune transaction pour l’instant." /> : null}

      <ul className="list">
        {items.map((it) => (
          <li key={it.id} className="list-row">
            <div className="badge">{label(it.type)}</div>
            <div className="grow">
              <div className="muted">{new Date(it.createdAt).toLocaleString()}</div>
              {it.ref ? (
                <a href={`https://lichess.org/${it.ref}`} target="_blank">
                  Game {it.ref}
                </a>
              ) : null}
            </div>
            <div className={`amount ${it.amount >= 0 ? "pos" : "neg"}`}>
              {it.amount >= 0 ? `+${it.amount}` : it.amount} CC
            </div>
          </li>
        ))}
      </ul>

      <div className="row">
        <button className="btn" onClick={() => load(false)} disabled={busy || !cursor}>
          {busy ? "…" : cursor ? "Voir plus" : "Fin"}
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------
 * History
 * ----------------------------------------------------- */
function HistoryCard({ token, refreshTick }: { token: string; refreshTick: number }) {
  const [items, setItems] = useState<HistoryResponse["items"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const prevCount = useRef(0);

  const load = async (reset = false) => {
    setBusy(true);
    const qs = new URLSearchParams();
    qs.set("take", "20");
    if (!reset && cursor) qs.set("cursor", cursor);
    const r = await fetchJson<HistoryResponse>(`${API}/history?${qs.toString()}`, {
      headers: authHeader(token),
    });
    setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
    setCursor(r.nextCursor);
    setBusy(false);
  };

  useEffect(() => {
    load(true);
  }, []);

  useEffect(() => {
    const run = async () => {
      const r = await fetchJson<HistoryResponse>(`${API}/history?take=5`, {
        headers: authHeader(token),
      });
      if (r.items.length > 0 && r.items[0].result === "W" && r.items.length !== prevCount.current) {
        confetti({ particleCount: 140, spread: 75, origin: { y: 0.6 } });
      }
      prevCount.current = r.items.length;
      setItems(r.items);
      setCursor(r.nextCursor);
    };
    run();
  }, [refreshTick]);

  const badge = (r: HistoryResponse["items"][number]["result"]) =>
    r === "W" ? <span className="badge success">Win</span> :
    r === "L" ? <span className="badge danger">Loss</span> :
    r === "D" ? <span className="badge">Draw</span> :
    r === "abort" ? <span className="badge warn">Abort</span> :
    <span className="badge muted">—</span>;

  return (
    <section className="card">
      <h2>Historique</h2>

      {!items.length && busy ? <SkeletonRows rows={4} /> : null}
      {!items.length && !busy ? <EmptyState text="Aucune partie encore. Lance-toi !" /> : null}

      <ul className="list">
        {items.map((it) => (
          <li key={it.id} className="list-row">
            {badge(it.result)}
            <div className="grow">
              <div className="muted">{new Date(it.at).toLocaleString()}</div>
              {it.gameId ? (
                <a href={`https://lichess.org/${it.gameId}`} target="_blank">
                  Voir la partie
                </a>
              ) : (
                <span className="muted">—</span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="row">
        <button className="btn" onClick={() => load(false)} disabled={busy || !cursor}>
          {busy ? "…" : cursor ? "Voir plus" : "Fin"}
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------
 * Leaderboard
 * ----------------------------------------------------- */
function LeaderboardCard({ token }: { token: string }) {
  const [tab, setTab] = useState<"balance" | "gains30d">("balance");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Array<Record<string, any>>>([]);

  const load = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (tab === "balance") {
        const r = await fetchJson<LbBalanceResponse>(`${API}/leaderboard/balance`, {
          headers: authHeader(token),
        });
        setRows(r.items);
      } else {
        const r = await fetchJson<LbGainsResponse>(`${API}/leaderboard/gains30d`, {
          headers: authHeader(token),
        });
        setRows(r.items);
      }
    } catch (e: any) {
      setErr(e.message || "Impossible de charger le classement");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
  }, [tab]);

  return (
    <section className="card">
      <h2>Classement</h2>

      <div className="row between">
        <div className="tabs">
          <button className={tab === "balance" ? "tab active" : "tab"} onClick={() => setTab("balance")}>
            Solde
          </button>
          <button className={tab === "gains30d" ? "tab active" : "tab"} onClick={() => setTab("gains30d")}>
            Gains 30j
          </button>
        </div>
        <button className="btn ghost" onClick={load} disabled={busy}>
          {busy ? "…" : "Rafraîchir"}
        </button>
      </div>

      {err ? <p className="error">{err}</p> : null}
      {busy && !rows.length ? <SkeletonRows rows={5} /> : null}
      {!rows.length && !busy && !err ? <EmptyState text="Pas encore de classement." /> : null}

      <ul className="list">
        {rows.slice(0, 20).map((it: any) => (
          <li key={`${tab}-${it.userId}`} className="list-row">
            <div className="badge">{it.rank}</div>
            <div className="grow">
              <div className="muted">{it.lichess ? <b>{it.lichess}</b> : <b>{it.email || it.userId}</b>}</div>
              <div className="muted tiny">
                {tab === "balance"
                  ? `Maj: ${new Date(it.updatedAt).toLocaleString()}`
                  : `Depuis: ${new Date(it.since).toLocaleDateString()}`}
              </div>
            </div>
            <div className="amount">{tab === "balance" ? `${it.chessCC} CC` : `+${it.gained ?? 0} CC`}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------
 * UI helpers
 * ----------------------------------------------------- */
function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-stack">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
    </div>
  );
}
function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">🕳</div>
      <p className="muted">{text}</p>
    </div>
  );
}
