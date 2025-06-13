# OV Signals Results Updater

This script updates the results for value bets stored in the `ov_signals` table by matching them with race results from the `master_results` table.

## Overview

The OV Signals Results Updater processes incomplete betting entries and fills in their results based on actual race outcomes. It handles win/loss calculations, returns, profit/loss, starting prices, and BSP (Betfair Starting Price) data.

## How It Works

### 1. Identifies Incomplete Entries
The script searches for entries in the `ov_signals` table where:
- `result` field is 'pending' OR
- `bsp` field is null

### 2. Matches with Master Results
For each incomplete entry, it finds the corresponding race result in the `master_results` table using:
- `horse_id` - Unique identifier for the horse
- `race_id` - Unique identifier for the race

### 3. Updates Results
The script updates the following fields in `ov_signals`:

| Field | Source | Description |
|-------|--------|-------------|
| `result` | Calculated | 'won', 'loss', or 'void' |
| `finish_position` | `master_results.position` | Horse's finishing position |
| `returns` | Calculated | Stake × odds (if won), stake (if void), 0 (if loss) |
| `profit_loss` | Calculated | Returns - stake |
| `sp` | `master_results.sp_dec` | Starting Price (decimal) |
| `bsp` | `master_results.bsp` | Betfair Starting Price |

## Result Determination Logic

### Won
- Horse finished in 1st position (`position = '1'`)
- Returns = stake × odds
- Profit/Loss = returns - stake

### Loss
- Horse finished in any position other than 1st
- Includes special positions like 'PU' (Pulled Up), 'UR' (Unseated Rider)
- Returns = 0
- Profit/Loss = -stake

### Void
- Race was abandoned (`is_abandoned = true`)
- Horse was a non-runner (horse name appears in `non_runners` field)
- Returns = stake (money back)
- Profit/Loss = 0

## Special Handling

### Abandoned Races
If `is_abandoned` is true in the master results, all bets for that race are voided.

### Non-Runners
The script checks if the horse name appears anywhere in the `non_runners` field. If found, the bet is voided.

### Incomplete Data
If a master result is missing BSP data, the script will:
1. Update all available fields
2. Leave BSP as null
3. Process the entry again in the next run when BSP data becomes available

## Schedule

The script runs automatically via GitHub Actions:
- **8:00 AM UTC** (9:00 AM BST / 8:00 AM GMT)
- **8:00 PM UTC** (9:00 PM BST / 8:00 PM GMT)

Can also be triggered manually through the GitHub Actions interface.

## Environment Variables

The script requires the following environment variables:

```env
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_KEY=your_supabase_service_role_key
```

## Usage

### Local Development
```bash
# Install dependencies
npm install

# Set environment variables in .env file
# Run the script
node ov-signals-results.js
```

### Manual GitHub Actions Run
1. Go to the repository's Actions tab
2. Select "OV Signals Results Updater"
3. Click "Run workflow"
4. Click "Run workflow" again to confirm

## Example Output

```
🚀 Starting OV Signals Results Update...
📊 Fetching incomplete entries from ov_signals...
📋 Found 25 incomplete entries to process

🔄 Processing entry 1/25: Thunder Storm (Race: race_123)
✅ Found matching master_results entry for Thunder Storm
✅ Updated Thunder Storm:
   - Result: won
   - Position: 1
   - Returns: £55.00
   - Profit/Loss: £45.00
   - SP: 4.5
   - BSP: 4.2

📊 Update Summary:
   - Total processed: 25
   - Successfully updated: 23
   - Skipped (no master data): 2
   - Errors: 0

✅ Successfully updated 23 entries!
```

## Database Schema

### OV Signals Table Fields (Updated by Script)
- `result` (text): 'won', 'loss', 'void'
- `finish_position` (text): Horse's finishing position
- `returns` (numeric): Calculated returns
- `profit_loss` (numeric): Calculated profit/loss
- `sp` (numeric): Starting Price
- `bsp` (numeric): Betfair Starting Price

### Master Results Table Fields (Used by Script)
- `position` (text): Horse's finishing position
- `sp_dec` (numeric): Starting Price in decimal format
- `bsp` (numeric): Betfair Starting Price
- `is_abandoned` (boolean): Whether the race was abandoned
- `non_runners` (text): List of non-running horses

## Error Handling

The script includes comprehensive error handling:
- Continues processing even if individual entries fail
- Logs detailed error messages for debugging
- Provides summary statistics at completion
- Gracefully handles missing data scenarios

## Monitoring

Each run produces detailed logs showing:
- Number of entries processed
- Success/failure counts
- Detailed update information for each entry
- Error messages for failed updates
- Total execution time 