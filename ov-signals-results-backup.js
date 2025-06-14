const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/**
 * Calculate returns and profit/loss based on result
 */
function calculateReturnsAndProfitLoss(result, stake, odds) {
    const stakeNum = parseFloat(stake) || 0;
    const oddsNum = parseFloat(odds) || 0;
    
    if (result === 'won') {
        const returns = stakeNum * oddsNum;
        const profit_loss = returns - stakeNum;
        return { returns: returns.toFixed(2), profit_loss: profit_loss.toFixed(2) };
    } else if (result === 'void') {
        return { returns: stakeNum.toFixed(2), profit_loss: '0.00' };
    } else {
        // Loss
        return { returns: '0.00', profit_loss: (-stakeNum).toFixed(2) };
    }
}

/**
 * Determine result based on position and other factors
 */
function determineResult(position, isAbandoned, isNonRunner) {
    if (isAbandoned || isNonRunner) {
        return 'void';
    }
    
    if (position === '1') {
        return 'won';
    } else {
        return 'loss';
    }
}

/**
 * Check if horse is a non-runner by checking if horse name appears in non_runners field
 */
function isHorseNonRunner(horseName, nonRunnersText) {
    if (!nonRunnersText || !horseName) return false;
    
    // Convert both to lowercase for case-insensitive matching
    const nonRunners = nonRunnersText.toLowerCase();
    const horse = horseName.toLowerCase();
    
    // Check if horse name appears anywhere in the non_runners text
    return nonRunners.includes(horse);
}

/**
 * Main function to update OV signals results
 */
async function updateOVSignalsResults() {
    try {
        console.log('🚀 Starting OV Signals Results Update...');
        
        // Step 1: Get incomplete entries from ov_signals
        console.log('📊 Fetching incomplete entries from ov_signals...');
        const { data: incompleteEntries, error: fetchError } = await supabase
            .from('ov_signals')
            .select('*')
            .or('result.eq.pending,bsp.is.null');
        
        if (fetchError) {
            console.error('❌ Error fetching incomplete entries:', fetchError);
            return;
        }
        
        if (!incompleteEntries || incompleteEntries.length === 0) {
            console.log('✅ No incomplete entries found. All entries are up to date.');
            return;
        }
        
        console.log(`📋 Found ${incompleteEntries.length} incomplete entries to process`);
        
        let processed = 0;
        let updated = 0;
        let skipped = 0;
        
        // Step 2: Process each incomplete entry
        for (const entry of incompleteEntries) {
            processed++;
            console.log(`\n🔄 Processing entry ${processed}/${incompleteEntries.length}: ${entry.horse_name} (Race: ${entry.race_id})`);
            
            try {
                // Step 3: Find matching entry in master_results
                const { data: masterResults, error: masterError } = await supabase
                    .from('master_results')
                    .select('*')
                    .eq('horse_id', entry.horse_id)
                    .eq('race_id', entry.race_id)
                    .single();
                
                if (masterError || !masterResults) {
                    console.log(`⚠️  No matching entry found in master_results for ${entry.horse_name}`);
                    skipped++;
                    continue;
                }
                
                console.log(`✅ Found matching master_results entry for ${entry.horse_name}`);
                
                // Step 4: Determine if this is a void bet due to race abandonment
                const isAbandoned = masterResults.is_abandoned === true;
                
                // Step 5: Check if horse is a non-runner
                const isNonRunner = isHorseNonRunner(entry.horse_name, masterResults.non_runners);
                
                // Step 6: Determine result
                const result = determineResult(masterResults.position, isAbandoned, isNonRunner);
                
                // Step 7: Calculate returns and profit/loss
                const { returns, profit_loss } = calculateReturnsAndProfitLoss(result, entry.stake, entry.odds);
                
                // Step 8: Prepare update data
                const updateData = {
                    result: result,
                    finish_position: masterResults.position,
                    returns: parseFloat(returns),
                    profit_loss: parseFloat(profit_loss)
                };
                
                // Step 9: Add SP if available
                if (masterResults.sp_dec !== null && masterResults.sp_dec !== undefined) {
                    updateData.sp = masterResults.sp_dec;
                }
                
                // Step 10: Add BSP if available
                if (masterResults.bsp !== null && masterResults.bsp !== undefined) {
                    updateData.bsp = masterResults.bsp;
                }
                
                // Step 11: Update the entry
                const { error: updateError } = await supabase
                    .from('ov_signals')
                    .update(updateData)
                    .eq('id', entry.id);
                
                if (updateError) {
                    console.error(`❌ Error updating entry ${entry.id}:`, updateError);
                    continue;
                }
                
                updated++;
                console.log(`✅ Updated ${entry.horse_name}:`);
                console.log(`   - Result: ${result}`);
                console.log(`   - Position: ${masterResults.position}`);
                console.log(`   - Returns: £${returns}`);
                console.log(`   - Profit/Loss: £${profit_loss}`);
                if (updateData.sp) console.log(`   - SP: ${updateData.sp}`);
                if (updateData.bsp) console.log(`   - BSP: ${updateData.bsp}`);
                if (isAbandoned) console.log(`   - Race was abandoned`);
                if (isNonRunner) console.log(`   - Horse was a non-runner`);
                
            } catch (error) {
                console.error(`❌ Error processing entry ${entry.id}:`, error);
                continue;
            }
        }
        
        // Step 12: Summary
        console.log('\n📊 Update Summary:');
        console.log(`   - Total processed: ${processed}`);
        console.log(`   - Successfully updated: ${updated}`);
        console.log(`   - Skipped (no master data): ${skipped}`);
        console.log(`   - Errors: ${processed - updated - skipped}`);
        
        if (updated > 0) {
            console.log(`\n✅ Successfully updated ${updated} entries!`);
        } else {
            console.log('\n⚠️  No entries were updated.');
        }
        
    } catch (error) {
        console.error('💥 Fatal error in updateOVSignalsResults:', error);
        process.exit(1);
    }
}

/**
 * Entry point
 */
async function main() {
    const startTime = new Date();
    console.log(`🕐 Starting at: ${startTime.toISOString()}`);
    
    try {
        await updateOVSignalsResults();
    } catch (error) {
        console.error('💥 Fatal error:', error);
        process.exit(1);
    }
    
    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;
    console.log(`\n🕐 Completed at: ${endTime.toISOString()}`);
    console.log(`⏱️  Total duration: ${duration.toFixed(2)} seconds`);
}

// Run the script
if (require.main === module) {
    main();
}

module.exports = { updateOVSignalsResults }; 