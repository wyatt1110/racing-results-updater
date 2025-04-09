require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');

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

// Main function to update bet results using track-specific API calls
async function updateBetResults() {
  try {
    console.log('Starting track-specific bet results update process...');
    console.log(`Using Supabase URL: ${supabaseUrl.substring(0, 20)}...`);
    
    // Load track codes for course IDs
    let trackCodes;
    try {
      const trackCodesFile = fs.readFileSync('Track-codes-list.json', 'utf8');
      trackCodes = JSON.parse(trackCodesFile);
      console.log(`Loaded ${trackCodes.course_list?.length || 0} track codes`);
    } catch (err) {
      console.error('Failed to load track codes:', err.message);
      trackCodes = { course_list: [] };
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
    
    // Debug: Log a sample bet
    console.log(`Sample pending bet: ${JSON.stringify(pendingBets[0], null, 2)}`);
    
    // Group bets by track and date
    const betsByTrackAndDate = {};
    
    // Group single bets
    pendingBets.forEach(bet => {
      if (!bet.track_name || !bet.race_date) return;
      
      // Check if this is a multiple bet
      if (bet.horse_name && bet.horse_name.includes('/')) {
        // Handle as a special case later
        const trackKey = 'multiple';
        const dateKey = bet.race_date.split('T')[0];
        
        if (!betsByTrackAndDate[trackKey]) {
          betsByTrackAndDate[trackKey] = {};
        }
        
        if (!betsByTrackAndDate[trackKey][dateKey]) {
          betsByTrackAndDate[trackKey][dateKey] = [];
        }
        
        betsByTrackAndDate[trackKey][dateKey].push(bet);
      } else {
        // Single bet
        const trackKey = bet.track_name.trim();
        const dateKey = bet.race_date.split('T')[0];
        
        if (!betsByTrackAndDate[trackKey]) {
          betsByTrackAndDate[trackKey] = {};
        }
        
        if (!betsByTrackAndDate[trackKey][dateKey]) {
          betsByTrackAndDate[trackKey][dateKey] = [];
        }
        
        betsByTrackAndDate[trackKey][dateKey].push(bet);
      }
    });
    
    // Print overview of bets by track and date
    console.log('Bets by track and date:');
    for (const [track, dateMap] of Object.entries(betsByTrackAndDate)) {
      for (const [date, bets] of Object.entries(dateMap)) {
        console.log(`- ${track} (${date}): ${bets.length} bets`);
      }
    }
    
    // Process each track and date
    let totalBets = 0;
    let updatedBets = 0;
    let noMatchBets = 0;
    let errorBets = 0;
    
    // Collect all horse data across all API calls
    const allHorseData = [];
    
    // Process regular single bets first (by track and date)
    for (const [track, dateMap] of Object.entries(betsByTrackAndDate)) {
      if (track === 'multiple') continue; // Handle multiples separately
      
      for (const [date, bets] of Object.entries(dateMap)) {
        totalBets += bets.length;
        
        console.log(`\nProcessing ${bets.length} bets for track: ${track}, date: ${date}`);
        
        // Find course ID for this track
        const courseId = findCourseId(track, trackCodes.course_list);
        
        // Fetch results for this track and date
        const horseData = await fetchResultsForTrackAndDate(track, courseId, date);
        
        // Add track horse data to all horse data
        if (horseData && horseData.length > 0) {
          allHorseData.push(...horseData);
          
          // Save track-specific data for debugging
          fs.writeFileSync(`${track}_${date}_horses.json`, JSON.stringify(horseData, null, 2));
          
          console.log(`Found ${horseData.length} horses for ${track} on ${date}`);
          
          // Process each bet for this track and date
          for (const bet of bets) {
            try {
              const success = await processSingleBet(bet, horseData);
              if (success) {
                updatedBets++;
              } else {
                noMatchBets++;
              }
            } catch (err) {
              console.error(`Error processing bet ID ${bet.id}:`, err.message);
              errorBets++;
            }
          }
        } else {
          console.log(`No horse data found for ${track} on ${date}, skipping ${bets.length} bets`);
          noMatchBets += bets.length;
        }
        
        // Wait 15 seconds between API calls
        if (Object.keys(betsByTrackAndDate).length > 1) {
          console.log('Waiting 15 seconds before next API call...');
          await sleep(15000);
        }
      }
    }
    
    // Save all horse data collected
    if (allHorseData.length > 0) {
      fs.writeFileSync('all_horse_data.json', JSON.stringify(allHorseData, null, 2));
      console.log(`Saved data for ${allHorseData.length} horses across all tracks`);
    }
    
    // Now process multiple bets using the combined horse data
    if (betsByTrackAndDate['multiple']) {
      for (const [date, bets] of Object.entries(betsByTrackAndDate['multiple'])) {
        totalBets += bets.length;
        
        console.log(`\nProcessing ${bets.length} multiple bets for date: ${date}`);
        
        for (const bet of bets) {
          try {
            const success = await processMultipleBet(bet, allHorseData);
            if (success) {
              updatedBets++;
            } else {
              noMatchBets++;
            }
          } catch (err) {
            console.error(`Error processing multiple bet ID ${bet.id}:`, err.message);
            errorBets++;
          }
        }
      }
    }
    
    console.log('\nResults Summary:');
    console.log(`- Total bets processed: ${totalBets}`);
    console.log(`- Matches found and updated: ${updatedBets}`);
    console.log(`- No matches found: ${noMatchBets}`);
    console.log(`- Errors encountered: ${errorBets}`);
    
    return {
      success: true,
      updated: updatedBets,
      total: totalBets,
      noMatches: noMatchBets,
      errors: errorBets
    };
    
  } catch (error) {
    console.error('Error in updateBetResults:', error);
    return { success: false, error: error.message };
  }
}

// Find course ID from track name
function findCourseId(trackName, courseList) {
  if (!courseList || !Array.isArray(courseList)) return null;
  
  const cleanTrackName = cleanName(trackName);
  
  // Try exact match first
  const exactMatch = courseList.find(course => 
    cleanName(course.name) === cleanTrackName
  );
  
  if (exactMatch) return exactMatch.id;
  
  // Try partial match
  const partialMatch = courseList.find(course => 
    cleanName(course.name).includes(cleanTrackName) || 
    cleanTrackName.includes(cleanName(course.name))
  );
  
  if (partialMatch) return partialMatch.id;
  
  console.log(`No course ID found for track: ${trackName}`);
  return null;
}

// Fetch results for a specific track and date
async function fetchResultsForTrackAndDate(trackName, courseId, date) {
  console.log(`Fetching results for track: ${trackName}, date: ${date}`);
  
  try {
    let endpoint, params;
    
    if (courseId) {
      // If we have a course ID, use it
      endpoint = '/results';
      params = {
        course: [courseId],
        start_date: date,
        end_date: date
      };
      console.log(`Using course ID: ${courseId}`);
    } else {
      // Otherwise try by date only
      endpoint = '/results';
      params = {
        start_date: date,
        end_date: date
      };
    }
    
    console.log(`API Request: ${endpoint}?${new URLSearchParams(params).toString()}`);
    
    const response = await racingApi.get(endpoint, { params });
    
    // Save raw response for debugging
    fs.writeFileSync(`${trackName}_${date}_raw.json`, JSON.stringify(response.data, null, 2));
    
    // Process the response to extract horses
    const horses = extractHorsesFromResponse(response.data, trackName);
    
    if (horses.length > 0) {
      console.log(`Successfully extracted ${horses.length} horses for ${trackName} on ${date}`);
      
      // Debug: Log a few sample horses
      const sampleHorses = horses.slice(0, 3);
      console.log('Sample horses:');
      sampleHorses.forEach(horse => {
        console.log(`- ${horse.horse_name} (Position: ${horse.position})`);
      });
    } else {
      console.log(`No horses found for ${trackName} on ${date}`);
      
      // Try alternative API endpoints
      console.log('Trying alternative API endpoints...');
      
      // Try cards endpoint
      try {
        const cardsResponse = await racingApi.get(`/cards?date=${date}`);
        fs.writeFileSync(`${trackName}_${date}_cards_raw.json`, JSON.stringify(cardsResponse.data, null, 2));
        
        const cardsHorses = extractHorsesFromResponse(cardsResponse.data, trackName);
        if (cardsHorses.length > 0) {
          console.log(`Found ${cardsHorses.length} horses from cards endpoint`);
          return cardsHorses;
        }
      } catch (err) {
        console.log(`Cards endpoint failed: ${err.message}`);
      }
      
      // Try pro racecards endpoint
      try {
        const proResponse = await racingApi.get(`/pro/racecards?date=${date}`);
        fs.writeFileSync(`${trackName}_${date}_pro_raw.json`, JSON.stringify(proResponse.data, null, 2));
        
        const proHorses = extractHorsesFromResponse(proResponse.data, trackName);
        if (proHorses.length > 0) {
          console.log(`Found ${proHorses.length} horses from pro endpoint`);
          return proHorses;
        }
      } catch (err) {
        console.log(`Pro endpoint failed: ${err.message}`);
      }
    }
    
    return horses;
    
  } catch (error) {
    console.error(`Error fetching results for ${trackName} on ${date}:`, error.message);
    if (error.response) {
      console.error(`Status: ${error.response.status}, Data:`, error.response.data);
    }
    return [];
  }
}

// Extract horses from API response
function extractHorsesFromResponse(apiData, targetTrackName) {
  const horses = [];
  const cleanTarget = cleanName(targetTrackName);
  
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
      
      const trackName = context.track || targetTrackName;
      const cleanTrack = cleanName(trackName);
      
      // Only include horses from the target track or if no track filter
      if (!targetTrackName || cleanTrack.includes(cleanTarget) || cleanTarget.includes(cleanTrack)) {
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
  const horseResult = findBestMatch(bet.horse_name, bet.track_name, horses);
  
  if (!horseResult) {
    console.log(`No match found for ${bet.horse_name} at ${bet.track_name}`);
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
    const trackName = trackNames[i] || trackNames[0] || '';
    const horseResult = findBestMatch(selections[i], trackName, horses);
    
    if (!horseResult) {
      console.log(`No match found for ${selections[i]} at ${trackName || 'any track'}`);
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

// Find the best match for a horse at a track
function findBestMatch(horseName, trackName, horses) {
  if (!horseName) return null;
  
  console.log(`Looking for horse: "${horseName}" at track: "${trackName}"`);
  
  // Clean and normalize names
  const cleanHorse = cleanHorseName(horseName);
  const cleanTrack = cleanName(trackName || '');
  const simplifiedHorse = simplifyHorseName(horseName);
  
  // Matching strategies from most to least specific
  
  // 1. Exact match - both track and horse
  if (cleanTrack) {
    const exactTrackMatches = horses.filter(h => 
      isSimilarTrack(h.track_name, trackName)
    );
    
    console.log(`Found ${exactTrackMatches.length} horses at track ${trackName}`);
    
    if (exactTrackMatches.length > 0) {
      // 1a. Exact horse name at the matching track
      const exactMatch = exactTrackMatches.find(h => 
        cleanHorseName(h.horse_name) === cleanHorse
      );
      
      if (exactMatch) {
        console.log(`MATCH FOUND: Exact match for "${horseName}" at "${trackName}", position: ${exactMatch.position}`);
        return exactMatch;
      }
      
      // 1b. Simplified name match
      const simplifiedMatch = exactTrackMatches.find(h => 
        h.simplified_name === simplifiedHorse
      );
      
      if (simplifiedMatch) {
        console.log(`MATCH FOUND: Simplified name match "${horseName}" → "${simplifiedMatch.horse_name}" at ${simplifiedMatch.track_name}, position: ${simplifiedMatch.position}`);
        return simplifiedMatch;
      }
      
      // 1c. Partial name match
      const partialMatch = exactTrackMatches.find(h => {
        const horseNameClean = cleanHorseName(h.horse_name);
        return horseNameClean.includes(cleanHorse) || cleanHorse.includes(horseNameClean);
      });
      
      if (partialMatch) {
        console.log(`MATCH FOUND: Partial match for "${horseName}" → "${partialMatch.horse_name}" at ${partialMatch.track_name}, position: ${partialMatch.position}`);
        return partialMatch;
      }
      
      // Show horses at this track for debugging
      console.log(`Horses at track ${trackName} (showing first 10):`);
      exactTrackMatches.slice(0, 10).forEach(h => {
        console.log(`- ${h.horse_name} (position: ${h.position})`);
      });
    }
  }
  
  // 2. Horse-only match (any track)
  // 2a. Exact name
  const nameExactMatch = horses.find(h => 
    cleanHorseName(h.horse_name) === cleanHorse
  );
  
  if (nameExactMatch) {
    console.log(`MATCH FOUND: Horse-only exact match for "${horseName}" at ${nameExactMatch.track_name}, position: ${nameExactMatch.position}`);
    return nameExactMatch;
  }
  
  // 2b. Simplified name
  const nameSimplifiedMatch = horses.find(h => 
    h.simplified_name === simplifiedHorse
  );
  
  if (nameSimplifiedMatch) {
    console.log(`MATCH FOUND: Horse-only simplified match for "${horseName}" → "${nameSimplifiedMatch.horse_name}" at ${nameSimplifiedMatch.track_name}, position: ${nameSimplifiedMatch.position}`);
    return nameSimplifiedMatch;
  }
  
  // 2c. Partial name match
  const namePartialMatch = horses.find(h => {
    const horseNameClean = cleanHorseName(h.horse_name);
    return horseNameClean.includes(cleanHorse) || cleanHorse.includes(horseNameClean);
  });
  
  if (namePartialMatch) {
    console.log(`MATCH FOUND: Horse-only partial match for "${horseName}" → "${namePartialMatch.horse_name}" at ${namePartialMatch.track_name}, position: ${namePartialMatch.position}`);
    return namePartialMatch;
  }
  
  // 3. Fuzzy matching - Levenshtein distance
  const fuzzyMatch = findClosestMatch(cleanHorse, horses);
  
  if (fuzzyMatch) {
    console.log(`MATCH FOUND: Fuzzy match for "${horseName}" → "${fuzzyMatch.horse_name}" at ${fuzzyMatch.track_name}, position: ${fuzzyMatch.position}`);
    return fuzzyMatch;
  }
  
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
  
  return bestMatch;
}

// Check if two track names are similar
function isSimilarTrack(track1, track2) {
  if (!track1 || !track2) return false;
  
  const clean1 = cleanName(track1);
  const clean2 = cleanName(track2);
  
  // Exact match
  if (clean1 === clean2) return true;
  
  // Partial match
  if (clean1.includes(clean2) || clean2.includes(clean1)) return true;
  
  // Split track names and check parts
  const parts1 = clean1.split(/[ -]/);
  const parts2 = clean2.split(/[ -]/);
  
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
      console.log('Track-specific update completed:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('Error in track-specific update:', error);
      process.exit(1);
    });
}

module.exports = { updateBetResults };