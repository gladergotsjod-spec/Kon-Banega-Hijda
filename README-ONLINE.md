# KON BANEGA HIJDA — Online Version

This version is designed to run on a public Node.js Web Service such as Render. The iPhone is a host/admin client; the server itself runs online.

## Render settings
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/`

The server already uses `process.env.PORT` and binds to `0.0.0.0`, which is required by Render.

## Game flow
1. Open the public URL on iPhone.
2. Enter your name and tap Create Room.
3. Share the room code.
4. Other players join from any phone/PC anywhere on the Internet.
5. Host starts after everyone has selected a unique secret number.

## Important
Rooms are kept in server memory. A service restart/redeploy clears active rooms. For a small game this is acceptable; a persistent production version would use a database/room store.
