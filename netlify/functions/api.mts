import type { Config, Context } from "@netlify/functions";
import {
  SHOPS, checkAuth, db, draftKey, getDraft, getJSON, getSettings, imgKey, json, saveDraft, setJSON, sha, type Shop,
} from "../shared/store.mts";
import { consentUrl, exchangeCode, hasCreds, kategorieVorschlaege, merkmaleFuer, syncShop, zustaendeFuer } from "../shared/ebay.mts";
import { einstellen } from "../shared/einstellen.mts";
import { fehlendeAngaben } from "../shared/ki.mts";

const isShop = (s: any): s is Shop => SHOPS.includes(s);
/** „17“, „#17“, „# 17“ → „#17“ */
const lagerTag = (v: any) => {
  const t = String(v ?? "").trim().replace(/^#+\s*/, "").slice(0, 20);
  return t ? `#${t}` : "";
};
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const EDITIERBAR = [
  "shop", "titel", "preis", "kategorieId", "shopKategorieId", "zustandId", "zustandText", "merkmale", "ean",
  "beschreibung", "hinweis", "shopWunsch", "preisWunsch", "kategorien", "status", "abgehakt", "lagerplatz", "menge",
];

function seite(titel: string, text: string) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${titel}</title>
<body style="font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;background:#f6f4f1;color:#2b2b2b">
<div style="text-align:center;max-width:460px"><h2>${titel}</h2><p>${text}</p><p><a href="/" style="color:#7a4fd6">Zurück zur Einstellhilfe</a></p></div>
<script>setTimeout(()=>location.href="/",2500)</script>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "");
  const m = req.method;
  const seg = path.split("/").filter(Boolean);

  try {
    // ---------- ohne Login ----------
    if (m === "POST" && path === "/auth/setup") {
      const { key } = await req.json();
      if (!key || String(key).length < 20) return json({ fehler: "Ungültig" }, 400);
      const salt = crypto.randomUUID();
      const { modified } = await db().setJSON("auth", { salt, hash: await sha(salt + key) }, { onlyIfNew: true });
      if (!modified) return json({ fehler: "Passwort ist schon festgelegt." }, 409);
      return json({ ok: true });
    }
    // eBay-Pflicht: Benachrichtigung über gelöschte eBay-Konten (wir speichern keine Daten fremder Nutzer)
    if (path === "/ebay/loeschung") {
      if (m === "GET") {
        const code = url.searchParams.get("challenge_code") || "";
        const token = Netlify.env.get("EBAY_LOESCH_TOKEN") || "nicis_einstellhilfe_1acc000b8f6f29169214c5c5f923d2d4";
        const endpoint = `${url.origin}/api/ebay/loeschung`;
        return json({ challengeResponse: await sha(code + token + endpoint) });
      }
      return new Response(null, { status: 200 });
    }
    if (m === "GET" && path === "/ebay/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || "";
      const st: any = await getJSON(`oauthstate/${state.replace(/[^a-z0-9-]/gi, "")}`);
      if (!code || !st || st.zeit < Date.now() - 15 * 60e3)
        return seite("Verbindung abgebrochen", "Die eBay-Anmeldung wurde abgebrochen oder ist abgelaufen. Bitte noch einmal auf „Mit eBay verbinden“ klicken.");
      await db().delete(`oauthstate/${state}`);
      await exchangeCode(st.shop, code);
      let name = "";
      try {
        const d = await syncShop(st.shop);
        name = d.user;
      } catch {}
      return seite("Verbunden ✓", `Der Shop ist jetzt mit eBay verbunden${name ? ` (Konto: ${name})` : ""}.`);
    }

    // ---------- Login prüfen ----------
    const auth = await checkAuth(req);
    if (auth !== "ok") return json({ fehler: auth === "setup" ? "setup" : "login" }, 401);

    if (m === "GET" && path === "/auth/check") return json({ ok: true });

    if (m === "GET" && path === "/state") {
      const settings = await getSettings();
      const shops: any = {};
      for (const s of SHOPS) {
        const [t, d]: any = await Promise.all([getJSON(`token/${s}`), getJSON(`shopdaten/${s}`)]);
        shops[s] = {
          verbunden: !!t?.refresh_token,
          ablauf: t?.refresh_expires || 0,
          daten: d
            ? { ...d, beispiele: (d.beispiele || []).map((b: any) => ({ ...b, html: undefined, hatHtml: !!b.html })) }
            : null,
        };
      }
      return json({
        settings,
        shops,
        konfig: { ebay: hasCreds(), ki: true },
      });
    }

    if (m === "PUT" && path === "/settings") {
      const neu = await req.json();
      const alt = await getSettings();
      await setJSON("settings", { ...alt, ...neu });
      return json(await getSettings());
    }

    if (m === "POST" && path === "/ebay/connect") {
      const { shop } = await req.json();
      if (!isShop(shop)) return json({ fehler: "Unbekannter Shop" }, 400);
      const state = crypto.randomUUID();
      await setJSON(`oauthstate/${state}`, { shop, zeit: Date.now() });
      return json({ url: consentUrl(state) });
    }

    if (m === "POST" && path === "/ebay/sync") {
      const { shop } = await req.json();
      if (!isShop(shop)) return json({ fehler: "Unbekannter Shop" }, 400);
      const d = await syncShop(shop);
      return json({ ok: true, hinweise: d.hinweise });
    }

    if (m === "GET" && seg[0] === "shopdaten" && isShop(seg[1])) {
      return json(await getJSON(`shopdaten/${seg[1]}`));
    }

    if (m === "GET" && seg[0] === "kategorie" && seg[1]) {
      const [aspekte, z] = await Promise.all([merkmaleFuer(seg[1]), zustaendeFuer([seg[1]])]);
      return json({ aspekte, zustaende: z[seg[1]] });
    }
    if (m === "GET" && path === "/kategorie-suche") {
      return json(await kategorieVorschlaege(url.searchParams.get("q") || ""));
    }

    // ---------- Entwürfe ----------
    if (m === "GET" && path === "/drafts") {
      const { blobs } = await db().list({ prefix: "drafts/" });
      const s = await getSettings();
      const list = (await Promise.all(blobs.map((b) => getJSON(b.key)))).filter(Boolean);
      list.sort((a: any, b: any) => b.erstellt - a.erstellt);
      return json(list.map((d: any) => ({ ...d, fehlt: d.status === "fertig" ? fehlendeAngaben(d, s) : [] })));
    }
    if (m === "POST" && path === "/drafts") {
      const b = await req.json();
      const d = {
        id: rid(),
        erstellt: Date.now(),
        status: "neu",
        bilder: Math.min(Number(b.bilder) || 0, 24),
        hochgeladen: 0,
        name: String(b.name || "").slice(0, 120),
        hinweis: String(b.hinweis || "").slice(0, 2000),
        shopWunsch: b.shopWunsch || "auto",
        preisWunsch: b.preisWunsch ? Number(String(b.preisWunsch).replace(",", ".")) : null,
        lagerplatz: lagerTag(b.lagerplatz),
        menge: Math.min(Math.max(parseInt(b.menge) || 1, 1), 999),
      };
      await saveDraft(d);
      return json(d);
    }
    if (seg[0] === "drafts" && seg[1]) {
      const d: any = await getDraft(seg[1]);
      if (!d) return json({ fehler: "Entwurf nicht gefunden" }, 404);

      if (m === "GET" && seg.length === 2) return json(d);

      if (m === "PUT" && seg.length === 2) {
        const b = await req.json();
        for (const k of EDITIERBAR) if (k in b) d[k] = b[k];
        if ("preis" in b) d.preis = Number(String(b.preis).replace(",", ".")) || 0;
        if ("lagerplatz" in b) d.lagerplatz = lagerTag(b.lagerplatz);
        if ("menge" in b) d.menge = Math.min(Math.max(parseInt(b.menge) || 1, 1), 999);
        await saveDraft(d);
        return json(d);
      }
      if (m === "DELETE" && seg.length === 2) {
        const { blobs } = await db().list({ prefix: `img/${d.id}/` });
        await Promise.all(blobs.map((x) => db().delete(x.key)));
        await db().delete(draftKey(d.id));
        return json({ ok: true });
      }
      // Foto hochladen: PUT /drafts/:id/bild/:n/:art  (art = voll | ki)
      if (m === "PUT" && seg[2] === "bild") {
        const n = Number(seg[3]);
        const art = seg[4] === "voll" ? "voll" : "ki";
        if (!(n >= 0 && n < 24)) return json({ fehler: "Ungültig" }, 400);
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 4_400_000) return json({ fehler: "Foto zu groß" }, 413);
        await db().set(imgKey(d.id, n, art), buf);
        return json({ ok: true });
      }
      // Foto ansehen: GET /drafts/:id/bild/:n?t=...
      if (m === "GET" && seg[2] === "bild") {
        const buf = await db().get(imgKey(d.id, Number(seg[3]), "ki"), { type: "arrayBuffer" });
        if (!buf) return new Response("", { status: 404 });
        return new Response(buf as ArrayBuffer, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
      }
      if (m === "POST" && seg[2] === "einstellen") {
        const { pruefen } = await req.json().catch(() => ({ pruefen: false }));
        if (d.status === "eingestellt") return json({ fehler: "Schon eingestellt" }, 409);
        try {
          const r = await einstellen(d, !!pruefen);
          await saveDraft(r);
          return json(r);
        } catch (e: any) {
          d.fehler = e.message;
          d.fehlerDetails = e.details?.fehler || null;
          await saveDraft(d);
          return json({ ...d }, 422);
        }
      }
    }

    return json({ fehler: "Nicht gefunden" }, 404);
  } catch (e: any) {
    console.error(e);
    return json({ fehler: e.message || "Unbekannter Fehler" }, 500);
  }
};

export const config: Config = {
  path: "/api/*",
  excludedPath: ["/api/analyse"],
};
