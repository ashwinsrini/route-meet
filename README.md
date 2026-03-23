# RouteMeet

A Chrome extension that finds the best meetup point for a group of people heading to the same destination — right inside Google Maps.

The idea is simple: you and your friends are going to the same place, but you're all coming from different locations. Where should you meet up along the way so nobody goes too far out of their route? RouteMeet figures that out.

## How it works

1. Open [Google Maps](https://www.google.com/maps)
2. Search for any place — you'll see **Add Person** and **Set Destination** buttons injected into the place panel
3. Add 2–10 people and set a destination
4. Hit **Find Meetup Point**

RouteMeet fetches each person's route to the destination, finds where the routes converge, and shows you the optimal meetup point(s) with time estimates for everyone.

### What you get

- **Meetup chain** — for 3+ people, it builds a hierarchical merge tree: the closest pair meets first, then that group meets the next person, and so on
- **Landmark names** — each meetup point shows a nearby landmark or street name, not just coordinates
- **Per-person transport modes** — each person can independently choose Drive, Two-wheeler, or Walk
- **Journey summary table** — a quick-glance table showing cumulative travel time for each person at every meetup point
- **Shareable results** — copy the plan as text or share a Google Maps link with all the waypoints

## Installation

This isn't on the Chrome Web Store yet. To install it locally:

1. Clone this repo
   ```
   git clone https://github.com/ashwinsrini/route-meet.git
   ```
2. Open `chrome://extensions` in Chrome
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the cloned folder
5. Open Google Maps — you should see the RouteMeet widget in the bottom left

## Project structure

```
.
├── manifest.json              # Chrome extension manifest (v3)
├── background/
│   └── service-worker.js      # Route fetching, convergence algorithm, meetup chain
├── content/
│   ├── content.js             # UI injection, widget, results panel, state management
│   └── content.css            # All injected styles
├── popup/
│   ├── popup.html             # Extension popup (click the icon)
│   ├── popup.js               # Popup state display and controls
│   └── popup.css              # Popup styles
└── icons/                     # Extension icons (16, 48, 128px)
```

## The algorithm

For 2 people, it's straightforward — walk backwards from the destination along both routes until the paths diverge. That divergence point is your meetup.

For 3+ people, it uses a **hierarchical pairwise merge**:
1. Compute pairwise convergence for every combination
2. The pair that converges earliest (closest to their origins) meets first
3. Merge that pair into a group and repeat until everyone's been merged
4. Each merge step becomes a numbered meetup point

The convergence detection uses a 500m threshold on [haversine distance](https://en.wikipedia.org/wiki/Haversine_formula) between route coordinates. Transport mode doesn't affect the algorithm — it works purely on route geometry, so a walker and a driver naturally produce different meetup points and times.

## Technical notes

- **No API keys required.** RouteMeet uses Google Maps' internal directions endpoint (`/maps/preview/directions`), the same one the Maps frontend uses. No billing, no quotas, no setup.
- **Manifest V3** with a service worker (no background page).
- **Permissions are minimal**: `activeTab`, `scripting`, `storage`. Host access limited to `google.com/maps` and `google.co.in/maps`.
- **XSS-safe.** All user-provided text (place names, custom labels) is escaped before rendering.
- **State persists** in `chrome.storage.local` — your people/destination selections survive tab refreshes and the results panel survives in-page navigation.
- **Breakage detection** — a daily [GitHub Actions health check](.github/workflows/health-check.yml) validates the API response structure and auto-creates an issue if Google changes anything. The extension also shows a "Report this issue" link when parsing fails.

## Privacy

RouteMeet runs entirely in your browser. It doesn't collect any data, phone home, or talk to any server other than Google Maps (which you're already using). Your selections are stored locally in Chrome's extension storage and never leave your machine.

## Known limitations

- Only works on `google.com/maps` and `google.co.in/maps`
- Transit and cycling modes aren't supported yet (Google's internal API handles them differently)
- The convergence algorithm uses route coordinates sampled at turn-by-turn steps, so very short routes (under ~200m) might not have enough points for accurate convergence detection
- Rate limits: if you add many people quickly, Google may throttle the direction requests. The extension retries automatically, but very large groups might take a moment.

## Contributing

Issues and PRs are welcome. The codebase is vanilla JS with no build step — just edit and reload the extension.

## License

MIT
