
# TODOS — Comparateur Bancaire Cameroun

## Phase 2 (post-MVP)

### Analytics / Instrumentation
- **Quoi :** Tracker conversations WhatsApp complètes vs abandonnées, banques recommandées, secteurs demandés
- **Pourquoi :** Sans métriques, impossible de savoir si le bot génère de la valeur ou des abandons
- **Comment :** Posthog free tier (5 lignes de code) ou JSONL dans Vercel KV
- **Bloqué par :** Rien — peut être ajouté à tout moment post-launch

## En scope (à construire maintenant)

### Zod Schema validation du Google Sheet
- **Quoi :** Valider le schema des données Sheets au moment du fetch (types, ranges, formats)
- **Pourquoi :** Un typo dans teg_min ('12,5' au lieu de '12.5') corrompt silencieusement toutes les recommandations
- **Comment :** `z.object({ teg_min: z.number().min(5).max(30), ... })` dans lib/recommend.ts
- **Effort :** CC ~15 min
