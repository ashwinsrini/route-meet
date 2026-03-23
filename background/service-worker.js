// Service worker: Hierarchical meetup chain algorithm
// Finds optimal pairwise merge order for N people heading to same destination

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'findRendezvous') {
    handleFindRendezvous(message.data).then(sendResponse).catch(err => {
      sendResponse({ error: err.message, parsingStep: err.parsingStep || null });
    });
    return true;
  }
});

// --- Structured validation helper ---
function assertPath(obj, keys, label) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') {
      const err = new Error('API structure changed: ' + label);
      err.parsingStep = label;
      throw err;
    }
    cur = cur[k];
  }
  return cur;
}

// --- Google Maps Internal API ---
async function googleDirections(origin, destination, mode = 0, _retries = 2) {
  const originStr = typeof origin === 'string'
    ? origin
    : origin.lat.toFixed(6) + ',' + origin.lng.toFixed(6);

  const pb =
    '!1m1!1s' + encodeURIComponent(originStr) +
    '!1m1!1s' + encodeURIComponent(destination) +
    '!3m12!1m3!1d17470.369063309543!2d77.6!3d13.0!2m3!1f0!2f0!3f0!3m2!1i1200!2i863!4f13.1' +
    '!6m27!1m5!18b1!30b1!31m1!1b1!34e1!2m4!5m1!6e2!20e3!39b1!10b1!12b1!13b1!14b1!16b1!17m1!3e0' +
    '!20m6!1e' + mode + '!2e3!5e2!6b1!8b1!14b1!46m1!1b0!96b1!99b1';

  const res = await fetch('https://www.google.com/maps/preview/directions?authuser=0&hl=en&gl=in&pb=' + pb);
  const text = await res.text();
  if (!text.startsWith(')]}')) {
    if (_retries > 0) {
      await new Promise(r => setTimeout(r, 500));
      return googleDirections(origin, destination, mode, _retries - 1);
    }
    throw new Error('Directions failed for: ' + originStr);
  }
  let json;
  try {
    json = JSON.parse(text.substring(4));
    assertPath(json, [0], 'response root');
    assertPath(json, [0, 0], 'origin/dest markers');
    assertPath(json, [0, 1], 'routes section');
  } catch (e) {
    if (_retries > 0) {
      await new Promise(r => setTimeout(r, 500));
      return googleDirections(origin, destination, mode, _retries - 1);
    }
    if (e.parsingStep) throw e;
    throw new Error('Could not parse directions for: ' + originStr);
  }

  function findLatLng(section) {
    if (!Array.isArray(section)) return null;
    if (section.length === 4 && section[0] === null && section[1] === null &&
        typeof section[2] === 'number' && typeof section[3] === 'number')
      return { lat: section[2], lng: section[3] };
    for (const item of section) { const f = findLatLng(item); if (f) return f; }
    return null;
  }

  function findName(section) {
    if (!Array.isArray(section)) return '';
    // Skip coordinate strings like "13.044998,80.239627" — the real name is deeper
    if (typeof section[0] === 'string' && !/^-?\d+\.?\d*,-?\d+\.?\d*$/.test(section[0]))
      return section[0].split(',').slice(0, 2).join(', ');
    for (const item of section) { const f = findName(item); if (f) return f; }
    return '';
  }

  const coordinates = [];
  function extractCoords(steps) {
    if (!steps || !Array.isArray(steps)) return;
    for (const step of steps) {
      if (!Array.isArray(step)) continue;
      const sd = step[0];
      if (sd && Array.isArray(sd) && sd[7]) {
        const f7 = sd[7];
        if (f7[2] && Array.isArray(f7[2]) && f7[2].length >= 4 &&
            typeof f7[2][2] === 'number' && typeof f7[2][3] === 'number') {
          coordinates.push({ lat: f7[2][2], lng: f7[2][3] });
        } else if (f7[0] && Array.isArray(f7[0]) && f7[0].length >= 3 &&
                   typeof f7[0][1] === 'number' && typeof f7[0][2] === 'number' && f7[0][0] !== 0) {
          coordinates.push({ lat: f7[0][2], lng: f7[0][1] });
        }
      }
      if (step[1] && Array.isArray(step[1])) extractCoords(step[1]);
    }
  }

  assertPath(json, [0, 1, 0], 'first route');
  const legs = json[0][1][0][1];
  if (legs) extractCoords(legs);

  assertPath(json, [0, 0, 0], 'origin marker');
  assertPath(json, [0, 0, 1], 'destination marker');
  const originCoord = findLatLng(json[0][0][0]);
  const destCoord = findLatLng(json[0][0][1]);
  const originName = findName(json[0][0][0]);
  const destName = findName(json[0][0][1]);

  if (!originCoord || !destCoord) throw new Error('Could not resolve: ' + originStr);

  if (coordinates.length === 0 || haversineDistance(coordinates[0].lat, coordinates[0].lng, originCoord.lat, originCoord.lng) > 100) {
    coordinates.unshift(originCoord);
  }
  if (coordinates.length < 2 || haversineDistance(coordinates[coordinates.length - 1].lat, coordinates[coordinates.length - 1].lng, destCoord.lat, destCoord.lng) > 100) {
    coordinates.push(destCoord);
  }

  const route = assertPath(json, [0, 1, 0, 0], 'route metadata');
  if (!route[3]) console.warn('RouteMeet: route duration missing — API may have changed');
  return {
    originName,
    destName,
    routeName: route[1] || '',
    distanceText: route[2] ? route[2][1] : '',
    durationText: route[3] ? route[3][1] : '',
    durationSeconds: route[3] ? route[3][0] : 0,
    coordinates
  };
}

// --- Haversine ---
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Pairwise Convergence (2 routes) ---
function findPairConvergence(routeA, routeB) {
  const threshold = 500;

  // Use the route with more coords as reference
  const ref = routeA.coordinates.length >= routeB.coordinates.length ? routeA : routeB;
  const other = ref === routeA ? routeB : routeA;
  const refPath = ref.coordinates;
  const otherPath = other.coordinates;

  let mergeIdx = refPath.length - 1;

  for (let i = refPath.length - 1; i >= 0; i--) {
    let minDist = Infinity;
    for (let j = 0; j < otherPath.length; j++) {
      const d = haversineDistance(refPath[i].lat, refPath[i].lng, otherPath[j].lat, otherPath[j].lng);
      if (d < minDist) minDist = d;
    }
    if (minDist > threshold) {
      mergeIdx = Math.min(i + 1, refPath.length - 1);
      break;
    }
    mergeIdx = i;
  }

  const mergePoint = refPath[mergeIdx];
  const fractionRef = mergeIdx / Math.max(refPath.length - 1, 1);

  // Find fraction on the other route
  let closestIdx = 0, minD = Infinity;
  for (let j = 0; j < otherPath.length; j++) {
    const d = haversineDistance(mergePoint.lat, mergePoint.lng, otherPath[j].lat, otherPath[j].lng);
    if (d < minD) { minD = d; closestIdx = j; }
  }
  const fractionOther = closestIdx / Math.max(otherPath.length - 1, 1);

  const fracA = ref === routeA ? fractionRef : fractionOther;
  const fracB = ref === routeA ? fractionOther : fractionRef;

  return {
    point: mergePoint,
    fractionA: fracA,
    fractionB: fracB,
    avgFraction: (fracA + fracB) / 2
  };
}

function formatDuration(seconds) {
  if (seconds < 60) return seconds + ' sec';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return mins + ' min';
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? hrs + ' hr ' + rem + ' min' : hrs + ' hr';
}

// --- Hierarchical Merge ---
async function handleFindRendezvous(data) {
  const { people, destination } = data;

  if (!people || people.length < 2 || !destination) {
    throw new Error('Need at least 2 people and a destination');
  }

  // Step 1: Fetch all routes in parallel (people can be strings or {query, mode} objects)
  // If primary query (coordinates) fails, retry with fallback (name + address)
  const googleResults = await Promise.all(
    people.map(async person => {
      const query = typeof person === 'string' ? person : person.query;
      const mode = typeof person === 'string' ? 0 : (person.mode || 0);
      const fallback = typeof person === 'string' ? null : (person.fallbackQuery || null);
      try {
        return await googleDirections(query, destination, mode);
      } catch (e) {
        if (fallback && fallback !== query) {
          return await googleDirections(fallback, destination, mode);
        }
        throw e;
      }
    })
  );

  for (let i = 0; i < googleResults.length; i++) {
    if (googleResults[i].coordinates.length < 2) {
      throw new Error('Not enough route data for Person ' + (i + 1));
    }
  }

  // Per-person route info (returned as-is)
  const routes = googleResults.map((gr, i) => ({
    name: gr.routeName,
    totalTime: gr.durationText,
    totalDistance: gr.distanceText,
    durationSeconds: gr.durationSeconds
  }));

  // Step 2: If only 2 people, simple convergence
  if (people.length === 2) {
    const conv = findPairConvergence(googleResults[0], googleResults[1]);
    const timeA = Math.round(conv.fractionA * googleResults[0].durationSeconds);
    const timeB = Math.round(conv.fractionB * googleResults[1].durationSeconds);
    const remaining = Math.round((1 - conv.fractionA) * googleResults[0].durationSeconds);

    // Fetch landmark name for the meetup point
    let landmark = '';
    try {
      const meetupRoute = await googleDirections(conv.point, destination);
      landmark = meetupRoute.originName || '';
    } catch (e) { /* ignore — landmark is optional */ }

    return {
      success: true,
      meetups: [{
        step: 1,
        point: conv.point,
        landmark,
        who: [0, 1],
        groupA: [0],
        groupB: [1],
        avgFraction: conv.avgFraction,
        arrivals: [
          { personIdx: 0, time: formatDuration(timeA), seconds: timeA, fromOrigin: true },
          { personIdx: 1, time: formatDuration(timeB), seconds: timeB, fromOrigin: true }
        ]
      }],
      remainingTime: formatDuration(remaining),
      remainingSeconds: remaining,
      routes
    };
  }

  // Step 3: Hierarchical merge for 3+ people
  // Each "active" entry tracks: { members: [person indices], route: googleResult }
  let active = googleResults.map((gr, i) => ({
    members: [i],
    route: gr
  }));

  const meetups = [];

  while (active.length > 1) {
    // Find the pair that converges earliest (smallest avgFraction)
    let bestI = 0, bestJ = 1;
    let bestConv = null;
    let bestAvgFrac = Infinity;

    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const conv = findPairConvergence(active[i].route, active[j].route);
        if (conv.avgFraction < bestAvgFrac) {
          bestAvgFrac = conv.avgFraction;
          bestConv = conv;
          bestI = i;
          bestJ = j;
        }
      }
    }

    // Record this meetup
    const groupA = active[bestI];
    const groupB = active[bestJ];
    const allMembers = [...groupA.members, ...groupB.members].sort((a, b) => a - b);

    const timeFromGroupA = Math.round(bestConv.fractionA * groupA.route.durationSeconds);
    const timeFromGroupB = Math.round(bestConv.fractionB * groupB.route.durationSeconds);

    // Arrivals: for groups with multiple members (already merged),
    // show the group travel time from the previous meetup
    const arrivals = [];
    const groupTravels = []; // "together" legs from previous meetups

    const currentStep = meetups.length + 1;

    if (groupA.members.length === 1) {
      arrivals.push({ personIdx: groupA.members[0], time: formatDuration(timeFromGroupA), seconds: timeFromGroupA, fromOrigin: true });
    } else {
      groupTravels.push({
        members: groupA.members,
        time: formatDuration(timeFromGroupA),
        seconds: timeFromGroupA,
        toStep: currentStep
      });
    }

    if (groupB.members.length === 1) {
      arrivals.push({ personIdx: groupB.members[0], time: formatDuration(timeFromGroupB), seconds: timeFromGroupB, fromOrigin: true });
    } else {
      groupTravels.push({
        members: groupB.members,
        time: formatDuration(timeFromGroupB),
        seconds: timeFromGroupB,
        toStep: currentStep
      });
    }

    // Fetch the merged group's route from meetup point → destination
    // The originName from this response gives us the nearest landmark
    let mergedRoute;
    let landmark = '';
    try {
      mergedRoute = await googleDirections(bestConv.point, destination);
      landmark = mergedRoute.originName || '';
    } catch (e) {
      const longerRoute = groupA.route.coordinates.length >= groupB.route.coordinates.length
        ? groupA.route : groupB.route;
      mergedRoute = {
        coordinates: longerRoute.coordinates,
        durationSeconds: Math.round((1 - bestAvgFrac) * longerRoute.durationSeconds),
        routeName: longerRoute.routeName,
        distanceText: '',
        durationText: formatDuration(Math.round((1 - bestAvgFrac) * longerRoute.durationSeconds))
      };
    }

    meetups.push({
      step: currentStep,
      point: bestConv.point,
      landmark,
      who: allMembers,
      avgFraction: bestAvgFrac,
      arrivals,
      groupTravels,
      groupA: groupA.members,
      groupB: groupB.members
    });

    // Remove the two merged groups, add the new merged group
    // Remove bestJ first (higher index) to avoid index shift
    active.splice(bestJ, 1);
    active.splice(bestI, 1);
    active.push({
      members: allMembers,
      route: mergedRoute
    });
  }

  // Remaining time: from last meetup to destination
  const lastMergedRoute = active[0].route;
  const remainingTime = lastMergedRoute.durationSeconds;

  return {
    success: true,
    meetups,
    remainingTime: formatDuration(remainingTime),
    remainingSeconds: remainingTime,
    routes
  };
}
