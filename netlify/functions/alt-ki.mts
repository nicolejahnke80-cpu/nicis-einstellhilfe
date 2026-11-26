import type { Config } from "@netlify/functions";
import { SHOPS, checkAuth, type Shop } from "../shared/store.mts";
import { listeLaden, vorschlagErstellen } from "../shared/alt.mts";

// Hintergrund-Funktion für alte Angebote: Liste laden (viele eBay-Abfragen) und KI-Vorschläge.
export default async (req: Request) => {
  if ((await checkAuth(req)) !== "ok") return;
  const { job, shop, itemId, wunsch } = await req.json().catch(() => ({}));
  if (!SHOPS.includes(shop)) return;
  if (job === "liste") return listeLaden(shop as Shop);
  if (job === "vorschlag" && itemId) return vorschlagErstellen(shop as Shop, String(itemId), String(wunsch || "").slice(0, 2000));
};

export const config: Config = { path: "/api/alt-ki", background: true };
