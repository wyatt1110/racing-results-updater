require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');

// Configuration with fallback values and multiple environment variable checks
const supabaseUrl = process.env.SUPABASE_URL || 
                   process.env.NEXT_PUBLIC_SUPABASE_URL || 
                   'https://gwvnmzfpnuwxcqtewbtl.supabase.co';

const supabaseKey = process.env.SUPABASE_KEY || 
                   process.env.SUPABASE_SERVICE_ROLE_KEY || 
                   process.env.SUPABASE_ANON_KEY ||
                   'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3dm5temZwbnV3eGNxdGV3YnRsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcwOTc1NDY3MCwiZXhwIjoyMDI1MzMwNjcwfQ.uZCQGcFm1mGSrKAcqbfgVx-YsNWlb-4iKLwRH5GQaRY';

const racingApiUsername = process.env.RACING_API_USERNAME || 'KQ9W7rQeAHWMUgxH93ie3yEc';
const racingApiPassword = process.env.RACING_API_PASSWORD || 'T5BoPivL3Q2h6RhCdLv4EwZu';
const racingApiBase = 'https://api.theracingapi.com/v1';

// Initialize Supabase client
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  }
});

// Create axios instance with authentication
const racingApi = axios.create({
  baseURL: racingApiBase,
  auth: {
    username: racingApiUsername,
    password: racingApiPassword
  }
});

// Helper functions
const standardizeDate = (dateString) => {
  const date = new Date(dateString);
  return date.toISOString().split('T')[0];
};

const cleanHorseName = (name) => {
  if (!name) return '';
  return name.toLowerCase().trim();
};

// Main function to update bet results
async function updateBetResults() {
  console.log('Starting bet results update process...');
  console.log(`Using Supabase URL: ${supabaseUrl.substring(0, 20)}...`);
  
  try {
    // First, let's check all status values to debug
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
    
    // Fetch pending bets using case-insensitive matching for greater flexibility
    let { data: pendingBets, error: betsError } = await supabase
      .from('racing_bets')
      .select('*')
      .or('status.ilike.%pending%,status.ilike.%open%,status.eq.new,status.eq.,status.eq.PENDING,status.eq.Pending');
    
    if (betsError) {
      throw new Error(`Error fetching pending bets: ${betsError.message}`);
    }
    
    console.log(`Found ${pendingBets ? pendingBets.length : 0} pending bets to process`);
    
    if (!pendingBets || pendingBets.length === 0) {
      console.log('No pending bets found to update.');
      return { success: true, updated: 0, total: 0 };
    }
    
    // Debug: Log the first bet to see field structure
    console.log(`Sample pending bet: ${JSON.stringify(pendingBets[0], null, 2)}`);
    
    // Fetch race results for each specific track rather than all at once
    const processedTracks = new Set();
    const tracksData = {};
    
    // Get all unique tracks from bets to minimize API calls
    const uniqueTracks = new Set();
    pendingBets.forEach(bet => {
      if (bet.track_name) {
        if (bet.track_name.includes('/')) {
          // Handle multiple tracks in one bet
          bet.track_name.split('/').forEach(track => uniqueTracks.add(track.trim()));
        } else {
          uniqueTracks.add(bet.track_name.trim());
        }
      }
    });
    
    console.log(`Found ${uniqueTracks.size} unique tracks to process: ${[...uniqueTracks].join(', ')}`);
    
    // First try to get results for all tracks at once
    const allResults = await fetchTodaysResultsRaw();
    if (!allResults) {
      console.log('Failed to fetch all results, nothing to update');
      return { success: true, updated: 0, total: pendingBets.length };
    }
    
    // Debug: Directly inspect the results structure
    console.log('Inspecting raw results structure...');
    
    // Check if we have the expected result structure
    if (!allResults.results || !Array.isArray(allResults.results)) {
      console.log('Unexpected API results structure, no results array found');
      return { success: true, updated: 0, total: pendingBets.length };
    }
    
    console.log(`API returned ${allResults.results.length} meetings/items`);
    
    // Inspect the first result to understand structure
    if (allResults.results.length > 0) {
      const firstResult = allResults.results[0];
      console.log('First result keys:', Object.keys(firstResult));
      
      // Try to find all possible race data paths
      if (firstResult.races) {
        console.log(`Found races array with ${firstResult.races.length} items at .races`);
        
        if (firstResult.races.length > 0) {
          const firstRace = firstResult.races[0];
          console.log('First race keys:', Object.keys(firstRace));
          
          if (firstRace.runners) {
            console.log(`Found runners array with ${firstRace.runners.length} items at .races[].runners`);
            
            if (firstRace.runners.length > 0) {
              console.log('First runner keys:', Object.keys(firstRace.runners[0]));
            }
          }
        }
      }
      
      // Try a different path
      if (firstResult.data && firstResult.data.races) {
        console.log(`Found races array with ${firstResult.data.races.length} items at .data.races`);
      }
      
      // Log a small sample of the first result for debugging
      try {
        const sampleJson = JSON.stringify(firstResult).substring(0, 1000);
        console.log('Sample of first result:', sampleJson + '...');
      } catch (e) {
        console.log('Error stringifying first result:', e.message);
      }
    }
    
    // Extract all horse results and flatten into a searchable structure
    const allHorses = [];
    
    console.log('Attempting to extract horse data from all possible locations...');
    
    // Try multiple path patterns to find horses
    for (const result of allResults.results) {
      const trackName = result.meeting_name || result.course || result.venue || '';
      console.log(`Processing meeting: ${trackName}`);
      
      // Path 1: Direct races array
      let foundHorses = false;
      
      if (result.races && Array.isArray(result.races)) {
        console.log(`Found ${result.races.length} races in direct .races array`);
        
        for (const race of result.races) {
          // Try to get runners
          if (race.runners && Array.isArray(race.runners)) {
            console.log(`Found ${race.runners.length} runners for race ${race.race_name || race.name || ''}`);
            
            foundHorses = processHorseResults(allHorses, race.runners, trackName, race);
          }
        }
      }
      
      // Path 2: Data.races
      if (!foundHorses && result.data && result.data.races && Array.isArray(result.data.races)) {
        console.log(`Found ${result.data.races.length} races in .data.races array`);
        
        for (const race of result.data.races) {
          // Try to get runners
          if (race.runners && Array.isArray(race.runners)) {
            console.log(`Found ${race.runners.length} runners for race ${race.race_name || race.name || ''}`);
            
            foundHorses = processHorseResults(allHorses, race.runners, trackName, race);
          }
        }
      }
      
      // Path 3: Results
      if (!foundHorses && result.results && Array.isArray(result.results)) {
        console.log(`Found ${result.results.length} races in .results array`);
        
        for (const race of result.results) {
          // Try to get runners
          if (race.runners && Array.isArray(race.runners)) {
            console.log(`Found ${race.runners.length} runners for race ${race.race_name || race.name || ''}`);
            
            foundHorses = processHorseResults(allHorses, race.runners, trackName, race);
          }
        }
      }
      
      // Recursively search for any arrays that might contain horse data
      if (!foundHorses) {
        console.log('No horses found through standard paths, performing deep search...');
        deepSearchForHorses(result, allHorses, trackName);
      }
    }
    
    // Log the number of horses we found
    console.log(`Found a total of ${allHorses.length} horse results`);
    
    // Save the extracted horses for debugging
    try {
      fs.writeFileSync('all_horses_extracted.json', JSON.stringify(allHorses, null, 2));
      console.log('Saved all extracted horse data to all_horses_extracted.json');
    } catch (err) {
      console.log('Failed to save horses json:', err.message);
    }
    
    // If we found no horses, we can't update anything
    if (allHorses.length === 0) {
      console.log('No horse results found, nothing to update');
      return { success: true, updated: 0, total: pendingBets.length };
    }
    
    // Process each pending bet
    let updatedCount = 0;
    let foundMatchCount = 0;
    let noMatchCount = 0;
    let errorCount = 0;
    
    for (const bet of pendingBets) {
      try {
        console.log(`\nProcessing bet ID: ${bet.id}`);
        console.log(`Horse: ${bet.horse_name || 'N/A'}, Track: ${bet.track_name || 'N/A'}`);
        
        // Check if this is a multiple bet (contains '/' in horse_name)
        if (bet.horse_name && bet.horse_name.includes('/')) {
          const matchFound = await processMultipleBet(bet, allHorses);
          if (matchFound) {
            updatedCount++;
            foundMatchCount++;
          } else {
            noMatchCount++;
          }
        } else {
          const matchFound = await processSingleBet(bet, allHorses);
          if (matchFound) {
            updatedCount++;
            foundMatchCount++;
          } else {
            noMatchCount++;
          }
        }
      } catch (betError) {
        console.error(`Error processing bet ID ${bet.id}:`, betError);
        errorCount++;
      }
    }
    
    console.log(`\nResults Summary:`);
    console.log(`- Total bets processed: ${pendingBets.length}`);
    console.log(`- Matches found and updated: ${foundMatchCount}`);
    console.log(`- No matches found: ${noMatchCount}`);
    console.log(`- Errors encountered: ${errorCount}`);
    
    return { 
      success: true, 
      updated: updatedCount, 
      total: pendingBets.length,
      matches: foundMatchCount,
      noMatches: noMatchCount,
      errors: errorCount
    };
    
  } catch (error) {
    console.error('Error in updateBetResults:', error);
    return { success: false, error: error.message };
  }
}

// Process horse results from runners array and add to allHorses array
function processHorseResults(allHorses, runners, trackName, race) {
  if (!runners || runners.length === 0) return false;
  
  let foundAnyHorses = false;
  
  for (const runner of runners) {
    const horseName = runner.horse || runner.name || '';
    if (!horseName) continue;
    
    allHorses.push({
      horse_name: horseName,
      position: runner.position || '',
      bsp: runner.bsp || null,
      sp: runner.sp_dec || runner.sp || null,
      track_name: trackName,
      race_id: race.race_id || race.id || '',
      race_time: race.time || '',
      race_name: race.race_name || race.name || '',
      total_runners: runners.length
    });
    
    foundAnyHorses = true;
  }
  
  return foundAnyHorses;
}

// Recursively search for arrays that might contain horse data
function deepSearchForHorses(obj, allHorses, trackName, depth = 0, path = '') {
  if (depth > 5) return; // Limit recursion depth
  
  // Check if this is an array of objects that might be horses
  if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') {
    // Check if these look like horses
    const sampleObj = obj[0];
    
    if (sampleObj && (sampleObj.horse || sampleObj.name || sampleObj.position)) {
      console.log(`Found potential horse data at path: ${path}, ${obj.length} items`);
      
      // Try to find associated race data
      const raceData = {
        race_id: '',
        race_name: '',
        time: ''
      };
      
      // Process horses
      for (const item of obj) {
        const horseName = item.horse || item.name || '';
        if (!horseName) continue;
        
        allHorses.push({
          horse_name: horseName,
          position: item.position || '',
          bsp: item.bsp || null,
          sp: item.sp_dec || item.sp || null,
          track_name: trackName,
          race_id: raceData.race_id,
          race_time: raceData.time,
          race_name: raceData.race_name,
          total_runners: obj.length
        });
      }
      
      return;
    }
  }
  
  // Recursively search through object properties
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const key of Object.keys(obj)) {
      const newPath = path ? `${path}.${key}` : key;
      deepSearchForHorses(obj[key], allHorses, trackName, depth + 1, newPath);
    }
  }
}

// Fetch today's race results for all tracks
async function fetchTodaysResultsRaw() {
  try {
    console.log('Fetching today\'s race results...');
    
    // Make the API call
    const response = await racingApi.get('/results/today');
    
    // Save the raw response for debugging
    try {
      fs.writeFileSync('results_raw_response.json', JSON.stringify(response.data, null, 2));
      console.log('Saved raw API response to results_raw_response.json');
    } catch (writeError) {
      console.log('Could not save response to file:', writeError.message);
    }
    
    // Check if we have the expected response structure
    if (!response.data) {
      console.log('Invalid API response: no data received');
      return null;
    }
    
    return response.data;
  } catch (error) {
    console.error('Error fetching today\'s race results:', error.message);
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', JSON.stringify(error.response.data || {}).substring(0, 200) + '...');
    }
    return null;
  }
}

// Find a horse in the allHorses array
function findHorseInResults(allHorses, horseName, trackName) {
  if (!horseName) return null;
  
  const cleanHorse = cleanHorseName(horseName);
  const cleanTrack = cleanHorseName(trackName || '');
  
  console.log(`Looking for horse: "${cleanHorse}" at track: "${cleanTrack}"`);
  
  // Try all matching strategies from most specific to least
  
  // 1. Exact match on horse name and track name
  if (cleanTrack) {
    const exactMatch = allHorses.find(horse => 
      cleanHorseName(horse.horse_name) === cleanHorse && 
      cleanHorseName(horse.track_name) === cleanTrack
    );
    
    if (exactMatch) {
      console.log(`MATCH FOUND: Exact match for "${horseName}" at "${trackName}", position: ${exactMatch.position}`);
      return exactMatch;
    }
    
    // 2. Exact horse name, partial track name
    const trackPartialMatch = allHorses.find(horse => 
      cleanHorseName(horse.horse_name) === cleanHorse && 
      (cleanHorseName(horse.track_name).includes(cleanTrack) || 
       cleanTrack.includes(cleanHorseName(horse.track_name)))
    );
    
    if (trackPartialMatch) {
      console.log(`MATCH FOUND: Exact horse match "${horseName}" at similar track "${trackPartialMatch.track_name}", position: ${trackPartialMatch.position}`);
      return trackPartialMatch;
    }
  }
  
  // 3. Partial horse name match with track match
  if (cleanTrack) {
    const partialMatch = allHorses.find(horse => {
      const horseNameClean = cleanHorseName(horse.horse_name);
      const trackNameClean = cleanHorseName(horse.track_name);
      
      return (horseNameClean.includes(cleanHorse) || cleanHorse.includes(horseNameClean)) && 
             (trackNameClean === cleanTrack || 
              trackNameClean.includes(cleanTrack) || 
              cleanTrack.includes(trackNameClean));
    });
    
    if (partialMatch) {
      console.log(`MATCH FOUND: Partial match for "${horseName}" → "${partialMatch.horse_name}" at ${partialMatch.track_name}, position: ${partialMatch.position}`);
      return partialMatch;
    }
  }
  
  // 4. Just match horse name as last resort
  const horseOnlyMatch = allHorses.find(horse => {
    const horseNameClean = cleanHorseName(horse.horse_name);
    return horseNameClean === cleanHorse || 
           horseNameClean.includes(cleanHorse) || 
           cleanHorse.includes(horseNameClean);
  });
  
  if (horseOnlyMatch) {
    console.log(`MATCH FOUND: Horse-only match for "${horseName}" at ${horseOnlyMatch.track_name}, position: ${horseOnlyMatch.position}`);
    return horseOnlyMatch;
  }
  
  // If track matches but no horse match, show all horses at that track
  if (cleanTrack) {
    const horsesAtTrack = allHorses.filter(horse => {
      const trackNameClean = cleanHorseName(horse.track_name);
      return trackNameClean === cleanTrack || 
             trackNameClean.includes(cleanTrack) || 
             cleanTrack.includes(trackNameClean);
    });
    
    if (horsesAtTrack.length > 0) {
      console.log(`Horses at track similar to "${trackName}":`);
      horsesAtTrack.forEach(h => {
        console.log(`- ${h.horse_name} (position: ${h.position})`);
      });
    } else {
      const uniqueTracks = [...new Set(allHorses.map(h => h.track_name))];
      console.log(`No horses found at track: "${trackName}". Available tracks: ${uniqueTracks.join(', ')}`);
    }
  } else {
    // If no track specified, show a sample of horses from all tracks
    const uniqueTracks = [...new Set(allHorses.map(h => h.track_name))];
    console.log(`Available tracks in results: ${uniqueTracks.join(', ')}`);
    
    // Show some sample horse names to help with debugging
    console.log(`Sample of horse names from results (first 10):`);
    allHorses.slice(0, 10).forEach(h => {
      console.log(`- ${h.track_name}: ${h.horse_name} (position: ${h.position})`);
    });
  }
  
  console.log(`NO MATCH: Horse "${horseName}" not found`);
  return null;
}

// Process a single horse bet
async function processSingleBet(bet, allHorses) {
  // Skip if missing essential data
  if (!bet.horse_name) {
    console.log(`Skipping bet ID ${bet.id} - missing horse name`);
    return false;
  }
  
  // Find the horse in the results
  const horseResult = findHorseInResults(allHorses, bet.horse_name, bet.track_name);
  
  if (!horseResult) {
    console.log(`No match found for bet ID ${bet.id}`);
    return false;
  }
  
  // Get number of runners in the race
  const numRunners = parseInt(horseResult.total_runners) || 0;
  console.log(`Race has ${numRunners} runners`);
  
  // Determine if this is an each-way bet
  const isEachWay = bet.each_way === true;
  
  // Determine bet result (win, place, loss)
  const betType = isEachWay ? 'each-way' : (bet.bet_type || 'win');
  const betResult = determineBetResult(horseResult, betType, numRunners);
  
  // Calculate bet returns based on result
  const returns = calculateReturns(bet, betResult, horseResult, numRunners);
  
  // Map betResult to status field value
  let status = 'Pending';
  if (betResult === 'win' || betResult === 'win-place') {
    status = 'Won';
  } else if (betResult === 'place') {
    status = 'Placed';
  } else if (betResult === 'loss') {
    status = 'Lost';
  } else if (betResult === 'void') {
    status = 'Void';
  }
  
  // Calculate profit/loss
  const profitLoss = returns - bet.stake;
  
  // Update the bet in Supabase
  const { error: updateError } = await supabase
    .from('racing_bets')
    .update({
      status: status,
      returns: returns,
      profit_loss: profitLoss,
      sp_industry: horseResult.sp || null,
      ovr_btn: horseResult.bsp || null,
      closing_line_value: calculateCLV(bet, horseResult),
      clv_stake: calculateCLVStake(bet, horseResult),
      fin_pos: horseResult.position || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', bet.id);
  
  if (updateError) {
    throw new Error(`Error updating bet ID ${bet.id}: ${updateError.message}`);
  }
  
  console.log(`Successfully updated bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}, Position: ${horseResult.position}`);
  return true;
}

// Process a multiple bet (horses separated by '/')
async function processMultipleBet(bet, allHorses) {
  // Split selection by '/'
  const selections = bet.horse_name.split('/').map(s => s.trim());
  console.log(`Processing multiple bet with ${selections.length} selections: ${selections.join(', ')}`);
  
  // Split track names if multiple tracks
  const trackNames = bet.track_name ? bet.track_name.split('/').map(t => t.trim()) : [];
  
  // Find all horses in the results
  const horseResults = [];
  
  for (let i = 0; i < selections.length; i++) {
    const selection = selections[i];
    // Get track name (use the corresponding track if available, otherwise use the first one)
    const trackName = trackNames[i] || trackNames[0] || '';
    
    const horseResult = findHorseInResults(allHorses, selection, trackName);
    if (!horseResult) {
      console.log(`No results found for ${selection} at ${trackName || 'any track'}`);
      return false; // Exit if any horse is not found
    }
    horseResults.push(horseResult);
  }
  
  console.log(`Found all ${selections.length} horses in the multiple bet`);
  
  // Check if all horses won (for win bets)
  const allWon = horseResults.every(hr => parseInt(hr.position) === 1);
  
  // Format positions for fin_pos field
  const positionsFormatted = horseResults.map(hr => hr.position).join(' / ');
  
  // Format BSP values for ovr_btn field
  const bspFormatted = horseResults.map(hr => hr.bsp || '0').join(' / ');
  
  // Calculate combined BSP (multiply all BSPs together)
  let combinedBSP = 1;
  let allHaveBSP = true;
  
  for (const hr of horseResults) {
    if (!hr.bsp || hr.bsp <= 0) {
      allHaveBSP = false;
      break;
    }
    combinedBSP *= parseFloat(hr.bsp);
  }
  
  if (!allHaveBSP) {
    combinedBSP = null;
  }
  
  // Format SP values for sp_industry field
  const spFormatted = horseResults.map(hr => hr.sp || '0').join(' / ');
  
  // Determine if this is an each-way bet
  const isEachWay = bet.each_way === true;
  
  // Determine bet result - for multiple bets, all selections must win
  let status = 'Lost';
  if ((bet.bet_type === 'win' || !bet.bet_type) && allWon) {
    status = 'Won';
  }
  
  // Calculate returns
  let returns = 0;
  if (status === 'Won') {
    returns = bet.stake * bet.odds;
  }
  
  // Calculate profit/loss
  const profitLoss = returns - bet.stake;
  
  // Update the bet in Supabase
  const { error: updateError } = await supabase
    .from('racing_bets')
    .update({
      status: status,
      returns: returns,
      profit_loss: profitLoss,
      sp_industry: spFormatted,
      ovr_btn: bspFormatted,
      closing_line_value: allHaveBSP ? calculateCLVForMultiple(bet, combinedBSP) : null,
      clv_stake: allHaveBSP ? calculateCLVStakeForMultiple(bet, combinedBSP) : null,
      fin_pos: positionsFormatted,
      updated_at: new Date().toISOString()
    })
    .eq('id', bet.id);
  
  if (updateError) {
    throw new Error(`Error updating multiple bet ID ${bet.id}: ${updateError.message}`);
  }
  
  console.log(`Successfully updated multiple bet ID: ${bet.id}, Status: ${status}, Returns: ${returns}, Positions: ${positionsFormatted}`);
  return true;
}

// Determine bet result (win, place, loss) based on number of runners
function determineBetResult(horseResult, betType, numRunners) {
  if (!horseResult || !horseResult.position) {
    return null;
  }
  
  const position = parseInt(horseResult.position, 10);
  
  if (isNaN(position)) {
    return 'void'; // Non-runner or void race
  }
  
  // Win bet logic
  if (betType === 'win' || betType === 'single') {
    return position === 1 ? 'win' : 'loss';
  }
  
  // Place bet logic based on number of runners
  if (betType === 'place') {
    // Apply place rules based on number of runners
    if (numRunners <= 7) {
      return position <= 2 ? 'place' : 'loss';
    } else if (numRunners <= 12) { 
      return position <= 3 ? 'place' : 'loss';
    } else if (numRunners <= 19) {
      return position <= 4 ? 'place' : 'loss';
    } else {
      return position <= 5 ? 'place' : 'loss';
    }
  }
  
  // Each-way bet logic
  if (betType === 'each-way') {
    // Win part
    if (position === 1) {
      // Check place part based on number of runners
      if (numRunners <= 7) {
        return 'win-place'; // Win and place (top 2)
      } else if (numRunners <= 12) {
        return 'win-place'; // Win and place (top 3)
      } else if (numRunners <= 19) {
        return 'win-place'; // Win and place (top 4)
      } else {
        return 'win-place'; // Win and place (top 5)
      }
    } 
    // Place part only (no win)
    else if ((numRunners <= 7 && position <= 2) ||
             (numRunners <= 12 && position <= 3) ||
             (numRunners <= 19 && position <= 4) ||
             (numRunners >= 20 && position <= 5)) {
      return 'place';
    } else {
      return 'loss';
    }
  }
  
  return null;
}

// Calculate returns based on bet result and number of runners
function calculateReturns(bet, result, horseResult, numRunners) {
  if (!result || result === 'loss' || result === 'void') {
    return 0;
  }
  
  // Determine if this is an each-way bet
  const isEachWay = bet.each_way === true;
  
  // For win bets
  if ((bet.bet_type === 'win' || bet.bet_type === 'single' || !bet.bet_type) && result === 'win') {
    return bet.stake * bet.odds;
  }
  
  // For place bets - apply different place terms based on runner count
  if (bet.bet_type === 'place' && result === 'place') {
    let placeOdds;
    
    if (numRunners <= 7) {
      // 1/4 odds for 2 places
      placeOdds = (bet.odds - 1) / 4 + 1;
    } else if (numRunners <= 12) {
      // 1/5 odds for 3 places
      placeOdds = (bet.odds - 1) / 5 + 1;
    } else if (numRunners <= 19) {
      // 1/5 odds for 4 places
      placeOdds = (bet.odds - 1) / 5 + 1;
    } else {
      // 1/6 odds for 5 places
      placeOdds = (bet.odds - 1) / 6 + 1;
    }
    
    return bet.stake * placeOdds;
  }
  
  // For each-way bets
  if (isEachWay) {
    let returns = 0;
    let placeOdds;
    
    // Calculate place odds based on number of runners
    if (numRunners <= 7) {
      // 1/4 odds for 2 places
      placeOdds = (bet.odds - 1) / 4 + 1;
    } else if (numRunners <= 12) {
      // 1/5 odds for 3 places
      placeOdds = (bet.odds - 1) / 5 + 1;
    } else if (numRunners <= 19) {
      // 1/5 odds for 4 places
      placeOdds = (bet.odds - 1) / 5 + 1;
    } else {
      // 1/6 odds for 5 places
      placeOdds = (bet.odds - 1) / 6 + 1;
    }
    
    if (result === 'win-place') {
      // Win part
      returns += (bet.stake / 2) * bet.odds;
      // Place part
      returns += (bet.stake / 2) * placeOdds;
    } else if (result === 'place') {
      // Only place part wins
      returns += (bet.stake / 2) * placeOdds;
    }
    
    return returns;
  }
  
  return 0;
}

// Calculate CLV (Closing Line Value)
function calculateCLV(bet, horseResult) {
  if (!horseResult.bsp || horseResult.bsp <= 0) {
    return null;
  }
  
  const bspOdds = parseFloat(horseResult.bsp);
  const betOdds = parseFloat(bet.odds);
  
  if (isNaN(bspOdds) || isNaN(betOdds)) {
    return null;
  }
  
  // CLV formula: (bet_odds / bsp_odds - 1) * 100
  const clv = (betOdds / bspOdds - 1) * 100;
  return Math.round(clv * 100) / 100; // Round to 2 decimal places
}

// Calculate CLV Stake (value captured by stake)
function calculateCLVStake(bet, horseResult) {
  const clv = calculateCLV(bet, horseResult);
  
  if (clv === null) {
    return null;
  }
  
  // CLV Stake = CLV * Stake / 100
  return Math.round((clv * bet.stake / 100) * 100) / 100; // Round to 2 decimal places
}

// Calculate CLV for multiple bets
function calculateCLVForMultiple(bet, combinedBSP) {
  if (!combinedBSP || combinedBSP <= 0) {
    return null;
  }
  
  const betOdds = parseFloat(bet.odds);
  
  if (isNaN(betOdds)) {
    return null;
  }
  
  // CLV formula: (bet_odds / bsp_odds - 1) * 100
  const clv = (betOdds / combinedBSP - 1) * 100;
  return Math.round(clv * 100) / 100; // Round to 2 decimal places
}

// Calculate CLV Stake for multiple bets
function calculateCLVStakeForMultiple(bet, combinedBSP) {
  const clv = calculateCLVForMultiple(bet, combinedBSP);
  
  if (clv === null) {
    return null;
  }
  
  // CLV Stake = CLV * Stake / 100
  return Math.round((clv * bet.stake / 100) * 100) / 100; // Round to 2 decimal places
}

// Run the main function if invoked directly
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