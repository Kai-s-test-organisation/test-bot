import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// --- Configuration from Environment Variables ---
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET!;
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
export const REDIS_URL = process.env.REDIS_URL!;
const REVIEWER_GROUP_CHANNEL_MAP_RAW = process.env.REVIEWER_GROUP_CHANNEL_MAP || '{}';
const GITHUB_TO_SLACK_USER_MAP_RAW = process.env.GITHUB_TO_SLACK_USER_MAP || '{}';
const TWO_APPROVAL_REPOS_RAW = process.env.TWO_APPROVAL_REPOS_LIST || '';
export const PORT = parseInt(process.env.PORT || '3000', 10)!;

// Validate essential environment variables
if (!GITHUB_WEBHOOK_SECRET || !SLACK_BOT_TOKEN || !REDIS_URL || !REVIEWER_GROUP_CHANNEL_MAP_RAW || !GITHUB_TO_SLACK_USER_MAP_RAW || !TWO_APPROVAL_REPOS_RAW) {
    console.error("ERROR: Missing essential environment variables. Check .env file.");
    process.exit(1);
}

// Parse JSON mappings
export const REVIEWER_GROUP_CHANNEL_MAP: { [key: string]: string } = JSON.parse(REVIEWER_GROUP_CHANNEL_MAP_RAW)!;
export const GITHUB_TO_SLACK_USER_MAP: { [key: string]: string } = JSON.parse(GITHUB_TO_SLACK_USER_MAP_RAW)!;

// Parse the comma-separated string into a Set for efficient lookups
export const TWO_APPROVAL_REPOS = new Set(
    TWO_APPROVAL_REPOS_RAW
        .split(',')              // Split the string into an array
        .map(repo => repo.trim()) // Trim any whitespace from each repo name
        .filter(Boolean)         // Remove any empty strings that might result from trailing commas
);

// Emoji constants
export const MERGED = "merged"
export const APPROVED = "white_check_mark"
export const CLOSED = "x"
export const COMMENTED = "speech_balloon"
export const READY_TO_MERGE = "rocket"
export const PARTIAL_APPROVAL = "one"
export const NEEDS_REVIEW = "warning"

// Other constants
export const THREE_DAYS_IN_SECONDS = 259200
