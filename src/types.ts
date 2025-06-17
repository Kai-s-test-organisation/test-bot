
// Type for message metadata
export interface PrSlackMessage {
    slackMessages: {
        channel: string;
        ts: string;
    }[]
    repoFullName: string;
    approvals: Set<string>;
    changesRequested: Set<string>;
    botReactions: Set<string>;
}

// Has more fields but we don't need em.
export interface SlackSlashCommandPayload {
    user_id: string
    channel_id: string
    text: string
}