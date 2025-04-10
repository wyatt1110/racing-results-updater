require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const supabaseUrl = process.env.SUPABASE_URL || 'https://gwvnmzfpnuwxcqtewbtl.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3dm5temZwbnV3eGNxdGV3YnRsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcwOTc1NDY3MCwiZXhwIjoyMDI1MzMwNjcwfQ.uZCQGcFm1mGSrKAcqbfgVx-YsNWlb-4iKLwRH5GQaRY';
const racingApiUsername = process.env.RACING_API_USERNAME || 'KQ9W7rQeAHWMUgxH93ie3yEc';
const racingApiPassword = process.env.RACING_API_PASSWORD || 'T5BoPivL3Q2h6RhCdLv4EwZu';
const racingApiBase = 'https://api.theracingapi.com/v1';

// Initialize clients
const supabase = createClient(supabaseUrl, supabaseKey);
const racingApi = axios.create({
  baseURL: racingApiBase,
  auth: {
    username: racingApiUsername,
    password: racingApiPassword
  }
});

// Sleep function for delay between API calls
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Load Track Codes from JSON File ---
let TRACK_CODES = {};
try {
  const trackCodesPath = path.resolve(__dirname, 'Track-codes-list.json');
  if (fs.existsSync(trackCodesPath)) {
    const rawData = fs.readFileSync(trackCodesPath);
    const loadedCodes = JSON.parse(rawData);
    // Convert keys to lowercase for consistent matching
    for (const key in loadedCodes) {
      TRACK_CODES[key.toLowerCase()] = loadedCodes[key];
    }
    console.log(`Successfully loaded ${Object.keys(TRACK_CODES).length} track codes from Track-codes-list.json`);
  } else {
    console.error('Error: Track-codes-list.json not found at path:', trackCodesPath);
    console.error('Proceeding without dynamic track codes. API calls for unknown tracks may fail.');
  }
} catch (err) {
  console.error('Error loading or parsing Track-codes-list.json:', err);
  console.error('Proceeding without dynamic track codes. API calls for unknown tracks may fail.');
}
// --- End Load Track Codes ---

// Track cache to avoid repeated API calls for the same track
const trackHorsesCache = {};

// Main function to update bet results
async function updateBetResults() {
  console.log('Starting bet results update process...');
  
  try {
    // Fetch pending bets
    let { data: pendingBets, error: betsError } = await supabase
      .from('racing_bets')
      .select('*')
      .or('status.ilike.%pending%,status.ilike.%open%,status.eq.new,status.eq.,status.eq.PENDING,status.eq.Pending');
    
    if (betsError) {
      throw new Error(`Error fetching pending bets: ${betsError.message}`);
    }
    
    console.log(`Found ${pendingBets?.length || 0} pending bets to process`);
    
    if (!pendingBets || pendingBets.length === 0) {
      console.log('No pending bets found to update.');
      return { success: true, updated: 0, total: 0 };
    }
    
    // Sample pending bet for debugging (only log one)
    console.log(`Sample pending bet: ${JSON.stringify(pendingBets[0], null, 2)}`);
    
    // Gather all unique track+date combinations needed
    const trackDateNeeded = new Map();
    
    pendingBets.forEach(bet => {
      if (!bet.track_name || !bet.race_date) return;
      
      const date = bet.race_date.split('T')[0];
      
      // For multiple bets with multiple tracks
      if (bet.track_name.includes('/')) {
        const trackNames = bet.track_name.split('/').map(t => t.trim());
        trackNames.forEach(track => {
          const key = `${track}:${date}`;
          if (!trackDateNeeded.has(key)) {
            trackDateNeeded.set(key, { track, date });
          }
        });
      } else {
        // For single track bets
        const track = bet.track_name.trim();
        const key = `${track}:${date}`;
        if (!trackDateNeeded.has(key)) {
          trackDateNeeded.set(key, { track, date });
        }
      }
    });
    
    // Print unique tracks we need to process
    const uniqueTracks = [...new Set([...trackDateNeeded.values()].map(item => item.track))];
    console.log(`Found ${uniqueTracks.length} unique tracks to process: ${uniqueTracks.join(', ')}`);
    
    // Results storage
    const results = {
      total: pendingBets.length,
      updated: 0,
      noMatch: 0,
      errors: 0
    };
    
    // First pass: Fetch all horse data needed for all tracks
    for (const [key, { track, date }] of trackDateNeeded.entries()) {
      console.log(`\nFetching data for track: ${track}, date: ${date}`);
      
      try {
        // Find course ID for this track using the loaded JSON data
        const courseId = findCourseId(track);
        if (courseId) {
          console.log(`Found course ID for ${track}: ${courseId}`);
        } else {
          console.log(`No course ID found for ${track} in Track-codes-list.json`);
        }
        
        // Fetch results for this track and date if not already cached
        if (!trackHorsesCache[key]) {
          console.log(`Fetching results for ${date}, course ID: ${courseId || 'N/A'}`);
          trackHorsesCache[key] = await fetchResultsByDateAndCourse(track, date, courseId);
          console.log(`Found ${trackHorsesCache[key].length} horses for ${track} on ${date}`);
        } else {
          console.log(`Using cached data for ${track} on ${date} (${trackHorsesCache[key].length} horses)`);
        }
        
        // Wait between API calls to avoid rate limiting
        await sleep(2000);
      } catch (error) {
        console.error(`Error fetching data for ${track} on ${date}:`, error.message);
      }
    }
    
    // Second pass: Process all bets now that we have the horse data
    for (const bet of pendingBets) {
      if (!bet.track_name || !bet.race_date || !bet.horse_name) {
        console.log(`Skipping bet ID ${bet.id} - missing required fields`);
        results.noMatch++;
        continue;
      }
      
      try {
        const isMultiple = bet.horse_name.includes('/');
        let success = false;
        
        if (isMultiple) {
          success = await processMultipleBet(bet);
        } else {
          // Get the track horses from cache
          const date = bet.race_date.split('T')[0];
          const track = bet.track_name.trim();
          const cacheKey = `${track}:${date}`;
          const horses = trackHorsesCache[cacheKey] || [];
          
          if (horses.length === 0) {
            console.log(`No horses found for ${track} on ${date} for bet ${bet.id}`);
            results.noMatch++;
            continue;
          }
          
          success = await processSingleBet(bet, horses);
        }
        
        if (success) {
          results.updated++;
        } else {
          results.noMatch++;
        }
      } catch (err) {
        console.error(`Error processing bet ID ${bet.id}:`, err.message);
        results.errors++;
      }
    }
    
    // Print results summary
    console.log('\nResults Summary:');
    console.log(`- Total bets processed: ${results.total}`);
    console.log(`- Matches found and updated: ${results.updated}`);
    console.log(`- No matches found: ${results.noMatch}`);
    console.log(`- Errors encountered: ${results.errors}`);
    
    return {
      success: true,
      updated: results.updated,
      total: results.total,
      noMatches: results.noMatch,
      errors: results.errors
    };
    
  } catch (error) {
    console.error('Error in updateBetResults:', error);
    return { success: false, error: error.message };
  }
}

// Find course ID based on track name (using loaded TRACK_CODES)
function findCourseId(trackName) {
  if (!trackName || Object.keys(TRACK_CODES).length === 0) return null;
  
  const cleanTrack = trackName.toLowerCase().trim();
  
  // Direct match
  if (TRACK_CODES[cleanTrack]) {
    return TRACK_CODES[cleanTrack];
  }
  
  // Handle track with (AW) and similar suffixes
  const baseName = cleanTrack.split('(')[0].trim();
  if (TRACK_CODES[baseName]) {
    return TRACK_CODES[baseName];
  }
  
  // Try partial match as last resort (less reliable)
  for (const [key, id] of Object.entries(TRACK_CODES)) {
    if (key.includes(cleanTrack) || cleanTrack.includes(key)) {
      console.log(`Partial match found for ${trackName} -> ${key}`);
      return id;
    }
  }
  
  return null;
}

// Fetch results for a specific date and course
async function fetchResultsByDateAndCourse(trackName, date, courseId) {
  console.log(`Fetching results for date: ${date}, track: ${trackName}`);
  
  try {
    // Create filename-safe version of track name
    const safeTrackName = trackName.replace(/[^a-zA-Z0-9_]/g, '_'); // Allow only alphanumeric and underscore
    
    // Basic params - date is required
    const params = {
      start_date: date,
    };
    
    // Only add course ID if available
    if (courseId) {
      params.course = courseId; // Single string, not an array
    } else {
      // If no course ID found, DO NOT make the API call as it might return wrong data
      console.warn(`Cannot fetch results for ${trackName} - Course ID not found in Track-codes-list.json`);
      return [];
      // Removed region guessing as it's unreliable without course ID
    }
    
    console.log(`API Request: /results with params:`, params);
    
    // Call the API
    const response = await racingApi.get('/results', { params });
    
    // Save raw response for debugging
    const outputFile = `${safeTrackName}_${date}_response.json`;
    fs.writeFileSync(outputFile, JSON.stringify(response.data, null, 2));
    console.log(`Saved results to ${outputFile}`);
    
    // Extract horses for our track
    return extractHorsesFromResponse(response.data, trackName);
    
  } catch (error) {
    console.error(`Error fetching results for ${trackName} on ${date}:`, error.message);
    if (error.response) {
      console.error(`API status: ${error.response.status}`);
      if (error.response.data) {
        console.error(`API error message: ${JSON.stringify(error.response.data).substring(0, 200)}...`);
      }
    }
    return [];
  }
}

// Extract horses from API response
function extractHorsesFromResponse(apiData, targetTrack) {
  console.log(`Extracting horses for track: ${targetTrack}`);
  const horses = [];
  const cleanTargetTrack = cleanName(targetTrack);
  
  if (!apiData || !apiData.results || !Array.isArray(apiData.results)) {
    console.log('No results array found in API response');
    return horses;
  }
  
  // Process each race in the results
  apiData.results.forEach(race => {
    // Check if this race is from our target track
    const apiTrackName = race.course || race.course_id || '';
    const cleanApiTrack = cleanName(apiTrackName);
    
    if (isSimilarTrack(cleanApiTrack, cleanTargetTrack)) {
      console.log(`Found matching track: API="${apiTrackName}" / Target="${targetTrack}"`);
      
      // Process each runner in the race
      if (race.runners && Array.isArray(race.runners)) {
        race.runners.forEach(runner => {
          horses.push({
            horse_name: runner.horse || runner.name,
            track_name: apiTrackName, // Use the name from the API response
            position: runner.position || runner.finish_position,
            sp: runner.sp_dec || runner.sp || null,
            bsp: runner.bsp || null,
            ovr_btn: runner.ovr_btn || runner.btn || null, // Default to null if missing
            btn: runner.btn || null,
            race_time: race.time || race.off || race.off_dt || '',
            race_id: race.race_id || '',
            race_name: race.race_name || '',
            total_runners: race.runners.length,
            simplified_name: simplifyHorseName(runner.horse || runner.name || '')
          });
        });
      }
    } else {
      // Log when a track doesn't match for debugging
      // console.log(`Track mismatch: API="${apiTrackName}" vs Target="${targetTrack}"`);
    }
  });
  
  console.log(`Extracted ${horses.length} horses for ${targetTrack}`);
  
  // Save extracted horses if we found any
  if (horses.length > 0) {
     const safeTrackName = targetTrack.replace(/[^a-zA-Z0-9_]/g, '_');
    fs.writeFileSync(
      `${safeTrackName}_horses.json`,
      JSON.stringify(horses, null, 2)
    );
  }
  
  return horses;
}

// Process a single bet
async function processSingleBet(bet, horses) {
  console.log(`Processing single bet: ${bet.id} - ${bet.horse_name}`);
  
  if (!bet.horse_name) {
    console.log(`Skipping bet ID ${bet.id} - missing horse name`);
    return false;
  }
  
  // Find horse in results
  const horseResult = findHorseMatch(bet.horse_name, horses);
  
  if (!horseResult) {
    console.log(`No match found for single bet horse: ${bet.horse_name}`);
    return false;
  }
  
  console.log(`MATCH (Single): ${bet.horse_name} → ${horseResult.horse_name} (Position: ${horseResult.position})`);
  
  // Calculate returns
  const numRunners = parseInt(horseResult.total_runners) || 0;
  const betType = bet.each_way === true ? 'each-way' : (bet.bet_type || 'win');
  const betResult = determineBetResult(horseResult, betType, numRunners);
  
  // Calculate bet returns
  const returns = calculateReturns(bet, betResult, horseResult, numRunners);
  
  // Map betResult to status
  let status = 'Pending';
  if (betResult === 'win' || betResult === 'win-place') status = 'Won';
  else if (betResult === 'place') status = 'Placed';
  else if (betResult === 'loss') status = 'Lost';
  else if (betResult === 'void') status = 'Void';
  
  // Calculate profit/loss
  const profitLoss = returns - bet.stake;
  
  // Convert ovr_btn to numeric
  const numericOvrBtn = extractNumericValue(horseResult.ovr_btn);
  const numericSP = extractNumericValue(horseResult.sp);

  // Prepare update data, ensuring numeric fields are numbers or null
  const updateData = {
    status: status,
    returns: returns,
    profit_loss: profitLoss,
    sp_industry: numericSP, // Ensure this is numeric or null
    ovr_btn: numericOvrBtn, // Ensure this is numeric or null
    closing_line_value: calculateCLV(bet, horseResult),
    clv_stake: calculateCLVStake(bet, horseResult),
    fin_pos: horseResult.position || null,
    updated_at: new Date().toISOString()
  };

  // Remove null fields to avoid potential issues
  Object.keys(updateData).forEach(key => updateData[key] === null && delete updateData[key]);

  console.log(`Update data for single bet ${bet.id}: ${JSON.stringify(updateData, null, 2)}`);
  
  // Update bet in Supabase
  const { error } = await supabase
    .from('racing_bets')
    .update(updateData)
    .eq('id', bet.id);
  
  if (error) {
    console.error(`Error updating single bet ID ${bet.id}:`, error.message);
    return false;
  }
  
  console.log(`Updated single bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}`);
  return true;
}

// Process a multiple bet
async function processMultipleBet(bet) {
  const selections = bet.horse_name.split('/').map(s => s.trim());
  const trackNames = bet.track_name ? bet.track_name.split('/').map(t => t.trim()) : [];
  
  console.log(`Processing multiple bet ID ${bet.id} with ${selections.length} selections: ${selections.join(', ')}`);
  
  // Find all horses in results
  const horseResults = [];
  let allHorsesFound = true;
  
  for (let i = 0; i < selections.length; i++) {
    const horseName = selections[i];
    // Use the specific track for this leg if available, else default to the first track
    const trackName = trackNames[i] || trackNames[0] || bet.track_name.split('/')[0].trim();
    const date = bet.race_date.split('T')[0];
    
    // Get the correct track horses from cache
    const cacheKey = `${trackName}:${date}`;
    const trackHorses = trackHorsesCache[cacheKey] || [];
    
    if (trackHorses.length === 0) {
      console.log(`No cached horses found for ${trackName} on ${date} for horse ${horseName} (Multiple bet leg ${i+1})`);
      allHorsesFound = false;
      break; // Cannot proceed if data for one leg is missing
    }
    
    // Find this horse in the relevant track results
    const horseResult = findHorseMatch(horseName, trackHorses);
    
    if (!horseResult) {
      console.log(`No match found for horse "${horseName}" at track "${trackName}" (Multiple bet leg ${i+1})`);
      allHorsesFound = false;
      break; // Cannot proceed if one horse is not found
    }
    
    console.log(`MATCH (Multiple Leg ${i+1}): ${horseName} → ${horseResult.horse_name} at ${trackName} (Position: ${horseResult.position})`);
    horseResults.push(horseResult);
  }
  
  // If not all horses were found, stop processing this multiple bet
  if (!allHorsesFound) {
      console.log(`Could not find all horses for multiple bet ID ${bet.id}. Skipping update.`);
      return false;
  }

  console.log(`Found all ${selections.length} horses for multiple bet ID ${bet.id}`);
  
  // Log the detailed horse data for debugging
  const horseDataDetails = horseResults.map(h => ({
    name: h.horse_name,
    position: h.position,
    sp: h.sp,
    ovr_btn: h.ovr_btn
  }));
  console.log(`Horse data details for multiple bet ${bet.id}: ${JSON.stringify(horseDataDetails, null, 2)}`);
  
  // Check if all horses won (for calculating returns)
  // Treat 'RR' (Rule 4 Reduction) or non-numeric positions as non-winners for simplicity
  const allWon = horseResults.every(hr => parseInt(hr.position) === 1);
  
  // Format data for display (string format with slashes for fin_pos)
  const positionsFormatted = horseResults.map(hr => hr.position || '?').join(' / ');
  
  // --- Calculate Combined Numeric Values --- 
  let combinedNumericSP = null;
  let combinedNumericOvrBtn = null;
  let combinedBSP = null;

  try {
    // Calculate combined SP (multiplication)
    let spProduct = 1;
    let spValid = true;
    for (const hr of horseResults) {
      const numericSP = extractNumericValue(hr.sp);
      if (numericSP !== null && numericSP > 0) {
        spProduct *= numericSP;
      } else {
        spValid = false;
        break;
      }
    }
    combinedNumericSP = spValid ? spProduct : null;
    console.log(`Combined SP (Numeric): ${combinedNumericSP}`);

    // Calculate combined ovr_btn (average)
    let totalOvrBtn = 0;
    let validCount = 0;
    for (const hr of horseResults) {
        const numericOvrBtn = extractNumericValue(hr.ovr_btn);
        if (numericOvrBtn !== null) { // Allow 0
            totalOvrBtn += numericOvrBtn;
            validCount++;
        }
    }
    if (validCount > 0) {
        combinedNumericOvrBtn = totalOvrBtn / validCount;
    } // else stays null
    console.log(`Combined ovr_btn (Numeric): ${combinedNumericOvrBtn}`);

    // Calculate combined BSP (multiplication)
    let bspProduct = 1;
    let bspValid = true;
    for (const hr of horseResults) {
      const numericBSP = extractNumericValue(hr.bsp);
      if (numericBSP !== null && numericBSP > 0) {
        bspProduct *= numericBSP;
      } else {
        bspValid = false;
        break;
      }
    }
    combinedBSP = bspValid ? bspProduct : null;
    console.log(`Combined BSP (Numeric): ${combinedBSP}`);

  } catch (err) {
    console.error(`Error calculating combined numeric values for bet ${bet.id}: ${err.message}`);
    // Ensure values are null if calculation fails
    combinedNumericSP = null;
    combinedNumericOvrBtn = null;
    combinedBSP = null;
  }
  // --- End Calculate Combined Numeric Values --- 

  // Determine bet result
  let status = 'Lost';
  if ((bet.bet_type === 'win' || bet.bet_type === 'double' || bet.bet_type === 'treble' || 
       bet.bet_type === 'accumulator' || !bet.bet_type) && allWon) {
    status = 'Won';
  } else {
      // Check for void legs (e.g., non-runner 'RR')
      const hasVoidLeg = horseResults.some(hr => hr.position && isNaN(parseInt(hr.position)));
      if (hasVoidLeg) {
          // Simplification: If any leg is void, mark the whole bet as Void for now
          // More complex logic could adjust odds based on remaining legs
          status = 'Void'; 
      }
  }
  
  // Calculate returns
  const returns = status === 'Won' ? bet.stake * bet.odds : (status === 'Void' ? bet.stake : 0);
  const profitLoss = returns - bet.stake;
  
  // Prepare update data, ensuring numeric fields are numbers or null
  const updateData = {
    status: status,
    returns: returns,
    profit_loss: profitLoss,
    fin_pos: positionsFormatted, // String format is ok for text field
    sp_industry: combinedNumericSP, // MUST be numeric or null
    ovr_btn: combinedNumericOvrBtn, // MUST be numeric or null
    updated_at: new Date().toISOString()
  };
  
  // Add BSP-related fields only if valid
  if (combinedBSP !== null) {
    updateData.closing_line_value = calculateCLVForMultiple(bet, combinedBSP);
    updateData.clv_stake = calculateCLVStakeForMultiple(bet, combinedBSP);
  }

  // Remove null fields before updating
  Object.keys(updateData).forEach(key => updateData[key] === null && delete updateData[key]);
  
  console.log(`Update data for multiple bet ${bet.id}: ${JSON.stringify(updateData, null, 2)}`);
  
  // Update bet in Supabase
  try {
    const { error } = await supabase
      .from('racing_bets')
      .update(updateData)
      .eq('id', bet.id);
    
    if (error) {
      console.error(`DB Error updating multiple bet ID ${bet.id}:`, error.message);
      // Log the data again on error
      console.error(`Data attempted for update: ${JSON.stringify(updateData)}`);
      return false;
    }
    
    console.log(`Updated multiple bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}`);
    return true;
  } catch (err) {
    console.error(`Exception during Supabase update for multiple bet ID ${bet.id}:`, err.message);
    return false;
  }
}

// Find horse match in results (we already filtered by track)
function findHorseMatch(horseName, horses) {
  if (!horseName || !horses || horses.length === 0) return null;
  
  // Log how many horses we're searching through
  // console.log(`Searching through ${horses.length} horses for a match to "${horseName}"`);
  
  const cleanHorse = cleanHorseName(horseName);
  const simplifiedHorse = simplifyHorseName(horseName);
  
  // Matching strategies in order of priority
  
  // 1. Exact name match
  const exactMatch = horses.find(h => 
    cleanHorseName(h.horse_name) === cleanHorse
  );
  
  if (exactMatch) {
    // console.log(`Found exact match for "${horseName}": "${exactMatch.horse_name}"`);
    return exactMatch;
  }
  
  // 2. Simplified name match (no spaces or special chars)
  const simplifiedMatch = horses.find(h => 
    h.simplified_name === simplifiedHorse
  );
  
  if (simplifiedMatch) {
    console.log(`Found simplified name match for "${horseName}": "${simplifiedMatch.horse_name}"`);
    return simplifiedMatch;
  }
  
  // 3. Partial name match (use with caution - can be inaccurate)
  /*
  const partialMatch = horses.find(h => {
    const horseNameClean = cleanHorseName(h.horse_name);
    return horseNameClean.includes(cleanHorse) || cleanHorse.includes(horseNameClean);
  });
  
  if (partialMatch) {
    console.log(`Found partial match for "${horseName}": "${partialMatch.horse_name}"`);
    return partialMatch;
  }
  */
  
  // 4. Fuzzy match - Levenshtein distance
  const fuzzyMatch = findClosestMatch(cleanHorse, horses);
  
  if (fuzzyMatch) {
    console.log(`Found fuzzy match for "${horseName}": "${fuzzyMatch.horse_name}"`);
    return fuzzyMatch;
  }
  
  // console.log(`No match found for horse "${horseName}" using any matching method`);
  return null;
}

// Find the closest match using Levenshtein distance
function findClosestMatch(horseName, horses) {
  if (!horseName || !horses || !horses.length) return null;
  
  // Levenshtein distance (memoized for slight performance improvement)
  const memo = {};
  function levenshtein(a, b) {
      const key = `${a}|${b}`;
      if (memo[key]) return memo[key];

      const matrix = [];
      for (let i = 0; i <= b.length; i++) matrix[i] = [i];
      for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

      for (let i = 1; i <= b.length; i++) {
          for (let j = 1; j <= a.length; j++) {
              const cost = a[j - 1] === b[i - 1] ? 0 : 1;
              matrix[i][j] = Math.min(
                  matrix[i - 1][j] + 1, // deletion
                  matrix[i][j - 1] + 1, // insertion
                  matrix[i - 1][j - 1] + cost // substitution
              );
          }
      }
      const distance = matrix[b.length][a.length];
      memo[key] = distance;
      return distance;
  }
  
  let bestMatch = null;
  let bestDistance = Infinity;
  const threshold = Math.max(2, Math.floor(horseName.length * 0.3)); // Adjusted threshold
  
  for (const horse of horses) {
    const distance = levenshtein(horseName, cleanHorseName(horse.horse_name));
    
    if (distance <= threshold && distance < bestDistance) { // Use <= threshold
      bestDistance = distance;
      bestMatch = horse;
    }
  }
  
  return bestMatch;
}

// Check if two track names are similar enough
function isSimilarTrack(track1, track2) {
  if (!track1 || !track2) return false;
  
  const clean1 = track1.replace(/\(.*?\)/g, '').trim(); // Remove content in parentheses
  const clean2 = track2.replace(/\(.*?\)/g, '').trim();

  // Exact match after cleaning
  if (clean1 === clean2) return true;
  
  // Consider partial match if one is a substring of the other (after cleaning)
  if (clean1.includes(clean2) || clean2.includes(clean1)) return true;
  
  return false;
}

// Helper functions
function cleanHorseName(name) {
  if (!name) return '';
  // Remove country codes like (GB), (IRE), etc. and convert to lowercase
  return name.replace(/\s*\([A-Z]{2,3}\)\s*$/g, '').toLowerCase().trim();
}

function cleanName(name) {
  if (!name) return '';
  return name.toLowerCase().trim();
}

function simplifyHorseName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractNumericValue(value) {
  if (value === null || value === undefined || value === '' || value === '-' || typeof value === 'boolean') return null;
  if (typeof value === 'number' && !isNaN(value)) return value;
  if (typeof value === 'string') {
    // Check for non-numeric placeholders commonly used
    const lowerVal = value.trim().toLowerCase();
    if (['ns', 'n/s', 'non-starter', 'rr', 'rule 4', 'ref', 'refused'].includes(lowerVal)) return null;
    
    // Remove common currency symbols, commas, etc.
    const numericStr = value.replace(/[^0-9.-]/g, ''); // Allow negative sign and decimal
    
    // Validate format (e.g., ensure only one decimal, one negative sign at start)
    if (!/^-?\d*\.?\d+$/.test(numericStr) && !/^-?\d+\.?\d*$/.test(numericStr)) {
        return null;
    }

    const num = parseFloat(numericStr);
    return isNaN(num) ? null : num;
  }
  return null;
}

// Determine bet result (win, place, loss, void)
function determineBetResult(horseResult, betType, numRunners) {
  if (!horseResult || horseResult.position === null || horseResult.position === undefined) return 'void'; // Void if no position
  
  const positionStr = String(horseResult.position).toUpperCase();
  
  // Handle non-numeric results (Void)
  if (['RR', 'REF', 'NR', 'NS', 'VOID', 'PULLED UP', 'PU', 'FELL', 'UR', 'SU'].some(v => positionStr.includes(v))) {
    return 'void';
  }
  
  const position = parseInt(positionStr, 10);
  if (isNaN(position)) return 'void'; // Void if position isn't a number after checks
  
  // Win bet logic
  if (betType === 'win' || betType === 'single' || !betType) {
    return position === 1 ? 'win' : 'loss';
  }
  
  // Place terms calculation (example - adjust as needed)
  let placeTerms = 0;
  if (numRunners >= 16) placeTerms = 4; // 1/4 odds usually
  else if (numRunners >= 8) placeTerms = 3; // 1/5 odds usually
  else if (numRunners >= 5) placeTerms = 2; // 1/4 odds usually
  // Handle handicaps separately if needed

  // Place bet logic
  if (betType === 'place') {
      if (placeTerms === 0) return 'loss'; // No places paid for small fields
      return position <= placeTerms ? 'place' : 'loss';
  }
  
  // Each-way bet logic
  if (betType === 'each-way') {
    if (position === 1) return 'win-place';
    if (placeTerms > 0 && position <= placeTerms) return 'place';
    return 'loss';
  }
  
  return null; // Should not happen if betType is handled
}

// Calculate returns based on bet result
function calculateReturns(bet, result, horseResult, numRunners) {
    if (!result || result === 'loss' || !bet.stake || !bet.odds) return 0;
    if (result === 'void') return bet.stake; // Return stake for void bets

    const stake = parseFloat(bet.stake);
    const odds = parseFloat(bet.odds);
    if (isNaN(stake) || isNaN(odds)) return 0;

    const isEachWay = bet.each_way === true;
    const betType = isEachWay ? 'each-way' : (bet.bet_type || 'win');

    // Calculate place odds fraction (common examples, adjust if needed)
    let placeFraction = 0;
    if (numRunners >= 8) placeFraction = 1/5;
    else if (numRunners >= 5) placeFraction = 1/4;

    // Win Bets (or single leg of multiple implicitly)
    if (betType === 'win' || betType === 'single') {
        return result === 'win' ? stake * odds : 0;
    }

    // Place Bets
    if (betType === 'place') {
        if (result === 'place' && placeFraction > 0) {
            const placeOdds = (odds - 1) * placeFraction + 1;
            return stake * placeOdds;
        }
        return 0;
    }

    // Each-Way Bets
    if (betType === 'each-way') {
        const ewStake = stake / 2;
        let totalReturns = 0;

        // Win part
        if (result === 'win' || result === 'win-place') {
            totalReturns += ewStake * odds;
        }

        // Place part
        if ((result === 'place' || result === 'win-place') && placeFraction > 0) {
            const placeOdds = (odds - 1) * placeFraction + 1;
            totalReturns += ewStake * placeOdds;
        }
        return totalReturns;
    }

    return 0; // Default case
}

// Calculate CLV
function calculateCLV(bet, horseResult) {
  const bsp = extractNumericValue(horseResult?.bsp);
  const betOdds = extractNumericValue(bet.odds);
  if (bsp === null || betOdds === null || bsp <= 0) return null;
  
  const clv = (betOdds / bsp - 1) * 100;
  return Math.round(clv * 100) / 100;
}

// Calculate CLV Stake
function calculateCLVStake(bet, horseResult) {
  const clv = calculateCLV(bet, horseResult);
  const stake = extractNumericValue(bet.stake);
  if (clv === null || stake === null) return null;
  
  return Math.round((clv * stake / 100) * 100) / 100;
}

// Multiple bet CLV
function calculateCLVForMultiple(bet, combinedBSP) {
  const betOdds = extractNumericValue(bet.odds);
  if (combinedBSP === null || betOdds === null || combinedBSP <= 0) return null;
  
  const clv = (betOdds / combinedBSP - 1) * 100;
  return Math.round(clv * 100) / 100;
}

// Multiple bet CLV Stake
function calculateCLVStakeForMultiple(bet, combinedBSP) {
  const clv = calculateCLVForMultiple(bet, combinedBSP);
  const stake = extractNumericValue(bet.stake);
  if (clv === null || stake === null) return null;
  
  return Math.round((clv * stake / 100) * 100) / 100;
}

// Run the main function
if (require.main === module) {
  updateBetResults()
    .then(result => {
      console.log('Script execution completed:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Unhandled error in script execution:', error);
      process.exit(1);
    });
}

module.exports = { updateBetResults };