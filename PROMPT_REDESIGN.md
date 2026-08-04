# Expert Prompt — Vendalytics Design Revolution

## Context

Vendalytics is a B2B sales intelligence platform for distributors. It provides a real-time dashboard with KPIs (client count, active clients, 30-day revenue, sales reps), a Leaflet map of client locations, and a daily prioritized queue ("Fila do dia") showing accounts ranked by expected value with explainable AI factors and one-click outcome tracking.

The current frontend is plain HTML/CSS/JS — no framework, no build step. The design uses a simple blue/amber color scheme, flexbox layout, basic card components, and minimal micro-interactions. The codebase is production-grade on the backend (FastAPI, RBAC, audit trail, model versioning) but the frontend reads like a prototype.

## Your Task

Redesign the Vendalytics frontend to be **innovative, technological, and revolutionary** — not a cosmetic refresh, but a complete reimagining of how a sales intelligence platform *feels* and *communicates data*. The redesign must make a VP of Sales stop scrolling and say "show me that again."

## Design Principles

1. **Data as atmosphere** — Metrics should not sit in static cards; they should breathe, pulse, and respond to the underlying data. The dashboard should feel alive.
2. **Progressive disclosure** — Surface the critical insight first, then let the user drill deeper without leaving the page. Every number tells a story on hover/focus.
3. **Spatial intelligence** — The map is not a background decoration; it is the primary navigation surface. The UI should orbit around it, not the other way around.
4. **Trust through transparency** — Model quality, confidence, and factors must be communicated visually, not buried in text. The user should *feel* the reliability of the AI.
5. **Zero friction, zero navigation** — Every action (close a deal, register an outcome, inspect a factor) must be achievable in one interaction, without modals that block the view.

## Specific Deliverables

### 1. Dashboard (`index.html` — KPI + Map)

- **Hero KPI strip**: Replace static `.kpi` cards with animated, glassmorphic metric cards that have:
  - A radial progress ring or sparkline that animates on load (use SVG or Canvas)
  - A subtle gradient background that shifts based on the metric value (e.g., revenue card shifts from cool blue to warm gold as the number increases)
  - A micro-counter animation that counts up from 0 to the real value on load
  - A contextual trend indicator (up/down arrow with percentage) fetched from the API or computed client-side
  - A subtle glow or shadow that intensifies on hover

- **Map as the centerpiece**: The Leaflet map should be the dominant visual element, not a 60vh rectangle at the bottom.
  - Implement a **dark-themed map** with custom tile styling (use CartoDB dark matter or a custom style)
  - Client markers should be **glowing circles** with size proportional to expected value, color-coded by status (active = vibrant cyan, inactive = muted red)
  - Add a **heatmap overlay** layer toggle showing client density
  - Markers should have a **pulse animation** (CSS keyframes) to indicate "live" data
  - On marker hover, show a **rich tooltip** with client name, segment, expected value, and a mini sparkline of recent activity — not just a plain popup
  - Add a **floating minimap** or **spatial filter** in the corner that lets the user brush-select a region and see only that region's KPIs update in real time

- **Background atmosphere**: Add a subtle animated gradient or particle field behind the content (CSS or lightweight Canvas) that responds to mouse movement — parallax or subtle shift. This gives the page a "living" quality.

- **Top navigation**: Redesign the header as a **floating glass bar** with backdrop-filter blur, rounded corners, and a subtle border. The logo should be an animated mark (SVG animation on load). Navigation items should have an active indicator that slides smoothly.

### 2. Fila do Dia (`fila.html`)

- **Model quality strip**: Replace the plain `.faixa-modelo` with a **radial gauge dashboard** — each metric (AUC, ECE, Lift, Coverage) becomes a circular progress gauge with gradient fills and animated transitions on load. The gauges should be interactive: hovering reveals a detailed explanation tooltip.

- **Client cards**: Transform `.cartao` into a **glassmorphic card** with:
  - A subtle border gradient (animated)
  - A backdrop blur effect
  - A **confidence ring** around the client avatar/ID showing the model's confidence for that specific record
  - Factor bars that are **animated on load** (grow from 0 to value with a staggered delay)
  - A **mini radar chart** (SVG) showing the factor profile visually, not just horizontal bars
  - Outcome buttons that morph into a **satisfaction feedback** — after clicking, the card flips or dissolves with a satisfying micro-animation

- **Layout**: Use a **masonry or justified-grid** layout for the cards so the page feels dynamic and data-dense without being boring. Cards should have varying heights based on content richness.

- **Empty/loading states**: Replace "Carregando…" with a **skeleton screen** that mirrors the card layout, with shimmer animation.

### 3. Login (`login.html`)

- Full-screen **gradient background** with animated mesh or flowing blobs (CSS animated gradients or a lightweight canvas particle system)
- The login card should be a **glassmorphic floating island** with:
  - Subtle border gradient
  - Backdrop blur
  - Input fields with animated labels (label floats up on focus)
  - A shimmer effect on the submit button
  - Error shake animation on failed login

### 4. Global Design System

- **Color palette**: Build on the existing CSS custom properties but expand them:
  - Primary: `#2563eb` → keep as anchor, add `primary-glow`, `primary-subtle` variants
  - Add a **neutral dark mode** foundation: `--bg-deep: #0a0e1a`, `--bg-surface: #111827`, `--bg-card: rgba(255,255,255,0.04)`
  - Secondary accent: `#f59e0b` → add `secondary-glow`, `secondary-subtle`
  - Success: `#10b981`, Warning: `#f59e0b`, Danger: `#ef4444`, Info: `#3b82f6`
  - All colors should have **gradient variants** (e.g., `primary-gradient: linear-gradient(135deg, #2563eb, #7c3aed)`)

- **Typography**: Use a **display font** (Inter is fine for UI, but add a distinctive heading font like Space Grotesk or Satoshi) with clear hierarchy:
  - H1: 28-32px, weight 700, letter-spacing -0.02em
  - H2: 20-24px, weight 600
  - Body: 14px, weight 400, line-height 1.6
  - Numbers/data: tabular nums, monospace-adjacent (use `font-variant-numeric: tabular-nums`)

- **Spacing and radii**:
  - Cards: `border-radius: 16px` (already there, keep)
  - Page sections: generous padding with asymmetric margins (not uniform)
  - Use a **8px grid system** consistently

- **Shadows and depth**:
  - Cards: `box-shadow: 0 4px 24px rgba(0,0,0,0.06), 0 0 0 1px rgba(255,255,255,0.05) inset`
  - Floating elements: stronger shadow with spread
  - Use `backdrop-filter: blur(12px)` for glass surfaces

- **Animations**:
  - Page load: staggered fade-in + slide-up for each section (CSS `@keyframes` with `animation-delay`)
  - Hover: subtle scale (1.02) + shadow increase + border color shift
  - Click: quick scale down (0.98) then back — tactile feedback
  - Data updates: number flip animation (counting up), bar growth from 0
  - Transitions: `cubic-bezier(0.4, 0, 0.2, 1)` for smoothness, 200-300ms duration

- **Glassmorphism**: Apply consistently to cards, navigation, and floating elements:
  ```css
  .glass {
    background: rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
  }
  ```

### 5. Technical Constraints

- **No framework required** — keep it vanilla HTML/CSS/JS. The prompt should produce a self-contained frontend that works with the existing backend API contracts.
- **No new dependencies** unless they are loaded from CDN (e.g., a lightweight charting lib like Chart.js or uPlot for sparklines is acceptable; Leaflet stays).
- **Responsive** — must work on desktop and tablet. Mobile can be a simplified single-column layout.
- **Performance** — animations must be GPU-accelerated (transform, opacity only). No layout thrashing. The page should load in under 2 seconds on a 3G connection.
- **Accessibility** — maintain keyboard navigation, ARIA labels on interactive elements, sufficient color contrast (WCAG AA minimum).
- **Branding compatibility** — the redesign must still work with the runtime branding system (`branding.js`). CSS custom properties must remain the theming mechanism.

### 6. What the Prompt Must NOT Do

- Do not remove or break the existing API consumption (`/api/metrics/dashboard`, `/api/clientes`, `/api/fila/diaria`, `/api/fila/desfecho/`, `/api/fila/saude-do-loop`, `/api/tenant/branding`)
- Do not change the backend in any way
- Do not hardcode tenant names or colors in HTML — all branding must flow through `branding.js` and CSS custom properties
- Do not add server-side rendering requirements — this is a client-side SPA-like experience with vanilla JS

## Success Criteria

When the redesign is complete, the page should:
1. Feel like a **modern SaaS product**, not a prototype
2. Communicate data **instantly** — the user should understand the business state within 2 seconds of landing
3. Have **delightful micro-interactions** that reward exploration without being distracting
4. Maintain **full functionality** — every existing feature must still work
5. Be **visually distinctive** — it should not look like every other dashboard template
6. Feel **trustworthy** — the design should communicate that the AI behind it is reliable and transparent

## Output Format

Produce the complete redesigned files:
- `frontend/style.css` — full redesign with all design system tokens, animations, glassmorphism, responsive rules
- `frontend/index.html` — redesigned dashboard layout
- `frontend/fila.html` — redesigned queue layout
- `frontend/login.html` — redesigned login experience
- `frontend/app.js` — updated dashboard logic (animations, map enhancements, data loading)
- `frontend/fila.js` — updated queue logic (gauges, card interactions, animations)
- `frontend/branding.js` — no changes needed unless the design system requires new CSS variables

Each file must be complete and production-ready. No placeholder comments like "TODO" or "implement later." If a feature is not feasible without a backend change, note it as a CSS class with a comment explaining what the backend would need to provide.