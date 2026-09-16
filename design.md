# Design — Travel Assistant

Sistema visivo condiviso per l'app vanilla multi-page. Le pagine app condividono
tipografia, accento e ritmo; la varietà viene dalla gerarchia dei contenuti, non
da palette diverse.

## Genere
Editoriale funzionale, caldo e misurato.

## Famiglie di macrostruttura

- Pagine app: Workbench / split-view, con una superficie primaria e una rail di contesto.
- Pagine contenuto: Long Document compatto, con titoli a margine e regole sottili.
- Accesso: gateway editoriale, con una sola scena introduttiva e form focalizzato.

## Tema

- `--color-paper`: `oklch(97% 0.012 92)`
- `--color-paper-2`: `oklch(94% 0.022 155)`
- `--color-ink`: `oklch(24% 0.045 195)`
- `--color-ink-2`: `oklch(39% 0.045 195)`
- `--color-rule`: `oklch(84% 0.035 170)`
- `--color-accent`: `oklch(57% 0.16 34)`
- `--color-focus`: `oklch(74% 0.14 82)`

## Tipografia

- Display: Fraunces, con Georgia come fallback, sempre roman.
- Corpo: Avenir Next / Segoe UI, con fallback sans-serif.
- Mono: SFMono-Regular / Consolas, solo per dati tecnici.
- Scala: token `--text-*` in `tokens.css`.

## Spaziatura e motion

Scala a 4 punti tramite token `--space-*`. Le transizioni animano solo opacity
e transform, con `--ease-out`; la modalità reduced-motion riduce tutto a un
crossfade breve.

## Voce delle interazioni

Azioni primarie piene e compatte, secondarie piane con bordo. Successi silenziosi;
gli errori restano visibili vicino al controllo che li ha generati. Focus ring
sempre immediato e tastiera-first. Nessun contenuto automatico rotante.

## Vincoli condivisi

Wordmark, accento corallo, superfici carta e densità editoriale restano comuni.
Le pagine non cambiano logica, route, copy, autenticazione, fetch o storage.
