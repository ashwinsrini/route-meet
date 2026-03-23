// Content script: injects buttons into Google Maps place panels,
// manages dynamic people + destination, triggers meetup point calculation.

(function () {
  if (window.__rvLoaded) return;
  window.__rvLoaded = true;

  const MAX_PEOPLE = 10;
  const REPO_URL = 'https://github.com/ashwinsrini/route-meet';
  const COLORS = ['#4285F4', '#EA4335', '#FBBC04', '#9334E6', '#E91E63',
                  '#00ACC1', '#FF6D00', '#43A047', '#8D6E63', '#546E7A'];
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Mode values map to Google Maps internal API !1e{N} parameter
  const MODES = [
    { value: 0, icon: '\uD83D\uDE97', label: 'Drive' },
    { value: 9, icon: '\uD83D\uDEF5', label: 'Two-wheeler' },
    { value: 2, icon: '\uD83D\uDEB6', label: 'Walk' }
  ];
  function modeIcon(m) { return (MODES.find(x => x.value === m) || MODES[0]).icon; }

  // --- State ---
  const state = { people: [], destination: null };

  function saveState() {
    chrome.storage.local.set({ rvState: state });
    updateWidget();
    updateButtons();
  }

  function loadState() {
    chrome.storage.local.get('rvState', (data) => {
      if (data.rvState) {
        state.people = data.rvState.people || [];
        state.destination = data.rvState.destination || null;
      }
      updateWidget();
    });
  }

  // --- Format duration from seconds (client-side) ---
  function formatDurationClient(seconds) {
    if (seconds < 60) return seconds + ' sec';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return mins + ' min';
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? hrs + ' hr ' + rem + ' min' : hrs + ' hr';
  }

  // --- Display label for a person ---
  function personLabel(idx) {
    const p = state.people[idx];
    if (!p) return 'P' + (idx + 1);
    return p.customName || ('P' + (idx + 1));
  }

  function personLabelWithMode(idx) {
    const p = state.people[idx];
    if (!p) return 'P' + (idx + 1);
    return modeIcon(p.mode || 0) + ' ' + personLabel(idx);
  }

  // --- Extract place info from current panel ---
  function getPlaceName(container) {
    return container.getAttribute('aria-label') ||
      (container.querySelector('h1') && container.querySelector('h1').textContent) || '';
  }

  function getCurrentPlace() {
    const container = Array.from($$("[role='main']")).pop();
    if (!container) return null;

    const name = getPlaceName(container);
    if (!name || name === 'Directions') return null;

    const addressEl = container.querySelector("[data-item-id='address']") ||
      container.querySelector("[data-tooltip='Copy address']");
    const rawAddr = addressEl ? addressEl.textContent : '';
    const address = rawAddr && rawAddr.charCodeAt(0) > 10000 ? rawAddr.substring(1).trim() : rawAddr.trim();

    const plusCodeBtn = container.querySelector("[data-item-id='oloc']");
    let plusCode = '';
    if (plusCodeBtn) {
      const pcText = plusCodeBtn.textContent.trim();
      const pcMatch = pcText.match(/([2-9A-Z][2-9A-Z0-9]*\+[2-9A-Z0-9]+\s+.+)/);
      plusCode = pcMatch ? pcMatch[1].trim() : '';
    }

    let lat = null, lng = null;
    const urlMatch = window.location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (urlMatch) { lat = parseFloat(urlMatch[1]); lng = parseFloat(urlMatch[2]); }

    // For search query: prefer coordinates (most precise and unambiguous),
    // fall back to name + address
    const searchQuery = (lat && lng)
      ? lat.toFixed(6) + ',' + lng.toFixed(6)
      : (name.trim() + (address ? ', ' + address : ''));

    return {
      name: name.trim(),
      address,
      plusCode,
      lat, lng,
      searchQuery
    };
  }

  // Check if a place is already assigned
  function findAssignment(placeName) {
    const pIdx = state.people.findIndex(p => p.name === placeName);
    if (pIdx >= 0) return { type: 'person', index: pIdx };
    if (state.destination && state.destination.name === placeName) return { type: 'destination' };
    return null;
  }

  // --- Inject buttons into place panel ---
  function injectButtons() {
    const container = Array.from($$("[role='main']")).pop();
    if (!container) return;
    if (container.querySelector('.rv-btn-container')) return;

    const name = getPlaceName(container);
    if (!name || name === 'Directions') return;

    const actionBar = container.querySelector("[aria-label*='Actions']") ||
      container.querySelector("[role='group']");

    const btnContainer = document.createElement('div');
    btnContainer.className = 'rv-btn-container';

    const assignment = findAssignment(name);

    // "Add Person" button
    const addBtn = document.createElement('button');
    addBtn.className = 'rv-set-btn';
    addBtn.dataset.role = 'person';
    if (assignment && assignment.type === 'person') {
      const c = COLORS[assignment.index % COLORS.length];
      addBtn.innerHTML = `<span class="rv-dot" style="background:${c}"></span>Person ${assignment.index + 1} <span class="rv-check">\u2713</span>`;
      addBtn.classList.add('rv-selected');
      addBtn.style.background = c + '18';
      addBtn.style.color = c;
    } else {
      const canAdd = state.people.length < MAX_PEOPLE;
      addBtn.innerHTML = '<span class="rv-dot" style="background:#4285F4"></span>Add Person' +
        (canAdd ? '' : ' (max ' + MAX_PEOPLE + ')');
      addBtn.disabled = !canAdd;
      addBtn.style.background = '#e8f0fe';
      addBtn.style.color = '#1a73e8';
    }

    addBtn.addEventListener('click', () => {
      const place = getCurrentPlace();
      if (!place) return;
      // If already a person, remove it
      const existing = findAssignment(place.name);
      if (existing && existing.type === 'person') {
        state.people.splice(existing.index, 1);
        saveState();
        refreshButtons();
        return;
      }
      if (state.people.length >= MAX_PEOPLE) return;
      // Remove from destination if assigned there
      if (state.destination && state.destination.name === place.name) state.destination = null;
      place.mode = 0; // default: driving
      state.people.push(place);
      saveState();
      refreshButtons();
    });
    btnContainer.appendChild(addBtn);

    // "Set Destination" button
    const destBtn = document.createElement('button');
    destBtn.className = 'rv-set-btn';
    destBtn.dataset.role = 'dest';
    destBtn.style.background = '#e6f4ea';
    destBtn.style.color = '#1e8e3e';
    if (assignment && assignment.type === 'destination') {
      destBtn.innerHTML = '<span class="rv-dot" style="background:#34A853"></span>Destination <span class="rv-check">\u2713</span>';
      destBtn.classList.add('rv-selected');
    } else {
      destBtn.innerHTML = '<span class="rv-dot" style="background:#34A853"></span>Set Destination';
    }

    destBtn.addEventListener('click', () => {
      const place = getCurrentPlace();
      if (!place) return;
      // Remove from people if assigned there
      const existing = findAssignment(place.name);
      if (existing && existing.type === 'person') {
        state.people.splice(existing.index, 1);
      }
      if (existing && existing.type === 'destination') {
        state.destination = null;
        saveState();
        refreshButtons();
        return;
      }
      state.destination = place;
      saveState();
      refreshButtons();
    });
    btnContainer.appendChild(destBtn);

    if (actionBar) {
      actionBar.after(btnContainer);
    } else {
      const tabs = container.querySelector("[role='tablist']");
      if (tabs) tabs.after(btnContainer);
      else container.querySelector('h1')?.closest('div')?.after(btnContainer);
    }
  }

  function refreshButtons() {
    $$('.rv-btn-container').forEach(c => c.remove());
    injectButtons();
  }

  function updateButtons() {
    // Just refresh all buttons to reflect current state
    $$('.rv-btn-container').forEach(c => c.remove());
    setTimeout(injectButtons, 100);
  }

  // --- Floating widget ---
  function createWidget() {
    if ($('#rv-widget')) return;
    const widget = document.createElement('div');
    widget.id = 'rv-widget';
    document.body.appendChild(widget);
    renderWidget();

    widget.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;

      if (action === 'close') widget.style.display = 'none';
      if (action === 'minimize') {
        widget.classList.toggle('rv-w-minimized');
        renderWidget();
      }
      if (action === 'find') findMeetupPoint();
      if (action === 'clear') {
        state.people = [];
        state.destination = null;
        saveState();
        removeResults(true);
      }
      if (action === 'remove-person') {
        const idx = parseInt(target.dataset.index);
        state.people.splice(idx, 1);
        saveState();
      }
      if (action === 'remove-dest') {
        state.destination = null;
        saveState();
      }
      if (action === 'edit-name') {
        const idx = parseInt(target.dataset.index);
        const p = state.people[idx];
        if (!p) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rv-w-name-input';
        input.value = p.customName || '';
        input.placeholder = 'Enter name (e.g. Ashwin)';
        target.replaceWith(input);
        input.focus();
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          const val = input.value.trim();
          if (state.people[idx]) state.people[idx].customName = val || null;
          saveState();
        };
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { input.blur(); }
          if (ev.key === 'Escape') { input.value = ''; input.blur(); }
        });
      }
    });

    // Handle mode change (select elements use 'change', not 'click')
    widget.addEventListener('change', (e) => {
      const target = e.target;
      if (target.dataset.action === 'change-mode') {
        const idx = parseInt(target.dataset.index);
        if (state.people[idx]) {
          state.people[idx].mode = parseInt(target.value);
          saveState();
        }
      }
    });
  }

  function renderWidget() {
    const widget = $('#rv-widget');
    if (!widget) return;

    let peopleHtml = '';
    for (let i = 0; i < state.people.length; i++) {
      const c = COLORS[i % COLORS.length];
      const p = state.people[i];
      const displayName = p.customName
        ? `${esc(p.customName)} <span class="rv-w-place">(${esc(p.name)})</span>`
        : `P${i + 1}: ${esc(p.name)}`;
      const currentMode = MODES.find(m => m.value === (p.mode || 0)) || MODES[0];
      const modeOptions = MODES.map(m =>
        `<option value="${m.value}" ${m.value === (p.mode || 0) ? 'selected' : ''}>${m.icon} ${m.label}</option>`
      ).join('');
      peopleHtml += `
        <div class="rv-w-slot">
          <span class="rv-w-dot" style="background:${c}"></span>
          <span class="rv-w-name rv-w-editable" data-action="edit-name" data-index="${i}" title="${p.customName ? escAttr(p.customName) + ' (' + escAttr(p.name) + ')' : escAttr(p.name)}${p.address ? '\n' + escAttr(p.address) : ''}">${displayName}</span>
          <select class="rv-w-mode" data-action="change-mode" data-index="${i}" title="Transport mode">${modeOptions}</select>
          <button class="rv-w-remove" data-action="remove-person" data-index="${i}">&times;</button>
        </div>`;
    }
    if (state.people.length < MAX_PEOPLE) {
      peopleHtml += `
        <div class="rv-w-slot">
          <span class="rv-w-dot" style="background:#ddd"></span>
          <span class="rv-w-empty">Search & add person (${state.people.length}/${MAX_PEOPLE})</span>
        </div>`;
    }

    const destHtml = state.destination
      ? `<div class="rv-w-slot">
           <span class="rv-w-dot" style="background:#34A853"></span>
           <span class="rv-w-name" title="${escAttr(state.destination.name)}">${esc(state.destination.name)}</span>
           <button class="rv-w-remove" data-action="remove-dest">&times;</button>
         </div>`
      : `<div class="rv-w-slot">
           <span class="rv-w-dot" style="background:#ddd"></span>
           <span class="rv-w-empty">Search & set destination</span>
         </div>`;

    const canFind = state.people.length >= 2 && state.destination;

    const isMinimized = widget.classList.contains('rv-w-minimized');
    widget.innerHTML = `
      <div class="rv-w-header">
        <span>\u2605 RouteMeet</span>
        <div class="rv-w-header-actions">
          <button class="rv-w-minimize-btn" data-action="minimize" title="${isMinimized ? 'Maximize' : 'Minimize'}">${isMinimized ? '\u25A1' : '\u2014'}</button>
          <button class="rv-w-close" data-action="close">&times;</button>
        </div>
      </div>
      <div class="rv-w-body">
        <div class="rv-w-section-label">People</div>
        ${peopleHtml}
        <div class="rv-w-section-label" style="margin-top:8px">Destination</div>
        ${destHtml}
        <button class="rv-w-find" data-action="find" ${canFind ? '' : 'disabled'}>
          Find Meetup Point${state.people.length < 2 ? ' (need 2+ people)' : !state.destination ? ' (need destination)' : ''}
        </button>
        <button class="rv-w-clear" data-action="clear">Clear All</button>
      </div>`;
  }

  function updateWidget() {
    renderWidget();
  }

  // --- Find Meetup Point ---
  async function findMeetupPoint() {
    if (state.people.length < 2 || !state.destination) return;

    const findBtn = $('#rv-widget [data-action="find"]');
    if (findBtn) { findBtn.disabled = true; findBtn.textContent = 'Calculating...'; }

    removeResults();

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'findRendezvous',
        data: {
          people: state.people.map(p => ({
            query: p.searchQuery,
            mode: p.mode || 0,
            fallbackQuery: p.name + (p.address ? ', ' + p.address : '')
          })),
          destination: state.destination.searchQuery
        }
      });

      if (response && response.error) {
        showError(response.error, response.parsingStep);
      } else if (response && response.success) {
        chrome.storage.local.set({ rvResults: response });
        showResults(response);
      }
    } catch (err) {
      showError(err.message);
    } finally {
      if (findBtn) { findBtn.disabled = false; findBtn.textContent = 'Find Meetup Point'; }
    }
  }

  // --- Show results ---
  function showResults(data) {
    removeResults();

    const panel = document.createElement('div');
    panel.id = 'rv-results';

    // Build meetup chain HTML
    let meetupsHtml = '';
    const meetupCoords = []; // collect for "View All" URL

    for (const meetup of data.meetups) {
      const coord = meetup.point.lat.toFixed(6) + ',' + meetup.point.lng.toFixed(6);
      meetupCoords.push(coord);

      // Who is meeting whom?
      let whoHtml = '';
      if (meetup.groupA && meetup.groupB) {
        const labelA = meetup.groupA.map(i => personLabel(i)).join(' + ');
        const labelB = meetup.groupB.map(i => personLabel(i)).join(' + ');
        whoHtml = `<div class="rv-m-who">${esc(labelA)} meets ${esc(labelB)}</div>`;
      } else {
        whoHtml = `<div class="rv-m-who">${meetup.who.map(i => personLabel(i)).join(' & ')} meet here</div>`;
      }

      // Landmark
      let landmarkHtml = '';
      if (meetup.landmark) {
        landmarkHtml = `<div class="rv-m-landmark">near ${esc(meetup.landmark)}</div>`;
      }

      // Individual arrivals (people coming from their origin)
      let arrivalsHtml = '';
      if (meetup.arrivals && meetup.arrivals.length > 0) {
        for (const arr of meetup.arrivals) {
          const c = COLORS[arr.personIdx % COLORS.length];
          arrivalsHtml += `
            <div class="rv-m-arrival">
              <span class="rv-w-dot" style="background:${c}"></span>
              <span class="rv-m-arrival-name">${esc(personLabelWithMode(arr.personIdx))}</span>
              <span class="rv-m-arrival-desc">will take</span>
              <span class="rv-m-arrival-time">${esc(arr.time)}</span>
              <span class="rv-m-arrival-desc">to reach</span>
            </div>`;
        }
      }

      // Group travels (merged groups traveling together from previous meetup)
      let groupTravelsHtml = '';
      if (meetup.groupTravels && meetup.groupTravels.length > 0) {
        for (const gt of meetup.groupTravels) {
          const label = gt.members.map(i => personLabel(i)).join(' + ');
          const toLabel = gt.toStep ? ' to Meetup ' + gt.toStep : '';
          groupTravelsHtml += `
            <div class="rv-m-together">
              <span class="rv-m-together-label">${esc(label)} together${toLabel}</span>
              <span class="rv-m-together-time">${esc(gt.time)}</span>
            </div>`;
        }
      }

      // Note if meetup is very close to destination or very close to start
      let meetupNote = '';
      if (meetup.avgFraction != null) {
        if (meetup.avgFraction > 0.85) {
          meetupNote = '<div class="rv-m-note">Routes converge near the destination \u2014 a separate meetup may not be needed</div>';
        } else if (meetup.avgFraction < 0.1) {
          meetupNote = '<div class="rv-m-note">Routes start very close together</div>';
        }
      }

      meetupsHtml += `
        <div class="rv-m-step">
          <div class="rv-m-step-badge">${meetup.step}</div>
          <div class="rv-m-step-content">
            <div class="rv-m-step-title">Meetup ${meetup.step}</div>
            ${landmarkHtml}
            ${whoHtml}
            ${meetupNote}
            <div class="rv-m-arrivals">${arrivalsHtml}</div>
            ${groupTravelsHtml}
            <a class="rv-m-map-link" href="https://www.google.com/maps/search/${coord}">
              View on map \u2192
            </a>
          </div>
        </div>`;
    }

    // Helper: get a clean coordinate string for a person/place
    function placeCoord(place) {
      if (place.lat && place.lng) return place.lat.toFixed(6) + ',' + place.lng.toFixed(6);
      return encodeURIComponent(place.searchQuery);
    }

    // Compute per-person cumulative journey time at each meetup step + destination
    // personCumSeconds[i] = running total seconds for person i
    const numPeople = data.routes.length;
    const personCumSeconds = new Array(numPeople).fill(0);
    const personAccountedFor = new Array(numPeople).fill(false);
    // personTimeAtMeetup[stepIdx][personIdx] = cumulative seconds to reach that meetup (null if not yet joined)
    const personTimeAtMeetup = [];

    for (const meetup of data.meetups) {
      if (meetup.arrivals) {
        for (const arr of meetup.arrivals) {
          if (arr.seconds != null) {
            personCumSeconds[arr.personIdx] += arr.seconds;
            personAccountedFor[arr.personIdx] = true;
          }
        }
      }
      if (meetup.groupTravels) {
        for (const gt of meetup.groupTravels) {
          if (gt.seconds != null) {
            for (const idx of gt.members) {
              personCumSeconds[idx] += gt.seconds;
              personAccountedFor[idx] = true;
            }
          }
        }
      }
      // Snapshot cumulative times at this meetup
      const snapshot = new Array(numPeople).fill(null);
      for (const idx of meetup.who) {
        if (personAccountedFor[idx]) snapshot[idx] = personCumSeconds[idx];
      }
      personTimeAtMeetup.push(snapshot);
    }

    // Add remaining time (last meetup → destination) for everyone
    const remSec = data.remainingSeconds || 0;
    const personJourneySeconds = personCumSeconds.map((s, i) =>
      personAccountedFor[i] ? s + remSec : 0
    );

    // Per-person route links — each person's route goes through all meetup points
    let routeLinksHtml = '';
    for (let i = 0; i < data.routes.length; i++) {
      const r = data.routes[i];
      const c = COLORS[i % COLORS.length];

      // Build route: PersonOrigin → [meetup points] → Destination
      const parts = [placeCoord(state.people[i])];
      for (const coord of meetupCoords) parts.push(coord);
      parts.push(placeCoord(state.destination));
      const dirUrl = 'https://www.google.com/maps/dir/' + parts.join('/');

      const pLabel = personLabel(i);
      // Show via-meetup estimated time if available, with direct time for reference
      const viaMeetupTime = personAccountedFor[i] ? formatDurationClient(personJourneySeconds[i]) : '';
      const timeDisplay = viaMeetupTime
        ? `${viaMeetupTime} via meetups (direct: ${r.totalTime})`
        : `${r.totalTime} (${r.totalDistance})`;
      routeLinksHtml += `
        <a class="rv-r-link" href="${dirUrl}" style="border-left:3px solid ${c}">
          <span>${esc(pLabel)}: ${esc(state.people[i].name)}</span>
          <span class="rv-r-link-sub">${esc(timeDisplay)}</span>
        </a>`;
    }

    // "View All" URL — use coordinates for clean shareable links
    const allParts = state.people.map(p => placeCoord(p));
    for (const coord of meetupCoords) allParts.push(coord);
    allParts.push(placeCoord(state.destination));
    const viewAllUrl = 'https://www.google.com/maps/dir/' + allParts.join('/');

    // "All together" text with last meetup reference
    const lastMeetupStep = data.meetups.length > 0 ? data.meetups[data.meetups.length - 1].step : 0;
    const destName = esc(state.destination ? state.destination.name : 'destination');
    const fromMeetupText = lastMeetupStep > 0 ? ` from Meetup ${lastMeetupStep}` : '';

    // Journey summary table — cumulative times from each person's start
    let tableHtml = '';
    const destColName = esc(state.destination ? state.destination.name : 'Dest');
    const meetupHeaders = data.meetups.map(m => 'Meetup ' + m.step);

    let headerCells = '<th class="rv-t-corner">From start</th>';
    for (const h of meetupHeaders) headerCells += `<th class="rv-t-col-header">${h}</th>`;
    headerCells += `<th class="rv-t-col-header rv-t-sortable" data-sort="dest">${destColName} \u21C5</th>`;

    // Build row data for sorting
    const tableRowData = [];
    for (let i = 0; i < numPeople; i++) {
      const c = COLORS[i % COLORS.length];
      const label = esc(personLabel(i));
      const originName = esc(state.people[i] ? state.people[i].name : '');
      let cells = `<td class="rv-t-row-header"><span class="rv-t-dot" style="background:${c}"></span><span><span class="rv-t-person">${label}</span><span class="rv-t-origin" title="${escAttr(state.people[i] ? state.people[i].name : '')}">${originName}</span></span></td>`;
      let prevRoundedMin = 0;
      for (let s = 0; s < data.meetups.length; s++) {
        const sec = personTimeAtMeetup[s][i];
        if (sec != null) {
          const cumMin = Math.round(sec / 60);
          const legMin = cumMin - prevRoundedMin;
          const legText = prevRoundedMin > 0 ? '+' + legMin + ' min' : '';
          cells += `<td class="rv-t-cell"><span class="rv-t-cumulative">${cumMin} min</span>${legText ? `<span class="rv-t-leg">${esc(legText)}</span>` : ''}</td>`;
          prevRoundedMin = cumMin;
        } else {
          cells += `<td class="rv-t-cell rv-t-na">\u2014</td>`;
        }
      }
      // Destination column
      let destSec = Infinity;
      if (personAccountedFor[i]) {
        destSec = personJourneySeconds[i];
        const cumMin = Math.round(destSec / 60);
        const legMin = cumMin - prevRoundedMin;
        const legText = prevRoundedMin > 0 ? '+' + legMin + ' min' : '';
        cells += `<td class="rv-t-cell rv-t-dest"><span class="rv-t-cumulative">${cumMin} min</span>${legText ? `<span class="rv-t-leg">${esc(legText)}</span>` : ''}</td>`;
      } else {
        cells += `<td class="rv-t-cell rv-t-na">\u2014</td>`;
      }
      tableRowData.push({ idx: i, cells, destSec });
    }

    const defaultRows = tableRowData.map(r => `<tr>${r.cells}</tr>`).join('');

    tableHtml = `
      <div class="rv-r-section-label" style="margin-top:12px">Journey Summary</div>
      <div class="rv-t-wrapper">
        <table class="rv-t-table">
          <thead><tr>${headerCells}</tr></thead>
          <tbody class="rv-t-body">${defaultRows}</tbody>
        </table>
      </div>`;

    panel.innerHTML = `
      <div class="rv-r-header">
        <span>\u2605 Meetup Plan</span>
        <div class="rv-r-header-actions">
          <button class="rv-r-minimize" title="Minimize">\u2014</button>
          <button class="rv-r-close">&times;</button>
        </div>
      </div>
      <div class="rv-r-body">
        <div class="rv-m-chain">${meetupsHtml}</div>
        <div class="rv-r-remaining">
          <span>All together${fromMeetupText} to ${destName}:</span>
          <span class="rv-r-remaining-val">${esc(data.remainingTime)}</span>
        </div>
        ${tableHtml}
        <div class="rv-r-section-label" style="margin-top:12px">View routes in Google Maps</div>
        <a class="rv-r-view-all" href="${viewAllUrl}">View All Routes \u2192</a>
        <div class="rv-r-routes-list">${routeLinksHtml}</div>
        <div class="rv-r-share-row">
          <button class="rv-r-share-btn" id="rv-copy-text">\ud83d\udccb Copy as Text</button>
          <button class="rv-r-share-btn rv-r-share-link" id="rv-share-link">\ud83d\udd17 Share Link</button>
        </div>
      </div>`;

    document.body.appendChild(panel);
    panel.querySelector('.rv-r-close').addEventListener('click', () => removeResults(true));

    // Minimize toggle
    panel.querySelector('.rv-r-minimize').addEventListener('click', () => {
      const btn = panel.querySelector('.rv-r-minimize');
      panel.classList.toggle('rv-minimized');
      btn.textContent = panel.classList.contains('rv-minimized') ? '\u25A1' : '\u2014';
      btn.title = panel.classList.contains('rv-minimized') ? 'Maximize' : 'Minimize';
    });

    // Sortable destination column
    let sortState = 'none'; // none → asc → desc → none
    const sortHeader = panel.querySelector('.rv-t-sortable');
    const tbody = panel.querySelector('.rv-t-body');
    if (sortHeader && tbody) {
      sortHeader.addEventListener('click', () => {
        if (sortState === 'none') sortState = 'asc';
        else if (sortState === 'asc') sortState = 'desc';
        else sortState = 'none';

        const sorted = [...tableRowData];
        if (sortState === 'asc') sorted.sort((a, b) => a.destSec - b.destSec);
        else if (sortState === 'desc') sorted.sort((a, b) => b.destSec - a.destSec);
        else sorted.sort((a, b) => a.idx - b.idx);

        tbody.innerHTML = sorted.map(r => `<tr>${r.cells}</tr>`).join('');

        const indicator = sortState === 'asc' ? ' \u25B2' : sortState === 'desc' ? ' \u25BC' : ' \u21C5';
        sortHeader.textContent = destColName + indicator;
      });
    }

    // Build shareable text
    const shareText = buildShareText(data, meetupCoords, viewAllUrl);

    panel.querySelector('#rv-copy-text').addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(shareText);
        e.target.textContent = '\u2713 Copied!';
        setTimeout(() => { e.target.textContent = '\ud83d\udccb Copy as Text'; }, 2000);
      } catch (err) {
        // Fallback: select and copy
        const ta = document.createElement('textarea');
        ta.value = shareText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        e.target.textContent = '\u2713 Copied!';
        setTimeout(() => { e.target.textContent = '\ud83d\udccb Copy as Text'; }, 2000);
      }
    });

    panel.querySelector('#rv-share-link').addEventListener('click', async (e) => {
      if (navigator.share) {
        try {
          await navigator.share({
            title: 'RouteMeet - Meetup Plan',
            text: shareText,
            url: viewAllUrl
          });
        } catch (err) {
          // User cancelled or share failed — ignore
        }
      } else {
        try {
          await navigator.clipboard.writeText(viewAllUrl);
          e.target.textContent = '\u2713 Link Copied!';
          setTimeout(() => { e.target.textContent = '\ud83d\udd17 Share Link'; }, 2000);
        } catch (err) {}
      }
    });
  }

  function buildShareText(data, meetupCoords, viewAllUrl) {
    let text = '\u2605 RouteMeet Plan\n\n';

    for (const meetup of data.meetups) {
      const coord = meetup.point.lat.toFixed(5) + ',' + meetup.point.lng.toFixed(5);
      let who;
      if (meetup.groupA && meetup.groupB) {
        const labelA = meetup.groupA.map(i => personLabel(i)).join('+');
        const labelB = meetup.groupB.map(i => personLabel(i)).join('+');
        who = labelA + ' meets ' + labelB;
      } else {
        who = meetup.who.map(i => personLabel(i)).join(' & ') + ' meet here';
      }

      text += 'Meetup ' + meetup.step + ': ' + who + '\n';
      if (meetup.landmark) text += '  Near: ' + meetup.landmark + '\n';
      text += '  Location: https://www.google.com/maps/search/' + coord + '\n';
      if (meetup.arrivals) {
        for (const arr of meetup.arrivals) {
          const pName = state.people[arr.personIdx] ? state.people[arr.personIdx].name : personLabel(arr.personIdx);
          text += '  ' + personLabelWithMode(arr.personIdx) + ' (' + pName + ') will take ' + arr.time + ' to reach\n';
        }
      }
      if (meetup.groupTravels) {
        for (const gt of meetup.groupTravels) {
          const label = gt.members.map(i => personLabel(i)).join('+');
          const toLabel = gt.toStep ? ' to Meetup ' + gt.toStep : '';
          text += '  ' + label + ' together' + toLabel + ': ' + gt.time + '\n';
        }
      }
      text += '\n';
    }

    const shareDestName = state.destination ? state.destination.name : 'destination';
    const shareLastStep = data.meetups.length > 0 ? data.meetups[data.meetups.length - 1].step : 0;
    const shareFromText = shareLastStep > 0 ? ' from Meetup ' + shareLastStep : '';
    text += 'All together' + shareFromText + ' to ' + shareDestName + ': ' + data.remainingTime + '\n\n';
    text += 'View all routes: ' + viewAllUrl + '\n';

    return text;
  }

  function removeResults(clearStorage) {
    const el = $('#rv-results');
    if (el) el.remove();
    if (clearStorage) chrome.storage.local.remove('rvResults');
  }

  function showError(errorMessage, parsingStep) {
    removeResults();
    const panel = document.createElement('div');
    panel.id = 'rv-results';

    const version = chrome.runtime.getManifest().version;
    const sanitized = errorMessage
      .replace(/-?\d+\.?\d*,-?\d+\.?\d*/g, '[coords]')
      .replace(/for: .+$/, 'for: [redacted]');
    const step = parsingStep || 'unknown';
    const issueTitle = encodeURIComponent('Parsing error: ' + step);
    const issueBody = encodeURIComponent(
      '## Bug Report\n\n' +
      '**Extension version:** ' + version + '\n' +
      '**Parsing step:** ' + step + '\n' +
      '**Error:** ' + sanitized + '\n' +
      '**Date:** ' + new Date().toISOString().split('T')[0] + '\n\n' +
      '_No personal data (coordinates, place names) is included in this report._'
    );
    const issueUrl = REPO_URL + '/issues/new?title=' + issueTitle + '&body=' + issueBody + '&labels=bug';

    panel.innerHTML = `
      <div class="rv-r-header">
        <span>\u2605 RouteMeet</span>
        <div class="rv-r-header-actions">
          <button class="rv-r-close">&times;</button>
        </div>
      </div>
      <div class="rv-r-body">
        <div class="rv-r-error-msg">${esc(errorMessage)}</div>
        <a class="rv-r-report-link" href="${issueUrl}" target="_blank">Report this issue on GitHub \u2192</a>
      </div>`;

    document.body.appendChild(panel);
    panel.querySelector('.rv-r-close').addEventListener('click', () => removeResults(true));
  }

  // --- MutationObserver ---
  let restoreTimer = null;
  function startObserver() {
    const mapContainer = $("[aria-label='Google Maps']");
    if (!mapContainer) { setTimeout(startObserver, 1000); return; }
    const target = mapContainer.lastChild || mapContainer;

    const observer = new MutationObserver(() => {
      setTimeout(injectButtons, 300);
      // Debounced restore: re-attach widget/results if removed by SPA navigation
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        if (!$('#rv-widget')) createWidget();
        if (!$('#rv-results')) {
          chrome.storage.local.get('rvResults', (data) => {
            if (data.rvResults && data.rvResults.success && !$('#rv-results')) {
              showResults(data.rvResults);
            }
          });
        }
      }, 500);
    });

    observer.observe(target, { childList: true, subtree: true, attributes: false });
    setTimeout(injectButtons, 1000);
  }

  // --- Messages from popup ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getState') sendResponse(state);
    if (message.action === 'triggerFind') {
      findMeetupPoint().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.action === 'clearAll') {
      state.people = [];
      state.destination = null;
      saveState();
      removeResults(true);
      sendResponse({ ok: true });
    }
    if (message.action === 'showWidget') {
      const w = $('#rv-widget');
      if (w) w.style.display = '';
      sendResponse({ ok: true });
    }
    if (message.action === 'refreshState') {
      loadState();
      sendResponse({ ok: true });
    }
  });

  // --- Init ---
  // Load state and restore results panel in one call to avoid race conditions
  chrome.storage.local.get(['rvState', 'rvResults'], (data) => {
    if (data.rvState) {
      state.people = data.rvState.people || [];
      state.destination = data.rvState.destination || null;
    }
    createWidget();
    if (data.rvResults && data.rvResults.success && !$('#rv-results')) {
      showResults(data.rvResults);
    }
  });
  startObserver();
  console.log('RouteMeet v3: loaded');
})();
