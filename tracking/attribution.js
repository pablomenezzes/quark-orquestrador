/*!
 * Quark - Script de atribuicao (secao 12.2 do orquestrador-marketing-quark.md)
 *
 * Uso: colar entre as tags de script, numa tag "HTML personalizado" do GTM (ou no cabecalho do site)
 * (container web unico), disparo "All Pages" com Consent Settings exigindo analytics_storage.
 * Configuracao opcional ANTES do script: window.QUARK_ATTR_CONFIG = { ... } (ver DEFAULTS).
 *
 * Responsabilidade: o navegador CAPTURA identificadores. Nao envia conversao nenhuma.
 * Nao coleta e-mail nem telefone. Sem dependencias. ES5 de proposito (roda em qualquer tema).
 */
(function (window, document) {
  'use strict';
  if (window.QuarkAttribution) return;

  var DEFAULTS = {
    cookiePrefix: 'qk_',
    // Ex: '.quark.com.br' para compartilhar entre subdominios. Vazio = so o host atual.
    cookieDomain: '',
    lidDays: 400,
    firstTouchDays: 400,
    lastTouchDays: 90,
    // Hosts cujos links/iframes recebem os parametros (Fillout, diagnostico).
    decorateHosts: ['fillout.com', 'form.fillout.com'],
    // Referrers que NAO contam como novo toque (dominio proprio, gateways de pagamento, o proprio Fillout).
    ignoreReferrerHosts: [],
    // utm_source cujo utm_content e o ad.id da Meta (convencao 12.1).
    metaSources: ['meta', 'facebook', 'fb', 'instagram', 'ig'],
    // Funcao opcional que devolve { marketing: bool, analytics: bool }.
    getConsent: null,
    honeypotName: 'website_hp'
  };

  var cfg = {};
  var user = window.QUARK_ATTR_CONFIG || {};
  var k;
  for (k in DEFAULTS) cfg[k] = Object.prototype.hasOwnProperty.call(user, k) ? user[k] : DEFAULTS[k];

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var CLICK_KEYS = ['gclid', 'gbraid', 'wbraid', 'fbclid'];
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  // ---------- utilidades ----------
  function uuid() {
    var c = window.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h[0] + h[1] + h[2] + h[3] + '-' + h[4] + h[5] + '-' + h[6] + h[7] + '-' + h[8] + h[9] + '-' + h[10] + h[11] + h[12] + h[13] + h[14] + h[15];
  }

  function getCookie(name) {
    try {
      var parts = document.cookie ? document.cookie.split('; ') : [];
      for (var i = 0; i < parts.length; i++) {
        var idx = parts[i].indexOf('=');
        if (parts[i].slice(0, idx) === name) return decodeURIComponent(parts[i].slice(idx + 1));
      }
    } catch (e) {}
    return '';
  }

  function setCookie(name, value, days) {
    try {
      var s = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + Math.round(days * 86400) + '; SameSite=Lax';
      if (cfg.cookieDomain) s += '; domain=' + cfg.cookieDomain;
      if (window.location.protocol === 'https:') s += '; Secure';
      document.cookie = s;
    } catch (e) {}
  }

  function readJson(name) {
    var raw = getCookie(name);
    if (!raw) return null;
    try {
      var o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : null;
    } catch (e) {
      return null;
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function hostMatches(host, list) {
    for (var i = 0; i < list.length; i++) {
      var d = String(list[i]).toLowerCase();
      if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
    }
    return false;
  }

  function stripUrl(url) {
    try {
      var u = new URL(url);
      return u.origin + u.pathname.replace(/\/+$/, '');
    } catch (e) {
      return '';
    }
  }

  function inList(v, list) {
    v = String(v || '').toLowerCase();
    for (var i = 0; i < list.length; i++) if (list[i] === v) return true;
    return false;
  }

  // ---------- identificador do lead ----------
  var LID_COOKIE = cfg.cookiePrefix + 'lid';
  var FT_COOKIE = cfg.cookiePrefix + 'ft';
  var LT_COOKIE = cfg.cookiePrefix + 'lt';

  var params = new URLSearchParams(window.location.search);

  function ensureLeadId() {
    var fromUrl = params.get('lid');
    var current = getCookie(LID_COOKIE);
    var lid = current;
    // Ciclo do diagnostico (secao 5): ?lid= tem prioridade e so vale se for UUID.
    if (fromUrl && UUID_RE.test(fromUrl)) lid = fromUrl;
    if (!UUID_RE.test(lid)) lid = uuid();
    if (lid !== current) setCookie(LID_COOKIE, lid, cfg.lidDays);
    return lid;
  }

  // ---------- toques (primeiro e ultimo) ----------
  function currentTouch() {
    var t = { ts: Date.now() };
    var any = false;
    var i;
    for (i = 0; i < UTM_KEYS.length; i++) {
      var v = params.get(UTM_KEYS[i]);
      if (v) {
        t[UTM_KEYS[i]] = v;
        any = true;
      }
    }
    for (i = 0; i < CLICK_KEYS.length; i++) {
      var c = params.get(CLICK_KEYS[i]);
      if (c) {
        t[CLICK_KEYS[i]] = c;
        any = true;
      }
    }
    var ref = document.referrer || '';
    var refHost = hostOf(ref);
    var ownHost = window.location.hostname.toLowerCase();
    var external = !!refHost && refHost !== ownHost && !hostMatches(refHost, cfg.ignoreReferrerHosts);
    if (external) t.referrer = ref;
    t.landing_url = stripUrl(window.location.href);
    return { touch: t, hasSignal: any || external };
  }

  function sameSignal(a, b) {
    if (!a || !b) return false;
    var keys = UTM_KEYS.concat(CLICK_KEYS, ['referrer']);
    for (var i = 0; i < keys.length; i++) if ((a[keys[i]] || '') !== (b[keys[i]] || '')) return false;
    return true;
  }

  function storeTouches() {
    var cur = currentTouch();
    var ft = readJson(FT_COOKIE);
    var lt = readJson(LT_COOKIE);
    if (!ft) {
      // Primeiro toque: guarda mesmo que seja direto.
      ft = cur.touch;
      setCookie(FT_COOKIE, JSON.stringify(ft), cfg.firstTouchDays);
    }
    // Ultimo toque: so muda com sinal novo (UTM, click id ou referrer externo). Visita direta nao apaga o toque anterior.
    if (!lt || (cur.hasSignal && !sameSignal(cur.touch, lt))) {
      lt = cur.touch;
      setCookie(LT_COOKIE, JSON.stringify(lt), cfg.lastTouchDays);
    }
    return { first: ft, last: lt };
  }

  // ---------- ids de plataformas ----------
  function gaClientId() {
    // Cookie _ga = GA1.1.<id>.<timestamp>  =>  client_id = "<id>.<timestamp>"
    var m = /^GA\d\.\d+\.(\d+\.\d+)$/.exec(getCookie('_ga'));
    return m ? m[1] : '';
  }

  function fbp() {
    return getCookie('_fbp');
  }

  function fbcFor(touch) {
    if (touch && touch.fbclid) return 'fb.1.' + touch.ts + '.' + touch.fbclid;
    return getCookie('_fbc');
  }

  function granted(entry) {
    if (!entry) return false;
    return entry.update !== undefined ? entry.update === true : entry.default === true;
  }

  function consent() {
    var out = { marketing: false, analytics: false };
    try {
      if (typeof cfg.getConsent === 'function') {
        var c = cfg.getConsent() || {};
        return { marketing: !!c.marketing, analytics: !!c.analytics };
      }
      // Consent Mode v2: le o estado atual, quando o GTM expoe. Desconhecido => false (LGPD: conservador).
      var entries = window.google_tag_data && window.google_tag_data.ics && window.google_tag_data.ics.entries;
      if (entries) {
        out.marketing = granted(entries.ad_storage);
        out.analytics = granted(entries.analytics_storage);
      }
    } catch (e) {}
    return out;
  }

  // ---------- estado ----------
  var state = {
    lead_id: ensureLeadId(),
    event_id: uuid()
  };
  var touches = storeTouches();

  function attribution() {
    var t = touches.last || {};
    var isMeta = inList(t.utm_source, cfg.metaSources);
    return {
      utm_source: t.utm_source || '',
      utm_medium: t.utm_medium || '',
      utm_campaign: t.utm_campaign || '',
      utm_term: t.utm_term || '',
      utm_content: t.utm_content || '',
      gclid: t.gclid || '',
      gbraid: t.gbraid || '',
      wbraid: t.wbraid || '',
      fbclid: t.fbclid || '',
      fbp: fbp(),
      fbc: fbcFor(t),
      ga_client_id: gaClientId(),
      ad_id: isMeta ? t.utm_content || '' : '',
      landing_url: t.landing_url || stripUrl(window.location.href),
      referrer: t.referrer || '',
      user_agent: navigator.userAgent || ''
    };
  }

  function flat() {
    var a = attribution();
    var c = consent();
    a.lead_id = state.lead_id;
    a.event_id = state.event_id;
    a.consent_marketing = c.marketing ? 'true' : 'false';
    a.consent_analytics = c.analytics ? 'true' : 'false';
    a.first_touch = JSON.stringify(touches.first || {});
    return a;
  }

  // ---------- campos ocultos ----------
  function setValue(el, value) {
    if (el.value === value) return;
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    // Frameworks (React em Lovable/Vercel) so enxergam a mudanca com o evento.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillHiddenFields(root) {
    var data = flat();
    var inputs = (root || document).querySelectorAll('input, textarea');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var name = el.getAttribute('name') || '';
      // Elementor usa name="form_fields[<id>]"; os demais usam name="<id>".
      var m = /^form_fields\[(.+)\]$/.exec(name);
      var key = m ? m[1] : name;
      if (key === cfg.honeypotName) continue;
      if (Object.prototype.hasOwnProperty.call(data, key)) setValue(el, data[key]);
    }
  }

  // ---------- links e iframes (Fillout / diagnostico) ----------
  var PASS_KEYS = UTM_KEYS.concat(['gclid', 'gbraid', 'wbraid', 'fbclid', 'fbp', 'fbc', 'ga_client_id', 'ad_id', 'landing_url', 'referrer']);

  function decorateUrl(url) {
    var u;
    try {
      u = new URL(url, window.location.href);
    } catch (e) {
      return url;
    }
    var a = attribution();
    u.searchParams.set('lid', state.lead_id);
    for (var i = 0; i < PASS_KEYS.length; i++) {
      var key = PASS_KEYS[i];
      var v = a[key];
      if (v && !u.searchParams.has(key)) u.searchParams.set(key, v);
    }
    return u.toString();
  }

  function shouldDecorate(url) {
    var h = hostOf(new URL(url, window.location.href).href);
    return !!h && hostMatches(h, cfg.decorateHosts);
  }

  function decorateAnchors(root) {
    var links = (root || document).querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      try {
        if (shouldDecorate(href)) links[i].setAttribute('href', decorateUrl(href));
      } catch (e) {}
    }
  }

  function decorateIframes(root) {
    var frames = (root || document).querySelectorAll('iframe[src]');
    for (var i = 0; i < frames.length; i++) {
      var src = frames[i].getAttribute('src');
      try {
        if (shouldDecorate(src) && !/[?&]lid=/.test(src)) frames[i].setAttribute('src', decorateUrl(src));
      } catch (e) {}
    }
  }

  // ---------- dataLayer ----------
  function pushLead(opts) {
    opts = opts || {};
    window.dataLayer = window.dataLayer || [];
    var payload = {
      event: 'generate_lead',
      form_id: opts.form_id || '',
      lp_id: opts.lp_id || '',
      lead_id: state.lead_id,
      event_id: state.event_id
    };
    window.dataLayer.push(payload);
    // Cada envio bem-sucedido consome o event_id; o proximo formulario ganha outro.
    state.event_id = uuid();
    fillHiddenFields();
    return payload;
  }

  // ---------- inicializacao ----------
  function run(root) {
    fillHiddenFields(root);
    decorateAnchors(root);
    decorateIframes(root);
  }

  function init() {
    run(document);
    // Formularios que aparecem depois (popups do Elementor, componentes React).
    if (window.MutationObserver) {
      var pending = false;
      new MutationObserver(function () {
        if (pending) return;
        pending = true;
        setTimeout(function () {
          pending = false;
          run(document);
        }, 150);
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
    // Garante o link decorado com dados frescos no instante do clique.
    document.addEventListener(
      'click',
      function (ev) {
        var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
        if (!a) return;
        try {
          var href = a.getAttribute('href');
          if (shouldDecorate(href)) a.setAttribute('href', decorateUrl(href));
        } catch (e) {}
      },
      true
    );
    // Antes do envio, repreenche (o _ga pode ter sido criado depois do carregamento).
    document.addEventListener(
      'submit',
      function (ev) {
        fillHiddenFields(ev.target && ev.target.querySelectorAll ? ev.target : document);
      },
      true
    );
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.QuarkAttribution = {
    version: '1.0.0',
    /** Objeto no formato do campo `attribution` do contrato (secao 7), mais lead_id e event_id. */
    get: function () {
      var a = attribution();
      var c = consent();
      return { lead_id: state.lead_id, event_id: state.event_id, attribution: a, consent: c, first_touch: touches.first };
    },
    leadId: function () {
      return state.lead_id;
    },
    eventId: function () {
      return state.event_id;
    },
    decorateUrl: decorateUrl,
    fillHiddenFields: fillHiddenFields,
    /** Chamar no envio BEM-SUCEDIDO de cada formulario. Dispara o evento generate_lead no dataLayer. */
    pushLead: pushLead
  };
})(window, document);
