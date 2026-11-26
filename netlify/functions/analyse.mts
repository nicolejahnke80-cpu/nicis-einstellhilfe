import type { Config } from "@netlify/functions";
import { checkAuth, getDraft, getJSON, getSettings, saveDraft } from "../shared/store.mts";
import { analysiere, anpassen, fehlendeAngaben } from "../shared/ki.mts";
import { einstellen } from "../shared/einstellen.mts";

// Hintergrund-Funktion: darf bis zu 15 Minuten laufen, Ergebnis landet im Entwurf.
export default async (req: Request) => {
  if ((await checkAuth(req)) !== "ok") return;
  const { id, modus, wunsch } = await req.json().catch(() => ({}));
  if (!id) return;
  const d: any = await getDraft(id);
  if (!d) return;

  d.status = "analysiere";
  d.fehler = "";
  d.analyseStart = Date.now();
  await saveDraft(d);

  if (modus === "anpassen" && wunsch) {
    try {
      const r = await anpassen(d, String(wunsch).slice(0, 2000));
      const aktuell: any = (await getDraft(id)) || d;
      Object.assign(aktuell, r, {
        status: "fertig",
        hinweis: [aktuell.hinweis, String(wunsch)].filter(Boolean).join("\n").slice(0, 4000),
        geprueft: null,
      });
      await saveDraft(aktuell);
    } catch (e: any) {
      const aktuell: any = (await getDraft(id)) || d;
      aktuell.status = "fertig";
      aktuell.fehler = `Anpassen hat nicht geklappt: ${e?.message || e}`;
      await saveDraft(aktuell);
    }
    return;
  }

  try {
    const r = await analysiere(d);
    const aktuell: any = (await getDraft(id)) || d; // falls inzwischen bearbeitet
    Object.assign(aktuell, r, { status: "fertig", analysiert: Date.now(), ebayBilder: [], itemId: null });
    await saveDraft(aktuell);

    const s = await getSettings();
    if (s.autoEinstellen && r.ki.sicherheit === "hoch" && !fehlendeAngaben(aktuell, s, { [aktuell.shop]: await getJSON(`shopdaten/${aktuell.shop}`) }).length) {
      try {
        aktuell.status = "einstellen";
        await saveDraft(aktuell);
        await einstellen(aktuell, false);
        await saveDraft(aktuell);
      } catch (e: any) {
        aktuell.status = "fertig";
        aktuell.fehler = `Automatisches Einstellen hat nicht geklappt: ${e.message}`;
        aktuell.fehlerDetails = e.details?.fehler || null;
        await saveDraft(aktuell);
      }
    }
  } catch (e: any) {
    console.error(e);
    const aktuell: any = (await getDraft(id)) || d;
    aktuell.status = "fehler";
    aktuell.fehler = e?.message || "Analyse fehlgeschlagen";
    await saveDraft(aktuell);
  }
};

export const config: Config = { path: "/api/analyse", background: true };
