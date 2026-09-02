// Shaped directly from the Microsoft Learn REST API v7.1 documentation examples
// (organization "fabrikam"), trimmed to the fields the mapper reads.

export const ME = { id: 'd6245f20-2af8-44f4-9451-8107cb2767db', displayName: 'Normal Paulk', emailAddress: 'normal.paulk@fabrikam.example' };
const OTHER = { id: '41113706-4320-4083-9151-925feb93fc22', displayName: 'Someone Else', uniqueName: 'someone@fabrikam.example' };

const repo = (project) => ({
  id: '3411ebc1-d5aa-464f-9615-0b527bc66719', name: 'payments',
  project: { id: 'a7573007-bbb3-4341-b726-0c4148a07853', name: project },
});

export const mergedPr = {
  pullRequestId: 22, codeReviewId: 22, status: 'completed',
  createdBy: { id: ME.id, displayName: ME.displayName },
  creationDate: '2026-08-20T09:15:00Z',
  closedDate: '2026-08-22T10:45:00Z',
  title: 'Add retry to the payment client',
  description: 'Yesterday I finished the retry logic and deployed it to staging.',
  repository: repo('Payments'),
};

export const activePr = {
  pullRequestId: 23, codeReviewId: 23, status: 'active',
  createdBy: { id: ME.id, displayName: ME.displayName },
  creationDate: '2026-08-25T14:00:00Z',
  title: 'Refactor the settlement job',
  description: 'No date references here.',
  repository: repo('Payments'),
};

// A PR authored by someone else, that I reviewed.
export const reviewedPr = {
  pullRequestId: 77, codeReviewId: 77, status: 'active',
  createdBy: OTHER,
  creationDate: '2026-08-26T09:00:00Z',
  title: "Tighten the ledger's decimal handling",
  description: 'Some other change.',
  repository: repo('Ledger'),
};

export const threadsForMergedPr = [
  {
    id: 148, publishedDate: '2026-08-21T12:00:00Z',
    comments: [{
      id: 1, author: ME, content: 'Looks right, one nit below.',
      publishedDate: '2026-08-21T12:00:00Z', commentType: 'text',
    }],
  },
  {
    id: 149, publishedDate: '2026-08-22T10:30:00Z',
    comments: [{
      id: 1, author: OTHER, content: 'Thanks for the review!',
      publishedDate: '2026-08-22T10:30:00Z', commentType: 'text',
    }],
  },
];

export const threadsForReviewedPr = [
  {
    id: 150, publishedDate: '2026-08-27T12:00:00Z',
    comments: [{
      id: 1, author: ME, content: 'Normal Paulk voted 10',
      publishedDate: '2026-08-27T12:00:00Z', commentType: 'system',
    }],
  },
];

export const wiqlResult = { workItems: [{ id: 299, url: 'https://dev.azure.com/fabrikam/_apis/wit/workItems/299' }] };

export const workItemBatch = {
  value: [{
    id: 299,
    fields: {
      'System.Id': 299,
      'System.Title': 'Fix settlement rounding drift',
      'System.State': 'Resolved',
      'System.WorkItemType': 'Bug',
      'System.TeamProject': 'Payments',
      'System.CreatedDate': '2026-08-15T08:00:00Z',
      'System.CreatedBy': { id: ME.id, displayName: ME.displayName },
      'System.ChangedDate': '2026-08-22T09:00:00Z',
    },
    url: 'https://dev.azure.com/fabrikam/_apis/wit/workItems/299',
  }],
};

export const workItemComments = {
  comments: [
    { id: 45, text: 'Last Friday I traced this to the rounding helper.', createdBy: ME, createdDate: '2026-08-21T20:12:00Z' },
    { id: 44, text: 'Someone else looking at this too.', createdBy: OTHER, createdDate: '2026-08-20T23:26:00Z' },
  ],
  continuationToken: null,
};

// Shaped from a real /updates response, not the documented example. Two details the
// documentation's tidy sample does not show, and both of which produced wrong data:
//
//   1. `revisedDate` on a revision is when that revision STOPPED being current, so
//      it equals the *next* revision's System.ChangedDate. Note rev 2's revisedDate
//      below matching rev 3's ChangedDate.
//   2. On the newest revision `revisedDate` is the year-9999 sentinel, meaning "not
//      superseded", not a date at all.
//
// System.ChangedDate on the same revision is when the change was actually made.
export const workItemUpdates = {
  value: [
    {
      id: 1, rev: 1, revisedBy: ME, revisedDate: '2026-08-22T09:00:00Z',
      fields: { 'System.ChangedDate': { newValue: '2026-08-15T08:00:00Z' }, 'System.State': { newValue: 'New' } },
    },
    {
      id: 2, rev: 2, revisedBy: ME, revisedDate: '2026-08-23T09:00:00Z',
      fields: { 'System.ChangedDate': { newValue: '2026-08-22T09:00:00Z' }, 'System.State': { oldValue: 'Active', newValue: 'Resolved' } },
    },
    {
      // The current revision, carrying the sentinel.
      id: 3, rev: 3, revisedBy: OTHER, revisedDate: '9999-01-01T00:00:00Z',
      fields: { 'System.ChangedDate': { newValue: '2026-08-23T09:00:00Z' }, 'System.State': { oldValue: 'Resolved', newValue: 'Closed' } },
    },
  ],
};

export const deployments = {
  value: [{
    id: 79,
    release: { id: 55, name: 'Release-2' },
    releaseEnvironment: { id: 118, name: 'PROD' },
    deploymentStatus: 'succeeded',
    requestedFor: ME,
    queuedOn: '0001-01-01T00:00:00',
    startedOn: '2026-08-29T16:51:32.09Z',
    lastModifiedOn: '2026-08-29T16:55:00.133Z',
    url: 'https://vsrm.dev.azure.com/fabrikam/MyFirstProject/_apis/Release/deployments/79',
  }],
};
