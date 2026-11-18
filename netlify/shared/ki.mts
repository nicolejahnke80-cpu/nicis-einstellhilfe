import { db, getJSON, getSettings, imgKey, type Shop } from "./store.mts";
import { kategorieVorschlaege, merkmaleFuer, vergleichsAngebote, zustaendeFuer } from "./ebay.mts";

const MODELL = () => Netlify.env.get("KI_MODELL") || "claude-sonnet-5-5";
const MAX_KI_BILDER = 8;

/** Schlanker Claude-Client (Netlify AI Gateway setzt ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL automatisch) */
function claude() {
  const key = Netlify.env.get("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  const base = (Netlify.env.get("ANTHROPIC_BASE_URL") || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  if (!key) throw new Error("Kein KI-Zugang: ANTHROPIC_API_KEY fehlt (AI Gateway noch nicht aktiv?).");
  return {
    messages: {
      async create(body: any) {
        for (let versuch = 0; versuch < 3; versuch++) {
          const r = await fetch(`${base}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
            body: JSON.stringify(body),
          });
          const j: any = await r.json().catch(() => ({}));
          if (r.ok) return j;
          if ((r.status === 429 || r.status >= 500) && versuch < 2) {
            await new Promise((ok) => setTimeout(ok, 4000 * (versuch + 1)));
            continue;
          }
          throw new Error(`KI-Fehler ${r.status}: ${j?.error?.message || "unbekannt"}`);
        }
      },
    },
  };
}

const STANDARD_VORLAGE: Record<Shop, string> = {
  nicideen: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:800px;margin:0 auto;background:#f2f2f2;padding:24px;border-radius:12px;color:#333">
<h2 style="margin-top:0">[Artikelname]</h2>
<p>[Kurze Beschreibung]</p>
<h3>Zustand</h3><p>[Zustand]</p>
<h3>Lieferumfang</h3><ul><li>[…]</li></ul>
<p style="font-size:13px;color:#666">Privatverkauf aus Sammlung · Versand versichert</p>
</div>`,
  wonderland: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:800px;margin:0 auto;padding:24px;color:#333">
<h2 style="margin-top:0">[Artikelname]</h2>
<p>[Kurze Beschreibung]</p>
<h3>Zustand</h3><p>[Zustand]</p>
<h3>Lieferumfang</h3><ul><li>[…]</li></ul>
</div>`,
};

function shopBlock(shop: Shop, s: any, daten: any) {
  const cfg = s.shops[shop];
  const vorlage = cfg.vorlageHtml?.trim() || daten?.beispiele?.[0]?.html || STANDARD_VORLAGE[shop];
  const kats = (daten?.storeKategorien || []).map((k: any) => `${k.id} = ${k.pfad}`).join("\n") || "(noch keine Shop-Kategorien geladen)";
  const beispiele = (daten?.beispiele || [])
    .map((b: any) => {
      const sk = daten.storeKategorien?.find((k: any) => k.id === b.shopKategorieId);
      return `- „${b.titel}“ → Shop-Kategorie: ${sk ? sk.pfad : b.shopKategorieId || "–"} · eBay-Kategorie: ${b.kategorie?.name || "–"} · ${b.preis} €`;
    })
    .join("\n");
  const titel = (daten?.titel || []).slice(0, 60).map((t: string) => `- ${t}`).join("\n");
  return `## Shop „${cfg.name}“ (Kürzel: ${shop})
Was gehört hierher: ${cfg.fokus}
Stilregeln: ${cfg.stil}

### Eigene Shop-Kategorien (ID = Pfad)
${kats}

### Beispiele aus ihren aktuellen Angeboten
${beispiele || "(keine)"}

### Weitere echte Titel von ihr (Stil, Aufbau, Schreibweise übernehmen)
${titel || "(keine)"}

### Beschreibungsvorlage (HTML) für diesen Shop
<vorlage shop="${shop}">
${vorlage}
</vorlage>`;
}

const ANGEBOT_TOOL: any = {
  name: "angebot_entwurf",
  description: "Gibt den fertigen Angebotsentwurf zurück.",
  input_schema: {
    type: "object",
    properties: {
      artikel: { type: "string", description: "Was genau ist das? Marke, Modell, Plattform, Edition, Region, Anzahl – so präzise wie auf den Fotos erkennbar." },
      shop: { type: "string", enum: ["nicideen", "wonderland"] },
      suchbegriff: { type: "string", description: "Kurzer eBay-Suchbegriff (2–6 Wörter) zum Finden der eBay-Kategorie und vergleichbarer Angebote, ohne Emojis und Füllwörter." },
      titel: { type: "string", description: "eBay-Titel, höchstens 80 Zeichen (Emojis zählen mit), im Stil ihrer Titel." },
      shop_kategorie_id: { type: "string", description: "ID aus der Liste der Shop-Kategorien des gewählten Shops, oder leer wenn keine passt." },
      zustand_stufe: { type: "string", enum: ["neu", "neu_sonstige", "wie_neu", "sehr_gut", "gut", "akzeptabel", "defekt"] },
      zustand_text: { type: "string", description: "Ehrliche, kurze Zustandsbeschreibung (max. 1000 Zeichen) – nur was auf den Fotos sichtbar ist oder im Hinweis steht." },
      ean: { type: "string", description: "EAN/Barcode-Nummer, falls auf einem Foto lesbar, sonst leer." },
      merkmale: {
        type: "object",
        description: "Artikelmerkmale als Name → Wert (deutsch, eBay-üblich: z. B. Marke, Plattform, Modell, Produktart, Farbe, Material, Altersempfehlung, Spielname, Region, Erscheinungsjahr …).",
        additionalProperties: { type: "string" },
      },
      beschreibung_html: { type: "string", description: "Komplette Artikelbeschreibung als HTML nach der Vorlage des gewählten Shops." },
      preis_idee: { type: "number", description: "Grobe eigene Preis-Idee in Euro (wird später mit echten eBay-Angeboten abgeglichen)." },
      sicherheit: { type: "string", enum: ["hoch", "mittel", "niedrig"], description: "Wie sicher ist die Erkennung insgesamt?" },
      hinweise: { type: "string", description: "Kurze Hinweise an Nicole: Unsicherheiten, was sie prüfen/ergänzen sollte. Leer, wenn nichts." },
    },
    required: ["artikel", "shop", "suchbegriff", "titel", "zustand_stufe", "zustand_text", "merkmale", "beschreibung_html", "sicherheit"],
  },
};

const DETAILS_TOOL: any = {
  name: "ebay_details",
  description: "Gibt eBay-Kategorie, Zustand, Merkmale und Preis zurück.",
  input_schema: {
    type: "object",
    properties: {
      kategorie_id: { type: "string" },
      zustand_id: { type: "string" },
      merkmale: {
        type: "object",
        description: "Name → Liste von Werten. Namen exakt wie in der Merkmalsliste der gewählten Kategorie.",
        additionalProperties: { type: "array", items: { type: "string" } },
      },
      preis: { type: "number", description: "Empfohlener Sofort-Kaufen-Preis in Euro, z. B. 24.99" },
      preis_begruendung: { type: "string", description: "1–2 Sätze, wie der Preis zustande kommt." },
    },
    required: ["kategorie_id", "zustand_id", "merkmale", "preis", "preis_begruendung"],
  },
};

function toolInput(msg: any, name: string) {
  const b = msg.content.find((c: any) => c.type === "tool_use" && c.name === name);
  if (!b) throw new Error("Die KI hat keinen Entwurf geliefert.");
  return b.input;
}

export async function analysiere(draft: any) {
  const s = await getSettings();
  const [dN, dW] = await Promise.all([getJSON("shopdaten/nicideen"), getJSON("shopdaten/wonderland")]);
  const client = claude();

  // --- Bilder laden ---
  const n = Math.min(draft.bilder, MAX_KI_BILDER);
  const bilder: any[] = [];
  for (let i = 0; i < n; i++) {
    const buf = (await db().get(imgKey(draft.id, i, "ki"), { type: "arrayBuffer" })) as ArrayBuffer | null;
    if (buf) bilder.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(buf).toString("base64") } });
  }
  if (!bilder.length) throw new Error("Keine Fotos gefunden.");

  const system = `Du bist die Einstellhilfe von Nicole, einer eBay-Händlerin aus Deutschland mit zwei Shops. Du bekommst Fotos EINES Artikels und erstellst daraus ein komplettes, verkaufsfertiges eBay-Angebot – exakt in ihrem Stil.

Grundregeln:
- Alles auf Deutsch.
- Wähle den passenden Shop anhand von „Was gehört hierher“ und ihrer Shop-Kategorien.
- Titel: max. 80 Zeichen, im Stil ihrer echten Titel (Aufbau, Reihenfolge, Schreibweise, Emoji-Regeln des Shops). Wichtige Suchbegriffe nach vorn. Keine Wörter wie „TOP“, „L@@K“, keine Großbuchstaben-Orgien, außer sie macht das selbst so.
- Beschreibung: Übernimm die Vorlage des gewählten Shops 1:1 in Aufbau, HTML, CSS, Farben, Überschriften und festen Textbausteinen (z. B. Versand-, Rechts- oder Grußtexte). Ersetze nur die artikelbezogenen Inhalte. Kein JavaScript, keine externen Bilder einfügen.
- Ehrlich bleiben: Nichts behaupten, was nicht auf den Fotos zu sehen ist oder im Hinweis von Nicole steht (z. B. „getestet“, „funktioniert“, „vollständig“). Sichtbare Mängel nennen.
- Sie zahlt den Versand selbst (für Käufer versandkostenfrei) – das darf in Titel/Beschreibung nur stehen, wenn es in ihrer Vorlage so steht.
- Wenn die Fotos mehrere verschiedene Artikel zeigen, behandle sie als ein Konvolut/Set.

${shopBlock("nicideen", s, dN)}

${shopBlock("wonderland", s, dW)}`;

  const nutzer: string[] = [];
  if (draft.hinweis) nutzer.push(`Hinweis von Nicole: ${draft.hinweis}`);
  if (draft.shopWunsch && draft.shopWunsch !== "auto") nutzer.push(`Shop ist vorgegeben: ${draft.shopWunsch}`);
  if (draft.preisWunsch) nutzer.push(`Preiswunsch von Nicole: ${draft.preisWunsch} €`);
  nutzer.push("Erstelle das Angebot und gib es über das Werkzeug angebot_entwurf zurück.");

  const m1 = await client.messages.create({
    model: MODELL(),
    max_tokens: 10000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [ANGEBOT_TOOL],
    tool_choice: { type: "tool", name: "angebot_entwurf" },
    messages: [{ role: "user", content: [...bilder, { type: "text", text: nutzer.join("\n") }] }],
  });
  const a = toolInput(m1, "angebot_entwurf");
  const shop: Shop = draft.shopWunsch && draft.shopWunsch !== "auto" ? draft.shopWunsch : a.shop === "nicideen" ? "nicideen" : "wonderland";

  // --- eBay: Kategorien, Vergleich, Merkmale, Zustände ---
  const [vorschlaege, vergleich] = await Promise.all([
    kategorieVorschlaege(a.suchbegriff).catch(() => [] as any[]),
    vergleichsAngebote(a.suchbegriff).catch(() => [] as any[]),
  ]);
  const zaehler: Record<string, { n: number; name: string }> = {};
  for (const v of vergleich)
    for (const id of v.kategorieIds.slice(0, 1)) {
      zaehler[id] = zaehler[id] || { n: 0, name: v.kategorieName || "" };
      zaehler[id].n++;
    }
  const ausVergleich = Object.entries(zaehler)
    .sort((x, y) => y[1].n - x[1].n)
    .slice(0, 2)
    .map(([id, v]) => ({ id, name: v.name, pfad: `${v.name} (bei ${v.n} ähnlichen Angeboten genutzt)` }));
  const kandidaten: any[] = [];
  for (const k of [...ausVergleich, ...vorschlaege]) if (!kandidaten.find((x) => x.id === k.id)) kandidaten.push(k);
  const top = kandidaten.slice(0, 4);
  // Pfade für Vergleichs-Kategorien aus den Vorschlägen übernehmen, wenn vorhanden
  for (const k of top) {
    const v = vorschlaege.find((x: any) => x.id === k.id);
    if (v) k.pfad = v.pfad;
  }
  const [zustaende, ...aspekteListe] = await Promise.all([
    zustaendeFuer(top.map((k) => k.id)),
    ...top.map((k) => merkmaleFuer(k.id).catch(() => [])),
  ]);
  top.forEach((k, i) => {
    k.aspekte = aspekteListe[i];
    k.zustaende = zustaende[k.id];
  });

  let d: any = null;
  if (top.length) {
    const kandText = top
      .map(
        (k) => `### Kategorie ${k.id}: ${k.pfad}
Zustände: ${k.zustaende.map((z: any) => `${z.id}=${z.name}`).join(", ")}
Merkmale:
${k.aspekte
  .filter((x: any) => x.pflicht || x.empfohlen)
  .slice(0, 35)
  .map((x: any) => `- ${x.name}${x.pflicht ? " (PFLICHT)" : ""}${x.mehrfach ? " (mehrere Werte möglich)" : ""}${x.nurAuswahl ? " (nur Werte aus Liste)" : ""}${x.werte.length ? `: ${x.werte.slice(0, 25).join(" | ")}` : ""}`)
  .join("\n")}`
      )
      .join("\n\n");
    const vergText = vergleich
      .slice(0, 25)
      .map((v: any) => `- ${v.gesamt.toFixed(2)} € gesamt (${v.preis.toFixed(2)} + ${v.versand.toFixed(2)} Versand) · ${v.zustand || "?"} · ${v.titel}`)
      .join("\n");

    const m2 = await client.messages.create({
      model: MODELL(),
      max_tokens: 3000,
      tools: [DETAILS_TOOL],
      tool_choice: { type: "tool", name: "ebay_details" },
      messages: [
        {
          role: "user",
          content: `Artikel: ${a.artikel}
Titel: ${a.titel}
Zustand laut Fotos: ${a.zustand_stufe} – ${a.zustand_text}
Erkannte Merkmale: ${JSON.stringify(a.merkmale)}
${a.ean ? `EAN: ${a.ean}` : ""}
Preis-Idee: ${a.preis_idee ?? "–"} €${draft.preisWunsch ? `\nPreiswunsch von Nicole: ${draft.preisWunsch} € (dann diesen nehmen)` : ""}

Wähle die passendste eBay-Kategorie, den passenden Zustand (ID aus der Liste dieser Kategorie) und fülle die Merkmale dieser Kategorie aus (alle PFLICHT-Merkmale unbedingt; bei „nur Werte aus Liste“ exakt einen Listenwert; sonst sinnvolle Werte, unbekanntes weglassen).

Preis: Die Verkäuferin bietet kostenlosen Versand an. Vergleiche daher mit den GESAMTpreisen (Preis + Versand) wirklich vergleichbarer Angebote (gleicher Artikel, ähnlicher Zustand). Ziel: zügig verkaufen, aber nicht verschenken – leicht unter dem mittleren vergleichbaren Gesamtpreis, auf ,99 oder ,95 / ,00 enden lassen. Wenn keine vergleichbaren Angebote dabei sind, schätze realistisch.

${kandText}

## Aktuelle Vergleichsangebote auf eBay.de (Sofort-Kaufen)
${vergText || "(keine gefunden)"}`,
        },
      ],
    });
    d = toolInput(m2, "ebay_details");
  }

  const kat = top.find((k) => k.id === String(d?.kategorie_id)) || top[0];
  const daten: any = shop === "nicideen" ? dN : dW;
  const shopKatOk = daten?.storeKategorien?.some((k: any) => k.id === String(a.shop_kategorie_id));

  return {
    shop,
    titel: String(a.titel || "").slice(0, 80),
    beschreibung: a.beschreibung_html,
    zustandText: a.zustand_text,
    ean: a.ean || "",
    shopKategorieId: shopKatOk ? String(a.shop_kategorie_id) : "",
    kategorieId: kat?.id || "",
    kategorien: top.map((k) => ({ id: k.id, pfad: k.pfad, aspekte: k.aspekte, zustaende: k.zustaende })),
    zustandId: d?.zustand_id ? String(d.zustand_id) : kat?.zustaende?.[0]?.id || "3000",
    merkmale: d?.merkmale || Object.fromEntries(Object.entries(a.merkmale || {}).map(([k, v]) => [k, [String(v)]])),
    preis: Number(draft.preisWunsch) || Number(d?.preis) || Number(a.preis_idee) || 0,
    ki: {
      artikel: a.artikel,
      suchbegriff: a.suchbegriff,
      sicherheit: a.sicherheit,
      hinweise: a.hinweise || "",
      preisBegruendung: d?.preis_begruendung || "",
      vergleich: vergleich.slice(0, 12),
    },
  };
}

/** Fehlende Pflichtangaben für das Einstellen */
export function fehlendeAngaben(d: any, s: any) {
  const f: string[] = [];
  if (!d.titel) f.push("Titel");
  if (!d.preis || d.preis <= 0) f.push("Preis");
  if (!d.kategorieId) f.push("eBay-Kategorie");
  const kat = d.kategorien?.find((k: any) => k.id === d.kategorieId);
  for (const a of kat?.aspekte || []) if (a.pflicht && !(d.merkmale?.[a.name] || []).filter(Boolean).length) f.push(`Merkmal „${a.name}“`);
  const p = s.shops[d.shop]?.profile || {};
  if (!p.shipping || !p.payment || !p.return) f.push("Versand-/Zahlungs-/Rückgabe-Profil (Einstellungen)");
  if (!s.standort?.plz) f.push("Artikelstandort-PLZ (Einstellungen)");
  return f;
}
