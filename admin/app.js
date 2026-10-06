/* ============================================================================
   JEITO MIAMI · Sistema interno · app.js
   Versión: ver APP_VERSION (subir en CADA entrega; ver docs/).

   Cómo está organizado este archivo:
     1. Constantes y estado en memoria
     2. Utilidades (fechas, texto, toasts)
     3. Conexión a Supabase, login y perfil
     4. Candado de versión (no guardar con un app.js viejo)
     5. Capa de datos (lectura y guardado por tabla)
     6. Interfaz: esqueleto, Acta de clientes, ficha, Administración
     7. Arranque
   ========================================================================== */
(function () {
  "use strict";

  /* ==========================================================================
     1. CONSTANTES Y ESTADO
     ========================================================================== */
  const APP_VERSION = "1.2.2";

  // Seguridad de la sesión
  const PASSWORD_MIN = 8;                       // largo mínimo de contraseña
  const IDLE_MS = 8 * 60 * 60 * 1000;           // se cierra sola tras 8 h sin uso
  const IDLE_WARN_MS = 5 * 60 * 1000;           // aviso 5 min antes
  const IDLE_KEY = "jm_last_activity";          // compartido entre pestañas

  const ROLES = {
    direccion:           "Dirección",
    ventas:              "Ventas",
    operaciones:         "Operaciones",
    operador_financiero: "Op. financiero",
    chofer:              "Chofer"
  };
  // Quién puede hacer qué en la interfaz. (La base tiene las mismas reglas en
  // RLS: aunque alguien toque el JavaScript, la base no lo deja.)
  const CAN = {
    verClientes:     ["direccion", "ventas", "operaciones", "operador_financiero"],
    editarClientes:  ["direccion", "ventas", "operaciones"],
    verProveedores:  ["direccion", "operaciones", "operador_financiero"],
    editarProveedores: ["direccion", "operaciones"],
    admin:           ["direccion"]
  };

  const LEAD_STATUS = {
    ingreso:     "Ingreso",
    pendiente:   "Pendiente",
    seguimiento: "Seguimiento",
    cerrado:     "Cerrado",
    no_cerrado:  "No cerrado"
  };
  const NO_CLOSE_REASONS = ["Precio", "Cambió de destino", "Sin respuesta", "Fechas", "Otro"];
  const SOURCES = ["Instagram", "WhatsApp directo", "Indicación", "Web", "TikTok", "Agencia asociada", "Otro"];

  // País de origen → idioma del itinerario (se puede cambiar a mano en la ficha).
  const LANGS = { pt: "Português", es: "Español", en: "English" };
  const LANG_PT = ["BR", "PT", "AO", "MZ", "CV", "GW", "ST", "TL"];
  const LANG_ES = ["AR", "BO", "CL", "CO", "CR", "CU", "DO", "EC", "SV", "GQ", "GT", "HN", "MX", "NI", "PA", "PY", "PE", "PR", "ES", "UY", "VE"];
  const COUNTRIES_TOP = ["BR", "AR", "UY", "CL", "PY", "CO", "PE", "MX", "ES", "PT", "US"];
  const COUNTRIES_ALL = ("AF AL DE AD AO AG SA DZ AR AM AU AT AZ BS BD BB BH BE BZ BJ BY BO BA BW BR BN BG BF BI BT CV KH CM CA QA TD CL CN CY CO KM CG CD KP KR CI CR HR CU DK DM EC EG SV AE ER SK SI ES US EE SZ ET PH FI FJ FR GA GM GE GH GD GR GT GN GQ GW GY HT HN HK HU IN ID IQ IR IE IS IL IT JM JP JO KZ KE KG KI KW LA LS LV LB LR LY LI LT LU MO MK MG MY MW MV ML MT MA MH MU MR MX FM MD MC MN ME MZ MM NA NR NP NI NE NG NO NZ OM NL PK PW PS PA PG PY PE PL PT PR GB CF CZ DO RW RO RU WS KN SM VC LC ST SN RS SC SL SG SY SO LK ZA SD SS SE CH SR TH TW TZ TJ TL TG TO TT TN TM TR TV UA UG UY UZ VU VA VE VN YE DJ ZM ZW").split(" ");
  const _regionNames = (() => { try { return new Intl.DisplayNames(["es"], { type: "region" }); } catch (e) { return null; } })();
  function countryName(code) { if (!code) return ""; try { return (_regionNames && _regionNames.of(code)) || code; } catch (e) { return code; } }
  function langForCountry(code) { return LANG_PT.includes(code) ? "pt" : LANG_ES.includes(code) ? "es" : "en"; }
  function countryOptions() {
    const byName = (a, b) => countryName(a).localeCompare(countryName(b), "es");
    const rest = COUNTRIES_ALL.filter(c => !COUNTRIES_TOP.includes(c)).sort(byName);
    return { top: COUNTRIES_TOP.map(c => ({ v: c, l: countryName(c) })), rest: rest.map(c => ({ v: c, l: countryName(c) })) };
  }

  const state = {
    supabase: null,
    session: null,
    me: null,            // fila de app_users del usuario logueado
    users: [],           // app_users (para elegir vendedor)
    settings: {},        // {key: value}
    zones: [], serviceTypes: [], paymentMethods: [],
    clients: [],         // fichas cargadas (sin borradas salvo que se pida)
    view: "acta",
    filters: { q: "", period: currentPeriod(), seller: "", status: "", showDeleted: false },
    drawer: null,        // {client, tab, loadedUpdatedAt, events}
    cat: null,           // proveedores, servicios, ofertas y valores (se carga al entrar a Proveedores)
    prov: { tab: "prov", edit: null, dirty: false, q: "", month: currentPeriod(), showOff: false },
    modal: null,
    codeStale: false,    // hay una versión más nueva publicada
    remoteVersion: null,
    sync: { status: "ok", text: "" },
    loginNote: "",       // aviso en la pantalla de login (ej. sesión cerrada por inactividad)
    weakPassword: false, // entró con una contraseña de menos de PASSWORD_MIN
    versionTimer: null
  };

  /* ==========================================================================
     2. UTILIDADES
     ========================================================================== */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function currentPeriod() { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
  function periodOf(iso) { const d = new Date(iso); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  function periodLabel(p) { if (!p) return "Todo"; const [y, m] = p.split("-"); return MESES[+m - 1] + " " + y; }
  function fmtDateTime(iso) { if (!iso) return ""; const d = new Date(iso); return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function fmtDateLong(iso) { if (!iso) return ""; const d = new Date(iso); return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function fmtDate(ymd) { if (!ymd) return "—"; const [y, m, d] = ymd.split("-"); return d + "/" + m; }
  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return "hace " + s + " s";
    if (s < 3600) return "hace " + Math.round(s / 60) + " min";
    if (s < 86400) return "hace " + Math.round(s / 3600) + " h";
    return "hace " + Math.round(s / 86400) + " días";
  }
  function fullName(c) { return ((c.first_name || "") + " " + (c.last_name || "")).trim(); }
  function userName(id) { const u = state.users.find(u => u.id === id); return u ? u.display_name : (id ? "—" : "—"); }
  function initials(name) { return (name || "?").split(/\s+/).map(p => p[0]).join("").slice(0, 2).toUpperCase(); }
  function cmpVersion(a, b) {        // devuelve >0 si a es más nueva que b
    const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
  }
  function toast(msg, kind) {
    const t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    $("#toasts").appendChild(t);
    setTimeout(() => t.remove(), kind === "bad" ? 7000 : 3500);
  }
  function setSync(status, text) { state.sync = { status, text }; const el = $("#syncBox"); if (el) el.outerHTML = syncHTML(); }
  function syncHTML() {
    const s = state.sync;
    const txt = s.text || (s.status === "ok" ? "Conectado" : s.status === "busy" ? "Guardando…" : "Sin conexión");
    return `<div class="sync ${s.status === "ok" ? "" : s.status}" id="syncBox"><i></i>${esc(txt)}</div>`;
  }
  function explainError(err) {
    // Traduce los errores de Supabase a algo que se entienda
    const m = (err && (err.message || err.error_description || err.msg)) || String(err);
    if (/row-level security|permission denied/i.test(m)) return "Tu usuario no tiene permiso para hacer esto.";
    if (/Failed to fetch|NetworkError|network/i.test(m)) return "No hay conexión con la base. Revisá internet y volvé a intentar.";
    if (/Invalid login credentials/i.test(m)) return "Usuario o contraseña incorrectos.";
    if (/duplicate key.*username/i.test(m)) return "Ya existe un usuario con ese nombre.";
    if (/already registered/i.test(m)) return "Ya existe un usuario con ese nombre.";
    if (/Password should be|at least \d+ characters/i.test(m)) return "La contraseña tiene que tener al menos " + PASSWORD_MIN + " caracteres.";
    if (/departure/i.test(m)) return "La fecha de salida no puede ser anterior a la de llegada.";
    return m;
  }

  /* ==========================================================================
     3. SUPABASE, LOGIN Y PERFIL
     ========================================================================== */
  function configOk() {
    const c = window.JEITO_CONFIG || {};
    return c.SUPABASE_URL && c.SUPABASE_ANON_KEY && !/PEGAR_ACA/.test(c.SUPABASE_URL + c.SUPABASE_ANON_KEY);
  }
  function emailFor(username) {
    const raw = String(username || "").trim().toLowerCase();
    if (raw.includes("@")) return raw;            // si escriben el mail completo, se usa tal cual
    const dom = (window.JEITO_CONFIG && window.JEITO_CONFIG.AUTH_EMAIL_DOMAIN) || "jeitomiami.app";
    return cleanUsername(username) + "@" + dom;
  }
  // Acepta la URL aunque se haya pegado con /rest/v1/ o barras al final.
  function cleanUrl(u) { return String(u || "").trim().replace(/\/+(rest\/v1|auth\/v1)?\/*$/i, ""); }
  function cleanUsername(u) { return String(u || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, ""); }

  async function login(username, password) {
    const { error } = await state.supabase.auth.signInWithPassword({ email: emailFor(username), password });
    if (error) throw error;
  }
  async function logout(note) {
    state.loginNote = typeof note === "string" ? note : "";
    state.weakPassword = false; hideIdleWarn();
    await state.supabase.auth.signOut();
    state.session = null; state.me = null; state.clients = []; state.cat = null;
    render();
  }
  async function loadProfile() {
    const { data, error } = await state.supabase.from("app_users").select("*").eq("id", state.session.user.id).maybeSingle();
    if (error) throw error;
    state.me = (data && data.id) ? data : null;   // null = existe en Auth pero no está activo (RLS no lo deja verse)
  }
  function can(action) { return !!state.me && CAN[action].includes(state.me.role); }

  /* ==========================================================================
     4. CANDADO DE VERSIÓN
     Cada app.js trae APP_VERSION. En la base, settings.app_version dice cuál
     es la última publicada. Si la de esta pestaña es más vieja, no se guarda
     nada hasta recargar. Se revisa al entrar, antes de cada guardado y cada
     60 segundos.
     ========================================================================== */
  async function checkVersion() {
    const { data, error } = await state.supabase.from("settings").select("value").eq("key", "app_version").maybeSingle();
    if (error || !data) return true;            // si no se puede leer, no bloquea (se avisa en el guardado si falla)
    state.remoteVersion = data.value;
    const stale = cmpVersion(data.value, APP_VERSION) > 0;
    if (stale !== state.codeStale) { state.codeStale = stale; renderBanner(); }
    return !stale;
  }
  async function assertCanSave() {
    if (!(await checkVersion())) {
      throw new Error("Hay una versión más nueva del sistema (" + state.remoteVersion + "). Recargá la página para actualizar y volvé a intentar.");
    }
  }

  /* ==========================================================================
     5. CAPA DE DATOS
     ========================================================================== */
  const db = {
    async loadBase() {
      const sb = state.supabase;
      const [users, settings, zones, types, methods] = await Promise.all([
        sb.from("app_users").select("*").order("display_name"),
        sb.from("settings").select("*"),
        sb.from("zones").select("*").order("sort_order"),
        sb.from("service_types").select("*").order("sort_order"),
        sb.from("payment_methods").select("*").order("sort_order")
      ]);
      for (const r of [users, settings, zones, types, methods]) if (r.error) throw r.error;
      state.users = users.data || [];
      state.settings = {}; (settings.data || []).forEach(s => { state.settings[s.key] = s.value; });
      state.zones = zones.data || []; state.serviceTypes = types.data || []; state.paymentMethods = methods.data || [];
      if (state.settings.app_version) { state.remoteVersion = state.settings.app_version; state.codeStale = cmpVersion(state.remoteVersion, APP_VERSION) > 0; }
    },
    async loadClients() {
      const { data, error } = await state.supabase.from("clients").select("*").order("created_at", { ascending: false }).limit(2000);
      if (error) throw error;
      state.clients = data || [];
    },
    async createClient(fields) {
      await assertCanSave();
      const { data, error } = await state.supabase.from("clients").insert(fields).select().single();
      if (error) throw error;
      return data;
    },
    // Guardado con candado optimista: solo pisa si la fila en la nube sigue
    // siendo la misma que se leyó (updated_at igual). Si otra persona la
    // cambió en el medio, no se guarda y se avisa.
    async updateClient(id, loadedUpdatedAt, patch) {
      await assertCanSave();
      const { data, error } = await state.supabase.from("clients").update(patch).eq("id", id).eq("updated_at", loadedUpdatedAt).select();
      if (error) throw error;
      if (!data || !data.length) {
        const err = new Error("CONFLICTO"); err.conflict = true; throw err;
      }
      return data[0];
    },
    async fetchClient(id) {
      const { data, error } = await state.supabase.from("clients").select("*").eq("id", id).single();
      if (error) throw error;
      return data;
    },
    async clientEvents(id) {
      const { data, error } = await state.supabase.from("client_events").select("*").eq("client_id", id).order("at", { ascending: false }).limit(200);
      if (error) throw error;
      return data || [];
    },
    async upsertConfig(table, row) {
      await assertCanSave();
      const q = row.id ? state.supabase.from(table).update(row).eq("id", row.id).select() : state.supabase.from(table).insert(row).select();
      const { data, error } = await q;
      if (error) throw error;
      return data[0];
    },
    async setSetting(key, value) {
      await assertCanSave();
      const { error } = await state.supabase.from("settings").update({ value }).eq("key", key);
      if (error) throw error;
      state.settings[key] = value;
    },
    async updateUser(id, patch) {
      await assertCanSave();
      const { data, error } = await state.supabase.from("app_users").update(patch).eq("id", id).select();
      if (error) throw error;
      if (!data || !data.length) throw new Error("No se pudo guardar el usuario (¿tenés permiso?).");
      return data[0];
    },
    // Crear un usuario: se usa una conexión aparte y descartable para
    // registrarlo, así la sesión de dirección no se toca. El usuario nace
    // inactivo (lo decide la base) y acá mismo se activa.
    async createUser({ username, display_name, role, password }) {
      if (String(password || "").length < PASSWORD_MIN) throw new Error("La contraseña tiene que tener al menos " + PASSWORD_MIN + " caracteres.");
      await assertCanSave();
      const c = window.JEITO_CONFIG;
      const tmp = window.supabase.createClient(cleanUrl(c.SUPABASE_URL), c.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const { data, error } = await tmp.auth.signUp({ email: emailFor(username), password, options: { data: { username: cleanUsername(username), display_name, role } } });
      if (error) throw error;
      const newId = data.user && data.user.id;
      if (!newId) throw new Error("Supabase no devolvió el usuario nuevo. Revisá que en Authentication esté desactivado 'Confirm email'.");
      try { await tmp.auth.signOut(); } catch (e) { /* no importa */ }
      // activar + asegurar rol (por si el metadata no llegó)
      let ok = false;
      for (let i = 0; i < 6 && !ok; i++) {          // el trigger de la base tarda un instante
        const { data: rows } = await state.supabase.from("app_users").update({ active: true, role, display_name }).eq("id", newId).select();
        ok = rows && rows.length > 0;
        if (!ok) await new Promise(r => setTimeout(r, 500));
      }
      if (!ok) throw new Error("El usuario se creó pero no se pudo activar. Activalo desde la lista (botón Activar).");
    },
    async changeMyPassword(password) {
      const { error } = await state.supabase.auth.updateUser({ password });
      if (error) throw error;
    },
    async backups() {
      const { data, error } = await state.supabase.from("backups").select("id, taken_at, taken_by, note, size_bytes").order("taken_at", { ascending: false }).limit(50);
      if (error) throw error;
      return data || [];
    },
    async takeBackup() {
      const { data, error } = await state.supabase.rpc("take_backup", { p_note: "manual" });
      if (error) throw error;
      return data;
    },
    async restoreBackup(id) {
      await assertCanSave();
      const { data, error } = await state.supabase.rpc("restore_backup", { p_id: id });
      if (error) throw error;
      return data;
    },
    async backupPayload(id) {
      const { data, error } = await state.supabase.from("backups").select("payload").eq("id", id).single();
      if (error) throw error;
      return data.payload;
    },
    async ledgerCount() {
      const { count, error } = await state.supabase.from("money_ledger").select("id", { count: "exact", head: true });
      if (error) return null;
      return count;
    }
  };

  /* ==========================================================================
     6. INTERFAZ
     ========================================================================== */
  function render() {
    const app = $("#app");
    if (!configOk()) {
      app.innerHTML = `<div class="splash"><div class="box"><h3>Falta configurar la conexión</h3><p>Abrí <code>config.js</code> y pegá la URL y la anon key del proyecto de Supabase (ver GUIA-INSTALACION.md, paso 3).</p></div></div>`;
      return;
    }
    if (!state.session) { app.innerHTML = loginHTML(); wireLogin(); return; }
    if (!state.me) { app.innerHTML = noAccessHTML(); wireNoAccess(); return; }
    app.innerHTML = shellHTML();
    wireShell();
    renderView();
  }

  /* ---------- login ---------- */
  function logoSVG(w) {
    return `<svg width="${w}" height="${Math.round(w * 0.4)}" viewBox="0 0 300 120" aria-label="Jeito Miami"><text x="150" y="70" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700" font-size="58" fill="#001E48" letter-spacing="2">JEI<tspan fill="#E4B472">TO</tspan></text><text x="150" y="100" text-anchor="middle" font-family="Inter,sans-serif" font-weight="500" font-size="15" fill="#E4B472" letter-spacing="9">MIAMI</text></svg>`;
  }
  function loginHTML() {
    return `<div class="login"><form class="login-card" id="loginForm">
      <div class="logo">${logoSVG(150)}</div>
      <h1>Ingresar al sistema</h1>
      <p class="sub">Usuario y contraseña de Jeito Miami</p>
      <div id="loginErr">${state.loginNote ? `<div class="infomsg">${esc(state.loginNote)}</div>` : ""}</div>
      <div class="field"><label>Usuario</label><input name="u" autocomplete="username" autofocus placeholder="tu.usuario" required></div>
      <div class="field"><label>Contraseña</label><input name="p" type="password" autocomplete="current-password" required></div>
      <button class="btn primary block" type="submit">Entrar</button>
      <div class="foot">¿Olvidaste la contraseña? Pedísela a dirección. · v${APP_VERSION}</div>
    </form></div>`;
  }
  function wireLogin() {
    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target; const btn = $("button", f); btn.disabled = true; $("#loginErr").innerHTML = "";
      try {
        state.weakPassword = f.p.value.length < PASSWORD_MIN;
        state.loginNote = "";
        touchActivity(true);
        await login(f.u.value, f.p.value);
      } catch (err) {
        $("#loginErr").innerHTML = `<div class="err">${esc(explainError(err))}</div>`;
        btn.disabled = false;
      }
    });
  }
  function noAccessHTML() {
    return `<div class="splash"><div class="box"><h3>Tu usuario todavía no está habilitado</h3><p>Existe, pero dirección tiene que activarlo y darle un rol. Avisale y volvé a entrar.</p><button class="btn" id="btnOut">Salir</button></div></div>`;
  }
  function wireNoAccess() { $("#btnOut").addEventListener("click", () => logout()); }

  /* ---------- esqueleto ---------- */
  const NAV = [
    { group: "Comercial" },
    { id: "acta", label: "Acta de clientes", icon: "M4 5h16v14H4z M8 9h8M8 13h5", need: "verClientes" },
    { id: "itin", label: "Itinerarios", icon: "M4 6h16M4 12h16M4 18h10", soon: "etapa 4" },
    { id: "banco", label: "Banco de reservas", icon: "M3 4h18v16H3z M8 2v4M16 2v4M3 10h18", soon: "etapa 6" },
    { group: "Operaciones" },
    { id: "logi", label: "Logística", icon: "M3 7h13l3 4h2v6H3z", soon: "etapa 7" },
    { id: "chof", label: "Choferes y flota", icon: "M12 4a4 4 0 1 0 0 8a4 4 0 0 0 0-8z M4 20c0-4 4-6 8-6s8 2 8 6", soon: "etapa 7" },
    { id: "prov", label: "Proveedores", icon: "M4 4h16v16H4z M4 9h16M9 9v11", need: "verProveedores" },
    { group: "Dinero" },
    { id: "cobr", label: "Cobranzas", icon: "M3 6h18v12H3z M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z", soon: "etapa 5" },
    { id: "fin", label: "Financiero", icon: "M4 19V5M4 19h16M8 15l4-5 3 3 5-7", soon: "etapa 6" },
    { id: "stats", label: "Estadísticas", icon: "M5 20V10M12 20V4M19 20v-7", soon: "etapa 9" },
    { group: "Sistema" },
    { id: "admin", label: "Administración", icon: "M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z M12 2v3M12 19v3M2 12h3M19 12h3", need: "admin" }
  ];
  const TITLES = { acta: "Acta de clientes", prov: "Proveedores y servicios", admin: "Administración", perfil: "Mi usuario" };

  function shellHTML() {
    const nav = NAV.map(n => {
      if (n.group) return `<div class="group">${n.group}</div>`;
      const icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="17" height="17"><path d="${n.icon}"/></svg>`;
      if (n.soon) return `<a class="soon">${icon}${n.label}<span class="tag">${n.soon}</span></a>`;
      if (n.need && !can(n.need)) return "";
      return `<a data-view="${n.id}" class="${state.view === n.id ? "on" : ""}">${icon}${n.label}</a>`;
    }).join("");
    return `<div class="shell">
      <aside class="side">
        <div class="brand"><svg width="34" height="34" viewBox="0 0 34 34"><circle cx="17" cy="17" r="16" fill="#E4B472"/><text x="17" y="22" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700" font-size="14" fill="#001E48">JM</text></svg><div><b>Jeito Miami</b><small>Sistema interno</small></div></div>
        <nav id="nav">${nav}</nav>
        <div class="me"><div class="av">${esc(initials(state.me.display_name))}</div><div><b>${esc(state.me.display_name)}</b><small>${esc(ROLES[state.me.role] || state.me.role)} · <a data-view="perfil" style="color:inherit;cursor:pointer">mi usuario</a></small></div><button id="btnLogout" title="Salir">Salir</button></div>
      </aside>
      <div class="main">
        <div id="banner"></div>
        <div class="topbar"><h2 id="pageTitle">${esc(TITLES[state.view] || "")}</h2><span class="ver">v${APP_VERSION}</span>${syncHTML()}</div>
        <div class="content" id="content"></div>
      </div>
    </div>`;
  }
  function wireShell() {
    $("#app").addEventListener("click", (e) => {
      const a = e.target.closest("[data-view]");
      if (a) { e.preventDefault(); goView(a.dataset.view); }
    });
    $("#btnLogout").addEventListener("click", () => logout());
    renderBanner();
  }
  function goView(v) {
    state.view = v; state.drawer = null;
    $$("#nav a[data-view]").forEach(a => a.classList.toggle("on", a.dataset.view === v));
    $("#pageTitle").textContent = TITLES[v] || "";
    renderView();
  }
  function renderBanner() {
    const el = $("#banner"); if (!el) return;
    if (!state.codeStale && state.weakPassword) {
      el.innerHTML = `<div class="banner">🔒 Tu contraseña tiene menos de ${PASSWORD_MIN} caracteres. Por seguridad, cambiala por una más larga. <button class="btn sm primary" data-view="perfil">Cambiarla ahora</button></div>`;
      return;
    }
    if (state.codeStale) {
      el.innerHTML = `<div class="banner">⚠️ Hay una versión más nueva del sistema (${esc(state.remoteVersion)}). Esta pestaña tiene la ${APP_VERSION} y <b>&nbsp;no va a poder guardar&nbsp;</b> hasta que actualices. <button class="btn sm primary" onclick="location.reload(true)">Actualizar ahora</button></div>`;
    } else el.innerHTML = "";
  }
  async function renderView() {
    const c = $("#content"); if (!c) return;
    if (state.view === "acta") return renderActa();
    if (state.view === "admin") return renderAdmin();
    if (state.view === "prov") return renderProv();
    if (state.view === "perfil") return renderPerfil();
    c.innerHTML = `<div class="placeholder"><b>En construcción</b></div>`;
  }

  /* ==========================================================================
     6a. ACTA DE CLIENTES
     ========================================================================== */
  function visibleClients() {
    const f = state.filters; const q = f.q.trim().toLowerCase();
    return state.clients.filter(c => {
      if (!f.showDeleted && c.deleted_at) return false;
      if (f.period && periodOf(c.created_at) !== f.period) return false;
      if (f.seller && c.seller_id !== f.seller) return false;
      if (f.status && c.lead_status !== f.status) return false;
      if (q && !(fullName(c).toLowerCase().includes(q) || String(c.number).includes(q) || countryName(c.origin_country).toLowerCase().includes(q))) return false;
      return true;
    });
  }
  function kpisFor(period) {
    const inPeriod = c => !c.deleted_at && (!period || periodOf(c.created_at) === period);
    const rows = state.clients.filter(inPeriod);
    const closed = rows.filter(c => c.lead_status === "cerrado");
    const pax = closed.reduce((a, c) => a + (c.adults || 0) + (c.minors || 0), 0);
    const bySeller = {};
    rows.forEach(c => { const k = c.seller_id || "sin"; bySeller[k] = bySeller[k] || { n: 0, closed: 0, pax: 0 }; bySeller[k].n++; if (c.lead_status === "cerrado") { bySeller[k].closed++; bySeller[k].pax += (c.adults || 0) + (c.minors || 0); } });
    let best = null; Object.entries(bySeller).forEach(([k, v]) => { if (k !== "sin" && (!best || v.closed > best.v.closed)) best = { k, v }; });
    const seg = rows.filter(c => c.lead_status === "seguimiento");
    const stale = seg.filter(c => Date.now() - new Date(c.status_changed_at).getTime() > 3 * 86400000).length;
    return { total: rows.length, closed: closed.length, pct: rows.length ? Math.round(closed.length * 100 / rows.length) : 0, seg: seg.length, stale, pax, adults: closed.reduce((a, c) => a + (c.adults || 0), 0), minors: closed.reduce((a, c) => a + (c.minors || 0), 0), best, bySeller };
  }
  function periodsAvailable() {
    const set = new Set(state.clients.map(c => periodOf(c.created_at))); set.add(currentPeriod());
    return Array.from(set).sort().reverse();
  }

  function renderActa() {
    const f = state.filters, k = kpisFor(f.period), rows = visibleClients();
    const sellers = state.users.filter(u => u.active && ["direccion", "ventas", "operaciones"].includes(u.role));
    const c = $("#content");
    c.innerHTML = `
      <div class="kpis">
        <div class="kpi gold"><small>Ingresados</small><b>${k.total}</b><span>${esc(periodLabel(f.period))}</span></div>
        <div class="kpi"><small>Cerrados</small><b>${k.closed}</b><span>${k.pct}% de cierre</span></div>
        <div class="kpi"><small>En seguimiento</small><b>${k.seg}</b><span>${k.stale ? k.stale + " sin novedades hace +3 días" : "al día"}</span></div>
        <div class="kpi"><small>Pasajeros vendidos</small><b>${k.pax}</b><span>${k.adults} adultos · ${k.minors} menores</span></div>
        <div class="kpi"><small>Mejor vendedor</small><b>${k.best ? esc(userName(k.best.k)) : "—"}</b><span>${k.best ? k.best.v.closed + " cierres · " + Math.round(k.best.v.closed * 100 / k.best.v.n) + "%" : "sin cierres"}</span></div>
      </div>
      <div class="toolbar">
        <input class="grow" id="fQ" placeholder="Buscar por nombre, número o país…" value="${esc(f.q)}">
        <select id="fPeriod"><option value="">Todo</option>${periodsAvailable().map(p => `<option value="${p}" ${p === f.period ? "selected" : ""}>${esc(periodLabel(p))}</option>`).join("")}</select>
        <select id="fSeller"><option value="">Todos los vendedores</option>${sellers.map(u => `<option value="${u.id}" ${u.id === f.seller ? "selected" : ""}>${esc(u.display_name)}</option>`).join("")}</select>
        <div class="chips" id="fStatus"><span class="chip ${!f.status ? "on" : ""}" data-s="">Todos</span>${Object.entries(LEAD_STATUS).map(([k, v]) => `<span class="chip ${f.status === k ? "on" : ""}" data-s="${k}">${v}</span>`).join("")}</div>
        ${state.clients.some(x => x.deleted_at) ? `<label class="toggle"><input type="checkbox" id="fDeleted" ${f.showDeleted ? "checked" : ""}> ver borrados</label>` : ""}
        ${can("editarClientes") ? `<button class="btn gold" id="btnNew">+ Nuevo cliente</button>` : ""}
      </div>
      <div class="card">
        <div class="tablewrap"><table>
          <thead><tr><th>Nº</th><th>Ingreso</th><th>Cliente</th><th>Pax</th><th>Viaje</th><th>País · medio</th><th>Vendedor</th><th>Estado</th></tr></thead>
          <tbody>${rows.length ? rows.map(rowHTML).join("") : `<tr><td colspan="8" class="empty">No hay clientes con estos filtros.</td></tr>`}</tbody>
        </table></div>
        <div class="tfoot">Mostrando ${rows.length} de ${state.clients.filter(c => f.showDeleted || !c.deleted_at).length} · ordenado por ingreso <button class="btn sm" id="btnExport">Exportar a Excel</button></div>
      </div>`;
    // eventos
    $("#fQ").addEventListener("input", e => { f.q = e.target.value; refreshTable(); });
    $("#fPeriod").addEventListener("change", e => { f.period = e.target.value; renderActa(); });
    $("#fSeller").addEventListener("change", e => { f.seller = e.target.value; refreshTable(); });
    if ($("#fDeleted")) $("#fDeleted").addEventListener("change", e => { f.showDeleted = e.target.checked; refreshTable(); });
    $("#fStatus").addEventListener("click", e => { const ch = e.target.closest(".chip"); if (!ch) return; f.status = ch.dataset.s; $$("#fStatus .chip").forEach(x => x.classList.toggle("on", x === ch)); refreshTable(); });
    $("#btnExport").addEventListener("click", exportCSV);
    if ($("#btnNew")) $("#btnNew").addEventListener("click", () => openDrawer(null));
    c.querySelector("tbody").addEventListener("click", e => { const tr = e.target.closest("tr.row"); if (tr) openDrawer(state.clients.find(x => x.id === tr.dataset.id)); });
  }
  function refreshTable() {
    const rows = visibleClients(); const tb = $("#content tbody");
    if (tb) tb.innerHTML = rows.length ? rows.map(rowHTML).join("") : `<tr><td colspan="8" class="empty">No hay clientes con estos filtros.</td></tr>`;
    const foot = $("#content .tfoot"); if (foot) foot.firstChild.textContent = `Mostrando ${rows.length} de ${state.clients.filter(c => state.filters.showDeleted || !c.deleted_at).length} · ordenado por ingreso `;
  }
  function rowHTML(c) {
    const pax = (c.adults || 0) + (c.minors ? " + " + c.minors : "");
    const viaje = c.arrival ? fmtDate(c.arrival) + " → " + fmtDate(c.departure) : "—";
    return `<tr class="row ${c.deleted_at ? "deleted" : ""}" data-id="${c.id}">
      <td class="num">${c.number}</td><td class="num">${fmtDateTime(c.created_at)}</td>
      <td><span class="name">${esc(fullName(c))}</span>${c.interests ? `<span class="sub">${esc(c.interests)}</span>` : ""}</td>
      <td>${pax}</td><td class="num">${viaje}</td>
      <td>${esc(countryName(c.origin_country) || "—")}${c.lang ? ` <span class="lang">${c.lang.toUpperCase()}</span>` : ""}<span class="sub">${esc(c.source || "")}</span></td>
      <td>${esc(userName(c.seller_id))}</td>
      <td><span class="st ${c.lead_status}">${LEAD_STATUS[c.lead_status] || c.lead_status}</span>${c.lead_status === "no_cerrado" && c.no_close_reason ? `<span class="sub">${esc(c.no_close_reason)}</span>` : ""}</td>
    </tr>`;
  }
  function exportCSV() {
    const rows = visibleClients();
    const head = ["Nº", "Ingreso", "Nombre", "Apellido", "Adultos", "Menores", "Edades menores", "Llegada", "Salida", "País", "Idioma", "Medio", "Qué le interesa", "Vendedor", "Estado", "Motivo no cierre", "Cerrado el", "Observaciones"];
    const lines = [head].concat(rows.map(c => [c.number, fmtDateLong(c.created_at), c.first_name, c.last_name, c.adults, c.minors, c.minors_ages, c.arrival, c.departure, countryName(c.origin_country), LANGS[c.lang] || "", c.source, c.interests, userName(c.seller_id), LEAD_STATUS[c.lead_status], c.no_close_reason, c.closed_at ? fmtDateLong(c.closed_at) : "", c.observations]));
    const csv = "﻿" + lines.map(r => r.map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = "clientes-" + (state.filters.period || "todo") + ".csv"; a.click();
  }

  /* ---------- ficha (drawer) ---------- */
  function openDrawer(client) {
    state.drawer = { client: client ? Object.assign({}, client) : null, tab: "datos", loadedUpdatedAt: client ? client.updated_at : null, events: null, dirty: false };
    renderDrawer();
    if (client) db.clientEvents(client.id).then(ev => { if (state.drawer && state.drawer.client && state.drawer.client.id === client.id) { state.drawer.events = ev; if (state.drawer.tab === "historial") renderDrawerBody(); } }).catch(() => { });
  }
  function closeDrawer(force) {
    if (!force && state.drawer && state.drawer.dirty && !confirm("Hay cambios sin guardar. ¿Cerrar igual?")) return;
    state.drawer = null; const d = $("#drawerRoot"); if (d) d.remove();
  }
  function renderDrawer() {
    let root = $("#drawerRoot");
    if (!root) { root = document.createElement("div"); root.id = "drawerRoot"; document.body.appendChild(root); }
    const d = state.drawer, c = d.client, isNew = !c;
    const editable = can("editarClientes") && !(c && c.deleted_at);
    root.innerHTML = `<div class="overlay" id="ovl"></div>
      <aside class="drawer" role="dialog">
        <header><div><div class="n">${isNew ? "Ficha nueva · el número se asigna al guardar" : `Ficha Nº ${c.number} · ingresó ${fmtDateLong(c.created_at)} · cargó ${esc(userName(c.created_by))}`}</div><h3>${isNew ? "Nuevo cliente" : esc(fullName(c))}${c && c.deleted_at ? ' <span class="st no_cerrado">borrado</span>' : ""}</h3></div><button class="x" id="btnX" title="Cerrar">×</button></header>
        <div class="tabs" id="dTabs"><button data-t="datos" class="${d.tab === "datos" ? "on" : ""}">Datos</button>${isNew ? "" : `<button data-t="itin" class="${d.tab === "itin" ? "on" : ""}">Itinerarios</button><button data-t="cobros" class="${d.tab === "cobros" ? "on" : ""}">Cobros</button><button data-t="historial" class="${d.tab === "historial" ? "on" : ""}">Historial</button>`}</div>
        <div class="body" id="dBody"></div>
        <footer id="dFoot"></footer>
      </aside>`;
    $("#ovl").addEventListener("click", () => closeDrawer());
    $("#btnX").addEventListener("click", () => closeDrawer());
    $("#dTabs").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; d.tab = b.dataset.t; $$("#dTabs button").forEach(x => x.classList.toggle("on", x === b)); renderDrawerBody(); });
    document.addEventListener("keydown", escClose);
    renderDrawerBody();
    void editable;
  }
  function escClose(e) { if (e.key === "Escape") { document.removeEventListener("keydown", escClose); closeDrawer(); } }

  function renderDrawerBody() {
    const d = state.drawer; if (!d) return;
    const c = d.client || {}, isNew = !d.client;
    const editable = can("editarClientes") && !c.deleted_at;
    const body = $("#dBody"), foot = $("#dFoot");
    if (d.tab === "datos") {
      const sellers = state.users.filter(u => u.active && ["direccion", "ventas", "operaciones"].includes(u.role));
      const sel = (name, opts, val, extra) => `<select name="${name}" ${extra || ""} ${editable ? "" : "disabled"}>${opts.map(o => `<option value="${esc(o.v)}" ${o.v === (val || "") ? "selected" : ""}>${esc(o.l)}</option>`).join("")}</select>`;
      const co = countryOptions();
      const inp = (name, val, type, extra) => `<input name="${name}" type="${type || "text"}" value="${esc(val == null ? "" : val)}" ${extra || ""} ${editable ? "" : "disabled"}>`;
      body.innerHTML = `<form id="cForm">
        <div class="sect">Cliente</div>
        <div class="grid2">
          <div class="field"><label>Nombre *</label>${inp("first_name", c.first_name, "text", "required")}</div>
          <div class="field"><label>Apellido</label>${inp("last_name", c.last_name)}</div>
          <div class="field"><label>País de origen</label><select name="origin_country" id="fCountry" ${editable ? "" : "disabled"}><option value="">—</option><optgroup label="Más frecuentes">${co.top.map(o => `<option value="${o.v}" ${o.v === c.origin_country ? "selected" : ""}>${esc(o.l)}</option>`).join("")}</optgroup><optgroup label="Todos">${co.rest.map(o => `<option value="${o.v}" ${o.v === c.origin_country ? "selected" : ""}>${esc(o.l)}</option>`).join("")}</optgroup></select>${c.origin_city ? `<span class="help">Ciudad cargada antes: ${esc(c.origin_city)}</span>` : ""}</div>
          <div class="field"><label>Idioma del itinerario</label>${sel("lang", Object.entries(LANGS).map(([v, l]) => ({ v, l })), c.lang || "pt", 'id="fLang"')}<span class="help">Se elige solo según el país; se puede cambiar.</span></div>
          <div class="field"><label>¿Cómo llegó?</label>${sel("source", [{ v: "", l: "—" }].concat(SOURCES.map(s => ({ v: s, l: s }))), c.source)}</div>
        </div>
        <div class="sect">Viaje</div>
        <div class="grid3">
          <div class="field"><label>Adultos</label>${inp("adults", c.adults == null ? 2 : c.adults, "number", 'min="0"')}</div>
          <div class="field"><label>Menores</label>${inp("minors", c.minors == null ? 0 : c.minors, "number", 'min="0"')}</div>
          <div class="field"><label>Edades menores</label>${inp("minors_ages", c.minors_ages, "text", 'placeholder="7, 12"')}</div>
          <div class="field"><label>Llegada</label>${inp("arrival", c.arrival, "date")}</div>
          <div class="field"><label>Salida</label>${inp("departure", c.departure, "date")}</div>
        </div>
        <div class="field"><label>Qué le interesa</label>${inp("interests", c.interests, "text", 'placeholder="Parques, compras, Key West…"')}</div>
        <div class="sect">Comercial</div>
        <div class="grid3">
          <div class="field"><label>Vendedor</label>${sel("seller_id", [{ v: "", l: "—" }].concat(sellers.map(u => ({ v: u.id, l: u.display_name }))), c.seller_id || (isNew ? state.me.id : ""))}</div>
          <div class="field"><label>Estado</label>${sel("lead_status", Object.entries(LEAD_STATUS).map(([v, l]) => ({ v, l })), c.lead_status || "ingreso", 'id="fStatusSel"')}</div>
          <div class="field"><label>Motivo de no cierre</label>${sel("no_close_reason", [{ v: "", l: "—" }].concat(NO_CLOSE_REASONS.map(s => ({ v: s, l: s }))), c.no_close_reason, 'id="fReason"')}</div>
        </div>
        <div class="field"><label>Observaciones</label><textarea name="observations" rows="3" ${editable ? "" : "disabled"}>${esc(c.observations || "")}</textarea></div>
        ${c.closed_at ? `<div class="field"><span class="help">Cerrado por primera vez el ${fmtDateLong(c.closed_at)} · último cambio de estado ${fmtDateLong(c.status_changed_at)}</span></div>` : ""}
      </form>`;
      const syncReason = () => { const s = $("#fStatusSel"), r = $("#fReason"); if (s && r) { r.disabled = !editable || s.value !== "no_cerrado"; if (s.value !== "no_cerrado") r.value = ""; } };
      syncReason();
      if ($("#fCountry")) $("#fCountry").addEventListener("change", e => { if (e.target.value) $("#fLang").value = langForCountry(e.target.value); });
      $("#cForm").addEventListener("change", () => { d.dirty = true; syncReason(); });
      $("#cForm").addEventListener("input", () => { d.dirty = true; });
      $("#cForm").addEventListener("submit", e => { e.preventDefault(); saveClient(); });
      foot.innerHTML = `${c.deleted_at && can("editarClientes") ? `<button class="btn ghost" id="btnRestore">Restaurar</button>` : ""}
        <div class="rightside"><button class="btn" id="btnCancel">Cerrar</button>${editable ? `<button class="btn primary" id="btnSave">Guardar</button>` : ""}</div>`;
      $("#btnCancel").addEventListener("click", () => closeDrawer());
      if ($("#btnSave")) $("#btnSave").addEventListener("click", saveClient);
      if ($("#btnRestore")) $("#btnRestore").addEventListener("click", () => softDelete(false));
    } else if (d.tab === "itin") {
      body.innerHTML = `<div class="placeholder"><b>Itinerarios · etapa 4</b>Acá van las versiones del itinerario: cuál ve el pasajero, cuál está cerrada, y el link público en portugués para mandar por WhatsApp.</div>`;
      foot.innerHTML = `<div class="rightside"><button class="btn" id="btnCancel">Cerrar</button></div>`; $("#btnCancel").addEventListener("click", () => closeDrawer());
    } else if (d.tab === "cobros") {
      body.innerHTML = `<div class="placeholder"><b>Cobros · etapa 5</b>Lo que debe según el itinerario cerrado, lo que pagó (en reales o dólares, con la cotización de ese día) y el saldo. Solo lo ve dirección.</div>`;
      foot.innerHTML = `<div class="rightside"><button class="btn" id="btnCancel">Cerrar</button></div>`; $("#btnCancel").addEventListener("click", () => closeDrawer());
    } else {
      const ev = d.events;
      body.innerHTML = ev == null ? `<div class="empty">Cargando historial…</div>` : ev.length ? `<ul class="list">${ev.map(eventHTML).join("")}</ul><div class="note">Cada cambio lo registra la base de datos sola, con quién y cuándo. Nada se borra de acá.</div>` : `<div class="empty">Sin movimientos.</div>`;
      foot.innerHTML = `<div class="rightside"><button class="btn" id="btnCancel">Cerrar</button></div>`; $("#btnCancel").addEventListener("click", () => closeDrawer());
    }
  }
  const FIELD_LABELS = { first_name: "nombre", last_name: "apellido", origin_city: "ciudad", origin_country: "país", lang: "idioma", source: "medio", adults: "adultos", minors: "menores", minors_ages: "edades", arrival: "llegada", departure: "salida", hotel_zone: "hotel/zona", interests: "intereses", seller_id: "vendedor", lead_status: "estado", no_close_reason: "motivo", observations: "observaciones", deleted_at: "borrado" };
  function eventHTML(e) {
    const who = esc(userName(e.by_user));
    let txt;
    if (e.action === "creado") txt = `<b>${who}</b> creó la ficha`;
    else if (e.action === "borrado") txt = `<b>${who}</b> la marcó como borrada`;
    else if (e.action === "restaurado") txt = `<b>${who}</b> la restauró`;
    else {
      const parts = Object.entries(e.detail || {}).filter(([k]) => k !== "restore_backup").map(([k, v]) => {
        const fmt = x => { if (x == null || x === "") return "—"; if (k === "lead_status") return LEAD_STATUS[x] || x; if (k === "seller_id") return userName(x); if (k === "origin_country") return countryName(x); if (k === "lang") return LANGS[x] || x; return String(x); };
        return `${FIELD_LABELS[k] || k}: ${esc(fmt(v.de))} → <b>${esc(fmt(v.a))}</b>`;
      });
      if (e.detail && e.detail.restore_backup) parts.push("restaurado desde el backup " + e.detail.restore_backup);
      txt = `<b>${who}</b> · ${parts.join(" · ") || "modificó la ficha"}`;
    }
    return `<li><div class="grow">${txt}</div><small class="nowrap">${fmtDateLong(e.at)}</small></li>`;
  }
  function readForm() {
    const f = $("#cForm"); const fd = new FormData(f); const o = {};
    for (const [k, v] of fd.entries()) o[k] = typeof v === "string" ? v.trim() : v;
    o.adults = Math.max(0, parseInt(o.adults || "0", 10) || 0);
    o.minors = Math.max(0, parseInt(o.minors || "0", 10) || 0);
    ["origin_country", "source", "minors_ages", "arrival", "departure", "interests", "seller_id", "no_close_reason", "observations", "last_name"].forEach(k => { if (o[k] === "") o[k] = k === "last_name" ? "" : null; });
    if (o.lead_status !== "no_cerrado") o.no_close_reason = null;
    return o;
  }
  async function saveClient() {
    const d = state.drawer; if (!d) return;
    const form = $("#cForm"); if (!form.reportValidity()) return;
    const fields = readForm();
    if (fields.lead_status === "no_cerrado" && !fields.no_close_reason) { toast("Elegí el motivo de no cierre.", "bad"); return; }
    if (fields.arrival && fields.departure && fields.departure < fields.arrival) { toast("La salida no puede ser antes que la llegada.", "bad"); return; }
    const btn = $("#btnSave"); if (btn) btn.disabled = true; setSync("busy", "Guardando…");
    try {
      let saved;
      if (!d.client) {
        saved = await db.createClient(fields);
        state.clients.unshift(saved);
        toast("Cliente Nº " + saved.number + " creado.", "ok");
      } else {
        // solo mando lo que cambió (regla 3: nadie pisa lo que no editó)
        const patch = {}; Object.keys(fields).forEach(k => { if ((fields[k] == null ? null : fields[k]) !== (d.client[k] == null ? null : d.client[k])) patch[k] = fields[k]; });
        if (!Object.keys(patch).length) { toast("No había cambios."); d.dirty = false; closeDrawer(true); return; }
        saved = await db.updateClient(d.client.id, d.loadedUpdatedAt, patch);
        const i = state.clients.findIndex(x => x.id === saved.id); if (i >= 0) state.clients[i] = saved;
        toast("Guardado.", "ok");
      }
      d.dirty = false; closeDrawer(true); setSync("ok", "Guardado " + ago(new Date().toISOString()));
      if (state.view === "acta") renderActa();
    } catch (err) {
      if (err.conflict) {
        const fresh = await db.fetchClient(d.client.id).catch(() => null);
        if (fresh) { const i = state.clients.findIndex(x => x.id === fresh.id); if (i >= 0) state.clients[i] = fresh; d.client = fresh; d.loadedUpdatedAt = fresh.updated_at; d.dirty = false; renderDrawerBody(); }
        toast("Otra persona modificó esta ficha mientras la editabas. Te muestro la versión actual: volvé a hacer tu cambio.", "bad");
      } else toast(explainError(err), "bad");
      setSync("ok", "");
      if (btn) btn.disabled = false;
    }
  }
  async function softDelete(del) {
    const d = state.drawer; if (!d || !d.client) return;
    if (del && !confirm("¿Marcar la ficha Nº " + d.client.number + " como borrada? Deja de verse en la lista, pero no se pierde.")) return;
    setSync("busy", "Guardando…");
    try {
      const saved = await db.updateClient(d.client.id, d.loadedUpdatedAt, { deleted_at: del ? new Date().toISOString() : null });
      const i = state.clients.findIndex(x => x.id === saved.id); if (i >= 0) state.clients[i] = saved;
      toast(del ? "Ficha marcada como borrada." : "Ficha restaurada.", "ok"); closeDrawer(true); renderActa();
    } catch (err) { toast(err.conflict ? "Otra persona modificó esta ficha. Cerrala y volvé a abrirla." : explainError(err), "bad"); }
    setSync("ok", "");
  }

  /* ==========================================================================
     6a2. PROVEEDORES Y CATÁLOGO DE SERVICIOS
     Proveedor → experiencias que ofrece → valores por mes:
       público (lo que paga el pasajero) y agencia (lo que paga Jeito).
     La misma experiencia (servicio) la pueden ofrecer varios proveedores.
     ========================================================================== */
  function money(n) {
    if (n == null || n === "") return "—";
    return "US$ " + Number(n).toLocaleString("es-AR", { maximumFractionDigits: 2 });
  }
  function monthKey(ym) { return ym + "-01"; }                       // "2027-01" → "2027-01-01"
  function numOrNull(v) { const s = String(v == null ? "" : v).trim().replace(",", "."); if (s === "") return null; const n = Number(s); return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN; }
  function sameVal(a, b) {
    const na = a == null || a === "" ? null : a, nb = b == null || b === "" ? null : b;
    if (na === null || nb === null) return na === nb;
    if (typeof na === "number" || typeof nb === "number") return Number(na) === Number(nb);
    return String(na) === String(nb);
  }
  function svcName(s) { return s ? s.name_es : "—"; }
  function provById(id) { return (state.cat.providers || []).find(p => p.id === id); }
  function svcById(id) { return (state.cat.services || []).find(s => s.id === id); }
  function offersOfProvider(pid) { return state.cat.offers.filter(o => o.provider_id === pid); }
  function offersOfService(sid) { return state.cat.offers.filter(o => o.service_id === sid); }
  function priceOf(offerId, ym) { return state.cat.prices.find(p => p.offer_id === offerId && p.month === monthKey(ym)) || null; }
  function margin(pub, ag) { if (pub == null || ag == null) return null; return Number(pub) - Number(ag); }
  function marginHTML(pub, ag) {
    const m = margin(pub, ag); if (m == null) return `<span class="muted">—</span>`;
    const pct = Number(pub) > 0 ? Math.round(m * 100 / Number(pub)) : 0;
    return `<b class="${m < 0 ? "neg" : "pos"}">${money(m)}</b><span class="sub">${pct}%</span>`;
  }
  function typeName(id) { const t = state.serviceTypes.find(x => x.id === id); return t ? t.name : ""; }
  function zoneName(id) { const z = state.zones.find(x => x.id === id); return z ? z.name : ""; }

  Object.assign(db, {
    async loadCatalog() {
      const sb = state.supabase;
      const [p, s, o, pr] = await Promise.all([
        sb.from("providers").select("*").order("name"),
        sb.from("services").select("*").order("name_es"),
        sb.from("provider_services").select("*"),
        sb.from("offer_prices").select("*")
      ]);
      for (const r of [p, s, o, pr]) if (r.error) throw r.error;
      state.cat = { providers: p.data || [], services: s.data || [], offers: o.data || [], prices: pr.data || [] };
    },
    // Guarda UNA fila: si es nueva la crea; si existe manda solo los campos que
    // cambiaron, con candado (updated_at = el que leí). Regla 3.
    async saveRow(table, orig, fields) {
      await assertCanSave();
      if (!orig) {
        const { data, error } = await state.supabase.from(table).insert(fields).select().single();
        if (error) throw error;
        return data;
      }
      const patch = {}; Object.keys(fields).forEach(k => { if (!sameVal(fields[k], orig[k])) patch[k] = fields[k]; });
      if (!Object.keys(patch).length) return orig;
      const { data, error } = await state.supabase.from(table).update(patch).eq("id", orig.id).eq("updated_at", orig.updated_at).select();
      if (error) throw error;
      if (!data || !data.length) { const err = new Error("CONFLICTO"); err.conflict = true; throw err; }
      return data[0];
    },
    async auditFor(col, id) {
      const { data, error } = await state.supabase.from("audit_events").select("*").eq(col, id).order("at", { ascending: false }).limit(80);
      if (error) throw error;
      return data || [];
    },
    async restoreCatalog(id) {
      const { data, error } = await state.supabase.rpc("restore_catalog", { p_id: id });
      if (error) throw error;
      return data;
    }
  });

  function catError(err) {
    if (err && err.conflict) return "Otra persona cambió esto mientras lo editabas. Te muestro lo actual: volvé a hacer tu cambio.";
    const m = (err && err.message) || "";
    if (/providers_name_uq/.test(m)) return "Ya existe un proveedor con ese nombre.";
    if (/services_name_uq/.test(m)) return "Ya existe un servicio con ese nombre.";
    if (/provider_services_provider_id_service_id/.test(m)) return "Ese proveedor ya ofrece esa experiencia.";
    if (/default_time/.test(m)) return "El horario tiene que ser HH:MM (por ejemplo 08:30).";
    return explainError(err);
  }

  /* ---------- pantalla: arriba el formulario (nuevo / editar), abajo la lista ---------- */
  async function renderProv() {
    const c = $("#content");
    if (!can("verProveedores")) { c.innerHTML = `<div class="placeholder"><b>Sin acceso</b>Proveedores lo ven dirección, operaciones y op. financiero.</div>`; return; }
    const P = state.prov;
    if (!state.cat) {
      c.innerHTML = `<div class="empty">Cargando proveedores…</div>`;
      try { await db.loadCatalog(); } catch (err) { c.innerHTML = `<div class="placeholder"><b>No se pudo cargar</b>${esc(explainError(err))}<br><br>¿Ya se corrió el SQL de Proveedores en Supabase?</div>`; return; }
      if (state.view !== "prov") return;
    }
    const isProv = P.tab === "prov", ed = can("editarProveedores");
    const nOffers = state.cat.offers.filter(o => o.active && (svcById(o.service_id) || {}).active !== false).length;
    c.innerHTML = `
      <div class="subtabs" id="pvTabs"><button data-t="prov" class="${isProv ? "on" : ""}">Proveedores <span>${state.cat.providers.filter(x => x.active).length}</span></button><button data-t="svc" class="${!isProv ? "on" : ""}">Servicios <span>${nOffers}</span></button></div>
      <div class="pv-head"><div><h3>${isProv ? "Proveedores" : "Servicios"}</h3><small>${isProv ? "Las empresas que hacen las excursiones y traslados, con sus datos de pago." : "Cada servicio con su proveedor y los valores del mes: público (lo que paga el pasajero) y agencia (lo que paga Jeito)."}</small></div>
        ${ed ? `<button class="btn gold" id="pvNew">+ Nuevo ${isProv ? "proveedor" : "servicio"}</button>` : ""}</div>
      <div id="pvDetail"></div>
      <div class="card" id="pvList"></div>`;
    $("#pvTabs").addEventListener("click", e => {
      const b = e.target.closest("button[data-t]"); if (!b || b.dataset.t === P.tab) return;
      if (P.dirty && !confirm("Hay cambios sin guardar en el formulario. ¿Salir igual?")) return;
      P.tab = b.dataset.t; P.edit = null; P.dirty = false; P.q = ""; renderProv();
    });
    if ($("#pvNew")) $("#pvNew").addEventListener("click", () => openForm("new"));
    renderPvDetail(); renderPvList();
  }
  function openForm(id) {
    const P = state.prov;
    if (P.dirty && P.edit !== id && !confirm("Hay cambios sin guardar en el formulario. ¿Descartarlos?")) return;
    P.edit = id; P.dirty = false; renderPvDetail(); renderPvList();
    const el = $("#pvDetail"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    const first = el && el.querySelector("input:not([disabled]), select:not([disabled])"); if (first && id === "new") setTimeout(() => first.focus(), 250);
  }
  function closeForm() {
    const P = state.prov;
    if (P.dirty && !confirm("Hay cambios sin guardar. ¿Cerrar igual?")) return;
    P.edit = null; P.dirty = false; renderPvDetail(); renderPvList();
  }
  function renderPvDetail() {
    const P = state.prov, el = $("#pvDetail"); if (!el) return;
    if (!P.edit) { el.innerHTML = ""; return; }
    if (P.dirty && el.firstChild) return;            // no borrar lo que se está escribiendo
    if (P.tab === "prov") providerForm(el); else serviceForm(el);
  }
  function wireDirty(form) {
    const P = state.prov;
    form.addEventListener("input", () => { P.dirty = true; });
    form.addEventListener("change", () => { P.dirty = true; });
  }

  /* ---------- lista de abajo ---------- */
  function renderPvList() {
    const P = state.prov, el = $("#pvList"); if (!el) return;
    const isProv = P.tab === "prov";
    const q = P.q.trim().toLowerCase();
    let body, count;
    if (isProv) {
      const rows = state.cat.providers.filter(x => P.showOff || x.active).filter(x => !q || [x.name, x.payment_method, x.conditions].join(" ").toLowerCase().includes(q));
      count = rows.length;
      body = `<table><thead><tr><th>Proveedor</th><th>Moneda</th><th>Forma de pago</th><th>Condiciones</th><th class="r">Servicios</th></tr></thead><tbody>${rows.map(x => {
        const n = offersOfProvider(x.id).filter(o => o.active).length;
        return `<tr class="row ${x.id === P.edit ? "sel" : ""} ${x.active ? "" : "off"}" data-id="${x.id}"><td><span class="name">${esc(x.name)}</span>${x.active ? "" : '<span class="sub">inactivo</span>'}</td><td>${x.currency}</td><td>${esc(x.payment_method || "—")}</td><td class="clip">${esc(x.conditions || "—")}</td><td class="r">${n}</td></tr>`;
      }).join("") || `<tr><td colspan="5" class="empty">${q ? "Nada coincide con la búsqueda." : "Todavía no hay proveedores. Tocá “+ Nuevo proveedor”."}</td></tr>`}</tbody></table>`;
    } else {
      const rows = state.cat.offers.map(o => ({ o, s: svcById(o.service_id), p: provById(o.provider_id) }))
        .filter(r => r.s && r.p && (P.showOff || (r.o.active && r.s.active)))
        .filter(r => !q || [r.s.name_es, r.s.name_pt, r.s.name_en, r.p.name].join(" ").toLowerCase().includes(q))
        .sort((a, b) => a.s.name_es.localeCompare(b.s.name_es, "es") || a.p.name.localeCompare(b.p.name, "es"));
      count = rows.length;
      body = `<table class="money"><thead><tr><th rowspan="2">Servicio</th><th rowspan="2">Proveedor</th><th colspan="2" class="c">Valor público</th><th colspan="2" class="c">Valor agencia</th><th rowspan="2" class="r">Ganancia<br>por adulto</th><th rowspan="2"></th></tr>
        <tr><th class="r">Adulto</th><th class="r">Menor</th><th class="r">Adulto</th><th class="r">Menor</th></tr></thead><tbody>${rows.map(({ o, s, p }) => {
          const pr = priceOf(o.id, P.month), miss = missingFor(s);
          return `<tr class="row ${o.id === P.edit ? "sel" : ""} ${o.active && s.active ? "" : "off"}" data-id="${o.id}"><td><span class="name">${esc(s.name_es)}</span>${miss.length ? `<span class="sub warn">falta: ${esc(miss.join(", "))}</span>` : ""}${o.active ? "" : '<span class="sub">ya no lo ofrece</span>'}</td><td>${esc(p.name)}</td>
            ${pr ? `<td class="r">${money(pr.public_adult)}</td><td class="r">${money(pr.public_minor)}</td><td class="r">${money(pr.agency_adult)}</td><td class="r">${money(pr.agency_minor)}</td><td class="r">${marginHTML(pr.public_adult, pr.agency_adult)}</td>` : `<td colspan="5" class="c"><span class="sub warn" style="display:inline">sin valores en ${esc(periodLabel(P.month))}</span></td>`}
            <td class="r"><button class="btn sm" data-act="months">Meses</button></td></tr>`;
        }).join("") || `<tr><td colspan="8" class="empty">${q ? "Nada coincide con la búsqueda." : state.cat.providers.some(x => x.active) ? "Todavía no hay servicios. Tocá “+ Nuevo servicio”." : "Primero cargá un proveedor en la pestaña Proveedores."}</td></tr>`}</tbody></table>`;
    }
    el.innerHTML = `<div class="pv-tools"><input id="pvQ" placeholder="${isProv ? "Buscar proveedor…" : "Buscar servicio o proveedor…"}" value="${esc(P.q)}">
        ${isProv ? "" : `<label class="pv-month">Valores de <input type="month" id="pvMonth" value="${P.month}"></label>`}
        <label class="toggle"><input type="checkbox" id="pvOff" ${P.showOff ? "checked" : ""}> ver inactivos</label></div>
      <div class="tablewrap">${body}</div>
      <div class="tfoot">${count} ${isProv ? (count === 1 ? "proveedor" : "proveedores") : (count === 1 ? "servicio" : "servicios")} · tocá un renglón para ${can("editarProveedores") ? "editarlo" : "ver el detalle"}</div>`;
    $("#pvQ").addEventListener("input", e => { P.q = e.target.value; const pos = e.target.selectionStart; renderPvList(); const i = $("#pvQ"); i.focus(); i.setSelectionRange(pos, pos); });
    $("#pvOff").addEventListener("change", e => { P.showOff = e.target.checked; renderPvList(); });
    if ($("#pvMonth")) $("#pvMonth").addEventListener("change", e => { if (!e.target.value) return; P.month = e.target.value; renderPvList(); if (P.edit && !P.dirty) renderPvDetail(); });
    el.querySelector("tbody").addEventListener("click", e => {
      const tr = e.target.closest("tr[data-id]"); if (!tr) return;
      if (e.target.closest("button[data-act=months]")) { pricesModal(state.cat.offers.find(o => o.id === tr.dataset.id)); return; }
      openForm(tr.dataset.id);
    });
  }
  function missingFor(s) {
    const m = [];
    if (!s.name_pt) m.push("nombre PT"); if (!s.name_en) m.push("nombre EN");
    if (!s.service_type_id) m.push("tipo"); if (!s.zone_id) m.push("zona");
    return m;
  }

  /* ---------- formulario de proveedor ---------- */
  function providerForm(el) {
    const P = state.prov, isNew = P.edit === "new";
    const p = isNew ? null : provById(P.edit); if (!isNew && !p) { P.edit = null; el.innerHTML = ""; return; }
    const ed = can("editarProveedores"), dis = ed ? "" : "disabled";
    const v = p || { currency: "USD", active: true };
    const methods = Array.from(new Set(state.paymentMethods.map(m => m.name).concat(["Zelle", "Transferencia bancaria", "Efectivo", "Tarjeta", "Pix"])));
    const nSvc = isNew ? 0 : offersOfProvider(p.id).filter(o => o.active).length;
    el.innerHTML = `<div class="card form-card"><h3 class="t">${isNew ? "Nuevo proveedor" : esc(p.name)}${!isNew && !p.active ? ' <span class="st no_cerrado">inactivo</span>' : ""}<button class="x" type="button" id="pfClose" title="Cerrar">×</button></h3>
      <form id="provForm" class="pad">
        <div class="grid2">
          <div class="field"><label>Nombre de la empresa *</label><input name="name" required value="${esc(v.name || "")}" ${dis} placeholder="Ej.: Everglades Holiday Park"></div>
          <div class="field"><label>Moneda en que cobra</label><select name="currency" ${dis}><option value="USD" ${v.currency === "USD" ? "selected" : ""}>Dólares (USD)</option><option value="BRL" ${v.currency === "BRL" ? "selected" : ""}>Reales (BRL)</option></select></div>
          <div class="field"><label>Forma de pago</label><input name="payment_method" list="pmList" value="${esc(v.payment_method || "")}" ${dis} placeholder="Zelle, transferencia…"><datalist id="pmList">${methods.map(m => `<option value="${esc(m)}">`).join("")}</datalist></div>
          <div class="field"><label>Datos de pago</label><input name="payment_details" value="${esc(v.payment_details || "")}" ${dis} placeholder="Banco, cuenta, mail de Zelle…"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Condiciones</label><textarea name="conditions" rows="2" ${dis} placeholder="Seña, cancelación, plazo de pago…">${esc(v.conditions || "")}</textarea></div>
          <div class="field"><label>Notas internas</label><textarea name="notes" rows="2" ${dis}>${esc(v.notes || "")}</textarea></div>
        </div>
        ${isNew ? "" : `<div class="meta">Último cambio: ${esc(userName(p.updated_by))} · ${fmtDateLong(p.updated_at)} · ${nSvc} servicio${nSvc === 1 ? "" : "s"} <button type="button" class="linkbtn" id="pfSvcs">ver sus servicios</button> · <button type="button" class="linkbtn" id="pfHist">ver historial</button></div>`}
        <div class="acts">${ed && !isNew ? `<button type="button" class="btn ghost ${p.active ? "danger" : ""}" id="provToggle">${p.active ? "Desactivar" : "Volver a activar"}</button>` : ""}<span class="grow"></span><button type="button" class="btn" id="pfCancel">${ed ? "Cancelar" : "Cerrar"}</button>${ed ? `<button class="btn primary" type="submit">${isNew ? "Crear proveedor" : "Guardar"}</button>` : ""}</div>
      </form><div id="pfHistBox"></div></div>`;
    const form = $("#provForm"); wireDirty(form);
    $("#pfClose").addEventListener("click", closeForm); $("#pfCancel").addEventListener("click", closeForm);
    if ($("#pfSvcs")) $("#pfSvcs").addEventListener("click", () => { if (P.dirty && !confirm("Hay cambios sin guardar. ¿Salir igual?")) return; P.tab = "svc"; P.edit = null; P.dirty = false; P.q = p.name; renderProv(); });
    if ($("#pfHist")) $("#pfHist").addEventListener("click", () => { $("#pfHistBox").className = "hist"; showHistory("#pfHistBox", "provider_id", p.id); });
    if (!ed) return;
    form.addEventListener("submit", async e => {
      e.preventDefault(); const f = e.target, t = k => f[k].value.trim() || null;
      const fields = { name: f.name.value.trim(), currency: f.currency.value, payment_method: t("payment_method"), payment_details: t("payment_details"), conditions: t("conditions"), notes: t("notes") };
      await saveAndRefresh(async () => { await db.saveRow("providers", p, fields); }, isNew ? "Proveedor creado." : "Guardado.", true);
    });
    if ($("#provToggle")) $("#provToggle").addEventListener("click", async () => {
      if (p.active && !confirm("¿Desactivar " + p.name + "? No se borra nada: deja de aparecer para armar itinerarios nuevos.")) return;
      await saveAndRefresh(async () => { await db.saveRow("providers", p, { active: !p.active }); }, p.active ? "Proveedor desactivado." : "Proveedor activado.", true);
    });
  }

  /* ---------- formulario de servicio (siempre con su proveedor) ---------- */
  function serviceForm(el) {
    const P = state.prov, isNew = P.edit === "new";
    const o = isNew ? null : state.cat.offers.find(x => x.id === P.edit); if (!isNew && !o) { P.edit = null; el.innerHTML = ""; return; }
    const s = o ? svcById(o.service_id) : null, p = o ? provById(o.provider_id) : null;
    const ed = can("editarProveedores"), dis = ed ? "" : "disabled";
    const v = s || {};
    const pr = o ? (priceOf(o.id, P.month) || {}) : {};
    const val = x => x == null ? "" : String(Number(x));
    const provs = state.cat.providers.filter(x => x.active).sort((a, b) => a.name.localeCompare(b.name, "es"));
    const opt = (list, cur) => `<option value="">—</option>` + list.filter(x => x.active || x.id === cur).map(x => `<option value="${x.id}" ${x.id === cur ? "selected" : ""}>${esc(x.name)}</option>`).join("");
    const shared = o ? offersOfService(s.id).filter(x => x.active && x.id !== o.id).length : 0;
    if (isNew && !provs.length) { el.innerHTML = `<div class="card form-card"><div class="placeholder" style="border:0"><b>Primero cargá un proveedor</b>Cada servicio pertenece a un proveedor. Andá a la pestaña Proveedores y tocá “+ Nuevo proveedor”.</div></div>`; return; }
    el.innerHTML = `<div class="card form-card"><h3 class="t">${isNew ? "Nuevo servicio" : esc(s.name_es) + ` <small class="muted">· ${esc(p.name)}</small>`}${o && !o.active ? ' <span class="st no_cerrado">ya no lo ofrece</span>' : ""}<button class="x" type="button" id="sfClose" title="Cerrar">×</button></h3>
      <form id="svcForm" class="pad">
        <div class="grid2">
          <div class="field"><label>Proveedor *</label>${isNew ? `<select name="provider_id" required ${dis}><option value="">Elegí el proveedor…</option>${provs.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select>` : `<input value="${esc(p.name)}" disabled><span class="help">El proveedor no se cambia; si es otro, cargá el servicio de nuevo con ese proveedor.</span>`}</div>
          <div class="field"><label>Nombre del servicio (español) *</label><input name="name_es" required value="${esc(v.name_es || "")}" ${dis} list="svcNames" autocomplete="off" placeholder="Ej.: Everglades en airboat"><datalist id="svcNames">${state.cat.services.map(x => `<option value="${esc(x.name_es)}">`).join("")}</datalist><span class="help" id="sfSame"></span></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Nombre en portugués</label><input name="name_pt" value="${esc(v.name_pt || "")}" ${dis} placeholder="Lo que lee un cliente de Brasil"></div>
          <div class="field"><label>Nombre en inglés</label><input name="name_en" value="${esc(v.name_en || "")}" ${dis}></div>
        </div>
        <div class="grid4">
          <div class="field"><label>Tipo</label><select name="service_type_id" ${dis}>${opt(state.serviceTypes, v.service_type_id)}</select></div>
          <div class="field"><label>Zona</label><select name="zone_id" ${dis}>${opt(state.zones, v.zone_id)}</select></div>
          <div class="field"><label>Horario sugerido</label><input name="default_time" type="time" value="${esc(v.default_time || "")}" ${dis}></div>
          <div class="field"><label>Duración</label><input name="duration" value="${esc(v.duration || "")}" placeholder="4 h, día completo…" ${dis}></div>
        </div>
        <div class="vals"><div class="vals-h"><b>Valores de ${esc(periodLabel(P.month))}</b> <span class="muted">· USD por persona</span>${o ? ` <button type="button" class="linkbtn" id="sfMonths">ver / cargar otros meses</button>` : ""}</div>
          <div class="grid4">
            <div class="field"><label>Público adulto</label><input name="pa" inputmode="decimal" value="${val(pr.public_adult)}" ${dis}></div>
            <div class="field"><label>Público menor</label><input name="pm" inputmode="decimal" value="${val(pr.public_minor)}" ${dis}></div>
            <div class="field"><label>Agencia adulto</label><input name="aa" inputmode="decimal" value="${val(pr.agency_adult)}" ${dis}></div>
            <div class="field"><label>Agencia menor</label><input name="am" inputmode="decimal" value="${val(pr.agency_minor)}" ${dis}></div>
          </div>
          <div class="vals-f"><span id="sfGain"></span>${ed ? `<label class="toggle"><input type="checkbox" name="all_year"> usar estos valores en los meses vacíos de ${P.month.slice(0, 4)}</label>` : ""}</div>
        </div>
        <details ${v.desc_es || v.desc_pt || v.desc_en || v.notes ? "open" : ""}><summary>Descripción para el cliente y notas internas (opcional)</summary>
          <div class="grid3" style="margin-top:10px">
            <div class="field"><label>Descripción en español</label><textarea name="desc_es" rows="2" ${dis}>${esc(v.desc_es || "")}</textarea></div>
            <div class="field"><label>En portugués</label><textarea name="desc_pt" rows="2" ${dis}>${esc(v.desc_pt || "")}</textarea></div>
            <div class="field"><label>En inglés</label><textarea name="desc_en" rows="2" ${dis}>${esc(v.desc_en || "")}</textarea></div>
          </div>
          <div class="field"><label>Notas internas</label><textarea name="notes" rows="2" ${dis}>${esc(v.notes || "")}</textarea></div>
        </details>
        ${shared ? `<div class="meta">Nombre, tipo, zona y descripción son del servicio: si los cambiás, se cambian también para ${shared === 1 ? "el otro proveedor" : "los otros " + shared + " proveedores"} que lo ofrecen.</div>` : ""}
        ${o ? `<div class="meta">Último cambio: ${esc(userName(s.updated_by))} · ${fmtDateLong(s.updated_at)} · <button type="button" class="linkbtn" id="sfHist">ver historial</button></div>` : ""}
        <div class="acts">${ed && o ? `<button type="button" class="btn ghost ${o.active ? "danger" : ""}" id="offToggle2">${o.active ? "Ya no lo ofrece" : "Lo vuelve a ofrecer"}</button>` : ""}<span class="grow"></span><button type="button" class="btn" id="sfCancel">${ed ? "Cancelar" : "Cerrar"}</button>${ed ? `<button class="btn primary" type="submit">${isNew ? "Crear servicio" : "Guardar"}</button>` : ""}</div>
      </form><div id="sfHistBox"></div></div>`;
    const form = $("#svcForm"); wireDirty(form);
    const gain = () => {
      const pa = numOrNull(form.pa.value), aa = numOrNull(form.aa.value), pm = numOrNull(form.pm.value), am = numOrNull(form.am.value);
      $("#sfGain").innerHTML = pa != null && aa != null && !isNaN(pa) && !isNaN(aa) ? "Ganancia por adulto: " + marginHTML(pa, aa).replace('<span class="sub">', " · ").replace("</span>", "") : "";
      form.aa.classList.toggle("warnbox", pa != null && aa != null && aa > pa); form.am.classList.toggle("warnbox", pm != null && am != null && am > pm);
    };
    gain(); form.addEventListener("input", gain);
    $("#sfClose").addEventListener("click", closeForm); $("#sfCancel").addEventListener("click", closeForm);
    if ($("#sfMonths")) $("#sfMonths").addEventListener("click", () => pricesModal(o));
    if ($("#sfHist")) $("#sfHist").addEventListener("click", () => { $("#sfHistBox").className = "hist"; showHistory("#sfHistBox", "service_id", s.id); });
    // si escriben un servicio que ya existe (lo ofrece otro proveedor), se reutiliza y se completan sus datos
    if (isNew) form.name_es.addEventListener("change", () => {
      const ex = state.cat.services.find(x => x.name_es.trim().toLowerCase() === form.name_es.value.trim().toLowerCase());
      $("#sfSame").textContent = ex ? "Este servicio ya existe con otro proveedor: se usan sus mismos datos y se le suma este proveedor." : "";
      if (ex) ["name_pt", "name_en", "service_type_id", "zone_id", "default_time", "duration", "desc_es", "desc_pt", "desc_en"].forEach(k => { if (!form[k].value && ex[k]) form[k].value = ex[k]; });
    });
    if (!ed) return;
    if ($("#offToggle2")) $("#offToggle2").addEventListener("click", async () => {
      if (o.active && !confirm("¿Marcar que " + p.name + " ya no ofrece " + s.name_es + "? No se borra nada.")) return;
      await saveAndRefresh(async () => { await db.saveRow("provider_services", o, { active: !o.active }); }, o.active ? "Listo: ya no lo ofrece." : "Lo vuelve a ofrecer.", true);
    });
    form.addEventListener("submit", async e => {
      e.preventDefault(); const f = e.target, t = k => f[k].value.trim() || null;
      const vals = {};
      for (const [n, col] of [["pa", "public_adult"], ["pm", "public_minor"], ["aa", "agency_adult"], ["am", "agency_minor"]]) {
        const x = numOrNull(f[n].value); if (Number.isNaN(x)) { toast("Hay un valor que no es un número.", "bad"); f[n].focus(); return; } vals[col] = x;
      }
      const svcFields = { name_es: f.name_es.value.trim(), name_pt: t("name_pt"), name_en: t("name_en"), service_type_id: f.service_type_id.value || null, zone_id: f.zone_id.value || null, default_time: t("default_time"), duration: t("duration"), desc_es: t("desc_es"), desc_pt: t("desc_pt"), desc_en: t("desc_en"), notes: t("notes") };
      const allYear = f.all_year && f.all_year.checked;
      const btn = $("button[type=submit]", f); btn.disabled = true;
      await saveAndRefresh(async () => {
        let offer = o, svc = s;
        if (isNew) {
          const pid = f.provider_id.value; if (!pid) throw new Error("Elegí el proveedor.");
          svc = state.cat.services.find(x => x.name_es.trim().toLowerCase() === svcFields.name_es.toLowerCase()) || null;
          if (svc) {           // ya existe: solo completo lo que estaba vacío (nunca piso lo que cargó otro)
            const fill = {}; Object.keys(svcFields).forEach(k => { if (svcFields[k] != null && (svc[k] == null || svc[k] === "")) fill[k] = svcFields[k]; });
            if (!svc.active) fill.active = true;
            if (Object.keys(fill).length) svc = await db.saveRow("services", svc, fill);
          } else svc = await db.saveRow("services", null, svcFields);
          const prev = state.cat.offers.find(x => x.provider_id === pid && x.service_id === svc.id);
          if (prev && prev.active) throw new Error("Ese proveedor ya tiene ese servicio cargado. Buscalo en la lista para editarlo.");
          offer = prev ? await db.saveRow("provider_services", prev, { active: true }) : await db.saveRow("provider_services", null, { provider_id: pid, service_id: svc.id });
        } else {
          await db.saveRow("services", s, svcFields);
        }
        await savePrices(offer.id, P.month, vals, allYear);
        state.prov.edit = isNew ? null : offer.id;
      }, isNew ? "Servicio creado." : "Guardado.", isNew);
      if ($("#svcForm button[type=submit]")) $("#svcForm button[type=submit]").disabled = false;
    });
  }
  // guarda los valores del mes elegido (y, si se pide, los copia a los meses vacíos del año)
  async function savePrices(offerId, ym, vals, allYear) {
    const empty = Object.values(vals).every(x => x == null);
    const months = allYear && !empty ? Array.from({ length: 12 }, (_, i) => ym.slice(0, 4) + "-" + pad(i + 1)) : [ym];
    for (const m of months) {
      const orig = priceOf(offerId, m);
      if (m !== ym && orig && ["public_adult", "public_minor", "agency_adult", "agency_minor"].some(k => orig[k] != null)) continue;   // no pisar meses ya cargados
      if (!orig && empty) continue;
      if (orig && Object.keys(vals).every(k => sameVal(vals[k], orig[k]))) continue;
      await db.saveRow("offer_prices", orig, orig ? vals : Object.assign({ offer_id: offerId, month: monthKey(m) }, vals));
    }
  }

  async function saveAndRefresh(fn, okMsg, closeAfter) {
    const P = state.prov;
    setSync("busy", "Guardando…");
    let ok = false;
    try { await fn(); ok = true; toast(okMsg, "ok"); }
    catch (err) { toast(catError(err), "bad"); }
    await db.loadCatalog().catch(() => { });
    setSync("ok", "");
    if (ok) { P.dirty = false; if (closeAfter) P.edit = null; }
    const keepForm = !ok && P.dirty;          // si falló, no borro lo que la persona escribió
    if (state.view === "prov") {
      const tabs = $("#pvTabs");
      if (tabs) { const nO = state.cat.offers.filter(o => o.active && (svcById(o.service_id) || {}).active !== false).length; tabs.querySelector('[data-t=prov] span').textContent = state.cat.providers.filter(x => x.active).length; tabs.querySelector('[data-t=svc] span').textContent = nO; }
      if (!keepForm) renderPvDetail();
      renderPvList();
    }
  }

  function pricesModal(o, year) {
    const P = state.prov, ed = can("editarProveedores");
    const s = svcById(o.service_id), p = provById(o.provider_id);
    const y = year || +P.month.slice(0, 4);
    const months = Array.from({ length: 12 }, (_, i) => y + "-" + pad(i + 1));
    const dis = ed ? "" : "disabled";
    const val = x => x == null ? "" : String(Number(x));
    openModal(`<h3>${esc(svcName(s))} · ${esc(p ? p.name : "")}</h3>
      <p>Valores en USD por persona. Dejá vacío el mes que no tenga valor.</p>
      <div class="row-y"><button class="btn sm" id="yPrev">← ${y - 1}</button><b>${y}</b><button class="btn sm" id="yNext">${y + 1} →</button></div>
      <form id="prForm"><div class="tablewrap"><table class="money prices">
        <thead><tr><th rowspan="2">Mes</th><th colspan="2" class="c">Público</th><th colspan="2" class="c">Agencia</th><th rowspan="2" class="r">Ganancia<br>adulto</th></tr>
        <tr><th>Adulto</th><th>Menor</th><th>Adulto</th><th>Menor</th></tr></thead>
        <tbody>${months.map((ym, i) => { const r = priceOf(o.id, ym) || {}; return `<tr data-ym="${ym}"><td>${MESES[i].slice(0, 3)}</td>
          <td><input inputmode="decimal" name="pa" value="${val(r.public_adult)}" ${dis}></td><td><input inputmode="decimal" name="pm" value="${val(r.public_minor)}" ${dis}></td>
          <td><input inputmode="decimal" name="aa" value="${val(r.agency_adult)}" ${dis}></td><td><input inputmode="decimal" name="am" value="${val(r.agency_minor)}" ${dis}></td>
          <td class="r g"></td></tr>`; }).join("")}</tbody></table></div>
        ${ed ? `<div class="acts" style="justify-content:space-between;flex-wrap:wrap"><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn sm" id="prFill">Repetir el primer mes en los vacíos</button><button type="button" class="btn sm ghost ${o.active ? "danger" : ""}" id="offToggle">${o.active ? "Ya no lo ofrece" : "Lo vuelve a ofrecer"}</button></div><div style="display:flex;gap:8px"><button type="button" class="btn" id="mCancel">Cancelar</button><button type="submit" class="btn primary">Guardar valores</button></div></div>` : `<div class="acts"><button type="button" class="btn" id="mCancel">Cerrar</button></div>`}
      </form>`);
    $("#modal .box").classList.add("wide");
    const form = $("#prForm");
    const calc = () => $$("tbody tr", form).forEach(tr => {
      const pa = numOrNull($("[name=pa]", tr).value), aa = numOrNull($("[name=aa]", tr).value), pm = numOrNull($("[name=pm]", tr).value), am = numOrNull($("[name=am]", tr).value);
      $(".g", tr).innerHTML = pa != null && aa != null && !isNaN(pa) && !isNaN(aa) ? marginHTML(pa, aa) : "";
      $("[name=aa]", tr).classList.toggle("warnbox", pa != null && aa != null && aa > pa);
      $("[name=am]", tr).classList.toggle("warnbox", pm != null && am != null && am > pm);
    });
    calc(); form.addEventListener("input", calc);
    $("#mCancel").addEventListener("click", closeModal);
    $("#yPrev").addEventListener("click", () => pricesModal(o, y - 1));
    $("#yNext").addEventListener("click", () => pricesModal(o, y + 1));
    if (!ed) return;
    $("#prFill").addEventListener("click", () => {
      const rows = $$("tbody tr", form), src = rows.find(tr => ["pa", "pm", "aa", "am"].some(n => $(`[name=${n}]`, tr).value.trim() !== ""));
      if (!src) return toast("Cargá primero un mes.", "bad");
      rows.forEach(tr => { if (["pa", "pm", "aa", "am"].every(n => $(`[name=${n}]`, tr).value.trim() === "")) ["pa", "pm", "aa", "am"].forEach(n => { $(`[name=${n}]`, tr).value = $(`[name=${n}]`, src).value; }); });
      calc();
    });
    $("#offToggle").addEventListener("click", async () => {
      try { await db.saveRow("provider_services", o, { active: !o.active }); await db.loadCatalog(); closeModal(); renderPvList(); renderPvDetail(); toast(o.active ? "Marcado como que ya no lo ofrece." : "Lo vuelve a ofrecer.", "ok"); }
      catch (err) { toast(catError(err), "bad"); if (err.conflict) { await db.loadCatalog(); closeModal(); renderPvDetail(); } }
    });
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const todo = [];
      for (const tr of $$("tbody tr", form)) {
        const ym = tr.dataset.ym, vals = {};
        for (const [n, col] of [["pa", "public_adult"], ["pm", "public_minor"], ["aa", "agency_adult"], ["am", "agency_minor"]]) {
          const x = numOrNull($(`[name=${n}]`, tr).value);
          if (Number.isNaN(x)) { toast("Hay un valor que no es un número (" + MESES[+ym.slice(5) - 1] + ").", "bad"); return; }
          vals[col] = x;
        }
        const orig = priceOf(o.id, ym);
        const empty = Object.values(vals).every(x => x == null);
        if (!orig && empty) continue;
        if (orig && Object.keys(vals).every(k => sameVal(vals[k], orig[k]))) continue;
        todo.push({ orig, fields: orig ? vals : Object.assign({ offer_id: o.id, month: monthKey(ym) }, vals) });
      }
      if (!todo.length) { closeModal(); return toast("No había cambios."); }
      const btn = $("button[type=submit]", form); btn.disabled = true; setSync("busy", "Guardando…");
      let ok = 0;
      try {
        for (const t of todo) { await db.saveRow("offer_prices", t.orig, t.fields); ok++; }
        toast(ok === 1 ? "Guardado 1 mes." : "Guardados " + ok + " meses.", "ok");
      } catch (err) { toast((ok ? "Se guardaron " + ok + " meses, pero " : "") + catError(err), "bad"); }
      setSync("ok", ""); await db.loadCatalog().catch(() => { }); closeModal(); renderPvList(); renderPvDetail();
    });
  }

  const AUDIT_LABELS = { name: "nombre", currency: "moneda", payment_method: "forma de pago", payment_details: "datos de pago", conditions: "condiciones", notes: "notas", active: "activo", name_es: "nombre ES", name_pt: "nombre PT", name_en: "nombre EN", desc_es: "descripción ES", desc_pt: "descripción PT", desc_en: "descripción EN", service_type_id: "tipo", zone_id: "zona", default_time: "horario", duration: "duración", public_adult: "público adulto", public_minor: "público menor", agency_adult: "agencia adulto", agency_minor: "agencia menor" };
  function auditVal(k, x) {
    if (x == null || x === "") return "—";
    if (k === "active") return x ? "sí" : "no";
    if (k === "service_type_id") return typeName(x) || "—";
    if (k === "zone_id") return zoneName(x) || "—";
    if (/^(public|agency)_/.test(k)) return money(x);
    return String(x);
  }
  async function showHistory(sel, col, id) {
    const el = $(sel); if (!el) return;
    el.innerHTML = `<h3 class="t">Historial</h3><div class="empty">Cargando…</div>`;
    let ev; try { ev = await db.auditFor(col, id); } catch (err) { el.innerHTML = `<h3 class="t">Historial</h3><div class="note">${esc(explainError(err))}</div>`; return; }
    const what = e => {
      if (e.table_name === "offer_prices") { const o = state.cat.offers.find(x => x.id === (e.detail.offer_id || "")) || null; const pr = state.cat.prices.find(x => x.id === e.row_id); const off = o || (pr && state.cat.offers.find(x => x.id === pr.offer_id)); const m = (e.detail.month || (pr && pr.month) || ""); return "valores " + (m ? periodLabel(m.slice(0, 7)) : "") + (off ? " · " + (col === "provider_id" ? svcName(svcById(off.service_id)) : (provById(off.provider_id) || {}).name || "") : ""); }
      if (e.table_name === "provider_services") { const o = state.cat.offers.find(x => x.id === e.row_id); return o ? (col === "provider_id" ? "experiencia " + svcName(svcById(o.service_id)) : "proveedor " + ((provById(o.provider_id) || {}).name || "")) : "experiencia"; }
      return "";
    };
    const line = e => {
      const who = `<b>${esc(userName(e.by_user))}</b>`, w = what(e);
      if (e.action === "creado") return `${who} creó ${w ? esc(w) : "la ficha"}`;
      const parts = Object.entries(e.detail || {}).map(([k, v]) => `${esc(AUDIT_LABELS[k] || k)}: ${esc(auditVal(k, v.de))} → <b>${esc(auditVal(k, v.a))}</b>`);
      return `${who}${w ? " · " + esc(w) : ""} · ${parts.join(" · ")}`;
    };
    el.innerHTML = `<h3 class="t">Historial</h3>${ev.length ? `<ul class="list">${ev.map(e => `<li><div class="grow">${line(e)}</div><small class="nowrap">${fmtDateLong(e.at)}</small></li>`).join("")}</ul>` : `<div class="empty">Sin cambios registrados.</div>`}<div class="note">Lo registra la base de datos sola, con quién y cuándo. No se puede editar.</div>`;
  }

  /* ==========================================================================
     6b. ADMINISTRACIÓN
     ========================================================================== */
  const PERMS = [
    ["Acta de clientes", "y", "y", "y", "r"], ["Itinerarios", "y", "y", "y", "r"], ["Banco de reservas", "y", "y", "y", "r"],
    ["Proveedores y servicios", "y", "n", "y", "r"], ["Logística", "y", "r", "y", "y"], ["Choferes y flota", "y", "n", "y", "y"], ["Financiero", "y", "n", "n", "y"],
    ["Cobranzas", "y", "n", "n", "n"], ["Estadísticas", "y", "r", "n", "n"], ["Administración", "y", "n", "n", "n"]
  ];
  async function renderAdmin() {
    if (!can("admin")) { $("#content").innerHTML = `<div class="placeholder"><b>Solo dirección</b></div>`; return; }
    const c = $("#content");
    c.innerHTML = `<div class="two">
      <div class="stack">
        <div class="card" id="usersCard"></div>
        <div class="card"><h3 class="t">Qué puede hacer cada rol</h3>
          <div class="perm"><div class="h">Módulo</div><div class="h">Dirección</div><div class="h">Ventas</div><div class="h">Operac.</div><div class="h">Financ.</div>
          ${PERMS.map(r => `<div>${r[0]}</div>` + r.slice(1).map(x => `<div class="${x}">${x === "y" ? "✓" : x === "r" ? "ver" : "—"}</div>`).join("")).join("")}</div>
          <div class="note">"ver" = puede mirar pero no cambiar. Estas reglas viven en la base de datos (RLS), no solo en la pantalla. Los choferes se agregan en la etapa 8.</div></div>
      </div>
      <div class="stack">
        <div class="card" id="zonesCard"></div>
        <div class="card" id="typesCard"></div>
        <div class="card" id="methodsCard"></div>
        <div class="card" id="settingsCard"></div>
        <div class="card" id="systemCard"></div>
      </div></div>`;
    renderUsersCard(); renderListCard("zonesCard", "zones", "Zonas de Miami", state.zones, "Se usan para las tarifas de choferes y para sugerir la zona de cada servicio en Logística.");
    renderListCard("typesCard", "service_types", "Tipos de servicio", state.serviceTypes, "Clasifican los servicios de los proveedores (etapa 3).");
    renderMethodsCard(); renderSettingsCard(); renderSystemCard();
  }

  function renderUsersCard() {
    const el = $("#usersCard"); if (!el) return;
    el.innerHTML = `<h3 class="t">Usuarios <button class="btn sm gold" id="btnNewUser">+ Nuevo usuario</button></h3>
      <ul class="list">${state.users.map(u => `<li class="${u.active ? "" : "off"}" data-id="${u.id}"><div class="grow"><b>${esc(u.display_name)}</b><small> · ${esc(u.username)}${u.id === state.me.id ? " · sos vos" : ""}</small></div><span class="role ${u.role} ${u.active ? "" : "off"}">${esc(ROLES[u.role] || u.role)}${u.active ? "" : " · inactivo"}</span><button class="btn sm" data-act="edit">Editar</button>${u.id === state.me.id ? "" : `<button class="btn sm" data-act="toggle">${u.active ? "Desactivar" : "Activar"}</button>`}</li>`).join("")}</ul>
      <div class="note">Al crear un usuario acá se crea también su acceso real (usuario y contraseña). Si alguien olvida la contraseña, dirección la reinicia desde el panel de Supabase → Authentication → Users → "…" → Reset password (o le manda una nueva desde "Send password recovery"); ver la guía.</div>`;
    $("#btnNewUser").addEventListener("click", () => userModal(null));
    el.querySelector("ul").addEventListener("click", async e => {
      const b = e.target.closest("button[data-act]"); if (!b) return;
      const u = state.users.find(x => x.id === b.closest("li").dataset.id);
      if (b.dataset.act === "edit") return userModal(u);
      try { const saved = await db.updateUser(u.id, { active: !u.active }); Object.assign(u, saved); renderUsersCard(); toast(saved.active ? "Usuario activado." : "Usuario desactivado.", "ok"); } catch (err) { toast(explainError(err), "bad"); }
    });
  }
  function userModal(u) {
    const isNew = !u;
    openModal(`<h3>${isNew ? "Nuevo usuario" : "Editar usuario"}</h3><p>${isNew ? "Se crea el acceso y queda activo enseguida." : "El nombre de usuario no se puede cambiar."}</p>
      <form id="uForm">
        <div class="grid2">
          <div class="field"><label>Usuario (para entrar)</label><input name="username" value="${esc(u ? u.username : "")}" ${isNew ? 'required pattern="[a-zA-Z0-9._\\-]{3,}" placeholder="carla"' : "disabled"}><span class="help">Letras, números, punto o guion. Sin espacios.</span></div>
          <div class="field"><label>Nombre que se muestra</label><input name="display_name" value="${esc(u ? u.display_name : "")}" required placeholder="Carla"></div>
          <div class="field"><label>Rol</label><select name="role">${Object.entries(ROLES).filter(([k]) => k !== "chofer").map(([k, v]) => `<option value="${k}" ${u && u.role === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
          ${isNew ? `<div class="field"><label>Contraseña inicial</label><input name="password" type="text" required minlength="${PASSWORD_MIN}" placeholder="mínimo ${PASSWORD_MIN} caracteres"><span class="help">Pasásela a la persona por un canal privado; la puede cambiar desde "mi usuario".</span></div>` : ""}
        </div>
        <div class="acts"><button type="button" class="btn" id="mCancel">Cancelar</button><button type="submit" class="btn primary">${isNew ? "Crear usuario" : "Guardar"}</button></div>
      </form>`);
    $("#mCancel").addEventListener("click", closeModal);
    $("#uForm").addEventListener("submit", async e => {
      e.preventDefault(); const f = e.target; const btn = $("button[type=submit]", f); btn.disabled = true;
      try {
        if (isNew) { await db.createUser({ username: f.username.value, display_name: f.display_name.value.trim(), role: f.role.value, password: f.password.value }); toast("Usuario creado y activado.", "ok"); }
        else { const saved = await db.updateUser(u.id, { display_name: f.display_name.value.trim(), role: f.role.value }); Object.assign(u, saved); toast("Guardado.", "ok"); }
        await db.loadBase(); closeModal(); renderUsersCard();
      } catch (err) { toast(explainError(err), "bad"); btn.disabled = false; }
    });
  }

  function renderListCard(elId, table, title, list, note) {
    const el = $("#" + elId); if (!el) return;
    el.innerHTML = `<h3 class="t">${title}</h3>
      <ul class="list">${list.map(z => `<li class="${z.active ? "" : "off"}" data-id="${z.id}"><div class="grow"><b>${esc(z.name)}</b>${z.detail ? `<small> · ${esc(z.detail)}</small>` : ""}</div><button class="btn sm" data-act="edit">✎</button><button class="btn sm" data-act="toggle">${z.active ? "Ocultar" : "Mostrar"}</button></li>`).join("") || `<li class="muted">Sin datos.</li>`}</ul>
      <form class="inline-form" id="${elId}Form"><input name="name" placeholder="Nombre" required><input name="detail" placeholder="Detalle (opcional)"><button class="btn sm gold" type="submit">+ Agregar</button></form>
      ${note ? `<div class="note">${note}</div>` : ""}`;
    const reload = async () => { await db.loadBase(); renderListCard(elId, table, title, table === "zones" ? state.zones : state.serviceTypes, note); };
    $("#" + elId + "Form").addEventListener("submit", async e => {
      e.preventDefault(); const f = e.target;
      try { await db.upsertConfig(table, { name: f.name.value.trim(), detail: f.detail.value.trim() || null, sort_order: list.length + 1 }); toast("Agregado.", "ok"); await reload(); } catch (err) { toast(explainError(err), "bad"); }
    });
    el.querySelector("ul").addEventListener("click", async e => {
      const b = e.target.closest("button[data-act]"); if (!b) return;
      const z = list.find(x => x.id === b.closest("li").dataset.id);
      try {
        if (b.dataset.act === "toggle") { await db.upsertConfig(table, { id: z.id, active: !z.active }); }
        else { const name = prompt("Nombre", z.name); if (name == null) return; const detail = prompt("Detalle", z.detail || ""); if (detail == null) return; await db.upsertConfig(table, { id: z.id, name: name.trim(), detail: detail.trim() || null }); }
        await reload();
      } catch (err) { toast(explainError(err), "bad"); }
    });
  }
  function renderMethodsCard() {
    const el = $("#methodsCard"); if (!el) return;
    el.innerHTML = `<h3 class="t">Medios de pago</h3>
      <ul class="list">${state.paymentMethods.map(m => `<li class="${m.active ? "" : "off"}" data-id="${m.id}"><div class="grow"><b>${esc(m.name)}</b><small> · ${m.currency}${+m.fee_pct ? " · comisión " + m.fee_pct + " %" : ""}</small></div><button class="btn sm" data-act="edit">✎</button><button class="btn sm" data-act="toggle">${m.active ? "Ocultar" : "Mostrar"}</button></li>`).join("")}</ul>
      <form class="inline-form" id="mForm"><input name="name" placeholder="Nombre" required><select name="currency"><option value="USD">USD</option><option value="BRL">BRL</option></select><input name="fee_pct" type="number" step="0.01" min="0" placeholder="% comisión" style="flex:0 1 110px"><button class="btn sm gold" type="submit">+ Agregar</button></form>`;
    const reload = async () => { await db.loadBase(); renderMethodsCard(); };
    $("#mForm").addEventListener("submit", async e => {
      e.preventDefault(); const f = e.target;
      try { await db.upsertConfig("payment_methods", { name: f.name.value.trim(), currency: f.currency.value, fee_pct: +f.fee_pct.value || 0, sort_order: state.paymentMethods.length + 1 }); toast("Agregado.", "ok"); await reload(); } catch (err) { toast(explainError(err), "bad"); }
    });
    el.querySelector("ul").addEventListener("click", async e => {
      const b = e.target.closest("button[data-act]"); if (!b) return;
      const m = state.paymentMethods.find(x => x.id === b.closest("li").dataset.id);
      try {
        if (b.dataset.act === "toggle") await db.upsertConfig("payment_methods", { id: m.id, active: !m.active });
        else { const name = prompt("Nombre", m.name); if (name == null) return; const fee = prompt("Comisión %", m.fee_pct); if (fee == null) return; await db.upsertConfig("payment_methods", { id: m.id, name: name.trim(), fee_pct: +fee || 0 }); }
        await reload();
      } catch (err) { toast(explainError(err), "bad"); }
    });
  }
  function renderSettingsCard() {
    const el = $("#settingsCard"); if (!el) return;
    const s = state.settings;
    el.innerHTML = `<h3 class="t">Moneda e idioma</h3>
      <ul class="list">
        <li><div class="grow">Moneda de cotización</div><b>${esc(s.quote_currency || "USD")}</b></li>
        <li><div class="grow">Cotización de referencia (reales por dólar)</div><b id="fxVal">${esc(s.fx_brl_usd)}</b><button class="btn sm" id="btnFx">✎</button></li>
        <li><div class="grow">Idioma al pasajero</div><b>${s.passenger_language === "pt" ? "Portugués" : esc(s.passenger_language)}</b></li>
      </ul>`;
    $("#btnFx").addEventListener("click", async () => {
      const v = prompt("Cotización de referencia (reales por dólar)", s.fx_brl_usd); if (v == null) return;
      const n = parseFloat(String(v).replace(",", ".")); if (!(n > 0)) return toast("Poné un número mayor a 0.", "bad");
      try { await db.setSetting("fx_brl_usd", n); renderSettingsCard(); toast("Cotización guardada.", "ok"); } catch (err) { toast(explainError(err), "bad"); }
    });
  }
  async function renderSystemCard() {
    const el = $("#systemCard"); if (!el) return;
    el.innerHTML = `<h3 class="t">Sistema</h3><div class="empty">Cargando…</div>`;
    let backups = [], ledger = null;
    try { [backups, ledger] = await Promise.all([db.backups(), db.ledgerCount()]); } catch (err) { el.innerHTML = `<h3 class="t">Sistema</h3><div class="note">${esc(explainError(err))}</div>`; return; }
    if (!el.isConnected) return;   // el usuario cambió de pantalla mientras cargaba
    el.innerHTML = `<h3 class="t">Sistema <button class="btn sm" id="btnBackup">Hacer backup ahora</button></h3>
      <ul class="list">
        <li><div class="grow">Versión publicada (la que exige la base)</div><b>${esc(state.remoteVersion || "?")}</b><button class="btn sm" id="btnVer">✎</button></li>
        <li><div class="grow">Versión de esta pestaña</div><b>${APP_VERSION}</b></li>
        <li><div class="grow">Libro de movimientos de dinero</div><small>${ledger == null ? "—" : ledger + " asientos"}</small></li>
      </ul>
      <h3 class="t" style="border-top:1px solid var(--line)">Backups guardados</h3>
      <ul class="list" id="bkList">${backups.map(b => `<li data-id="${b.id}"><div class="grow"><b>${fmtDateLong(b.taken_at)}</b><small> · ${esc(b.note || "")} · ${Math.round((b.size_bytes || 0) / 1024)} KB</small></div><button class="btn sm" data-act="dl">Descargar</button><button class="btn sm" data-act="rs">Restaurar</button></li>`).join("") || `<li class="muted">Todavía no hay backups. El automático corre todos los días a las 04:00 (si pg_cron está activado).</li>`}</ul>
      <div class="note">Restaurar vuelve a poner los datos de ese momento por encima de los actuales; lo cargado después del backup no se pierde. Antes de restaurar se hace un backup automático del estado actual.</div>`;
    $("#btnBackup", el).addEventListener("click", async () => { try { await db.takeBackup(); toast("Backup hecho.", "ok"); renderSystemCard(); } catch (err) { toast(explainError(err), "bad"); } });
    $("#btnVer", el).addEventListener("click", async () => {
      const v = prompt("Versión publicada. Solo cambiala cuando subiste un app.js nuevo con ese número; todas las pestañas más viejas van a tener que recargar.", state.remoteVersion); if (v == null) return;
      if (!/^\d+\.\d+\.\d+$/.test(v.trim())) return toast("Formato: 1.0.0", "bad");
      try { await db.setSetting("app_version", v.trim()); await checkVersion(); renderSystemCard(); toast("Versión publicada actualizada.", "ok"); } catch (err) { toast(explainError(err), "bad"); }
    });
    $("#bkList", el).addEventListener("click", async e => {
      const b = e.target.closest("button[data-act]"); if (!b) return; const id = +b.closest("li").dataset.id;
      try {
        if (b.dataset.act === "dl") { const p = await db.backupPayload(id); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(p, null, 1)], { type: "application/json" })); a.download = "jeito-backup-" + id + ".json"; a.click(); }
        else { if (!confirm("¿Restaurar el backup " + id + "? Primero se guarda un backup del estado actual.")) return; await db.takeBackup(); const msg = await db.restoreBackup(id); let msg2 = ""; try { msg2 = await db.restoreCatalog(id); } catch (e2) { } toast(msg + (msg2 ? " · " + msg2 : ""), "ok"); state.cat = null; await db.loadClients(); await db.loadBase(); renderSystemCard(); }
      } catch (err) { toast(explainError(err), "bad"); }
    });
  }

  /* ---------- mi usuario ---------- */
  function renderPerfil() {
    $("#content").innerHTML = `<div class="card" style="max-width:520px"><h3 class="t">Mi usuario</h3>
      <ul class="list"><li><div class="grow">Usuario</div><b>${esc(state.me.username)}</b></li><li><div class="grow">Nombre</div><b>${esc(state.me.display_name)}</b></li><li><div class="grow">Rol</div><span class="role ${state.me.role}">${esc(ROLES[state.me.role])}</span></li></ul>
      <form class="inline-form" id="pwForm" style="flex-direction:column;align-items:stretch"><label class="muted" style="font-size:12px">Cambiar mi contraseña</label><input name="p1" type="password" minlength="${PASSWORD_MIN}" required autocomplete="new-password" placeholder="Nueva contraseña (mínimo ${PASSWORD_MIN})"><input name="p2" type="password" minlength="${PASSWORD_MIN}" required autocomplete="new-password" placeholder="Repetir"><span class="help" style="font-size:11.5px;color:var(--muted)">Consejo: una frase corta es fácil de recordar y difícil de adivinar (ej. "mate con medialunas 7").</span><button class="btn primary" type="submit">Cambiar</button></form></div>`;
    $("#pwForm").addEventListener("submit", async e => {
      e.preventDefault(); const f = e.target;
      if (f.p1.value.length < PASSWORD_MIN) return toast("La contraseña tiene que tener al menos " + PASSWORD_MIN + " caracteres.", "bad");
      if (f.p1.value !== f.p2.value) return toast("Las contraseñas no coinciden.", "bad");
      try { await db.changeMyPassword(f.p1.value); toast("Contraseña cambiada.", "ok"); f.reset(); state.weakPassword = false; renderBanner(); } catch (err) { toast(explainError(err), "bad"); }
    });
  }

  /* ---------- modal ---------- */
  function openModal(html) { closeModal(); const m = document.createElement("div"); m.className = "modal"; m.id = "modal"; m.innerHTML = `<div class="box">${html}</div>`; document.body.appendChild(m); }
  function closeModal() { const m = $("#modal"); if (m) m.remove(); }

  /* ---------- cierre de sesión por inactividad ---------- */
  let _lastWrite = 0;
  function readActivity() { try { return +localStorage.getItem(IDLE_KEY) || 0; } catch (e) { return state._lastActivity || 0; } }
  function touchActivity(force) {
    const now = Date.now();
    state._lastActivity = now;
    if (!force && now - _lastWrite < 30000) return;   // no escribir en cada movimiento
    _lastWrite = now;
    try { localStorage.setItem(IDLE_KEY, String(now)); } catch (e) { }
    hideIdleWarn();
  }
  function hideIdleWarn() { const w = $("#idleWarn"); if (w) w.remove(); }
  function showIdleWarn(msLeft) {
    let w = $("#idleWarn");
    if (!w) { w = document.createElement("div"); w.id = "idleWarn"; w.className = "idle-warn"; document.body.appendChild(w); }
    const min = Math.max(1, Math.ceil(msLeft / 60000));
    w.innerHTML = `<span>🔒 Por seguridad, la sesión se cierra en <b>${min} min</b> porque no se está usando.</span> <button class="btn sm gold" type="button">Seguir conectado</button>`;
    w.querySelector("button").onclick = () => touchActivity(true);
  }
  function idleCheck() {
    if (!state.session) return;
    const last = Math.max(readActivity(), state._lastActivity || 0);
    if (!last) { touchActivity(true); return; }
    const idle = Date.now() - last;
    if (idle >= IDLE_MS) { clearInterval(state.idleTimer); logout("Por seguridad, la sesión se cerró porque no se usó por " + Math.round(IDLE_MS / 3600000) + " horas. Volvé a entrar."); return; }
    if (idle >= IDLE_MS - IDLE_WARN_MS) showIdleWarn(IDLE_MS - idle); else hideIdleWarn();
  }
  function startIdleWatch() {
    if (state.idleWired) return; state.idleWired = true;
    ["pointerdown", "keydown", "touchstart", "wheel"].forEach(ev => document.addEventListener(ev, () => { if (state.session) touchActivity(); }, { passive: true, capture: true }));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) idleCheck(); });
    clearInterval(state.idleTimer); state.idleTimer = setInterval(idleCheck, 30000);
  }

  /* ==========================================================================
     7. ARRANQUE
     ========================================================================== */
  async function afterLogin() {
    setSync("busy", "Cargando…");
    try {
      await loadProfile();
      if (!state.me) { render(); return; }
      await db.loadBase();
      if (can("verClientes")) await db.loadClients();
      if (!can("verClientes")) state.view = can("admin") ? "admin" : "perfil";
      render();
      setSync("ok", "Conectado");
      clearInterval(state.versionTimer);
      state.versionTimer = setInterval(checkVersion, 60000);
    } catch (err) {
      $("#app").innerHTML = `<div class="splash"><div class="box"><h3>No se pudo cargar el sistema</h3><p>${esc(explainError(err))}</p><p class="muted" style="font-size:12px">Si es la primera vez: ¿corriste 01-modifica.sql en Supabase?</p><button class="btn" id="btnRetry">Reintentar</button> <button class="btn ghost" id="btnOut2">Salir</button></div></div>`;
      $("#btnRetry").addEventListener("click", afterLogin); $("#btnOut2").addEventListener("click", () => logout());
    }
  }
  async function boot() {
    // siempre por conexión segura (el candadito): si alguien entra por http, se pasa a https
    if (location.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { location.replace("https://" + location.host + location.pathname + location.search + location.hash); return; }
    if (!configOk() || !window.supabase) { render(); return; }
    const c = window.JEITO_CONFIG;
    state.supabase = window.supabase.createClient(cleanUrl(c.SUPABASE_URL), c.SUPABASE_ANON_KEY);
    const { data } = await state.supabase.auth.getSession();
    state.session = data.session || null;
    state.supabase.auth.onAuthStateChange((event, session) => {
      const had = !!state.session; state.session = session || null;
      if (event === "SIGNED_IN" && !had) afterLogin();
      if (event === "SIGNED_OUT") { state.me = null; render(); }
    });
    if (state.session) {
      const last = readActivity();
      if (last && Date.now() - last >= IDLE_MS) {           // quedó abierta y sin uso: se cierra
        state.loginNote = "Por seguridad, la sesión se cerró porque no se usó por " + Math.round(IDLE_MS / 3600000) + " horas. Volvé a entrar.";
        await state.supabase.auth.signOut(); state.session = null; render(); startIdleWatch(); return;
      }
      touchActivity(true); afterLogin();
    } else render();
    startIdleWatch();
  }
  // para pruebas y depuración desde la consola del navegador
  window.JEITO = { state, db, APP_VERSION, checkVersion, idleCheck };
  boot();
})();
