# Racing Results Updater

An automated system to update betting results by fetching race results from The Racing API and updating bets in a Supabase database.

## Features

- Fetches race results from The Racing API
- Processes pending bets to mark them as settled
- Calculates win/loss based on horse performance
- Updates the Supabase database with results
- Runs automatically via GitHub Actions on an hourly schedule

## Setup

1. Clone this repository
2. Install dependencies: `npm install`
3. Set up the following environment variables:
   - `SUPABASE_URL`: Your Supabase project URL
   - `SUPABASE_KEY`: Your Supabase service role key
   - `RACING_API_USERNAME`: Your Racing API username
   - `RACING_API_PASSWORD`: Your Racing API password

## Usage

### Manual Run

```bash
node bet-results-updater.js
```

### GitHub Actions

The repository is configured to run hourly from 1 PM to 11 PM UTC via GitHub Actions. The workflow can also be triggered manually through the GitHub Actions interface.

## Setting Up GitHub Actions Secrets

To run this in GitHub Actions, you need to set up the following secrets in your repository:

1. Go to your repository → Settings → Secrets and variables → Actions
2. Add the following secrets:
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - `RACING_API_USERNAME`
   - `RACING_API_PASSWORD`