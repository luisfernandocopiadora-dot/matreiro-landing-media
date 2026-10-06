const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const UMBLER_BASE = "https://app-utalk.umbler.com/api";
const TOKEN = process.env.UMBLER_TOKEN || "";
const ORG_ID = process.env.UMBLER_ORG_ID || "";
const CHANNEL_ID = process.env.UMBLER_CHANNEL_ID || "";
const TAG_ID = process.env.UMBLER_TAG_ID || "";

const allowedOrigins = new Set([
  "https://matreiro.com.br",
  "https://www.matreiro.com.br"
]);

const rate = new Map();

function send(res, status, body, origin="") {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
  if (allowedOrigins.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function clean(v, max=300) {
  return String(v ?? "").trim().slice(0, max);
}

function normalizePhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (!d.startsWith("55")) d = "55" + d;
  if (d.length < 12 || d.length > 13) return null;
  return "+" + d;
}

function qualify(qty) {
  const q = String(qty || "");
  if (q.includes("Mais de 100") || q.includes("+100")) return "🔥 Prioridade máxima";
  if (q.includes("51") || q.includes("100")) return "🟠 Alto potencial";
  if (q.includes("11") || q.includes("50")) return "🟡 Médio potencial";
  if (q.includes("4") || q.includes("10")) return "🟢 Pequeno pedido";
  return "🟢 Entrada";
}

function sourceName(src, medium, ref, gclid, fbclid) {
  const s = String(src || "").toLowerCase();
  if (s.includes("google") || gclid) return "Google Ads";
  if (s.includes("meta") || s.includes("facebook") || s.includes("instagram") || fbclid) return "Meta Ads";
  if (s.includes("chatgpt") || s.includes("openai")) return "ChatGPT / OpenAI Ads";
  if (s) return src;
  if (ref) {
    try {
      const h = new URL(ref).hostname.replace(/^www\./, "");
      if (h && !h.includes("matreiro.com.br")) return h;
    } catch {}
  }
  return "Direto / Orgânico";
}

async function umbler(path, options={}) {
  const r = await fetch(UMBLER_BASE + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + TOKEN,
      "Accept": "application/json",
      ...(options.body ? {"Content-Type":"application/json"} : {}),
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = {raw:text}; }
  if (!r.ok) {
    const e = new Error("Umbler " + r.status);
    e.status = r.status;
    e.data = data;
    throw e;
  }
  return data;
}

async function getOrCreateContact(name, phone) {
  try {
    const found = await umbler("/v1/contacts/phone/?organizationId=" + encodeURIComponent(ORG_ID) + "&phoneNumber=" + encodeURIComponent(phone));
    if (found && found.id) return found;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return await umbler("/v1/contacts/", {
    method:"POST",
    body: JSON.stringify({
      name,
      phoneNumber: phone,
      organizationId: ORG_ID
    })
  });
}

async function createOrGetChat(contactId) {
  return await umbler("/v1/chats/", {
    method:"POST",
    body: JSON.stringify({
      contactId,
      channelId: CHANNEL_ID,
      organizationId: ORG_ID
    })
  });
}

async function attachTag(chatId) {
  return await umbler("/v1/chats/" + encodeURIComponent(chatId) + "/tags/", {
    method:"POST",
    body: JSON.stringify({
      tagId: TAG_ID,
      organizationId: ORG_ID
    })
  });
}

async function addContactNote(contactId, content) {
  return await umbler("/v1/contacts/" + encodeURIComponent(contactId) + "/notes/", {
    method:"POST",
    body: JSON.stringify({
      content,
      organizationId: ORG_ID
    })
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";

  if (req.method === "OPTIONS") {
    if (!allowedOrigins.has(origin)) return send(res, 403, {ok:false}, origin);
    res.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "access-control-max-age": "86400",
      "vary":"Origin"
    });
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, {ok:true, service:"matreiro-leads"}, origin);
  }

  if (req.method !== "POST" || req.url !== "/lead") {
    return send(res, 404, {ok:false, error:"not_found"}, origin);
  }

  if (!allowedOrigins.has(origin)) {
    return send(res, 403, {ok:false, error:"origin_not_allowed"}, origin);
  }

  if (!TOKEN || !ORG_ID || !CHANNEL_ID || !TAG_ID) {
    return send(res, 503, {ok:false, error:"integration_not_configured"}, origin);
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const recent = (rate.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (recent.length >= 8) return send(res, 429, {ok:false, error:"too_many_requests"}, origin);
  recent.push(now); rate.set(ip, recent);

  let raw = "";
  req.on("data", chunk => {
    raw += chunk;
    if (raw.length > 20000) req.destroy();
  });

  req.on("end", async () => {
    try {
      const b = JSON.parse(raw || "{}");

      // Honeypot: bots tend to fill hidden fields.
      if (clean(b.website, 100)) return send(res, 200, {ok:true}, origin);

      const nome = clean(b.nome, 100);
      const phone = normalizePhone(b.whatsapp);
      const cidade = clean(b.cidade, 100);
      const prazo = clean(b.prazo, 100);
      const segmento = clean(b.segmento, 100);
      const quantidade = clean(b.quantidade, 100);
      const manga = clean(b.manga, 100);
      const arte = clean(b.arte, 180);

      if (!nome || !phone || !cidade || !prazo || !segmento || !quantidade || !manga || !arte) {
        return send(res, 400, {ok:false, error:"invalid_fields"}, origin);
      }

      const utmSource = clean(b.utm_source, 120);
      const utmMedium = clean(b.utm_medium, 120);
      const utmCampaign = clean(b.utm_campaign, 180);
      const utmContent = clean(b.utm_content, 180);
      const gclid = clean(b.gclid, 250);
      const fbclid = clean(b.fbclid, 250);
      const referrer = clean(b.referrer, 500);
      const pagina = clean(b.pagina, 500);
      const origem = sourceName(utmSource, utmMedium, referrer, gclid, fbclid);
      const classificacao = qualify(quantidade);

      const contact = await getOrCreateContact(nome, phone);
      const contactId = contact.id;
      if (!contactId) throw new Error("contact_id_missing");

      const chat = await createOrGetChat(contactId);
      const chatId = chat.id;
      if (!chatId) throw new Error("chat_id_missing");

      await attachTag(chatId);

      const note = [
        "🆕 NOVO LEAD — LANDING MATREIRO",
        "",
        "👤 CLIENTE",
        "Nome: " + nome,
        "WhatsApp: " + phone,
        "Cidade/UF: " + cidade,
        "",
        "🎯 PEDIDO",
        "Produto: " + segmento,
        "Quantidade: " + quantidade,
        "Manga: " + manga,
        "Arte: " + arte,
        "Prazo: " + prazo,
        "",
        "📊 QUALIFICAÇÃO",
        classificacao,
        "",
        "📣 ORIGEM DO LEAD",
        "Canal: " + origem,
        "utm_source: " + (utmSource || "-"),
        "utm_medium: " + (utmMedium || "-"),
        "Campanha: " + (utmCampaign || "-"),
        "Conteúdo: " + (utmContent || "-"),
        "gclid: " + (gclid ? "presente" : "-"),
        "fbclid: " + (fbclid ? "presente" : "-"),
        "",
        "✅ PRÓXIMA AÇÃO",
        "Entrar em contato com o cliente pelo WhatsApp.",
        "",
        "Página: " + (pagina || "-")
      ].join("\n");

      await addContactNote(contactId, note);

      return send(res, 200, {ok:true, leadId: chatId}, origin);
    } catch (e) {
      console.error("lead_error", e.status || "", e.data || e.message);
      return send(res, 502, {ok:false, error:"integration_error"}, origin);
    }
  });
});

async function validateIntegration() {
  if (!TOKEN || !ORG_ID || !CHANNEL_ID || !TAG_ID) {
    console.error("umbler_integration_config_missing");
    return;
  }

  try {
    const me = await umbler("/v1/members/me/");
    const orgs = Array.isArray(me && me.organizations) ? me.organizations : [];
    const org = orgs.find(o => o && o.id === ORG_ID);

    if (!org || org.active !== true) {
      throw new Error("organization_not_active");
    }

    const channel = await umbler(
      "/v1/channels/" + encodeURIComponent(CHANNEL_ID) +
      "/?organizationId=" + encodeURIComponent(ORG_ID)
    );

    const tag = await umbler(
      "/v1/tags/" + encodeURIComponent(TAG_ID) +
      "/?organizationId=" + encodeURIComponent(ORG_ID)
    );

    if (!channel || channel.id !== CHANNEL_ID) {
      throw new Error("channel_not_found");
    }

    if (!tag || tag.id !== TAG_ID) {
      throw new Error("tag_not_found");
    }

    console.log("umbler_integration_ok");
  } catch (e) {
    console.error("umbler_integration_check_failed", e.status || "", e.message || "unknown");
  }
}

server.listen(PORT, () => {
  console.log("matreiro-leads listening on", PORT);
  validateIntegration();
});
