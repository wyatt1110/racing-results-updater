// Improved API request module for fetching race results
const axios = require('axios');
const fs = require('fs');

// Function to fetch race results from the API with improved error handling
async function fetchRaceResults(trackName, date, courseId, racingApi, sleep) {
  console.log(`Fetching results for ${trackName} on ${date} with course ID ${courseId}`);
  
  try {
    // Prepare API params - simplify to just the essential parameters
    const params = { 
      start_date: date,
      end_date: date // Add end_date to ensure we only get this specific date
    };
    
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
      
      // Try alternate API call without course filter (last resort)
      console.log(`Trying fallback API call without course filter for ${date}...`);
      try {
        const fallbackResponse = await racingApi.get('/results', { 
          params: { 
            start_date: date,
            end_date: date
          }
        });
        
        console.log(`Fallback API call successful, looking for horses at ${trackName}`);
        const fallbackHorses = extractHorsesFromResponse(fallbackResponse.data, trackName);
        
        if (fallbackHorses.length > 0) {
          console.log(`Found ${fallbackHorses.length} horses for ${trackName} in fallback API response`);
          const fallbackFile = `${safeTrackName}_${date}_fallback_horses.json`;
          fs.writeFileSync(fallbackFile, JSON.stringify(fallbackHorses, null, 2));
          return fallbackHorses;
        } else {
          console.log(`No horses found for ${trackName} in fallback API response either`);
        }
      } catch (fallbackError) {
        console.error(`Fallback API call failed:`, fallbackError.message);
      }
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
        
        // Try alternate API call without course filter as a fallback
        console.log(`Trying fallback API call without course filter for ${date}...`);
        try {
          const fallbackResponse = await racingApi.get('/results', { 
            params: { 
              start_date: date,
              end_date: date 
            }
          });
          
          console.log(`Fallback API call successful, looking for horses at ${trackName}`);
          const fallbackHorses = extractHorsesFromResponse(fallbackResponse.data, trackName);
          
          if (fallbackHorses.length > 0) {
            console.log(`Found ${fallbackHorses.length} horses for ${trackName} in fallback API response`);
            return fallbackHorses;
          }
        } catch (fallbackError) {
          console.error(`Fallback API call failed:`, fallbackError.message);
        }
      } else if (error.response.status === 429) {
        console.error(`429 Too Many Requests - Rate limited. Waiting before retrying...`);
        // Wait longer for rate limit errors
        await sleep(30000);
        
        // Retry once with exponential backoff
        try {
          console.log(`Retrying API request for ${trackName}...`);
          const retryResponse = await racingApi.get('/results', { 
            params: { 
              start_date: date, 
              end_date: date,
              course: courseId 
            }
          });
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
    .replace(/\s*\(aw\)$/i, '')
    .replace(/\s*\(all weather\)$/i, '')
    .replace(/\s*\(uk\)$/i, '')
    .replace(/\s*\(gb\)$/i, '')
    .replace(/\s*\(ire\)$/i, '')
    .replace(/\s*racecourse$/i, '')
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
      .replace(/\s*\(aw\)$/i, '')
      .replace(/\s*\(all weather\)$/i, '')
      .replace(/\s*\(uk\)$/i, '')
      .replace(/\s*\(gb\)$/i, '')
      .replace(/\s*\(ire\)$/i, '')
      .replace(/\s*racecourse$/i, '')
      .trim();
    
    // Check if this race is from our target track using more flexible matching
    const isTrackMatch = 
      raceTrackClean.includes(cleanTarget) || 
      cleanTarget.includes(raceTrackClean) ||
      raceTrackClean.startsWith(cleanTarget) ||
      cleanTarget.startsWith(raceTrackClean) ||
      levenshteinDistance(raceTrackClean, cleanTarget) <= Math.min(3, Math.floor(cleanTarget.length * 0.3));
    
    if (isTrackMatch) {
      console.log(`Found matching race at "${race.course}" for "${targetTrack}"`);
      
      // Process runners if available
      if (race.runners && Array.isArray(race.runners)) {
        console.log(`Race has ${race.runners.length} runners`);
        
        race.runners.forEach(runner => {
          // For each horse, create multiple variants of names for better matching later
          const horseName = runner.horse || '';
          const simplifiedName = simplifyName(horseName);
          const nameVariants = generateNameVariants(horseName);
          
          // Capture horse_id from the API response
          const horse_id = runner.horse_id || null;
          
          // Log the horse_id for debugging
          if (horse_id) {
            console.log(`Found horse ID ${horse_id} for ${horseName}`);
          } else {
            console.log(`No horse ID found for ${horseName}`);
          }
          
          // Add each horse to our results with enhanced details
          horses.push({
            horse_name: horseName,
            horse_id: horse_id, // Include the horse_id field
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
            simplified_name: simplifiedName,
            name_variants: nameVariants,
            // Add jockey and trainer for additional validation
            jockey: runner.jockey || '',
            trainer: runner.trainer || '',
            // Add raw runner data for reference
            raw_data: runner
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

// Generate variants of a horse name for better matching
function generateNameVariants(name) {
  if (!name) return [];
  
  const variants = [
    name.toLowerCase(),
    simplifyName(name),
    name.toLowerCase().replace(/[^\w\s]/g, ''), // Remove punctuation
    name.toLowerCase().replace(/\s+/g, ''),     // Remove spaces
    name.toLowerCase().replace(/the/gi, '')     // Remove "the"
  ];
  
  // Remove (FR), (IRE), etc. country codes
  const withoutCountry = name.toLowerCase().replace(/\s*\([a-z]{2,3}\)$/i, '');
  if (withoutCountry !== name.toLowerCase()) {
    variants.push(withoutCountry);
    variants.push(simplifyName(withoutCountry));
  }
  
  // Handle common prefixes
  if (name.toLowerCase().startsWith('the ')) {
    const withoutThe = name.substring(4);
    variants.push(withoutThe.toLowerCase());
    variants.push(simplifyName(withoutThe));
  }
  
  return [...new Set(variants)]; // Remove duplicates
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
  parseNumeric,
  generateNameVariants
};