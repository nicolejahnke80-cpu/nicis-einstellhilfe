import { getStore } from "@netlify/blobs";

export const SHOPS = ["nicideen", "wonderland"] as const;
export type Shop = (typeof SHOPS)[number];

export const db = () => getStore({ name: "einstellhilfe", consistency: "strong" });

export async function getJSON<T = any>(key: string): Promise<T | null> {
  return (await db().get(key, { type: "json" })) as T | null;
}
export async function setJSON(key: string, val: any) {
  await db().setJSON(key, val);
}

export async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Buffer.from(b).toString("hex");
}

/** "ok" | "setup" (noch kein Passwort) | "nein" */
export async function checkAuth(req: Request): Promise<"ok" | "setup" | "nein"> {
  const url = new URL(req.url);
  const key = req.headers.get("x-key") || url.searchParams.get("t") || "";
  const a = await getJSON("auth");
  if (!a) return "setup";
  if (!key) return "nein";
  return (await sha(a.salt + key)) === a.hash ? "ok" : "nein";
}

export const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export function defaultSettings() {
  return {
    shops: {
      nicideen: {
        name: "Nicideen",
        fokus:
          "Videospiele aller Plattformen (Nintendo, PlayStation, Xbox, Sega, PC, Retro-Gaming), Konsolen und Zubehör, Pokémon- und andere Sammelkarten, Sammelsachen.",
        stil: "Keine Emojis im Titel. Beschreibungsdesign hellgrau.",
        vorlageHtml: "",
        profile: { shipping: "", payment: "", return: "" },
        kampagne: "",
      },
      wonderland: {
        name: "Nicis.Wonderland",
        fokus:
          "Haushaltsartikel (z. B. Tupperware), Spielzeug (My Little Pony, Barbie, Puppen, Tiptoi, LEGO), Walkmans und andere Retro-Technik – alles, was nicht zu Nicideen gehört.",
        stil:
          "Titel-Emoji: 🔥 für Jungensachen/Technik, 🌸 für Mädchensachen (Ponys, Barbies, Puppen, Spielzeug allgemein, Tiptoi). Position des Emojis wie in den bisherigen Titeln.",
        vorlageHtml: "",
        profile: { shipping: "", payment: "", return: "" },
        kampagne: "",
      },
    },
    standort: { plz: "", ort: "" },
    werbungProzent: 5,
    preisvorschlagErlauben: false,
    autoEinstellen: false,
  };
}

export async function getSettings() {
  const s = await getJSON("settings");
  const d = defaultSettings();
  if (!s) return d;
  // flach zusammenführen, damit neue Felder Standardwerte bekommen
  return {
    ...d,
    ...s,
    standort: { ...d.standort, ...(s.standort || {}) },
    shops: {
      nicideen: { ...d.shops.nicideen, ...(s.shops?.nicideen || {}), profile: { ...d.shops.nicideen.profile, ...(s.shops?.nicideen?.profile || {}) } },
      wonderland: { ...d.shops.wonderland, ...(s.shops?.wonderland || {}), profile: { ...d.shops.wonderland.profile, ...(s.shops?.wonderland?.profile || {}) } },
    },
  };
}

export const draftKey = (id: string) => `drafts/${id}`;
export const imgKey = (id: string, n: number | string, art: string) => `img/${id}/${n}-${art}.jpg`;

export async function getDraft(id: string) {
  return getJSON(draftKey(id));
}
export async function saveDraft(d: any) {
  d.geaendert = Date.now();
  await setJSON(draftKey(d.id), d);
  return d;
}
