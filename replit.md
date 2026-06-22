# NexFeed

A dashboard for managing and tracking feed mill production orders across multiple lines.

## Run & Operate

```bash
npm run dev
```

**Environment Variables:**
- `DATABASE_URL`: PostgreSQL connection string (auto-set by Replit)
- `VITE_AZURE_OPENAI_KEY`: Azure OpenAI API key (optional)

## Stack

- **Frontend:** React 18, Vite, Tailwind CSS, Radix UI
- **Backend:** Express.js
- **Database:** PostgreSQL
- **AI:** Azure OpenAI (gpt-4.1-mini)

## Where things live

- `server.js`: Express backend and API routes.
- `src/api/base44Client.js`: API client for local REST endpoints.
- `src/lib/AuthContext.jsx`: Authentication context (local admin, no-auth mode).
- `src/pages/Dashboard.jsx`: Main dashboard component. Also hosts the isolated "Fulfillment (Demo)" workspace: it is "demo-aware" via an `isDemo` flag (active when `activeSection === "fulfillment_demo"`) that swaps the `Order`/N10D entities and React Query keys to `Demo*`/`demo_*` so all existing handlers (combine, split, auto-sequence, status, reorder, edits) operate on demo data only.
- `src/components/orders/`: Production order management components.
- `src/components/chat/AIChatbot.jsx`: AI chatbot implementation.
- `src/components/utils/formatters.js`: Shared utility for data formatting.
- `src/utils/changeoverCalc.js`: Source of truth for changeover rules logic.

## Architecture decisions

- Replaced Base44 SDK/storage/auth with custom Express API, PostgreSQL, and local auth for Replit compatibility.
- Integrated Azure OpenAI directly for AI features like auto-sequencing and smart insights.
- Prioritized client-side cascade logic for scheduling calculations to provide immediate feedback.
- Implemented a "Readiness" column with a detailed tooltip to guide users on missing critical data for orders.
- Centralized changeover rules in `src/utils/changeoverCalc.js` to ensure consistent application across AI and manual scheduling.

## Product

- Production order management across Feedmill 1, 2, 3, and Powermix lines.
- AI-powered optimal sequencing with interactive simulation.
- Real-time scheduling conflict detection and cascading completion dates.
- Tools for combining production orders and managing order history (completed, cancelled, restored).
- Integrated AI chatbot and per-chart smart insights for data analysis.
- Customizable row highlighting and cell-level commenting.
- Specialized handling for Powermix (Line 5) specific fields.
- **Fulfillment (Demo)**: a fully isolated demo workspace (left nav, after Configurations) seeded once from live data via `POST /api/demo/seed` (uses `Demo*` entities + `demo_*` tables). Implemented by making `Dashboard.jsx` demo-aware (entity/query-key swap) rather than a separate container, so the demo reuses every live planning tool against `demo_*` data. Three tabs: All Feedmills, Order History, Future Dispatches. Includes fulfillment-from-inventory detection → pending "Pre-order" row suggestion (Approve/Dismiss) and an "Adjusted Inventory" column (= Inventory − satisfied order volume + AvgDaily, where AvgDaily = mean of day 1–10 demand). Divert/Revert are hidden in the demo. Seed only marks ready on success (with a Retry on failure). Never affects live data — the live-mutating `/api/powermix/apply-all` is skipped on demo uploads.

## User preferences

- **HA = Hand-Additives (Hand-Adds)** — not "Hauling Authority". HA Info and HA Prep columns both relate to the Hand-Additives preparation process. The HA batch count is auto-calculated from volume ÷ batch size.

## Gotchas

- Start Date/Time never cascade; only Completion Date cascades.
- Combining orders is always contiguous and follows specific volume limits per line.
- User-set Start Date/Time overrides downstream cascade chains.
- Orders marked "Done" are frozen in cascade but feed into subsequent orders.
- "Avail Date" year inference can show warnings if the inferred date is significantly in the past or future.

## Pointers

- [React Documentation](https://react.dev/learn)
- [Vite Documentation](https://vitejs.dev/guide/)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [Radix UI Documentation](https://www.radix-ui.com/docs/primitives)
- [Express.js Documentation](https://expressjs.com/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Azure OpenAI Service Documentation](https://learn.microsoft.com/en-us/azure/ai-services/openai/overview)