// Improved track name matching function
function findCourseId(trackName, trackCodes) {
  if (!trackName) return null;
  
  console.log(`Finding course ID for track: "${trackName}"`);
  
  // Clean the track name
  let cleanTrack = trackName.toLowerCase().trim();
  
  // Store all attempted matches for debugging
  const attempts = [];
  
  // Special case for Newmarket
  if (cleanTrack === 'newmarket' || cleanTrack === 'newmarket (uk)' || cleanTrack.includes('newmarket')) {
    // Newmarket has course ID crs_1016
    const newmarketId = 'crs_1016';
    console.log(`Special case match for Newmarket: ${newmarketId}`);
    return newmarketId;
  }
  
  // Try direct match first
  if (trackCodes[cleanTrack]) {
    console.log(`Direct match for ${trackName}: ${trackCodes[cleanTrack]}`);
    return trackCodes[cleanTrack];
  }
  attempts.push(`Direct match: "${cleanTrack}" - No match`);
  
  // Try with parentheses content removed
  const withoutParentheses = cleanTrack.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (trackCodes[withoutParentheses]) {
    console.log(`Parentheses-removed match for ${trackName}: ${trackCodes[withoutParentheses]}`);
    return trackCodes[withoutParentheses];
  }
  attempts.push(`Without parentheses: "${withoutParentheses}" - No match`);
  
  // Try with common words removed
  const commonWords = [
    'racecourse', 'race course', 'races', 'racing', 
    'track', 'downs', 'park', 'course', 'the'
  ];
  
  for (const word of commonWords) {
    const withoutWord = cleanTrack.replace(new RegExp(`\\s*${word}\\s*`, 'i'), ' ').trim();
    if (trackCodes[withoutWord]) {
      console.log(`Common word removed match for ${trackName}: ${trackCodes[withoutWord]}`);
      return trackCodes[withoutWord];
    }
    attempts.push(`Without "${word}": "${withoutWord}" - No match`);
  }
  
  // Try removing common suffixes
  const withoutSuffix = cleanTrack
    .replace(/\s*\(aw\)$/i, '')
    .replace(/\s*\(all weather\)$/i, '')
    .replace(/\s*\(uk\)$/i, '')
    .replace(/\s*\(gb\)$/i, '')
    .replace(/\s*\(aus\)$/i, '')
    .replace(/\s*\(ire\)$/i, '')
    .replace(/\s*\(usa\)$/i, '')
    .replace(/\s*racecourse$/i, '')
    .trim();
  
  if (trackCodes[withoutSuffix]) {
    console.log(`Suffix-removed match for ${trackName}: ${trackCodes[withoutSuffix]}`);
    return trackCodes[withoutSuffix];
  }
  attempts.push(`Without suffix: "${withoutSuffix}" - No match`);
  
  // Extended common alternates
  const alternates = {
    'kempton': 'kempton park',
    'kempton (aw)': 'kempton park',
    'kempton park (aw)': 'kempton park',
    'catterick': 'catterick bridge',
    'catterick bridge': 'catterick',
    'cork': 'corks',
    'curragh': 'the curragh',
    'doncaster': 'donny',
    'ayr': 'ayr racecourse',
    'york': 'york racecourse',
    'ascot': 'ascot racecourse',
    'goodwood': 'goodwood racecourse',
    'newmarket': 'newmarket racecourse',
    'newmarket (rowley)': 'newmarket',
    'newmarket (july)': 'newmarket',
    'exeter': 'exeter racecourse',
    'leopardstown': 'leopardstown racecourse',
    'lingfield': 'lingfield park',
    'lingfield (aw)': 'lingfield park',
    'newbury': 'newbury racecourse',
    'nottingham': 'nottingham racecourse',
    'pontefract': 'pontefract racecourse',
    'southwell': 'southwell racecourse',
    'southwell (aw)': 'southwell racecourse',
    'wolverhampton': 'wolverhampton racecourse',
    'wolverhampton (aw)': 'wolverhampton racecourse',
    'wincanton': 'wincanton racecourse',
    'sandown': 'sandown park',
    'sandown (aw)': 'sandown park',
    'haydock': 'haydock park',
    'chepstow': 'chepstow racecourse',
    'cheltenham': 'cheltenham racecourse',
    'epsom': 'epsom downs',
    'hamilton': 'hamilton park',
    'yarmouth': 'great yarmouth',
    'chelmsford': 'chelmsford city',
    'chelmsford (aw)': 'chelmsford city'
  };
  
  // Try direct alternate lookup
  if (alternates[cleanTrack]) {
    const alt = alternates[cleanTrack];
    if (trackCodes[alt]) {
      console.log(`Alternate name match for ${trackName} -> ${alt}: ${trackCodes[alt]}`);
      return trackCodes[alt];
    }
    attempts.push(`Alternate name: "${cleanTrack}" -> "${alt}" - No match`);
  }
  
  // Try recursive alternates (check if alternate of alternate exists)
  let currentTrack = cleanTrack;
  const visitedAlternates = new Set();
  
  while (alternates[currentTrack] && !visitedAlternates.has(currentTrack)) {
    visitedAlternates.add(currentTrack);
    currentTrack = alternates[currentTrack];
    
    if (trackCodes[currentTrack]) {
      console.log(`Recursive alternate match for ${trackName} -> ${currentTrack}: ${trackCodes[currentTrack]}`);
      return trackCodes[currentTrack];
    }
  }
  
  // Comprehensive track name mapping with course IDs
  const knownTracks = {
    'newmarket': 'crs_1016', 
    'kempton': 'crs_28054',
    'kempton (aw)': 'crs_28054',
    'lingfield': 'crs_910',
    'lingfield (aw)': 'crs_910',
    'ascot': 'crs_26',
    'catterick': 'crs_260',
    'nottingham': 'crs_1040',
    'chelmsford': 'crs_286',
    'chelmsford city': 'crs_286',
    'doncaster': 'crs_390',
    'epsom': 'crs_572',
    'epsom downs': 'crs_572',
    'goodwood': 'crs_702',
    'haydock': 'crs_776',
    'haydock park': 'crs_776',
    'newbury': 'crs_988',
    'sandown': 'crs_1222',
    'sandown park': 'crs_1222',
    'wolverhampton': 'crs_1638',
    'wolverhampton (aw)': 'crs_1638',
    'york': 'crs_1690',
    'leopardstown': 'crs_4862',
    'dundalk': 'crs_4368',
    'dundalk (aw)': 'crs_4368',
    'fairyhouse': 'crs_4374'
  };
  
  // Check against the hardcoded list
  if (knownTracks[cleanTrack]) {
    console.log(`Hardcoded track match for ${trackName}: ${knownTracks[cleanTrack]}`);
    return knownTracks[cleanTrack];
  }
  
  if (knownTracks[withoutParentheses]) {
    console.log(`Hardcoded track match for ${withoutParentheses}: ${knownTracks[withoutParentheses]}`);
    return knownTracks[withoutParentheses];
  }
  
  if (knownTracks[withoutSuffix]) {
    console.log(`Hardcoded track match for ${withoutSuffix}: ${knownTracks[withoutSuffix]}`);
    return knownTracks[withoutSuffix];
  }
  
  // Try substrings (track contained in mapping keys or vice versa)
  for (const [track, id] of Object.entries(trackCodes)) {
    // Skip short track names to avoid false positives
    if (track.length < 4) continue;
    
    if (track.includes(cleanTrack) || cleanTrack.includes(track)) {
      console.log(`Substring match: "${trackName}" <-> "${track}" = ${id}`);
      return id;
    }
  }
  attempts.push(`Substring matches - No match found`);
  
  // Try Levenshtein distance for fuzzy matching
  const threshold = Math.min(3, Math.floor(cleanTrack.length * 0.3)); // Max 30% different
  let bestMatch = null;
  let bestDistance = Infinity;
  
  for (const [track, id] of Object.entries(trackCodes)) {
    // Skip very short track names
    if (track.length < 4) continue;
    
    const distance = levenshtein(cleanTrack, track);
    if (distance < threshold && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = { track, id };
    }
  }
  
  if (bestMatch) {
    console.log(`Fuzzy match: "${trackName}" -> "${bestMatch.track}" (distance: ${bestDistance}) = ${bestMatch.id}`);
    return bestMatch.id;
  }
  attempts.push(`Fuzzy matching (threshold: ${threshold}) - No match found`);
  
  // Check for just the start of the track name
  for (const [track, id] of Object.entries(trackCodes)) {
    if (track.startsWith(cleanTrack) || cleanTrack.startsWith(track)) {
      console.log(`Prefix match: "${trackName}" <-> "${track}" = ${id}`);
      return id;
    }
  }
  attempts.push(`Prefix matches - No match found`);
  
  // Check for UK regional tracks
  if (cleanTrack.includes("(uk)") || trackName.includes("UK")) {
    // This is a UK track, try substring matching with UK tracks only
    for (const [track, id] of Object.entries(trackCodes)) {
      if (track.length < 4) continue;
      
      // If we have region info and it's GB/UK
      if (id.startsWith("crs_") && parseInt(id.replace("crs_", "")) < 2000) {
        // UK tracks typically have IDs under 2000
        if (track.includes(withoutSuffix) || withoutSuffix.includes(track)) {
          console.log(`UK regional match: "${withoutSuffix}" <-> "${track}" = ${id}`);
          return id;
        }
      }
    }
  }
  
  // Log all attempts if no match found
  console.error(`No course ID found for track: ${trackName}`);
  console.error(`Attempted matches:\n${attempts.join('\n')}`);
  
  // Last resort - if it contains "newmarket" return that ID
  if (cleanTrack.includes("newmarket")) {
    console.log(`Last resort Newmarket match for: ${trackName}`);
    return 'crs_1016'; // Newmarket
  }
  
  return null;
}

// Levenshtein distance for fuzzy matching
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j-1] === b[i-1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i-1][j] + 1,      // deletion
        matrix[i][j-1] + 1,      // insertion
        matrix[i-1][j-1] + cost  // substitution
      );
    }
  }
  
  return matrix[b.length][a.length];
}

module.exports = { findCourseId };