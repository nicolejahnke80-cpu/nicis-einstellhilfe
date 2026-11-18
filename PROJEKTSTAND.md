# Nicis Einstellhilfe – Projektstand (18.11.2026)

Mac-Web-App: Fotos rein → KI (Claude über Netlify AI Gateway oder eigener ANTHROPIC_API_KEY) erstellt komplettes eBay-Angebot im Stil der Nutzerin → Einstellen per eBay Trading API (AddFixedPriceItem), Bilder per Media API.

## Netlify
- Projekt: nicis-einstellhilfe (Site-ID 9cff05b0-4124-4d4c-80bd-14539ecab6ef), Team nicole-jahnke (Free-Plan)
- URL: https://nicis-einstellhilfe.netlify.app
- Noch NICHT deployed (Netlify war im Sandbox-Netz gesperrt). Deploy: Netlify-MCP deploy-site → Befehl im entpackten Ordner ausführen (Remote-Build, package.json vorhanden).

## Aufbau
- public/index.html – komplette Oberfläche (Login, Neue Artikel, Entwürfe, Eingestellt, Einstellungen)
- netlify/functions/api.mts – Router /api/* (Auth, State, Settings, eBay-OAuth, Sync, Entwürfe, Fotos, Einstellen, Kategorien)
- netlify/functions/analyse.mts – Hintergrundfunktion /api/analyse (KI-Analyse, ggf. Auto-Einstellen)
- netlify/shared/{store,ebay,ki,einstellen}.mts
- Daten in Netlify Blobs (Store "einstellhilfe")

## Noch offen
1. Deploy
2. Env-Variablen in Netlify: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME (Production-Keyset); optional ANTHROPIC_API_KEY (empfohlen, sonst Netlify-Credits), optional KI_MODELL, EBAY_COMPAT_LEVEL (Standard 1451)
3. eBay-Entwicklerportal: RuName „Auth accepted URL“ = https://nicis-einstellhilfe.netlify.app/api/ebay/callback, Privacy-URL = https://nicis-einstellhilfe.netlify.app/datenschutz.html
4. In der App: Passwort festlegen, beide Shops verbinden (jeweils eigenes eBay-Konto), Shop-Daten laden, Profile/Kampagne/PLZ wählen
5. Erster echter Test mit „Nur prüfen“ (eBay- und KI-Teil sind ungetestet, nur UI mit Mock getestet)
