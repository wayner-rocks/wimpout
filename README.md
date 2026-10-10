# Cosmic Wimpout Online

Tiny multiplayer dice game. One Node process serves the web page and handles live play over WebSockets. No database, no build step.

## Run it
```
npm install
npm start          # http://localhost:3000   (PORT=8080 npm start to change)
npm test           # rules-engine tests
```
Needs Node 18+.

## Share with friends
1. Host it somewhere that can run Node and allows WebSockets (home server, VPS, Raspberry Pi, Fly.io, etc).
2. Put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel). Phones need HTTPS for Add to Home Screen, and the page auto-switches to wss://.
   - Caddy example: `yourdomain.com { reverse_proxy localhost:3000 }`
   - Nginx needs `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`
3. One person taps **Create a game** and shares the 4-letter code. Friends tap **Join a game**.
4. Keep it alive with `pm2 start server.js --name wimpout` (or systemd/Docker).

On iPhone: Share > Add to Home Screen. On Android: menu > Install app.

## Tweaking the rules
All scoring is in `game.js` (`FACES`, `FLASH`, `FREIGHT`, `OPEN_MIN`). Games live in server memory and are cleared after 6 idle hours or on restart.

## Docker (optional)
```
docker build -t wimpout . && docker run -d --restart unless-stopped -p 3000:3000 --name wimpout wimpout
```

## Art
Generated images live in `public/img/` (dice faces `die_*.png`, `bg.jpg`, `logo.jpg`); app icons are `public/icon-*.png`. Swap any file for your own with the same name. Mute button is top-right in the game.
