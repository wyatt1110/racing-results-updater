// Find a matching horse in the results with greatly improved matching accuracy
function findHorseMatch(horseName, horses) {
  if (!horseName || !horses || horses.length === 0) return null;
  
  // Clean the horse name for comparison
  const cleanName = horseName.toLowerCase().trim();
  const simplifiedSearch = simplifyName(horseName);
  
  Logger.debug(`Searching ${horses.length} horses for match to "${horseName}"`);
  
  // First, try exact match
  for (const horse of horses) {
    // Clean the horse name from API response
    const apiName = (horse.horse_name || '').toLowerCase().trim();
    
    // Check for country code markers and remove them
    const apiNameNoCountry = apiName.replace(/\\s*\\([a-z]{2,3}\\)$/i, '');
    
    if (apiName === cleanName || apiNameNoCountry === cleanName) {
      Logger.debug(`Exact match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try simplified name match (no spaces, no punctuation)
  for (const horse of horses) {
    if (horse.simplified_name === simplifiedSearch) {
      Logger.debug(`Simplified match found: ${horse.horse_name}`);
      return horse;
    }
  }
  
  // Try contains matching (when one name is contained in the other)
  for (const horse of horses) {
    const apiName = (horse.horse_name || '').toLowerCase().trim();
    const apiNameNoCountry = apiName.replace(/\\s*\\([a-z]{2,3}\\)$/i, '');
    
    if (apiNameNoCountry.includes(cleanName) || cleanName.includes(apiNameNoCountry)) {
      const containsScore = Math.min(apiNameNoCountry.length, cleanName.length) / 
                           Math.max(apiNameNoCountry.length, cleanName.length);
      
      // Only accept if significant overlap
      if (containsScore > 0.7) {
        Logger.debug(`Contains match found: ${horse.horse_name} (score: ${containsScore.toFixed(2)})`);
        return horse;
      }
    }
  }
  
  // Try fuzzy matching using Levenshtein distance
  let bestMatch = null;
  let bestScore = 0;
  const threshold = 0.8; // Require high confidence for fuzzy matches
  
  for (const horse of horses) {
    const apiName = (horse.horse_name || '').toLowerCase().trim();
    const apiNameNoCountry = apiName.replace(/\\s*\\([a-z]{2,3}\\)$/i, '');
    
    const score = calculateSimilarity(cleanName, apiNameNoCountry);
    
    if (score > threshold && score > bestScore) {
      bestScore = score;
      bestMatch = horse;
    }
  }
  
  if (bestMatch) {
    Logger.debug(`Fuzzy match found: ${bestMatch.horse_name} (score: ${bestScore.toFixed(2)})`);
    return bestMatch;
  }
  
  // Alternative approach - try matching each word separately
  const betWords = cleanName.split(/\\s+/);
  
  // Only attempt word matching if we have multiple words and they're not super short
  if (betWords.length > 1 && betWords.some(w => w.length > 3)) {
    let bestMatchByWords = null;
    let highestWordMatchCount = 0;
    
    for (const horse of horses) {
      const apiName = (horse.horse_name || '').toLowerCase().trim();
      const apiWords = apiName.split(/\\s+/);
      
      let matchCount = 0;
      for (const betWord of betWords) {
        // Skip very short words
        if (betWord.length <= 2) continue;
        
        // Check if any API words match or contain this bet word
        if (apiWords.some(apiWord => 
          apiWord === betWord || 
          (apiWord.length > 3 && apiWord.includes(betWord)) ||
          (betWord.length > 3 && betWord.includes(apiWord))
        )) {
          matchCount++;
        }
      }
      
      // Calculate match percentage (against meaningful bet words)
      const matchPercentage = matchCount / betWords.filter(w => w.length > 2).length;
      
      if (matchCount > highestWordMatchCount && matchPercentage > 0.5) {
        highestWordMatchCount = matchCount;
        bestMatchByWords = horse;
      }
    }
    
    if (bestMatchByWords) {
      Logger.debug(`Word match found: ${bestMatchByWords.horse_name} (matched ${highestWordMatchCount} words)`);
      return bestMatchByWords;
    }
  }
  
  Logger.debug(`No match found for horse: ${horseName}`);
  return null;
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
  Logger.info(`Processing single bet: ${bet.id} - ${bet.horse_name} at ${bet.track_name}`);
  
  const date = bet.race_date.split('T')[0];
  const trackName = bet.track_name.trim();
  const horseName = bet.horse_name.trim();
  
  // Get cached horses for this track/date
  const cacheKey = `${trackName}:${date}`;
  const cachedHorses = trackHorsesCache[cacheKey] || [];
  
  if (cachedHorses.length === 0) {
    Logger.warn(`No horses found for ${trackName} on ${date}`);
    return false;
  }
  
  // Find the matching horse
  const horse = findHorseMatch(horseName, cachedHorses);
  
  if (!horse) {
    Logger.warn(`No match found for horse: ${horseName} at ${trackName}`);
    return false;
  }
  
  Logger.info(`Found match: ${horseName} -> ${horse.horse_name} (Position: ${horse.position})`);
  
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
    
    Logger.debug(`Updating bet ${bet.id} with:`, updateData);
    
    // Update in Supabase
    const { error } = await supabase
      .from('racing_bets')
      .update(updateData)
      .eq('id', bet.id);
    
    if (error) {
      Logger.error(`Error updating bet ${bet.id}:`, error.message);
      return false;
    }
    
    Logger.info(`Successfully updated bet ${bet.id}: ${status}, Returns: ${returns}`);
    return true;
  } catch (error) {
    Logger.error(`Exception updating bet ${bet.id}:`, error);
    return false;
  }
}

// Process a multiple bet (improved handling)
async function processMultipleBet(bet) {
  Logger.info(`Processing multiple bet: ${bet.id} - ${bet.horse_name}`);
  
  // Split horse names
  const horseNames = bet.horse_name.split('/').map(h => h.trim());
  
  // Handle track names (single track or multiple tracks)
  let trackNames = [];
  
  if (bet.track_name.includes('/')) {
    // Multiple tracks specified
    trackNames = bet.track_name.split('/').map(t => t.trim());
    
    // Ensure we have same number of tracks as horses
    if (trackNames.length < horseNames.length) {
      // If not enough tracks, repeat the last one
      const lastTrack = trackNames[trackNames.length - 1];
      while (trackNames.length < horseNames.length) {
        trackNames.push(lastTrack);
      }
    } else if (trackNames.length > horseNames.length) {
      // If too many tracks, truncate
      trackNames = trackNames.slice(0, horseNames.length);
    }
  } else {
    // Single track for all horses
    trackNames = horseNames.map(() => bet.track_name.trim());
  }
  
  Logger.info(`Multiple bet has ${horseNames.length} selections: ${horseNames.join(', ')}`);
  Logger.info(`Tracks: ${trackNames.join(', ')}`);
  
  const date = bet.race_date.split('T')[0];
  const horses = [];
  const missingHorses = [];
  
  // Find all horses
  for (let i = 0; i < horseNames.length; i++) {
    const horseName = horseNames[i];
    const trackName = trackNames[i];
    
    // Get cached horses for this track
    const cacheKey = `${trackName}:${date}`;
    let cachedHorses = trackHorsesCache[cacheKey] || [];
    
    // If no cached horses, try to fetch them now
    if (cachedHorses.length === 0) {
      Logger.warn(`No cached horses for ${trackName} on ${date}, trying to fetch now`);
      
      const courseId = findCourseId(trackName);
      if (courseId) {
        const fetchedHorses = await fetchRaceResults(trackName, date, courseId);
        if (fetchedHorses.length > 0) {
          trackHorsesCache[cacheKey] = fetchedHorses;
          cachedHorses = fetchedHorses;
          Logger.info(`Fetched ${fetchedHorses.length} horses for ${trackName}`);
        }
      }
      
      // If still no horses, log and continue
      if (cachedHorses.length === 0) {
        Logger.warn(`No horses found for ${trackName} on ${date} for horse ${horseName}`);
        missingHorses.push({ horseName, trackName, reason: 'No horses found for track/date' });
        continue; // Continue to next horse instead of failing the entire bet
      }
    }
    
    // Find this horse
    const horse = findHorseMatch(horseName, cachedHorses);
    
    if (horse) {
      Logger.info(`Found match for multiple bet: ${horseName} -> ${horse.horse_name} (Position: ${horse.position})`);
      horses.push(horse);
    } else {
      Logger.warn(`No match found for horse: ${horseName} at ${trackName}`);
      missingHorses.push({ horseName, trackName, reason: 'No match found' });
    }
  }
  
  Logger.info(`Found ${horses.length} of ${horseNames.length} horses for multiple bet ${bet.id}`);
  
  // If we didn't find any horses, fail
  if (horses.length === 0) {
    Logger.warn(`Failed to find any horses for multiple bet ${bet.id}`);
    for (const missing of missingHorses) {
      Logger.debug(`- ${missing.horseName} at ${missing.trackName}: ${missing.reason}`);
    }
    return false;
  }
  
  // If we found some but not all horses, proceed with what we have (partial update)
  if (horses.length < horseNames.length) {
    Logger.warn(`Only found ${horses.length} of ${horseNames.length} horses for bet ${bet.id}`);
    for (const missing of missingHorses) {
      Logger.debug(`- ${missing.horseName} at ${missing.trackName}: ${missing.reason}`);
    }
  }
  
  // Calculate bet status, returns, etc.
  const { status, returns, profit_loss, sp_industry, ovr_btn, fin_pos } = calculateBetResult(bet, horses, horseNames.length);
  
  // Update bet in database
  try {
    // Prepare update data
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
    
    Logger.debug(`Updating multiple bet ${bet.id} with:`, updateData);
    
    // Update in Supabase
    const { error } = await supabase
      .from('racing_bets')
      .update(updateData)
      .eq('id', bet.id);
    
    if (error) {
      Logger.error(`Error updating multiple bet ${bet.id}:`, error);
      return false;
    }
    
    Logger.info(`Successfully updated multiple bet ${bet.id}: ${status}, Returns: ${returns}`);
    return true;
  } catch (error) {
    Logger.error(`Exception updating multiple bet ${bet.id}:`, error);
    return false;
  }
}

// Calculate the outcome of a bet
function calculateBetResult(bet, horses, totalSelections = null) {
  if (!horses || horses.length === 0) {
    throw new Error('No horse data provided to calculate bet result');
  }
  
  const isMultiple = horses.length > 1;
  const originalHorseCount = totalSelections || (bet.horse_name || '').split('/').length;
  const missingHorses = originalHorseCount - horses.length;
  
  // For multi-selection bets where not all horses were found
  let status = 'Pending';
  
  if (isMultiple && missingHorses > 0) {
    Logger.debug(`Multiple bet has ${missingHorses} missing horses, marking as 'Partial Update'`);
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