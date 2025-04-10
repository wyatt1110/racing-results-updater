// Main function to update bet results
async function updateBetResults() {
  Logger.info('Starting bet results update process...');
  
  try {
    // Initialize track codes
    await loadTrackCodes();
    
    // Verify we have track codes loaded
    if (Object.keys(TRACK_CODES).length === 0) {
      Logger.warn('No track codes loaded, using fallback codes');
      
      // Use fallback codes
      for (const [track, id] of Object.entries(FALLBACK_TRACK_CODES)) {
        TRACK_CODES[track] = id;
      }
    }
    
    // Log some available track codes for debugging
    Logger.debug('Sample track codes:');
    const trackSamples = Object.entries(TRACK_CODES).slice(0, 10);
    for (const [track, id] of trackSamples) {
      Logger.debug(`  - ${track}: ${id}`);
    }
    Logger.debug(`... and ${Object.keys(TRACK_CODES).length - 10} more`);
    
    // Fetch pending bets
    let { data: pendingBets, error: betsError } = await supabase
      .from('racing_bets')
      .select('*')
      .or('status.ilike.%pending%,status.ilike.%open%,status.eq.new,status.eq.,status.eq.PENDING,status.eq.Pending');
    
    if (betsError) {
      throw new Error(`Error fetching pending bets: ${betsError.message}`);
    }
    
    Logger.info(`Found ${pendingBets?.length || 0} pending bets to process`);
    
    if (!pendingBets || pendingBets.length === 0) {
      Logger.info('No pending bets found to update.');
      return { success: true, updated: 0, total: 0 };
    }
    
    // Sample pending bet for debugging (only log one)
    Logger.debug('Sample pending bet:', pendingBets[0]);
    
    // Extract all unique track+date combinations from bets, handling multiple horses/tracks
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
        if (!track) return; // Skip empty track names
        
        uniqueTracks.add(track);
        const key = `${track}:${date}`;
        trackDateCombos.set(key, { track, date });
      });
    });
    
    Logger.info(`Found ${uniqueTracks.size} unique tracks: ${Array.from(uniqueTracks).join(', ')}`);
    Logger.info(`Need to fetch ${trackDateCombos.size} track/date combinations`);
    
    // Results tracking
    const results = {
      total: pendingBets.length,
      updated: 0,
      noMatches: 0,
      errors: 0
    };
    
    // First pass: Fetch all the track data we need with increased time between calls
    Logger.info('=== FETCHING TRACK DATA ===');
    let trackIndex = 1;
    const totalTracks = trackDateCombos.size;
    
    for (const [key, { track, date }] of trackDateCombos.entries()) {
      Logger.info(`Processing track ${trackIndex}/${totalTracks}: ${track}, date: ${date}`);
      trackIndex++;
      
      // Skip if we already have this data cached
      if (trackHorsesCache[key] && trackHorsesCache[key].length > 0) {
        Logger.info(`Using cached data for ${track} (${trackHorsesCache[key].length} horses)`);
        continue;
      }
      
      try {
        // Get the course ID for this track
        const courseId = findCourseId(track);
        
        if (courseId) {
          Logger.info(`Found course ID for ${track}: ${courseId}`);
          
          // Fetch the data from the racing API
          const horses = await fetchRaceResults(track, date, courseId);
          trackHorsesCache[key] = horses;
          
          Logger.info(`Fetched ${horses.length} horses for ${track} on ${date}`);
          if (horses.length === 0) {
            Logger.warn(`No horses found for ${track} on ${date} with ID ${courseId}`);
          }
        } else {
          Logger.error(`No course ID found for ${track} in track codes list`);
          trackHorsesCache[key] = [];
        }
        
        // Wait to avoid API rate limits - increased delay
        Logger.info(`Waiting 15 seconds before next API call...`);
        await sleep(15000); // 15-second delay between API calls
      } catch (error) {
        Logger.error(`Error fetching data for ${track} on ${date}:`, error);
        trackHorsesCache[key] = [];
      }
    }
    
    // Second pass: Process all bets with improved handling of multiple horses
    Logger.info('=== PROCESSING BETS ===');
    
    for (const bet of pendingBets) {
      try {
        if (!bet.horse_name || !bet.track_name || !bet.race_date) {
          Logger.warn(`Skipping bet ID ${bet.id} - missing required fields`);
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
        Logger.error(`Error processing bet ID ${bet.id}:`, error);
        results.errors++;
      }
    }
    
    // Print results summary
    Logger.info('=== RESULTS SUMMARY ===');
    Logger.info(`- Total bets processed: ${results.total}`);
    Logger.info(`- Matches found and updated: ${results.updated}`);
    Logger.info(`- No matches found: ${results.noMatches}`);
    Logger.info(`- Errors encountered: ${results.errors}`);
    
    return {
      success: true,
      updated: results.updated,
      total: results.total,
      noMatches: results.noMatches,
      errors: results.errors
    };
    
  } catch (error) {
    Logger.error('Error in updateBetResults:', error);
    return { success: false, error: error.message };
  }
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