// Hand-built fixtures shaped like the GitHub REST responses the source consumes.
// Trimmed to the fields the mapper reads, plus a few it must ignore.

export const authoredPr = {
  number: 42,
  title: 'Add retry to the payment client',
  body: 'Yesterday I finished the retry logic and deployed it to staging.',
  state: 'closed',
  html_url: 'https://github.com/octo/payments/pull/42',
  repository_url: 'https://api.github.com/repos/octo/payments',
  created_at: '2026-08-20T09:15:00Z',
  updated_at: '2026-08-22T11:00:00Z',
  user: { login: 'janedoe' },
  pull_request: { merged_at: '2026-08-22T10:45:00Z' },
};

export const openPr = {
  number: 43,
  title: 'Refactor the settlement job',
  body: 'Splitting this out of #42. No date references here.',
  state: 'open',
  html_url: 'https://github.com/octo/payments/pull/43',
  repository_url: 'https://api.github.com/repos/octo/payments',
  created_at: '2026-08-25T14:00:00Z',
  updated_at: '2026-08-25T14:00:00Z',
  user: { login: 'janedoe' },
  pull_request: { merged_at: null },
};

export const issueThread = {
  number: 91,
  title: 'Settlement totals drift by a cent',
  html_url: 'https://github.com/octo/payments/issues/91',
  repository_url: 'https://api.github.com/repos/octo/payments',
  created_at: '2026-08-10T08:00:00Z',
  updated_at: '2026-08-28T16:30:00Z',
  user: { login: 'someone-else' },
  // no `pull_request` key -> this is an issue, not a PR
};

export const ownComment = {
  id: 555001,
  body: 'Last Friday I traced this to the rounding helper. Fix incoming.',
  html_url: 'https://github.com/octo/payments/issues/91#issuecomment-555001',
  created_at: '2026-08-28T16:30:00Z',
  updated_at: '2026-08-28T16:30:00Z',
  user: { login: 'janedoe' },
};

export const otherPersonsComment = {
  id: 555002,
  body: 'Thanks! Yesterday I saw the same thing.',
  html_url: 'https://github.com/octo/payments/issues/91#issuecomment-555002',
  created_at: '2026-08-28T17:00:00Z',
  updated_at: '2026-08-28T17:00:00Z',
  user: { login: 'someone-else' },
};

export const staleComment = {
  id: 554000,
  body: 'An older note from before the sync window.',
  html_url: 'https://github.com/octo/payments/issues/91#issuecomment-554000',
  created_at: '2026-07-01T09:00:00Z',
  updated_at: '2026-07-01T09:00:00Z',
  user: { login: 'janedoe' },
};

export const reviewedPr = {
  number: 77,
  title: "Tighten the ledger's decimal handling",
  html_url: 'https://github.com/octo/ledger/pull/77',
  repository_url: 'https://api.github.com/repos/octo/ledger',
  created_at: '2026-08-26T09:00:00Z',
  updated_at: '2026-08-27T12:00:00Z',
  user: { login: 'someone-else' },
  pull_request: { merged_at: null },
};

export const ownReview = {
  id: 777001,
  state: 'APPROVED',
  body: 'Looks right. Checked the rounding cases.',
  html_url: 'https://github.com/octo/ledger/pull/77#pullrequestreview-777001',
  submitted_at: '2026-08-27T12:00:00Z',
  user: { login: 'janedoe' },
};

export const commitItem = {
  sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  html_url: 'https://github.com/octo/payments/commit/a1b2c3d',
  commit: {
    message: 'Fix rounding in settlement totals\n\nLonger body text here.',
    author: { date: '2026-08-27T08:12:00Z' },
  },
  repository: { name: 'payments', owner: { login: 'octo' } },
};
