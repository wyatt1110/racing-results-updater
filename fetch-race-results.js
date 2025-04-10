// Fetch race results from the API
async function fetchRaceResults(trackName, date, courseId, racingApi, fs) {
  console.log(`Fetching results for ${trackName} on ${date} with course ID ${courseId}`);
  
  try {
    // Prepare API params
    const params = { start_date: date };
    
    // Add course ID if we have it
    if (courseId) {
      params.course = courseId;
    } else {
      console.error(`No course ID available for ${trackName}, cannot make API call`);
      return [];
    }
    
    // Log the API request details
    console.log(`API Request: ${racingApi.defaults.baseURL}/results with params:`, params);
    
    // Make the API call
    const response = await racingApi.get('/results', { params });
    
    // Create a safe filename for saving response
    const safeTrackName = trackName.replace(/[^a-zA-Z0-9]/g, '_');
    const responseFile = `${safeTrackName}_${date}_response.json`;
    
    // Save the raw response for debugging
    fs.writeFileSync(responseFile, JSON.stringify(response.data, null, 2));
    console.log(`Saved API response to ${responseFile}`);
    
    // Extract and process the horses
    const horses = extractHorsesFromResponse(response.data, trackName);
    
    if (horses.length > 0) {
      const horsesFile = `${safeTrackName}_${date}_horses.json`;
      fs.writeFileSync(horsesFile, JSON.stringify(horses, null, 2));
      console.log(`Saved extracted horses to ${horsesFile}`);
      
      // Log sample horse data for verification
      console.log(`Sample horse data: ${JSON.stringify(horses[0])}`);
    }
    
    return horses;
  } catch (error) {
    console.error(`Error fetching race results for ${trackName}:`, error.message);
    if (error.response) {
      console.error(`API Status: ${error.response.status}`);
      console.error(`API Error: ${JSON.stringify(error.response.data || {}).substring(0, 200)}...`);
    }
    return [];
  }
}

// Extract horse data from API response
function extractHorsesFromResponse(apiData, targetTrack) {
  const horses = [];
  
  // Handle missing or empty results
  if (!apiData) {
    console.error(`API response is null or undefined for ${targetTrack}`);
    return horses;
  }
  
  if (!apiData.results || !Array.isArray(apiData.results)) {
    console.error(`Invalid API response structure for ${targetTrack}. No results array found.`);
    // Try deep search for race results
    const foundResults = searchForResults(apiData);
    if (foundResults.length > 0) {
      console.log(`Deep search found ${foundResults.length} potential results objects`);
      for (const result of foundResults) {
        const extractedHorses = processRaceResults(result, targetTrack);
        if (extractedHorses.length > 0) {
          console.log(`Found ${extractedHorses.length} horses from deep search`);
          horses.push(...extractedHorses);
        }
      }
    }
    return horses;
  }
  
  // Clean target track name for matching
  const cleanTarget = targetTrack.toLowerCase()
    .replace(/\\s*\\(aw\\)$/i, '')
    .replace(/\\s*racecourse$/i, '')
    .trim();
  
  console.log(`Looking for races at "${cleanTarget}" in API response`);
  
  // Process each race in the results
  return processRaceResults(apiData.results, cleanTarget, targetTrack);
}

// Process race results to extract horse data
function processRaceResults(races, cleanTarget, targetTrack) {
  const horses = [];
  
  if (!Array.isArray(races)) {
    console.error(`Expected array of races but got: ${typeof races}`);
    return horses;
  }
  
  // Process each race in the results
  races.forEach(race => {
    // Safely access the course property
    const raceTrack = ((race && race.course) || '').toLowerCase().trim();
    const raceTrackClean = raceTrack
      .replace(/\\s*\\(aw\\)$/i, '')
      .replace(/\\s*racecourse$/i, '')
      .trim();
    
    // Improved track matching logic
    const isMatch = 
      raceTrackClean.includes(cleanTarget) || 
      cleanTarget.includes(raceTrackClean) ||
      levenshteinDistance(raceTrackClean, cleanTarget) <= 2; // Allow for minor spelling differences
    
    if (isMatch) {
      console.log(`Found matching race at "${race.course}" for "${targetTrack}"`);
      
      // Process runners if available
      if (race.runners && Array.isArray(race.runners)) {
        race.runners.forEach(runner => {
          if (!runner) return; // Skip null runners
          
          // Get values with fallbacks
          const horseName = runner.horse || '';
          const position = runner.position || '';
          const sp = parseFloat(runner.sp_dec) || null;
          const bsp = parseFloat(runner.bsp) || null;
          
          // Correctly handle ovr_btn field - could be ovr_btn or ovr_beaten
          let ovrBtn = null;
          if (runner.ovr_btn !== undefined) {
            ovrBtn = parseNumeric(runner.ovr_btn);
          } else if (runner.ovr_beaten !== undefined) {
            ovrBtn = parseNumeric(runner.ovr_beaten);
          }
          
          // Add each horse to our results
          horses.push({
            horse_name: horseName,
            track_name: race.course || targetTrack,
            race_time: race.off || race.time || '',
            position: position,
            sp: sp,
            bsp: bsp,
            ovr_btn: ovrBtn,
            btn: parseNumeric(runner.btn),
            total_runners: race.runners.length,
            race_id: race.race_id || '',
            race_name: race.race_name || '',
            simplified_name: simplifyName(horseName)
          });
        });
      }
    }
  });
  
  console.log(`Extracted ${horses.length} horses for ${targetTrack}`);
  return horses;
}

// Recursive search for results in the API response
function searchForResults(obj, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];
  if (!obj || typeof obj !== 'object') return [];
  
  let results = [];
  
  // Check if this object itself is a results array
  if (Array.isArray(obj) && obj.length > 0 && obj[0] && typeof obj[0] === 'object') {
    // Look for common racing fields like course, race_id, etc.
    const hasRaceFields = obj.some(item => 
      (item.course || item.race_id || item.race_name || 
       (item.runners && Array.isArray(item.runners)))
    );
    
    if (hasRaceFields) {
      results.push(obj);
    }
  }
  
  // Check for a results property
  if (obj.results && Array.isArray(obj.results)) {
    results.push(obj.results);
  }
  
  // Check for a data property
  if (obj.data && typeof obj.data === 'object') {
    const dataResults = searchForResults(obj.data, depth + 1, maxDepth);
    results = results.concat(dataResults);
  }
  
  // For arrays, search each item
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const itemResults = searchForResults(item, depth + 1, maxDepth);
      results = results.concat(itemResults);
    }
  } else {
    // For objects, search each property
    for (const key in obj) {
      if (obj.hasOwnProperty(key) && obj[key] && typeof obj[key] === 'object') {
        const propResults = searchForResults(obj[key], depth + 1, maxDepth);
        results = results.concat(propResults);
      }
    }
  }
  
  return results;
}

// Levenshtein distance for fuzzy string matching
function levenshteinDistance(a, b) {
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

// Simplify name for easier comparison
function simplifyName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Parse numeric value safely
function parseNumeric(value) {
  if (value === null || value === undefined || value === '') return null;
  
  // If already a number, just return it
  if (typeof value === 'number' && !isNaN(value)) return value;
  
  // Handle string values
  if (typeof value === 'string') {
    // Return null for non-numeric placeholders
    if (['nr', 'ns', 'rr', 'void', '-'].includes(value.toLowerCase())) {
      return null;
    }
    
    // Try to convert to number
    const num = parseFloat(value);
    return isNaN(num) ? null : num;
  }
  
  return null;
}

module.exports = {
  fetchRaceResults,
  extractHorsesFromResponse,
  processRaceResults,
  searchForResults,
  levenshteinDistance,
  simplifyName,
  parseNumeric
};