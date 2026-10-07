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
  const APP_VERSION = "1.4.0";

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
    verItinerarios:  ["direccion", "ventas", "operaciones", "operador_financiero"],
    editarItinerarios: ["direccion", "ventas", "operaciones"],
    verCostos:       ["direccion", "operaciones", "operador_financiero"],
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
    itin: { clientId: null, itinId: null, versions: [], detail: null, edit: null, dirty: false, token: null, list: null, filters: { q: "", status: "" }, catCache: {} },
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
    state.session = null; state.me = null; state.clients = []; state.cat = null; state.itin.clientId = null; state.itin.list = null; state.itin.dirty = false;
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
    { id: "itin", label: "Itinerarios", icon: "M4 6h16M4 12h16M4 18h10", need: "verItinerarios" },
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
  const TITLES = { acta: "Acta de clientes", itin: "Itinerarios", prov: "Proveedores y servicios", admin: "Administración", perfil: "Mi usuario" };

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
    if (state.view === "itin" && state.itin.clientId && state.itin.dirty && !confirm("Hay cambios sin guardar en el itinerario. ¿Salir igual?")) return;
    if (v === "itin") { state.itin.clientId = null; state.itin.dirty = false; }
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
    if (state.view === "itin") return renderItin();
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
      renderClientItinTab(body, d.client);
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
  function provById(id) { return ((state.cat || {}).providers || []).find(p => p.id === id); }
  function svcById(id) { return ((state.cat || {}).services || []).find(s => s.id === id); }
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
      const [p, s, o, pr, ti, tr, tp] = await Promise.all([
        sb.from("providers").select("*").order("name"),
        sb.from("services").select("*").order("name_es"),
        sb.from("provider_services").select("*"),
        sb.from("offer_prices").select("*"),
        sb.from("vehicle_tiers").select("*").order("pax_from"),
        sb.from("transfers").select("*").order("name_es"),
        sb.from("transfer_prices").select("*")
      ]);
      for (const r of [p, s, o, pr]) if (r.error) throw r.error;
      const ok = r => (r.error ? [] : r.data || []);     // si todavía no se corrió el SQL de traslados, sigue andando
      state.cat = { providers: p.data || [], services: s.data || [], offers: o.data || [], prices: pr.data || [], tiers: ok(ti), transfers: ok(tr), tprices: ok(tp) };
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
    async rpcRead(fn, args) {
      const { data, error } = await state.supabase.rpc(fn, args);
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
    const isProv = P.tab === "prov", isTrf = P.tab === "trf", ed = can("editarProveedores");
    const nOffers = state.cat.offers.filter(o => o.active && (svcById(o.service_id) || {}).active !== false).length;
    const H = { prov: ["Proveedores", "Las empresas que hacen las excursiones, con sus datos de pago.", "proveedor"],
                svc: ["Servicios", "Cada servicio con su proveedor y los valores del mes: público (lo que paga el pasajero) y agencia (lo que paga Jeito).", "servicio"],
                trf: ["Traslados", "Los hacen nuestros choferes. Precio por traslado según cuántos pasajeros van, por mes. En el itinerario se puede cambiar a mano.", "traslado"] }[P.tab];
    c.innerHTML = `
      <div class="subtabs" id="pvTabs"><button data-t="prov" class="${isProv ? "on" : ""}">Proveedores <span>${state.cat.providers.filter(x => x.active).length}</span></button><button data-t="svc" class="${P.tab === "svc" ? "on" : ""}">Servicios <span>${nOffers}</span></button><button data-t="trf" class="${isTrf ? "on" : ""}">Traslados <span>${state.cat.transfers.filter(x => x.active).length}</span></button></div>
      <div class="pv-head"><div><h3>${H[0]}</h3><small>${H[1]}${isTrf ? ` · Tramos: <b>${esc(tiersActive().map(tierLabel).join(" · ") || "sin cargar")}</b>` : ""}</small></div>
        <div class="pv-head-btns">${ed && isTrf ? `<button class="btn" id="pvTiers">Tramos de pasajeros</button>` : ""}${ed ? `<button class="btn gold" id="pvNew">+ Nuevo ${H[2]}</button>` : ""}</div></div>
      <div id="pvDetail"></div>
      <div class="card" id="pvList"></div>`;
    $("#pvTabs").addEventListener("click", e => {
      const b = e.target.closest("button[data-t]"); if (!b || b.dataset.t === P.tab) return;
      if (P.dirty && !confirm("Hay cambios sin guardar en el formulario. ¿Salir igual?")) return;
      P.tab = b.dataset.t; P.edit = null; P.dirty = false; P.q = ""; renderProv();
    });
    if ($("#pvNew")) $("#pvNew").addEventListener("click", () => openForm("new"));
    if ($("#pvTiers")) $("#pvTiers").addEventListener("click", tiersModal);
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
    if (P.tab === "prov") providerForm(el); else if (P.tab === "trf") transferForm(el); else serviceForm(el);
  }
  function wireDirty(form) {
    const P = state.prov;
    form.addEventListener("input", () => { P.dirty = true; });
    form.addEventListener("change", () => { P.dirty = true; });
  }

  /* ---------- lista de abajo ---------- */
  function renderPvList() {
    const P = state.prov, el = $("#pvList"); if (!el) return;
    const isProv = P.tab === "prov", isTrf = P.tab === "trf";
    const q = P.q.trim().toLowerCase();
    let body, count;
    if (isTrf) { const r = renderTrfList(q); body = r.body; count = r.count; }
    else if (isProv) {
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
    el.innerHTML = `<div class="pv-tools"><input id="pvQ" placeholder="${isProv ? "Buscar proveedor…" : isTrf ? "Buscar traslado…" : "Buscar servicio o proveedor…"}" value="${esc(P.q)}">
        ${isProv ? "" : `<label class="pv-month">Valores de <input type="month" id="pvMonth" value="${P.month}"></label>`}
        <label class="toggle"><input type="checkbox" id="pvOff" ${P.showOff ? "checked" : ""}> ver inactivos</label></div>
      <div class="tablewrap">${body}</div>
      <div class="tfoot">${count} ${isProv ? (count === 1 ? "proveedor" : "proveedores") : isTrf ? (count === 1 ? "traslado" : "traslados") : (count === 1 ? "servicio" : "servicios")} · tocá un renglón para ${can("editarProveedores") ? "editarlo" : "ver el detalle"}</div>`;
    $("#pvQ").addEventListener("input", e => { P.q = e.target.value; const pos = e.target.selectionStart; renderPvList(); const i = $("#pvQ"); i.focus(); i.setSelectionRange(pos, pos); });
    $("#pvOff").addEventListener("change", e => { P.showOff = e.target.checked; renderPvList(); });
    if ($("#pvMonth")) $("#pvMonth").addEventListener("change", e => { if (!e.target.value) return; P.month = e.target.value; renderPvList(); if (P.edit && !P.dirty) renderPvDetail(); });
    el.querySelector("tbody").addEventListener("click", e => {
      const tr = e.target.closest("tr[data-id]"); if (!tr) return;
      if (e.target.closest("button[data-act=months]")) { if (P.tab === "trf") trfMonthsModal(trfById(tr.dataset.id)); else pricesModal(state.cat.offers.find(o => o.id === tr.dataset.id)); return; }
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
        <div class="grid4">
          <div class="field"><label>Paga como menor hasta</label><div class="suffix"><input name="minor_age_max" type="number" min="0" max="17" value="${esc(v.minor_age_max == null ? 11 : v.minor_age_max)}" ${dis}><span>años</span></div></div>
          <div class="field"><label>Bebés sin cargo hasta</label><div class="suffix"><input name="infant_age_max" type="number" min="0" max="16" value="${esc(v.id ? (v.infant_age_max == null ? "" : v.infant_age_max) : 2)}" placeholder="—" ${dis}><span>años</span></div></div>
          <div class="field" style="grid-column:span 2"><span class="help" style="margin-top:22px">Mayores de esa edad pagan como adulto. Si dejás “bebés” vacío, los bebés pagan como menor.</span></div>
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
      if (ex) { ["name_pt", "name_en", "service_type_id", "zone_id", "default_time", "duration", "desc_es", "desc_pt", "desc_en"].forEach(k => { if (!form[k].value && ex[k]) form[k].value = ex[k]; }); form.minor_age_max.value = ex.minor_age_max == null ? 11 : ex.minor_age_max; form.infant_age_max.value = ex.infant_age_max == null ? "" : ex.infant_age_max; }
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
      const mAge = parseInt(f.minor_age_max.value, 10), iAge = f.infant_age_max.value.trim() === "" ? null : parseInt(f.infant_age_max.value, 10);
      if (!(mAge >= 0 && mAge <= 17)) { toast("La edad de menor tiene que ser entre 0 y 17.", "bad"); f.minor_age_max.focus(); return; }
      if (iAge != null && !(iAge >= 0 && iAge < mAge)) { toast("La edad de bebé tiene que ser menor que la de menor.", "bad"); f.infant_age_max.focus(); return; }
      const svcFields = { minor_age_max: mAge, infant_age_max: iAge, name_es: f.name_es.value.trim(), name_pt: t("name_pt"), name_en: t("name_en"), service_type_id: f.service_type_id.value || null, zone_id: f.zone_id.value || null, default_time: t("default_time"), duration: t("duration"), desc_es: t("desc_es"), desc_pt: t("desc_pt"), desc_en: t("desc_en"), notes: t("notes") };
      const allYear = f.all_year && f.all_year.checked;
      const btn = $("button[type=submit]", f); btn.disabled = true;
      await saveAndRefresh(async () => {
        let offer = o, svc = s;
        if (isNew) {
          const pid = f.provider_id.value; if (!pid) throw new Error("Elegí el proveedor.");
          svc = state.cat.services.find(x => x.name_es.trim().toLowerCase() === svcFields.name_es.toLowerCase()) || null;
          if (svc) {           // ya existe: solo completo lo que estaba vacío (nunca piso lo que cargó otro)
            const fill = {}; Object.keys(svcFields).forEach(k => { if (k === "minor_age_max" || k === "infant_age_max") return; if (svcFields[k] != null && (svc[k] == null || svc[k] === "")) fill[k] = svcFields[k]; });
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
      if (tabs) { const nO = state.cat.offers.filter(o => o.active && (svcById(o.service_id) || {}).active !== false).length; tabs.querySelector('[data-t=prov] span').textContent = state.cat.providers.filter(x => x.active).length; tabs.querySelector('[data-t=svc] span').textContent = nO; const ts = tabs.querySelector('[data-t=trf] span'); if (ts) ts.textContent = state.cat.transfers.filter(x => x.active).length; }
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

  const AUDIT_LABELS = { name: "nombre", currency: "moneda", payment_method: "forma de pago", payment_details: "datos de pago", conditions: "condiciones", notes: "notas", active: "activo", name_es: "nombre ES", name_pt: "nombre PT", name_en: "nombre EN", desc_es: "descripción ES", desc_pt: "descripción PT", desc_en: "descripción EN", service_type_id: "tipo", zone_id: "zona", default_time: "horario", duration: "duración", pax_from: "desde", pax_to: "hasta", price: "precio", minor_age_max: "menor hasta", infant_age_max: "bebé hasta", public_adult: "público adulto", public_minor: "público menor", agency_adult: "agencia adulto", agency_minor: "agencia menor" };
  function auditVal(k, x) {
    if (x == null || x === "") return "—";
    if (k === "active") return x ? "sí" : "no";
    if (k === "service_type_id") return typeName(x) || "—";
    if (k === "zone_id") return zoneName(x) || "—";
    if (/^(public|agency)_/.test(k) || k === "price") return money(x);
    return String(x);
  }
  async function showHistory(sel, col, id) {
    const el = $(sel); if (!el) return;
    el.innerHTML = `<h3 class="t">Historial</h3><div class="empty">Cargando…</div>`;
    let ev; try { ev = await db.auditFor(col, id); } catch (err) { el.innerHTML = `<h3 class="t">Historial</h3><div class="note">${esc(explainError(err))}</div>`; return; }
    const what = e => {
      if (e.table_name === "transfer_prices") { const pr = state.cat.tprices.find(x => x.id === e.row_id) || {}; const t = state.cat.tiers.find(x => x.id === (e.detail.tier_id || pr.tier_id)); const m = e.detail.month || pr.month || ""; return "precio " + (m ? periodLabel(m.slice(0, 7)) : "") + (t ? " · " + tierLabel(t) : ""); }
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
     6a3. ITINERARIOS
     Versiones por cliente: borrador → enviada (congelada) → cerrada (una sola).
     El costo de cada línea vive en otra tabla que ventas no puede leer.
     ========================================================================== */
  const ITIN_STATUS = { borrador: "Borrador", enviada: "Enviada", cerrada: "Cerrada", reemplazada: "Reemplazada" };
  const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  function numSigned(v) { const s = String(v == null ? "" : v).trim().replace(",", ".").replace("−", "-"); if (s === "" || s === "-") return null; const n = Number(s); return isFinite(n) ? Math.round(n * 100) / 100 : NaN; }
  function itemPublic(i) { if (i.kind === "transfer") return Number(i.total_price) || 0; return (i.n_adults || 0) * (Number(i.public_adult) || 0) + (i.n_minors || 0) * (Number(i.public_minor) || 0); }
  function itemCost(i, c) { if (i.kind === "transfer" || !c) return null; return (i.n_adults || 0) * (Number(c.agency_adult) || 0) + (i.n_minors || 0) * (Number(c.agency_minor) || 0); }
  function addDays(ymd, n) { const d = new Date(ymd + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { if (!a || !b || b < a) return []; const out = []; let d = a; for (let k = 0; k < 120 && d <= b; k++) { out.push(d); d = addDays(d, 1); } return out; }
  function dayLabel(ymd, idx) { const d = new Date(ymd + "T12:00:00"); return (idx != null ? "Día " + (idx + 1) + " · " : "") + DIAS[d.getDay()] + " " + fmtDate(ymd); }
  function agesCount(t) { return (String(t || "").match(/\d{1,2}/g) || []).length; }
  function paxText(i) { if (i.kind === "transfer") return "traslado · " + (i.pax || 0) + " pax" + (i.tier_label ? " · tramo " + i.tier_label : " · sin tramo");
    return [i.n_adults ? i.n_adults + " ad" : "", i.n_minors ? i.n_minors + " men" : "", i.n_infants ? i.n_infants + " bebé" + (i.n_infants > 1 ? "s" : "") : ""].filter(Boolean).join(" · ") || "0 pax"; }
  function dayCount(l) {
    if (!l.length) return "día libre";
    const t = l.filter(x => x.kind === "transfer").length, sv = l.length - t;
    return [sv ? sv + " servicio" + (sv > 1 ? "s" : "") : "", t ? t + " traslado" + (t > 1 ? "s" : "") : ""].filter(Boolean).join(" · ");
  }
  function noPriceItem(x) { return x.kind === "transfer" ? x.total_price == null : x.public_adult == null; }
  function clientById(id) { return state.clients.find(c => String(c.id) === String(id)); }
  function roteiroUrl(token) { return location.origin + "/roteiro/?c=" + encodeURIComponent(token); }
  function statusTag(st) { return `<span class="ist ${st}">${ITIN_STATUS[st] || st}</span>`; }

  Object.assign(db, {
    async itinList() {
      const sb = state.supabase;
      const [it, items] = await Promise.all([
        sb.from("itineraries").select("*").order("version", { ascending: false }).limit(3000),
        sb.from("itinerary_items").select("itinerary_id, kind, n_adults, n_minors, public_adult, public_minor, total_price").limit(20000)
      ]);
      for (const r of [it, items]) if (r.error) throw r.error;
      const tot = {}; (items.data || []).forEach(i => { tot[i.itinerary_id] = (tot[i.itinerary_id] || 0) + itemPublic(i); });
      return (it.data || []).map(x => Object.assign({}, x, { _total: (tot[x.id] || 0) + Number(x.adjustment || 0), _items: tot[x.id] != null }));
    },
    async itinVersions(clientId) {
      const { data, error } = await state.supabase.from("itineraries").select("*").eq("client_id", clientId).order("version", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async itinDetail(itinId) {
      const sb = state.supabase;
      const [h, it] = await Promise.all([
        sb.from("itinerary_hotels").select("*").eq("itinerary_id", itinId).order("sort"),
        sb.from("itinerary_items").select("*").eq("itinerary_id", itinId).order("sort")
      ]);
      for (const r of [h, it]) if (r.error) throw r.error;
      let costs = {};
      if (can("verCostos") && (it.data || []).length) {
        const c = await sb.from("itinerary_item_costs").select("*").in("item_id", it.data.map(x => x.id));
        if (!c.error) (c.data || []).forEach(x => { costs[x.item_id] = x; });
      }
      return { hotels: h.data || [], items: it.data || [], costs };
    },
    async clientLink(clientId) {
      if (!can("editarItinerarios")) return null;
      const { data } = await state.supabase.from("client_links").select("token").eq("client_id", clientId).maybeSingle();
      return data ? data.token : null;
    },
    async rpcOk(fn, args) {
      await assertCanSave();
      const { data, error } = await state.supabase.rpc(fn, args);
      if (error) throw error;
      return data;
    },
    async itinCatalog(ym) {
      const { data, error } = await state.supabase.rpc("itin_catalog", { p_month: ym + "-01" });
      if (error) throw error;
      return data || [];
    },
    async deleteRow(table, row) {
      await assertCanSave();
      const { data, error } = await state.supabase.from(table).delete().eq("id", row.id).eq("updated_at", row.updated_at).select();
      if (error) throw error;
      if (!data || !data.length) { const err = new Error("CONFLICTO"); err.conflict = true; throw err; }
    }
  });

  /* ---------- lista general ---------- */
  async function renderItin() {
    const c = $("#content");
    if (!can("verItinerarios")) { c.innerHTML = `<div class="placeholder"><b>Sin acceso</b></div>`; return; }
    if (state.itin.clientId) return renderItinEditor();
    c.innerHTML = `<div class="empty">Cargando itinerarios…</div>`;
    let all;
    try { all = await db.itinList(); } catch (err) { c.innerHTML = `<div class="placeholder"><b>No se pudo cargar</b>${esc(explainError(err))}<br><br>¿Ya se corrió el SQL de Itinerarios en Supabase?</div>`; return; }
    if (state.view !== "itin" || state.itin.clientId) return;
    state.itin.list = all;
    drawItinList();
  }
  function drawItinList() {
    const c = $("#content"), F = state.itin.filters, all = state.itin.list || [];
    const byClient = {};
    all.forEach(x => { const k = String(x.client_id); (byClient[k] = byClient[k] || []).push(x); });
    let rows = Object.entries(byClient).map(([cid, vs]) => ({ cid, last: vs[0], closed: vs.find(v => v.status === "cerrada"), n: vs.length, client: clientById(cid) }));
    const q = F.q.trim().toLowerCase();
    rows = rows.filter(r => (!F.status || r.last.status === F.status) && (!q || (r.client && (fullName(r.client).toLowerCase().includes(q) || String(r.client.number).includes(q)))))
      .sort((a, b) => String(b.last.updated_at).localeCompare(String(a.last.updated_at)));
    const chip = (v, l) => `<span class="chip ${F.status === v ? "on" : ""}" data-s="${v}">${l}</span>`;
    c.innerHTML = `
      <div class="pv-head"><div><h3>Itinerarios</h3><small>Uno por cliente, con todas sus versiones. Tocá un renglón para abrirlo.</small></div>${can("editarItinerarios") ? `<button class="btn gold" id="itNew">+ Nuevo itinerario</button>` : ""}</div>
      <div class="card"><div class="pv-tools"><input id="itQ" placeholder="Buscar cliente por nombre o número…" value="${esc(F.q)}"><div class="chips" id="itSt">${chip("", "Todos")}${chip("borrador", "Borradores")}${chip("enviada", "Enviados")}${chip("cerrada", "Cerrados")}</div></div>
      <div class="tablewrap"><table><thead><tr><th>Cliente</th><th>Viaje</th><th>Pax</th><th>Última versión</th><th class="r">Total</th><th>Vendedor</th><th>Actualizado</th></tr></thead>
      <tbody>${rows.map(r => { const cl = r.client || {}; return `<tr class="row" data-cid="${esc(r.cid)}"><td><span class="name">${esc(fullName(cl) || "Cliente")}</span><span class="sub">Nº ${esc(cl.number || "—")}${cl.lang ? " · " + cl.lang.toUpperCase() : ""}</span></td>
        <td class="num">${r.last.start_date ? fmtDate(r.last.start_date) + " → " + fmtDate(r.last.end_date) : "—"}</td><td>${r.last.adults}${agesCount(r.last.minors_ages) ? " + " + agesCount(r.last.minors_ages) : ""}</td>
        <td>v${r.last.version} ${statusTag(r.last.status)}${r.closed && r.closed.id !== r.last.id ? `<span class="sub">cerrada: v${r.closed.version}</span>` : ""}</td>
        <td class="r"><b>${money(r.last._total)}</b></td><td>${esc(userName(cl.seller_id))}</td><td class="num">${fmtDateTime(r.last.updated_at)}</td></tr>`; }).join("") || `<tr><td colspan="7" class="empty">${all.length ? "Nada coincide con el filtro." : "Todavía no hay itinerarios. Tocá “+ Nuevo itinerario” o abrí un cliente desde la Acta."}</td></tr>`}</tbody></table></div>
      <div class="tfoot">${rows.length} cliente${rows.length === 1 ? "" : "s"} con itinerario</div></div>`;
    $("#itQ").addEventListener("input", e => { F.q = e.target.value; const pos = e.target.selectionStart; drawItinList(); const i = $("#itQ"); i.focus(); i.setSelectionRange(pos, pos); });
    $("#itSt").addEventListener("click", e => { const ch = e.target.closest(".chip"); if (!ch) return; F.status = ch.dataset.s; drawItinList(); });
    if ($("#itNew")) $("#itNew").addEventListener("click", newItinModal);
    c.querySelector("tbody").addEventListener("click", e => { const tr = e.target.closest("tr[data-cid]"); if (tr) openItinEditor(tr.dataset.cid); });
  }
  function newItinModal() {
    const has = new Set((state.itin.list || []).map(x => String(x.client_id)));
    const cls = state.clients.filter(c => !c.deleted_at).sort((a, b) => b.number - a.number);
    openModal(`<h3>Nuevo itinerario</h3><p>Elegí el cliente. Las fechas y los pasajeros se toman de su ficha.</p>
      <form id="niForm"><div class="field"><label>Cliente</label><input id="niQ" placeholder="Buscar por nombre o número…" autocomplete="off"></div>
      <ul class="list sel pick" id="niList"></ul>
      <div class="acts"><button type="button" class="btn" id="mCancel">Cancelar</button></div></form>`);
    const draw = () => {
      const q = $("#niQ").value.trim().toLowerCase();
      $("#niList").innerHTML = cls.filter(c => !q || fullName(c).toLowerCase().includes(q) || String(c.number).includes(q)).slice(0, 40)
        .map(c => `<li data-id="${esc(c.id)}"><div class="grow"><b>${esc(fullName(c))}</b><small>Nº ${c.number} · ${c.arrival ? fmtDate(c.arrival) + " → " + fmtDate(c.departure) : "sin fechas"} · ${c.adults || 0} ad${c.minors ? " + " + c.minors + " men" : ""}</small></div>${has.has(String(c.id)) ? `<span class="ist enviada">ya tiene</span>` : ""}</li>`).join("") || `<li class="muted">No hay clientes con ese nombre.</li>`;
    };
    draw(); $("#niQ").addEventListener("input", draw); $("#niQ").focus();
    $("#mCancel").addEventListener("click", closeModal);
    $("#niList").addEventListener("click", async e => {
      const li = e.target.closest("li[data-id]"); if (!li) return;
      closeModal(); await openItinEditor(li.dataset.id, true);
    });
  }

  /* ---------- abrir el editor de un cliente ---------- */
  async function openItinEditor(clientId, createIfNone) {
    if (state.view !== "itin") { state.view = "itin"; $$("#nav a[data-view]").forEach(a => a.classList.toggle("on", a.dataset.view === "itin")); $("#pageTitle").textContent = TITLES.itin; }
    const I = state.itin; I.clientId = String(clientId); I.itinId = null; I.edit = null; I.dirty = false; I.catCache = {};
    $("#content").innerHTML = `<div class="empty">Cargando itinerario…</div>`;
    try {
      let vs = await db.itinVersions(I.clientId);
      if (!vs.length && createIfNone) {
        if (!can("editarItinerarios")) throw new Error("Este cliente todavía no tiene itinerario.");
        await db.rpcOk("create_itinerary", { p_client: I.clientId }); vs = await db.itinVersions(I.clientId);
        toast("Itinerario creado con las fechas y pasajeros de la ficha.", "ok");
      }
      if (can("verProveedores") && !state.cat) await db.loadCatalog().catch(() => { });
      I.versions = vs; I.itinId = vs.length ? vs[0].id : null;
      I.token = await db.clientLink(I.clientId).catch(() => null);
      await loadItinDetail();
    } catch (err) { toast(explainError(err), "bad"); I.clientId = null; return renderItin(); }
    renderItinEditor();
  }
  async function loadItinDetail() {
    const I = state.itin; if (!I.itinId) { I.detail = null; return; }
    I.detail = await db.itinDetail(I.itinId);
    const it = I.versions.find(v => v.id === I.itinId);
    I.edit = { it: Object.assign({}, it), hotels: I.detail.hotels.map(h => Object.assign({}, h)), items: I.detail.items.map(x => Object.assign({}, x)), delHotels: [], delItems: [] };
    I.dirty = false;
  }
  async function reloadItin(keepVersion) {
    const I = state.itin, cur = I.itinId;
    I.versions = await db.itinVersions(I.clientId);
    I.itinId = keepVersion && I.versions.some(v => v.id === cur) ? cur : (I.versions[0] || {}).id;
    I.token = await db.clientLink(I.clientId).catch(() => I.token);
    await loadItinDetail(); renderItinEditor();
  }
  function leaveItinEditor() {
    const I = state.itin;
    if (I.dirty && !confirm("Hay cambios sin guardar en el itinerario. ¿Salir igual?")) return;
    I.clientId = null; I.dirty = false; renderItin();
  }

  /* ---------- editor ---------- */
  function renderItinEditor() {
    const I = state.itin, c = $("#content"), cl = clientById(I.clientId) || {};
    const E = I.edit, it = E ? E.it : null;
    const ed = can("editarItinerarios"), canEdit = ed && it && it.status === "borrador";
    const showCost = can("verCostos");
    const hasDraft = I.versions.some(v => v.status === "borrador");
    const vChips = I.versions.map(v => `<button class="ver ${v.id === I.itinId ? "on" : ""}" data-id="${v.id}"><b>v${v.version}</b> ${statusTag(v.status)}</button>`).join("");
    const lang = cl.lang || "pt";
    let html = `<div class="it-top card">
        <div class="it-top-row"><button class="linkbtn" id="itBack">← Todos los itinerarios</button>
          <div class="it-acts">${ed && I.token ? `<button class="btn sm" id="itCopy">Copiar link</button><a class="btn sm" id="itView" href="${esc(roteiroUrl(I.token))}" target="_blank" rel="noopener">Ver como el cliente</a>` : ""}${ed && !hasDraft && I.versions.length ? `<button class="btn sm gold" id="itNewV">+ Nueva versión</button>` : ""}</div></div>
        <div class="it-client"><div><h3>${esc(fullName(cl) || "Cliente")}</h3><small>Nº ${esc(cl.number || "—")} · ${esc(countryName(cl.origin_country) || "país sin cargar")} · el cliente lo lee en <b>${esc(LANGS[lang] || lang)}</b> · vendedor: ${esc(userName(cl.seller_id))}</small></div>
          <div class="vers" id="itVers">${vChips}</div></div>
        ${I.token && ed ? `<div class="it-link">Link del cliente: <code>${esc(roteiroUrl(I.token))}</code> <button class="linkbtn" id="itRenew">cambiar link</button></div>` : ""}
      </div>`;
    if (!it) {
      html += `<div class="placeholder"><b>Este cliente todavía no tiene itinerario</b>${ed ? `<br><button class="btn gold" id="itCreate">Armar itinerario</button>` : ""}</div>`;
      c.innerHTML = `<div id="itEd">${html}</div>`; wireItinTop(); if ($("#itCreate")) $("#itCreate").addEventListener("click", () => openItinEditor(I.clientId, true)); return;
    }
    if (it.status !== "borrador") {
      const msg = it.status === "enviada" ? `Versión enviada el ${fmtDateLong(it.sent_at)} por ${esc(userName(it.sent_by))}. Ya no se cambia: es lo que vio el cliente.`
        : it.status === "cerrada" ? `✓ Versión cerrada: el cliente la aceptó el ${fmtDateLong(it.closed_at)}. Es la que se usa para cobrar y operar.`
        : `Esta versión fue reemplazada por una cerrada más nueva.`;
      html += `<div class="it-banner ${it.status}">${msg}${ed && !hasDraft ? ` Para cambiar algo, tocá <b>+ Nueva versión</b> (copia esta).` : ""}${ed && hasDraft ? " Hay un borrador más nuevo: elegilo arriba." : ""}</div>`;
    }
    const dis = canEdit ? "" : "disabled";
    const days = daysBetween(it.start_date, it.end_date);
    const nAges = agesCount(it.minors_ages);
    const warnAges = cl.minors && nAges < cl.minors ? `<span class="help warn">La ficha dice ${cl.minors} menor${cl.minors > 1 ? "es" : ""}: cargá sus edades para calcular bien los precios.</span>` : `<span class="help">Separadas por coma, ej. 3, 7, 12. Cada servicio decide quién paga como menor y quién no paga (bebés).</span>`;
    html += `<div class="card it-sec"><h3 class="t">Viaje</h3><div class="pad"><div class="grid4">
        <div class="field"><label>Llegada</label><input type="date" data-f="start_date" value="${esc(it.start_date || "")}" ${dis}></div>
        <div class="field"><label>Salida</label><input type="date" data-f="end_date" value="${esc(it.end_date || "")}" ${dis}></div>
        <div class="field"><label>Adultos</label><input type="number" min="0" data-f="adults" value="${esc(it.adults)}" ${dis}></div>
        <div class="field"><label>Edades de los menores</label><input data-f="minors_ages" value="${esc(it.minors_ages || "")}" placeholder="ej. 3, 7, 12" ${dis}>${warnAges}</div>
      </div></div></div>`;
    html += `<div class="card it-sec"><h3 class="t">Hoteles${canEdit ? `<button class="btn sm" id="itAddHotel">+ Agregar hotel</button>` : ""}</h3><div class="pad" id="itHotels">${E.hotels.map((h, k) => `<div class="hotel-row" data-k="${k}">
        <div class="field"><label>Hotel</label><input data-h="name" value="${esc(h.name || "")}" placeholder="Nombre del hotel" ${dis}></div>
        <div class="field"><label>Desde</label><input type="date" data-h="date_from" value="${esc(h.date_from || "")}" ${dis}></div>
        <div class="field"><label>Hasta</label><input type="date" data-h="date_to" value="${esc(h.date_to || "")}" ${dis}></div>
        ${canEdit ? `<button class="btn sm ghost danger" data-act="delhotel" title="Quitar">✕</button>` : ""}</div>`).join("") || `<div class="muted" style="padding:4px 0 10px">Sin hotel cargado.</div>`}</div></div>`;
    // días
    const inRange = new Set(days);
    const byDay = {}; E.items.forEach(x => { (byDay[x.day] = byDay[x.day] || []).push(x); });
    Object.values(byDay).forEach(l => l.sort((a, b) => (a.time || "99").localeCompare(b.time || "99") || a.sort - b.sort));
    const out = Object.keys(byDay).filter(d => !inRange.has(d)).sort();
    const itemRow = x => {
      const k = E.items.indexOf(x), cst = I.detail.costs[x.id], pub = itemPublic(x), cost = itemCost(x, cst);
      const isT = x.kind === "transfer";
      const changed = isT ? (x.catalog_total_price != null && !sameVal(x.total_price, x.catalog_total_price))
        : (x.catalog_public_adult != null && !sameVal(x.public_adult, x.catalog_public_adult)) || (x.catalog_public_minor != null && !sameVal(x.public_minor, x.catalog_public_minor));
      const noPrice = isT ? x.total_price == null : x.public_adult == null;
      return `<div class="it-row" data-k="${k}">
        <div class="c-time"><input type="time" data-i="time" value="${esc(x.time || "")}" ${dis}>${canEdit && days.length ? `<select data-i="day" title="Mover a otro día">${days.map((d, n) => `<option value="${d}" ${d === x.day ? "selected" : ""}>Día ${n + 1}</option>`).join("")}${inRange.has(x.day) ? "" : `<option value="${x.day}" selected>${fmtDate(x.day)}</option>`}</select>` : ""}</div>
        <div class="c-name"><b>${esc(x.name_es)}</b><small>${showCost && cst && cst.provider_id ? esc((provById(cst.provider_id) || {}).name || "") + " · " : ""}${paxText(x)}${x.n_infants ? " (bebés sin cargo)" : ""}</small>${noPrice ? `<small class="warn">${isT ? "sin precio para este tramo o mes: cargalo a mano" : "sin valor del mes: cargalo a mano"}</small>` : changed ? `<small class="warn">valor cambiado a mano (catálogo: ${isT ? money(x.catalog_total_price) : money(x.catalog_public_adult) + " / " + money(x.catalog_public_minor)})</small>` : ""}</div>
        ${isT ? `<div class="c-pr"><label>Precio</label><input inputmode="decimal" data-i="total_price" value="${x.total_price == null ? "" : Number(x.total_price)}" ${dis}></div><div class="c-pr"></div>`
        : `<div class="c-pr"><label>Adulto</label><input inputmode="decimal" data-i="public_adult" value="${x.public_adult == null ? "" : Number(x.public_adult)}" ${dis}></div>
        <div class="c-pr"><label>Menor</label><input inputmode="decimal" data-i="public_minor" value="${x.public_minor == null ? "" : Number(x.public_minor)}" ${dis}></div>`}
        <div class="c-sub"><label>Subtotal</label><b>${money(pub)}</b>${showCost ? (isT ? `<small>chofer propio (costo en Logística)</small>` : `<small>costo ${cost == null ? "—" : money(cost)} · <span class="${pub - (cost || 0) < 0 ? "neg" : "pos"}">gan. ${money(pub - (cost || 0))}</span></small>`) : ""}</div>
        <div class="c-x">${canEdit ? `<button class="btn sm ghost danger" data-act="delitem" title="Quitar del itinerario">✕</button>` : ""}</div></div>`;
    };
    html += `<div class="card it-sec"><h3 class="t">Día por día</h3><div class="pad">`;
    if (!days.length) html += `<div class="muted">Cargá la llegada y la salida (arriba) para ver los días del viaje.</div>`;
    days.forEach((d, n) => {
      const l = byDay[d] || [];
      html += `<div class="day"><div class="day-h"><b>${esc(dayLabel(d, n))}</b><span class="muted">${dayCount(l)}</span></div>${l.map(itemRow).join("")}${canEdit ? `<div class="day-add"><button class="btn sm add-svc" data-day="${d}">+ Servicio</button><button class="btn sm add-trf" data-day="${d}">+ Traslado</button></div>` : ""}</div>`;
    });
    if (out.length) html += `<div class="day out"><div class="day-h"><b>Fuera de las fechas del viaje</b><span class="muted">movelos a un día del viaje o quitalos</span></div>${out.map(d => byDay[d].map(itemRow).join("")).join("")}</div>`;
    html += `</div></div>`;
    // precio
    html += `<div class="it-price"><div class="card it-sec"><h3 class="t">Precio y nota</h3><div class="pad">
        <div class="grid2"><div class="field"><label>Ajuste o descuento (US$, negativo = descuento)</label><input inputmode="decimal" data-f="adjustment" value="${Number(it.adjustment) || ""}" placeholder="ej. -100" ${dis}></div>
        <div class="field"><label>Motivo del ajuste (interno, el cliente no lo ve)</label><input data-f="adjustment_reason" value="${esc(it.adjustment_reason || "")}" ${dis}></div></div>
        <div class="field"><label>Nota para el cliente (escribila en ${esc(LANGS[lang] || lang)})</label><textarea rows="2" data-f="client_note" ${dis}>${esc(it.client_note || "")}</textarea></div>
        <div class="field"><label>Qué precios ve el cliente</label><select data-f="show_item_prices" ${dis}><option value="0" ${it.show_item_prices ? "" : "selected"}>Solo el total del viaje</option><option value="1" ${it.show_item_prices ? "selected" : ""}>El total y el precio de cada servicio</option></select></div>
      </div></div>
      <div class="sum" id="itSum">${sumHTML()}      </div></div>`;
    // pie
    html += `<div class="it-foot" id="itFoot">${canEdit ? `<span class="dirty ${I.dirty ? "" : "hidden"}" id="itDirty">Hay cambios sin guardar</span><span class="grow"></span><button class="btn" id="itSave" ${I.dirty ? "" : "disabled"}>Guardar</button><button class="btn gold" id="itSend">Marcar como enviada</button>` : `<span class="grow"></span>`}${ed && (it.status === "borrador" || it.status === "enviada") ? `<button class="btn ok" id="itClose">Cliente aceptó → Cerrar</button>` : ""}</div>`;
    c.innerHTML = `<div id="itEd">${html}</div>`;
    wireItinTop(); wireItinEditor();
  }

  function sumHTML() {
    const I = state.itin, E = I.edit, it = E.it, showCost = can("verCostos");
    const nAges = agesCount(it.minors_ages);
    const sub = E.items.reduce((a, x) => a + itemPublic(x), 0), adjN = numSigned(it.adjustment), adj = Number.isNaN(adjN) ? 0 : Number(adjN || 0), total = sub + adj;
    const costT = E.items.reduce((a, x) => a + (itemCost(x, I.detail.costs[x.id]) || 0), 0);
    const payers = Number(it.adults || 0) + nAges, fx = Number(state.settings.fx_brl_usd) || 0;
    return `<div class="l"><span>Servicios (${E.items.length})</span><span>${money(sub)}</span></div>${adj ? `<div class="l"><span>Ajuste${it.adjustment_reason ? " · " + esc(it.adjustment_reason) : ""}</span><span>${adj < 0 ? "−" : "+"} ${money(Math.abs(adj))}</span></div>` : ""}
        <div class="l big"><span>Total</span><span>${money(total)}</span></div>
        ${fx ? `<div class="l sm"><span>Referencia en reales (cotiz. ${fx})</span><span>R$ ${Math.round(total * fx).toLocaleString("es-AR")}</span></div>` : ""}
        ${payers ? `<div class="l sm"><span>Promedio por pasajero (${payers})</span><span>${money(Math.round(total / payers))}</span></div>` : ""}
        ${showCost ? `<div class="l sm sep"><span>Costo (lo que paga Jeito)${E.items.some(x => x.kind === "transfer") ? "<br><small>sin los traslados: los hacen nuestros choferes (se ve en Logística)</small>" : ""}</span><span>${money(costT)}</span></div><div class="l"><span>Ganancia</span><b class="${total - costT < 0 ? "neg" : "pos"}">${money(total - costT)}${total > 0 ? " · " + Math.round((total - costT) * 100 / total) + "%" : ""}</b></div>` : ""}`;
  }
  function wireItinTop() {
    const I = state.itin;
    $("#itBack").addEventListener("click", leaveItinEditor);
    if ($("#itVers")) $("#itVers").addEventListener("click", async e => {
      const b = e.target.closest("button[data-id]"); if (!b || b.dataset.id === I.itinId) return;
      if (I.dirty && !confirm("Hay cambios sin guardar. ¿Cambiar de versión igual?")) return;
      I.itinId = b.dataset.id; try { await loadItinDetail(); } catch (err) { toast(explainError(err), "bad"); } renderItinEditor();
    });
    if ($("#itCopy")) $("#itCopy").addEventListener("click", () => copyText(roteiroUrl(I.token)));
    if ($("#itRenew")) $("#itRenew").addEventListener("click", async () => {
      if (!confirm("¿Hacer un link nuevo? El link anterior deja de funcionar (usalo si se lo mandaste a quien no correspondía).")) return;
      try { I.token = await db.rpcOk("renew_client_link", { p_client: I.clientId }); toast("Link nuevo listo. El anterior ya no funciona.", "ok"); renderItinEditor(); } catch (err) { toast(explainError(err), "bad"); }
    });
    if ($("#itNewV")) $("#itNewV").addEventListener("click", async () => {
      try { await db.rpcOk("create_itinerary", { p_client: I.clientId }); toast("Versión nueva creada (copia de la anterior).", "ok"); await reloadItin(false); } catch (err) { toast(explainError(err), "bad"); }
    });
  }
  function copyText(t) {
    const done = () => toast("Link copiado. Pegalo en el WhatsApp del cliente.", "ok");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => prompt("Copiá el link:", t));
    else prompt("Copiá el link:", t);
  }

  function wireItinEditor() {
    const I = state.itin, E = I.edit; if (!E) return;
    const c = $("#itEd");
    const markDirty = () => { I.dirty = true; const d = $("#itDirty"); if (d) d.classList.remove("hidden"); const s = $("#itSave"); if (s) s.disabled = false; };
    c.addEventListener("input", e => {
      const t = e.target;
      if (t.dataset.f) { E.it[t.dataset.f] = t.dataset.f === "show_item_prices" ? t.value === "1" : t.value; markDirty(); if (["adjustment"].includes(t.dataset.f)) refreshSums(); }
      else if (t.dataset.h) { E.hotels[+t.closest(".hotel-row").dataset.k][t.dataset.h] = t.value; markDirty(); }
      else if (t.dataset.i) {
        const x = E.items[+t.closest(".it-row").dataset.k];
        if (t.dataset.i === "public_adult" || t.dataset.i === "public_minor" || t.dataset.i === "total_price") { const v = numOrNull(t.value); x[t.dataset.i] = Number.isNaN(v) ? x[t.dataset.i] : v; refreshSums(); }
        else x[t.dataset.i] = t.value;
        markDirty();
      }
    });
    c.addEventListener("change", e => {
      const t = e.target;
      if (t.dataset.f === "show_item_prices") { E.it.show_item_prices = t.value === "1"; markDirty(); }
      if (t.dataset.i === "day") { E.items[+t.closest(".it-row").dataset.k].day = t.value; markDirty(); renderItinEditor(); }
      if (t.dataset.f === "start_date" || t.dataset.f === "end_date") renderItinEditor();
    });
    c.addEventListener("click", async e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.act === "delhotel") { const k = +b.closest(".hotel-row").dataset.k; const h = E.hotels[k]; if (h.id) E.delHotels.push(h); E.hotels.splice(k, 1); markDirty(); renderItinEditor(); }
      else if (b.dataset.act === "delitem") { const k = +b.closest(".it-row").dataset.k; E.delItems.push(E.items[k]); E.items.splice(k, 1); markDirty(); renderItinEditor(); toast("Quitado. Se aplica al tocar Guardar."); }
      else if (b.id === "itAddHotel") { E.hotels.push({ name: "", date_from: E.it.start_date || null, date_to: E.it.end_date || null, sort: E.hotels.length + 1 }); markDirty(); renderItinEditor(); const ins = $$("#itHotels [data-h=name]"); if (ins.length) ins[ins.length - 1].focus(); }
      else if (b.classList.contains("add-svc")) { if (I.dirty && !(await saveItin(true))) return; pickServiceModal(b.dataset.day); }
      else if (b.classList.contains("add-trf")) { if (I.dirty && !(await saveItin(true))) return; pickTransferModal(b.dataset.day); }
      else if (b.id === "itSave") saveItin();
      else if (b.id === "itSend") sendItin();
      else if (b.id === "itClose") closeItin();
    });
    function refreshSums() {
      // recalcula subtotales y total sin redibujar (no se pierde el foco)
      $$(".it-row").forEach(row => { const x = E.items[+row.dataset.k]; const s = $(".c-sub b", row); if (s) s.textContent = money(itemPublic(x)); });
      const box = $("#itSum"); if (box) box.innerHTML = sumHTML();
    }
  }

  // guarda todo lo que cambió: datos del viaje, hoteles y líneas (cada fila por separado, con candado)
  async function saveItin(silent) {
    const I = state.itin, E = I.edit; if (!E) return false;
    const it = E.it, orig = I.versions.find(v => v.id === I.itinId);
    for (const x of E.items) for (const k of ["public_adult", "public_minor", "total_price"]) if (x[k] != null && (isNaN(x[k]) || x[k] < 0)) { toast("Revisá los valores: hay uno que no es un número válido.", "bad"); return false; }
    if (it.start_date && it.end_date && it.end_date < it.start_date) { toast("La salida no puede ser antes que la llegada.", "bad"); return false; }
    for (const h of E.hotels) if (!String(h.name || "").trim()) { toast("Escribí el nombre del hotel (o quitá ese renglón).", "bad"); return false; }
    const adj = numSigned(it.adjustment); if (Number.isNaN(adj)) { toast("El ajuste tiene que ser un número.", "bad"); return false; }
    setSync("busy", "Guardando…"); const btn = $("#itSave"); if (btn) btn.disabled = true;
    try {
      const fields = { start_date: it.start_date || null, end_date: it.end_date || null, adults: Math.max(0, parseInt(it.adults, 10) || 0), minors_ages: String(it.minors_ages || "").trim() || null, adjustment: adj == null ? 0 : adj, adjustment_reason: String(it.adjustment_reason || "").trim() || null, client_note: String(it.client_note || "").trim() || null, show_item_prices: !!it.show_item_prices };
      const paxChanged = !sameVal(fields.adults, orig.adults) || !sameVal(fields.minors_ages, orig.minors_ages);
      await db.saveRow("itineraries", orig, fields);
      for (const h of E.delHotels) await db.deleteRow("itinerary_hotels", h);
      for (const [k, h] of E.hotels.entries()) {
        const f = { name: String(h.name).trim(), date_from: h.date_from || null, date_to: h.date_to || null, sort: k + 1 };
        if (h.id) await db.saveRow("itinerary_hotels", I.detail.hotels.find(o => o.id === h.id), f);
        else await db.saveRow("itinerary_hotels", null, Object.assign({ itinerary_id: I.itinId }, f));
      }
      for (const x of E.delItems) await db.deleteRow("itinerary_items", I.detail.items.find(o => o.id === x.id) || x);
      for (const x of E.items) {
        const o = I.detail.items.find(y => y.id === x.id); if (!o) continue;
        await db.saveRow("itinerary_items", o, x.kind === "transfer" ? { time: x.time || null, day: x.day, total_price: x.total_price } : { time: x.time || null, day: x.day, public_adult: x.public_adult, public_minor: x.public_minor });
      }
      if (paxChanged) await db.rpcOk("recount_itinerary", { p_itin: I.itinId });
      if (!silent) toast(paxChanged ? "Guardado. Se recalcularon los pasajeros de cada servicio." : "Guardado.", "ok");
      setSync("ok", "Guardado " + ago(new Date().toISOString()));
      await reloadItin(true);
      return true;
    } catch (err) {
      setSync("ok", "");
      if (err.conflict) { toast("Otra persona cambió este itinerario mientras lo editabas. Te muestro lo actual: volvé a hacer tu cambio.", "bad"); await reloadItin(true).catch(() => { }); }
      else { toast(explainError(err), "bad"); if (btn) btn.disabled = false; }
      return false;
    }
  }
  async function sendItin() {
    const I = state.itin, E = I.edit;
    if (!E.items.length) return toast("Agregá al menos un servicio antes de enviarlo.", "bad");
    if (E.items.some(noPriceItem)) return toast("Hay servicios o traslados sin precio. Cargalos antes de enviarlo.", "bad");
    if (I.dirty && !(await saveItin(true))) return;
    if (!confirm("¿Marcar la versión " + E.it.version + " como enviada? Queda congelada (ya no se cambia) y el link del cliente pasa a mostrar esta versión.")) return;
    try { I.token = await db.rpcOk("send_itinerary", { p_itin: I.itinId }); await reloadItin(true); toast("Enviada. Copiá el link y mandáselo al cliente.", "ok"); }
    catch (err) { toast(explainError(err), "bad"); }
  }
  async function closeItin() {
    const I = state.itin, E = I.edit, cl = clientById(I.clientId);
    if (!E.items.length) return toast("El itinerario no tiene servicios.", "bad");
    if (E.it.status === "borrador" && E.items.some(noPriceItem)) return toast("Hay servicios o traslados sin precio. Cargalos antes de cerrar.", "bad");
    if (I.dirty && !(await saveItin(true))) return;
    const prevClosed = I.versions.find(v => v.status === "cerrada");
    if (!confirm("¿El cliente aceptó la versión " + E.it.version + "? Queda cerrada y es la que se usa para cobrar y operar." + (prevClosed ? " La versión " + prevClosed.version + " (cerrada antes) pasa a reemplazada." : ""))) return;
    try {
      I.token = await db.rpcOk("close_itinerary", { p_itin: I.itinId }); await reloadItin(true); toast("Versión cerrada.", "ok");
      if (cl && cl.lead_status !== "cerrado" && can("editarClientes") && confirm("¿Pasar la ficha de " + fullName(cl) + " a “Cerrado” en la Acta?")) {
        try { const saved = await db.updateClient(cl.id, cl.updated_at, { lead_status: "cerrado" }); const k = state.clients.findIndex(x => x.id === saved.id); if (k >= 0) state.clients[k] = saved; toast("Ficha pasada a Cerrado.", "ok"); }
        catch (err) { toast(err.conflict ? "La ficha cambió mientras tanto: pasala a Cerrado desde la Acta." : explainError(err), "bad"); }
      }
    } catch (err) { toast(explainError(err), "bad"); }
  }

  /* ---------- elegir servicio del catálogo ---------- */
  async function pickServiceModal(day) {
    const I = state.itin, E = I.edit, it = E.it, ym = day.slice(0, 7), priv = can("verCostos");
    const days = daysBetween(it.start_date, it.end_date);
    openModal(`<h3>Agregar servicio</h3><p>${esc(dayLabel(day, days.indexOf(day) >= 0 ? days.indexOf(day) : null))} · valores de ${esc(periodLabel(ym))}</p><div class="empty">Cargando catálogo…</div>`);
    $("#modal .box").classList.add("wide");
    let cat; try { I.catCache = I.catCache || {}; cat = I.catCache[ym] || (I.catCache[ym] = await db.itinCatalog(ym)); } catch (err) { closeModal(); return toast(explainError(err), "bad"); }
    const counts = s => { let a = Number(it.adults) || 0, m = 0, i = 0; (String(it.minors_ages || "").match(/\d{1,2}/g) || []).map(Number).forEach(x => { if (x > s.minor_age_max) a++; else if (s.infant_age_max != null && x <= s.infant_age_max) i++; else m++; }); return { a, m, i }; };
    const groups = {}; cat.forEach(o => { (groups[o.service_id] = groups[o.service_id] || []).push(o); });
    const draw = q => {
      q = (q || "").trim().toLowerCase();
      const list = Object.values(groups).filter(g => !q || [g[0].name_es, g[0].name_pt, g[0].name_en].concat(g.map(o => o.provider || "")).join(" ").toLowerCase().includes(q));
      $("#pkList").innerHTML = list.map(g => {
        const s = g[0], n = counts(s), meta = [typeName(s.service_type_id), zoneName(s.zone_id), s.duration].filter(Boolean).join(" · ");
        const minAg = g.filter(o => o.agency_adult != null).reduce((a, o) => a == null || o.agency_adult < a ? o.agency_adult : a, null);
        return `<div class="pk"><div class="pk-h"><b>${esc(s.name_es)}</b><small>${meta ? esc(meta) + " · " : ""}menor hasta ${s.minor_age_max} años${s.infant_age_max != null ? " · bebés gratis hasta " + s.infant_age_max : ""}</small><small>Para este grupo: ${n.a} adulto${n.a === 1 ? "" : "s"}${n.m ? " · " + n.m + " menor" + (n.m > 1 ? "es" : "") : ""}${n.i ? " · " + n.i + " bebé" + (n.i > 1 ? "s" : "") + " sin cargo" : ""}</small></div>
          ${g.map(o => { const sub = o.public_adult == null ? null : n.a * Number(o.public_adult) + n.m * Number(o.public_minor || 0); const cost = o.agency_adult == null ? null : n.a * Number(o.agency_adult) + n.m * Number(o.agency_minor || 0);
            return `<div class="pk-o"><div class="grow">${priv ? `<b>${esc(o.provider || "")}</b>${g.length > 1 && o.agency_adult != null && o.agency_adult === minAg ? ' <span class="ist cerrada">menor costo</span>' : ""}<br>` : ""}<small>${o.public_adult == null ? `<span class="warn">sin valor en ${esc(periodLabel(ym))}: se agrega vacío y lo cargás a mano</span>` : `${money(o.public_adult)} adulto · ${money(o.public_minor)} menor → <b>${money(sub)}</b>`}${priv && cost != null && sub != null ? ` · costo ${money(cost)} · <span class="${sub - cost < 0 ? "neg" : "pos"}">gan. ${money(sub - cost)}</span>` : ""}</small></div><button class="btn sm primary" data-offer="${o.offer_id}" data-time="${esc(s.default_time || "")}">Agregar</button></div>`; }).join("")}</div>`;
      }).join("") || `<div class="empty">${cat.length ? "Nada coincide con la búsqueda." : "El catálogo está vacío: cargá servicios en Proveedores → Servicios."}</div>`;
    };
    $("#modal .box").innerHTML = `<h3>Agregar servicio</h3><p>${esc(dayLabel(day, days.indexOf(day) >= 0 ? days.indexOf(day) : null))} · valores de ${esc(periodLabel(ym))}</p>
      <div class="grid2"><div class="field"><label>Buscar</label><input id="pkQ" placeholder="Nombre del servicio${priv ? " o proveedor" : ""}…" autocomplete="off"></div><div class="field"><label>Horario (vacío = el sugerido)</label><input id="pkTime" type="time"></div></div>
      <div id="pkList" class="pk-list"></div><div class="acts"><button type="button" class="btn" id="mCancel">Cerrar</button></div>`;
    draw(""); $("#pkQ").focus();
    $("#pkQ").addEventListener("input", e => draw(e.target.value));
    $("#mCancel").addEventListener("click", closeModal);
    $("#pkList").addEventListener("click", async e => {
      const b = e.target.closest("button[data-offer]"); if (!b) return; b.disabled = true;
      try { await db.rpcOk("add_itinerary_item", { p_itin: I.itinId, p_offer: b.dataset.offer, p_day: day, p_time: $("#pkTime").value || null }); closeModal(); await reloadItin(true); toast("Servicio agregado.", "ok"); }
      catch (err) { toast(explainError(err), "bad"); b.disabled = false; }
    });
  }

  /* ---------- TRASLADOS (choferes propios): precio por tramo de pasajeros y por mes ---------- */
  function tiersActive() { return ((state.cat || {}).tiers || []).filter(t => t.active).sort((a, b) => a.pax_from - b.pax_from); }
  function tierLabel(t) { return t.pax_from + "–" + t.pax_to + " pax"; }
  function trfById(id) { return ((state.cat || {}).transfers || []).find(t => t.id === id); }
  function trfPrice(trfId, tierId, ym) { return ((state.cat || {}).tprices || []).find(p => p.transfer_id === trfId && p.tier_id === tierId && p.month === monthKey(ym)) || null; }

  function renderTrfList(q) {
    const P = state.prov, tiers = tiersActive();
    const rows = state.cat.transfers.filter(x => P.showOff || x.active).filter(x => !q || [x.name_es, x.name_pt, x.name_en].join(" ").toLowerCase().includes(q));
    const body = `<table class="money"><thead><tr><th>Traslado</th><th>Horario</th>${tiers.map(t => `<th class="r">${esc(tierLabel(t))}</th>`).join("")}<th></th></tr></thead><tbody>${rows.map(x => {
      const prs = tiers.map(t => trfPrice(x.id, t.id, P.month)), none = prs.every(p => !p || p.price == null);
      const miss = []; if (!x.name_pt) miss.push("nombre PT"); if (!x.name_en) miss.push("nombre EN");
      return `<tr class="row ${x.id === P.edit ? "sel" : ""} ${x.active ? "" : "off"}" data-id="${x.id}"><td><span class="name">${esc(x.name_es)}</span>${miss.length ? `<span class="sub warn">falta: ${esc(miss.join(", "))}</span>` : ""}${x.active ? "" : '<span class="sub">inactivo</span>'}</td><td class="num">${esc(x.default_time || "—")}</td>
        ${none ? `<td colspan="${tiers.length}" class="c"><span class="sub warn" style="display:inline">sin valores en ${esc(periodLabel(P.month))}</span></td>` : prs.map(p => `<td class="r">${p && p.price != null ? money(p.price) : '<span class="muted">—</span>'}</td>`).join("")}
        <td class="r"><button class="btn sm" data-act="months">Meses</button></td></tr>`;
    }).join("") || `<tr><td colspan="${tiers.length + 3}" class="empty">${q ? "Nada coincide con la búsqueda." : "Todavía no hay traslados. Tocá “+ Nuevo traslado”."}</td></tr>`}</tbody></table>`;
    return { body, count: rows.length };
  }

  function transferForm(el) {
    const P = state.prov, isNew = P.edit === "new";
    const x = isNew ? null : trfById(P.edit); if (!isNew && !x) { P.edit = null; el.innerHTML = ""; return; }
    const ed = can("editarProveedores"), dis = ed ? "" : "disabled", v = x || {}, tiers = tiersActive();
    const val = n => n == null ? "" : String(Number(n));
    el.innerHTML = `<div class="card form-card"><h3 class="t">${isNew ? "Nuevo traslado" : esc(x.name_es)}${x && !x.active ? ' <span class="st no_cerrado">inactivo</span>' : ""}<button class="x" type="button" id="tfClose" title="Cerrar">×</button></h3>
      <form id="trfForm" class="pad">
        <div class="grid3">
          <div class="field"><label>Nombre (español) *</label><input name="name_es" required value="${esc(v.name_es || "")}" ${dis} placeholder="Ej.: Aeropuerto MIA → Brickell"></div>
          <div class="field"><label>Nombre en portugués</label><input name="name_pt" value="${esc(v.name_pt || "")}" ${dis} placeholder="Aeroporto MIA → Brickell"></div>
          <div class="field"><label>Nombre en inglés</label><input name="name_en" value="${esc(v.name_en || "")}" ${dis}></div>
        </div>
        <div class="grid4"><div class="field"><label>Horario sugerido</label><input name="default_time" type="time" value="${esc(v.default_time || "")}" ${dis}></div></div>
        <div class="vals"><div class="vals-h"><b>Precios de ${esc(periodLabel(P.month))}</b> <span class="muted">· US$ por traslado (el vehículo completo), según cuántos pasajeros van</span>${x ? ` <button type="button" class="linkbtn" id="tfMonths">ver / cargar otros meses</button>` : ""}</div>
          <div class="tiers-grid">${tiers.map(t => { const p = x ? trfPrice(x.id, t.id, P.month) : null; return `<div class="field"><label>${esc(tierLabel(t))}</label><input inputmode="decimal" data-tier="${t.id}" value="${val(p && p.price)}" ${dis}></div>`; }).join("") || `<div class="muted">No hay tramos de pasajeros. Cargalos con “Tramos de pasajeros”.</div>`}</div>
          ${ed ? `<div class="vals-f"><span></span><label class="toggle"><input type="checkbox" name="all_year"> usar estos precios en los meses vacíos de ${P.month.slice(0, 4)}</label></div>` : ""}
        </div>
        <details ${v.desc_es || v.desc_pt || v.desc_en || v.notes ? "open" : ""}><summary>Descripción para el cliente y notas internas (opcional)</summary>
          <div class="grid3" style="margin-top:10px">
            <div class="field"><label>Descripción en español</label><textarea name="desc_es" rows="2" ${dis}>${esc(v.desc_es || "")}</textarea></div>
            <div class="field"><label>En portugués</label><textarea name="desc_pt" rows="2" ${dis}>${esc(v.desc_pt || "")}</textarea></div>
            <div class="field"><label>En inglés</label><textarea name="desc_en" rows="2" ${dis}>${esc(v.desc_en || "")}</textarea></div>
          </div>
          <div class="field"><label>Notas internas</label><textarea name="notes" rows="2" ${dis}>${esc(v.notes || "")}</textarea></div>
        </details>
        ${x ? `<div class="meta">Último cambio: ${esc(userName(x.updated_by))} · ${fmtDateLong(x.updated_at)} · <button type="button" class="linkbtn" id="tfHist">ver historial</button></div>` : ""}
        <div class="acts">${ed && x ? `<button type="button" class="btn ghost ${x.active ? "danger" : ""}" id="tfToggle">${x.active ? "Desactivar" : "Volver a activar"}</button>` : ""}<span class="grow"></span><button type="button" class="btn" id="tfCancel">${ed ? "Cancelar" : "Cerrar"}</button>${ed ? `<button class="btn primary" type="submit">${isNew ? "Crear traslado" : "Guardar"}</button>` : ""}</div>
      </form><div id="tfHistBox"></div></div>`;
    const form = $("#trfForm"); wireDirty(form);
    $("#tfClose").addEventListener("click", closeForm); $("#tfCancel").addEventListener("click", closeForm);
    if ($("#tfMonths")) $("#tfMonths").addEventListener("click", () => trfMonthsModal(x));
    if ($("#tfHist")) $("#tfHist").addEventListener("click", () => { $("#tfHistBox").className = "hist"; showHistory("#tfHistBox", "transfer_id", x.id); });
    if (!ed) return;
    if ($("#tfToggle")) $("#tfToggle").addEventListener("click", async () => {
      if (x.active && !confirm("¿Desactivar " + x.name_es + "? No se borra: deja de aparecer para armar itinerarios nuevos.")) return;
      await saveAndRefresh(async () => { await db.saveRow("transfers", x, { active: !x.active }); }, x.active ? "Traslado desactivado." : "Traslado activado.", true);
    });
    form.addEventListener("submit", async e => {
      e.preventDefault(); const f = e.target, t = k => f[k].value.trim() || null;
      const vals = {};
      for (const inp of $$("[data-tier]", f)) { const n = numOrNull(inp.value); if (Number.isNaN(n)) { toast("Hay un precio que no es un número.", "bad"); inp.focus(); return; } vals[inp.dataset.tier] = n; }
      const fields = { name_es: f.name_es.value.trim(), name_pt: t("name_pt"), name_en: t("name_en"), default_time: t("default_time"), desc_es: t("desc_es"), desc_pt: t("desc_pt"), desc_en: t("desc_en"), notes: t("notes") };
      const allYear = f.all_year && f.all_year.checked;
      await saveAndRefresh(async () => {
        const saved = await db.saveRow("transfers", x, fields);
        await saveTrfPrices(saved.id, P.month, vals, allYear);
      }, isNew ? "Traslado creado." : "Guardado.", true);
    });
  }
  // guarda los precios del mes (y si se pide, los copia a los meses vacíos del año); nunca pisa meses cargados
  async function saveTrfPrices(trfId, ym, vals, allYear) {
    const any = Object.values(vals).some(v => v != null);
    const months = allYear && any ? Array.from({ length: 12 }, (_, i) => ym.slice(0, 4) + "-" + pad(i + 1)) : [ym];
    for (const m of months) {
      const monthHasData = tiersActive().some(t => { const p = trfPrice(trfId, t.id, m); return p && p.price != null; });
      if (m !== ym && monthHasData) continue;
      for (const [tierId, price] of Object.entries(vals)) {
        const orig = trfPrice(trfId, tierId, m);
        if (!orig && price == null) continue;
        if (orig && sameVal(orig.price, price)) continue;
        await db.saveRow("transfer_prices", orig, orig ? { price } : { transfer_id: trfId, tier_id: tierId, month: monthKey(m), price });
      }
    }
  }
  function trfMonthsModal(x, year) {
    const P = state.prov, ed = can("editarProveedores"), tiers = tiersActive();
    const y = year || +P.month.slice(0, 4), months = Array.from({ length: 12 }, (_, i) => y + "-" + pad(i + 1));
    const dis = ed ? "" : "disabled", val = n => n == null ? "" : String(Number(n));
    openModal(`<h3>${esc(x.name_es)}</h3><p>Precio en US$ por traslado, según cuántos pasajeros van. Dejá vacío lo que no tenga precio.</p>
      <div class="row-y"><button class="btn sm" id="yPrev">← ${y - 1}</button><b>${y}</b><button class="btn sm" id="yNext">${y + 1} →</button></div>
      <form id="tmForm"><div class="tablewrap"><table class="money prices"><thead><tr><th>Mes</th>${tiers.map(t => `<th>${esc(tierLabel(t))}</th>`).join("")}</tr></thead>
      <tbody>${months.map((ym, i) => `<tr data-ym="${ym}"><td>${MESES[i].slice(0, 3)}</td>${tiers.map(t => { const p = trfPrice(x.id, t.id, ym); return `<td><input inputmode="decimal" data-tier="${t.id}" value="${val(p && p.price)}" ${dis}></td>`; }).join("")}</tr>`).join("")}</tbody></table></div>
      ${ed ? `<div class="acts" style="justify-content:space-between;flex-wrap:wrap"><button type="button" class="btn sm" id="tmFill">Repetir el primer mes en los vacíos</button><div style="display:flex;gap:8px"><button type="button" class="btn" id="mCancel">Cancelar</button><button type="submit" class="btn primary">Guardar precios</button></div></div>` : `<div class="acts"><button type="button" class="btn" id="mCancel">Cerrar</button></div>`}</form>`);
    $("#modal .box").classList.add("wide");
    $("#mCancel").addEventListener("click", closeModal);
    $("#yPrev").addEventListener("click", () => trfMonthsModal(x, y - 1)); $("#yNext").addEventListener("click", () => trfMonthsModal(x, y + 1));
    if (!ed) return;
    const form = $("#tmForm");
    $("#tmFill").addEventListener("click", () => {
      const rows = $$("tbody tr", form), src = rows.find(tr => $$("input", tr).some(i => i.value.trim() !== ""));
      if (!src) return toast("Cargá primero un mes.", "bad");
      rows.forEach(tr => { if ($$("input", tr).every(i => i.value.trim() === "")) $$("input", tr).forEach((i, k) => { i.value = $$("input", src)[k].value; }); });
    });
    form.addEventListener("submit", async e => {
      e.preventDefault(); const todo = [];
      for (const tr of $$("tbody tr", form)) for (const inp of $$("input", tr)) {
        const n = numOrNull(inp.value); if (Number.isNaN(n)) { toast("Hay un precio que no es un número.", "bad"); inp.focus(); return; }
        const orig = trfPrice(x.id, inp.dataset.tier, tr.dataset.ym);
        if ((!orig && n == null) || (orig && sameVal(orig.price, n))) continue;
        todo.push({ orig, fields: orig ? { price: n } : { transfer_id: x.id, tier_id: inp.dataset.tier, month: monthKey(tr.dataset.ym), price: n } });
      }
      if (!todo.length) { closeModal(); return toast("No había cambios."); }
      const btn = $("button[type=submit]", form); btn.disabled = true; setSync("busy", "Guardando…"); let ok = 0;
      try { for (const t of todo) { await db.saveRow("transfer_prices", t.orig, t.fields); ok++; } toast("Precios guardados.", "ok"); }
      catch (err) { toast((ok ? "Se guardaron " + ok + " precios, pero " : "") + catError(err), "bad"); }
      setSync("ok", ""); await db.loadCatalog().catch(() => { }); closeModal(); renderPvList(); renderPvDetail();
    });
  }
  function tiersModal() {
    const all = (state.cat.tiers || []).slice().sort((a, b) => a.pax_from - b.pax_from);
    const rows = all.map(t => Object.assign({}, t));
    const draw = () => {
      $("#tiList").innerHTML = rows.map((t, k) => `<div class="tier-row ${t.active === false ? "off" : ""}" data-k="${k}"><label>De</label><input type="number" min="1" data-f="pax_from" value="${t.pax_from || ""}"><label>a</label><input type="number" min="1" data-f="pax_to" value="${t.pax_to || ""}"><span>pasajeros</span>${t.id ? `<label class="toggle"><input type="checkbox" data-f="active" ${t.active !== false ? "checked" : ""}> en uso</label>` : `<button type="button" class="btn sm ghost danger" data-del="${k}">✕</button>`}</div>`).join("");
    };
    openModal(`<h3>Tramos de pasajeros</h3><p>Son los rangos de los vehículos. Cada traslado tiene un precio por tramo, y el itinerario elige el tramo según cuántos viajan (bebés incluidos, porque ocupan lugar).</p>
      <div id="tiList"></div><button type="button" class="btn sm" id="tiAdd">+ Agregar tramo</button>
      <div class="acts"><button type="button" class="btn" id="mCancel">Cancelar</button><button type="button" class="btn primary" id="tiSave">Guardar tramos</button></div>`);
    draw();
    $("#mCancel").addEventListener("click", closeModal);
    $("#tiAdd").addEventListener("click", () => { const last = rows.filter(r => r.active !== false).reduce((a, r) => Math.max(a, +r.pax_to || 0), 0); rows.push({ pax_from: last + 1, pax_to: last + 4, active: true }); draw(); });
    $("#tiList").addEventListener("input", e => { const k = +e.target.closest(".tier-row").dataset.k, f = e.target.dataset.f; rows[k][f] = f === "active" ? e.target.checked : parseInt(e.target.value, 10); });
    $("#tiList").addEventListener("change", e => { if (e.target.dataset.f === "active") { rows[+e.target.closest(".tier-row").dataset.k].active = e.target.checked; draw(); } });
    $("#tiList").addEventListener("click", e => { const b = e.target.closest("[data-del]"); if (b) { rows.splice(+b.dataset.del, 1); draw(); } });
    $("#tiSave").addEventListener("click", async () => {
      const act = rows.filter(r => r.active !== false).sort((a, b) => a.pax_from - b.pax_from);
      for (const r of act) if (!(r.pax_from >= 1 && r.pax_to >= r.pax_from)) return toast("Cada tramo necesita “de” y “a”, con “a” mayor o igual que “de”.", "bad");
      for (let i = 1; i < act.length; i++) if (act[i].pax_from <= act[i - 1].pax_to) return toast("Los tramos " + tierLabel(act[i - 1]) + " y " + tierLabel(act[i]) + " se superponen.", "bad");
      setSync("busy", "Guardando…");
      try {
        for (const r of rows) {
          const f = { pax_from: r.pax_from, pax_to: r.pax_to, active: r.active !== false };
          if (r.id) await db.saveRow("vehicle_tiers", all.find(o => o.id === r.id), f); else await db.saveRow("vehicle_tiers", null, f);
        }
        toast("Tramos guardados.", "ok");
      } catch (err) { toast(catError(err), "bad"); }
      setSync("ok", ""); await db.loadCatalog().catch(() => { }); closeModal(); renderProv();
    });
  }

  /* ---------- itinerario: elegir traslado ---------- */
  async function pickTransferModal(day) {
    const I = state.itin, it = I.edit.it, ym = day.slice(0, 7);
    const days = daysBetween(it.start_date, it.end_date), pax = (Number(it.adults) || 0) + agesCount(it.minors_ages);
    openModal(`<h3>Agregar traslado</h3><p>Cargando…</p>`); $("#modal .box").classList.add("wide");
    let list; try { I.trfCache = I.trfCache || {}; list = I.trfCache[ym] || (I.trfCache[ym] = await db.rpcRead("itin_transfers", { p_month: ym + "-01" })); } catch (err) { closeModal(); return toast(explainError(err), "bad"); }
    const draw = q => {
      q = (q || "").trim().toLowerCase();
      $("#ptList").innerHTML = list.filter(t => !q || [t.name_es, t.name_pt].join(" ").toLowerCase().includes(q)).map(t => {
        const tier = (t.tiers || []).find(x => pax >= x.from && pax <= x.to);
        return `<div class="pk-o" style="padding-left:14px"><div class="grow"><b>${esc(t.name_es)}</b><br><small>${tier ? (tier.price != null ? `Tramo ${tier.from}–${tier.to} pax → <b>${money(tier.price)}</b>` : `<span class="warn">sin precio para ${tier.from}–${tier.to} pax en ${esc(periodLabel(ym))}: se agrega vacío y lo cargás a mano</span>`) : `<span class="warn">ningún tramo cubre ${pax} pasajeros: se agrega vacío y lo cargás a mano</span>`}</small></div><button class="btn sm primary" data-trf="${t.transfer_id}">Agregar</button></div>`;
      }).join("") || `<div class="empty">${list.length ? "Nada coincide con la búsqueda." : "Todavía no hay traslados cargados: se cargan en Proveedores → Traslados."}</div>`;
    };
    $("#modal .box").innerHTML = `<h3>Agregar traslado</h3><p>${esc(dayLabel(day, days.indexOf(day) >= 0 ? days.indexOf(day) : null))} · ${pax} pasajero${pax === 1 ? "" : "s"} · precios de ${esc(periodLabel(ym))}</p>
      <div class="grid2"><div class="field"><label>Buscar</label><input id="ptQ" placeholder="Ej.: aeropuerto" autocomplete="off"></div><div class="field"><label>Horario (vacío = el sugerido)</label><input id="ptTime" type="time"></div></div>
      <div id="ptList" class="pk-list"></div><div class="acts"><button type="button" class="btn" id="mCancel">Cerrar</button></div>`;
    draw(""); $("#ptQ").focus(); $("#ptQ").addEventListener("input", e => draw(e.target.value));
    $("#mCancel").addEventListener("click", closeModal);
    $("#ptList").addEventListener("click", async e => {
      const b = e.target.closest("button[data-trf]"); if (!b) return; b.disabled = true;
      try { await db.rpcOk("add_itinerary_transfer", { p_itin: I.itinId, p_transfer: b.dataset.trf, p_day: day, p_time: $("#ptTime").value || null }); closeModal(); await reloadItin(true); toast("Traslado agregado. El precio se puede cambiar en la línea.", "ok"); }
      catch (err) { toast(explainError(err), "bad"); b.disabled = false; }
    });
  }

  /* ---------- pestaña “Itinerarios” en la ficha del cliente ---------- */
  async function renderClientItinTab(body, client) {
    body.innerHTML = `<div class="empty">Cargando…</div>`;
    let vs; try { vs = await db.itinVersions(client.id); } catch (err) { body.innerHTML = `<div class="placeholder"><b>No se pudo cargar</b>${esc(explainError(err))}</div>`; return; }
    if (!state.drawer || !state.drawer.client || state.drawer.client.id !== client.id || state.drawer.tab !== "itin") return;
    const ed = can("editarItinerarios");
    body.innerHTML = vs.length ? `<ul class="list">${vs.map(v => `<li><div class="grow"><b>Versión ${v.version}</b> ${statusTag(v.status)}<small> · ${v.status === "borrador" ? "editada " + fmtDateLong(v.updated_at) : v.status === "cerrada" ? "cerrada " + fmtDateLong(v.closed_at) : "enviada " + fmtDateLong(v.sent_at)}</small></div></li>`).join("")}</ul>
      <div style="margin-top:14px"><button class="btn primary" id="ciOpen">Abrir itinerario</button></div>`
      : `<div class="placeholder"><b>Todavía no tiene itinerario</b>Se arma con las fechas y pasajeros de esta ficha.${ed ? `<br><br><button class="btn gold" id="ciCreate">Armar itinerario</button>` : ""}</div>`;
    const go = create => { closeDrawer(true); openItinEditor(client.id, create); };
    if ($("#ciOpen")) $("#ciOpen").addEventListener("click", () => go(false));
    if ($("#ciCreate")) $("#ciCreate").addEventListener("click", () => go(true));
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
