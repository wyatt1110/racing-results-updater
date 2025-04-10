// Improved track name matching function
function findCourseId(trackName, trackCodes) {
  if (!trackName) return null;
  
  console.log(`Finding course ID for track: "${trackName}"`);
  
  // Clean the track name
  let cleanTrack = trackName.toLowerCase().trim();
  
  // Store all attempted matches for debugging
  const attempts = [];
  
  // Try direct match first
  if (trackCodes[cleanTrack]) {
    console.log(`Direct match for ${trackName}: ${trackCodes[cleanTrack]}`);
    return trackCodes[cleanTrack];
  }
  attempts.push(`Direct match: "${cleanTrack}" - No match`);
  
  // Try with common words removed
  const commonWords = [
    'racecourse', 'race course', 'races', 'racing', 
    'track', 'downs', 'park', 'course'
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
    .replace(/\\s*\\(aw\\)$/i, '')
    .replace(/\\s*\\(all weather\\)$/i, '')
    .replace(/\\s*\\(uk\\)$/i, '')
    .replace(/\\s*\\(aus\\)$/i, '')
    .replace(/\\s*\\(ire\\)$/i, '')
    .replace(/\\s*\\(usa\\)$/i, '')
    .replace(/\\s*racecourse$/i, '')
    .trim();
  
  if (trackCodes[withoutSuffix]) {
    console.log(`Suffix-removed match for ${trackName}: ${trackCodes[withoutSuffix]}`);
    return trackCodes[withoutSuffix];
  }
  attempts.push(`Without suffix: "${withoutSuffix}" - No match`);
  
  // Try common alternates
  const alternates = {
    'kempton': 'kempton park',
    'kempton (aw)': 'kempton park',
    'catterick': 'catterick bridge',
    'cork': 'corks',
    'curragh': 'the curragh',
    'doncaster': 'donny',
    'ayr': 'ayr racecourse',
    'york': 'york racecourse',
    'ascot': 'ascot racecourse',
    'goodwood': 'goodwood racecourse',
    'newmarket': 'newmarket racecourse',
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
    'wincanton': 'wincanton racecourse'
  };
  
  if (alternates[cleanTrack]) {
    const alt = alternates[cleanTrack];
    if (trackCodes[alt]) {
      console.log(`Alternate name match for ${trackName} -> ${alt}: ${trackCodes[alt]}`);
      return trackCodes[alt];
    }
    attempts.push(`Alternate name: "${cleanTrack}" -> "${alt}" - No match`);
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
  
  // Log all attempts if no match found
  console.error(`No course ID found for track: ${trackName}`);
  console.error(`Attempted matches:\n${attempts.join('\n')}`);
  
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