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

// Fallback hardcoded track codes for common tracks (in case file loading fails)
const FALLBACK_TRACK_CODES = {
  'catterick': 'crs_260',
  'nottingham': 'crs_1040',
  'leopardstown': 'crs_4862',
  'kempton': 'crs_28054',
  'lingfield': 'crs_910',
  'newton abbot': 'crs_1026',
  'limerick': 'crs_4868',
  'hereford': 'crs_778'
};

// Load track codes from JSON file
let TRACK_CODES = {};
try {
  // Try to load the track codes file
  const trackCodesPath = path.resolve(__dirname, 'Track-codes-list.json');
  console.log(`Loading track codes from: ${trackCodesPath}`);
  
  if (fs.existsSync(trackCodesPath)) {
    const fileContent = fs.readFileSync(trackCodesPath, 'utf8');
    const parsedData = JSON.parse(fileContent);
    
    // Check for expected structure (new or old format)
    if (parsedData.courses && Array.isArray(parsedData.courses)) {
      console.log(`Found ${parsedData.courses.length} tracks in Track-codes-list.json (courses format)`);
      
      // Convert to name->id mapping for lookups
      parsedData.courses.forEach(course => {
        if (course.course && course.id) {
          TRACK_CODES[course.course.toLowerCase()] = course.id;
        }
      });
    } else if (parsedData.course_list && Array.isArray(parsedData.course_list)) {
      console.log(`Found ${parsedData.course_list.length} tracks in Track-codes-list.json (course_list format)`);
      
      // Convert to name->id mapping for lookups
      parsedData.course_list.forEach(course => {
        if (course.name && course.id) {
          TRACK_CODES[course.name.toLowerCase()] = course.id;
        }
      });
    } else {
      // Try to read the structure exactly as it is in the file
      console.log('Attempting to parse track codes directly from JSON structure');
      if (typeof parsedData === 'object') {
        // Parse the structure directly
        Object.entries(parsedData).forEach(([key, value]) => {
          if (typeof value === 'string' && value.startsWith('crs_')) {
            TRACK_CODES[key.toLowerCase()] = value;
          }
        });
      }
      
      if (Object.keys(TRACK_CODES).length === 0) {
        throw new Error('Track-codes-list.json does not contain expected structure');
      }
    }
    
    console.log(`Successfully loaded ${Object.keys(TRACK_CODES).length} track codes`);
    
    // Add fallbacks for any missing common tracks
    for (const [track, id] of Object.entries(FALLBACK_TRACK_CODES)) {
      if (!TRACK_CODES[track]) {
        TRACK_CODES[track] = id;
        console.log(`Added fallback track code for ${track}: ${id}`);
      }
    }
  } else {
    throw new Error(`Track-codes-list.json not found at: ${trackCodesPath}`);
  }
} catch (err) {
  console.error(`Error loading track codes: ${err.message}`);
  console.log('Falling back to hardcoded track codes');
  TRACK_CODES = { ...FALLBACK_TRACK_CODES };
}

// Log available track codes for debugging
console.log('Available track codes:');
for (const [track, id] of Object.entries(TRACK_CODES)) {
  console.log(`  - ${track}: ${id}`);
}

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
    
    // Extract all unique track+date combinations from bets
    const uniqueTracks = new Set();
    const trackDateCombos = new Map();
    
    pendingBets.forEach(bet => {
      if (!bet.track_name || !bet.race_date) return;
      
      const date = bet.race_date.split('T')[0];
      
      // Handle multiple tracks (for multiple bets)
      let trackNames = [];
      if (bet.track_name.includes('/')) {
        trackNames = bet.track_name.split('/').map(t => t.trim());
      } else {
        trackNames = [bet.track_name.trim()];
      }
      
      // Add each track to our sets and maps
      trackNames.forEach(track => {
        uniqueTracks.add(track);
        const key = `${track}:${date}`;
        trackDateCombos.set(key, { track, date });
      });
    });
    
    console.log(`Found ${uniqueTracks.size} unique tracks: ${Array.from(uniqueTracks).join(', ')}`);
    console.log(`Need to fetch ${trackDateCombos.size} track/date combinations`);
    
    // Results tracking
    const results = {
      total: pendingBets.length,
      updated: 0,
      noMatches: 0,
      errors: 0
    };
    
    // First pass: Fetch all the track data we need
    for (const [key, { track, date }] of trackDateCombos.entries()) {
      console.log(`\nProcessing track: ${track}, date: ${date}`);
      
      // Skip if we already have this data cached
      if (trackHorsesCache[key] && trackHorsesCache[key].length > 0) {
        console.log(`Using cached data for ${track} (${trackHorsesCache[key].length} horses)`);
        continue;
      }
      
      try {
        // Get the course ID for this track
        const courseId = findCourseId(track);
        
        if (courseId) {
          console.log(`Found course ID for ${track}: ${courseId}`);
          
          // Fetch the data from the racing API
          const horses = await fetchRaceResults(track, date, courseId);
          trackHorsesCache[key] = horses;
          
          console.log(`Fetched ${horses.length} horses for ${track} on ${date}`);
          if (horses.length === 0) {
            console.log(`WARNING: No horses found for ${track} on ${date} with ID ${courseId}`);
          }
        } else {
          console.error(`ERROR: No course ID found for ${track} in track codes list`);
          trackHorsesCache[key] = [];
        }
        
        // Wait to avoid API rate limits
        await sleep(5000); // Increased delay between API calls
      } catch (error) {
        console.error(`Error fetching data for ${track} on ${date}:`, error.message);
        trackHorsesCache[key] = [];
      }
    }
    
    // Second pass: Process all bets
    for (const bet of pendingBets) {
      try {
        if (!bet.horse_name || !bet.track_name || !bet.race_date) {
          console.log(`Skipping bet ID ${bet.id} - missing required fields`);
          results.noMatches++;
          continue;
        }
        
        const success = await processBet(bet);
        
        if (success) {
          results.updated++;
        } else {
          results.noMatches++;
        }
      } catch (error) {
        console.error(`Error processing bet ID ${bet.id}:`, error.message);
        results.errors++;
      }
    }
    
    // Print results summary
    console.log('\nResults Summary:');
    console.log(`- Total bets processed: ${results.total}`);
    console.log(`- Matches found and updated: ${results.updated}`);
    console.log(`- No matches found: ${results.noMatches}`);
    console.log(`- Errors encountered: ${results.errors}`);
    
    return {
      success: true,
      updated: results.updated,
      total: results.total,
      noMatches: results.noMatches,
      errors: results.errors
    };
    
  } catch (error) {
    console.error('Error in updateBetResults:', error.message);
    return { success: false, error: error.message };
  }
}

// Find a course ID based on track name
function findCourseId(trackName) {
  if (!trackName) return null;
  
  // Clean the track name
  let cleanTrack = trackName.toLowerCase().trim();
  
  // Direct match
  if (TRACK_CODES[cleanTrack]) {
    console.log(`Direct match for ${trackName}: ${TRACK_CODES[cleanTrack]}`);
    return TRACK_CODES[cleanTrack];
  }
  
  // Try removing common suffixes
  const withoutSuffix = cleanTrack
    .replace(/\s*\(aw\)$/i, '')
    .replace(/\s*\(all weather\)$/i, '')
    .replace(/\s*racecourse$/i, '')
    .trim();
  
  if (TRACK_CODES[withoutSuffix]) {
    console.log(`Suffix-removed match for ${trackName}: ${TRACK_CODES[withoutSuffix]}`);
    return TRACK_CODES[withoutSuffix];
  }
  
  // Look for partial matches
  for (const [track, id] of Object.entries(TRACK_CODES)) {
    if (track.includes(cleanTrack) || cleanTrack.includes(track)) {
      console.log(`Partial match: "${trackName}" -> "${track}" = ${id}`);
      return id;
    }
  }
  
  console.error(`No course ID found for track: ${trackName}`);
  return null;
}

// Fetch race results from the API
async function fetchRaceResults(trackName, date, courseId) {
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
    console.log(`API Request: ${racingApiBase}/results with params:`, params);
    
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
    }
    
    return horses;
  } catch (error) {
    console.error(`Error fetching race results for ${trackName}:`, error.message);
    if (error.response) {
      console.error(`API Status: ${error.response.status}`);
      console.error(`API Error: ${JSON.stringify(error.response.data).substring(0, 200)}...`);
    }
    return [];
  }
}

// Extract horse data from API response
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
    .replace(/\s*racecourse$/i, '')
    .trim();
  
  console.log(`Looking for races at "${cleanTarget}" in API response`);
  
  // Process each race in the results
  apiData.results.forEach(race => {
    // Get the track from the race
    const raceTrack = (race.course || '').toLowerCase().trim();
    const raceTrackClean = raceTrack
      .replace(/\s*\(aw\)$/i, '')
      .replace(/\s*racecourse$/i, '')
      .trim();
    
    // Check if this race is from our target track
    if (raceTrackClean.includes(cleanTarget) || cleanTarget.includes(raceTrackClean)) {
      console.log(`Found matching race at "${race.course}" for "${targetTrack}"`);
      
      // Process runners if available
      if (race.runners && Array.isArray(race.runners)) {
        race.runners.forEach(runner => {
          // Add each horse to our results
          horses.push({
            horse_name: runner.horse || '',
            track_name: race.course || targetTrack,
            race_time: race.off || race.time || '',
            position: runner.position || '',
            sp: parseFloat(runner.sp_dec) || null,
            bsp: parseFloat(runner.bsp) || null,
            ovr_btn: parseNumeric(runner.ovr_btn),
            btn: parseNumeric(runner.btn),
            total_runners: race.runners.length,
            race_id: race.race_id || '',
            race_name: race.race_name || '',
            simplified_name: simplifyName(runner.horse || '')
          });
        });
      }
    }
  });
  
  console.log(`Extracted ${horses.length} horses for ${targetTrack}`);
  return horses;
}

// Process a bet (single or multiple)
async function processBet(bet) {
  // Determine if this is a multiple bet
  const isMultiple = bet.horse_name.includes('/');
  
  if (isMultiple) {
    return await processMultipleBet(bet);
  } else {
    return await processSingleBet(bet);
  }
}

// Process a single bet
async function processSingleBet(bet) {
  console.log(`Processing single bet: ${bet.id} - ${bet.horse_name}`);
  
  const date = bet.race_date.split('T')[0];
  const trackName = bet.track_name.trim();
  const horseName = bet.horse_name.trim();
  
  // Get cached horses for this track/date
  const cacheKey = `${trackName}:${date}`;
  const cachedHorses = trackHorsesCache[cacheKey] || [];
  
  if (cachedHorses.length === 0) {
    console.log(`No horses found for ${trackName} on ${date}`);
    return false;
  }
  
  // Find the matching horse
  const horse = findHorseMatch(horseName, cachedHorses);
  
  if (!horse) {
    console.log(`No match found for horse: ${horseName} at ${trackName}`);
    return false;
  }
  
  console.log(`Found match: ${horseName} -> ${horse.horse_name} (Position: ${horse.position})`);
  
  // Calculate bet status and returns
  const { status, returns, profit_loss, sp_industry, ovr_btn, fin_pos } = calculateBetResult(bet, [horse]);
  
  // Update bet in database
  try {
    // Prepare update data - ensure all values are properly typed
    const updateData = {
      status: status,
      fin_pos: fin_pos,
      updated_at: new Date().toISOString()
    };
    
    // Only add numeric fields if they're valid numbers
    if (returns !== null && !isNaN(returns)) updateData.returns = returns;
    if (profit_loss !== null && !isNaN(profit_loss)) updateData.profit_loss = profit_loss;
    if (sp_industry !== null && !isNaN(sp_industry)) updateData.sp_industry = sp_industry;
    if (ovr_btn !== null && !isNaN(ovr_btn)) updateData.ovr_btn = ovr_btn;
    
    console.log(`Updating bet ${bet.id} with: ${JSON.stringify(updateData)}`);
    
    // Update in Supabase
    const { error } = await supabase
      .from('racing_bets')
      .update(updateData)
      .eq('id', bet.id);
    
    if (error) {
      console.error(`Error updating bet ${bet.id}:`, error.message);
      return false;
    }
    
    console.log(`Successfully updated bet ${bet.id}: ${status}, Returns: ${returns}`);
    return true;
  } catch (error) {
    console.error(`Exception updating bet ${bet.id}:`, error.message);
    return false;
  }
}

// Process a multiple bet
async function processMultipleBet(bet) {
  console.log(`Processing multiple bet: ${bet.id} - ${bet.horse_name}`);
  
  // Split horse names and track names
  const horseNames = bet.horse_name.split('/').map(h => h.trim());
  let trackNames = [];
  
  if (bet.track_name.includes('/')) {
    // Multiple tracks specified
    trackNames = bet.track_name.split('/').map(t => t.trim());
  } else {
    // Single track for all horses
    trackNames = horseNames.map(() => bet.track_name.trim());
  }
  
  console.log(`Multiple bet has ${horseNames.length} selections: ${horseNames.join(', ')}`);
  console.log(`Tracks: ${trackNames.join(', ')}`);
  
  const date = bet.race_date.split('T')[0];
  const horses = [];
  const missingHorses = [];
  
  // Find all horses
  for (let i = 0; i < horseNames.length; i++) {
    const horseName = horseNames[i];
    const trackName = trackNames[i] || trackNames[0]; // Use first track if not enough tracks specified
    
    // Get cached horses for this track
    const cacheKey = `${trackName}:${date}`;
    const cachedHorses = trackHorsesCache[cacheKey] || [];
    
    if (cachedHorses.length === 0) {
      console.log(`No horses found for ${trackName} on ${date} for horse ${horseName}`);
      missingHorses.push({ horseName, trackName, reason: 'No horses found for track/date' });
      continue; // Continue to next horse instead of failing the entire bet
    }
    
    // Find this horse
    const horse = findHorseMatch(horseName, cachedHorses);
    
    if (horse) {
      console.log(`Found match for multiple bet: ${horseName} -> ${horse.horse_name} (Position: ${horse.position})`);
      horses.push(horse);
    } else {
      console.log(`No match found for horse: ${horseName} at ${trackName}`);
      missingHorses.push({ horseName, trackName, reason: 'No match found' });
    }
  }
  
  console.log(`Found ${horses.length} of ${horseNames.length} horses for multiple bet ${bet.id}`);
  
  // If we didn't find any horses, fail
  if (horses.length === 0) {
    console.log(`Failed to find any horses for multiple bet ${bet.id}`);
    for (const missing of missingHorses) {
      console.log(`- ${missing.horseName} at ${missing.trackName}: ${missing.reason}`);
    }
    return false;
  }
  
  // If we found some but not all horses, proceed with what we have (partial update)
  if (horses.length < horseNames.length) {
    console.log(`WARNING: Only found ${horses.length} of ${horseNames.length} horses for bet ${bet.id}`);
    for (const missing of missingHorses) {
      console.log(`- ${missing.horseName} at ${missing.trackName}: ${missing.reason}`);
    }
  }
  
  // Calculate bet status, returns, etc.
  const { status, returns, profit_loss, sp_industry, ovr_btn, fin_pos } = calculateBetResult(bet, horses);
  
  // Update bet in database
  try {
    // Prepare update data - ensure all values are properly typed
    const updateData = {
      status: status,
      fin_pos: fin_pos,
      updated_at: new Date().toISOString()
    };
    
    // Only add numeric fields if they're valid numbers
    if (returns !== null && !isNaN(returns)) updateData.returns = returns;
    if (profit_loss !== null && !isNaN(profit_loss)) updateData.profit_loss = profit_loss;
    if (sp_industry !== null && !isNaN(sp_industry)) updateData.sp_industry = sp_industry;
    if (ovr_btn !== null && !isNaN(ovr_btn)) updateData.ovr_btn = ovr_btn;
    
    console.log(`Updating multiple bet ${bet.id} with: ${JSON.stringify(updateData)}`);
    
    // Update in Supabase
    const { error } = await supabase
      .from('racing_bets')
      .update(updateData)
      .eq('id', bet.id);
    
    if (error) {
      console.error(`Error updating multiple bet ${bet.id}:`, error.message);
      console.error(`Update data: ${JSON.stringify(updateData)}`);
      return false;
    }
    
    console.log(`Successfully updated multiple bet ${bet.id}: ${status}, Returns: ${returns}`);
    return true;
  } catch (error) {
    console.error(`Exception updating multiple bet ${bet.id}:`, error.message);
    return false;
  }
}

// Calculate the outcome of a bet
function calculateBetResult(bet, horses) {
  if (!horses || horses.length === 0) {
    throw new Error('No horse data provided to calculate bet result');
  }
  
  const isMultiple = horses.length > 1;
  const originalHorseCount = (bet.horse_name || '').split('/').length;
  const missingHorses = originalHorseCount - horses.length;
  
  // For multi-selection bets where not all horses were found
  let status = 'Pending';
  
  if (isMultiple && missingHorses > 0) {
    console.log(`Multiple bet has ${missingHorses} missing horses, marking as 'Partial Update'`);
    status = 'Partial Update';
  } else if (isMultiple) {
    // For complete multiples, check if all horses won
    const allWon = horses.every(horse => {
      const pos = parseFloat(horse.position);
      return pos === 1 || horse.position === '1';
    });
    
    // Check for void legs (non-runners)
    const hasVoidLeg = horses.some(horse => {
      const posLower = (horse.position || '').toLowerCase();
      return posLower === 'rr' || posLower === 'nr' || posLower === 'ns' || posLower === 'void';
    });
    
    if (hasVoidLeg) {
      status = 'Void';
    } else if (allWon) {
      status = 'Won';
    } else {
      status = 'Lost';
    }
  } else {
    // Single bet
    const horse = horses[0];
    const positionStr = String(horse.position || '').trim().toLowerCase();
    
    // Check for non-numeric positions (void races)
    if (positionStr === 'nr' || positionStr === 'ns' || positionStr === 'rr' || positionStr === 'void') {
      status = 'Void';
    } else {
      // Try to get numeric position
      const position = parseFloat(positionStr);
      
      if (isNaN(position)) {
        // If position can't be parsed as a number
        status = 'Pending'; // Keep as pending if we can't determine position
      } else if (position === 1) {
        status = 'Won';
      } else if (bet.each_way === true) {
        // Check place for each-way bets
        const numRunners = horse.total_runners || 0;
        let placePaid = 0;
        
        if (numRunners >= 16) placePaid = 4;
        else if (numRunners >= 8) placePaid = 3;
        else if (numRunners >= 5) placePaid = 2;
        
        if (placePaid > 0 && position <= placePaid) {
          status = 'Placed';
        } else {
          status = 'Lost';
        }
      } else {
        status = 'Lost';
      }
    }
  }
  
  // Calculate returns
  let returns = 0;
  
  if (status === 'Won') {
    // Winning bet gets full odds
    returns = parseFloat(bet.stake || 0) * parseFloat(bet.odds || 0);
  } else if (status === 'Placed' && bet.each_way === true) {
    // Each-way place pays a fraction
    const placeOdds = (parseFloat(bet.odds || 0) - 1) * 0.2 + 1; // 1/5 odds typically
    returns = (parseFloat(bet.stake || 0) / 2) * placeOdds; // Half stake on place
  } else if (status === 'Void') {
    // Void bets return the stake
    returns = parseFloat(bet.stake || 0);
  }
  
  // Calculate profit/loss
  const profitLoss = returns - parseFloat(bet.stake || 0);
  
  // Format finish positions
  const finishPositions = horses.map(h => h.position || '?').join(' / ');
  
  // Calculate SP value
  let spValue = null;
  if (isMultiple) {
    // For multiples, SP is the product of individual SPs
    let hasAllSPs = true;
    let cumulativeSP = 1;
    
    for (const horse of horses) {
      if (horse.sp === null || isNaN(horse.sp)) {
        hasAllSPs = false;
        break;
      }
      cumulativeSP *= parseFloat(horse.sp);
    }
    
    spValue = hasAllSPs ? cumulativeSP : null;
  } else {
    // For singles, use the horse's SP
    spValue = parseNumeric(horses[0].sp);
  }
  
  // Calculate OVR_BTN value
  let ovrBtnValue = null;
  if (isMultiple) {
    // For multiples, use average of all horses' values
    let sum = 0;
    let count = 0;
    
    for (const horse of horses) {
      if (horse.ovr_btn !== null && !isNaN(horse.ovr_btn)) {
        sum += parseFloat(horse.ovr_btn);
        count++;
      }
    }
    
    ovrBtnValue = count > 0 ? sum / count : null;
  } else {
    // For singles, use the horse's value
    ovrBtnValue = parseNumeric(horses[0].ovr_btn);
  }
  
  return {
    status,
    returns,
    profit_loss: profitLoss,
    sp_industry: spValue,
    ovr_btn: ovrBtnValue,
    fin_pos: finishPositions
  };
}

// Find a matching horse in the results
function findHorseMatch(horseName, horses) {
  if (!horseName || !horses || horses.length === 0) return null;
  
  const cleanName = horseName.toLowerCase().trim();
  const simplifiedSearch = simplifyName(horseName);
  
  console.log(`Searching ${horses.length} horses for match to "${horseName}"`);
  
  // Try exact match first
  for (const horse of horses) {
    // Clean the horse name from API response
    const apiName = (horse.horse_name || '').toLowerCase().trim();
    const apiNameWithoutCountry = apiName.replace(/\s*\([a-z]{2,3}\)$/i, '');
    
    if (apiName === cleanName || apiNameWithoutCountry === cleanName) {
      console.log(`Exact match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try simplified match (no spaces, no punctuation)
  for (const horse of horses) {
    if (horse.simplified_name === simplifiedSearch) {
      console.log(`Simplified match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try fuzzy matching
  const fuzzyMatch = findClosestHorseMatch(cleanName, horses);
  if (fuzzyMatch) {
    console.log(`Fuzzy match found: ${fuzzyMatch.horse_name}`);
    return fuzzyMatch;
  }
  
  console.log(`No match found for horse: ${horseName}`);
  return null;
}

// Find closest matching horse using Levenshtein distance
function findClosestHorseMatch(name, horses) {
  // Levenshtein distance function
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
  
  let bestMatch = null;
  let bestDistance = Infinity;
  const threshold = Math.max(2, Math.floor(name.length * 0.3)); // Allow 30% difference max
  
  for (const horse of horses) {
    const horseName = (horse.horse_name || '').toLowerCase().trim().replace(/\s*\([a-z]{2,3}\)$/i, '');
    const distance = levenshtein(name, horseName);
    
    if (distance < threshold && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = horse;
    }
  }
  
  return bestMatch;
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

// Run the script
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