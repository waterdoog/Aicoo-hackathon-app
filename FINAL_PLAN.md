# Final Plan: Aicoo Event Cards

## Product One-Liner

Aicoo Event Cards lets anyone create an event or hackathon where participants register with a short form, automatically get an Aicoo shared agent link, and appear as interactive people cards in the event square. Project submissions use the same pattern: a short form creates a submission post that appears in the submissions board.

## Core Product Shape

The MVP has two main areas:

1. People / Register
   - Register as yourself for an event.
   - Generate an Aicoo agent card from a simple form.
   - Browse participant cards.
   - Click a participant to chat with their agent, book a meeting, or copy the link.

2. Submit / Submissions
   - Submit a project through a simple form.
   - Generate a submission post.
   - Browse project submissions.
   - Click a submission to view details, authors, links, and Aicoo usage.

## User Flow

Event participant:

```txt
Open event link
-> Login with Aicoo
-> Fill simple registration form
-> Generate shared agent card
-> Card appears in People board
-> Others can chat, book, or copy the agent link
```

Project team:

```txt
Open Submit Project
-> Fill project form
-> Submit project
-> Project appears in Submissions board
-> Others can view demo, GitHub, authors, and team agent
```

Organizer:

```txt
Create event
-> Share event/register/submit links
-> Participants become cards automatically
-> Projects become submission cards automatically
-> Event square becomes the live coordination surface
```

## MVP Scope

Build now:

- Event landing surface
- Login with Aicoo CTA
- People board
- Participant registration form
- Auto-generated participant card
- Participant detail panel
- Chat agent, book meeting, copy link actions
- Project submit form
- Submissions board
- Submission detail panel
- Responsive mobile preview

Defer:

- Judge scoring
- Advanced matching
- Team workspace
- Analytics
- Complex agent-to-agent group workflows
- Full backend persistence

## Data Model

```ts
type ParticipantCardPost = {
  type: "participant_card";
  eventId: string;
  title: string;
  content: string;
  metadata: {
    name: string;
    role: string;
    company: string;
    timezone: string;
    intro: string;
    skills: string[];
    lookingForTeam: boolean;
    lookingFor: string[];
    agentName: string;
    sharedAgentLink: string;
    github?: string;
    linkedin?: string;
    website?: string;
  };
};

type SubmissionPost = {
  type: "submission";
  eventId: string;
  title: string;
  content: string;
  metadata: {
    projectName: string;
    oneLiner: string;
    description: string;
    track?: string;
    authors: string[];
    githubUrl?: string;
    demoUrl?: string;
    deckUrl?: string;
    videoUrl?: string;
    aicooUsage?: string;
    sharedProjectLink?: string;
  };
};
```

## Recommended Routes

```txt
/events
/events/create
/events/[slug]
/events/[slug]/people
/events/[slug]/register
/events/[slug]/submit
/events/[slug]/submissions
/events/[slug]/submissions/[id]
```

For the prototype, these routes are represented as tabs and panels inside one static page.

## Design Direction

The UI should feel like:

- Linear clarity
- Devpost event structure
- LinkedIn-style people cards
- Aicoo agent-first actions
- Light cyberpunk energy without becoming a game UI

Visual system:

- Background: near-black and Oxford blue
- Primary: fluorescent blue
- Accent: electric cyan
- Cards: dark glass surfaces with 1px blue borders
- Badges: cyan, green, and amber states
- Avatars: pixel-style agent identity

## Implementation Plan

1. Create a static prototype shell with event navigation, hero, boards, forms, detail panels, and mobile preview.
2. Seed realistic participant and submission data.
3. Implement client-side state for filters, search, selected cards, registration, project submission, and copy actions.
4. Store new cards in memory for the current session and immediately render them in the relevant board.
5. Keep code portable so the frontend can later be wired to Aicoo auth, Subsquare post APIs, and shared agent link creation.

