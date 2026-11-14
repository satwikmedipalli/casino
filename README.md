# Casino

Poker for friends, played in the browser and added to the iPhone home screen.
The dealer rotates every hand and picks the game: Texas Hold'em, Irish, 3 Card, AK47,
Triple 9, Triple 9 Custom, 5 Card Omaha, 6 Card Omaha, Double Board and High-Low.

```
npm install
npm run dev      # server on :3001, app on :5173 (open from phones on the same Wi-Fi)
npm test         # game engine tests
npm run build && npm start   # production: one server on $PORT serves app + game
```

The server deals and keeps every player's cards; each phone only receives its own.
Play chips only.
