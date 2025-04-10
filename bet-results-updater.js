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

// Fallback track codes in case file loading fails
const FALLBACK_TRACK_CODES = {
  'catterick': 'crs_19734',
  'nottingham': 'crs_38742',
  'leopardstown': 'crs_32789',
  'kempton': 'crs_29348',
  'taunton': 'crs_23985'
};

// Load track codes from JSON file
let TRACK_CODES = {};
try {
  // Try to load the track codes file
  const trackCodesPath = path.resolve(__dirname, 'Track-codes-list.json');
  console.log(`Attempting to load track codes from: ${trackCodesPath}`);
  
  if (fs.existsSync(trackCodesPath)) {
    const fileContent = fs.readFileSync(trackCodesPath, 'utf8');
    const parsedData = JSON.parse(fileContent);
    
    // Check for expected structure
    if (parsedData.course_list && Array.isArray(parsedData.course_list)) {
      console.log(`Found ${parsedData.course_list.length} tracks in Track-codes-list.json`);
      
      // Convert to name->id mapping for lookups
      parsedData.course_list.forEach(course => {
        if (course.name && course.id) {
          TRACK_CODES[course.name.toLowerCase()] = course.id;
        }
      });
      
      console.log(`Successfully loaded ${Object.keys(TRACK_CODES).length} track codes into lookup table`);
    } else {
      throw new Error('Track-codes-list.json does not contain expected "course_list" array');
    }
  } else {
    throw new Error(`Track-codes-list.json not found at: ${trackCodesPath}`);
  }
} catch (err) {
  console.error(`Error loading track codes: ${err.message}`);
  console.log('Falling back to hardcoded track codes');
  TRACK_CODES = { ...FALLBACK_TRACK_CODES };
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
    
    // Extract all unique horses and their tracks from all bets
    const horseTrackDateMap = new Map(); // Map of horses with their tracks and dates
    pendingBets.forEach(bet => {
      if (!bet.track_name || !bet.race_date || !bet.horse_name) return;
      
      const date = bet.race_date.split('T')[0];
      
      // Handle multiple horses
      if (bet.horse_name.includes('/')) {
        const horses = bet.horse_name.split('/').map(h => h.trim());
        const tracks = bet.track_name.split('/').map(t => t.trim());
        
        horses.forEach((horse, index) => {
          // Use correct track for this horse if available
          const track = tracks[index] || tracks[0];
          const key = `${horse}:${track}:${date}`;
          horseTrackDateMap.set(key, { horse, track, date });
        });
      } else {
        // Single horse
        const key = `${bet.horse_name}:${bet.track_name}:${date}`;
        horseTrackDateMap.set(key, { horse: bet.horse_name, track: bet.track_name, date });
      }
    });
    
    // Get unique tracks to fetch
    const uniqueTracks = new Map();
    horseTrackDateMap.forEach(({ track, date }) => {
      const key = `${track}:${date}`;
      uniqueTracks.set(key, { track, date });
    });
    
    console.log(`Found ${uniqueTracks.size} unique track/date combinations to process`);
    
    // First fetch all needed track data
    for (const [key, { track, date }] of uniqueTracks.entries()) {
      console.log(`\nFetching data for track: ${track}, date: ${date}`);
      
      if (trackHorsesCache[key]) {
        console.log(`Using cached data for ${track} (${trackHorsesCache[key].length} horses)`);
        continue;
      }
      
      try {
        // Get course ID
        const trackNameLower = track.toLowerCase();
        const courseId = TRACK_CODES[trackNameLower];
        
        if (courseId) {
          console.log(`Found course ID for ${track}: ${courseId}`);
          const horses = await fetchResultsByTrack(track, date, courseId);
          trackHorsesCache[key] = horses;
          console.log(`Cached ${horses.length} horses for ${track} on ${date}`);
        } else {
          console.error(`ERROR: No course ID found for ${track} in track codes list`);
          trackHorsesCache[key] = [];
        }
        
        // Wait to avoid API rate limits
        await sleep(2000);
      } catch (error) {
        console.error(`Error fetching data for ${track}:`, error.message);
        trackHorsesCache[key] = [];
      }
    }
    
    // Process bets
    let updated = 0;
    let failures = 0;
    
    // Process each bet
    for (const bet of pendingBets) {
      try {
        // For multiples, need to get all horses data first
        const isMultiple = bet.horse_name && bet.horse_name.includes('/');
        let success = false;
        
        if (isMultiple) {
          success = await processMultipleBet(bet);
        } else {
          success = await processSingleBet(bet);
        }
        
        if (success) {
          updated++;
        } else {
          failures++;
        }
      } catch (error) {
        console.error(`Error processing bet ID ${bet.id}:`, error.message);
        failures++;
      }
    }
    
    console.log('\nResults Summary:');
    console.log(`- Total bets processed: ${pendingBets.length}`);
    console.log(`- Successfully updated: ${updated}`);
    console.log(`- Failed to update: ${failures}`);
    
    return {
      success: true, 
      updated,
      total: pendingBets.length,
      failures
    };
    
  } catch (error) {
    console.error('Error in updateBetResults:', error.message);
    return { success: false, error: error.message };
  }
}

// Fetch race results by track and date
async function fetchResultsByTrack(trackName, date, courseId) {
  console.log(`Fetching results for track: ${trackName}, date: ${date}`);
  
  try {
    // Basic params
    const params = {
      start_date: date
    };
    
    // Add course ID if available
    if (courseId) {
      params.course = courseId;
    } else {
      console.error(`No course ID available for ${trackName}`);
      return [];
    }
    
    console.log(`API Request: ${racingApiBase}/results with params: ${JSON.stringify(params)}`);
    
    // Call the API
    const response = await racingApi.get('/results', { params });
    
    // Create a safe filename
    const safeTrackName = trackName.replace(/[^a-zA-Z0-9_]/g, '_');
    const outputFile = `${safeTrackName}_${date}_response.json`;
    
    // Save raw response for debugging
    fs.writeFileSync(outputFile, JSON.stringify(response.data, null, 2));
    console.log(`Saved raw API response to ${outputFile}`);
    
    // Extract horses
    const horses = extractHorsesFromResponse(response.data, trackName);
    console.log(`Found ${horses.length} horses for ${trackName}`);
    
    // Save extracted horses
    if (horses.length > 0) {
      fs.writeFileSync(
        `${safeTrackName}_horses.json`,
        JSON.stringify(horses, null, 2)
      );
    }
    
    return horses;
  } catch (error) {
    console.error(`Error fetching results for ${trackName}:`, error.message);
    if (error.response) {
      console.error(`API status: ${error.response.status}`);
      if (error.response.data) {
        console.error(`API error: ${JSON.stringify(error.response.data)}`);
      }
    }
    return [];
  }
}

// Extract horses from API response
function extractHorsesFromResponse(apiData, targetTrack) {
  if (!apiData || !apiData.results || !Array.isArray(apiData.results)) {
    console.error('No results array found in API response');
    return [];
  }
  
  const horses = [];
  const cleanTargetTrack = targetTrack.toLowerCase().trim();
  
  // Process each race
  apiData.results.forEach(race => {
    // Get the track name from the result
    const apiTrackName = (race.course || race.course_id || '').toLowerCase().trim();
    
    // If this race matches our target track
    if (apiTrackName.includes(cleanTargetTrack) || cleanTargetTrack.includes(apiTrackName)) {
      console.log(`Found matching race at "${race.course || race.course_id}" for "${targetTrack}"`);
      
      // Process all runners
      if (race.runners && Array.isArray(race.runners)) {
        race.runners.forEach(runner => {
          // Extract all relevant fields for this horse
          horses.push({
            horse_name: runner.horse || runner.name || '',
            track_name: race.course || race.course_id || targetTrack,
            position: runner.position || runner.finish_position || '',
            sp: runner.sp_dec || runner.sp || null,
            bsp: runner.bsp || null,
            ovr_btn: runner.ovr_btn || runner.btn || null,
            btn: runner.btn || null,
            race_time: race.time || race.off || race.off_dt || '',
            race_id: race.race_id || '',
            race_name: race.race_name || '',
            total_runners: race.runners.length,
            simplified_name: simplifyHorseName(runner.horse || runner.name || '')
          });
        });
      }
    }
  });
  
  return horses;
}

// Process a single bet
async function processSingleBet(bet) {
  console.log(`Processing single bet: ${bet.id} - ${bet.horse_name}`);
  
  if (!bet.horse_name || !bet.track_name || !bet.race_date) {
    console.log(`Skipping bet - missing required fields`);
    return false;
  }
  
  const date = bet.race_date.split('T')[0];
  const track = bet.track_name.trim();
  const cacheKey = `${track}:${date}`;
  
  // Get horses for this track/date
  const trackHorses = trackHorsesCache[cacheKey] || [];
  
  if (trackHorses.length === 0) {
    console.log(`No horse data found for ${track} on ${date}`);
    return false;
  }
  
  // Find the horse
  const horse = findHorseMatch(bet.horse_name, trackHorses);
  
  if (!horse) {
    console.log(`No match found for horse: ${bet.horse_name}`);
    return false;
  }
  
  console.log(`Found match for ${bet.horse_name} → ${horse.horse_name} (Position: ${horse.position || 'unknown'})`);
  
  // Process the result
  const result = await updateBetWithHorseData(bet, [horse]);
  return result;
}

// Process a multiple bet
async function processMultipleBet(bet) {
  if (!bet.horse_name || !bet.track_name || !bet.race_date) {
    console.log(`Skipping multiple bet - missing required fields`);
    return false;
  }
  
  const date = bet.race_date.split('T')[0];
  const horseNames = bet.horse_name.split('/').map(h => h.trim());
  const trackNames = bet.track_name.split('/').map(t => t.trim());
  
  console.log(`Processing multiple bet: ${bet.id} with ${horseNames.length} selections: ${horseNames.join(', ')}`);
  
  // Find all horses
  const horses = [];
  let allFound = true;
  
  for (let i = 0; i < horseNames.length; i++) {
    const horseName = horseNames[i];
    // Use the correct track for this horse (or use the first track if not enough tracks specified)
    const trackName = trackNames[i] || trackNames[0];
    const cacheKey = `${trackName}:${date}`;
    
    // Get horses for this track
    const trackHorses = trackHorsesCache[cacheKey] || [];
    
    if (trackHorses.length === 0) {
      console.log(`No horse data found for ${trackName} on ${date} for horse ${horseName}`);
      allFound = false;
      break;
    }
    
    // Find this horse
    const horse = findHorseMatch(horseName, trackHorses);
    
    if (!horse) {
      console.log(`No match found for horse: ${horseName} at ${trackName}`);
      allFound = false;
      break;
    }
    
    console.log(`Found match for ${horseName} → ${horse.horse_name} (Position: ${horse.position || 'unknown'})`);
    horses.push(horse);
  }
  
  if (!allFound) {
    console.log(`Could not find all horses for multiple bet ID ${bet.id}`);
    return false;
  }
  
  console.log(`Found all ${horses.length} horses for multiple bet`);
  
  // Update the bet
  const result = await updateBetWithHorseData(bet, horses);
  return result;
}

// Update a bet record (single or multiple) in the database
async function updateBetWithHorseData(bet, horses) {
  if (!horses || horses.length === 0) return false;
  
  try {
    const isMultiple = horses.length > 1;
    const numRunners = isMultiple ? null : parseInt(horses[0].total_runners || 0);
    const betType = bet.each_way ? 'each-way' : (bet.bet_type || 'win');
    
    // Determine if bet won
    let status;
    if (isMultiple) {
      // For multiples, all legs must win
      const allWon = horses.every(h => h.position === '1' || parseInt(h.position) === 1);
      
      // Check for void legs (non-runners)
      const hasVoidLeg = horses.some(h => {
        const pos = h.position;
        return pos === 'void' || pos === 'NR' || pos === 'NS' || pos === 'RR';
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
      const betResult = determineBetResult(horses[0], betType, numRunners);
      
      if (betResult === 'win' || betResult === 'win-place') status = 'Won';
      else if (betResult === 'place') status = 'Placed';
      else if (betResult === 'loss') status = 'Lost';
      else if (betResult === 'void') status = 'Void';
      else status = 'Pending';
    }
    
    // Calculate returns
    let returns = 0;
    if (status === 'Won') {
      returns = parseFloat(bet.stake || 0) * parseFloat(bet.odds || 0);
    } else if (status === 'Void') {
      returns = parseFloat(bet.stake || 0);
    } else if (status === 'Placed' && !isMultiple) {
      // For single each-way bets that placed
      if (betType === 'each-way' || betType === 'place') {
        // Calculate place terms
        let placeFraction = 0.2; // 1/5 for large fields
        if (numRunners <= 4) placeFraction = 0;
        else if (numRunners <= 7) placeFraction = 0.25; // 1/4 for small fields
        
        // Calculate returns
        if (betType === 'place') {
          returns = parseFloat(bet.stake || 0) * ((parseFloat(bet.odds || 0) - 1) * placeFraction + 1);
        } else if (betType === 'each-way') {
          // Half stake on place part
          returns = (parseFloat(bet.stake || 0) / 2) * ((parseFloat(bet.odds || 0) - 1) * placeFraction + 1);
        }
      }
    }
    
    const profitLoss = returns - parseFloat(bet.stake || 0);
    
    // Prepare positions string for fin_pos
    const positions = horses.map(h => h.position || '?').join(' / ');
    
    // Calculate SP values
    let spValue = null;
    if (isMultiple) {
      // For multiples, multiply SPs
      let hasAllSP = true;
      let spProduct = 1;
      
      for (const horse of horses) {
        const sp = extractNumericValue(horse.sp);
        if (sp === null || sp <= 0) {
          hasAllSP = false;
          break;
        }
        spProduct *= sp;
      }
      
      spValue = hasAllSP ? spProduct : null;
    } else {
      // For singles, just use the SP
      spValue = extractNumericValue(horses[0].sp);
    }
    
    // Calculate OVR_BTN
    let ovrBtnValue = null;
    if (isMultiple) {
      // For multiples, use average of all legs
      let validCount = 0;
      let sum = 0;
      
      for (const horse of horses) {
        const btn = extractNumericValue(horse.ovr_btn);
        if (btn !== null) {
          sum += btn;
          validCount++;
        }
      }
      
      ovrBtnValue = validCount > 0 ? sum / validCount : null;
    } else {
      // For singles, just use the value
      ovrBtnValue = extractNumericValue(horses[0].ovr_btn);
    }
    
    // Prepare update data
    const updateData = {
      status: status,
      returns: returns,
      profit_loss: profitLoss,
      fin_pos: positions,
      updated_at: new Date().toISOString()
    };
    
    // Only add numeric fields if they're valid
    if (spValue !== null) updateData.sp_industry = spValue;
    if (ovrBtnValue !== null) updateData.ovr_btn = ovrBtnValue;
    
    // Add BSP-related fields
    if (!isMultiple) {
      const bspValue = extractNumericValue(horses[0].bsp);
      if (bspValue && bspValue > 0) {
        updateData.closing_line_value = calculateCLV(bet, bspValue);
        updateData.clv_stake = calculateCLVStake(bet, bspValue);
      }
    }
    
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
    console.error(`Error in updateBetWithHorseData for bet ${bet.id}:`, error.message);
    return false;
  }
}

// Find a horse match in the results
function findHorseMatch(horseName, horses) {
  if (!horseName || !horses || horses.length === 0) return null;
  
  const cleanHorseName = horseName.toLowerCase().trim().replace(/\s*\([a-z]{2,3}\)\s*$/i, '');
  const simplifiedSearch = simplifyHorseName(horseName);
  
  // Try exact match first
  for (const horse of horses) {
    const apiHorseName = (horse.horse_name || '')
      .toLowerCase()
      .trim()
      .replace(/\s*\([a-z]{2,3}\)\s*$/i, '');
    
    if (apiHorseName === cleanHorseName) {
      return horse;
    }
  }
  
  // Try simplified match
  for (const horse of horses) {
    if (horse.simplified_name === simplifiedSearch) {
      return horse;
    }
  }
  
  // Try fuzzy match
  const fuzzyMatch = findClosestMatch(cleanHorseName, horses);
  if (fuzzyMatch) {
    return fuzzyMatch;
  }
  
  return null;
}

// Find the closest match using Levenshtein distance
function findClosestMatch(horseName, horses) {
  if (!horseName || !horses || !horses.length) return null;
  
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
  
  // Find closest match
  let bestMatch = null;
  let bestDistance = Infinity;
  const threshold = Math.max(2, Math.floor(horseName.length * 0.25)); // Lower threshold for better matching
  
  for (const horse of horses) {
    const apiHorseName = (horse.horse_name || '')
      .toLowerCase()
      .trim()
      .replace(/\s*\([a-z]{2,3}\)\s*$/i, '');
    
    const distance = levenshtein(horseName, apiHorseName);
    
    if (distance <= threshold && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = horse;
    }
  }
  
  return bestMatch;
}

// Simplify horse name for matching
function simplifyHorseName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Extract numeric value
function extractNumericValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !isNaN(value)) return value;
  
  if (typeof value === 'string') {
    // Check for non-numeric placeholders
    if (['nr', 'ns', 'rr', 'void', 'pu', 'fell', 'ur', 'bd', 'su'].includes(value.toLowerCase().trim())) {
      return null;
    }
    
    // Try to extract a number
    const numStr = value.replace(/[^0-9.-]/g, '');
    if (numStr) {
      const num = parseFloat(numStr);
      return isNaN(num) ? null : num;
    }
  }
  
  return null;
}

// Determine bet result (win, place, loss, void)
function determineBetResult(horseResult, betType, numRunners) {
  // Handle missing or non-numeric positions
  if (!horseResult || !horseResult.position) return 'void';
  
  // Check for void positions (non-runners, etc.)
  if (typeof horseResult.position === 'string') {
    const pos = horseResult.position.toLowerCase();
    if (['void', 'nr', 'ns', 'rr', 'pu', 'fell', 'ur', 'bd', 'su'].includes(pos)) {
      return 'void';
    }
  }
  
  // Parse position as number
  const position = parseInt(horseResult.position);
  if (isNaN(position)) return 'void';
  
  // Win bet
  if (betType === 'win' || betType === 'single') {
    return position === 1 ? 'win' : 'loss';
  }
  
  // Place terms based on field size
  let placeTerm = 0;
  if (numRunners >= 16) placeTerm = 4;
  else if (numRunners >= 8) placeTerm = 3;
  else if (numRunners >= 5) placeTerm = 2;
  
  // Place bet
  if (betType === 'place') {
    return position <= placeTerm ? 'place' : 'loss';
  }
  
  // Each-way bet
  if (betType === 'each-way') {
    if (position === 1) return 'win-place';
    if (placeTerm > 0 && position <= placeTerm) return 'place';
    return 'loss';
  }
  
  return 'loss';
}

// Calculate CLV
function calculateCLV(bet, bspValue) {
  const betOdds = parseFloat(bet.odds);
  if (isNaN(betOdds) || !bspValue || bspValue <= 0) return null;
  
  const clv = (betOdds / bspValue - 1) * 100;
  return parseFloat(clv.toFixed(2));
}

// Calculate CLV Stake
function calculateCLVStake(bet, bspValue) {
  const clv = calculateCLV(bet, bspValue);
  const stake = parseFloat(bet.stake);
  
  if (clv === null || isNaN(stake)) return null;
  
  const clvStake = (clv * stake) / 100;
  return parseFloat(clvStake.toFixed(2));
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