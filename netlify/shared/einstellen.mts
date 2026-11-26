import { db, getSettings, imgKey, saveDraft, type Shop } from "./store.mts";
import { anzeigeInKampagne, bildHochladen, cdata, esc, merkmaleFuer, produktsicherheitXml, trading } from "./ebay.mts";
import { fehlendeAngaben } from "./ki.mts";

async function bilderHochladen(d: any) {
  d.ebayBilder = d.ebayBilder || [];
  const shop = d.shop as Shop;
  // Bilder sind 7 Tage ohne Angebot gültig – bei Shop-Wechsel neu hochladen
  if (d.ebayBilderShop && d.ebayBilderShop !== shop) d.ebayBilder = [];
  const todo: number[] = [];
  for (let i = 0; i < Math.min(d.bilder, 24); i++) if (!d.ebayBilder[i]) todo.push(i);
  let pos = 0;
  const worker = async () => {
    while (pos < todo.length) {
      const i = todo[pos++];
      const buf = (await db().get(imgKey(d.id, i, "voll"), { type: "arrayBuffer" })) as ArrayBuffer | null;
      if (!buf) throw new Error(`Foto ${i + 1} fehlt.`);
      d.ebayBilder[i] = await bildHochladen(shop, buf, `${d.id}-${i}.jpg`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  d.ebayBilderShop = shop;
  d.ebayBilder = d.ebayBilder.slice(0, Math.min(d.bilder, 24));
}

/** Lagerplatz (z. B. #17) ans Ende des Titels – Titel wird bei Bedarf gekürzt (max. 80 Zeichen) */
export function titelMitLager(titel: string, tag: string) {
  const t = [...String(titel || "").replace(/\s*#\S+\s*$/, "").trim()];
  if (!tag) return t.slice(0, 80).join("");
  const platz = 80 - [...tag].length - 1;
  let w = t.join("").split(/\s+/);
  // ganze Wörter von hinten weglassen, bis es passt
  while (w.length > 1 && [...w.join(" ")].length > platz) w.pop();
  const kurz = [...w.join(" ")].slice(0, platz).join("");
  return `${kurz} ${tag}`;
}

/** (nicht mehr genutzt) Lagerplatz unten in die Beschreibung */
function mitLagerplatz(html: string, tag: string) {
  if (!tag || html.includes(tag)) return html;
  const zeile = `<p style="margin:14px 0 0;font-size:12px;color:#888">${esc(tag)}</p>`;
  // als letzte Zeile INNERHALB des Beschreibungs-Designs (vor dem letzten </div>)
  const t = html.trimEnd(), i = t.toLowerCase().lastIndexOf("</div>");
  if (i >= 0 && t.slice(i + 6).trim() === "") return t.slice(0, i) + zeile + t.slice(i);
  return `${t}\n${zeile}`;
}

/** Pflicht-Hinweise (Batterie, unter 3 Jahren) unten in die Beschreibung – innerhalb des Designs, nicht doppelt */
export function mitPflichthinweisen(html: string, f: { batterie?: boolean; u3?: boolean }, s: any) {
  let t = String(html || "").trimEnd();
  const bloecke: string[] = [];
  const absatz = (txt: string) => esc(txt).replace(/\n\s*\n/g, "</p><p style=\"margin:6px 0 0\">").replace(/\n/g, "<br>");
  if (f.u3 && !/unter\s*3\s*Jahr|unter\s*drei\s*Jahr|0\s*-\s*3\s*Jahr|36\s*Monat/i.test(t) && s.hinweise?.u3Text)
    bloecke.push(`<p style="margin:16px 0 0;font-weight:600">⚠️ ${esc(s.hinweise.u3Text)}</p>`);
  if (f.batterie && !/Batterieentsorgung/i.test(t) && s.hinweise?.batterieText) {
    const [kopf, ...rest] = String(s.hinweise.batterieText).split(/\n\s*\n/);
    bloecke.push(`<div style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#555"><p style="margin:0;font-weight:600">${esc(kopf)}</p><p style="margin:6px 0 0">${absatz(rest.join("\n\n"))}</p></div>`);
  }
  if (!bloecke.length) return t;
  const zusatz = bloecke.join("");
  const i = t.toLowerCase().lastIndexOf("</div>");
  if (i >= 0 && t.slice(i + 6).trim() === "") return t.slice(0, i) + zusatz + t.slice(i);
  return `${t}\n${zusatz}`;
}

/** Kreuzchen eines Entwurfs – bei Nicideen standardmäßig beide an */
export const hinweisFlags = (d: any) => ({ batterie: d.batterie ?? d.shop === "nicideen", u3: d.u3 ?? d.shop === "nicideen" });

/** eBay-Produktsicherheit passend zu den Kreuzchen */
export function sicherheitFuer(f: { batterie?: boolean; u3?: boolean }, s: any) {
  const h = s.hinweise || {};
  return produktsicherheitXml(
    [f.u3 ? h.u3Statement : "", f.batterie ? h.batterieStatement : ""],
    [f.u3 ? h.u3Piktogramm : ""]
  );
}

/**
 * Werte eines Merkmals passend zu eBays Regeln: Bei Merkmalen, die nur EINEN Wert erlauben (z. B. oft „Farbe“),
 * werden mehrere Werte zusammengefasst – „Mehrfarbig“, wenn eBay das anbietet, sonst „Blau / Weiß“ oder der erste Wert.
 */
export function merkmalWerte(name: string, werte: any, aspekt?: any) {
  let vals = (Array.isArray(werte) ? werte : [werte])
    .map((v: any) => String(v).trim())
    .filter(Boolean);
  vals = [...new Set(vals)].slice(0, 30);
  if (vals.length > 1 && aspekt && !aspekt.mehrfach) {
    const liste: string[] = aspekt.werte || [];
    const mehrfarbig = /farbe/i.test(name) && liste.find((w) => /^mehrfarbig$/i.test(w));
    if (mehrfarbig) vals = [mehrfarbig];
    else if (aspekt.nurAuswahl) vals = [vals[0]];
    else vals = [vals.join(" / ").slice(0, 65)];
  }
  return vals;
}

function itemXml(d: any, s: any, aspekte: any[] = []) {
  const p = s.shops[d.shop].profile;
  const nachName = new Map(aspekte.map((a: any) => [String(a.name).toLowerCase(), a]));
  const merkmale = Object.entries(d.merkmale || {})
    .map(([name, werte]: any) => {
      const vals = merkmalWerte(name, werte, nachName.get(String(name).toLowerCase()));
      if (!vals.length) return "";
      return `<NameValueList><Name>${esc(name)}</Name>${vals.map((v: string) => `<Value>${esc(v.slice(0, 65))}</Value>`).join("")}</NameValueList>`;
    })
    .join("");
  const zustandText = d.zustandId !== "1000" && d.zustandText ? `<ConditionDescription>${esc(String(d.zustandText).slice(0, 1000))}</ConditionDescription>` : "";
  return `<Item>
<Title>${esc(titelMitLager(d.titel, d.lagerplatz))}</Title>
<Description>${cdata(mitPflichthinweisen(d.beschreibung || "", hinweisFlags(d), s))}</Description>
<PrimaryCategory><CategoryID>${esc(d.kategorieId)}</CategoryID></PrimaryCategory>
<StartPrice currencyID="EUR">${Number(d.preis).toFixed(2)}</StartPrice>
<ConditionID>${esc(d.zustandId)}</ConditionID>${zustandText}
<Country>DE</Country><Currency>EUR</Currency>
<PostalCode>${esc(s.standort.plz)}</PostalCode>${s.standort.ort ? `<Location>${esc(s.standort.ort)}</Location>` : ""}
<ListingDuration>GTC</ListingDuration><ListingType>FixedPriceItem</ListingType><Quantity>${Math.max(1, parseInt(d.menge) || 1)}</Quantity>
<SKU>${esc(d.lagerplatz || d.id)}</SKU>
<PictureDetails>${(d.ebayBilder || []).map((u: string) => `<PictureURL>${esc(u)}</PictureURL>`).join("")}</PictureDetails>
<SellerProfiles>
<SellerShippingProfile><ShippingProfileID>${esc(p.shipping)}</ShippingProfileID></SellerShippingProfile>
<SellerReturnProfile><ReturnProfileID>${esc(p.return)}</ReturnProfileID></SellerReturnProfile>
<SellerPaymentProfile><PaymentProfileID>${esc(p.payment)}</PaymentProfileID></SellerPaymentProfile>
</SellerProfiles>
${d.shopKategorieId ? `<Storefront><StoreCategoryID>${esc(d.shopKategorieId)}</StoreCategoryID></Storefront>` : ""}
${merkmale ? `<ItemSpecifics>${merkmale}</ItemSpecifics>` : ""}
${d.ean ? `<ProductListingDetails><EAN>${esc(d.ean)}</EAN></ProductListingDetails>` : ""}
${s.preisvorschlagErlauben ? `<BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>` : ""}
${sicherheitFuer(hinweisFlags(d), s)}
</Item>`;
}

function gebuehren(data: any) {
  const fees = data.Fees?.Fee || [];
  const liste = fees
    .map((f: any) => ({ name: f.Name, betrag: Number(f.Fee?.["#text"] ?? f.Fee ?? 0) }))
    .filter((f: any) => f.betrag > 0);
  return { summe: liste.reduce((a: number, f: any) => a + f.betrag, 0), liste };
}

/** pruefen=true: nur prüfen (VerifyAddFixedPriceItem), sonst wirklich einstellen */
export async function einstellen(d: any, pruefen: boolean) {
  const s = await getSettings();
  const fehlt = fehlendeAngaben(d, s);
  if (fehlt.length) throw new Error(`Es fehlt noch: ${fehlt.join(", ")}`);

  await bilderHochladen(d);
  await saveDraft(d);

  const call = pruefen ? "VerifyAddFixedPriceItem" : "AddFixedPriceItem";
  // Merkmal-Regeln der Kategorie (ein oder mehrere Werte erlaubt?)
  const aspekte = (d.kategorien || []).find((k: any) => k.id === d.kategorieId)?.aspekte || (await merkmaleFuer(d.kategorieId).catch(() => []));
  const { data, warnungen } = await trading(d.shop, call, itemXml(d, s, aspekte));
  d.warnungen = warnungen.map((w: any) => w.text);
  d.gebuehren = gebuehren(data);
  if (pruefen) {
    d.geprueft = Date.now();
    d.fehler = "";
    return d;
  }
  d.itemId = String(data.ItemID);
  d.status = "eingestellt";
  d.eingestellt = Date.now();
  d.fehler = "";

  // Werbung (z. B. 5 %) – nur wenn eine Kampagne gewählt ist
  const kamp = s.shops[d.shop].kampagne;
  if (kamp) {
    try {
      await anzeigeInKampagne(d.shop, kamp, d.itemId, Number(s.werbungProzent) || 5);
      d.werbung = `${s.werbungProzent} %`;
    } catch (e: any) {
      d.warnungen.push(`Werbung konnte nicht gesetzt werden: ${e.message}`);
    }
  }

  // Große Fotos löschen (die kleinen bleiben als Vorschau)
  for (let i = 0; i < d.bilder; i++) await db().delete(imgKey(d.id, i, "voll")).catch(() => {});
  return d;
}
