# Letter Clash

A browser-based party game for **2-4 players** with two modes:

- **Online room mode**: friends join from different devices/locations using a room code.
- **Local shared-device mode**: pass one device around with private handoff screens.

## Gameplay

1. A selector chooses a letter and an opponent.
2. The opponent has **60 seconds** to submit:
   - Name
   - Place (city/country)
   - Animal
   - Random Thing
3. Scoring is automatic:
   - Participation points (even with blanks)
   - Points per valid answer (starts with selected letter)
   - Speed bonus for faster submissions
   - Bonus for all 4 correct
   - Streak bonus for back-to-back full clears
4. The match ends when each player reaches the configured rounds (default 5), then final leaderboard is shown.

## Run locally

```bash
npm install
npm start
```

Open: `http://localhost:3000`

## Play online with friends

Deploy this app to any Node host (Render, Railway, Fly.io, etc.) and share the public URL.
Friends can join in browser with the room code.

## Tech

- Node.js + Express
- Socket.IO for real-time multiplayer
- Vanilla HTML/CSS/JS frontend
