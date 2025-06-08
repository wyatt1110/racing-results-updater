# Master Results Population Script

This script populates the `master_results` table with comprehensive data for machine learning purposes by combining data from multiple sources.

## Overview

The master results table is designed to be a comprehensive dataset containing:
- Race results from the Racing API
- Pre-race data from racecard tables (races, runners, odds)
- Betfair exchange data (BSP) from UK and Ireland BSP tables
- Calculated machine learning features

## Data Sources

1. **Racing API Results** (`https://api.theracingapi.com/v1/results`)
   - Race information and post-race results
   - Starting prices, finishing positions, times
   - Tote returns, race comments

2. **Supabase Tables**
   - `races` - Race conditions, course info, prize money
   - `runners` - Horse details, connections, technical analysis
   - `odds` - Opening odds, odds history, place odds for all bookmakers

3. **BSP Tables**
   - `uk_bsp` - UK Betfair Starting Prices and market data
   - `ireland_bsp` - Ireland Betfair Starting Prices and market data

## Script Functionality

### Main Functions

- `fetchRacingResults(date)` - Gets results from Racing API
- `getRunnerData(raceId, horseId)` - Fetches runner data from database
- `getRaceData(raceId)` - Fetches race data from database  
- `getOddsData(raceId, horseId)` - Fetches odds data from database
- `getBspData(horseName, raceDate, region)` - Fetches BSP data
- `buildMasterResultsRow()` - Combines all data into final row
- `processResults()` - Main processing loop

### Key Features

- **Dual Mode Operation**: Insert mode (first run) and Update mode (second run)
- **Data Validation**: Checks for existing records to avoid duplicates
- **Error Handling**: Continues processing even if individual records fail
- **Comprehensive Mapping**: Maps 80+ columns from various sources
- **Machine Learning Ready**: Includes calculated features like win/place flags

## Usage

### Manual Execution

```bash
# First run (insert new records)
npm run populate-master-results

# Second run (update existing records with new data)
npm run populate-master-results-update
```

### Automated Execution

The script runs automatically twice daily via GitHub Actions:

1. **02:00 UTC** (Insert mode) - Processes yesterday's results
2. **08:00 UTC** (Update mode) - Updates any missing data

### Environment Variables

Required environment variables:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_KEY` - Supabase service role key

## Data Processing Logic

### Date Handling
- Always processes the previous day's data (yesterday)
- Uses `YYYY-MM-DD` format for date queries

### Record Matching
- Matches race results to racecard data by `race_id` and `horse_id`
- BSP data matched by horse name and race date (fuzzy matching)

### Data Mapping

#### From Racing API Results:
- Race details (course, date, going, distance, etc.)
- Runner results (position, SP, beaten lengths, times, etc.)
- Tote returns and race comments

#### From Racecard Tables:
- Pre-race odds (opening, history, places) for 30+ bookmakers
- Technical analysis (moving averages, support/resistance)
- Horse breeding and connections data
- Race conditions and restrictions

#### From BSP Tables:
- Betfair Starting Price (BSP)
- Pre-post WAP, Morning WAP
- Maximum and minimum traded prices
- Volume data

### Calculated Fields

The script automatically calculates machine learning features:
- `win_flag` - True if horse won (position = 1)
- `place_flag` - True if horse placed (position 1-3)
- `favorite_indicator` - 'F' if horse was favorite
- `beaten_distance_numeric` - Numeric version of beaten lengths
- Opening prices mentioned in comments
- Price movements and market pressure indicators

## Table Structure

The master_results table contains approximately 80+ columns:

### Race Information (25+ columns)
- Basic race details, conditions, prize money
- Course, date, distance, going, surface

### Runner Information (30+ columns)  
- Horse details, breeding, connections
- Pre-race form and ratings

### Odds Data (40+ columns)
- Opening odds for all major bookmakers
- Complete odds history 
- Place odds

### Results Data (15+ columns)
- Finishing position, starting price
- Times, beaten lengths, prize money
- Tote returns

### BSP Data (10+ columns)
- Exchange prices and volume data
- Market liquidity indicators

### ML Features (10+ columns)
- Calculated flags and indicators
- Derived market metrics

## Error Handling

- **Missing Data**: Script continues if some data sources are unavailable
- **Duplicate Prevention**: Checks existing records before inserting
- **Graceful Failures**: Individual record failures don't stop processing
- **Comprehensive Logging**: Detailed console output for monitoring

## Performance

- Processes ~100-200 runners per day typically
- Includes 100ms delays between records to avoid DB overload
- 30-minute timeout for large datasets
- Parallel data fetching where possible

## Monitoring

Check the GitHub Actions logs for:
- Number of races processed
- Insert/update counts
- Error summaries
- Processing time

## Troubleshooting

### Common Issues

1. **Missing Environment Variables**
   - Ensure SUPABASE_URL and SUPABASE_SERVICE_KEY are set

2. **API Rate Limits**
   - Racing API has limits - script includes delays

3. **Database Timeouts**
   - Large datasets may need longer timeouts

4. **BSP Matching Failures**
   - Horse name variations can cause BSP lookup failures
   - This is expected for some horses

### Manual Debugging

```bash
# Test with specific date
node populate-master-results.js --date=2024-01-15

# Run in update mode
node populate-master-results.js --update

# Check logs in GitHub Actions
```

## Future Enhancements

Potential improvements:
- Better BSP horse name matching algorithms
- Additional calculated ML features
- Performance optimizations for large datasets
- Integration with live race feeds
- Automated data quality checks 