import type { Config } from "@netlify/functions";
import { checkAuth, getDraft, getSettings, saveDraft } from "../shared/store.mts";
import { analysiere, fehlendeAngaben } from "../shared/ki.mts";
import { einstellen } from "../shared/einstellen.mts";

// Hintergrund-Funktion: darf bis zu 15 Minuten laufen, Ergebnis landet im Entwurf.
export default async (req: Request) => {
  if ((await checkAuth(req)) !== "ok") return;
  const { id } = await req.json().catch(() => ({}));
  if (!id) return;
  const d: any = await getDraft(id);
  if (!d) return;

  d.status = "analysiere";
  d.fehler = "";
  d.analyseStart = Date.now();
  await saveDraft(d);

  try {
    const r = await analysiere(d);
    const aktuell: any = (await getDraft(id)) || d; // falls inzwischen bearbeitet
    Object.assign(aktuell, r, { status: "fertig", analysiert: Date.now(), ebayBilder: [], itemId: null });
    await saveDraft(aktuell);

    const s = await getSettings();
    if (s.autoEinstellen && r.ki.sicherheit === "hoch" && !fehlendeAngaben(aktuell, s).length) {
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
