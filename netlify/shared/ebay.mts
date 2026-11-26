import { XMLParser } from "fast-xml-parser";
import { getJSON, setJSON, type Shop } from "./store.mts";

const API = "https://api.ebay.com";
const SITE_ID = "77"; // eBay.de
const TREE_ID = "77";
const COMPAT = () => Netlify.env.get("EBAY_COMPAT_LEVEL") || "1451";

/** Berechtigungen der ersten Version – Tokens ohne gespeicherte Scopes wurden damit erteilt */
const ALTE_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
].join(" ");
const ANALYTICS_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly";
export const SCOPES = `${ALTE_SCOPES} ${ANALYTICS_SCOPE}`;

/** Hat die Verbindung dieses Shops schon die Berechtigung für Traffic-Zahlen? */
export async function hatTrafficRecht(shop: Shop) {
  const t: any = await getJSON(`token/${shop}`);
  return !!t?.refresh_token && String(t.scopes || ALTE_SCOPES).includes(ANALYTICS_SCOPE);
}

export class EbayError extends Error {
  details: any;
  constructor(msg: string, details?: any) {
    super(msg);
    this.details = details;
  }
}

function creds() {
  const id = Netlify.env.get("EBAY_CLIENT_ID");
  const secret = Netlify.env.get("EBAY_CLIENT_SECRET");
  const runame = Netlify.env.get("EBAY_RUNAME");
  if (!id || !secret || !runame)
    throw new EbayError("eBay-Schlüssel fehlen noch (EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME in Netlify eintragen).");
  return { id, secret, runame };
}
export const hasCreds = () =>
  !!(Netlify.env.get("EBAY_CLIENT_ID") && Netlify.env.get("EBAY_CLIENT_SECRET") && Netlify.env.get("EBAY_RUNAME"));

export const esc = (s: any) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
export const cdata = (s: string) => `<![CDATA[${String(s ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

// ---------- OAuth ----------
async function tokenRequest(body: Record<string, string>) {
  const { id, secret } = creds();
  const r = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    },
    body: new URLSearchParams(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new EbayError(`eBay-Anmeldung fehlgeschlagen: ${j.error_description || j.error || r.status}`, j);
  return j;
}

export function consentUrl(state: string) {
  const { id, runame } = creds();
  const p = new URLSearchParams({
    client_id: id,
    response_type: "code",
    redirect_uri: runame,
    scope: SCOPES,
    state,
    prompt: "login",
    locale: "de-DE",
  });
  return `https://auth.ebay.com/oauth2/authorize?${p}`;
}

export async function exchangeCode(shop: Shop, code: string) {
  const { runame } = creds();
  const j = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: runame });
  const now = Date.now();
  const t = {
    access_token: j.access_token,
    access_expires: now + (j.expires_in - 120) * 1000,
    refresh_token: j.refresh_token,
    refresh_expires: now + (j.refresh_token_expires_in || 0) * 1000,
    verbunden: now,
    scopes: SCOPES,
  };
  await setJSON(`token/${shop}`, t);
  return t;
}

export async function userToken(shop: Shop): Promise<string> {
  const t: any = await getJSON(`token/${shop}`);
  if (!t?.refresh_token) throw new EbayError(`Shop „${shop}“ ist noch nicht mit eBay verbunden.`);
  if (t.access_token && t.access_expires > Date.now()) return t.access_token;
  // nur die Scopes anfragen, die bei der Verbindung auch erteilt wurden
  const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, scope: t.scopes || ALTE_SCOPES });
  t.access_token = j.access_token;
  t.access_expires = Date.now() + (j.expires_in - 120) * 1000;
  await setJSON(`token/${shop}`, t);
  return t.access_token;
}

export async function appToken(): Promise<string> {
  const t: any = await getJSON("apptoken");
  if (t?.access_token && t.expires > Date.now()) return t.access_token;
  const j = await tokenRequest({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" });
  await setJSON("apptoken", { access_token: j.access_token, expires: Date.now() + (j.expires_in - 120) * 1000 });
  return j.access_token;
}

// ---------- REST ----------
export async function rest(path: string, opts: { token: string; method?: string; body?: any; headers?: Record<string, string> }) {
  const r = await fetch(path.startsWith("http") ? path : API + path, {
    method: opts.method || "GET",
    headers: {
      authorization: `Bearer ${opts.token}`,
      "accept-language": "de-DE",
      "content-language": "de-DE",
      "x-ebay-c-marketplace-id": "EBAY_DE",
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let j: any = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { raw: text };
  }
  if (!r.ok) {
    const msg = j.errors?.map((e: any) => e.longMessage || e.message).join(" · ") || `HTTP ${r.status}`;
    throw new EbayError(msg, j);
  }
  return { data: j, headers: r.headers, status: r.status };
}

// ---------- Trading (XML) ----------
const ARR = new Set([
  "Errors", "CustomCategory", "ChildCategory", "SupportedSellerProfile", "Item", "NameValueList", "Value",
  "PictureURL", "Fee", "ErrorParameters",
]);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  isArray: (name) => ARR.has(name),
});

export async function trading(shop: Shop, call: string, inner: string) {
  const token = await userToken(shop);
  const body = `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>de_DE</ErrorLanguage><WarningLevel>High</WarningLevel>${inner}</${call}Request>`;
  const r = await fetch(`${API}/ws/api.dll`, {
    method: "POST",
    headers: {
      "content-type": "text/xml; charset=utf-8",
      "x-ebay-api-siteid": SITE_ID,
      "x-ebay-api-compatibility-level": COMPAT(),
      "x-ebay-api-call-name": call,
      "x-ebay-api-iaf-token": token,
    },
    body,
  });
  const text = await r.text();
  const parsed = parser.parse(text);
  const data = parsed[`${call}Response`];
  if (!data) throw new EbayError(`Unerwartete eBay-Antwort (${r.status})`, text.slice(0, 500));
  const errs = (data.Errors || []).map((e: any) => ({
    stufe: e.SeverityCode,
    code: e.ErrorCode,
    text: e.LongMessage || e.ShortMessage,
  }));
  const fehler = errs.filter((e: any) => e.stufe === "Error");
  const warnungen = errs.filter((e: any) => e.stufe !== "Error");
  if (data.Ack === "Failure" || (fehler.length && data.Ack !== "Warning" && data.Ack !== "Success"))
    throw new EbayError(fehler.map((e: any) => e.text).join(" · ") || "eBay-Fehler", { fehler, warnungen });
  return { data, warnungen };
}

// ---------- Shop-Daten laden ----------
function flattenStoreCats(list: any[], prefix = ""): any[] {
  const out: any[] = [];
  for (const c of list || []) {
    if (!c) continue;
    const name = prefix ? `${prefix} > ${c.Name}` : c.Name;
    const kids = c.ChildCategory || [];
    out.push({ id: String(c.CategoryID), pfad: name, blatt: kids.length === 0 });
    out.push(...flattenStoreCats(kids, name));
  }
  return out;
}

export async function syncShop(shop: Shop) {
  const [user, store, prefs, selling] = await Promise.all([
    trading(shop, "GetUser", "").catch((e) => ({ err: e.message })),
    trading(shop, "GetStore", "<CategoryStructureOnly>true</CategoryStructureOnly>").catch((e) => ({ err: e.message })),
    trading(shop, "GetUserPreferences", "<ShowSellerProfilePreferences>true</ShowSellerProfilePreferences>").catch((e) => ({ err: e.message })),
    trading(
      shop,
      "GetMyeBaySelling",
      "<ActiveList><Include>true</Include><Sort>StartTimeDescending</Sort><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination></ActiveList>"
    ).catch((e) => ({ err: e.message })),
  ]);
  const hinweise: string[] = [];
  const g = (x: any, label: string) => {
    if (x?.err) {
      hinweise.push(`${label}: ${x.err}`);
      return null;
    }
    return x.data;
  };
  const u = g(user, "Benutzer");
  const st = g(store, "Shop-Kategorien");
  const pr = g(prefs, "Rahmenbedingungen");
  const se = g(selling, "Aktive Angebote");

  const storeKategorien = flattenStoreCats(st?.Store?.CustomCategories?.CustomCategory || []);
  const profile = (pr?.SellerProfilePreferences?.SupportedSellerProfiles?.SupportedSellerProfile || []).map((p: any) => ({
    id: String(p.ProfileID),
    typ: p.ProfileType, // PAYMENT | RETURN_POLICY | SHIPPING
    name: p.ProfileName,
    info: p.ShortSummary || "",
  }));
  const items = se?.ActiveList?.ItemArray?.Item || [];
  const titel = items.map((i: any) => i.Title).filter(Boolean);

  // Neueste Angebote im Detail (für Stil, Shop-Kategorie, Beschreibung)
  const neueste = items.slice(0, 8);
  const details = await Promise.all(
    neueste.map((i: any) =>
      trading(shop, "GetItem", `<ItemID>${esc(i.ItemID)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>`)
        .then((r) => r.data.Item?.[0] || r.data.Item)
        .catch(() => null)
    )
  );
  const beispiele = details.filter(Boolean).map((it: any) => ({
    itemId: String(it.ItemID),
    titel: it.Title,
    preis: it.StartPrice?.["#text"] || it.StartPrice,
    kategorie: { id: it.PrimaryCategory?.CategoryID, name: it.PrimaryCategory?.CategoryName },
    shopKategorieId: it.Storefront?.StoreCategoryID ? String(it.Storefront.StoreCategoryID) : "",
    zustandId: it.ConditionID,
    merkmale: Object.fromEntries(
      (it.ItemSpecifics?.NameValueList || []).map((n: any) => [n.Name, (n.Value || []).join(", ")])
    ),
    html: String(it.Description || "").slice(0, 20000),
  }));

  let kampagnen: any[] = [];
  try {
    const token = await userToken(shop);
    const { data } = await rest("/sell/marketing/v1/ad_campaign?campaign_status=RUNNING&limit=50", { token });
    kampagnen = (data.campaigns || []).map((c: any) => ({
      id: c.campaignId,
      name: c.campaignName,
      modell: c.fundingStrategy?.fundingModel,
      prozent: c.fundingStrategy?.bidPercentage,
      regelbasiert: !!c.campaignCriterion?.autoSelectFutureInventory,
    }));
  } catch (e: any) {
    hinweise.push(`Werbekampagnen: ${e.message}`);
  }

  const daten = {
    shop,
    user: u?.User?.UserID || "",
    storeName: st?.Store?.Name || "",
    storeKategorien,
    profile,
    kampagnen,
    titel: titel.slice(0, 100),
    beispiele,
    anzahlAktiv: Number(se?.ActiveList?.PaginationResult?.TotalNumberOfEntries || items.length),
    hinweise,
    geladen: Date.now(),
  };
  await setJSON(`shopdaten/${shop}`, daten);
  return daten;
}

// ---------- Kategorien, Merkmale, Zustände, Vergleich ----------
export async function kategorieVorschlaege(q: string) {
  const token = await appToken();
  const { data } = await rest(
    `/commerce/taxonomy/v1/category_tree/${TREE_ID}/get_category_suggestions?q=${encodeURIComponent(q.slice(0, 350))}`,
    { token }
  );
  return (data.categorySuggestions || []).map((s: any) => ({
    id: String(s.category.categoryId),
    name: s.category.categoryName,
    pfad: [...(s.categoryTreeNodeAncestors || []).map((a: any) => a.categoryName).reverse(), s.category.categoryName].join(" > "),
  }));
}

export async function merkmaleFuer(categoryId: string) {
  const token = await appToken();
  const cacheKey = `cache/aspekte/${categoryId}`;
  const c: any = await getJSON(cacheKey);
  if (c && c.zeit > Date.now() - 7 * 864e5) return c.aspekte;
  const { data } = await rest(
    `/commerce/taxonomy/v1/category_tree/${TREE_ID}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,
    { token }
  );
  const aspekte = (data.aspects || []).map((a: any) => ({
    name: a.localizedAspectName,
    pflicht: !!a.aspectConstraint?.aspectRequired,
    empfohlen: a.aspectConstraint?.aspectUsage === "RECOMMENDED",
    mehrfach: a.aspectConstraint?.itemToAspectCardinality === "MULTI",
    nurAuswahl: a.aspectConstraint?.aspectMode === "SELECTION_ONLY",
    werte: (a.aspectValues || []).slice(0, 60).map((v: any) => v.localizedValue),
  }));
  await setJSON(cacheKey, { zeit: Date.now(), aspekte });
  return aspekte;
}

const STANDARD_ZUSTAENDE = [
  { id: "1000", name: "Neu" },
  { id: "1500", name: "Neu: Sonstige (siehe Artikelbeschreibung)" },
  { id: "3000", name: "Gebraucht" },
  { id: "7000", name: "Als Ersatzteil / defekt" },
];

export async function zustaendeFuer(categoryIds: string[]) {
  const out: Record<string, any[]> = {};
  if (!categoryIds.length) return out;
  try {
    const token = await appToken();
    const { data } = await rest(
      `/sell/metadata/v1/marketplace/EBAY_DE/get_item_condition_policies?filter=${encodeURIComponent(`categoryIds:{${categoryIds.join("|")}}`)}`,
      { token }
    );
    for (const p of data.itemConditionPolicies || []) {
      out[String(p.categoryId)] = (p.itemConditions || []).map((c: any) => ({
        id: String(c.conditionId),
        name: c.conditionDescription,
      }));
    }
  } catch {
    /* Standard verwenden */
  }
  for (const id of categoryIds) if (!out[id]?.length) out[id] = STANDARD_ZUSTAENDE;
  return out;
}

export async function vergleichsAngebote(q: string) {
  const token = await appToken();
  const { data } = await rest(
    `/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q.slice(0, 100))}&limit=40&filter=${encodeURIComponent("buyingOptions:{FIXED_PRICE},deliveryCountry:DE,itemLocationCountry:DE")}`,
    { token, headers: { "x-ebay-c-enduserctx": "contextualLocation=country=DE" } }
  );
  return (data.itemSummaries || []).map((i: any) => {
    const preis = Number(i.price?.value || 0);
    const versand = Number(i.shippingOptions?.[0]?.shippingCost?.value || 0);
    return {
      titel: i.title,
      preis,
      versand,
      gesamt: Math.round((preis + versand) * 100) / 100,
      zustand: i.condition,
      kategorieIds: (i.leafCategoryIds || i.categories?.map((c: any) => c.categoryId) || []).map(String),
      kategorieName: i.categories?.[0]?.categoryName,
    };
  });
}

// ---------- Bilder (Media API) ----------
export async function bildHochladen(shop: Shop, jpeg: ArrayBuffer, name: string): Promise<string> {
  const token = await userToken(shop);
  const fd = new FormData();
  fd.append("image", new Blob([jpeg], { type: "image/jpeg" }), name);
  const r = await fetch("https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });
  const text = await r.text();
  let j: any = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {}
  if (!r.ok) throw new EbayError(`Bild-Upload fehlgeschlagen: ${j.errors?.[0]?.longMessage || j.errors?.[0]?.message || r.status}`, j);
  if (j.imageUrl) return j.imageUrl;
  const loc = r.headers.get("location");
  if (!loc) throw new EbayError("Bild-Upload: keine Bild-Adresse erhalten");
  const g = await rest(loc, { token });
  if (!g.data.imageUrl) throw new EbayError("Bild-Upload: keine Bild-Adresse erhalten");
  return g.data.imageUrl;
}

export async function anzeigeInKampagne(shop: Shop, campaignId: string, listingId: string, prozent: number) {
  const token = await userToken(shop);
  await rest(`/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad`, {
    token,
    method: "POST",
    body: { listingId, bidPercentage: prozent.toFixed(1) },
  });
}

// ---------- Alte Angebote ----------
const num = (x: any) => Number(x?.["#text"] ?? x ?? 0) || 0;
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

/** Alle aktiven Angebote eines Shops (max. 2000) */
export async function aktiveAngebote(shop: Shop) {
  const seite = (n: number) =>
    trading(
      shop,
      "GetMyeBaySelling",
      `<ActiveList><Include>true</Include><IncludeWatchCount>true</IncludeWatchCount><Sort>StartTime</Sort><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${n}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`
    ).then((r) => r.data.ActiveList);
  const erste = await seite(1);
  const seiten = Math.min(Number(erste?.PaginationResult?.TotalNumberOfPages || 1), 10);
  const rest = await Promise.all(Array.from({ length: seiten - 1 }, (_, i) => seite(i + 2)));
  const items = [erste, ...rest].flatMap((l: any) => l?.ItemArray?.Item || []);
  return items.map((i: any) => ({
    itemId: String(i.ItemID),
    titel: String(i.Title || ""),
    preis: num(i.BuyItNowPrice) || num(i.SellingStatus?.CurrentPrice),
    bild: i.PictureDetails?.GalleryURL || "",
    beobachter: Number(i.WatchCount || 0),
    start: i.ListingDetails?.StartTime || "",
    menge: Number(i.QuantityAvailable ?? i.Quantity ?? 1),
    sku: String(i.SKU || ""),
  }));
}

/** Traffic der letzten 30 Tage je Angebot (braucht die Analytics-Berechtigung) */
export async function trafficProAngebot(shop: Shop, ids: string[]) {
  const token = await userToken(shop);
  const ende = new Date(Date.now() - 2 * 864e5);
  const start = new Date(ende.getTime() - 29 * 864e5);
  const out: Record<string, { impressionen: number; aufrufe: number; klickrate: number; verkauft: number }> = {};
  const stuecke: string[][] = [];
  for (let i = 0; i < ids.length; i += 200) stuecke.push(ids.slice(i, i + 200));
  await Promise.all(
    stuecke.map(async (teil) => {
      const filter = `listing_ids:{${teil.join("|")}},marketplace_ids:{EBAY_DE},date_range:[${ymd(start)}..${ymd(ende)}]`;
      const { data } = await rest(
        `/sell/analytics/v1/traffic_report?dimension=LISTING&metric=LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL,CLICK_THROUGH_RATE,TRANSACTION&filter=${encodeURIComponent(filter)}`,
        { token }
      );
      const keys = (data.header?.metrics || []).map((m: any) => m.key);
      for (const r of data.records || []) {
        const id = String(r.dimensionValues?.[0]?.value || "");
        const v: any = {};
        keys.forEach((k: string, i: number) => (v[k] = Number(r.metricValues?.[i]?.value || 0)));
        out[id] = {
          impressionen: v.LISTING_IMPRESSION_TOTAL || 0,
          aufrufe: v.LISTING_VIEWS_TOTAL || 0,
          klickrate: v.CLICK_THROUGH_RATE || 0,
          verkauft: v.TRANSACTION || 0,
        };
      }
    })
  );
  return out;
}

/** Ein Angebot komplett laden */
export async function angebotDetails(shop: Shop, itemId: string) {
  const { data } = await trading(
    shop,
    "GetItem",
    `<ItemID>${esc(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics><IncludeWatchCount>true</IncludeWatchCount>`
  );
  const it: any = data.Item?.[0] || data.Item;
  if (!it) throw new EbayError("Angebot nicht gefunden.");
  return {
    itemId: String(it.ItemID),
    titel: String(it.Title || ""),
    preis: num(it.StartPrice),
    beschreibung: String(it.Description || ""),
    // größte Variante der eBay-Fotos (s-l1600)
    bilder: (it.PictureDetails?.PictureURL || []).map((u: string) => String(u)),
    zustandId: String(it.ConditionID || ""),
    zustandName: String(it.ConditionDisplayName || ""),
    zustandText: String(it.ConditionDescription || ""),
    kategorie: { id: String(it.PrimaryCategory?.CategoryID || ""), name: String(it.PrimaryCategory?.CategoryName || "") },
    merkmale: Object.fromEntries((it.ItemSpecifics?.NameValueList || []).map((n: any) => [n.Name, (n.Value || []).join(", ")])),
    beobachter: Number(it.WatchCount || 0),
    menge: Number(it.Quantity || 1) - Number(it.SellingStatus?.QuantitySold || 0),
    verkauft: Number(it.SellingStatus?.QuantitySold || 0),
    sku: String(it.SKU || ""),
    start: it.ListingDetails?.StartTime || "",
    url: it.ListingDetails?.ViewItemURL || `https://www.ebay.de/itm/${it.ItemID}`,
  };
}

/** Laufendes Angebot ändern – ohne Beenden (Beobachter und Verlauf bleiben) */
export async function angebotAendern(
  shop: Shop,
  itemId: string,
  f: { titel?: string; beschreibung?: string; preis?: number; zustandText?: string; zustandId?: string; bilder?: string[] }
) {
  const teile: string[] = [`<ItemID>${esc(itemId)}</ItemID>`];
  if (f.titel) teile.push(`<Title>${esc(f.titel)}</Title>`);
  if (f.beschreibung) teile.push(`<Description>${cdata(f.beschreibung)}</Description>`);
  if (f.preis && f.preis > 0) teile.push(`<StartPrice currencyID="EUR">${Number(f.preis).toFixed(2)}</StartPrice>`);
  if (f.zustandText !== undefined && f.zustandId !== "1000") teile.push(`<ConditionDescription>${esc(String(f.zustandText).slice(0, 1000))}</ConditionDescription>`);
  if (f.bilder?.length) teile.push(`<PictureDetails>${f.bilder.slice(0, 24).map((u) => `<PictureURL>${esc(u)}</PictureURL>`).join("")}</PictureDetails>`);
  const { warnungen } = await trading(shop, "ReviseFixedPriceItem", `<Item>${teile.join("")}</Item>`);
  return warnungen.map((w: any) => w.text);
}

/** Angebot beenden (bei eBay danach unter „Nicht verkauft“, kann wieder eingestellt werden) */
export async function angebotBeenden(shop: Shop, itemId: string) {
  await trading(shop, "EndFixedPriceItem", `<ItemID>${esc(itemId)}</ItemID><EndingReason>NotAvailable</EndingReason>`);
}

/** Preisvorschlag an alle Beobachter senden */
export async function angebotAnBeobachter(shop: Shop, itemId: string, prozent: number, nachricht: string) {
  const token = await userToken(shop);
  const { data } = await rest("/sell/negotiation/v1/send_offer_to_interested_buyers", {
    token,
    method: "POST",
    body: {
      allowCounterOffer: false,
      message: nachricht.slice(0, 2000),
      offerDuration: { unit: "DAY", value: 2 },
      offeredItems: [{ listingId: itemId, discountPercentage: String(Math.round(prozent)), quantity: 1 }],
    },
  });
  return data;
}
