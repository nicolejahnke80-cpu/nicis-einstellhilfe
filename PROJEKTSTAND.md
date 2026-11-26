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

## Änderung 24.11.2026
- Titelregeln im KI-Prompt (netlify/shared/ki.mts, analysiere) verschärft: Marke → Serie/Modell → Modell-/Setnummer → Artikelart → Größe/Farbe/Plattform → Zustand; eigene Muster für Videospiele, Sammelkarten, LEGO, Tupperware/Haushalt, Telefone/Technik/Ersatzteile; Mängel konkret statt „LESEN!!!“; keine Füllwörter. Diese Regeln haben Vorrang vor dem Stil der alten Titel.

## Änderung 26.11.2026
- **Fotos zuschneiden** (✂): bei neuen Artikeln (vor dem Hochladen), in den Entwurfs-Details (Foto anklicken; lädt voll+ki neu, eBay-Bild wird beim Einstellen neu hochgeladen) und bei alten Angeboten. Seitenverhältnis frei / Quadrat / 4:3.
- **Neuer Tab „Alte Angebote“**: laufende Angebote bearbeiten OHNE Beenden (ReviseFixedPriceItem) – Beobachter und Verlauf bleiben.
  - Liste lädt im Hintergrund (`/api/alt-ki`, job=liste): alle aktiven Angebote + Traffic 30 Tage (Analytics-API). Sortierung: wenigste Aufrufe zuerst (Standard), viel gesehen/kaum geklickt, am längsten online, teuerste. Grinch-Titel gelten als schon erledigt.
  - Beim Öffnen erstellt die KI einen Vorschlag (Titel nach Titelregeln, Beschreibung in der Shop-Vorlage, Preis mit Vergleichsangeboten); das nächste Angebot wird schon vorbereitet.
  - Fotos: zuschneiden, als Titelbild setzen, entfernen, neues Titelbild hochladen (über Media-API).
  - Preisvorschlag an Beobachter (Negotiation-API, 2 Tage gültig).
  - Lagerplatz (#…) aus altem Titel/SKU bleibt am Titelende.
  - Daten: `alt/{shop}/liste`, `alt/{shop}/stand`, `alt/{shop}/item/{id}`.
- **eBay-Berechtigung**: neuer Scope `sell.analytics.readonly`. Token speichert jetzt seine Scopes; alte Tokens werden weiter mit den alten Scopes erneuert. Für Traffic-Zahlen beide Shops einmal „Neu verbinden“.
- **Mehrere alte Angebote auf einmal** (26.11.2026): „✨ Nächste 10 vorbereiten“ startet die KI für die nächsten 10 offenen Angebote (gestaffelt). In der Liste erscheinen neuer Titel und Preis direkt zum Ändern, „✓ Passt“ hakt ab, „Abgehakte übernehmen“ ändert alle nacheinander bei eBay. Endpunkt `GET /api/alt/:shop/vorschlaege?ids=…` (Kurzfassung), Feld `abgehakt` im Vorschlag.
- **Angebot beenden** (26.11.2026): Knopf „Beenden“ in jeder Zeile und „Angebot beenden“ in den Details (EndFixedPriceItem, Grund NotAvailable), mit Sicherheitsabfrage. Stand `beendet`.
- **Entsorgen-Liste** (26.11.2026): beim Beenden wird der Artikel (Titel, Lagerplatz, Shop) in `entsorgen` gemerkt (beide Shops zusammen). Knopf „🗑 Entsorgen-Liste“ unter Alte Angebote: Tabelle nach Lagerplatz, „Drucken“ (eigene Druckseite mit Abhak-Kästchen), „Liste löschen“ (nur App-Liste, eBay bleibt unverändert). Endpunkte `GET/DELETE /api/entsorgen`.
- **Lagerleichen** (26.11.2026): Umschalter „🪦 Lagerleichen“ unter Alte Angebote. Regeln einstellbar (Standard: mind. 180 Tage online, höchstens 2 Aufrufe in 30 Tagen, keine Beobachter; im Browser gespeichert). Auswählen / alle auswählen, „Ausgewählte beenden“ → kommen auf die Entsorgen-Liste.
- **Fix „Neu vorschlagen“** (26.11.2026): App zeigte sofort den alten Vorschlag, weil die Hintergrund-KI noch nicht gestartet war, und lud den neuen nicht nach. Jetzt wartet die App, bis `zeit` des Vorschlags sich ändert (max. 3 Min.). Infos von Nicole sind im Prompt verbindlich (Mängel in Titel, Zustand, Beschreibung) und werden ohne Doppelungen gesammelt und im Editor angezeigt.
- **Pflicht-Hinweise** (26.11.2026): Kreuzchen „🔋 Enthält Batterien“ und „🚫 Nicht für Kinder unter 3 Jahren“ in Entwürfen und alten Angeboten (Nicideen: standardmäßig beide an, Wonderland: KI schlägt vor). Beim Einstellen/Übernehmen: Text unten in die Beschreibung (innerhalb des Designs, nicht doppelt) und eBay-Produktsicherheit (`Item.Regulatory.ProductSafety` Statements/Pictograms). Texte und eBay-Hinweis-IDs unter Einstellungen → „Pflicht-Hinweise“ (Liste über Metadata-API `get_product_safety_labels`, Vorauswahl per Textsuche). Die KI schreibt diese Hinweise nicht mehr selbst in die Beschreibung.
- **Fix Fotogröße** (26.11.2026): eBay lehnt Fotos unter 500 px (längste Seite) ab – zugeschnittene Fotos werden jetzt auf mind. 1000 px gebracht (`skaliere(img, max, q, min)`), eBay-Fotos werden zum Zuschneiden in der größten Variante (s-l1600 / $_57) geholt. Fehler beim Übernehmen stehen jetzt direkt über dem Knopf, bei Bildfehlern mit „Fotos zurücksetzen“.
- **Fix Merkmale mit nur einem Wert** (26.11.2026): eBay-Fehler „Farbe darf nur einen Wert enthalten“. Beim Einstellen/Prüfen werden mehrere Werte bei Merkmalen ohne MULTI-Kardinalität zusammengefasst (`merkmalWerte`): Farbe → „Mehrfarbig“ falls angeboten, sonst „A / B“, bei reinen Auswahllisten der erste Wert.
- **Shop-Kategorien** (26.11.2026): KI wählt nur noch Unterkategorien ohne weitere Unterkategorien (eBay nimmt Artikel nur dort auf). Fehlt die Shop-Kategorie, steht sie bei „Fehlt noch“ (fehlendeAngaben mit Shop-Daten). Alte Angebote: Shop-Kategorie wird geladen (Storefront.StoreCategoryID), die KI schlägt die passende vor, Auswahl im Editor + Anzeige in der Kurzansicht, Übernehmen setzt Storefront.
