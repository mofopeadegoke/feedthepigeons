# Pigeon Feeder

A small, delightful website: you feed pigeons bread. Come back every day and you build a streak. A worldwide counter shows how many crumbs everyone has tossed in the last 24 hours.

This is a design-engineering portfolio piece. How it feels matters more than how many features it has.

## Decisions already made (don't change these)

### Core
- **Worldwide counter counts every crumb tossed**, across all visitors (including crumbs no pigeon eats).
- **The counter is a rolling 24 hours.** It shows crumbs tossed in the last 24 hours, never a midnight reset.
- **The streak is stored in the browser only.** No accounts, no login, no sign-in. If someone clears their data, their streak is gone, and that's accepted.

### Look and rendering
- **Plain TypeScript, no UI framework.** Three.js (WebGL into a `<canvas>`).
- **Grounded / "stylised-real" 3D**: real proportions, PBR materials, soft natural light and real shadows, simplified textures. Not photoreal, not flat or low-poly.
- **Pigeons are built entirely in code**: sculpted Three.js geometry, shader feather detail and iridescent neck, procedural animation (head-bob, waddle, peck, flutter). No third-party pigeon models.
- **Environment**: own geometry plus **CC0** textures and HDRI from Poly Haven.
- **Camera**: fixed bench-sitter view looking down the path, slight drift with the pointer. It sits close when the flock is small and eases back as the flock grows.

### Throwing
- **Bread is infinite.** Each toss tears a visible bite from the side of the slice facing the throw. Once tossing pauses, the bites slowly fill back in.
- **Phone**: swipe up and away from the bread. Swipe length sets distance (on a curve: fine control near, long reach far), sideways movement aims. Dragging back to the bread cancels.
- **Desktop mouse**: press, drag, release, with the same mapping as the phone swipe.
- **Keyboard**: Space/Enter tosses to a soft aim ring on the ground, and arrow keys move the ring. If the ring is never moved, it drifts to a random spot near the flock after each toss. Screen readers get announcements ("Crumb tossed. Gerald is eating.").
- **Aim preview**: the same soft ground ring follows the drag, shared by all three input methods.
- **A tap/click with no drag** does a short underhand drop just in front of the bread.
- **Max throw distance** is well beyond the flock.
- **Client throttle**: about 8 tosses per second at most.
- **First-visit hint**: a small animated hand with "swipe to toss" (touch) or "drag to toss" (mouse), shown once and faded after the first throw.

### Pigeon behaviour
- **Interest radius**: each pigeon only goes for crumbs within a radius of where it stands. Bolder birds (Gerald's stage, per-bird random temperament) have a bigger radius. Far crumbs are ignored by most birds, but birds standing near them still go.
- **Squabbles** happen only when competing for crumbs within about a body-length. The closer bird usually wins, weighted by boldness. The loser does a wing-flap lunge, a sidestep and a sulky head-shake.
- **Uneaten crumbs** stay on the ground, and wandering birds may notice them later. Beyond about 30 uneaten, the oldest fades away.

### Streak, flock, Gerald (all in `localStorage`, every access wrapped in try/catch)
- **Fed today** = at least one crumb tossed on the visitor's **local calendar day**. A full missed calendar day resets the streak to 1.
- **Familiarity** (hidden): +1 per day fed, −2 per missed day, never below 1.
- **Flock size** follows a curve on familiarity: 1→5, 3→6, 7→8, 14→12, 30→18, capped at 24 (from roughly 45). Visitors start with 5 pigeons and never drop below 5. New birds flutter in while you watch. Birds lost to missed days are simply gone when you return (nobody visibly leaves).
- **Offended**: on the first visit after one or more missed days, the flock stands with backs half-turned, puffed up, and ignores the first 3 crumbs. They glance at the 4th and forgive at the 5th. Gerald forgives first. It lasts one visit and doesn't scale with the number of missed days.
- **Gerald** is the regular, marked by a pale patch on one wing. His bravery follows **total days ever fed** and never regresses:
  - from day 1: keeps his distance and only eats far crumbs
  - from about day 5: comes to mid-distance crumbs
  - from about day 14: takes the closest crumbs and wins most squabbles
  - from about day 30: occasionally hops up onto the bench beside the camera

### Sound
- **Muted by default.** CC0 recordings for coos and flaps, with tiny crumb and peck ticks synthesised in Web Audio.
- The **time-of-day idea is not included.**

### UI and quality
- **Overlay only, no header or menu.** The streak is top-left and small, with a drawn bread icon ("Day 12"). The sound toggle is a top-right icon button. The worldwide counter is quiet text at bottom-centre ("4,213 crumbs tossed in the last 24 hours").
- **Loading**: a warm plain screen with a small head-bobbing pigeon silhouette, fading into the scene. No percentage bar. The counter text can appear immediately.
- **Weak devices**: quality drops automatically (shadows, pixel ratio, flock cap). With no WebGL at all, show a still rendered image of the scene; crumbs still count and a short note explains.
- **Reduced motion**: no camera drift or easing (cuts instead), no flutter-ins (new birds are simply there), shorter crumb arcs. Pigeons still walk and peck, but calmer.

### Counter networking
- **Spam control is stateless.** Client throttle (see Throwing). The server rejects or clamps batches claiming more than 10 crumbs per second since the last batch or more than 100 per request. Nothing about visitors is stored.
- **Batching**: the client sends every 5 s and on page close (`sendBeacon`). The total is polled every 30 s and counts up smoothly. Your own tosses bump the displayed number straight away.

## Scope is my decision

Don't add, cut or reshape features on your own. If something isn't listed under "Decisions already made" or "Build steps", ask me before building it.

## Stack (decided)

- Vite + TypeScript, pnpm. No Next.js. Three.js for rendering.
- One serverless function (Vercel, in `/api`) for the crumb counter: accepts batched crumbs and returns the 24-hour total.
- Postgres on Neon for the counter, connection string in `.env.local`.
- Streak in `localStorage`, wrapped in try/catch (it can throw or be unavailable).
- Deploy on Vercel.

## How the counter should work

- Don't store one row per crumb. Store counts in per-minute buckets (`minute_start`, `count`) and increment them, so writes stay cheap.
- "Last 24 hours" = sum of buckets where `minute_start` is within the past 24 hours.
- Batch crumbs on the client (see Counter networking) rather than one request per click.
- Prune buckets older than 24 hours.
- The page polls or refreshes the total gently. It doesn't need to be exact to the second.
- API shape: `POST /api/crumbs` with `{ "count": n }` → `{ "total": n }`; `GET /api/crumbs` → `{ "total": n }`.

## Build steps

The original plan was one step at a time with a check-in after each. On 2026-11-24 I asked for the whole site (steps 1–5 and 7) to be built in one go by four sub-agents, without stopping unless my input is needed. The database (step 6 server side) comes after that, then deploy.

1. **Setup:** scaffold the Vite project with an empty `/api` folder, and add `.env.local` to `.gitignore`.
2. **The scene:** park scene, pigeon, bread.
3. **Feeding:** throwing, crumbs, the pigeon waddles over and eats. This is where most of the craft goes: easing, timing, little squabbles.
4. **Chosen ideas:** growing flock, Gerald, gentle offence on missed days, sound.
5. **Streak:** `localStorage`, as decided above.
6. **Worldwide counter:** the Postgres bucket table, the serverless function that takes batched crumbs, and the live total on the page.
7. **Quality pass:** responsive down to mobile, keyboard accessible, respects reduced motion, visible focus.
8. **Deploy.**

## Rules

- Use pnpm.
- Give me full files, not fragments.
- Comments explain only why, never what.
- Secrets go in `.env.local`, which is gitignored. Never commit them.
- No real personal data anywhere. No analytics or tracking unless I ask.
- Never post, publish or share anything publicly on my behalf.
- Don't use real brand logos, characters or copyrighted art. Pigeons are drawn in code. Only CC0 outside assets (textures, HDRI, sounds) are allowed, each recorded in `CREDITS.md`.
