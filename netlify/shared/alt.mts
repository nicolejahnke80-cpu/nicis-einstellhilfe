import { getJSON, setJSON, type Shop } from "./store.mts";
import { aktiveAngebote, angebotDetails, hatTrafficRecht, trafficProAngebot } from "./ebay.mts";
import { altVorschlag } from "./ki.mts";

/** Alte Angebote: Liste, Bearbeitungsstand je Angebot und Vorschläge liegen in Netlify Blobs */
export const listeKey = (shop: Shop) => `alt/${shop}/liste`;
export const standKey = (shop: Shop) => `alt/${shop}/stand`;
export const itemKey = (shop: Shop, id: string) => `alt/${shop}/item/${String(id).replace(/\D/g, "")}`;

/** Lagerplatz (#17) aus altem Titel oder SKU */
export function lagerAus(titel: string, sku = "") {
  const t = String(titel || "").match(/#(\S+)\s*$/);
  if (t) return `#${t[1]}`;
  const s = String(sku || "").trim();
  return /^#\S+$/.test(s) ? s : "";
}

export async function listeLaden(shop: Shop) {
  await setJSON(listeKey(shop), { ...((await getJSON(listeKey(shop))) || {}), status: "laedt", fehler: "" });
  try {
    const items = await aktiveAngebote(shop);
    let traffic = false;
    let hinweis = "";
    if (await hatTrafficRecht(shop)) {
      try {
        const t = await trafficProAngebot(shop, items.map((i) => i.itemId));
        for (const i of items as any[]) i.traffic = t[i.itemId] || { impressionen: 0, aufrufe: 0, klickrate: 0, verkauft: 0 };
        traffic = true;
      } catch (e: any) {
        hinweis = `Traffic-Zahlen konnten nicht geladen werden: ${e.message}`;
      }
    } else {
      hinweis = "Für die Traffic-Zahlen den Shop unter Einstellungen einmal „Neu verbinden“. Bis dahin: Sortierung nach Beobachtern und Alter.";
    }
    await setJSON(listeKey(shop), { status: "fertig", geladen: Date.now(), items, traffic, hinweis, fehler: "" });
  } catch (e: any) {
    const alt: any = (await getJSON(listeKey(shop))) || {};
    await setJSON(listeKey(shop), { ...alt, status: "fehler", fehler: e.message || "Laden fehlgeschlagen" });
  }
}

export async function vorschlagErstellen(shop: Shop, itemId: string, wunsch = "") {
  const key = itemKey(shop, itemId);
  const vorher: any = (await getJSON(key)) || {};
  // Infos sammeln (gleiche Info nicht doppelt)
  const alle = String(vorher.wunsch || "").split("\n").filter(Boolean);
  if (wunsch && !alle.includes(wunsch.trim())) alle.push(wunsch.trim());
  const wunschAlle = alle.join("\n").slice(0, 3000);
  await setJSON(key, { ...vorher, status: "ki", fehler: "", wunsch: wunschAlle });
  try {
    const original = await angebotDetails(shop, itemId);
    const liste: any = await getJSON(listeKey(shop));
    const stats = liste?.traffic ? liste.items?.find((i: any) => i.itemId === itemId)?.traffic : null;
    const v = await altVorschlag(shop, original, stats, wunschAlle);
    const aktuell: any = (await getJSON(key)) || {};
    await setJSON(key, {
      ...aktuell,
      status: "fertig",
      fehler: "",
      original,
      lager: lagerAus(original.titel, original.sku),
      neu: {
        titel: v.titel,
        preis: v.preis,
        zustandText: v.zustandText,
        beschreibung: v.beschreibung,
        // Kreuzchen: von Hand gesetzte bleiben, sonst Vorschlag der KI
        batterie: aktuell.neu?.batterieGesetzt ? aktuell.neu.batterie : v.batterie,
        u3: aktuell.neu?.u3Gesetzt ? aktuell.neu.u3 : v.u3,
        batterieGesetzt: !!aktuell.neu?.batterieGesetzt,
        u3Gesetzt: !!aktuell.neu?.u3Gesetzt,
        // eigene Foto-Änderungen (Zuschnitt, Reihenfolge) nicht überschreiben
        bilder: aktuell.neu?.bilder?.length ? aktuell.neu.bilder : original.bilder,
      },
      ki: { preisBegruendung: v.preisBegruendung, aenderungen: v.aenderungen, rueckfrage: v.rueckfrage, vergleich: v.vergleich },
      zeit: Date.now(),
    });
  } catch (e: any) {
    const aktuell: any = (await getJSON(key)) || {};
    await setJSON(key, { ...aktuell, status: "fehler", fehler: e.message || "Vorschlag fehlgeschlagen", zeit: Date.now() });
  }
}
