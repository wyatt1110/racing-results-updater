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

// Hardcoded track codes with verified correct values
const TRACK_CODES = {
  'catterick': 'crs_260',
  'nottingham': 'crs_1040',
  'leopardstown': 'crs_4862',
  'taunton': 'crs_1898',
  'kempton': 'crs_28054'
};

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
        // Find course ID for this track
        const courseId = findCourseId(track);
        if (courseId) {
          console.log(`Found course ID for ${track}: ${courseId}`);
        } else {
          console.log(`No course ID found for ${track}`);
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

// Find course ID based on track name
function findCourseId(trackName) {
  if (!trackName) return null;
  
  const cleanTrack = trackName.toLowerCase().trim();
  
  // Direct match
  if (TRACK_CODES[cleanTrack]) {
    return TRACK_CODES[cleanTrack];
  }
  
  // Try with common prefix/suffix removal
  const simplifiedTrack = cleanTrack
    .replace(/racecourse$/, '')
    .replace(/\(aw\)$/, '')
    .replace(/\(all weather\)$/, '')
    .replace(/\(gb\)$/, '')
    .replace(/\(ire\)$/, '')
    .replace(/\(usa\)$/, '')
    .replace(/\s+/g, '')
    .trim();
  
  for (const [track, id] of Object.entries(TRACK_CODES)) {
    const simplifiedKey = track
      .replace(/\s+/g, '')
      .trim();
    
    if (simplifiedKey === simplifiedTrack) {
      return id;
    }
  }
  
  // Try partial match as last resort
  for (const [track, id] of Object.entries(TRACK_CODES)) {
    if (track.includes(cleanTrack) || cleanTrack.includes(track)) {
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
    const safeTrackName = trackName.replace(/\s+/g, '_');
    
    // Basic params - date is required
    const params = {
      start_date: date,
    };
    
    // Only add course ID if available
    if (courseId) {
      params.course = courseId; // Single string, not an array
    } else {
      // Try to guess the region if no course ID
      if (trackName.toLowerCase().includes('(ire)')) {
        params.region = 'ire';
      } else if (trackName.toLowerCase().includes('(aus)')) {
        params.region = 'aus';
      } else if (trackName.toLowerCase().includes('(usa)')) {
        params.region = 'usa';
      } else {
        // Default to GB for most UK tracks
        params.region = 'gb';
      }
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
    const trackName = race.course || race.course_id || '';
    const cleanTrack = cleanName(trackName);
    
    if (isSimilarTrack(cleanTrack, cleanTargetTrack)) {
      console.log(`Found matching track: "${trackName}" for "${targetTrack}"`);
      
      // Process each runner in the race
      if (race.runners && Array.isArray(race.runners)) {
        race.runners.forEach(runner => {
          horses.push({
            horse_name: runner.horse || runner.name,
            track_name: trackName,
            position: runner.position || runner.finish_position,
            sp: runner.sp_dec || runner.sp || null,
            bsp: runner.bsp || null,
            ovr_btn: runner.ovr_btn || runner.btn || '0',
            btn: runner.btn || '0',
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
  
  console.log(`Found ${horses.length} horses for ${targetTrack}`);
  
  // Save extracted horses if we found any
  if (horses.length > 0) {
    fs.writeFileSync(
      `${targetTrack.replace(/\s+/g, '_')}_horses.json`,
      JSON.stringify(horses, null, 2)
    );
  }
  
  return horses;
}

// Process a single bet
async function processSingleBet(bet, horses) {
  console.log(`Processing bet: ${bet.id} - ${bet.horse_name}`);
  
  if (!bet.horse_name) {
    console.log(`Skipping bet ID ${bet.id} - missing horse name`);
    return false;
  }
  
  // Find horse in results
  const horseResult = findHorseMatch(bet.horse_name, horses);
  
  if (!horseResult) {
    console.log(`No match found for ${bet.horse_name}`);
    return false;
  }
  
  console.log(`MATCH: ${bet.horse_name} → ${horseResult.horse_name} (Position: ${horseResult.position})`);
  
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
  
  // Update bet in Supabase
  const { error } = await supabase
    .from('racing_bets')
    .update({
      status: status,
      returns: returns,
      profit_loss: profitLoss,
      sp_industry: horseResult.sp || null,
      ovr_btn: numericOvrBtn, // Store as numeric
      closing_line_value: calculateCLV(bet, horseResult),
      clv_stake: calculateCLVStake(bet, horseResult),
      fin_pos: horseResult.position || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', bet.id);
  
  if (error) {
    console.error(`Error updating bet ID ${bet.id}:`, error.message);
    return false;
  }
  
  console.log(`Updated bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}`);
  return true;
}

// Process a multiple bet
async function processMultipleBet(bet) {
  const selections = bet.horse_name.split('/').map(s => s.trim());
  const trackNames = bet.track_name ? bet.track_name.split('/').map(t => t.trim()) : [];
  
  console.log(`Processing multiple bet with ${selections.length} selections: ${selections.join(', ')}`);
  
  // Find all horses in results
  const horseResults = [];
  
  for (let i = 0; i < selections.length; i++) {
    const horseName = selections[i];
    const trackName = trackNames[i] || trackNames[0] || bet.track_name;
    const date = bet.race_date.split('T')[0];
    
    // Get the correct track horses from cache
    const cacheKey = `${trackName}:${date}`;
    const trackHorses = trackHorsesCache[cacheKey] || [];
    
    if (trackHorses.length === 0) {
      console.log(`No horses found for ${trackName} on ${date} for horse ${horseName}`);
      return false;
    }
    
    // Find this horse in the relevant track results
    const horseResult = findHorseMatch(horseName, trackHorses);
    
    if (!horseResult) {
      console.log(`No match found for ${horseName} at ${trackName}`);
      return false;
    }
    
    horseResults.push(horseResult);
  }
  
  console.log(`Found all ${selections.length} horses in multiple bet`);
  
  // Check if all horses won (for calculating returns)
  const allWon = horseResults.every(hr => parseInt(hr.position) === 1);
  
  // Format data for display (string format with slashes)
  const positionsFormatted = horseResults.map(hr => hr.position).join(' / ');
  const spFormatted = horseResults.map(hr => hr.sp || '0').join(' / ');
  
  // Calculate numeric values (for database)
  let combinedOvrBtn = 0;
  horseResults.forEach((hr, index) => {
    const numValue = extractNumericValue(hr.ovr_btn);
    if (index === 0) {
      combinedOvrBtn = numValue;
    } else {
      // For multiple horses, average the beaten distances
      combinedOvrBtn = (combinedOvrBtn + numValue) / 2;
    }
  });
  
  // For BSP calculations
  let combinedBSP = 1;
  let allHaveBSP = true;
  
  for (const hr of horseResults) {
    if (!hr.bsp || hr.bsp <= 0) {
      allHaveBSP = false;
      break;
    }
    combinedBSP *= parseFloat(hr.bsp);
  }
  
  if (!allHaveBSP) combinedBSP = null;
  
  // Determine bet result
  let status = 'Lost';
  if ((bet.bet_type === 'win' || bet.bet_type === 'double' || bet.bet_type === 'treble' || 
       bet.bet_type === 'accumulator' || !bet.bet_type) && allWon) {
    status = 'Won';
  }
  
  // Calculate returns
  const returns = status === 'Won' ? bet.stake * bet.odds : 0;
  const profitLoss = returns - bet.stake;
  
  // Update bet in Supabase
  const { error } = await supabase
    .from('racing_bets')
    .update({
      status: status,
      returns: returns,
      profit_loss: profitLoss,
      sp_industry: spFormatted, // This can be string formatted
      ovr_btn: combinedOvrBtn, // This must be numeric
      closing_line_value: allHaveBSP ? calculateCLVForMultiple(bet, combinedBSP) : null,
      clv_stake: allHaveBSP ? calculateCLVStakeForMultiple(bet, combinedBSP) : null,
      fin_pos: positionsFormatted, // This can be string formatted
      updated_at: new Date().toISOString()
    })
    .eq('id', bet.id);
  
  if (error) {
    console.error(`Error updating multiple bet ID ${bet.id}:`, error.message);
    return false;
  }
  
  console.log(`Updated multiple bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}`);
  return true;
}

// Find horse match in results (we already filtered by track)
function findHorseMatch(horseName, horses) {
  if (!horseName || !horses || horses.length === 0) return null;
  
  const cleanHorse = cleanHorseName(horseName);
  const simplifiedHorse = simplifyHorseName(horseName);
  
  // Matching strategies in order of priority
  
  // 1. Exact name match
  const exactMatch = horses.find(h => 
    cleanHorseName(h.horse_name) === cleanHorse
  );
  
  if (exactMatch) {
    return exactMatch;
  }
  
  // 2. Simplified name match (no spaces or special chars)
  const simplifiedMatch = horses.find(h => 
    h.simplified_name === simplifiedHorse
  );
  
  if (simplifiedMatch) {
    return simplifiedMatch;
  }
  
  // 3. Partial name match
  const partialMatch = horses.find(h => {
    const horseNameClean = cleanHorseName(h.horse_name);
    return horseNameClean.includes(cleanHorse) || cleanHorse.includes(horseNameClean);
  });
  
  if (partialMatch) {
    return partialMatch;
  }
  
  // 4. Fuzzy match - Levenshtein distance
  const fuzzyMatch = findClosestMatch(cleanHorse, horses);
  
  if (fuzzyMatch) {
    return fuzzyMatch;
  }
  
  return null;
}

// Find the closest match using Levenshtein distance
function findClosestMatch(horseName, horses) {
  if (!horseName || !horses || !horses.length) return null;
  
  // Levenshtein distance
  function levenshtein(a, b) {
    const matrix = [];
    
    // Initialize matrix
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    
    // Fill matrix
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
  
  for (const horse of horses) {
    const distance = levenshtein(horseName, cleanHorseName(horse.horse_name));
    
    // Consider good match if distance is less than 30% of name length
    const threshold = Math.max(3, Math.floor(horseName.length * 0.3));
    
    if (distance < threshold && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = horse;
    }
  }
  
  return bestMatch;
}

// Check if two track names are similar
function isSimilarTrack(track1, track2) {
  if (!track1 || !track2) return false;
  
  // Exact match
  if (track1 === track2) return true;
  
  // Partial match
  if (track1.includes(track2) || track2.includes(track1)) return true;
  
  // Split track names and check parts
  const parts1 = track1.split(/[ -]/);
  const parts2 = track2.split(/[ -]/);
  
  // Check if any significant part matches
  for (const part1 of parts1) {
    if (part1.length > 3) { 
      for (const part2 of parts2) {
        if (part2.length > 3 && part1 === part2) return true;
      }
    }
  }
  
  return false;
}

// Helper functions
function cleanHorseName(name) {
  if (!name) return '';
  // Remove country codes like (GB), (IRE), etc.
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
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const numericStr = value.replace(/[^0-9.]/g, '');
    if (numericStr === '') return 0;
    return parseFloat(numericStr);
  }
  return null;
}

// Determine bet result (win, place, loss)
function determineBetResult(horseResult, betType, numRunners) {
  if (!horseResult || !horseResult.position) return null;
  
  const position = parseInt(horseResult.position, 10);
  if (isNaN(position)) return 'void';
  
  // Win bet logic
  if (betType === 'win' || betType === 'single') {
    return position === 1 ? 'win' : 'loss';
  }
  
  // Place bet logic
  if (betType === 'place') {
    if (numRunners <= 7) return position <= 2 ? 'place' : 'loss';
    if (numRunners <= 12) return position <= 3 ? 'place' : 'loss';
    if (numRunners <= 19) return position <= 4 ? 'place' : 'loss';
    return position <= 5 ? 'place' : 'loss';
  }
  
  // Each-way bet logic
  if (betType === 'each-way') {
    if (position === 1) return 'win-place';
    if ((numRunners <= 7 && position <= 2) ||
        (numRunners <= 12 && position <= 3) ||
        (numRunners <= 19 && position <= 4) ||
        (numRunners >= 20 && position <= 5)) {
      return 'place';
    }
    return 'loss';
  }
  
  return null;
}

// Calculate returns based on bet result
function calculateReturns(bet, result, horseResult, numRunners) {
  if (!result || result === 'loss' || result === 'void') return 0;
  
  const isEachWay = bet.each_way === true;
  
  // Win bets
  if ((bet.bet_type === 'win' || bet.bet_type === 'single' || !bet.bet_type) && result === 'win') {
    return bet.stake * bet.odds;
  }
  
  // Place bets
  if (bet.bet_type === 'place' && result === 'place') {
    let placeOdds;
    
    if (numRunners <= 7) placeOdds = (bet.odds - 1) / 4 + 1;
    else if (numRunners <= 12) placeOdds = (bet.odds - 1) / 5 + 1;
    else if (numRunners <= 19) placeOdds = (bet.odds - 1) / 5 + 1;
    else placeOdds = (bet.odds - 1) / 6 + 1;
    
    return bet.stake * placeOdds;
  }
  
  // Each-way bets
  if (isEachWay) {
    let returns = 0;
    let placeOdds;
    
    if (numRunners <= 7) placeOdds = (bet.odds - 1) / 4 + 1;
    else if (numRunners <= 12) placeOdds = (bet.odds - 1) / 5 + 1;
    else if (numRunners <= 19) placeOdds = (bet.odds - 1) / 5 + 1;
    else placeOdds = (bet.odds - 1) / 6 + 1;
    
    if (result === 'win-place') {
      returns += (bet.stake / 2) * bet.odds; // Win part
      returns += (bet.stake / 2) * placeOdds; // Place part
    } else if (result === 'place') {
      returns += (bet.stake / 2) * placeOdds; // Only place part wins
    }
    
    return returns;
  }
  
  return 0;
}

// Calculate CLV
function calculateCLV(bet, horseResult) {
  if (!horseResult.bsp || horseResult.bsp <= 0) return null;
  
  const bspOdds = parseFloat(horseResult.bsp);
  const betOdds = parseFloat(bet.odds);
  
  if (isNaN(bspOdds) || isNaN(betOdds)) return null;
  
  const clv = (betOdds / bspOdds - 1) * 100;
  return Math.round(clv * 100) / 100;
}

// Calculate CLV Stake
function calculateCLVStake(bet, horseResult) {
  const clv = calculateCLV(bet, horseResult);
  if (clv === null) return null;
  
  return Math.round((clv * bet.stake / 100) * 100) / 100;
}

// Multiple bet CLV
function calculateCLVForMultiple(bet, combinedBSP) {
  if (!combinedBSP || combinedBSP <= 0) return null;
  
  const betOdds = parseFloat(bet.odds);
  if (isNaN(betOdds)) return null;
  
  const clv = (betOdds / combinedBSP - 1) * 100;
  return Math.round(clv * 100) / 100;
}

// Multiple bet CLV Stake
function calculateCLVStakeForMultiple(bet, combinedBSP) {
  const clv = calculateCLVForMultiple(bet, combinedBSP);
  if (clv === null) return null;
  
  return Math.round((clv * bet.stake / 100) * 100) / 100;
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