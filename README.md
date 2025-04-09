# Racing Results Updater

Automatic system for updating racing bet results using The Racing API.

## How it Works

This script performs the following:

1. Fetches pending bets from Supabase
2. Groups bets by track and date
3. Makes separate API calls for each track/date combination
4. Matches horses using multiple matching strategies
5. Updates bet results in Supabase

## Key Features

- Track-specific API calls to reduce data volume
- 15-second delay between API calls
- Course ID lookup for precise filtering
- Multiple matching strategies for horses
- Detailed logging and debugging

## Usage

```
node bet-results-updater.js
```

## Alternative Scripts

The repository also includes additional scripts for different approaches:

- `track-specific-updater.js` - Alternative implementation with similar functionality
- `alternative-api-approach.js` - Another approach using date-specific API calls
- `inspect-api-structure.js` - Utility to analyze API response structure