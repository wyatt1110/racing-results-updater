// Improved API request module for fetching race results
const axios = require('axios');
const fs = require('fs');

// Function to fetch race results from the API with improved error handling
async function fetchRaceResults(trackName, date, courseId, racingApi, sleep) {
  console.log(`Fetching results for ${trackName} on ${date} with course ID ${courseId}`);
  
  try {
    // Prepare API params - simplify to just the essential parameters
    // The API documentation indicates start_date and course are the critical parameters
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
    
    // Log success
    console.log(`API Request successful for ${trackName}`);
    
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
    } else {
      console.log(`No horses found for ${trackName} in API response`);
    }
    
    return horses;
  } catch (error) {
    console.error(`Error fetching race results for ${trackName}:`);
    
    if (error.response) {
      // The API responded with an error status
      console.error(`API Status: ${error.response.status}`);
      console.error(`API Error: ${JSON.stringify(error.response.data).substring(0, 200)}...`);
      
      // Check for specific error codes
      if (error.response.status === 404) {
        console.error(`404 Not Found - The API couldn't find results for ${trackName} on ${date}`);
        console.error(`This could mean there are no races at this track on this date`);
      } else if (error.response.status === 429) {
        console.error(`429 Too Many Requests - Rate limited. Waiting before retrying...`);
        // Wait longer for rate limit errors
        await sleep(15000);
        
        // Retry once with exponential backoff
        try {
          console.log(`Retrying API request for ${trackName}...`);
          const retryResponse = await racingApi.get('/results', { params: { start_date: date, course: courseId } });
          console.log(`Retry successful for ${trackName}`);
          return extractHorsesFromResponse(retryResponse.data, trackName);
        } catch (retryError) {
          console.error(`Retry failed for ${trackName}:`, retryError.message);
        }
      }
    } else if (error.request) {
      // The request was made but no response was received
      console.error(`No response received from API for ${trackName}`);
    } else {
      // Something else caused the error
      console.error(`Error message: ${error.message}`);
    }
    
    return [];
  }
}

// Extract horse data from API response with improved extraction logic
function extractHorsesFromResponse(apiData, targetTrack) {
  const horses = [];
  
  // Handle missing or empty results
  if (!apiData || !apiData.results || !Array.isArray(apiData.results)) {
    console.error(`Invalid API response structure for ${targetTrack}`);
    return horses;
  }
  
  // Clean target track name for matching
  const cleanTarget = targetTrack.toLowerCase()
    .replace(/\\s*\\(aw\\)$/i, '')
    .replace(/\\s*racecourse$/i, '')
    .trim();
  
  console.log(`Looking for races at "${cleanTarget}" in API response`);
  console.log(`Found ${apiData.results.length} races in API response`);
  
  // Process each race in the results
  apiData.results.forEach((race, index) => {
    // Log each race summary for debugging
    console.log(`Race ${index + 1}: ${race.course || 'Unknown'} - ${race.race_name || 'Unnamed race'}`);
    
    // Get the track from the race
    const raceTrack = (race.course || '').toLowerCase().trim();
    const raceTrackClean = raceTrack
      .replace(/\\s*\\(aw\\)$/i, '')
      .replace(/\\s*racecourse$/i, '')
      .trim();
    
    // Check if this race is from our target track using more flexible matching
    const isTrackMatch = 
      raceTrackClean.includes(cleanTarget) || 
      cleanTarget.includes(raceTrackClean) ||
      levenshteinDistance(raceTrackClean, cleanTarget) <= 2; // Allow small typos
    
    if (isTrackMatch) {
      console.log(`Found matching race at "${race.course}" for "${targetTrack}"`);
      
      // Process runners if available
      if (race.runners && Array.isArray(race.runners)) {
        console.log(`Race has ${race.runners.length} runners`);
        
        race.runners.forEach(runner => {
          // Add each horse to our results with enhanced details
          horses.push({
            horse_name: runner.horse || '',
            track_name: race.course || targetTrack,
            race_time: race.off || race.time || '',
            position: runner.position || '',
            sp: parseFloat(runner.sp_dec) || null,
            bsp: parseFloat(runner.bsp) || null,
            // Use ovr_btn first, fall back to ovr_beaten if present
            ovr_btn: parseNumeric(runner.ovr_btn !== undefined ? runner.ovr_btn : runner.ovr_beaten),
            btn: parseNumeric(runner.btn),
            total_runners: race.runners.length,
            race_id: race.race_id || '',
            race_name: race.race_name || '',
            simplified_name: simplifyName(runner.horse || ''),
            // Add jockey and trainer for additional validation
            jockey: runner.jockey || '',
            trainer: runner.trainer || ''
          });
        });
      } else {
        console.log(`Race has no runners data`);
      }
    }
  });
  
  console.log(`Extracted ${horses.length} horses for ${targetTrack}`);
  return horses;
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

// Levenshtein distance function for fuzzy track name matching
function levenshteinDistance(a, b) {
  const matrix = [];
  
  // Increment along the first column of each row
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  
  // Increment each column in the first row
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  // Fill in the rest of the matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i-1) === a.charAt(j-1)) {
        matrix[i][j] = matrix[i-1][j-1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i-1][j-1] + 1, // substitution
          Math.min(
            matrix[i][j-1] + 1, // insertion
            matrix[i-1][j] + 1  // deletion
          )
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

module.exports = {
  fetchRaceResults,
  extractHorsesFromResponse,
  simplifyName,
  parseNumeric
};