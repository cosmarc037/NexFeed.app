---
name: Mash shutdown diversion
description: How Mash orders on active lines surface as opportunistic diversion candidates TO shutdown lines, and how DivertOrderDialog handles the fixed destination.
---

## Rule
When a line is in shutdown, Mash orders (form='M') on OTHER active lines get highlighted green and offered as diversion candidates TO that shutdown line.

**Why:** Mash skips the pellet mill, so it can physically run on a "pellet-mill-down" shutdown line. This is the reverse of the normal shutdown-divert flow (which diverts orders OFF a shutdown line).

**How to apply:**
- `getMashShutdownDiversionInfo()` in `OrderTable.jsx` (after `getDivertInfo`) — checks form, eligible status, active line, finds best shutdown-line candidate.
- Rows get `bg-[#d1fae5]` (light green) + clickable note: "🌿 Line X is shutdown — consider diverting…"
- Clicking calls `onMashShutdownDivertOrder(order, shutdownLine)` → `setMashShutdownDivertDialog({ order, shutdownLine })` in Dashboard.
- `DivertOrderDialog` accepts `fixedDestinationLine` prop; when set it bypasses `!allShutdownLines.includes(l)` filter, shows green "Mash Opportunistic Diversion" banner, sets `isMashShutdownDiversion: true` in calcsAtConfirm.
- `handleDivertOrderConfirm` in Dashboard logs `[Mash Shutdown Diversion Applied]` and closes both `divertDialog` and `mashShutdownDivertDialog`.
- Debug log chain: `[Mash Shutdown Diversion Opportunity]` → `[Mash Shutdown Diversion Modal]` → `[Mash Shutdown Diversion Applied]`.
