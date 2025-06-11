// Type for Redis Stored Data
export interface PrSlackMessageInfo {
    channel: string;
    ts: string;
    repoFullName: string; // needed for TWO_APPROVAL_REPOS check
    approvals: Set<string>; // Track who has approved
    changesRequested: Set<string>; // Track who requested changes
    botReactions: Set<string>; // Track current reactions on the message
}