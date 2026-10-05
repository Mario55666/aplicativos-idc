/* Envío de resultados al servidor del docente (NAS).
   Se carga al final de cada aplicativo:
     <script src="envio-resultados.js" data-actividad="actividad-1"></script>
   En una tarea del NAS basta con:  <script src="/envio-resultados.js"></script>
   Usa las variables globales del aplicativo: `state` y `buildMD()`.
   - Envía automáticamente el avance cada 45 s si hubo cambios.
   - Envía un latido cada 20 s para que el panel del docente muestre quién está conectado.
   - Añade un botón "Enviar al docente" junto a cada botón de Markdown.
   - Si no hay conexión, reintenta hasta lograrlo. */
(function () {
  "use strict";

  // Dirección pública del servidor del NAS (Tailscale Funnel), p. ej.
  // "https://aplicativos-idc.tu-red.ts.net". Solo se usa cuando el aplicativo
  // se abre desde otra dirección (por ejemplo, la copia de GitHub Pages).
  var SERVIDOR_PUBLICO = "";

  var me = document.currentScript;
  // En las tareas del NAS (/tarea-05/…) la actividad se toma de la dirección si el script no la indica.
  var ACTIVIDAD = (me && me.dataset.actividad) || (location.pathname.match(/\/(tarea-\d\d)\//) || [])[1] || "desconocida";
  var INTERVALO_MS = 45000;
  var LATIDO_MS = 20000;
  var LS_ENVIO = "idc-envio-" + ACTIVIDAD;

  function endpoint() {
    if (location.protocol === "file:") return null;
    if (location.hostname.endsWith("github.io")) {
      return SERVIDOR_PUBLICO ? SERVIDOR_PUBLICO.replace(/\/$/, "") + "/api/resultados" : null;
    }
    return "/api/resultados";
  }

  function leer() { try { return JSON.parse(localStorage.getItem(LS_ENVIO)) || {}; } catch (e) { return {}; } }
  function guardar(o) { try { localStorage.setItem(LS_ENVIO, JSON.stringify(o)); } catch (e) {} }

  function estado() { return (typeof state !== "undefined" && state) ? state : null; }
  function estudiante() { var s = estado(); return s && s.student ? s.student : null; }
  function claveEstudiante(st) {
    return [st.apellidos || "", st.nombres || "", st.email || ""].join("|").toLowerCase();
  }

  // Un identificador por estudiante y navegador: si otro estudiante se registra
  // en la misma computadora, se genera uno nuevo y no se mezclan los resultados.
  function idEnvio(st) {
    var reg = leer(), clave = claveEstudiante(st);
    if (!reg.id || reg.clave !== clave) {
      var rnd = (crypto && crypto.randomUUID) ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      reg = { id: rnd.replace(/[^a-z0-9-]/gi, "").toLowerCase(), clave: clave, ultimaHuella: "" };
      guardar(reg);
    }
    return reg;
  }

  function huella(txt) { // hash corto para saber si el estado cambió
    var h = 0;
    for (var i = 0; i < txt.length; i++) h = (h * 31 + txt.charCodeAt(i)) | 0;
    return txt.length + ":" + h;
  }

  function paquete() {
    var s = estado(), st = estudiante();
    if (!st) return null;
    var reg = idEnvio(st), md = "";
    try { if (typeof buildMD === "function") md = buildMD(); } catch (e) { md = ""; }
    var json = JSON.stringify(s);
    return {
      reg: reg,
      huella: huella(json),
      cuerpo: JSON.stringify({
        id: reg.id,
        actividad: ACTIVIDAD,
        pagina: location.pathname.split("/").pop() || "index.html",
        estudiante: { nombres: st.nombres || "", apellidos: st.apellidos || "", email: st.email || "" },
        enviadoEn: new Date().toISOString(),
        estado: s,
        informeMd: md
      })
    };
  }

  var enCurso = false;
  var ultimoRtt = null; // tiempo de respuesta del servidor en el último envío o latido (ms)
  function enviar(manual) {
    var url = endpoint();
    if (!url) { if (manual) aviso("Abre la actividad desde el enlace del curso para poder enviar tus resultados.", "warn"); return; }
    var p = paquete();
    if (!p) { if (manual) aviso("Primero regístrate e inicia la actividad.", "warn"); return; }
    if (!manual && p.huella === p.reg.ultimaHuella) return; // sin cambios
    if (enCurso) return;
    enCurso = true;
    if (manual) aviso("Enviando…", "info");
    var t0 = Date.now();
    fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: p.cuerpo, keepalive: p.cuerpo.length < 60000 })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function () {
        ultimoRtt = Date.now() - t0;
        var reg = leer(); reg.ultimaHuella = p.huella; reg.ultimoEnvio = Date.now(); reg.pendiente = false; guardar(reg);
        aviso("✓ Resultados enviados a tu docente · " + hora(Date.now()), "ok");
        if (manual && typeof toast === "function") toast("✔ Resultados enviados a tu docente", true);
      })
      .catch(function () {
        var reg = leer(); reg.pendiente = true; guardar(reg);
        aviso("⚠ No se pudo enviar. Se reintentará automáticamente. Descarga también tu informe PDF.", "warn");
      })
      .then(function () { enCurso = false; });
  }

  // Latido: aviso pequeño para que el panel del docente sepa quién está conectado ahora.
  function latido(visible) {
    var url = endpoint(), st = estudiante();
    if (!url || !st) return;
    var cuerpo = JSON.stringify({
      id: idEnvio(st).id, actividad: ACTIVIDAD, visible: visible, rtt: ultimoRtt,
      estudiante: { nombres: st.nombres || "", apellidos: st.apellidos || "" }
    });
    url = url.replace(/\/resultados$/, "/latido");
    if (!visible && navigator.sendBeacon) { navigator.sendBeacon(url, new Blob([cuerpo], { type: "text/plain;charset=UTF-8" })); return; }
    var t0 = Date.now();
    fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: cuerpo, keepalive: true })
      .then(function (r) { if (r.ok) ultimoRtt = Date.now() - t0; }).catch(function () {});
  }

  // Al cerrar la pestaña: último intento con sendBeacon (solo si cabe y hubo cambios).
  function alSalir() {
    var url = endpoint(), p = paquete();
    if (!url || !p || p.huella === p.reg.ultimaHuella || !navigator.sendBeacon || p.cuerpo.length > 60000) return;
    navigator.sendBeacon(url, new Blob([p.cuerpo], { type: "text/plain;charset=UTF-8" }));
  }

  function hora(ts) { return new Date(ts).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }); }

  // ---------- Interfaz ----------
  var css = document.createElement("style");
  css.textContent =
    "#idcEnvio{position:fixed;left:12px;bottom:12px;z-index:60;max-width:min(360px,calc(100vw - 24px));" +
    "background:var(--surface,#fff);color:var(--ink,#1b1f24);border:1.5px solid var(--line,#dde3ea);border-radius:12px;" +
    "padding:8px 12px;font:500 .8rem/1.35 Inter,system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.12)}" +
    "#idcEnvio.ok{border-color:var(--ok,#2b8a3e)}#idcEnvio.warn{border-color:var(--warn,#c77700);background:var(--sun-soft,#fdf1d6)}" +
    ".idc-enviar{margin-top:8px}";
  document.head.appendChild(css);

  var caja = document.createElement("div");
  caja.id = "idcEnvio"; caja.setAttribute("role", "status"); caja.setAttribute("aria-live", "polite");
  caja.textContent = "Tus respuestas se envían automáticamente a tu docente.";
  document.body.appendChild(caja);
  function aviso(txt, tipo) { caja.textContent = txt; caja.className = tipo || ""; }

  function boton(bloque) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn primary idc-enviar" + (bloque ? " block full" : "");
    b.textContent = "📤 Enviar resultados al docente";
    b.onclick = function () { enviar(true); };
    return b;
  }
  // Los aplicativos vuelven a dibujar sus paneles, así que se observa el DOM.
  function insertarBotones() {
    document.querySelectorAll('#mdBtn, [onclick="downloadMD()"]').forEach(function (md) {
      var sig = md.nextElementSibling;
      if (sig && sig.classList.contains("idc-enviar")) return;
      var bloque = md.classList.contains("block") || md.classList.contains("full");
      md.insertAdjacentElement("afterend", boton(bloque));
    });
  }
  insertarBotones();
  new MutationObserver(insertarBotones).observe(document.body, { childList: true, subtree: true });

  // Las descargas de informe también disparan un envío.
  ["downloadMD", "downloadPDF"].forEach(function (fn) {
    var orig = window[fn];
    if (typeof orig !== "function") return;
    window[fn] = function () { var r = orig.apply(this, arguments); setTimeout(function () { enviar(false); }, 300); return r; };
  });

  var reg = leer();
  if (reg.pendiente) aviso("⚠ Hay resultados pendientes de envío. Reintentando…", "warn");
  else if (reg.ultimoEnvio) aviso("✓ Último envío a tu docente · " + hora(reg.ultimoEnvio), "ok");
  if (!endpoint()) aviso("Abre la actividad desde el enlace del curso para que tus resultados lleguen a tu docente.", "warn");

  setInterval(function () { enviar(false); }, INTERVALO_MS);
  setInterval(function () { if (document.visibilityState === "visible") latido(true); }, LATIDO_MS);
  window.addEventListener("online", function () { enviar(false); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { alSalir(); latido(false); } else latido(true);
  });
  window.addEventListener("pagehide", function () { alSalir(); latido(false); });
  setTimeout(function () { latido(true); }, 1500);
  setTimeout(function () { enviar(false); }, 3000);
})();
