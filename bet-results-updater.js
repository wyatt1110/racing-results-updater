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
  auth: { username: racingApiUsername, password: racingApiPassword }
});

// Sleep function for delay between API calls
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Track codes map (hardcoded for simplicity)
const TRACK_CODES = {
  'catterick': 'crs_19734',
  'nottingham': 'crs_38742',
  'leopardstown': 'crs_32789',
  'kempton': 'crs_29348',
  'taunton': 'crs_23985'
};

// Main function to update bet results
async function updateBetResults() {
  console.log('Starting bet results update process...');
  console.log(`Using Supabase URL: ${supabaseUrl.substring(0, 20)}...`);
  
  try {
    // Check status values for debugging
    const { data: statusCheck, error: statusError } = await supabase
      .from('racing_bets')
      .select('status')
      .limit(50);
    
    if (statusError) {
      console.log(`Error checking status values: ${statusError.message}`);
    } else {
      const uniqueStatuses = [...new Set(statusCheck.map(b => b.status))];
      console.log(`Found these status values in the database: ${JSON.stringify(uniqueStatuses)}`);
    }
    
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
    
    // Log a sample bet
    console.log(`Sample pending bet: ${JSON.stringify(pendingBets[0], null, 2)}`);
    
    // Group bets by track and date
    const trackDateGroups = groupBetsByTrackAndDate(pendingBets);
    
    // Print tracks we need to process
    const uniqueTracks = Object.keys(trackDateGroups);
    console.log(`Found ${uniqueTracks.length} unique tracks to process: ${uniqueTracks.join(', ')}`);
    
    // Results storage
    const results = {
      total: pendingBets.length,
      updated: 0,
      noMatch: 0,
      errors: 0
    };
    
    // Process each track with a separate API call
    for (const [track, dateGroups] of Object.entries(trackDateGroups)) {
      for (const [date, bets] of Object.entries(dateGroups)) {
        console.log(`\nProcessing track: ${track}, date: ${date}, bets: ${bets.length}`);
        
        // Get course ID for this track
        const courseId = TRACK_CODES[track.toLowerCase()] || null;
        if (courseId) {
          console.log(`Found course ID for ${track}: ${courseId}`);
        } else {
          console.log(`No course ID found for ${track}, will use track name only`);
        }
        
        // Fetch results for this track and date
        const horses = await fetchTrackResults(track, courseId, date);
        
        if (horses.length === 0) {
          console.log(`No horses found for ${track} on ${date}, skipping ${bets.length} bets`);
          results.noMatch += bets.length;
          continue;
        }
        
        console.log(`Found ${horses.length} horses for ${track} on ${date}`);
        
        // Log a few sample horses
        if (horses.length > 0) {
          console.log('Sample horses:');
          horses.slice(0, 3).forEach(h => {
            console.log(`- ${h.horse_name} (Position: ${h.position})`);
          });
        }
        
        // Process each bet for this track/date
        for (const bet of bets) {
          try {
            // Process the bet
            const isMultiple = bet.horse_name && bet.horse_name.includes('/');
            const success = isMultiple 
              ? await processMultipleBet(bet, horses)
              : await processSingleBet(bet, horses);
              
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
        
        // Wait before next API call
        if (Object.keys(trackDateGroups).length > 1) {
          console.log('Waiting 15 seconds before next API call...');
          await sleep(15000);
        }
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

// Group bets by track and date
function groupBetsByTrackAndDate(bets) {
  const groups = {};
  
  bets.forEach(bet => {
    if (!bet.track_name || !bet.race_date) return;
    
    // Handle multiple bets (with multiple tracks)
    if (bet.horse_name && bet.horse_name.includes('/') && bet.track_name.includes('/')) {
      const horses = bet.horse_name.split('/').map(h => h.trim());
      const tracks = bet.track_name.split('/').map(t => t.trim());
      
      // If number of horses and tracks match, treat as separate bets for API calls
      if (horses.length === tracks.length) {
        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          const date = bet.race_date.split('T')[0];
          
          if (!groups[track]) groups[track] = {};
          if (!groups[track][date]) groups[track][date] = [];
          groups[track][date].push(bet);
        }
      } else {
        // If they don't match, just use the first track
        const track = tracks[0];
        const date = bet.race_date.split('T')[0];
        
        if (!groups[track]) groups[track] = {};
        if (!groups[track][date]) groups[track][date] = [];
        groups[track][date].push(bet);
      }
    } else {
      // Single bets
      const track = bet.track_name.trim();
      const date = bet.race_date.split('T')[0];
      
      if (!groups[track]) groups[track] = {};
      if (!groups[track][date]) groups[track][date] = [];
      groups[track][date].push(bet);
    }
  });
  
  return groups;
}

// Fetch results for a specific track and date
async function fetchTrackResults(trackName, courseId, date) {
  console.log(`Fetching results for track: ${trackName}, date: ${date}`);
  
  try {
    // Build the API request options
    let params = { 
      start_date: date,
      end_date: date
    };
    
    // Add course ID if available
    if (courseId) {
      params.course = [courseId];
    }
    
    const requestUrl = `/results?${new URLSearchParams(params).toString()}`;
    console.log(`API Request: ${requestUrl}`);
    
    // Make the API call
    const response = await racingApi.get('/results', { params });
    
    // Save raw response for debugging
    const outputFile = `${trackName.replace(/\s+/g, '_')}_${date}_response.json`;
    fs.writeFileSync(outputFile, JSON.stringify(response.data, null, 2));
    console.log(`Saved raw API response to ${outputFile}`);
    
    // Extract horse data
    const horses = extractHorsesFromResponse(response.data, trackName);
    
    if (horses.length === 0) {
      console.log(`No horses found in response, trying alternative endpoints...`);
      
      // Try cards endpoint
      try {
        const cardsResponse = await racingApi.get('/cards', { 
          params: { date }
        });
        
        const cardsOutputFile = `${trackName.replace(/\s+/g, '_')}_${date}_cards_response.json`;
        fs.writeFileSync(cardsOutputFile, JSON.stringify(cardsResponse.data, null, 2));
        
        const cardsHorses = extractHorsesFromResponse(cardsResponse.data, trackName);
        if (cardsHorses.length > 0) {
          console.log(`Found ${cardsHorses.length} horses from cards endpoint`);
          return cardsHorses;
        }
      } catch (err) {
        console.log(`Cards endpoint failed: ${err.message}`);
      }
    }
    
    return horses;
    
  } catch (error) {
    console.error(`Error fetching results for ${trackName} on ${date}:`, error.message);
    if (error.response) {
      console.error(`API Status: ${error.response.status}`);
      if (error.response.data) {
        console.error(`API Response: ${JSON.stringify(error.response.data).substring(0, 200)}...`);
      }
    }
    return [];
  }
}

// Extract horses from API response with target track filter
function extractHorsesFromResponse(apiData, targetTrack) {
  const horses = [];
  const cleanTargetTrack = cleanName(targetTrack);
  
  // Recursive function to find horse data
  function findHorses(obj, context = {}) {
    if (!obj || typeof obj !== 'object') return;
    
    // Update context with track info
    if (obj.meeting_name) context.track = obj.meeting_name;
    if (obj.course) context.track = obj.course;
    if (obj.venue) context.track = obj.venue;
    if (obj.track) context.track = obj.track;
    
    // Update context with race info
    if (obj.time) context.time = obj.time;
    if (obj.race_time) context.time = obj.race_time;
    if (obj.race_id) context.race_id = obj.race_id;
    if (obj.id && !context.race_id) context.race_id = obj.id;
    if (obj.race_name) context.race_name = obj.race_name;
    if (obj.name && !context.race_name) context.race_name = obj.name;
    if (obj.runners?.length) context.total_runners = obj.runners.length;
    if (obj.results?.length) context.total_runners = obj.results.length;
    
    // Check if this object is a horse/runner
    if ((obj.horse || obj.name) && 
        (obj.position !== undefined || obj.finish_position !== undefined)) {
      
      const trackName = context.track || targetTrack;
      const cleanTrack = cleanName(trackName);
      
      // Only include horses from the target track
      if (isSimilarTrack(cleanTrack, cleanTargetTrack)) {
        horses.push({
          horse_name: obj.horse || obj.name,
          track_name: trackName,
          position: obj.position || obj.finish_position,
          sp: obj.sp_dec || obj.sp || null,
          bsp: obj.bsp || null,
          ovr_btn: obj.ovr_btn || obj.btn || '0',
          btn: obj.btn || '0',
          race_time: context.time || '',
          race_id: context.race_id || '',
          race_name: context.race_name || '',
          total_runners: context.total_runners || 0,
          simplified_name: simplifyHorseName(obj.horse || obj.name || '')
        });
      }
      return;
    }
    
    // Process arrays
    if (Array.isArray(obj)) {
      obj.forEach(item => findHorses(item, {...context}));
      return;
    }
    
    // Process object properties
    for (const [key, value] of Object.entries(obj)) {
      findHorses(value, {...context});
    }
  }
  
  findHorses(apiData);
  
  if (horses.length > 0) {
    console.log(`Found ${horses.length} horses for ${targetTrack}`);
    
    // Save horses to file for debugging
    const outputFile = `${targetTrack.replace(/\s+/g, '_')}_horses.json`;
    fs.writeFileSync(outputFile, JSON.stringify(horses, null, 2));
  } else {
    console.log(`No horses found for ${targetTrack}`);
  }
  
  return horses;
}

// Process a single bet
async function processSingleBet(bet, horses) {
  console.log(`\nProcessing bet ID: ${bet.id}`);
  console.log(`Horse: ${bet.horse_name}, Track: ${bet.track_name}`);
  
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
  
  console.log(`MATCH FOUND: ${bet.horse_name} → ${horseResult.horse_name} (Position: ${horseResult.position})`);
  
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
  
  console.log(`Successfully updated bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}`);
  return true;
}

// Process a multiple bet
async function processMultipleBet(bet, horses) {
  const selections = bet.horse_name.split('/').map(s => s.trim());
  const trackNames = bet.track_name ? bet.track_name.split('/').map(t => t.trim()) : [];
  
  console.log(`Processing multiple bet with ${selections.length} selections: ${selections.join(', ')}`);
  
  // Find all horses in results
  const horseResults = [];
  
  for (let i = 0; i < selections.length; i++) {
    // We already filtered by track, so just match by horse name
    const horseResult = findHorseMatch(selections[i], horses);
    
    if (!horseResult) {
      console.log(`No match found for ${selections[i]}`);
      return false;
    }
    
    horseResults.push(horseResult);
  }
  
  console.log(`Found all ${selections.length} horses in multiple bet`);
  
  // Check if all horses won
  const allWon = horseResults.every(hr => parseInt(hr.position) === 1);
  
  // Format data for update
  const positionsFormatted = horseResults.map(hr => hr.position).join(' / ');
  const ovrBtnFormatted = horseResults.map(hr => extractNumericValue(hr.ovr_btn) || '0').join(' / ');
  const spFormatted = horseResults.map(hr => hr.sp || '0').join(' / ');
  
  // Calculate combined BSP
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
  if ((bet.bet_type === 'win' || !bet.bet_type) && allWon) status = 'Won';
  
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
      sp_industry: spFormatted,
      ovr_btn: ovrBtnFormatted,
      closing_line_value: allHaveBSP ? calculateCLVForMultiple(bet, combinedBSP) : null,
      clv_stake: allHaveBSP ? calculateCLVStakeForMultiple(bet, combinedBSP) : null,
      fin_pos: positionsFormatted,
      updated_at: new Date().toISOString()
    })
    .eq('id', bet.id);
  
  if (error) {
    console.error(`Error updating multiple bet ID ${bet.id}:`, error.message);
    return false;
  }
  
  console.log(`Successfully updated multiple bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}`);
  return true;
}

// Find horse match in results (we already filtered by track)
function findHorseMatch(horseName, horses) {
  if (!horseName || !horses || horses.length === 0) return null;
  
  const cleanHorse = cleanHorseName(horseName);
  const simplifiedHorse = simplifyHorseName(horseName);
  
  console.log(`Looking for horse: "${cleanHorse}"`);
  
  // Matching strategies in order of priority
  
  // 1. Exact name match
  const exactMatch = horses.find(h => 
    cleanHorseName(h.horse_name) === cleanHorse
  );
  
  if (exactMatch) {
    console.log(`MATCH FOUND: Exact match for "${horseName}", position: ${exactMatch.position}`);
    return exactMatch;
  }
  
  // 2. Simplified name match (no spaces or special chars)
  const simplifiedMatch = horses.find(h => 
    h.simplified_name === simplifiedHorse
  );
  
  if (simplifiedMatch) {
    console.log(`MATCH FOUND: Simplified name match "${horseName}" → "${simplifiedMatch.horse_name}", position: ${simplifiedMatch.position}`);
    return simplifiedMatch;
  }
  
  // 3. Partial name match
  const partialMatch = horses.find(h => {
    const horseNameClean = cleanHorseName(h.horse_name);
    return horseNameClean.includes(cleanHorse) || cleanHorse.includes(horseNameClean);
  });
  
  if (partialMatch) {
    console.log(`MATCH FOUND: Partial match for "${horseName}" → "${partialMatch.horse_name}", position: ${partialMatch.position}`);
    return partialMatch;
  }
  
  // 4. Fuzzy match - Levenshtein distance
  const fuzzyMatch = findClosestMatch(cleanHorse, horses);
  
  if (fuzzyMatch) {
    console.log(`MATCH FOUND: Fuzzy match for "${horseName}" → "${fuzzyMatch.horse_name}", position: ${fuzzyMatch.position}`);
    return fuzzyMatch;
  }
  
  // Show all horses for debugging
  console.log(`Available horses (showing first 10):`);
  horses.slice(0, 10).forEach(h => {
    console.log(`- ${h.horse_name} (position: ${h.position})`);
  });
  
  console.log(`NO MATCH: Horse "${horseName}" not found`);
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
  
  if (bestMatch) {
    console.log(`Fuzzy match found with distance ${bestDistance}`);
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