#!/usr/bin/env node

const https = require('https');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// API credentials (same as in fetch-racecards.js)
const USERNAME = 'KQ9W7rQeAHWMUgxH93ie3yEc';
const PASSWORD = 'T5BoPivL3Q2h6RhCdLv4EwZu';

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase configuration. Please check your environment variables.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Get yesterday's date in YYYY-MM-DD format
const getYesterdayDate = () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0];
};

// Function to get a specific date for testing
const getSpecificDate = (daysAgo) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split('T')[0];
};

// Make API request to get racing results with FULL PAGINATION
const fetchRacingResults = async (date) => {
  console.log(`🚨 ENTERING fetchRacingResults function for date: ${date}`);
  
  const auth = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  const options = {
    headers: {
      'Authorization': `Basic ${auth}`,
      'User-Agent': 'Node.js/Results-Fetcher'
    }
  };

  let allRaces = [];
  let skip = 0;
  let limit = 50; // Maximum allowed by API
  let totalExpected = 0;
  let totalFetched = 0;
  let requestCount = 0;

  console.log(`🔍 Starting paginated fetch for ${date} using limit=${limit} and skip...`);

  try {
    // Keep fetching until we have all races
    while (true) {
      requestCount++;
      const apiUrl = `https://api.theracingapi.com/v1/results?start_date=${date}&end_date=${date}&limit=${limit}&skip=${skip}`;
      console.log(`📄 Request ${requestCount}: ${apiUrl}`);

      const pageData = await new Promise((resolve, reject) => {
        const req = https.get(apiUrl, options, (res) => {
          console.log(`📡 Request ${requestCount} response status: ${res.statusCode}`);
          
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            try {
              const jsonData = JSON.parse(data);
              resolve(jsonData);
            } catch (error) {
              console.error(`❌ Error parsing request ${requestCount} response:`, error.message);
              reject(error);
            }
          });
        });

        req.on('error', (error) => {
          console.error(`❌ Error making API request ${requestCount}:`, error.message);
          reject(error);
        });

        req.setTimeout(30000, () => {
          console.error(`❌ Request timeout for request ${requestCount}`);
          req.destroy();
          reject(new Error(`Request timeout for request ${requestCount}`));
        });
      });

      // Set total expected from first request
      if (requestCount === 1) {
        totalExpected = pageData.total || 0;
        console.log(`🎯 TOTAL RACES EXPECTED: ${totalExpected}`);
        
        if (totalExpected === 0) {
          console.log(`ℹ️  No races found for ${date}`);
          break;
        }
      }

      // Add races from this request
      const pageRaces = pageData.results || [];
      allRaces = allRaces.concat(pageRaces);
      totalFetched += pageRaces.length;

      console.log(`📊 Request ${requestCount}: Got ${pageRaces.length} races (Total so far: ${totalFetched}/${totalExpected})`);

      // Break if no more races on this request or we have all races
      if (pageRaces.length === 0 || totalFetched >= totalExpected) {
        console.log(`✅ Finished pagination. Got all ${totalFetched} races.`);
        break;
      }

      // Update skip for next request
      skip += limit;
      
      // Safety check to prevent infinite loops
      if (requestCount > 10) {
        console.warn(`⚠️  Safety break: Stopped at request ${requestCount} to prevent infinite loop`);
        break;
      }

      // Small delay between requests to be respectful to the API
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Final validation
    if (totalFetched !== totalExpected && totalExpected > 0) {
      console.warn(`⚠️  WARNING: Expected ${totalExpected} races but got ${totalFetched}`);
    }

    // Save complete response to file for debugging
    const completeResponse = {
      total: totalExpected,
      fetched: totalFetched,
      requests: requestCount,
      results: allRaces
    };
    
    require('fs').writeFileSync(`debug-response-${date}-COMPLETE.json`, JSON.stringify(completeResponse, null, 2));
    console.log(`💾 Saved COMPLETE response to debug-response-${date}-COMPLETE.json`);
    
    console.log(`✅ Successfully fetched ALL results from API`);
    console.log(`📊 FINAL RESULT: ${totalFetched} races fetched (expected: ${totalExpected})`);
    
    return {
      total: totalExpected,
      results: allRaces
    };

  } catch (error) {
    console.error('❌ Error in paginated fetch:', error.message);
    throw error;
  }
};

// Get runner data from supabase
const getRunnerData = async (raceId, horseId) => {
  try {
    const { data, error } = await supabase
      .from('runners')
      .select('*')
      .eq('race_id', raceId)
      .eq('horse_id', horseId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
      console.warn(`⚠️  Error fetching runner data for ${horseId} in race ${raceId}:`, error.message);
      return null;
    }

    return data;
  } catch (error) {
    console.warn(`⚠️  Exception fetching runner data for ${horseId} in race ${raceId}:`, error.message);
    return null;
  }
};

// Get race data from supabase
const getRaceData = async (raceId) => {
  try {
    const { data, error } = await supabase
      .from('races')
      .select('*')
      .eq('race_id', raceId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.warn(`⚠️  Error fetching race data for ${raceId}:`, error.message);
      return null;
    }

    return data;
  } catch (error) {
    console.warn(`⚠️  Exception fetching race data for ${raceId}:`, error.message);
    return null;
  }
};

// Get odds data from supabase
const getOddsData = async (raceId, horseId) => {
  try {
    const { data, error } = await supabase
      .from('odds')
      .select('*')
      .eq('race_id', raceId)
      .eq('horse_id', horseId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.warn(`⚠️  Error fetching odds data for ${horseId} in race ${raceId}:`, error.message);
      return null;
    }

    return data;
  } catch (error) {
    console.warn(`⚠️  Exception fetching odds data for ${horseId} in race ${raceId}:`, error.message);
    return null;
  }
};

// Get BSP data from UK or Ireland tables
const getBspData = async (horseName, raceDate, region) => {
  try {
    const tableName = region === 'IRE' ? 'IRE_BSP_Historical' : 'UK_BSP_Historical';
    
    // Convert date format for matching (YYYY-MM-DD to DD-MM-YYYY)
    const dateParts = raceDate.split("-");
    const bspDateFormat = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
    
    // Clean horse name for matching (remove country codes)
    const cleanHorseName = horseName.replace(/\s*\([A-Z]{2,3}\)$/, "").trim();
    
    console.log(`🔍 BSP lookup: ${tableName} for "${cleanHorseName}" on ${bspDateFormat}`);
    
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .ilike('selection_name', `%${cleanHorseName}%`)
      .ilike('event_dt', `${bspDateFormat}%`)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.warn(`⚠️  Error fetching BSP data for ${horseName} on ${raceDate}:`, error.message);
      return null;
    }

    if (data) {
      console.log(`🎯 BSP found for ${cleanHorseName}: BSP=${data.bsp}`);
    }

    return data;
  } catch (error) {
    console.warn(`⚠️  Exception fetching BSP data for ${horseName} on ${raceDate}:`, error.message);
    return null;
  }
};

// Calculate average opening odds from all bookmakers
const calculateAverageOpeningOdds = (oddsData) => {
  if (!oddsData) return null;
  
  const openingOdds = [
    oddsData.bet365_opening, oddsData.william_hill_opening, oddsData.paddy_power_opening,
    oddsData.sky_bet_opening, oddsData.ladbrokes_opening, oddsData.coral_opening,
    oddsData.betfair_opening, oddsData.betfred_opening, oddsData.unibet_opening,
    oddsData.bet_uk_opening, oddsData.bet_goodwin_opening, oddsData.bet_victor_opening,
    oddsData.ten_bet_opening, oddsData.seven_bet_opening, oddsData.bet442_opening,
    oddsData.betmgm_opening, oddsData.betway_opening, oddsData.boyle_sports_opening,
    oddsData.copybet_opening, oddsData.dragon_bet_opening, oddsData.gentlemen_jim_opening,
    oddsData.grosvenor_sports_opening, oddsData.hollywood_bets_opening, oddsData.matchbook_opening,
    oddsData.midnite_opening, oddsData.pricedup_bet_opening, oddsData.quinn_bet_opening,
    oddsData.sporting_index_opening, oddsData.spreadex_opening, oddsData.star_sports_opening,
    oddsData.virgin_bet_opening, oddsData.talksport_bet_opening, oddsData.betfair_exchange_opening
  ].filter(odds => odds && odds > 0);
  
  if (openingOdds.length === 0) return null;
  
  return openingOdds.reduce((sum, odds) => sum + odds, 0) / openingOdds.length;
};

// Parse average odds time series from string format
const parseAverageOddsTimeSeries = (averageOddsString) => {
  if (!averageOddsString || typeof averageOddsString !== 'string') return [];
  
  try {
    // Parse format like "1.5@10:00,1.6@11:00,1.7@12:00"
    return averageOddsString.split(',').map(entry => {
      const [odds, time] = entry.split('@');
      return {
        odds: parseFloat(odds),
        time: time
      };
    }).filter(entry => !isNaN(entry.odds));
  } catch (error) {
    return [];
  }
};

// Calculate price movement metrics
const calculatePriceMovementMetrics = (averageOpeningOdds, averageOddsString) => {
  const timeSeries = parseAverageOddsTimeSeries(averageOddsString);
  
  if (!averageOpeningOdds || timeSeries.length === 0) {
    return {
      price_change_percentage: null,
      price_volatility: null,
      max_price: null,
      min_price: null,
      price_trend: null
    };
  }
  
  const prices = timeSeries.map(entry => entry.odds);
  const finalPrice = prices[prices.length - 1];
  
  // Price change percentage
  const priceChangePercentage = ((finalPrice - averageOpeningOdds) / averageOpeningOdds) * 100;
  
  // Price volatility (standard deviation)
  const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
  const volatility = Math.sqrt(variance);
  
  // Max and min prices
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  
  // Price trend (simplified: positive if final > opening, negative if final < opening)
  const priceTrend = finalPrice > averageOpeningOdds ? 'drifting' : 
                    finalPrice < averageOpeningOdds ? 'shortening' : 'stable';
  
  return {
    price_change_percentage: priceChangePercentage,
    price_volatility: volatility,
    max_price: maxPrice,
    min_price: minPrice,
    price_trend: priceTrend
  };
};

// Calculate market confidence score based on price stability
const calculateMarketConfidenceScore = (averageOddsString) => {
  const timeSeries = parseAverageOddsTimeSeries(averageOddsString);
  
  if (timeSeries.length < 2) return null;
  
  const prices = timeSeries.map(entry => entry.odds);
  
  // Calculate coefficient of variation (volatility relative to mean)
  const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
  const standardDeviation = Math.sqrt(variance);
  const coefficientOfVariation = standardDeviation / mean;
  
  // Convert to confidence score (lower volatility = higher confidence)
  // Scale from 0-100 where 100 is highest confidence
  const confidenceScore = Math.max(0, Math.min(100, 100 - (coefficientOfVariation * 1000)));
  
  return confidenceScore;
};

// Calculate money indicators (steaming/drifting patterns)
const calculateMoneyIndicators = (averageOpeningOdds, averageOddsString) => {
  const timeSeries = parseAverageOddsTimeSeries(averageOddsString);
  
  if (!averageOpeningOdds || timeSeries.length < 3) {
    return {
      steaming_indicator: false,
      drifting_indicator: false,
      money_confidence: null,
      late_money: false
    };
  }
  
  const prices = timeSeries.map(entry => entry.odds);
  const finalPrice = prices[prices.length - 1];
  const midPrice = prices[Math.floor(prices.length / 2)];
  
  // Steaming: significant shortening (price decrease)
  const totalShortening = averageOpeningOdds - finalPrice;
  const shorteningPercentage = (totalShortening / averageOpeningOdds) * 100;
  const steamingIndicator = shorteningPercentage > 15; // More than 15% shortening
  
  // Drifting: significant lengthening (price increase)
  const totalDrifting = finalPrice - averageOpeningOdds;
  const driftingPercentage = (totalDrifting / averageOpeningOdds) * 100;
  const driftingIndicator = driftingPercentage > 20; // More than 20% drifting
  
  // Money confidence based on consistent movement direction
  let consistentMovements = 0;
  for (let i = 1; i < prices.length; i++) {
    const movement = prices[i] - prices[i-1];
    const expectedDirection = steamingIndicator ? -1 : driftingIndicator ? 1 : 0;
    if ((movement < 0 && expectedDirection < 0) || (movement > 0 && expectedDirection > 0)) {
      consistentMovements++;
    }
  }
  const moneyConfidence = consistentMovements / (prices.length - 1);
  
  // Late money: significant movement in final third of time series
  const finalThirdStart = Math.floor(prices.length * 2/3);
  const finalThirdPrices = prices.slice(finalThirdStart);
  const lateMovement = Math.abs(finalThirdPrices[finalThirdPrices.length - 1] - finalThirdPrices[0]);
  const lateMoney = lateMovement > (averageOpeningOdds * 0.1); // More than 10% movement in final third
  
  return {
    steaming_indicator: steamingIndicator,
    drifting_indicator: driftingIndicator,
    money_confidence: moneyConfidence,
    late_money: lateMoney
  };
};

// Calculate derived fields
const calculateDerivedFields = (runner, results, runnerData, oddsData) => {
  const derived = {};
  
  // Win/place flags
  derived.win_flag = runner.position === '1';
  derived.place_flag = ['1', '2', '3'].includes(runner.position);
  
  // Favorite indicator
  derived.favorite_indicator = runner.sp && runner.sp.includes('F') ? 'F' : null;
  derived.joint_favorite_indicator = runner.sp && runner.sp.includes('JF');
  
  // Extract opening price from comment
  const comment = runner.comment || '';
  const openingMatch = comment.match(/\(op ([^)]+)\)/);
  derived.opening_price_mentioned = openingMatch ? openingMatch[1] : null;
  
  const touchedMatch = comment.match(/tchd ([^)]+)/);
  derived.price_touched_mentioned = touchedMatch ? touchedMatch[1] : null;
  
  // Convert beaten lengths to numeric
  derived.beaten_distance_numeric = runner.btn && runner.btn !== '0' ? parseFloat(runner.btn) : 0;
  derived.overall_beaten_distance_numeric = runner.ovr_btn && runner.ovr_btn !== '0' ? parseFloat(runner.ovr_btn) : 0;
  
  // Calculate advanced price metrics
  const averageOpeningOdds = calculateAverageOpeningOdds(oddsData);
  const averageOddsString = runnerData?.average_odds || '';
  
  const priceMetrics = calculatePriceMovementMetrics(averageOpeningOdds, averageOddsString);
  const moneyIndicators = calculateMoneyIndicators(averageOpeningOdds, averageOddsString);
  
  derived.average_opening_odds = averageOpeningOdds;
  derived.market_confidence_score = calculateMarketConfidenceScore(averageOddsString);
  
  // Add all calculated metrics
  Object.assign(derived, priceMetrics, moneyIndicators);
  
  return derived;
};

// Build master results row
const buildMasterResultsRow = (race, runner, raceData, runnerData, oddsData, bspData) => {
  const derivedFields = calculateDerivedFields(runner, race, runnerData, oddsData);
  
  return {
    // Race Information
    race_id: race.race_id,
    course: race.course,
    course_id: race.course_id,
    race_date: race.date,
    off_time: race.off,
    off_dt: race.off_dt,
    race_name: race.race_name,
    dist: race.dist,
    distance_f: raceData?.distance_f || null,
    distance_round: raceData?.distance_round || null,
    dist_y: race.dist_y,
    dist_m: race.dist_m,
    dist_f: race.dist_f,
    pattern: race.pattern,
    race_class: race.class,
    type: race.type,
    age_band: race.age_band,
    rating_band: race.rating_band,
    sex_rest: race.sex_rest,
    going: race.going,
    going_detailed: raceData?.going_detailed || null,
    surface: race.surface,
    jumps: race.jumps,
    prize: raceData?.prize || null,
    field_size: raceData?.field_size || null,
    region: race.region,
    big_race: raceData?.big_race || false,
    is_abandoned: raceData?.is_abandoned || false,
    
    // Runner/Horse Information
    runner_id: runnerData?.id || null,
    horse_id: runner.horse_id,
    horse: runner.horse,
    number: runner.number,
    draw: runner.draw,
    dob: runnerData?.dob || null,
    age: runner.age,
    sex: runner.sex,
    sex_code: runnerData?.sex_code || null,
    colour: runnerData?.colour || null,
    sire: runner.sire,
    sire_id: runner.sire_id,
    dam: runner.dam,
    dam_id: runner.dam_id,
    damsire: runner.damsire,
    damsire_id: runner.damsire_id,
    trainer: runner.trainer,
    trainer_id: runner.trainer_id,
    jockey: runner.jockey,
    jockey_id: runner.jockey_id,
    jockey_claim_lbs: runner.jockey_claim_lbs,
    owner: runner.owner,
    owner_id: runner.owner_id,
    weight_lbs: runner.weight_lbs,
    headgear: runner.headgear,
    comment: runnerData?.comment || null,
    
    // Technical Analysis (from runners table)
    "5_moving_average": runnerData?.["5_moving_average"] || null,
    "20_moving_average": runnerData?.["20_moving_average"] || null,
    "60_moving_average": runnerData?.["60_moving_average"] || null,
    "5_bollinger_bands": runnerData?.["5_bollinger_bands"] || null,
    "20_bollinger_bands": runnerData?.["20_bollinger_bands"] || null,
    "60_bollinger_bands": runnerData?.["60_bollinger_bands"] || null,
    support_levels: runnerData?.support_levels || null,
    resistance_levels: runnerData?.resistance_levels || null,
    price_change: runnerData?.price_change || null,
    average_odds: runnerData?.average_odds || null,
    market_pressure_shortening: runnerData?.market_pressure_shortening || null,
    market_pressure_drifting: runnerData?.market_pressure_drifting || null,
    momentum_steaming: runnerData?.momentum_steaming || null,
    momentum_drifting: runnerData?.momentum_drifting || null,
    sharp_average_odds: runnerData?.sharp_average_odds || null,
    
    // Opening Odds (mapping all bookmakers)
    bet365_opening: oddsData?.bet365_opening || null,
    william_hill_opening: oddsData?.william_hill_opening || null,
    paddy_power_opening: oddsData?.paddy_power_opening || null,
    sky_bet_opening: oddsData?.sky_bet_opening || null,
    ladbrokes_opening: oddsData?.ladbrokes_opening || null,
    coral_opening: oddsData?.coral_opening || null,
    betfair_opening: oddsData?.betfair_opening || null,
    betfred_opening: oddsData?.betfred_opening || null,
    unibet_opening: oddsData?.unibet_opening || null,
    bet_uk_opening: oddsData?.bet_uk_opening || null,
    bet_goodwin_opening: oddsData?.bet_goodwin_opening || null,
    bet_victor_opening: oddsData?.bet_victor_opening || null,
    ten_bet_opening: oddsData?.ten_bet_opening || null,
    seven_bet_opening: oddsData?.seven_bet_opening || null,
    bet442_opening: oddsData?.bet442_opening || null,
    betmgm_opening: oddsData?.betmgm_opening || null,
    betway_opening: oddsData?.betway_opening || null,
    boyle_sports_opening: oddsData?.boyle_sports_opening || null,
    copybet_opening: oddsData?.copybet_opening || null,
    dragon_bet_opening: oddsData?.dragon_bet_opening || null,
    gentlemen_jim_opening: oddsData?.gentlemen_jim_opening || null,
    grosvenor_sports_opening: oddsData?.grosvenor_sports_opening || null,
    hollywood_bets_opening: oddsData?.hollywood_bets_opening || null,
    matchbook_opening: oddsData?.matchbook_opening || null,
    midnite_opening: oddsData?.midnite_opening || null,
    pricedup_bet_opening: oddsData?.pricedup_bet_opening || null,
    quinn_bet_opening: oddsData?.quinn_bet_opening || null,
    sporting_index_opening: oddsData?.sporting_index_opening || null,
    spreadex_opening: oddsData?.spreadex_opening || null,
    star_sports_opening: oddsData?.star_sports_opening || null,
    virgin_bet_opening: oddsData?.virgin_bet_opening || null,
    talksport_bet_opening: oddsData?.talksport_bet_opening || null,
    betfair_exchange_opening: oddsData?.betfair_exchange_opening || null,
    
    // Odds History
    bet365_history: oddsData?.bet365_history || '',
    william_hill_history: oddsData?.william_hill_history || '',
    paddy_power_history: oddsData?.paddy_power_history || '',
    sky_bet_history: oddsData?.sky_bet_history || '',
    ladbrokes_history: oddsData?.ladbrokes_history || '',
    coral_history: oddsData?.coral_history || '',
    betfair_history: oddsData?.betfair_history || '',
    betfred_history: oddsData?.betfred_history || '',
    unibet_history: oddsData?.unibet_history || '',
    bet_uk_history: oddsData?.bet_uk_history || '',
    bet_goodwin_history: oddsData?.bet_goodwin_history || '',
    bet_victor_history: oddsData?.bet_victor_history || '',
    ten_bet_history: oddsData?.ten_bet_history || '',
    seven_bet_history: oddsData?.seven_bet_history || '',
    bet442_history: oddsData?.bet442_history || '',
    betmgm_history: oddsData?.betmgm_history || '',
    betway_history: oddsData?.betway_history || '',
    boyle_sports_history: oddsData?.boyle_sports_history || '',
    copybet_history: oddsData?.copybet_history || '',
    dragon_bet_history: oddsData?.dragon_bet_history || '',
    gentlemen_jim_history: oddsData?.gentlemen_jim_history || '',
    grosvenor_sports_history: oddsData?.grosvenor_sports_history || '',
    hollywood_bets_history: oddsData?.hollywood_bets_history || '',
    matchbook_history: oddsData?.matchbook_history || '',
    midnite_history: oddsData?.midnite_history || '',
    pricedup_bet_history: oddsData?.pricedup_bet_history || '',
    quinn_bet_history: oddsData?.quinn_bet_history || '',
    sporting_index_history: oddsData?.sporting_index_history || '',
    spreadex_history: oddsData?.spreadex_history || '',
    star_sports_history: oddsData?.star_sports_history || '',
    virgin_bet_history: oddsData?.virgin_bet_history || '',
    talksport_bet_history: oddsData?.talksport_bet_history || '',
    betfair_exchange_history: oddsData?.betfair_exchange_history || '',
    
    // Place Odds
    bet365_places: oddsData?.bet365_places || null,
    william_hill_places: oddsData?.william_hill_places || null,
    paddy_power_places: oddsData?.paddy_power_places || null,
    sky_bet_places: oddsData?.sky_bet_places || null,
    ladbrokes_places: oddsData?.ladbrokes_places || null,
    coral_places: oddsData?.coral_places || null,
    betfair_places: oddsData?.betfair_places || null,
    betfred_places: oddsData?.betfred_places || null,
    unibet_places: oddsData?.unibet_places || null,
    bet_uk_places: oddsData?.bet_uk_places || null,
    bet_goodwin_places: oddsData?.bet_goodwin_places || null,
    bet_victor_places: oddsData?.bet_victor_places || null,
    ten_bet_places: oddsData?.ten_bet_places || null,
    seven_bet_places: oddsData?.seven_bet_places || null,
    bet442_places: oddsData?.bet442_places || null,
    betmgm_places: oddsData?.betmgm_places || null,
    betway_places: oddsData?.betway_places || null,
    boyle_sports_places: oddsData?.boyle_sports_places || null,
    copybet_places: oddsData?.copybet_places || null,
    dragon_bet_places: oddsData?.dragon_bet_places || null,
    gentlemen_jim_places: oddsData?.gentlemen_jim_places || null,
    grosvenor_sports_places: oddsData?.grosvenor_sports_places || null,
    hollywood_bets_places: oddsData?.hollywood_bets_places || null,
    matchbook_places: oddsData?.matchbook_places || null,
    midnite_places: oddsData?.midnite_places || null,
    pricedup_bet_places: oddsData?.pricedup_bet_places || null,
    quinn_bet_places: oddsData?.quinn_bet_places || null,
    sporting_index_places: oddsData?.sporting_index_places || null,
    
    // Post-Race Results
    position: runner.position,
    sp: runner.sp,
    sp_dec: runner.sp_dec,
    btn: runner.btn,
    ovr_btn: runner.ovr_btn,
    time: runner.time,
    or_rating: runner.or,
    rpr_result: runner.rpr,
    tsr_result: runner.tsr,
    prize_won: runner.prize,
    comment_result: runner.comment,
    
    // Race Result Details
    winning_time_detail: race.winning_time_detail,
    race_comments: race.comments,
    non_runners: race.non_runners,
    tote_win: race.tote_win,
    tote_place: race.tote_pl,
    tote_exacta: race.tote_ex,
    tote_csf: race.tote_csf,
    tote_tricast: race.tote_tricast,
    tote_trifecta: race.tote_trifecta,
    
    // BSP Data
    betfair_event_id: bspData?.event_id || null,
    betfair_selection_id: bspData?.selection_id || null,
    bsp: bspData?.bsp || null,
    ppwap: bspData?.ppwap || null,
    morningwap: bspData?.morningwap || null,
    ppmax: bspData?.ppmax || null,
    ppmin: bspData?.ppmin || null,
    ipmax: bspData?.ipmax || null,
    ipmin: bspData?.ipmin || null,
    total_traded_volume: bspData ? 
      (bspData.morningtradedvol || 0) + (bspData.pptradedvol || 0) + (bspData.iptradedvol || 0) : null,
    
    // Derived ML Fields
    ...derivedFields
  };
};

// Check if record already exists
const recordExists = async (raceId, horseId) => {
  try {
    const { data, error } = await supabase
      .from('master_results')
      .select('id')
      .eq('race_id', raceId)
      .eq('horse_id', horseId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.warn(`⚠️  Error checking existing record for ${horseId} in race ${raceId}:`, error.message);
      return false;
    }

    return !!data;
  } catch (error) {
    console.warn(`⚠️  Exception checking existing record for ${horseId} in race ${raceId}:`, error.message);
    return false;
  }
};

// Insert or update master results record
const insertMasterResult = async (resultRow, isUpdate = false) => {
  try {
    let result;
    
    if (isUpdate) {
      // Update existing record
      result = await supabase
        .from('master_results')
        .update(resultRow)
        .eq('race_id', resultRow.race_id)
        .eq('horse_id', resultRow.horse_id);
    } else {
      // Insert new record
      result = await supabase
        .from('master_results')
        .insert([resultRow]);
    }

    if (result.error) {
      console.error(`❌ Error ${isUpdate ? 'updating' : 'inserting'} record for ${resultRow.horse} in race ${resultRow.race_id}:`, result.error.message);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`❌ Exception ${isUpdate ? 'updating' : 'inserting'} record for ${resultRow.horse} in race ${resultRow.race_id}:`, error.message);
    return false;
  }
};

// Main processing function
const processResults = async (results, isUpdate = false) => {
  let totalProcessed = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalErrors = 0;

  console.log(`\n🔄 Processing ${results.results?.length || 0} races...`);

  for (const race of results.results || []) {
    console.log(`\n📍 Processing race: ${race.race_name} at ${race.course}`);
    
    // Get race data from supabase
    const raceData = await getRaceData(race.race_id);
    
    for (const runner of race.runners || []) {
      totalProcessed++;
      
      try {
        // Check if record already exists
        const exists = await recordExists(race.race_id, runner.horse_id);
        
        if (exists && !isUpdate) {
          console.log(`⏭️  Record exists for ${runner.horse}, skipping...`);
          continue;
        }
        
        console.log(`${exists ? '🔄' : '➕'} Processing ${runner.horse}...`);
        
        // Get all the supplementary data
        const [runnerData, oddsData, bspData] = await Promise.all([
          getRunnerData(race.race_id, runner.horse_id),
          getOddsData(race.race_id, runner.horse_id),
          getBspData(runner.horse, race.date, race.region)
        ]);
        
        // Build the master results row
        const resultRow = buildMasterResultsRow(race, runner, raceData, runnerData, oddsData, bspData);
        
        // Insert or update the record
        const shouldUpdate = exists && isUpdate;
        const success = await insertMasterResult(resultRow, shouldUpdate);
        
        if (success) {
          if (shouldUpdate) {
            totalUpdated++;
            console.log(`✅ Updated ${runner.horse}`);
          } else {
            totalInserted++;
            console.log(`✅ Inserted ${runner.horse}`);
          }
        } else {
          totalErrors++;
        }
        
        // Small delay to avoid overwhelming the database
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        totalErrors++;
        console.error(`❌ Error processing ${runner.horse}:`, error.message);
      }
    }
  }

  console.log(`\n📊 Summary: Processed: ${totalProcessed}, Inserted: ${totalInserted}, Updated: ${totalUpdated}, Errors: ${totalErrors}`);
  
  return {
    totalProcessed,
    totalInserted,
    totalUpdated,
    totalErrors
  };
};

// Main execution function
const main = async () => {
  try {
    console.log('🚀 Starting Master Results Population');
    
    const targetDate = getYesterdayDate();
    console.log(`📅 Target date: ${targetDate}`);
    console.log(`🔄 Mode: INSERT`);
    
    // Fetch results from API with FULL PAGINATION
    const results = await fetchRacingResults(targetDate);
    
    if (!results.results || results.results.length === 0) {
      console.log('ℹ️  No results found for the target date');
      return;
    }
    
    console.log(`📋 Found ${results.results.length} races for ${targetDate}`);
    
    // Process all results
    const summary = await processResults(results, false);
    
    console.log('\n🎉 Script completed successfully!');
    console.log(`📈 Final stats: ${summary.totalInserted} inserted, ${summary.totalUpdated} updated, ${summary.totalErrors} errors`);
    
  } catch (error) {
    console.error('💥 Script failed:', error.message);
    process.exit(1);
  }
};

// Run the script
if (require.main === module) {
  main();
}

module.exports = { main, processResults, fetchRacingResults };