// === src/types.ts ===
export interface PrSlackMessageInfo {
    channel: string;
    ts: string;
    prLink: string;
    prTitle: string;
    prCreatorGithub: string;
    repoFullName: string;
    requestedReviewersGithub: { login: string }[];
    activities: string[];
    currentStatus: string;
    approvals: Set<string>;
    changesRequested: Set<string>;
}

export interface StoredPrInfo {
    channel: string;
    ts: string;
    prLink: string;
    prTitle: string;
    prCreatorGithub: string;
    repoFullName: string;
    requestedReviewersGithub: { login: string }[];
    activities: string[];
    currentStatus: string;
    approvals: string[];
    changesRequested: string[];
}