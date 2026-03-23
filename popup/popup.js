const COLORS = ['#4285F4', '#EA4335', '#FBBC04', '#9334E6', '#E91E63',
                '#00ACC1', '#FF6D00', '#43A047', '#8D6E63', '#546E7A'];
const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

document.addEventListener('DOMContentLoaded', () => {
  const findBtn = document.getElementById('find-btn');
  const clearBtn = document.getElementById('clear-btn');
  const showWidgetBtn = document.getElementById('show-widget-btn');
  const notOnMaps = document.getElementById('not-on-maps');
  const instructions = document.getElementById('instructions');
  const selections = document.getElementById('selections');

  let activeTabId = null;
  let isEditing = false; // pause polling while editing
  let lastStateJSON = ''; // skip re-render if unchanged

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.match(/google\.(com|co\.\w+)\/maps/)) {
      instructions.classList.add('hidden');
      selections.classList.add('hidden');
      findBtn.classList.add('hidden');
      clearBtn.classList.add('hidden');
      showWidgetBtn.classList.add('hidden');
      notOnMaps.classList.remove('hidden');
      return;
    }
    activeTabId = tab.id;
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] }).catch(() => {});
    loadState();
  });

  const pollInterval = setInterval(loadState, 1000);
  window.addEventListener('unload', () => clearInterval(pollInterval));

  function loadState() {
    if (isEditing) return; // don't clobber the DOM while user is editing
    chrome.storage.local.get('rvState', (data) => {
      if (isEditing) return; // double-check after async
      const state = data.rvState || { people: [], destination: null };
      const stateJSON = JSON.stringify(state);
      if (stateJSON === lastStateJSON) return; // skip if unchanged
      lastStateJSON = stateJSON;
      renderSelections(state);
      findBtn.disabled = !(state.people && state.people.length >= 2 && state.destination);
    });
  }

  function renderSelections(state) {
    let html = '';
    if (state.people) {
      state.people.forEach((p, i) => {
        const c = COLORS[i % COLORS.length];
        const displayName = p.customName
          ? esc(p.customName) + ' <span class="sel-place">(' + esc(p.name) + ')</span>'
          : esc(p.name);
        const titleText = p.customName
          ? escAttr(p.customName) + ' (' + escAttr(p.name) + ')'
          : escAttr(p.name);
        const fullTitle = titleText + (p.address ? '\n' + escAttr(p.address) : '');
        html += `<div class="sel-row">
          <span class="sel-dot" style="background:${c}"></span>
          <span class="sel-label">P${i + 1}:</span>
          <span class="sel-name sel-name-editable" data-index="${i}" title="${fullTitle}">${displayName}</span>
        </div>`;
      });
    }
    if (!state.people || state.people.length === 0) {
      html += '<div class="sel-row"><span class="sel-dot" style="background:#ddd"></span><span class="sel-name sel-empty">No people added yet</span></div>';
    }
    html += '<div class="sel-divider"></div>';
    if (state.destination) {
      const destTitle = escAttr(state.destination.name) + (state.destination.address ? '\n' + escAttr(state.destination.address) : '');
      html += `<div class="sel-row">
        <span class="sel-dot" style="background:#34A853"></span>
        <span class="sel-label">D:</span>
        <span class="sel-name" title="${destTitle}">${esc(state.destination.name)}</span>
      </div>`;
    } else {
      html += '<div class="sel-row"><span class="sel-dot" style="background:#ddd"></span><span class="sel-name sel-empty">No destination set</span></div>';
    }
    selections.innerHTML = html;
  }

  // Inline name editing in popup
  selections.addEventListener('click', (e) => {
    const target = e.target.closest('.sel-name-editable');
    if (!target) return;
    const idx = parseInt(target.dataset.index);
    isEditing = true;
    chrome.storage.local.get('rvState', (data) => {
      const state = data.rvState;
      if (!state || !state.people || !state.people[idx]) { isEditing = false; return; }
      const p = state.people[idx];
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'sel-name-input';
      input.value = p.customName || '';
      input.placeholder = 'Enter name (e.g. Ashwin)';
      target.replaceWith(input);
      input.focus();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        isEditing = false;
        const val = input.value.trim();
        state.people[idx].customName = val || null;
        lastStateJSON = ''; // force re-render on next poll
        chrome.storage.local.set({ rvState: state }, () => {
          loadState();
          if (activeTabId) {
            chrome.tabs.sendMessage(activeTabId, { action: 'refreshState' }).catch(() => {});
          }
        });
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') { input.value = ''; input.blur(); }
      });
    });
  });

  findBtn.addEventListener('click', () => {
    if (!activeTabId) return;
    findBtn.disabled = true;
    findBtn.textContent = 'Calculating...';
    chrome.tabs.sendMessage(activeTabId, { action: 'triggerFind' }, () => {
      findBtn.disabled = false;
      findBtn.textContent = 'Find Meetup Point';
    });
  });

  clearBtn.addEventListener('click', () => {
    if (!activeTabId) return;
    chrome.tabs.sendMessage(activeTabId, { action: 'clearAll' }, () => {
      lastStateJSON = '';
      loadState();
    });
  });

  showWidgetBtn.addEventListener('click', () => {
    if (!activeTabId) return;
    chrome.tabs.sendMessage(activeTabId, { action: 'showWidget' });
  });
});
