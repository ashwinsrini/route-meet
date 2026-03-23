// RouteMeet API Health Check
// Validates that Google Maps' internal directions API response structure
// hasn't changed. Run daily via GitHub Actions or locally with:
//   node tests/api-health-check.js [--json]
//
// Requires Node 18+ (built-in fetch).

const JSON_OUTPUT = process.argv.includes('--json');

// Stable coordinates: Bangalore Palace → MG Road Metro Station
// These are well-known landmarks unlikely to disappear.
const TEST_ORIGIN = '12.9988,77.5921';
const TEST_DEST = '12.9756,77.6066';

function buildPb(origin, destination) {
  // Mirrors service-worker.js lines 17-22
  return (
    '!1m1!1s' + encodeURIComponent(origin) +
    '!1m1!1s' + encodeURIComponent(destination) +
    '!3m12!1m3!1d17470.369063309543!2d77.6!3d13.0!2m3!1f0!2f0!3f0!3m2!1i1200!2i863!4f13.1' +
    '!6m27!1m5!18b1!30b1!31m1!1b1!34e1!2m4!5m1!6e2!20e3!39b1!10b1!12b1!13b1!14b1!16b1!17m1!3e0' +
    '!20m6!1e0!2e3!5e2!6b1!8b1!14b1!46m1!1b0!96b1!99b1'
  );
}

function check(name, condition, detail) {
  return { name, passed: !!condition, detail: detail || (condition ? 'ok' : 'failed') };
}

async function fetchDirections(retries = 1) {
  const url = 'https://www.google.com/maps/preview/directions?authuser=0&hl=en&gl=in&pb=' + buildPb(TEST_ORIGIN, TEST_DEST);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      const text = await res.text();
      return text;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const checks = [];
  let text, json;

  // Fetch
  try {
    text = await fetchDirections();
  } catch (e) {
    checks.push(check('fetch', false, 'Network error: ' + e.message));
    return finish(checks);
  }

  // Response prefix
  const hasPrefix = text.startsWith(')]}');
  checks.push(check('response prefix', hasPrefix,
    hasPrefix ? 'starts with )]}' : 'Unexpected prefix — request may be blocked by Google from CI'));
  if (!hasPrefix) return finish(checks);

  // JSON parse
  try {
    json = JSON.parse(text.substring(4));
  } catch (e) {
    checks.push(check('json parse', false, 'Parse error: ' + e.message));
    return finish(checks);
  }
  checks.push(check('json parse', true));

  // Structure validation — mirrors service-worker.js assertPath calls
  const s = (path, label) => {
    let cur = json;
    for (const k of path) {
      if (cur == null || typeof cur !== 'object') {
        checks.push(check(label, false, 'Missing at index ' + k));
        return null;
      }
      cur = cur[k];
    }
    checks.push(check(label, cur != null));
    return cur;
  };

  s([0], 'json[0] — response root');
  s([0, 0], 'json[0][0] — origin/dest markers');
  const originMarker = s([0, 0, 0], 'json[0][0][0] — origin marker');
  const destMarker = s([0, 0, 1], 'json[0][0][1] — destination marker');
  s([0, 1], 'json[0][1] — routes section');
  s([0, 1, 0], 'json[0][1][0] — first route');
  const route = s([0, 1, 0, 0], 'json[0][1][0][0] — route metadata');
  const legs = s([0, 1, 0, 1], 'json[0][1][0][1] — legs/steps');

  // Route metadata fields
  if (route) {
    checks.push(check('route[1] — route name', typeof route[1] === 'string', route[1] ? 'ok: ' + route[1] : 'missing'));
    checks.push(check('route[2][1] — distance text', route[2] && typeof route[2][1] === 'string', route[2] ? 'ok: ' + route[2][1] : 'missing'));
    checks.push(check('route[3][0] — duration seconds', route[3] && typeof route[3][0] === 'number', route[3] ? 'ok: ' + route[3][0] + 's' : 'missing'));
    checks.push(check('route[3][1] — duration text', route[3] && typeof route[3][1] === 'string', route[3] ? 'ok: ' + route[3][1] : 'missing'));
  }

  // findLatLng pattern — [null, null, lat, lng]
  function findLatLng(section) {
    if (!Array.isArray(section)) return null;
    if (section.length === 4 && section[0] === null && section[1] === null &&
        typeof section[2] === 'number' && typeof section[3] === 'number')
      return { lat: section[2], lng: section[3] };
    for (const item of section) { const f = findLatLng(item); if (f) return f; }
    return null;
  }

  if (originMarker) {
    const oc = findLatLng(originMarker);
    checks.push(check('findLatLng — origin', oc, oc ? 'ok: ' + oc.lat.toFixed(4) + ',' + oc.lng.toFixed(4) : 'pattern not found'));
  }
  if (destMarker) {
    const dc = findLatLng(destMarker);
    checks.push(check('findLatLng — destination', dc, dc ? 'ok: ' + dc.lat.toFixed(4) + ',' + dc.lng.toFixed(4) : 'pattern not found'));
  }

  // Step coordinate extraction — check sd[7] structure (recurse into sub-steps like extractCoords does)
  if (legs && Array.isArray(legs)) {
    let foundStepCoords = false;
    function checkSteps(steps) {
      if (!steps || !Array.isArray(steps)) return;
      for (const step of steps) {
        if (!Array.isArray(step)) continue;
        const sd = step[0];
        if (sd && Array.isArray(sd) && sd[7]) { foundStepCoords = true; return; }
        if (step[1] && Array.isArray(step[1])) checkSteps(step[1]);
        if (foundStepCoords) return;
      }
    }
    checkSteps(legs);
    checks.push(check('step[0][7] — coord structure', foundStepCoords,
      foundStepCoords ? 'ok' : 'sd[7] pattern not found in any step'));
  }

  // findName — should not return coordinates for coordinate-based origin
  function findName(section) {
    if (!Array.isArray(section)) return '';
    if (typeof section[0] === 'string' && !/^-?\d+\.?\d*,-?\d+\.?\d*$/.test(section[0]))
      return section[0].split(',').slice(0, 2).join(', ');
    for (const item of section) { const f = findName(item); if (f) return f; }
    return '';
  }

  if (originMarker) {
    const name = findName(originMarker);
    const looksLikeCoords = /^-?\d+\.?\d*,\s*-?\d+\.?\d*$/.test(name);
    checks.push(check('findName — origin', name && !looksLikeCoords,
      name ? (looksLikeCoords ? 'returned coordinates instead of name: ' + name : 'ok: ' + name) : 'empty'));
  }

  finish(checks);
}

function finish(checks) {
  const failed = checks.filter(c => !c.passed);
  const passed = checks.filter(c => c.passed);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ checks, passed: failed.length === 0 }, null, 2));
  } else {
    console.log('\nRouteMeet API Health Check');
    console.log('='.repeat(40));
    for (const c of checks) {
      console.log((c.passed ? '  PASS' : '  FAIL') + '  ' + c.name + (c.detail !== 'ok' ? '  — ' + c.detail : ''));
    }
    console.log('='.repeat(40));
    console.log(passed.length + ' passed, ' + failed.length + ' failed\n');
  }

  if (failed.length > 0) process.exit(1);
}

main().catch(e => {
  console.error('Health check crashed:', e.message);
  process.exit(1);
});
